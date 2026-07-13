/**
 * outcome-rv-book — probability RV: trade venue binaries against the Deribit RND.
 *
 * THE THESIS (2026-07-13 live read, locked in implied-digital.spec.ts): binary-market
 * crowds quote wide, retail-anchored books; this desk owns an options-calibrated fair
 * value (smile-adjusted digital) that no one else on those books is using. We buy YES
 * when the ask is below fair, buy NO when the bid is above fair — fee-adjusted, edge
 * thresholded. NOT spread-MM (killed, #70): positions are defined-risk (max loss =
 * collateral), self-settle to 0/1 within hours (no warehouse drift — the thing that
 * killed spread-MM), and every entry needs a signed fair-value edge, not queue rent.
 *
 * Doctrine compliance (desk rules):
 *   - conserve equity: hard collateral caps per market + total; max loss known at entry;
 *   - exit aggressively: take-profit closes when the market comes to us pre-expiry;
 *   - no edge → no position: evaluate() returns null with the reason, logged;
 *   - capital-lock honesty: dailies lock < 24h, so raw edge ≈ honest return; the
 *     snapshot still reports edge and lock hours separately so nothing hides.
 *
 * Money is plain USD numbers (contracts pay $1). Paper-only, like everything here.
 */
import { BinaryQuote } from './binary-market.types';

export interface OutcomeRvConfig {
  /** Min fee-adjusted edge (probability units) to open. Pre-registered: 0.03. */
  edgeMinProb: number;
  /** Fee per $1 contract charged on close/settle (HIP-4 opens free; conservative default until the venue's schedule is confirmed). */
  settleFeeProb: number;
  /** Base size per trade, $1-payout contracts. */
  contractsPerTrade: number;
  /** Never lock more than this much collateral in one market (USD). */
  maxCollateralPerMarket: number;
  /** ... or across the whole book (USD). */
  maxTotalCollateral: number;
  /** No NEW entries this close to expiry (stale-smile / gamma-slam guard), minutes. */
  minMinutesToExpiry: number;
  /** Close early if the market lets us lock ≥ this fraction of entry edge. 0 disables. */
  takeProfitFrac: number;
  /** Never take more than this fraction of the touch size (impact honesty). */
  maxTouchFrac: number;
}

export const DEFAULT_OUTCOME_RV_CONFIG: OutcomeRvConfig = {
  edgeMinProb: 0.03,
  settleFeeProb: 0.005,
  contractsPerTrade: 500,
  maxCollateralPerMarket: 500,
  maxTotalCollateral: 2_000,
  minMinutesToExpiry: 45,
  takeProfitFrac: 0.7,
  maxTouchFrac: 0.5,
};

export type BinarySide = 'YES' | 'NO';

export interface BinaryPosition {
  marketId: string;
  venue: string;
  underlying: string;
  targetPrice: number;
  expiryMs: number;
  side: BinarySide;
  contracts: number;
  /** Executable probability paid per contract (the entry price). */
  entryProb: number;
  /** Fair P(side wins) at entry. */
  fairAtEntry: number;
  /** Fee-adjusted edge at entry, prob units. */
  entryEdge: number;
  /** USD locked = entryProb × contracts. Max loss, known at entry. */
  collateral: number;
  openedMs: number;
  status: 'OPEN' | 'CLOSED' | 'SETTLED';
  realised?: number;
  exitProb?: number;
  closedMs?: number;
}

export interface RvDecision {
  action: 'BUY_YES' | 'BUY_NO';
  /** Executable probability we pay. */
  execProb: number;
  /** Fee-adjusted edge, prob units. */
  edge: number;
  contracts: number;
}

export interface RvNoTrade {
  action: null;
  reason: string;
  /** Best fee-adjusted edge seen (may be negative). */
  bestEdge: number;
}

export interface BookSnapshot {
  open: number;
  settled: number;
  closedEarly: number;
  wins: number;
  losses: number;
  collateralLocked: number;
  realisedTotal: number;
  feesPaid: number;
}

export class OutcomeRvBook {
  private readonly positions = new Map<string, BinaryPosition>();
  private realisedTotal = 0;
  private feesPaid = 0;
  private wins = 0;
  private losses = 0;
  private settledCount = 0;
  private closedEarlyCount = 0;

  constructor(private readonly cfg: OutcomeRvConfig = DEFAULT_OUTCOME_RV_CONFIG) {}

