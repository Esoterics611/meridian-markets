// regime-stress — the scenario / stress harness for the "take sides" desk (Playbook II P11).
// The OOS gate proves an edge on average history; this proves the desk SURVIVES the tails: a
// flash crash, a simultaneous vol spike, a funding sign-flip across the book, and a stale/gapped
// feed. It runs the REAL components — RegimeDirectionalBook (P1, stop + decay + flatten), the
// RegimeMonitor (P3 weather → STAND_ASIDE), and the RegimeDeskRisk spine (P5 caps + kill-switch)
// — over a synthetic shocked path and records the desk's PROTECTIVE response, so the assertions
// below are a regression guard, not a one-off check.
//
// Pure + clock-free (synthetic ms clock, no I/O), exactly like the rest of the directional desk,
// so every scenario is a deterministic jest case. The script wrapper just prints the scorecard.

import { RegimeDirectionalBook } from './regime-directional-book';
import { RegimeMonitor, RegimeState } from './regime-monitor';
import { RegimeDeskRisk, BookRiskInput } from './regime-desk-risk';
import { BiasReading } from '../bias/bias-source.interface';

const MICROS = 1_000_000;
const toMicros = (x: number): bigint => BigInt(Math.round(x * MICROS));
const HOUR = 3_600_000;

export type StressScenarioKind = 'flash-crash' | 'vol-spike' | 'funding-flip' | 'feed-blackout';
export const STRESS_SCENARIOS: readonly StressScenarioKind[] = ['flash-crash', 'vol-spike', 'funding-flip', 'feed-blackout'];

export interface StressConfig {
  /** The shocked universe. Default ['BTC','ETH','SOL']. */
  readonly symbols?: readonly string[];
  /** Per-book full-conviction notional (USD). Default 50_000. */
  readonly baseNotionalUsd?: number;
  /** Directional stop fraction. Default 0.02. */
  readonly stopFrac?: number;
  /** Desk maxDD budget (fraction of capital). Default 0.02. */
  readonly maxDrawdownFrac?: number;
  /** Warmup steps (calm, to seat a position + warm the vol EWMA) before the shock. Default 14. */
  readonly warmupSteps?: number;
  /** Shock steps. Default 6. */
  readonly shockSteps?: number;
}

export interface StressStep {
  readonly tMs: number;
  readonly midUsd: number;
  readonly fundingRatePerHour: number;
  readonly basisBps: number;
  readonly ret: number;
  readonly feedStale: boolean;
  /** The (already validated/unvalidated) consensus reading the desk would express this step. */
  readonly bias: number;
  readonly validated: boolean;
}

export interface StressResult {
  readonly scenario: StressScenarioKind;
  readonly steps: number;
  readonly symbols: number;
  /** Loss-stops that fired across all books. */
  readonly stopsFired: number;
  /** Books whose monitor read STAND_ASIDE at the end of the shock. */
  readonly standAsideBooks: number;
  /** True ⇔ EVERY book that held a position during the shock went STAND_ASIDE. */
  readonly allHeldStoodAside: boolean;
  /** Regime-change transitions fired (funding side-flips / hazard escalations). */
  readonly regimeTransitions: number;
  readonly deskHalted: boolean;
  readonly haltReason: string | null;
  /** Desk equity maxDD as a fraction of capital over the run. */
  readonly maxDrawdownFrac: number;
  readonly budgetFrac: number;
  /** The headline invariant: maxDD stayed inside the budget OR the kill-switch engaged. */
  readonly budgetRespected: boolean;
  /** Every book flat at the end of the run. */
  readonly flatAtEnd: boolean;
}

