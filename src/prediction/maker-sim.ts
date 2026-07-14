/**
 * maker-sim — Phase-0 maker-fill simulation over a recorded HIP-4 tape (PURE, no I/O).
 *
 * Question it answers (pre-registered, docs/PREDICTION_MARKET_MM_RESEARCH.md §5): if the
 * desk had rested two-sided quotes around its live-spot RND fair on the YES book,
 * re-priced every `repriceMs`, what is fill-rate × captured spread − adverse markout −
 * hedge cost − fees, per grid point (halfWidth × cadence)?
 *
 * Deliberately conservative mechanics (no queue flattery — the #96 lesson):
 *   - STRICT trade-through fills only: a resting bid at b fills only when a later snap
 *     shows best ask < b (someone priced through us). Touching our price never fills.
 *     Fill size = min(quote size, displayed size at/inside our price), never more.
 *   - Post-only honesty: a quote that would cross the current touch is withheld that
 *     cycle (a maker never takes; fat dislocations are the taker book's territory).
 *   - Between reprices the quote is STALE by construction — that is the point: the
 *     cadence axis measures what re-pricing speed is worth (#27–#33 mechanism).
 *   - Quote width has a floor = floorMult · φ(d2)·√(δt/T) — the digital fair value's own
 *     one-σ move over the reprice horizon δt (r=0). Quoting tighter than your own
 *     staleness is donating gamma.
 *   - HIP-4 fee taxonomy (Chainstack-verified 2026-07-14): opens FREE, the closing side
 *     of a normal trade pays makerCloseFeeBps·px·sz, settlement pays settleFeeBps·sz.
 *   - Hedge cost line: each fill's digital delta is φ(d2)/(σ√T) dollars of perp notional
 *     per contract; charged hedgeCostBps on that notional at fill and again at unwind.
 *     Reported separately so hedged and unhedged economics are both visible.
 *   - No-quote window near expiry (digital Γ → ∞ pinned at strike: "0DTE but worse").
 */
import { normPdf } from '../derivatives/greeks/black-scholes';
import { TapeSnap } from './maker-tape.types';

export interface MakerSimConfig {
  /** Half-width around fair, probability units (before the staleness floor). */
  halfWidthProb: number;
  /** Re-quote cadence in ms — quotes are stale between reprices. */
  repriceMs: number;
  /** Contracts per quote side ($1 payout each). */
  quoteContracts: number;
  /** Absolute inventory cap in contracts; at cap the increasing side is withheld. */
  maxInventory: number;
  /** Multiplier m on the φ(d2)·√(δt/T) width floor. */
  floorMult: number;
  /** Pull all quotes when time-to-expiry is below this (minutes). */
  noQuoteMinutes: number;
  /** Fee on the closing side of a trade, bps of px·sz (HIP-4 maker close ≈ 4). */
  makerCloseFeeBps: number;
  /** Fee at settlement, bps of $1·sz (schedule still placeholder — flagged). */
  settleFeeBps: number;
  /** Cost per $ of perp hedge notional, bps (taker fee + half-spread ≈ 5). */
  hedgeCostBps: number;
  /** Markout horizon for the adverse-selection diagnostic. */
  markoutMs: number;
  /** Venue price tick. */
  tickSize: number;
}

export const DEFAULT_MAKER_SIM: MakerSimConfig = {
  halfWidthProb: 0.005,
  repriceMs: 1_000,
  quoteContracts: 100,
  maxInventory: 500,
  floorMult: 1,
  noQuoteMinutes: 30,
  makerCloseFeeBps: 4,
  settleFeeBps: 4,
  hedgeCostBps: 5,
  markoutMs: 60_000,
  // Probed live 2026-07-14: HIP-4 BTC daily book shows 5-dp prices (0.48504/0.48505),
  // finer than the documented 0.0001 — a coarser sim tick would merge distinct levels.
  tickSize: 0.00001,
};

