/*
 * mm-timestop-sweep.ts — S2 task 1: does the inventory TIME-STOP pay for itself?
 *
 * Replays the real HL L2 tapes through the queue-aware LobReplayHarness with the live GLFT
 * config, baseline vs TimeStopQuoter(T, maxShift) grid. The question S1's leak tables pose:
 * warehouse MTM is the desk's #1 leak class (#51 BRENTOIL/HYPE −$1.1k each; A″ ETH/BTC bled
 * warehouse with POSITIVE fill edge) — does bounding HOLDING TIME (skew-to-flat escalation)
 * cut that loss by more than the entry fills it forfeits?
 *
 * HONESTY (read before citing): the tapes are 2026-06-04/05 BTC/ETH/SOL/BNB/DOGE (8h fine,
 * ~0.6s cadence) + HYPE (6h coarse, ~18s cadence — queue realism is weaker there). There is NO
 * HIP-3 RWA tape yet, so the per-book-class verdict for xyz:* is OUT OF SAMPLE — capture one
 * next run before trusting the time-stop on RWAs. One window per coin = a read, not a law.
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/mm-timestop-sweep.ts
 *      (env: TS_TAPES=BTC,DOGE,HYPE  TS_GRID=600:3,1800:3,1800:8,3600:8)
 */
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { LobReplayHarness } from '../src/market-making/backtest/lob-replay';
import { parseTape } from '../src/market-making/backtest/l2-tape-io';
import { GlftQuoter } from '../src/market-making/quote/glft-quoter';
import { TimeStopQuoter } from '../src/market-making/quote/time-stop-quoter';
import { midMicros } from '../src/market-making/microstructure/order-book';
import { venueFeeFor } from '../src/market-making/backtest/venue-fees';

const TAPES_DIR = process.env['TS_TAPES_DIR'] ?? path.join('docs', 'research', 'l2-tapes');
const TAPE_FILES: Record<string, string> = {
  BTC: 'hl-fine-20260605-BTC.json',
  ETH: 'hl-fine-20260605-ETH.json',
  SOL: 'hl-fine-20260605-SOL.json',
  BNB: 'hl-fine-20260605-BNB.json',
  DOGE: 'hl-fine-20260605-DOGE.json',
  HYPE: 'hl-discovery-20260604-HYPE.json',
};

// The LIVE desk config (start-desk.sh, 2026-06-11): risk-averse profile.
const GAMMA = 0.005;
const KAPPA = 2;
const CAPITAL_UNITS = 500_000_000_000n; // $500k/book
const QUOTE_NOTIONAL_USD = 50_000;
const MAX_INV_FRAC = 0.15;

interface Cell {
  coin: string;
  label: string;
  netUsd: number;
  realisedUsd: number;
  unrealUsd: number;
  maxDdPct: number;
  fills: number;
  finalInvUsd: number;
  spreadUsd: number;
  adverseUsd: number;
  feesUsd: number;
}

const usd = (u: bigint): number => Number(u) / 1e6;

function runOne(coin: string, tapeSteps: ReturnType<typeof parseTape>, label: string, stop?: { ageMs: number; maxShiftBps: number }): Cell {
  const mid0 = midMicros(tapeSteps[0].book)!;
  const quoteSizeUnits = BigInt(Math.round((QUOTE_NOTIONAL_USD / (Number(mid0) / 1e6)) * 1e6));
  const inner = new GlftQuoter({
    gamma: GAMMA,
    kappa: KAPPA,
    quoteSizeUnits,
    minHalfSpreadBps: 1,
    maxHalfSpreadBps: 200,
    maxInventoryLots: 4,
    maxInventoryNotionalFrac: MAX_INV_FRAC,
    capitalUnits: CAPITAL_UNITS,
    steadyHorizonBars: 1,
    inventorySkewMult: 6, // live default (risk-averse profile)
    inventorySpreadSkew: 0.4,
    hardInventoryCap: true,
  });
  const quoter = stop
    ? new TimeStopQuoter(inner, { ageMs: stop.ageMs, rampMs: stop.ageMs, maxShiftBps: stop.maxShiftBps, flatUnits: quoteSizeUnits / 2n, fullUnits: quoteSizeUnits * 4n })
    : inner;
  const m = new LobReplayHarness().run({
    tape: tapeSteps,
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
    microDepth: 5, // live default (F1 micro-price center)
    f3Toxicity: true,
    f3MinScale: 1.0, // live default (widen-only, risk-averse doctrine)
    f3MaxScale: 3.0,
  });
  const lastMid = midMicros(tapeSteps[tapeSteps.length - 1].book)!;
  return {
    coin,
    label,
    netUsd: usd(m.netPnlUnits),
    realisedUsd: usd(m.realisedPnlUnits),
    unrealUsd: usd(m.unrealisedPnlUnits),
    maxDdPct: m.maxDrawdownPct,
    fills: m.queueFills,
    finalInvUsd: (Number(m.finalInventoryUnits) / 1e6) * (Number(lastMid) / 1e6),
    spreadUsd: usd(m.attribution.spreadCapturedUnits),
    adverseUsd: usd(m.attribution.adverseSelectionUnits),
    feesUsd: usd(m.feesUnits),
  };
}