/** Build the synthetic per-symbol shocked path for a scenario. */
export function buildStressPath(kind: StressScenarioKind, cfg: Required<StressConfig>): Map<string, StressStep[]> {
  const out = new Map<string, StressStep[]>();
  const W = cfg.warmupSteps;
  const S = cfg.shockSteps;
  const t0 = 1_700_000_000_000;
  // A modest, persistent funding tailwind during warmup (paid-short ⇒ the book leans LONG via +bias).
  const warmFunding = 1.5e-5; // ≈ FAVORABLE band

  for (let s = 0; s < cfg.symbols.length; s++) {
    const sym = cfg.symbols[s];
    const steps: StressStep[] = [];
    let mid = 100 + s * 10; // distinct price scales per symbol (σ-invariance is real — see S31)
    let prev = mid;
    // ── warmup: calm, small noise, a clear validated LONG view so the book seats a position ──
    for (let i = 0; i < W; i++) {
      const noise = (i % 2 === 0 ? 1 : -1) * 0.0008; // ±8bp calm chop
      prev = mid;
      mid = mid * (1 + noise);
      steps.push({
        tMs: t0 + i * HOUR,
        midUsd: mid,
        fundingRatePerHour: warmFunding,
        basisBps: 1.5,
        ret: Math.log(mid / prev),
        feedStale: false,
        bias: 0.5, // strong validated long
        validated: true,
      });
    }
    // ── shock ──
    for (let i = 0; i < S; i++) {
      const tMs = t0 + (W + i) * HOUR;
      let funding = warmFunding;
      let basis = 1.5;
      let feedStale = false;
      let bias = 0.5;
      prev = mid;
      if (kind === 'flash-crash') {
        // a single −15% gap on the first shock step, then flat at the new level.
        mid = i === 0 ? mid * 0.85 : mid;
      } else if (kind === 'vol-spike') {
        // big alternating returns (×~6 normal) — price oscillates, vol EWMA ratio spikes.
        mid = mid * (1 + (i % 2 === 0 ? 0.05 : -0.0476));
      } else if (kind === 'funding-flip') {
        // funding flips hard negative (paid-long) ⇒ the supplied view flips LONG→SHORT.
        funding = -3e-5;
        bias = -0.5;
        mid = mid * (1 + (i % 2 === 0 ? 0.0008 : -0.0008));
      } else if (kind === 'feed-blackout') {
        feedStale = true;
        mid = mid * (1 + (i % 2 === 0 ? 0.0008 : -0.0008));
      }
      steps.push({ tMs, midUsd: mid, fundingRatePerHour: funding, basisBps: basis, ret: Math.log(mid / prev), feedStale, bias, validated: true });
    }
    out.set(sym, steps);
  }
  return out;
}

