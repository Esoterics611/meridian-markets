import { Bar } from '../../stat-arb/backtest/bar';
import { IQuoter } from '../quote/quoter.interface';
import { QuoteContext } from '../quote/quote-pair';
import { RollingVolatility } from '../quote/volatility';
import { InventoryBook, FillSide } from '../inventory/inventory-book';
import { passiveFills } from './fill-model';
import { attributeFill, PnlComponent, sumComponents, AttributionSummary } from './pnl-attribution';
import { RiskGate, RiskState } from '../risk/risk-gate';

// MmBacktestRunner — the bar-driven market-making backtest. Walks one symbol's
// OHLCV bars in order, drives an IQuoter on each bar with strictly historical
// context (rolling σ, current inventory), simulates passive fills against the
// bar's range, and attributes every fill into the four P&L components. The same
// IQuoter runs unchanged in the live paper book (live/mm-book.ts) — the swap
// seam stat-arb is built around, applied to quoting.
//
// This is the runnable MM backtest on the data we have today (Binance public
// OHLCV). Its fill model is fill-on-touch and therefore an upper bound on fills
// (see fill-model.ts); the honest queue-aware version is the LOB-replay path.

export interface MmFillRecord {
  barIndex: number;
  side: FillSide;
  sizeUnits: bigint;
  priceMicros: bigint;
  feeUnits: bigint;
  midMicros: bigint;
  component: PnlComponent;
}

export interface MmBacktestMetrics {
  bars: number;
  quotingBars: number; // bars where a quote was actually placed (not paused/denied)
  fills: number;
  bidFills: number;
  askFills: number;
  fillRate: number; // fills ÷ (2 × quotingBars)
  realisedPnlUnits: bigint;
  finalInventoryUnits: bigint;
  unrealisedPnlUnits: bigint;
  netPnlUnits: bigint; // realised − fees + final unrealised
  feesUnits: bigint; // signed; negative = net maker rebate earned
  maxDrawdownPct: number;
  attribution: AttributionSummary;
}

export interface MmBacktestConfig {
  bars: Bar[];
  quoter: IQuoter;
  /** Asset units quoted per side (matches the quoter's size; used for fills). */
  quoteSizeUnits: bigint;
  /** γ surfaced into the QuoteContext (the quoter may ignore it). */
  gamma: number;
  /** κ surfaced into the QuoteContext. */
  kappa: number;
  /** Horizon (bars) for the AS (T−t) term. */
  horizonBars: number;
  /** Rolling-σ window in bars. */
  volWindowBars: number;
  /** σ floor as a fraction of price, so a flat warmup never produces a zero spread. */
  volFloor: number;
  /** Maker fee in bps, SIGNED: negative = rebate (revenue). */
  makerFeeBps: number;
  /** Capital anchor for the drawdown ratio (USDC-units). */
  capitalUnits: bigint;
  /** Optional risk gate; Deny/Pause suppress quoting for that bar. */
  riskGate?: RiskGate;
}

const MICROS = 1_000_000n;

function toMicros(price: number): bigint {
  return BigInt(Math.round(price * 1_000_000));
}

function valueUnits(qtyUnits: bigint, priceMicros: bigint): bigint {
  return (qtyUnits * priceMicros) / MICROS;
}

export class MmBacktestRunner {
  run(cfg: MmBacktestConfig): MmBacktestMetrics {
    const vol = new RollingVolatility(cfg.volWindowBars);
    const book = new InventoryBook();
    const fills: MmFillRecord[] = [];
    const components: PnlComponent[] = [];
    let quotingBars = 0;
    let bidFills = 0;
    let askFills = 0;

    let peakEquity = cfg.capitalUnits;
    let maxDrawdownPct = 0;

    const feeFor = (notionalUnits: bigint): bigint =>
      (notionalUnits * BigInt(Math.round(cfg.makerFeeBps * 100))) / 1_000_000n;

    for (let i = 0; i < cfg.bars.length; i++) {
      const bar = cfg.bars[i];
      const midMicros = toMicros(bar.close);
      vol.push(bar.close);
      if (!vol.ready()) continue; // warmup

      const inventoryBefore = book.inventoryUnits();
      const ctx: QuoteContext = {
        inventoryUnits: inventoryBefore,
        midMicros,
        volatility: vol.valueOr(cfg.volFloor),
        riskAversion: cfg.gamma,
        arrivalDecay: cfg.kappa,
        horizonBars: cfg.horizonBars,
        schemaVersion: 1,
      };
      const quote = cfg.quoter.quote(ctx, bar.symbol);

      // Risk gate: Deny or Pause both mean "don't place new quotes this bar".
      if (cfg.riskGate) {
        const navRatio = Number(book.equityUnits(cfg.capitalUnits, midMicros)) / Number(cfg.capitalUnits);
        const state: RiskState = {
          inventoryUnits: inventoryBefore,
          navRatio,
          vpin: 0,
          recentAdverseUnits: 0n,
          killed: false,
        };
        if (cfg.riskGate.check(quote, state).kind !== 'Allow') continue;
      }
      quotingBars += 1;

      const res = passiveFills(bar, quote.bid.priceMicros, quote.ask.priceMicros);
      // Mark-out reference: next bar's mid (one-bar horizon), else this bar's mid.
      const markoutMid = i + 1 < cfg.bars.length ? toMicros(cfg.bars[i + 1].close) : midMicros;

      const applyOne = (side: FillSide, priceMicros: bigint): void => {
        const notional = valueUnits(cfg.quoteSizeUnits, priceMicros);
        const fee = feeFor(notional);
        const invBefore = book.inventoryUnits();
        book.apply({ side, sizeUnits: cfg.quoteSizeUnits, priceMicros, feeUnits: fee });
        const component = attributeFill(
          { side, sizeUnits: cfg.quoteSizeUnits, priceMicros, feeUnits: fee },
          midMicros,
          markoutMid,
          invBefore,
        );
        components.push(component);
        fills.push({ barIndex: i, side, sizeUnits: cfg.quoteSizeUnits, priceMicros, feeUnits: fee, midMicros, component });
      };

      // Apply the bid fill first (buy), then the ask fill (sell) — order only
      // matters for the inventory path within a straddle bar; both net to the
      // captured spread.
      if (res.bidFilled) {
        applyOne('BUY', quote.bid.priceMicros);
        bidFills += 1;
      }
      if (res.askFilled) {
        applyOne('SELL', quote.ask.priceMicros);
        askFills += 1;
      }

      const equity = book.equityUnits(cfg.capitalUnits, midMicros);
      if (equity > peakEquity) peakEquity = equity;
      if (peakEquity > 0n) {
        const ddPct = (Number(peakEquity - equity) / Number(peakEquity)) * 100;
        if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
      }
    }

    const lastMid = cfg.bars.length > 0 ? toMicros(cfg.bars[cfg.bars.length - 1].close) : MICROS;
    const finalInventory = book.inventoryUnits();
    const unrealised = book.unrealisedUnits(lastMid);

    return {
      bars: cfg.bars.length,
      quotingBars,
      fills: fills.length,
      bidFills,
      askFills,
      fillRate: quotingBars > 0 ? fills.length / (2 * quotingBars) : 0,
      realisedPnlUnits: book.realisedUnits(),
      finalInventoryUnits: finalInventory,
      unrealisedPnlUnits: unrealised,
      netPnlUnits: book.totalPnlUnits(lastMid),
      feesUnits: book.feesUnits(),
      maxDrawdownPct,
      attribution: sumComponents(components),
    };
  }
}