function main(): void {
  const coins = (process.env['TS_TAPES'] ?? 'BTC,ETH,SOL,DOGE,HYPE').split(',').map((s) => s.trim()).filter(Boolean);
  // grid entries ageSeconds:maxShiftBps
  const grid = (process.env['TS_GRID'] ?? '600:3,1800:3,3600:3,1800:8,3600:8')
    .split(',')
    .map((g) => g.split(':').map(Number) as [number, number]);

  const cells: Cell[] = [];
  for (const coin of coins) {
    const file = TAPE_FILES[coin];
    if (!file) {
      console.error(`no tape for ${coin}, skipping`);
      continue;
    }
    process.stderr.write(`${coin}: loading ${file}…\n`);
    const tape = parseTape(readFileSync(path.join(TAPES_DIR, file), 'utf8'));
    cells.push(runOne(coin, tape, 'baseline'));
    for (const [ageS, shift] of grid) {
      cells.push(runOne(coin, tape, `T=${ageS / 60}m,shift=${shift}bps`, { ageMs: ageS * 1000, maxShiftBps: shift }));
      process.stderr.write(`  ${coin} T=${ageS / 60}m/${shift}bps done\n`);
    }
  }

  const lines: string[] = [];
  lines.push('# Inventory time-stop sweep — queue-aware replay (S2 task 1)');
  lines.push(`live GLFT config: γ=${GAMMA} κ=${KAPPA} skewMult=6 invFrac=${MAX_INV_FRAC} F3 widen-only · grid = age:maxShift`);
  lines.push('');
  lines.push('| coin | variant | net $ | realised $ | unreal $ | Δnet vs base | maxDD % | fills | final inv $ | spread $ | adverse $ | fees $ |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const coin of coins) {
    const base = cells.find((c) => c.coin === coin && c.label === 'baseline');
    for (const c of cells.filter((c) => c.coin === coin)) {
      const d = base ? c.netUsd - base.netUsd : 0;
      lines.push(
        `| ${c.coin} | ${c.label} | ${c.netUsd.toFixed(0)} | ${c.realisedUsd.toFixed(0)} | ${c.unrealUsd.toFixed(0)} | ${c.label === 'baseline' ? '—' : (d >= 0 ? '+' : '') + d.toFixed(0)} | ${c.maxDdPct.toFixed(2)} | ${c.fills} | ${c.finalInvUsd.toFixed(0)} | ${c.spreadUsd.toFixed(0)} | ${c.adverseUsd.toFixed(0)} | ${c.feesUsd.toFixed(0)} |`,
      );
    }
  }
  lines.push('');
  lines.push('Caveats: tapes are 2026-06-04/05 main-dex only (no HIP-3 RWA tape — xyz:* verdict OUT OF SAMPLE);');
  lines.push('HYPE tape is 18s-cadence (coarse queue realism); one window per coin = a read, not a law.');

  const out = path.join('docs', 'research', 'timestop-sweep.md');
  writeFileSync(out, lines.join('\n') + '\n');
  writeFileSync(path.join('docs', 'research', 'timestop-sweep.json'), JSON.stringify(cells, null, 1));
  console.log(lines.join('\n'));
  console.error(`\nwritten: ${out}`);
}

main();
