import { Logger } from '@nestjs/common';
import { Bar } from '../../stat-arb/backtest/bar';
import { IQuoter } from '../quote/quoter.interface';
import { QuoteContext, QuotePair } from '../quote/quote-pair';
import { RollingVolatility } from '../quote/volatility';
import { InventoryBook } from '../inventory/inventory-book';
import { passiveFills } from '../backtest/fill-model';
import { attributeFill } from '../backtest/pnl-attribution';
import { RiskGate, RiskState, RiskVerdict } from '../risk/risk-gate';

// MmBook — a single-instrument live paper market-making book. The market-making
// analogue of LivePaperTrader: on each tick it pulls the latest closed bar for
// its symbol from the real feed, computes the quote its IQuoter wants resting,
// runs the risk gate, simulates passive fills against the bar's range (paper
// matching — see fill-model.ts), and marks its inventory + P&L. The SAME IQuoter
// runs unchanged in the backtest; only the bar source differs, so paper results
// predict live behaviour — the seam the whole engine is built around.
//
// Feed + clock are injected (not a Nest dependency) so the book is unit-testable
// with a scripted bar list and no network. The module wires the real feed.

const MICROS = 1_000_000n;

function toMicros(price: number): bigint {
  return BigInt(Math.round(price * 1_000_000));
}

function valueUnits(qtyUnits: bigint, priceMicros: bigint): bigint {
  return (qtyUnits * priceMicros) / MICROS;
}

export interface MmBookConfig {
  symbol: string;
  strategyId: string;
  quoter: IQuoter;
  quoteSizeUnits: bigint;
  gamma: number;
  kappa: number;
  horizonBars: number;
  volWindowBars: number;
  volFloor: number;
  /** Maker fee in bps, SIGNED: negative = rebate. */
  makerFeeBps: number;
  /**
   * Perp funding rate as a SIGNED fraction per HOUR (+ ⇒ longs pay shorts, the HL
   * convention). When set, funding accrues each bar on the inventory held over the
   * interval, pro-rated by the real inter-bar time, into equity + net P&L (the same
   * 5th-line model as the queue-aware harness — MM course §8.10). Omit/0 ⇒ none
   * (spot/AMM venues have no funding). Static over the run unless refreshed.
   */
  fundingRatePerHour?: number;
  capitalUnits: bigint;
  /** Latest-closed-bar source (one bar per call, null when none new). */
  nextBar: (symbol: string) => Promise<Bar | null>;
  /** Optional σ warmup: recent closes so the book quotes on its first live bar. */
  warmupCloses?: (symbol: string) => Promise<number[]>;
  riskGate?: RiskGate;
  now?: () => Date;
}

export interface MmBookSnapshot {
  symbol: string;
  strategyId: string;
  family: string;
  running: boolean;
  warm: boolean;
  barsSeen: number;
  seededBars: number;
  lastBarAt: string | null;
  midMicros: string;
  bidMicros: string | null;
  askMicros: string | null;
  reservationMicros: string | null;
  halfSpreadMicros: string | null;
  inventoryUnits: string;
  capitalUnits: string;
  equityUnits: string;
  realisedPnlUnits: string;
  unrealisedPnlUnits: string;
  feesUnits: string;
  /** Funding accrued on held inventory (+ received / − paid); "0" on non-perp venues. */
  fundingUnits: string;
  netPnlUnits: string;
  spreadCapturedUnits: string;
  adverseSelectionUnits: string;
  fills: number;
  bidFills: number;
  askFills: number;
  blockedQuotes: number;
  lastVerdict: string;
  maxDrawdownPct: number;
}

export class MmBook {
  private readonly logger = new Logger(MmBook.name);
  private readonly vol: RollingVolatility;
  private readonly book = new InventoryBook();
  private readonly now: () => Date;

  private barsSeen = 0;
  private seededBars = 0;
  private lastBar: Bar | null = null;
  private lastQuote: QuotePair | null = null;
  private fills = 0;
  private bidFills = 0;
  private askFills = 0;
  private blockedQuotes = 0;
  private spreadCaptured = 0n;
  private adverse = 0n;
  /** Funding harvested (+) / paid (−) on held inventory over the run; 0 when no rate. */
  private fundingUnits = 0n;
  private prevBarMs: number | undefined;
  private prevMidMicros: bigint | undefined;
  private peakEquity: bigint;
  private maxDrawdownPct = 0;
  private lastVerdict: RiskVerdict['kind'] = 'Allow';
  private running = false;
  private warmedUp = false;
  /** Fill recorded last bar, awaiting a mark-out against this bar's mid. */
  private pendingMarkout: { side: 'BUY' | 'SELL'; sizeUnits: bigint; fairMid: bigint }[] = [];

