// DeskDeltaHedger — neutralise the desk's residual directional (delta) exposure.
//
// Journal #41: the 8 neutral MM books are ONE short-gamma crypto-beta bet, not 8 edges.
// Per-book inventory caps bound each book's size but do NOTHING about the desk's NET delta —
// and that net delta is what price runs over (BTC/SOL/SUI/ETH all drew down in the same
// window). Hedging the net delta with a perp leg isolates the MARKET-MAKING edge (spread +
// rebate − adverse selection) from the directional variance — the move that turns the desk
// into a working mode rather than a levered beta punt.
//
// This module is the pure model: aggregate per-book delta → beta-weighted net delta per hedge
// underlying → a BANDED rebalance order (don't pay the spread to chase noise) → the hedge cost
// and funding carry. The live taker leg that executes these orders on the fast path is the
// wiring step (see HEDGING_MODEL.md §2 + the MmPortfolioTrader). The LINEAR/perp hedge lives
// here; the long-gamma OPTIONS overlay (the 2nd-order, short-realised-vol hedge) is the model
// in HEDGING_MODEL.md §3 — perps kill the delta, long gamma caps the move you re-hedge into.

const MICROS = 1_000_000;

/** One book's signed exposure: long inventory ⇒ inventoryUnits > 0. */
export interface BookDelta {
  /** The book's underlying (BTC, ETH, SOL, …). */
  symbol: string;
  /** Signed 6-decimal asset units held (long > 0, short < 0). */
  inventoryUnits: bigint;
  /** Mid price in micro-USD per unit (= price · 1e6); the live mark. */
  midMicros: bigint;
  /** Signed aggressor-flow imbalance ∈ [−1,1] at this book (F1: a flow sign-flip freezes hedge
   *  ADDS on the book's underlying — the front of the move is reversing). Optional: omitted by
   *  the bar path / older callers ⇒ no flow gating. */
  flow?: number;
}

/** How a book symbol maps onto a hedge underlying + its beta to that underlying. */
export interface BetaMapEntry {
  /** The perp we actually trade to hedge this book (often the book's own symbol). */
  underlying: string;
  /** Sensitivity of this book's move to the hedge underlying's move (BTC→1, an alt→~1.1). */
  beta: number;
}

export interface HedgeConfig {
  /** Rebalance only when the residual |net delta| in an underlying exceeds this many USD.
   *  The dead-band stops us paying the taker spread to chase noise around zero. */
  bandUsd: number;
  /** book symbol → hedge underlying + beta. Books on the same underlying net off; alts can map
   *  to a major (SOL→{underlying:'BTC', beta:1.1}) so a single BTC perp hedges the basket —
   *  the capital-efficient read of "8 books = 1 beta bet". Unmapped symbols self-hedge (beta 1). */
  betaMap: Record<string, BetaMapEntry>;
  /** Taker fee (bps) paid to cross when rebalancing the hedge (HL perp taker ≈ +2.5bps). */
  hedgeTakerBps: number;
  /** Half-spread (bps) crossed on the hedge perp when rebalancing. */
  hedgeHalfSpreadBps: number;
  /** Hedge-quality KPI sampling bucket, ms (WP1.1 — Epps: tick-cadence returns decorrelate alts
   *  from majors mechanically, so β/R²/basis are measured on coarser buckets). Default 60s. */
  qualityBucketMs?: number;

  // ── F1 anti-churn (Journal #60; run55: 56 orders / 19 flips / $1.62M churned ≈ −$437) ──
  /** Min hold per hedge leg: no re-fire on an underlying faster than this. 0/undefined = off. */
  minHoldMs?: number;
  /** After a hedge direction FLIP on a leg, freeze further flips for this long; a book flow
   *  sign-flip freezes ADDS (open/increase/flip) on its underlying for the same interval. */
  flipCooldownMs?: number;
  /** |flow| below this is noise — a flow sign only counts (for the flip-freeze) at/above it. */
  flowFreezeThreshold?: number;
  /** Per-book basis gate: 'flatten' books are EXCLUDED from the hedge plan (their basis is so
   *  poor the cross-hedge is a second bet — let the book's own stops/skew bound them); unlisted
   *  books default to 'hedge'. run55 priors: FARTCOIN/kPEPE/ADA → flatten. */
  basisPolicy?: Record<string, 'hedge' | 'flatten'>;
  /** Per-underlying no-trade band override (USD); falls back to bandUsd. */
  bandUsdByUnderlying?: Record<string, number>;
}

export interface HedgeUnderlyingState {
  underlying: string;
  /** Beta-weighted net desk delta in this underlying, USD (net-long books ⇒ +). */
  netDeltaUsd: number;
  /** Hedge notional currently held in this underlying, USD (a short hedge ⇒ −). */
  hedgeNotionalUsd: number;
  /** What price still runs over after the current hedge: netDelta + hedge. */
  residualUsd: number;
}