/** Run a stress scenario across the desk and return the protective-response scorecard. */
export function runStressScenario(kind: StressScenarioKind, config: StressConfig = {}): StressResult {
  const cfg: Required<StressConfig> = {
    symbols: config.symbols ?? ['BTC', 'ETH', 'SOL'],
    baseNotionalUsd: config.baseNotionalUsd ?? 50_000,
    stopFrac: config.stopFrac ?? 0.02,
    maxDrawdownFrac: config.maxDrawdownFrac ?? 0.02,
    warmupSteps: config.warmupSteps ?? 14,
    shockSteps: config.shockSteps ?? 6,
  };
  const n = cfg.symbols.length;
  const capitalUsd = cfg.baseNotionalUsd * n;
  const path = buildStressPath(kind, cfg);

  let regimeTransitions = 0;
  const books = new Map<string, RegimeDirectionalBook>();
  const monitors = new Map<string, RegimeMonitor>();
  const lastState = new Map<string, RegimeState>();
  const heldAtShockStart = new Set<string>();
  for (const sym of cfg.symbols) {
    books.set(sym, new RegimeDirectionalBook({ baseNotionalUsd: cfg.baseNotionalUsd, stopFrac: cfg.stopFrac, book: sym }));
    monitors.set(sym, new RegimeMonitor(sym, { onRegimeChange: () => regimeTransitions++ }));
  }
  const deskRisk = new RegimeDeskRisk({
    maxGrossUsd: cfg.baseNotionalUsd * n * 2,
    maxNetUsd: cfg.baseNotionalUsd * n * 2,
    dailyLossLimitUsd: capitalUsd, // let the maxDD breaker own the budget test (not the daily-loss one)
    capitalUsd,
    maxDrawdownFrac: cfg.maxDrawdownFrac,
  });

  const steps = path.get(cfg.symbols[0])!.length;
  const warmup = cfg.warmupSteps;
  let stopsFired = 0;
  let peakEquityUsd = 0;
  let maxDrawdownUsd = 0;

  for (let i = 0; i < steps; i++) {
    // Capture which books held a position at the moment the shock begins (pre-update), so
    // "every HELD book stood aside" is judged against positions actually exposed to the shock.
    if (i === warmup) for (const sym of cfg.symbols) if (books.get(sym)!.inventoryUnits() !== 0n) heldAtShockStart.add(sym);

    // 1. weather per symbol (pre-update), then the desk-risk assessment on pre-update positions.
    for (const sym of cfg.symbols) {
      const st = path.get(sym)![i];
      const state = monitors.get(sym)!.update({ nowMs: st.tMs, fundingRatePerHour: st.fundingRatePerHour, basisBps: st.basisBps, ret: st.ret, feedStale: st.feedStale });
      lastState.set(sym, state);
    }
    const riskInputs: BookRiskInput[] = cfg.symbols.map((sym) => {
      const b = books.get(sym)!;
      const mid = toMicros(path.get(sym)![i].midUsd);
      const inv = b.inventoryUnits();
      const absInv = inv < 0n ? -inv : inv;
      const notionalUsd = Number((absInv * mid) / BigInt(MICROS)) / MICROS;
      const snap = b.snapshot(mid);
      return {
        symbol: sym,
        notionalUsd,
        side: inv > 0n ? 'LONG' : inv < 0n ? 'SHORT' : 'FLAT',
        realisedPnlUsd: Number(snap.realisedUnits - snap.feesUnits + snap.fundingUnits) / MICROS,
        unrealisedPnlUsd: Number(snap.unrealisedUnits) / MICROS,
      };
    });
    const assessment = deskRisk.assess(riskInputs);

    // 2. update each book under its weather + desk-risk verdict.
    for (const sym of cfg.symbols) {
      const st = path.get(sym)![i];
      const state = lastState.get(sym)!;
      const verdict = assessment.perBook.get(sym);
      const flatten = assessment.desk.kind === 'Halt' || verdict?.kind === 'FlattenNow';
      const reading: BiasReading = { bias: st.bias, validated: st.validated, reason: `stress:${kind}` };
      const book = books.get(sym)!;
      const action = book.update({
        nowMs: st.tMs,
        midMicros: toMicros(st.midUsd),
        reading,
        fundingRatePerHour: st.fundingRatePerHour,
        standAside: state.standAside || flatten,
      });
      if (action.trigger === 'loss-stop') stopsFired++;
    }

    // 3. desk equity maxDD (realised + open mark).
    let equityUsd = 0;
    for (const sym of cfg.symbols) equityUsd += Number(books.get(sym)!.totalPnlUnits(toMicros(path.get(sym)![i].midUsd))) / MICROS;
    if (equityUsd > peakEquityUsd) peakEquityUsd = equityUsd;
    const ddUsd = peakEquityUsd - equityUsd;
    if (ddUsd > maxDrawdownUsd) maxDrawdownUsd = ddUsd;
  }

  // count books standing aside at the end of the shock + whether all held books stood aside.
  let standAsideBooks = 0;
  let allHeldStoodAside = heldAtShockStart.size > 0; // false (not vacuously true) if nothing was exposed
  for (const sym of cfg.symbols) {
    const aside = lastState.get(sym)!.standAside;
    if (aside) standAsideBooks++;
    if (heldAtShockStart.has(sym) && !aside) allHeldStoodAside = false;
  }

  let flatAtEnd = true;
  for (const sym of cfg.symbols) if (books.get(sym)!.inventoryUnits() !== 0n) flatAtEnd = false;

  const maxDrawdownFrac = capitalUsd > 0 ? maxDrawdownUsd / capitalUsd : 0;
  return {
    scenario: kind,
    steps,
    symbols: n,
    stopsFired,
    standAsideBooks,
    allHeldStoodAside,
    regimeTransitions,
    deskHalted: deskRisk.isHalted(),
    haltReason: deskRisk.haltReason(),
    maxDrawdownFrac,
    budgetFrac: cfg.maxDrawdownFrac,
    budgetRespected: maxDrawdownFrac <= cfg.maxDrawdownFrac || deskRisk.isHalted(),
    flatAtEnd,
  };
}
