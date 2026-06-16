import { DeskEventInput, hedgeEvent } from '../events/desk-event';

// RegimeBetaHedge — the PURE beta-hedger for the "take sides" desk (Playbook II P9). The
// operator's locked decision: build BOTH exposure modes behind a toggle (default OUTRIGHT).
// In HEDGED mode a desk that is long several alts can flatten its net crypto-beta and express
// only the signal's idiosyncratic edge — the hedge leg is a paper perp in a single hedge
// instrument (default BTC).
//
// Net book beta, in USD-beta units, is Σ(signedNotional_i · beta_i). The hedge instrument has
// beta 1 to itself, so the leg that neutralises the desk is hedgeNotional = −netBookBeta; the
// residual after applying it is netBookBeta + hedgeNotional = 0. A rebalance BAND avoids churn:
// the leg only moves when the target shifts by more than the band. Clock-free + I/O-free, so it
// is fully unit-testable; the runner wires it on the live loop.

const MICROS = 1_000_000;

/** Trailing-returns beta of an asset to the hedge instrument: cov(a,h)/var(h). */
export function estimateBeta(assetReturns: readonly number[], hedgeReturns: readonly number[]): number {
  const n = Math.min(assetReturns.length, hedgeReturns.length);
  if (n < 2) return 1; // not enough data ⇒ assume unit beta (conservative — fully hedge)
  let ma = 0;
  let mh = 0;
  for (let i = 0; i < n; i++) {
    ma += assetReturns[i];
    mh += hedgeReturns[i];
  }
  ma /= n;
  mh /= n;
  let cov = 0;
  let varH = 0;
  for (let i = 0; i < n; i++) {
    const dh = hedgeReturns[i] - mh;
    cov += (assetReturns[i] - ma) * dh;
    varH += dh * dh;
  }
  return varH > 0 ? cov / varH : 1;
}

export interface RegimeBetaHedgeConfig {
  /** The hedge instrument symbol (beta 1 to itself). Default 'BTC'. */
  readonly hedgeSymbol?: string;
  /** Minimum |target − current| (USD) before the leg rebalances — avoids churn. Default 5,000. */
  readonly rebalanceBandUsd?: number;
  /** Taker fee on each hedge trade, bps of |delta notional|. Default 4.5. */
  readonly takerFeeBps?: number;
}

/** One book's signed exposure + its beta to the hedge instrument. */
export interface BookBeta {
  readonly symbol: string;
  /** + long, − short, 0 flat. USD. */
  readonly signedNotionalUsd: number;
  readonly beta: number;
}

export interface HedgeRebalance {
  /** True when the band was breached and the leg moved this poll. */
  readonly changed: boolean;
  /** The hedge leg's desired signed notional (USD). */
  readonly targetNotionalUsd: number;
  /** The trade executed (target − current) when changed, else 0. */
  readonly deltaNotionalUsd: number;
  /** Net book beta before hedging (USD-beta). */
  readonly netBookBetaUsd: number;
  /** Residual net beta after applying the (possibly unchanged) hedge leg. ~0 when rebalanced. */
  readonly residualBetaUsd: number;
}

export class RegimeBetaHedge {
  private current = 0; // hedge leg signed notional, USD
  private feesAccrued = 0n;
  private readonly hedgeSymbol: string;
  private readonly bandUsd: number;
  private readonly takerFeeBps: number;
  private readonly onEvent?: (e: DeskEventInput) => void;

  constructor(cfg: RegimeBetaHedgeConfig = {}, onEvent?: (e: DeskEventInput) => void) {
    this.hedgeSymbol = cfg.hedgeSymbol ?? 'BTC';
    this.bandUsd = Math.max(0, cfg.rebalanceBandUsd ?? 5_000);
    this.takerFeeBps = cfg.takerFeeBps ?? 4.5;
    this.onEvent = onEvent;
  }

  /** The hedge leg that would flatten the desk's net beta from the given books. */
  targetNotionalUsd(books: readonly BookBeta[]): number {
    let netBeta = 0;
    for (const b of books) netBeta += b.signedNotionalUsd * b.beta;
    return -netBeta;
  }

  /** Re-aim the hedge leg at the current net beta, respecting the band. Books its fee + event. */
  rebalance(books: readonly BookBeta[], nowMs: number): HedgeRebalance {
    let netBeta = 0;
    for (const b of books) netBeta += b.signedNotionalUsd * b.beta;
    const target = -netBeta;
    const delta = target - this.current;
    const changed = Math.abs(delta) > this.bandUsd;
    if (changed) {
      this.current = target;
      const feeUnits = BigInt(Math.round((Math.abs(delta) * this.takerFeeBps) / 10_000 * MICROS));
      this.feesAccrued += feeUnits;
      if (this.onEvent) {
        try {
          this.onEvent(
            hedgeEvent({
              ts: nowMs,
              underlying: this.hedgeSymbol,
              side: delta >= 0 ? 'buy' : 'sell',
              notionalUsd: Math.abs(delta),
              residualUsd: netBeta + this.current,
              reason: 'net-beta rebalance',
            }),
          );
        } catch {
          /* observability must never break the hedge */
        }
      }
    }
    return {
      changed,
      targetNotionalUsd: target,
      deltaNotionalUsd: changed ? delta : 0,
      netBookBetaUsd: netBeta,
      residualBetaUsd: netBeta + this.current,
    };
  }

  hedgeSymbolId(): string {
    return this.hedgeSymbol;
  }
  hedgeNotionalUsd(): number {
    return this.current;
  }
  feesUnits(): bigint {
    return this.feesAccrued;
  }
}