export interface SimFill {
  ms: number;
  side: 1 | -1;
  px: number;
  contracts: number;
  /** fair at fill time (diagnostic: fill edge = side·(fair − px)). */
  fairAtFill: number;
  /** side·(fair@+markoutMs − px)·contracts, $. Negative = adverse. */
  markout: number | null;
}

export interface MakerSimResult {
  marketId: string;
  snaps: number;
  quotedSnaps: number;
  fills: SimFill[];
  buyFills: number;
  sellFills: number;
  /** Realized P&L from fills that offset inventory (spread capture), $. */
  realizedTrading: number;
  /** Realized P&L from settlement of the residual position, $ (0 if no SETTLE). */
  realizedSettle: number;
  closeFees: number;
  settleFees: number;
  hedgeCost: number;
  /** Sum of per-fill markouts, $ (diagnostic — NOT part of net). */
  markoutTotal: number;
  markoutKnown: number;
  /** Position left open when the tape ended without a settle, marked to last fair. */
  endInventory: number;
  unrealizedEnd: number;
  /** Peak locked collateral, $ (long: px·n, short: (1−px)·n). */
  peakCollateral: number;
  /** realizedTrading + realizedSettle − fees − hedgeCost. Excludes unrealizedEnd. */
  net: number;
  tapeMs: number;
}

const YEAR_MS = 365.25 * 24 * 3600 * 1000;

/** One-σ move of the digital fair over horizon δt: φ(d2)·√(δt/T), probability units. */
export function widthFloor(d2: number, repriceMs: number, tYears: number, mult: number): number {
  if (tYears <= 0) return 1; // expired — effectively unquotable
  const dtYears = repriceMs / YEAR_MS;
  return mult * normPdf(d2) * Math.sqrt(dtYears / tYears);
}

/** Perp hedge notional per contract, $: |dp/dS|·S = φ(d2)/(σ√T). */
export function hedgeNotionalPerContract(d2: number, iv: number, tYears: number): number {
  if (tYears <= 0 || iv <= 0) return 0;
  return normPdf(d2) / (iv * Math.sqrt(tYears));
}

interface Quote {
  px: number;
  contracts: number;
}

/**
 * Simulate one market's tape. `snaps` must be time-ordered SNAPs of a single marketId;
 * `settledYes` is null when the tape ended before settlement.
 */
