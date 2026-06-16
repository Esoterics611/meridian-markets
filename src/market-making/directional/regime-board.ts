// regime-board — the shared SCORER behind the Validated Board (REGIME_DIRECTIONAL_BOOK.md
// P2) and the live runner's gate (P4). It builds every (symbol × signal × horizon) trial
// from real history, scores each through the honest OOS gate (purged k-fold + deflated
// Sharpe over the WHOLE sweep's trials), and returns the per-trial verdicts. Both
// scripts/regime-bias-oos.ts (the morning board) and scripts/regime-book-live.ts (the
// gate-first runner) call this — so what the board VALIDATES is exactly what the live
// book is allowed to trade. One definition, no drift (CLAUDE.md §6).

import { sharpeStats } from '../../stat-arb/research/deflated-sharpe';
import { RegimeSeries, RegimeSignalSpec, regimeSignalPairs } from './regime-signals';
import { oosForwardReturnIc, verdictFor, biasMagnitudeCap, BiasVerdict } from '../bias/oos/forward-return-ic';

export interface LoadedSeries {
  readonly symbol: string;
  readonly series: RegimeSeries;
}

export interface ScoredTrial {
  readonly symbol: string;
  readonly spec: RegimeSignalSpec;
  readonly fwdHours: number;
  readonly horizonBars: number;
  /** Pooled OOS Spearman rank IC. */
  readonly oosIc: number;
  readonly hitRate: number;
  readonly dsr: number;
  readonly psr: number;
  readonly n: number;
  readonly verdict: BiasVerdict;
  /** Conviction magnitude cap (4·|IC|, ≤0.5) — only meaningful when VALIDATED. */
  readonly convCap: number;
}

export interface RegimeBoard {
  readonly trials: number;
  readonly sigmaSR: number;
  readonly perTrial: ScoredTrial[];
}

export interface BoardScoreConfig {
  /** Forward-return horizons in HOURS. */
  readonly fwdHours: readonly number[];
  /** Bar interval in hours (to convert horizons to bars). */
  readonly ivHours: number;
  /** Purged k-fold count. */
  readonly folds: number;
  /** Embargo fraction (lifted to cover the horizon inside the gate). */
  readonly embargoFrac: number;
}

/** A symbol's single best row (a VALIDATED one with the strongest IC if any, else the
 *  highest-IC near-miss) + whether it is eligible to trade. */
export interface BoardRow extends ScoredTrial {
  readonly eligible: boolean;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  let v = 0;
  for (const x of xs) v += (x - mean) ** 2;
  return Math.sqrt(v / (xs.length - 1));
}

/** Score every (symbol × signal × horizon) trial through the deflated OOS gate. */
export function scoreRegimeBoard(loaded: readonly LoadedSeries[], specs: readonly RegimeSignalSpec[], cfg: BoardScoreConfig): RegimeBoard {
  interface Pending {
    symbol: string;
    spec: RegimeSignalSpec;
    fwdHours: number;
    horizonBars: number;
    pairs: ReturnType<typeof regimeSignalPairs>;
    rawSharpe: number;
  }
  const pending: Pending[] = [];
  for (const L of loaded) {
    for (const fh of cfg.fwdHours) {
      const horizonBars = Math.max(1, Math.round(fh / cfg.ivHours));
      for (const spec of specs) {
        const pairs = regimeSignalPairs(spec, L.series, horizonBars);
        if (pairs.length < cfg.folds) continue;
        const rawSharpe = sharpeStats(pairs.map((p) => Math.sign(p.signal) * p.forwardReturn)).sharpe;
        pending.push({ symbol: L.symbol, spec, fwdHours: fh, horizonBars, pairs, rawSharpe });
      }
    }
  }
  const trials = pending.length;
  const sigmaSR = std(pending.map((p) => p.rawSharpe).filter(Number.isFinite));

  const perTrial: ScoredTrial[] = pending.map((p) => {
    const report = oosForwardReturnIc(p.pairs, p.horizonBars, { folds: cfg.folds, embargoFrac: cfg.embargoFrac, trials, sigmaSR });
    const verdict = verdictFor(report);
    return {
      symbol: p.symbol,
      spec: p.spec,
      fwdHours: p.fwdHours,
      horizonBars: p.horizonBars,
      oosIc: report.spearmanIc,
      hitRate: report.hitRate,
      dsr: report.deflated.dsr,
      psr: report.deflated.psr,
      n: report.n,
      verdict,
      convCap: verdict === 'VALIDATED' ? biasMagnitudeCap(report.spearmanIc) : 0,
    };
  });
  return { trials, sigmaSR, perTrial };
}

/** Collapse to ONE best row per symbol (prefer a VALIDATED signal with the strongest IC;
 *  else the highest-IC near-miss), sorted by IC descending — the printable board. */
export function bestPerSymbol(board: RegimeBoard): BoardRow[] {
  const bySymbol = new Map<string, ScoredTrial[]>();
  for (const t of board.perTrial) (bySymbol.get(t.symbol) ?? bySymbol.set(t.symbol, []).get(t.symbol)!).push(t);
  const rows: BoardRow[] = [];
  for (const [, ts] of bySymbol) {
    const validated = ts.filter((t) => t.verdict === 'VALIDATED');
    const pool = validated.length ? validated : ts;
    const best = pool.reduce((a, b) => (b.oosIc > a.oosIc ? b : a));
    rows.push({ ...best, eligible: best.verdict === 'VALIDATED' });
  }
  rows.sort((a, b) => b.oosIc - a.oosIc);
  return rows;
}

/** Per symbol, the VALIDATED signals (deduped to the strongest-IC horizon per signal kind)
 *  — the constituent set the live ConsensusBiasSource votes over. */
export function validatedSignalsPerSymbol(board: RegimeBoard): Map<string, ScoredTrial[]> {
  const out = new Map<string, ScoredTrial[]>();
  const bestByKind = new Map<string, Map<string, ScoredTrial>>();
  for (const t of board.perTrial) {
    if (t.verdict !== 'VALIDATED') continue;
    const kinds = bestByKind.get(t.symbol) ?? bestByKind.set(t.symbol, new Map()).get(t.symbol)!;
    const prev = kinds.get(t.spec.kind);
    if (!prev || t.oosIc > prev.oosIc) kinds.set(t.spec.kind, t);
  }
  for (const [symbol, kinds] of bestByKind) out.set(symbol, [...kinds.values()].sort((a, b) => b.oosIc - a.oosIc));
  return out;
}
