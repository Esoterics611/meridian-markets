/**
 * mm-l2-tune — per-pool γ/κ tuning for a market-making quoter, judged on the
 * QUEUE-AWARE fills of the LobReplayHarness (S33) at the VENUE'S REAL maker fee
 * (venue-fees.ts). This is the lever that was blocked until the L2 queue model
 * landed: you can only tune γ (inventory aversion) and κ (arrival decay) honestly
 * once you stop assuming every touched quote fills.
 *
 * Capture-once, sweep-many. First capture a real L2 tape with mm-l2-session and
 * save it; then sweep this script over the SAME flow for every grid point — an
 * apples-to-apples A/B, not noise between live windows:
 *
 *   # 1) capture + save a real HL tape (run for a while on your own box):
 *   MM_L2_POLL_S=60 MM_L2_DURATION_MIN=120 MM_L2_COINS=BTC,ETH,SOL \
 *     MM_L2_SAVE_TAPE=docs/research/l2-tapes/run1 \
 *     npx ts-node -r tsconfig-paths/register scripts/mm-l2-session.ts
 *   # 2) sweep γ/κ over the saved tapes (fast, deterministic, offline):
 *   MM_TUNE_TAPE_PREFIX=docs/research/l2-tapes/run1 MM_TUNE_COINS=BTC,ETH,SOL \
 *     npx ts-node -r tsconfig-paths/register scripts/mm-l2-tune.ts
 *
 * The winner per coin is the drawdown-compliant (γ,κ,floor) with the highest
 * maker-net P&L — the per-pool quote calibration the live book should adopt.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { mmStrategyRegistry } from '../src/market-making/registry/mm-strategy-registry';
import { CompositeRiskGate } from '../src/market-making/risk/risk-gate';
import { parseTape } from '../src/market-making/backtest/l2-tape-io';
import { midMicros } from '../src/market-making/microstructure/order-book';
import { venueFeeFor } from '../src/market-making/backtest/venue-fees';
import { sweepGammaKappa, SweepCombo, SweepResult } from '../src/market-making/backtest/gamma-kappa-sweep';
import { L2TapeStep } from '../src/market-making/backtest/l2-tape';

// ---- config -----------------------------------------------------------------
const STRATEGY = process.env.MM_TUNE_STRATEGY ?? 'mm-glft';
const SOURCE = (process.env.MM_TUNE_SOURCE ?? 'hyperliquid').trim().toLowerCase();
const nums = (v: string | undefined, d: number[]): number[] =>
  v ? v.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : d;
const GAMMAS = nums(process.env.MM_TUNE_GAMMAS, [0.0005, 0.0025, 0.01, 0.05]);
const KAPPAS = nums(process.env.MM_TUNE_KAPPAS, [1, 2, 5]);
const FLOORS = nums(process.env.MM_TUNE_MIN_BPS, [0.5, 1, 2, 5]);
const MAX_BPS = Number(process.env.MM_TUNE_MAX_BPS ?? 200);
const MAX_LOTS = Number(process.env.MM_TUNE_MAX_LOTS ?? 8);
const QUOTE_USD = Number(process.env.MM_TUNE_QUOTE_USD ?? 50_000);
const CAPITAL_USD = Number(process.env.MM_TUNE_CAPITAL_USD ?? 1_000_000);
const VOL_WINDOW = Number(process.env.MM_TUNE_VOL_WINDOW ?? 20);
const VOL_FLOOR = Number(process.env.MM_TUNE_VOL_FLOOR ?? 0.0001);
const HORIZON = Number(process.env.MM_TUNE_HORIZON ?? 1);
const DD_LIMIT = Number(process.env.MM_TUNE_DD_LIMIT ?? 2);
const TOP = Number(process.env.MM_TUNE_TOP ?? 8);

const usd = (units: bigint): string => (Number(units) / 1e6).toFixed(2);
const sgn = (units: bigint): string => (units >= 0n ? '+' : '') + usd(units);
const pad = (s: string | number, n: number): string => String(s).padStart(n);

// ---- tape loading -----------------------------------------------------------
function tapeFiles(): string[] {
  const explicit = (process.env.MM_TUNE_TAPES ?? '').trim();
  if (explicit) return explicit.split(',').map((s) => s.trim()).filter(Boolean);
  const prefix = (process.env.MM_TUNE_TAPE_PREFIX ?? '').trim();
  const coins = (process.env.MM_TUNE_COINS ?? 'BTC,ETH,SOL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!prefix) throw new Error('set MM_TUNE_TAPES=a.json,b.json OR MM_TUNE_TAPE_PREFIX=... (+ MM_TUNE_COINS) — capture with mm-l2-session MM_L2_SAVE_TAPE first');
  return coins.map((c) => `${prefix}-${c}.json`);
}

interface LoadedTape {
  coin: string;
  file: string;
  tape: L2TapeStep[];
  midPrice: number;
}

function loadTapes(): LoadedTape[] {
  const out: LoadedTape[] = [];
  for (const file of tapeFiles()) {
    let tape: L2TapeStep[];
    try {
      tape = parseTape(readFileSync(file, 'utf8'));
    } catch (e) {
      console.log(`  ! skip ${file}: ${(e as Error).message}`);
      continue;
    }
    if (tape.length === 0) {
      console.log(`  ! skip ${file}: empty tape`);
      continue;
    }
    const mid = midMicros(tape[0].book);
    const coin = tape[0].book.symbol;
    out.push({ coin, file, tape, midPrice: mid ? Number(mid) / 1e6 : 0 });
  }
  return out;
}

// ---- sweep one tape ---------------------------------------------------------
function tuneOne(lt: LoadedTape): SweepResult[] {
  const fee = venueFeeFor(SOURCE);
  const quoteUnits = BigInt(Math.max(1, Math.round((QUOTE_USD / Math.max(lt.midPrice, 1e-9)) * 1e6)));
  const riskGate = new CompositeRiskGate({
    maxInventoryUnits: quoteUnits * BigInt(MAX_LOTS),
    minNavRatio: 1 - DD_LIMIT / 100,
    vpinPauseThreshold: 2,
    vpinPauseMs: 30_000,
    maxAdverseUnits: 1_000_000_000_000_000n,
    adversePauseMs: 30_000,
  });
  const buildQuoter = (combo: SweepCombo) =>
    mmStrategyRegistry.build(STRATEGY, {
      quoteSizeUnits: quoteUnits,
      minHalfSpreadBps: combo.minHalfSpreadBps,
      maxHalfSpreadBps: MAX_BPS,
      maxInventoryLots: MAX_LOTS,
      params: { gamma: combo.gamma, kappa: combo.kappa },
    });
  return sweepGammaKappa({
    tape: lt.tape,
    grid: { gammas: GAMMAS, kappas: KAPPAS, minHalfSpreadsBps: FLOORS },
    buildQuoter,
    base: {
      quoteSizeUnits: quoteUnits,
      capitalUnits: BigInt(Math.round(CAPITAL_USD * 1e6)),
      volWindowBars: VOL_WINDOW,
      volFloor: VOL_FLOOR,
      horizonBars: HORIZON,
      makerBps: fee.makerBps,
      minHalfSpreadBps: FLOORS[0] ?? 1,
      symbol: lt.coin,
      riskGate,
      ddLimitPct: DD_LIMIT,
    },
  });
}

function reportCoin(lt: LoadedTape, ranked: SweepResult[]): SweepResult | undefined {
  const fee = venueFeeFor(SOURCE);
  console.log(`\n=== ${lt.coin}  (${lt.tape.length} steps, mid $${lt.midPrice.toFixed(2)}, ${fee.makerBps}bps maker) ===`);
  console.log('  rank  gamma     kappa  floorBps  queueFills  ratio   spread      adverse     structural  makerNet    maxDD%   dd');
  ranked.slice(0, TOP).forEach((r, i) => {
    console.log(
      `  ${pad(i + 1, 4)}  ${pad(r.combo.gamma, 8)}  ${pad(r.combo.kappa, 5)}  ${pad(r.combo.minHalfSpreadBps, 8)}  ` +
        `${pad(r.queueFills, 10)}  ${r.fillRatio.toFixed(3)}  ${sgn(r.spreadCapturedUnits).padStart(9)}  ` +
        `${sgn(r.adverseSelectionUnits).padStart(9)}  ${sgn(r.structuralUnits).padStart(10)}  ${sgn(r.makerNetUnits).padStart(10)}  ` +
        `${r.maxDrawdownPct.toFixed(3).padStart(6)}  ${r.ddPass ? 'ok' : 'FAIL'}`,
    );
  });
  const winner = ranked.find((r) => r.ddPass) ?? ranked[0];
  if (winner) {
    console.log(
      `  → winner: γ=${winner.combo.gamma} κ=${winner.combo.kappa} floor=${winner.combo.minHalfSpreadBps}bps  ` +
        `makerNet=${sgn(winner.makerNetUnits)}  maxDD=${winner.maxDrawdownPct.toFixed(3)}%  ` +
        `(${winner.makerNetUnits > 0n ? 'POSITIVE' : 'still negative'} at this venue's maker fee)`,
    );
  }
  return winner;
}

// ---- main -------------------------------------------------------------------
function main(): void {
  if (!mmStrategyRegistry.has(STRATEGY)) throw new Error(`unknown MM strategy '${STRATEGY}'`);
  const combos = GAMMAS.length * KAPPAS.length * FLOORS.length;
  console.log(`\n=== Meridian MM L2 γ/κ tuning — ${STRATEGY} on ${SOURCE} (queue-aware fills) ===`);
  console.log(`  grid: ${GAMMAS.length}γ × ${KAPPAS.length}κ × ${FLOORS.length} floors = ${combos} combos/coin`);
  console.log(`  γ∈{${GAMMAS.join(',')}} κ∈{${KAPPAS.join(',')}} floor∈{${FLOORS.join(',')}}bps | lot $${QUOTE_USD.toLocaleString()} | DD limit ${DD_LIMIT}%`);

  const tapes = loadTapes();
  if (tapes.length === 0) throw new Error('no tapes loaded — capture with mm-l2-session MM_L2_SAVE_TAPE=... first');

  const winners: { coin: string; w: SweepResult | undefined }[] = [];
  for (const lt of tapes) winners.push({ coin: lt.coin, w: reportCoin(lt, tuneOne(lt)) });

  console.log(`\n=== DESK: per-coin winning calibration ===`);
  for (const { coin, w } of winners) {
    if (!w) continue;
    console.log(
      `  ${coin.padEnd(5)}  γ=${pad(w.combo.gamma, 7)}  κ=${pad(w.combo.kappa, 4)}  floor=${pad(w.combo.minHalfSpreadBps, 4)}bps  ` +
        `→ makerNet ${sgn(w.makerNetUnits)}  maxDD ${w.maxDrawdownPct.toFixed(3)}%`,
    );
  }
  console.log(`\n  CAVEAT: the tape's aggressive volume is a candle-derived estimate (mm-l2-session); the`);
  console.log(`  winner is the best calibration FOR THIS CAPTURED FLOW. Re-capture across regimes before trusting it live.`);
  console.log('\nTUNE OK');
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error('\nTUNE FAIL:', (e as Error)?.message ?? e);
  process.exit(1);
}