export function simulateMaker(
  snaps: TapeSnap[],
  settledYes: boolean | null,
  cfg: MakerSimConfig,
): MakerSimResult {
  const r: MakerSimResult = {
    marketId: snaps[0]?.marketId ?? '?',
    snaps: snaps.length,
    quotedSnaps: 0,
    fills: [],
    buyFills: 0,
    sellFills: 0,
    realizedTrading: 0,
    realizedSettle: 0,
    closeFees: 0,
    settleFees: 0,
    hedgeCost: 0,
    markoutTotal: 0,
    markoutKnown: 0,
    endInventory: 0,
    unrealizedEnd: 0,
    peakCollateral: 0,
    net: 0,
    tapeMs: snaps.length ? snaps[snaps.length - 1].ms - snaps[0].ms : 0,
  };
  if (snaps.length === 0) return r;

  let pos = 0; // signed contracts (+ long YES)
  let avgCost = 0;
  let bid: Quote | null = null;
  let ask: Quote | null = null;
  let lastQuoteMs = -Infinity;

  // All price comparisons happen in integer tick space — float px reconstructed from
  // ticks (0.49 → 0.49000000000000005) must never fake a strict trade-through.
  const toTicks = (p: number): number => Math.round(p / cfg.tickSize);
  const roundTick = (p: number, up: boolean): number => {
    const t = cfg.tickSize;
    const q = up ? Math.ceil(p / t - 1e-9) : Math.floor(p / t + 1e-9);
    return Math.min(0.999, Math.max(0.001, q * t));
  };

  const collateral = (): number => (pos >= 0 ? avgCost * pos : (1 - avgCost) * -pos);

  const applyFill = (snap: TapeSnap, side: 1 | -1, px: number, contracts: number): void => {
    // Offsetting portion realizes P&L and pays the close fee (we are the closing side).
    let n = contracts;
    if (pos !== 0 && Math.sign(pos) !== side) {
      const closed = Math.min(n, Math.abs(pos));
      r.realizedTrading += (side === 1 ? avgCost - px : px - avgCost) * closed;
      r.closeFees += (cfg.makerCloseFeeBps / 10_000) * px * closed;
      pos += side * closed;
      n -= closed;
      if (pos === 0) avgCost = 0;
    }
    if (n > 0) {
      // Opening portion: free at open (mint / normal-trade opener pays nothing).
      const newPos = pos + side * n;
      avgCost = pos === 0 ? px : (avgCost * Math.abs(pos) + px * n) / Math.abs(newPos);
      pos = newPos;
    }
    r.hedgeCost +=
      (cfg.hedgeCostBps / 10_000) *
      hedgeNotionalPerContract(snap.d2, snap.iv, snap.tYears) *
      contracts;
    r.fills.push({ ms: snap.ms, side, px, contracts, fairAtFill: snap.fairYes, markout: null });
    if (side === 1) r.buyFills++;
    else r.sellFills++;
  };

  for (const snap of snaps) {
    // 1) Fill check against standing quotes (strict trade-through, conservative size).
    const bestBid = snap.bids[0]?.[0];
    const bestAsk = snap.asks[0]?.[0];
    if (bid && bestAsk !== undefined && toTicks(bestAsk) < toTicks(bid.px)) {
      const bidTicks = toTicks(bid.px);
      const displayed = snap.asks
        .filter(([p]) => toTicks(p) <= bidTicks)
        .reduce((s, [, z]) => s + z, 0);
      const n = Math.min(bid.contracts, Math.floor(displayed));
      if (n > 0) applyFill(snap, 1, bid.px, n);
      bid = null; // consumed until next reprice
    }
    if (ask && bestBid !== undefined && toTicks(bestBid) > toTicks(ask.px)) {
      const askTicks = toTicks(ask.px);
      const displayed = snap.bids
        .filter(([p]) => toTicks(p) >= askTicks)
        .reduce((s, [, z]) => s + z, 0);
      const n = Math.min(ask.contracts, Math.floor(displayed));
      if (n > 0) applyFill(snap, -1, ask.px, n);
      ask = null;
    }
    r.peakCollateral = Math.max(r.peakCollateral, collateral());

    // 2) No-quote window near expiry: pull everything and stop quoting.
    const minToExpiry = (snap.expiryMs - snap.ms) / 60_000;
    if (minToExpiry < cfg.noQuoteMinutes) {
      bid = null;
      ask = null;
      continue;
    }

    // 3) Reprice on cadence.
    if (snap.ms - lastQuoteMs >= cfg.repriceMs) {
      lastQuoteMs = snap.ms;
      const w = Math.max(
        cfg.halfWidthProb,
        widthFloor(snap.d2, cfg.repriceMs, snap.tYears, cfg.floorMult),
      );
      const bidPx = roundTick(snap.fairYes - w, false);
      const askPx = roundTick(snap.fairYes + w, true);
      // Inventory cap: withhold the increasing side. Post-only: never cross the touch.
      bid =
        pos < cfg.maxInventory && (bestAsk === undefined || toTicks(bidPx) < toTicks(bestAsk))
          ? { px: bidPx, contracts: cfg.quoteContracts }
          : null;
      ask =
        pos > -cfg.maxInventory && (bestBid === undefined || toTicks(askPx) > toTicks(bestBid))
          ? { px: askPx, contracts: cfg.quoteContracts }
          : null;
      if (bid || ask) r.quotedSnaps++;
    }
  }

  // Markouts (diagnostic): fair at the first snap ≥ fill time + markoutMs.
  let j = 0;
  for (const f of r.fills) {
    const target = f.ms + cfg.markoutMs;
    while (j < snaps.length && snaps[j].ms < target) j++;
    if (j < snaps.length) {
      f.markout = f.side * (snaps[j].fairYes - f.px) * f.contracts;
      r.markoutTotal += f.markout;
      r.markoutKnown++;
    }
    j = 0; // fills are time-ordered but restart to stay simple/correct
  }

  // Settlement or end-of-tape.
  if (settledYes !== null && pos !== 0) {
    const y = settledYes ? 1 : 0;
    r.realizedSettle += pos > 0 ? (y - avgCost) * pos : (avgCost - y) * -pos;
    r.settleFees += (cfg.settleFeeBps / 10_000) * Math.abs(pos);
    r.hedgeCost +=
      (cfg.hedgeCostBps / 10_000) *
      hedgeNotionalPerContract(
        snaps[snaps.length - 1].d2,
        snaps[snaps.length - 1].iv,
        Math.max(snaps[snaps.length - 1].tYears, 1e-6),
      ) *
      Math.abs(pos);
    pos = 0;
    avgCost = 0;
  }
  r.endInventory = pos;
  if (pos !== 0) {
    const lastFair = snaps[snaps.length - 1].fairYes;
    r.unrealizedEnd = pos > 0 ? (lastFair - avgCost) * pos : (avgCost - lastFair) * -pos;
  }
  r.net = r.realizedTrading + r.realizedSettle - r.closeFees - r.settleFees - r.hedgeCost;
  return r;
}

