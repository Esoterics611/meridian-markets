/*
 * mm-flow-sweep.ts — F4 Stage A calibration: θ_enter/θ_exit/dwell per book, by queue-aware
 * replay on the 14h fine tapes (Journal #63).
 *
 * Replays the live GLFT config (start-desk.sh risk-averse profile: γ=0.005, skewMult 6,
 * F3 widen-only, conc controls ON, loss-stop 0.01%) through LobReplayHarness, baseline
 * (no flow gate — the F3-era desk) vs the FlowRegimeMachine grid. The validation gate
 * (MASTER_PLAN_SESSIONS.md PART V, F4A): ADVERSE down, SPREAD capture given up < adverse
 * saved, and ZERO flatten entries in A>0 windows — the script HARD-FAILS if any variant
 * reports flattenEntriesNotAligned > 0 (the §3 invariant must hold on real tape, not just
 * in the unit test).
 *
 * HONESTY: tapes are 2026-06-05 BTC/ETH/SOL/BNB/DOGE (~14h, ~1.1s cadence) — main-dex
 * majors only; no HIP-3 RWA tape, so xyz:* books inherit the majors' pick, OUT OF SAMPLE.
 * One window per coin = a read, not a law.
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/mm-flow-sweep.ts
 *      (env: FLOW_TAPES=BTC,ETH  FLOW_GRID=0.3:0.18:2,0.4:0.25:3,0.5:0.35:5  — θe:θx:dwellS)
 */
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { LobReplayHarness } from '../src/market-making/backtest/lob-replay';
import { parseTape } from '../src/market-making/backtest/l2-tape-io';
import { GlftQuoter } from '../src/market-making/quote/glft-quoter';
import { midMicros } from '../src/market-making/microstructure/order-book';
import { venueFeeFor } from '../src/market-making/backtest/venue-fees';
import { FlowRegimeConfig, FlowRegimeStats } from '../src/market-making/risk/flow-regime';

const TAPES_DIR = process.env['FLOW_TAPES_DIR'] ?? path.join('docs', 'research', 'l2-tapes');
const TAPE_FILES: Record<string, string> = {
  BTC: 'hl-fine-20260605-BTC.json',
  ETH: 'hl-fine-20260605-ETH.json',
  SOL: 'hl-fine-20260605-SOL.json',
  BNB: 'hl-fine-20260605-BNB.json',
  DOGE: 'hl-fine-20260605-DOGE.json',
};

// The LIVE desk config (start-desk.sh, 2026-06-12): risk-averse profile + F3 conc controls.
const GAMMA = 0.005;
const KAPPA = 2;
const CAPITAL_UNITS = 500_000_000_000n; // $500k/book
const QUOTE_NOTIONAL_USD = 50_000;
const MAX_INV_FRAC = 0.1;

interface Cell {
  coin: string;
  label: string;
  netUsd: number;
  maxDdPct: number;
  fills: number;
  spreadUsd: number;
  adverseUsd: number;
  feesUsd: number;
  lossStops: number;
  flow?: FlowRegimeStats;
}

const usd = (u: bigint): number => Number(u) / 1e6;

function runOne(coin: string, tape: ReturnType<typeof parseTape>, label: string, flow?: FlowRegimeConfig): Cell {
  const mid0 = midMicros(tape[0].book)!;
  const quoteSizeUnits = BigInt(Math.round((QUOTE_NOTIONAL_USD / (Number(mid0) / 1e6)) * 1e6));
  const quoter = new GlftQuoter({
    gamma: GAMMA,
    kappa: KAPPA,
    quoteSizeUnits,
    minHalfSpreadBps: 1,
    maxHalfSpreadBps: 200,
    maxInventoryLots: 4,
    maxInventoryNotionalFrac: MAX_INV_FRAC,
    capitalUnits: CAPITAL_UNITS,
    steadyHorizonBars: 1,
    inventorySkewMult: 6,
    inventorySpreadSkew: 0.4,
    hardInventoryCap: true,
    concSoftFrac: 0.5, // F3 conc controls — live default ON
    concHardFrac: 0.85,
    concSkewGain: 2,
  });
  const m = new LobReplayHarness().run({
    tape,
    quoter,
    quoteSizeUnits,
    gamma: GAMMA,
    kappa: KAPPA,
    horizonBars: 1,
    volWindowBars: 30,
    volFloor: 0.0001,
    makerFeeBps: venueFeeFor('hyperliquid', coin).makerBps,
    capitalUnits: CAPITAL_UNITS,
    symbol: coin,
    microDepth: 5,
    f3Toxicity: true,
    f3MinScale: 1.0, // widen-only (live default)
    f3MaxScale: 3.0,
    lossStopFrac: 0.0001, // live default (Journal #62 sweep pick)
    lossStopCooldownMs: 15 * 60_000,
    flow,
  });
  return {
    coin,
    label,
    netUsd: usd(m.netPnlUnits),
    maxDdPct: m.maxDrawdownPct,
    fills: m.queueFills,
    spreadUsd: usd(m.attribution.spreadCapturedUnits),
    adverseUsd: usd(m.attribution.adverseSelectionUnits),
    feesUsd: usd(m.feesUnits),
    lossStops: m.lossStops,
    flow: m.flowStats,
  };
}