  constructor(private cfg: MmBookConfig) {
    this.vol = new RollingVolatility(cfg.volWindowBars);
    this.now = cfg.now ?? (() => new Date());
    this.peakEquity = cfg.capitalUnits;
  }

  setRunning(v: boolean): void {
    this.running = v;
  }

  setCapital(units: bigint): void {
    if (units <= 0n) throw new Error('mm book capital must be positive');
    this.cfg = { ...this.cfg, capitalUnits: units };
    this.peakEquity = units;
  }

  /** Refresh the live perp funding rate (signed fraction/hour). Lets a scheduler keep
   *  the static-per-run rate current as funding drifts over a multi-hour session. */
  setFundingRatePerHour(rate: number): void {
    this.cfg = { ...this.cfg, fundingRatePerHour: rate };
  }

  /** Seed the σ window from recent closes so the book can quote immediately. */
  async warmup(): Promise<void> {
    if (this.warmedUp || !this.cfg.warmupCloses) return;
    try {
      const closes = await this.cfg.warmupCloses(this.cfg.symbol);
      for (const c of closes) {
        this.vol.push(c);
        this.seededBars += 1;
      }
      this.warmedUp = true;
    } catch (e) {
      this.logger.warn(`warmup failed for ${this.cfg.symbol}: ${(e as Error).message}`);
    }
  }

  /** One iteration: pull the latest closed bar and act on it. No-op if none new. */
  async tick(): Promise<void> {
    const bar = await this.cfg.nextBar(this.cfg.symbol);
    if (!bar) return;
    this.barsSeen += 1;
    this.lastBar = bar;
    const midMicros = toMicros(bar.close);
    this.vol.push(bar.close);

    // Accrue funding on the inventory CARRIED INTO this bar over the interval since
    // the previous bar (long pays a positive rate ⇒ −(signed inv notional)·rate·Δt).
    // Done before the warmup early-return so the inter-bar clock stays correct; while
    // warming, inventory is 0 ⇒ no accrual. (MM course §8.10.)
    const tsMs = bar.timestamp.getTime();
    const fundingRate = this.cfg.fundingRatePerHour ?? 0;
    if (fundingRate !== 0 && this.prevBarMs !== undefined && this.prevMidMicros !== undefined) {
      const dtHours = (tsMs - this.prevBarMs) / 3_600_000;
      const inv = this.book.inventoryUnits();
      if (dtHours > 0 && inv !== 0n) {
        const notional = (inv * this.prevMidMicros) / MICROS;
        this.fundingUnits += BigInt(Math.round(-Number(notional) * fundingRate * dtHours));
      }
    }
    this.prevBarMs = tsMs;
    this.prevMidMicros = midMicros;

    // Resolve any prior-bar fills' adverse selection against this bar's mid.
    for (const p of this.pendingMarkout) {
      const c = attributeFill({ side: p.side, sizeUnits: p.sizeUnits, priceMicros: p.fairMid, feeUnits: 0n }, p.fairMid, midMicros, 0n);
      this.adverse += c.adverseSelectionUnits;
    }
    this.pendingMarkout = [];

    if (!this.vol.ready()) return; // warming

    const inventoryBefore = this.book.inventoryUnits();
    const ctx: QuoteContext = {
      inventoryUnits: inventoryBefore,
      midMicros,
      volatility: this.vol.valueOr(this.cfg.volFloor),
      riskAversion: this.cfg.gamma,
      arrivalDecay: this.cfg.kappa,
      horizonBars: this.cfg.horizonBars,
      schemaVersion: 1,
    };
    const quote = this.cfg.quoter.quote(ctx, this.cfg.symbol);
    this.lastQuote = quote;

    if (this.cfg.riskGate) {
      const navRatio = Number(this.equityWithFunding(midMicros)) / Number(this.cfg.capitalUnits);
      const state: RiskState = { inventoryUnits: inventoryBefore, navRatio, vpin: 0, recentAdverseUnits: this.adverse, killed: false };
      const verdict = this.cfg.riskGate.check(quote, state);
      this.lastVerdict = verdict.kind;
      if (verdict.kind !== 'Allow') {
        this.blockedQuotes += 1;
        this.markEquity(midMicros);
        return;
      }
    }

    const res = passiveFills(bar, quote.bid.priceMicros, quote.ask.priceMicros);
    const feeFor = (notionalUnits: bigint): bigint => (notionalUnits * BigInt(Math.round(this.cfg.makerFeeBps * 100))) / 1_000_000n;
    const applyOne = (side: 'BUY' | 'SELL', priceMicros: bigint): void => {
      const fee = feeFor(valueUnits(this.cfg.quoteSizeUnits, priceMicros));
      this.book.apply({ side, sizeUnits: this.cfg.quoteSizeUnits, priceMicros, feeUnits: fee });
      const c = attributeFill({ side, sizeUnits: this.cfg.quoteSizeUnits, priceMicros, feeUnits: fee }, midMicros, midMicros, 0n);
      this.spreadCaptured += c.spreadCapturedUnits;
      this.fills += 1;
      // Defer adverse selection to next bar's mid (a one-bar mark-out).
      this.pendingMarkout.push({ side, sizeUnits: this.cfg.quoteSizeUnits, fairMid: priceMicros });
    };
    if (res.bidFilled) {
      applyOne('BUY', quote.bid.priceMicros);
      this.bidFills += 1;
    }
    if (res.askFilled) {
      applyOne('SELL', quote.ask.priceMicros);
      this.askFills += 1;
    }
    this.markEquity(midMicros);
  }