export interface GridPoint {
  halfWidthProb: number;
  repriceMs: number;
  markets: number;
  snaps: number;
  fills: number;
  net: number;
  realizedTrading: number;
  realizedSettle: number;
  fees: number;
  hedgeCost: number;
  markoutTotal: number;
  markoutKnown: number;
  unrealizedEnd: number;
  peakCollateral: number;
  /** net per $ peak collateral per day of tape — THE pre-registered Phase-0 metric. */
  revenueDensity: number;
}

/** Run the width × cadence grid over per-market timelines; aggregate per grid point. */
export function runGrid(
  markets: { snaps: TapeSnap[]; settledYes: boolean | null }[],
  widths: number[],
  cadencesMs: number[],
  base: MakerSimConfig,
): GridPoint[] {
  const out: GridPoint[] = [];
  for (const w of widths) {
    for (const c of cadencesMs) {
      const cfg = { ...base, halfWidthProb: w, repriceMs: c };
      const gp: GridPoint = {
        halfWidthProb: w,
        repriceMs: c,
        markets: 0,
        snaps: 0,
        fills: 0,
        net: 0,
        realizedTrading: 0,
        realizedSettle: 0,
        fees: 0,
        hedgeCost: 0,
        markoutTotal: 0,
        markoutKnown: 0,
        unrealizedEnd: 0,
        peakCollateral: 0,
        revenueDensity: 0,
      };
      let tapeMsMax = 0;
      for (const m of markets) {
        const r = simulateMaker(m.snaps, m.settledYes, cfg);
        gp.markets++;
        gp.snaps += r.snaps;
        gp.fills += r.fills.length;
        gp.net += r.net;
        gp.realizedTrading += r.realizedTrading;
        gp.realizedSettle += r.realizedSettle;
        gp.fees += r.closeFees + r.settleFees;
        gp.hedgeCost += r.hedgeCost;
        gp.markoutTotal += r.markoutTotal;
        gp.markoutKnown += r.markoutKnown;
        gp.unrealizedEnd += r.unrealizedEnd;
        gp.peakCollateral += r.peakCollateral;
        tapeMsMax = Math.max(tapeMsMax, r.tapeMs);
      }
      const days = tapeMsMax / 86_400_000;
      gp.revenueDensity = gp.peakCollateral > 0 && days > 0 ? gp.net / gp.peakCollateral / days : 0;
      out.push(gp);
    }
  }
  return out;
}
