import { IQuoter } from '../quote/quoter.interface';
import { RiskGate } from '../risk/risk-gate';
import { LobReplayHarness, LobReplayConfig } from './lob-replay';
import { L2TapeStep } from './l2-tape';

// gamma-kappa-sweep — per-pool tuning of the inventory-aversion γ and arrival-decay
// κ (and the half-spread floor) for a market-making quoter, judged on the
// QUEUE-AWARE fills of LobReplayHarness rather than the fill-on-touch upper bound.
// This is the lever that was blocked until the L2 queue model landed (S33): you
// can only tune a quoter honestly once you stop pretending every touched quote
// fills. γ widens + skews the quote (more inventory-averse); κ controls how fast
// the half-spread tightens with arrival intensity; the floor caps how tight the
// venue/fee economics let you quote. The right (γ,κ) for a thin DEX pool is not the
// right one for a deep perp — hence per-pool.
//
// Capture-once, sweep-many: the harness is deterministic over a fixed tape, so a
// real L2 capture (scripts/mm-l2-tune.ts) is replayed for every grid point against
// the SAME flow — an apples-to-apples A/B, not noise between live windows. The
// quoter is REBUILT per (γ,κ): GlftQuoter/AvellanedaStoikovQuoter bake γ,κ from
// their build params and IGNORE ctx.riskAversion/arrivalDecay, so varying the
// harness ctx would be inert — the sweep injects a `buildQuoter` that bakes them.

export interface SweepCombo {
  gamma: number;
  kappa: number;
  /** Half-spread floor in bps of mid (the venue/fee break-even rail). */
  minHalfSpreadBps: number;
}

export interface SweepResult {
  combo: SweepCombo;
  queueFills: number;
  touchFills: number;
  fillRatio: number;
  /** realised + unrealised, fee-free (0bps) — the structural edge. */
  structuralUnits: bigint;
  /** structural − fees at the venue's maker bps — what the book actually nets. */
  makerNetUnits: bigint;
  spreadCapturedUnits: bigint;
  adverseSelectionUnits: bigint;
  maxDrawdownPct: number;
  /** Did this combo stay within the drawdown limit? (ranked above failing combos.) */
  ddPass: boolean;
}

export interface SweepGrid {
  gammas: number[];
  kappas: number[];
  /** Optional half-spread floors to sweep; defaults to [base.minHalfSpreadBps]. */
  minHalfSpreadsBps?: number[];
}

export interface SweepBase {
  quoteSizeUnits: bigint;
  capitalUnits: bigint;
  volWindowBars: number;
  volFloor: number;
  horizonBars: number;
  /** The venue's maker fee in bps (signed; − = rebate) — drives the fee column. */
  makerBps: number;
  minHalfSpreadBps: number;
  symbol?: string;
  riskGate?: RiskGate;
  /** Drawdown limit (%) a combo must respect to rank as ddPass. Default 2. */
  ddLimitPct?: number;
  /** Signed funding rate per hour (+ longs pay shorts) — accrued on held inventory, into makerNet. */
  fundingRatePerHour?: number;
}

export interface SweepOptions {
  tape: L2TapeStep[];
  grid: SweepGrid;
  /** Builds a quoter with γ,κ,minSpread baked in (registry-backed in the script, a stub in tests). */
  buildQuoter: (combo: SweepCombo) => IQuoter;
  base: SweepBase;
}

/**
 * Run the queue-aware harness over the tape for every (γ × κ × floor) combo and
 * return them ranked best-first: drawdown-compliant combos first, then by maker net.
 */
export function sweepGammaKappa(opts: SweepOptions): SweepResult[] {
  const { tape, grid, buildQuoter, base } = opts;
  const floors = grid.minHalfSpreadsBps && grid.minHalfSpreadsBps.length > 0 ? grid.minHalfSpreadsBps : [base.minHalfSpreadBps];
  const ddLimit = base.ddLimitPct ?? 2;
  const harness = new LobReplayHarness();
  const results: SweepResult[] = [];

  for (const gamma of grid.gammas) {
    for (const kappa of grid.kappas) {
      for (const minHalfSpreadBps of floors) {
        const combo: SweepCombo = { gamma, kappa, minHalfSpreadBps };
        const quoter = buildQuoter(combo);
        const cfg: LobReplayConfig = {
          tape,
          quoter,
          quoteSizeUnits: base.quoteSizeUnits,
          gamma, // inert for GLFT/AS (baked in the quoter) but kept consistent for ctx-reading quoters
          kappa,
          horizonBars: base.horizonBars,
          volWindowBars: base.volWindowBars,
          volFloor: base.volFloor,
          makerFeeBps: base.makerBps,
          capitalUnits: base.capitalUnits,
          symbol: base.symbol,
          riskGate: base.riskGate,
          fundingRatePerHour: base.fundingRatePerHour,
        };
        const m = harness.run(cfg);
        const structural = m.realisedPnlUnits + m.unrealisedPnlUnits;
        results.push({
          combo,
          queueFills: m.queueFills,
          touchFills: m.touchFills,
          fillRatio: m.fillRatio,
          structuralUnits: structural,
          makerNetUnits: m.netPnlUnits, // = structural − fees(at makerBps)
          spreadCapturedUnits: m.attribution.spreadCapturedUnits,
          adverseSelectionUnits: m.attribution.adverseSelectionUnits,
          maxDrawdownPct: m.maxDrawdownPct,
          ddPass: m.maxDrawdownPct <= ddLimit,
        });
      }
    }
  }

  return rankSweep(results);
}

/** Rank: drawdown-compliant combos first, then highest maker net (then structural, then DD). */
export function rankSweep(results: SweepResult[]): SweepResult[] {
  return [...results].sort((a, b) => {
    if (a.ddPass !== b.ddPass) return a.ddPass ? -1 : 1;
    if (a.makerNetUnits !== b.makerNetUnits) return a.makerNetUnits > b.makerNetUnits ? -1 : 1;
    if (a.structuralUnits !== b.structuralUnits) return a.structuralUnits > b.structuralUnits ? -1 : 1;
    return a.maxDrawdownPct - b.maxDrawdownPct;
  });
}