  /** Force inventory to zero at the last mid (taker flatten; manual desk action). */
  async flatten(): Promise<void> {
    const inv = this.book.inventoryUnits();
    if (inv === 0n || !this.lastBar) return;
    const midMicros = toMicros(this.lastBar.close);
    const side = inv > 0n ? 'SELL' : 'BUY';
    const size = inv > 0n ? inv : -inv;
    // Crossing the spread to flatten pays a taker fee (5 bps), not the maker rebate.
    const fee = (valueUnits(size, midMicros) * 5n) / 10_000n;
    this.book.apply({ side, sizeUnits: size, priceMicros: midMicros, feeUnits: fee });
  }

  /** Equity including funding: capital + trading P&L + funding accrued. */
  private equityWithFunding(midMicros: bigint): bigint {
    return this.book.equityUnits(this.cfg.capitalUnits, midMicros) + this.fundingUnits;
  }

  private markEquity(midMicros: bigint): void {
    const equity = this.equityWithFunding(midMicros);
    if (equity > this.peakEquity) this.peakEquity = equity;
    if (this.peakEquity > 0n) {
      const ddPct = (Number(this.peakEquity - equity) / Number(this.peakEquity)) * 100;
      if (ddPct > this.maxDrawdownPct) this.maxDrawdownPct = ddPct;
    }
  }

  snapshot(): MmBookSnapshot {
    const midMicros = this.lastBar ? toMicros(this.lastBar.close) : MICROS;
    const q = this.lastQuote;
    return {
      symbol: this.cfg.symbol,
      strategyId: this.cfg.strategyId,
      family: this.cfg.quoter.familyId,
      running: this.running,
      warm: this.vol.ready(),
      barsSeen: this.barsSeen,
      seededBars: this.seededBars,
      lastBarAt: this.lastBar ? this.lastBar.timestamp.toISOString() : null,
      midMicros: midMicros.toString(),
      bidMicros: q ? q.bid.priceMicros.toString() : null,
      askMicros: q ? q.ask.priceMicros.toString() : null,
      reservationMicros: q ? q.reservationMicros.toString() : null,
      halfSpreadMicros: q ? q.halfSpreadMicros.toString() : null,
      inventoryUnits: this.book.inventoryUnits().toString(),
      capitalUnits: this.cfg.capitalUnits.toString(),
      equityUnits: this.equityWithFunding(midMicros).toString(),
      realisedPnlUnits: this.book.realisedUnits().toString(),
      unrealisedPnlUnits: this.book.unrealisedUnits(midMicros).toString(),
      feesUnits: this.book.feesUnits().toString(),
      fundingUnits: this.fundingUnits.toString(),
      netPnlUnits: (this.book.totalPnlUnits(midMicros) + this.fundingUnits).toString(),
      spreadCapturedUnits: this.spreadCaptured.toString(),
      adverseSelectionUnits: this.adverse.toString(),
      fills: this.fills,
      bidFills: this.bidFills,
      askFills: this.askFills,
      blockedQuotes: this.blockedQuotes,
      lastVerdict: this.lastVerdict,
      maxDrawdownPct: this.maxDrawdownPct,
    };
  }
}
