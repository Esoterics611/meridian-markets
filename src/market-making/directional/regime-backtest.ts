import { RegimeDirectionalBook, RegimeDirectionalConfig, RegimeBookTrigger } from './regime-directional-book';
import { BiasReading } from '../bias/bias-source.interface';
import { sharpeStats } from '../../stat-arb/research/deflated-sharpe';

// regime-backtest — the PURE book-level replay engine (Playbook II P8). The OOS gate (P2)
// proves a SIGNAL predicts forward return; this proves the BOOK — the whole chain of
// gate→consensus→size→stop→fees→funding→slippage — actually makes money AFTER costs on
// out-of-sample history. It replays the EXACT live logic (the same RegimeDirectionalBook,
// the same P7 fill model) bar by bar, so backtest and live are one code path (no drift).
//
// No look-ahead is STRUCTURAL: the engine hands the signal callback only bars[0..i], so a
// signal physically cannot read the future. The caller (the walk-forward script) recomputes
// the consensus reading + monitor stand-aside from that window alone.

const MICROS = 1_000_000;
const toMicros = (x: number): bigint => BigInt(Math.round(x * MICROS));

export interface BacktestBar {
  readonly tMs: number;
  readonly close: number;
  /** Signed perp funding rate per hour at this bar (+ ⇒ longs pay shorts). Optional. */
  readonly fundingRatePerHour?: number;
}

/** What the strategy "sees" at a bar — produced by the caller from data up to that bar only. */
export interface RegimeSignalReading {
  readonly reading: BiasReading;
  /** OOS IC for the conviction cap (optional). */
  readonly ic?: number;
  /** Regime monitor stand-aside flag (optional). */
  readonly standAside?: boolean;
}

/**
 * The no-look-ahead signal contract: given bar index `i` and the bars UP TO AND INCLUDING i
 * (`window.length === i + 1`, `window[i]` is the current bar), return the reading at i.
 */
export type SignalAt = (i: number, window: readonly BacktestBar[]) => RegimeSignalReading;

export interface RegimeReplayResult {
  readonly bars: number;
  /** Realised-first: gross realised − fees + funding (slippage is already inside gross realised). */
  readonly realisedUnits: bigint;
  readonly grossRealisedUnits: bigint;
  readonly feesUnits: bigint;
  readonly fundingUnits: bigint;
  readonly slippageUnits: bigint;
  /** Mark of any still-open position at the last bar (NOT in the realised headline). */
  readonly finalUnrealisedUnits: bigint;
  readonly maxDrawdownUsd: number;
  /** maxDD as a fraction of base notional (the per-book budget denominator). */
  readonly maxDrawdownFrac: number;
  readonly entries: number;
  readonly stops: number;
  readonly closes: number;
  readonly wins: number;
  /** wins / closed round-trips. */
  readonly hitRate: number;
  /** Fraction of bars holding a non-flat position. */
  readonly exposureFrac: number;
  /** Realised P&L (USD) per CLOSED round-trip — the per-trade Sharpe stream. */
  readonly perTradePnlUsd: number[];
  /** Per-trade Sharpe of the realised stream (un-deflated; the script deflates over the grid). */
  readonly sharpe: number;
}

/**
 * Replay the book over `bars`, asking `signalAt` for the reading at each bar (window = bars[0..i]).
 * Returns the realised-first scorecard. The book's own stop / decay / stand-aside / funding /
 * slippage all fire exactly as they do live.
 */
export function replayRegimeBook(
  bars: readonly BacktestBar[],
  cfg: RegimeDirectionalConfig,
  signalAt: SignalAt,
): RegimeReplayResult {
  const book = new RegimeDirectionalBook(cfg);
  const baseNotionalUsd = cfg.baseNotionalUsd;

  let entries = 0;
  let stops = 0;
  let closes = 0;
  let wins = 0;
  let exposedBars = 0;
  const perTradePnlUsd: number[] = [];

  let peakEquityUsd = 0;
  let maxDrawdownUsd = 0;
  // realised-first running total at the previous close, to slice out each round-trip's P&L.
  let realisedAtLastCloseUnits = 0n;

  const realisedFirst = (): bigint => book.realisedUnits() - book.feesUnits() + book.fundingUnits();

  for (let i = 0; i < bars.length; i++) {
    const window = bars.slice(0, i + 1); // STRUCTURAL no-look-ahead: signal sees only [0..i]
    const sig = signalAt(i, window);
    const midMicros = toMicros(bars[i].close);

    const action = book.update({
      nowMs: bars[i].tMs,
      midMicros,
      reading: sig.reading,
      ic: sig.ic,
      fundingRatePerHour: bars[i].fundingRatePerHour,
      standAside: sig.standAside,
    });

    if (action.action === 'open' || action.action === 'flip') entries++;
    if (action.trigger === ('loss-stop' as RegimeBookTrigger)) stops++;
    if (action.action === 'close' || action.action === 'flip') {
      closes++;
      const now = realisedFirst();
      const tradePnlUsd = Number(now - realisedAtLastCloseUnits) / MICROS;
      perTradePnlUsd.push(tradePnlUsd);
      if (tradePnlUsd > 0) wins++;
      realisedAtLastCloseUnits = now;
    }

    if (book.inventoryUnits() !== 0n) exposedBars++;

    // Equity curve (realised-first incl. the open mark) for the honest maxDD.
    const equityUsd = Number(book.totalPnlUnits(midMicros)) / MICROS;
    if (equityUsd > peakEquityUsd) peakEquityUsd = equityUsd;
    const ddUsd = peakEquityUsd - equityUsd;
    if (ddUsd > maxDrawdownUsd) maxDrawdownUsd = ddUsd;
  }

  const lastMid = bars.length ? toMicros(bars[bars.length - 1].close) : 0n;
  return {
    bars: bars.length,
    realisedUnits: realisedFirst(),
    grossRealisedUnits: book.realisedUnits(),
    feesUnits: book.feesUnits(),
    fundingUnits: book.fundingUnits(),
    slippageUnits: book.slippageUnits(),
    finalUnrealisedUnits: lastMid > 0n ? book.unrealisedUnits(lastMid) : 0n,
    maxDrawdownUsd,
    maxDrawdownFrac: baseNotionalUsd > 0 ? maxDrawdownUsd / baseNotionalUsd : 0,
    entries,
    stops,
    closes,
    wins,
    hitRate: closes > 0 ? wins / closes : 0,
    exposureFrac: bars.length > 0 ? exposedBars / bars.length : 0,
    perTradePnlUsd,
    sharpe: sharpeStats(perTradePnlUsd).sharpe,
  };
}