  /** Decide on one market. fairYes is the smile-adjusted digital; caller got it or we don't trade. */
  evaluate(q: BinaryQuote, fairYes: number, nowMs: number): RvDecision | RvNoTrade {
    const fee = this.cfg.settleFeeProb;
    const yesEdge = fairYes - q.yesAsk - fee; // buy YES at the ask
    const noEdge = q.yesBid - fairYes - fee; // buy NO ≡ sell YES at the bid
    const bestEdge = Math.max(yesEdge, noEdge);

    const open = this.positions.get(q.marketId);
    if (open && open.status === 'OPEN') return { action: null, reason: 'position-open', bestEdge };
    const minsLeft = (q.expiryMs - nowMs) / 60_000;
    if (minsLeft < this.cfg.minMinutesToExpiry) {
      return { action: null, reason: `inside-expiry-guard (${minsLeft.toFixed(0)}m left)`, bestEdge };
    }
    if (bestEdge < this.cfg.edgeMinProb) {
      return { action: null, reason: `edge ${bestEdge.toFixed(4)} < min ${this.cfg.edgeMinProb}`, bestEdge };
    }

    const action = yesEdge >= noEdge ? 'BUY_YES' : 'BUY_NO';
    const execProb = action === 'BUY_YES' ? q.yesAsk : 1 - q.yesBid;
    const touch = action === 'BUY_YES' ? q.yesAskSize : q.yesBidSize;

    let contracts = Math.min(this.cfg.contractsPerTrade, Math.floor(touch * this.cfg.maxTouchFrac));
    const perMarketRoom = this.cfg.maxCollateralPerMarket / Math.max(execProb, 1e-9);
    const totalRoom = (this.cfg.maxTotalCollateral - this.collateralLocked()) / Math.max(execProb, 1e-9);
    contracts = Math.floor(Math.min(contracts, perMarketRoom, totalRoom));
    if (contracts <= 0) return { action: null, reason: 'collateral-cap or touch too thin', bestEdge };

    return { action, execProb, edge: bestEdge, contracts };
  }

  enter(q: BinaryQuote, d: RvDecision, fairYes: number, nowMs: number): BinaryPosition {
    const side: BinarySide = d.action === 'BUY_YES' ? 'YES' : 'NO';
    const pos: BinaryPosition = {
      marketId: q.marketId,
      venue: q.venue,
      underlying: q.underlying,
      targetPrice: q.targetPrice,
      expiryMs: q.expiryMs,
      side,
      contracts: d.contracts,
      entryProb: d.execProb,
      fairAtEntry: side === 'YES' ? fairYes : 1 - fairYes,
      entryEdge: d.edge,
      collateral: d.execProb * d.contracts,
      openedMs: nowMs,
      status: 'OPEN',
    };
    this.positions.set(q.marketId, pos);
    return pos;
  }

  /**
   * Exit aggressively (doctrine #4): if the market now pays us ≥ takeProfitFrac of the
   * entry edge, close and recycle the collateral rather than riding to settlement.
   */
  tryTakeProfit(q: BinaryQuote, nowMs: number): BinaryPosition | null {
    if (this.cfg.takeProfitFrac <= 0) return null;
    const pos = this.positions.get(q.marketId);
    if (!pos || pos.status !== 'OPEN') return null;
    // Selling our side hits that side's bid: YES sells at yesBid; NO sells at 1 − yesAsk.
    const exitProb = pos.side === 'YES' ? q.yesBid : 1 - q.yesAsk;
    const lockedEdge = exitProb - pos.entryProb - this.cfg.settleFeeProb;
    if (lockedEdge < this.cfg.takeProfitFrac * pos.entryEdge || lockedEdge <= 0) return null;
    const fee = this.cfg.settleFeeProb * pos.contracts;
    pos.status = 'CLOSED';
    pos.exitProb = exitProb;
    pos.closedMs = nowMs;
    pos.realised = (exitProb - pos.entryProb) * pos.contracts - fee;
    this.realisedTotal += pos.realised;
    this.feesPaid += fee;
    this.closedEarlyCount += 1;
    if (pos.realised >= 0) this.wins += 1;
    else this.losses += 1;
    return pos;
  }

  /** Settle an expired market from the resolved outcome. */
  settle(marketId: string, settledYes: boolean, nowMs: number): BinaryPosition | null {
    const pos = this.positions.get(marketId);
    if (!pos || pos.status !== 'OPEN') return null;
    const won = (pos.side === 'YES') === settledYes;
    const payout = won ? pos.contracts : 0;
    const fee = this.cfg.settleFeeProb * pos.contracts;
    pos.status = 'SETTLED';
    pos.exitProb = won ? 1 : 0;
    pos.closedMs = nowMs;
    pos.realised = payout - pos.collateral - fee;
    this.realisedTotal += pos.realised;
    this.feesPaid += fee;
    this.settledCount += 1;
    if (won) this.wins += 1;
    else this.losses += 1;
    return pos;
  }

  /** Positions still open on markets past expiry — the runner must settle these. */
  expiredOpen(nowMs: number): BinaryPosition[] {
    return [...this.positions.values()].filter((p) => p.status === 'OPEN' && nowMs >= p.expiryMs);
  }

  openPositions(): BinaryPosition[] {
    return [...this.positions.values()].filter((p) => p.status === 'OPEN');
  }

  collateralLocked(): number {
    return this.openPositions().reduce((s, p) => s + p.collateral, 0);
  }

  snapshot(): BookSnapshot {
    return {
      open: this.openPositions().length,
      settled: this.settledCount,
      closedEarly: this.closedEarlyCount,
      wins: this.wins,
      losses: this.losses,
      collateralLocked: this.collateralLocked(),
      realisedTotal: this.realisedTotal,
      feesPaid: this.feesPaid,
    };
  }
}
