// RegimeUniverseAllocator — the CROSS-SECTIONAL capital allocator for the "take sides" desk
// (Playbook II P12, the headline). With a wide validated universe the desk can no longer give
// every name an equal slice — it must concentrate capital on its STRONGEST validated edges and
// stay inside the P5 desk-risk caps. This is the capital-budgeting step between the OOS board
// (which says WHICH edges are real + how strong) and the runner (which sizes the books).
//
// The rule, in order:
//   1. SELECT the top-N candidates by conviction (the IC-capped |bias|, the same conviction the
//      book sizes on). Ties broken by |IC|, then symbol, for determinism.
//   2. SIZE each: notional = baseNotional · conviction, capped at the per-symbol max — exactly
//      RegimeDirectionalBook's own conviction sizing, so the allocation matches what the book does.
//   3. ENFORCE the gross cap: if Σ|notional| > maxGross, scale ALL down uniformly (trim, never breach).
//   4. ENFORCE the net cap: if |Σ signed| > maxNet, reduce the HEAVIER side pro-rata until net == cap.
// Every output respects per-symbol ≤ max, gross ≤ maxGross, |net| ≤ maxNet — an over-budget
// request is TRIMMED, not breached (the asserted invariant). Pure + deterministic, USD throughout.

export interface AllocationCandidate {
  readonly symbol: string;
  /** Signed view: +1 long, −1 short, 0 flat (no allocation). */
  readonly side: -1 | 0 | 1;
  /** Conviction ∈ [0,1] — the IC-capped |bias| the book would size on. */
  readonly conviction: number;
  /** OOS rank IC (tiebreak + diagnostic). */
  readonly ic: number;
}

export interface AllocatorConfig {
  /** How many of the strongest edges to fund. */
  readonly topN: number;
  /** Full-conviction per-book notional (USD); notional = baseNotional·conviction. */
  readonly baseNotionalUsd: number;
  /** Hard per-symbol notional cap (USD). Default = baseNotionalUsd. */
  readonly perSymbolMaxUsd?: number;
  /** Desk gross cap: Σ|notional| ≤ this (USD). */
  readonly maxGrossUsd: number;
  /** Desk net cap: |Σ signed notional| ≤ this (USD). */
  readonly maxNetUsd: number;
}

export interface Allocation {
  readonly symbol: string;
  readonly side: -1 | 1;
  readonly notionalUsd: number;
  readonly conviction: number;
  readonly ic: number;
  /** Plain-English why (rank + any cap that bound it). */
  readonly reason: string;
}

export interface AllocationResult {
  readonly allocations: readonly Allocation[];
  readonly grossUsd: number;
  readonly netUsd: number;
  /** Symbols considered but not funded (below top-N or zero conviction/flat). */
  readonly excluded: readonly string[];
  /** Caps that actively bound the result (for the cockpit "why"). */
  readonly grossCapBound: boolean;
  readonly netCapBound: boolean;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

export function allocateUniverse(candidates: readonly AllocationCandidate[], cfg: AllocatorConfig): AllocationResult {
  const perSymbolMax = cfg.perSymbolMaxUsd ?? cfg.baseNotionalUsd;
  // 1. fundable = a real side + positive conviction; rank by conviction, then |IC|, then symbol.
  const fundable = candidates
    .filter((c) => c.side !== 0 && c.conviction > 0)
    .sort((a, b) => b.conviction - a.conviction || Math.abs(b.ic) - Math.abs(a.ic) || a.symbol.localeCompare(b.symbol));
  const selected = fundable.slice(0, Math.max(0, cfg.topN));
  const excluded = [
    ...fundable.slice(Math.max(0, cfg.topN)).map((c) => c.symbol),
    ...candidates.filter((c) => c.side === 0 || c.conviction <= 0).map((c) => c.symbol),
  ];

  // 2. conviction sizing, per-symbol capped.
  const sized = selected.map((c, idx) => {
    const raw = cfg.baseNotionalUsd * c.conviction;
    const capped = Math.min(raw, perSymbolMax);
    return { c, notionalUsd: capped, perSymbolBound: capped < raw, rank: idx + 1 };
  });

  // 3. gross cap — uniform downscale (never breach).
  let gross = sized.reduce((a, s) => a + s.notionalUsd, 0);
  let grossCapBound = false;
  if (gross > cfg.maxGrossUsd && gross > 0) {
    const g = cfg.maxGrossUsd / gross;
    for (const s of sized) s.notionalUsd *= g;
    grossCapBound = true;
    gross = cfg.maxGrossUsd;
  }

  // 4. net cap — reduce the heavier side pro-rata until |net| == cap (gross only decreases).
  let net = sized.reduce((a, s) => a + s.c.side * s.notionalUsd, 0);
  let netCapBound = false;
  if (Math.abs(net) > cfg.maxNetUsd) {
    const heavySide = net > 0 ? 1 : -1;
    const heavy = sized.filter((s) => s.c.side === heavySide);
    const heavyGross = heavy.reduce((a, s) => a + s.notionalUsd, 0);
    const excess = Math.abs(net) - cfg.maxNetUsd;
    if (heavyGross > 0) {
      for (const s of heavy) s.notionalUsd -= excess * (s.notionalUsd / heavyGross);
      netCapBound = true;
      net = heavySide * cfg.maxNetUsd;
    }
  }

  const allocations: Allocation[] = sized
    .filter((s) => s.notionalUsd > 0.005)
    .map((s) => {
      const bounds: string[] = [`#${s.rank} by conviction ${s.c.conviction.toFixed(2)}`];
      if (s.perSymbolBound) bounds.push('per-symbol cap');
      if (grossCapBound) bounds.push('gross-trimmed');
      if (netCapBound && s.c.side === (net >= 0 ? 1 : -1)) bounds.push('net-trimmed');
      return {
        symbol: s.c.symbol,
        side: s.c.side as -1 | 1,
        notionalUsd: round2(s.notionalUsd),
        conviction: s.c.conviction,
        ic: s.c.ic,
        reason: bounds.join(', '),
      };
    });

  return {
    allocations,
    grossUsd: round2(allocations.reduce((a, s) => a + s.notionalUsd, 0)),
    netUsd: round2(allocations.reduce((a, s) => a + s.side * s.notionalUsd, 0)),
    excluded,
    grossCapBound,
    netCapBound,
  };
}