export interface HedgeOrder {
  underlying: string;
  /** sell = short the perp (hedges a net-LONG book); buy = cover/long (hedges a net-short book). */
  side: 'buy' | 'sell';
  /** Size of the rebalancing taker order, USD notional (always ≥ 0). */
  notionalUsd: number;
  /** Taker + half-spread cost of this rebalance, USD (to charge the books). */
  costUsd: number;
  reason: 'open' | 'increase' | 'reduce' | 'flip';
}

export interface HedgePlan {
  states: HedgeUnderlyingState[];
  orders: HedgeOrder[];
  /** Σ|order notional| · bps — the spread bill this rebalance pays. */
  totalCostUsd: number;
  /** Gross beta-weighted desk delta before hedging, Σ|netDelta| — the size of the bet we carry. */
  grossDeltaUsd: number;
}

/** USD delta of one book = (units/1e6 coins) · (midMicros/1e6 USD/coin). */
export function bookDeltaUsd(b: BookDelta): number {
  return (Number(b.inventoryUnits) / MICROS) * (Number(b.midMicros) / MICROS);
}

/** Aggregate books into beta-weighted net delta per hedge underlying. */
export function netDeltaByUnderlying(books: BookDelta[], betaMap: HedgeConfig['betaMap']): Record<string, number> {
  const net: Record<string, number> = {};
  for (const b of books) {
    const m = betaMap[b.symbol] ?? { underlying: b.symbol, beta: 1 };
    if (m.beta === 0) continue; // explicit "do not hedge" (no crypto factor — e.g. HIP-3 RWAs)
    net[m.underlying] = (net[m.underlying] ?? 0) + m.beta * bookDeltaUsd(b);
  }
  return net;
}

/**
 * The banded hedge rebalance. For each hedge underlying:
 *  - residual = netDelta + currentHedge (the hedge carries the OPPOSITE sign of the books).
 *  - |residual| ≤ band ⇒ no order (don't pay the spread to chase noise around flat).
 *  - else trade to flatten the residual: order notional = −residual, costed at taker + half-spread.
 *
 * `currentHedgeUsd` is the hedge we already hold per underlying (short ⇒ negative). Pure: it does
 * not execute — it returns the orders for the live taker leg to fill and the cost to attribute.
 */
export function computeHedge(books: BookDelta[], currentHedgeUsd: Record<string, number>, cfg: HedgeConfig): HedgePlan {
  const net = netDeltaByUnderlying(books, cfg.betaMap);
  const underlyings = new Set<string>([...Object.keys(net), ...Object.keys(currentHedgeUsd)]);
  const states: HedgeUnderlyingState[] = [];
  const orders: HedgeOrder[] = [];
  let totalCostUsd = 0;
  let grossDeltaUsd = 0;

  for (const u of [...underlyings].sort()) {
    const netDeltaUsd = net[u] ?? 0;
    const hedgeNotionalUsd = currentHedgeUsd[u] ?? 0;
    const residualUsd = netDeltaUsd + hedgeNotionalUsd;
    grossDeltaUsd += Math.abs(netDeltaUsd);
    states.push({ underlying: u, netDeltaUsd, hedgeNotionalUsd, residualUsd });
    if (Math.abs(residualUsd) <= cfg.bandUsd) continue;

    const tradeUsd = -residualUsd; // flatten the residual back to zero net delta
    const side: 'buy' | 'sell' = tradeUsd > 0 ? 'buy' : 'sell';
    const costUsd = (Math.abs(tradeUsd) * (cfg.hedgeTakerBps + cfg.hedgeHalfSpreadBps)) / 1e4;
    const newHedge = hedgeNotionalUsd + tradeUsd;
    const reason: HedgeOrder['reason'] =
      hedgeNotionalUsd === 0
        ? 'open'
        : newHedge !== 0 && Math.sign(newHedge) !== Math.sign(hedgeNotionalUsd)
          ? 'flip'
          : Math.abs(newHedge) > Math.abs(hedgeNotionalUsd)
            ? 'increase'
            : 'reduce';
    orders.push({ underlying: u, side, notionalUsd: Math.abs(tradeUsd), costUsd, reason });
    totalCostUsd += costUsd;
  }

  return { states, orders, totalCostUsd, grossDeltaUsd };
}

/**
 * Funding carry on the held hedge over one funding interval. A SHORT perp (hedgeNotional < 0)
 * EARNS funding when the rate is positive (longs pay shorts) — so hedging a long-biased book can
 * be carry-POSITIVE (ties to the funding-carry findings). Signed USD: + = the desk receives.
 */
export function hedgeFundingCarryUsd(hedgeNotionalUsd: number, fundingBps: number): number {
  return (-hedgeNotionalUsd * fundingBps) / 1e4;
}

/** Convert a hedge order's USD notional into 6-dec perp units at the live mid (venue boundary). */
export function hedgeOrderUnits(notionalUsd: number, midMicros: bigint): bigint {
  const price = Number(midMicros) / MICROS;
  if (!(price > 0) || !Number.isFinite(notionalUsd) || notionalUsd <= 0) return 0n;
  return BigInt(Math.max(0, Math.round((notionalUsd / price) * MICROS)));
}