function main(): void {
  const coins = (process.env['FLOW_TAPES'] ?? 'BTC,ETH,SOL,BNB,DOGE').split(',').map((s) => s.trim()).filter(Boolean);
  // grid entries θ_enter:θ_exit:dwellSeconds
  const grid = (process.env['FLOW_GRID'] ?? '0.3:0.18:3,0.4:0.25:3,0.5:0.35:3,0.4:0.25:8,0.5:0.35:8')
    .split(',')
    .map((g) => g.split(':').map(Number) as [number, number, number]);

  // FLOW_APPEND=1: keep previously-swept coins from the JSON and add/replace this run's —
  // lets the 5×14h sweep run one coin per invocation (each ≈3min of replay).
  const jsonOut = path.join('docs', 'research', 'flow-throttle-sweep.json');
  let cells: Cell[] = [];
  if (process.env['FLOW_APPEND'] === '1') {
    try {
      cells = (JSON.parse(readFileSync(jsonOut, 'utf8')) as Cell[]).filter((c) => !coins.includes(c.coin));
    } catch {
      /* no prior file — fresh start */
    }
  }
  for (const coin of coins) {
    const file = TAPE_FILES[coin];
    if (!file) {
      console.error(`no tape for ${coin}, skipping`);
      continue;
    }
    process.stderr.write(`${coin}: loading ${file}…\n`);
    const tape = parseTape(readFileSync(path.join(TAPES_DIR, file), 'utf8'));
    cells.push(runOne(coin, tape, 'baseline'));
    for (const [te, tx, dwellS] of grid) {
      cells.push(
        runOne(coin, tape, `θ=${te}/${tx},dwell=${dwellS}s`, {
          thetaEnter: te,
          thetaExit: tx,
          dwellMs: dwellS * 1000,
          // the rest are the shipped MM_FLOW_* defaults — the sweep is the hysteresis/dwell axis
        }),
      );
      process.stderr.write(`  ${coin} θ=${te}/${tx}/${dwellS}s done\n`);
    }
  }

  // HARD INVARIANT (F4A gate): zero flatten entries in A>0 windows, on every variant.
  const violations = cells.filter((c) => (c.flow?.flattenEntriesNotAligned ?? 0) > 0);

  const lines: string[] = [];
  lines.push('# F4 Stage A flow-throttle sweep — queue-aware replay (Journal #63)');
  lines.push(
    `live GLFT config: γ=${GAMMA} κ=${KAPPA} skewMult=6 invFrac=${MAX_INV_FRAC} F3 widen-only conc=0.5/0.85 loss-stop=0.01% · grid = θ_enter:θ_exit:dwell`,
  );
  lines.push('');
  lines.push('| coin | variant | net $ | Δnet | spread $ | Δspread | adverse $ | Δadverse | fees $ | DD% | fills | stops | defT | harvT | flat (viol) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const tableCoins = [...new Set(cells.map((c) => c.coin))];
  for (const coin of tableCoins) {
    const base = cells.find((c) => c.coin === coin && c.label === 'baseline');
    for (const c of cells.filter((x) => x.coin === coin)) {
      const d = (x: number, b?: number) => (c.label === 'baseline' || b === undefined ? '—' : ((x - b >= 0 ? '+' : '') + (x - b).toFixed(0)));
      const fl = c.flow;
      lines.push(
        `| ${c.coin} | ${c.label} | ${c.netUsd.toFixed(0)} | ${d(c.netUsd, base?.netUsd)} | ${c.spreadUsd.toFixed(0)} | ${d(c.spreadUsd, base?.spreadUsd)} | ` +
          `${c.adverseUsd.toFixed(0)} | ${d(c.adverseUsd, base?.adverseUsd)} | ${c.feesUsd.toFixed(0)} | ${c.maxDdPct.toFixed(2)} | ${c.fills} | ${c.lossStops} | ` +
          `${fl ? fl.ticksDefensive : '—'} | ${fl ? fl.ticksHarvest : '—'} | ${fl ? `${fl.flattenEntries} (${fl.flattenEntriesNotAligned})` : '—'} |`,
      );
    }
  }
  lines.push('');
  lines.push(`Hard invariant (zero A>0 flattens): ${violations.length === 0 ? 'PASS on every variant' : `FAIL — ${violations.length} variant(s)`}`);
  lines.push('Caveats: 2026-06-05 majors tape only (no HIP-3 RWA tape — xyz:* OUT OF SAMPLE); one window per coin = a read, not a law.');

  const out = path.join('docs', 'research', 'flow-throttle-sweep.md');
  writeFileSync(out, lines.join('\n') + '\n');
  writeFileSync(jsonOut, JSON.stringify(cells, null, 1));
  console.log(lines.join('\n'));
  console.error(`\nwritten: ${out}`);
  if (violations.length > 0) {
    console.error('HARD INVARIANT VIOLATED — flatten fired in an A>0 window; do not ship.');
    process.exit(1);
  }
}

main();
