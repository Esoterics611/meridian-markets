/**
 * orv-maker-replay — Phase-0 verdict: replay a maker over the orv-calibration tape.
 *
 * Reads tape-*.jsonl files (from scripts/orv-calibration.ts), simulates resting
 * two-sided quotes around the recorded live-spot RND fair on every priceable HIP-4
 * market, over a width × cadence grid (src/prediction/maker-sim.ts — strict
 * trade-through fills, post-only, inventory cap, expiry no-quote window, HIP-4 fee
 * taxonomy, hedge cost line), and prints the revenue-density table.
 *
 * PRE-REGISTERED GATE (docs/PREDICTION_MARKET_MM_RESEARCH.md §5, set before any tape
 * existed): the maker thesis proceeds to Phase 1 iff some grid point shows net > 0
 * with ≥50 fills across ≥2 markets on ≥3 days of tape. Otherwise it dies here.
 *
 * Also re-scores the #96 calibration question from the same tape (Brier fair vs mid,
 * paired bootstrap CI over settles) — that gate needs ≥100 settles; reported as n grows.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/orv-maker-replay.ts [tape files…]
 *   (default: docs/research/orv-maker/tapes/tape-*.jsonl)
 * Knobs:
 *   RPL_WIDTHS(0.002,0.005,0.01,0.02) RPL_CADENCES_S(1,5,15,60) RPL_CONTRACTS(100)
 *   RPL_MAXINV(500) RPL_NOQUOTE_MIN(30) RPL_FLOOR_MULT(1) RPL_CLOSE_FEE_BPS(4)
 *   RPL_SETTLE_FEE_BPS(4) RPL_HEDGE_BPS(5) RPL_MARKOUT_MS(60000)
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  bootstrapDiffCI,
  brierSummary,
  CalibrationBook,
} from '../src/prediction/calibration-score';
import { DEFAULT_MAKER_SIM, MakerSimConfig, runGrid } from '../src/prediction/maker-sim';
import { parseTapeLine, TapeSnap } from '../src/prediction/maker-tape.types';

const nums = (env: string | undefined, dflt: number[]): number[] =>
  env ? env.split(',').map(Number).filter(Number.isFinite) : dflt;

const WIDTHS = nums(process.env.RPL_WIDTHS, [0.002, 0.005, 0.01, 0.02]);
const CADENCES_MS = nums(process.env.RPL_CADENCES_S, [1, 5, 15, 60]).map((s) => s * 1_000);
const CFG: MakerSimConfig = {
  ...DEFAULT_MAKER_SIM,
  quoteContracts: Number(process.env.RPL_CONTRACTS ?? 100),
  maxInventory: Number(process.env.RPL_MAXINV ?? 500),
  noQuoteMinutes: Number(process.env.RPL_NOQUOTE_MIN ?? 30),
  floorMult: Number(process.env.RPL_FLOOR_MULT ?? 1),
  makerCloseFeeBps: Number(process.env.RPL_CLOSE_FEE_BPS ?? 4),
  settleFeeBps: Number(process.env.RPL_SETTLE_FEE_BPS ?? 4),
  hedgeCostBps: Number(process.env.RPL_HEDGE_BPS ?? 5),
  markoutMs: Number(process.env.RPL_MARKOUT_MS ?? 60_000),
};

function tapeFiles(): string[] {
  const args = process.argv.slice(2);
  if (args.length) return args;
  const dir = 'docs/research/orv-maker/tapes';
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^tape-.*\.jsonl$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function main(): void {
  const files = tapeFiles();
  if (files.length === 0) {
    console.error('no tape files — run scripts/orv-calibration.ts first');
    process.exit(1);
  }
  const snapsByMarket = new Map<string, TapeSnap[]>();
  const settled = new Map<string, boolean>();
  const calibration = new CalibrationBook();
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const rec = parseTapeLine(line);
      if (!rec) continue;
      if (rec.ev === 'SNAP') {
        const arr = snapsByMarket.get(rec.marketId) ?? [];
        arr.push(rec);
        snapsByMarket.set(rec.marketId, arr);
        if (rec.bids.length && rec.asks.length) {
          calibration.onSnap(
            rec.marketId,
            rec.expiryMs,
            rec.ms,
            rec.fairYes,
            (rec.bids[0][0] + rec.asks[0][0]) / 2,
          );
        }
      } else {
        settled.set(rec.marketId, rec.settledYes);
        calibration.onSettle(rec.marketId, rec.settledYes);
      }
    }
  }
  const markets = [...snapsByMarket.entries()].map(([id, snaps]) => ({
    snaps: snaps.sort((a, b) => a.ms - b.ms),
    settledYes: settled.get(id) ?? null,
  }));
  const allMs = markets.flatMap((m) => [m.snaps[0].ms, m.snaps[m.snaps.length - 1].ms]);
  const tapeDays = (Math.max(...allMs) - Math.min(...allMs)) / 86_400_000;
  console.log(
    `tape: ${files.length} file(s), ${markets.length} market(s), ${markets.reduce((s, m) => s + m.snaps.length, 0)} snaps, ${tapeDays.toFixed(2)} day(s)`,
  );
  console.log(
    `cfg: Q=${CFG.quoteContracts} maxInv=${CFG.maxInventory} noQuote<${CFG.noQuoteMinutes}min floor×${CFG.floorMult} fees close/settle ${CFG.makerCloseFeeBps}/${CFG.settleFeeBps}bps hedge ${CFG.hedgeCostBps}bps\n`);

  const grid = runGrid(markets, WIDTHS, CADENCES_MS, CFG);
  const pad = (v: string, n: number) => v.padStart(n);
  console.log(
    [
      pad('width', 6),
      pad('cadence', 8),
      pad('fills', 6),
      pad('trading$', 9),
      pad('settle$', 8),
      pad('fees$', 7),
      pad('hedge$', 7),
      pad('mkout$', 8),
      pad('unrl$', 7),
      pad('NET$', 8),
      pad('$/$/day', 9),
    ].join(' '),
  );
  for (const g of grid) {
    console.log(
      [
        pad(g.halfWidthProb.toFixed(3), 6),
        pad(`${g.repriceMs / 1_000}s`, 8),
        pad(String(g.fills), 6),
        pad(g.realizedTrading.toFixed(2), 9),
        pad(g.realizedSettle.toFixed(2), 8),
        pad(g.fees.toFixed(2), 7),
        pad(g.hedgeCost.toFixed(2), 7),
        pad(g.markoutTotal.toFixed(2), 8),
        pad(g.unrealizedEnd.toFixed(2), 7),
        pad(g.net.toFixed(2), 8),
        pad((g.revenueDensity * 100).toFixed(3) + '%', 9),
      ].join(' '),
    );
  }

  // ── Pre-registered Phase-0 gate ────────────────────────────────────────────────
  const best = grid.reduce((a, b) => (b.net > a.net ? b : a), grid[0]);
  const pass =
    best.net > 0 && best.fills >= 50 && markets.length >= 2 && tapeDays >= 3;
  console.log(
    `\nbest grid point: w=${best.halfWidthProb} c=${best.repriceMs / 1_000}s net=$${best.net.toFixed(2)} fills=${best.fills}`,
  );
  if (tapeDays < 3 || markets.length < 2 || best.fills < 50) {
    console.log(
      `GATE: INSUFFICIENT TAPE (need ≥3 days [have ${tapeDays.toFixed(2)}], ≥2 markets [${markets.length}], ≥50 fills at the best point [${best.fills}]) — keep collecting, no verdict yet`,
    );
  } else {
    console.log(`GATE (pre-registered): ${pass ? 'PASS — proceed to Phase 1 (OutcomeMakerBook)' : 'FAIL — the maker thesis dies here'}`);
  }

  // ── #96 calibration read (needs ≥100 settles to gate; reported as it grows) ────
  const contribs = calibration.all();
  const b = brierSummary(contribs);
  if (b.n > 0) {
    console.log(
      `\ncalibration: settles=${b.settles} n=${b.n} brier fair=${b.brierFair.toFixed(4)} mid=${b.brierMid.toFixed(4)} meanDiff=${b.meanDiff >= 0 ? '+' : ''}${b.meanDiff.toFixed(4)} (＋ ⇒ RND better)`,
    );
    const ci = bootstrapDiffCI(contribs);
    if (ci.settles >= 2)
      console.log(
        `  bootstrap 95% CI [${ci.lo95.toFixed(4)}, ${ci.hi95.toFixed(4)}] over ${ci.settles} settles — gate decides at ≥100 settles (#96)`,
      );
  } else {
    console.log('\ncalibration: no settles on tape yet');
  }
}

main();
