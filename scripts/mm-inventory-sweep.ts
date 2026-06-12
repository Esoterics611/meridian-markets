/**
 * mm-inventory-sweep — F3 validation (Journal #62): the concentration controls A/B + the
 * loss-stop threshold sweep, on the saved fine-cadence L2 tapes.
 *
 * Three questions, answered per coin on the same tape with the same quoter base (the live
 * governor: skewMult 4, shed 0.4, hard cap on):
 *   1. BASE vs +CONC — do the concentration ramp + adding-side size cut reduce the warehouse
 *      loss (carry + unreal) without raising taker fees? (the F3 gate)
 *   2. stop sweep — with the stronger skew in place, where does the loss-stop threshold
 *      actually sit? (run55 prior: 0.01% = $50 on a $500k book; 12 stops ≈ −$664 realised)
 *   3. how many stops does each level fire, and what do their taker fees cost?
 *
 * Run:
 *   MM_TUNE_TAPE_PREFIX=docs/research/l2-tapes/hl-fine-20260605 MM_TUNE_COINS=BTC,ETH,SOL,BNB,DOGE \
 *     npx ts-node -r tsconfig-paths/register scripts/mm-inventory-sweep.ts
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { mmStrategyRegistry } from '../src/market-making/registry/mm-strategy-registry';
import { CompositeRiskGate } from '../src/market-making/risk/risk-gate';
import { parseTape } from '../src/market-making/backtest/l2-tape-io';
import { midMicros } from '../src/market-making/microstructure/order-book';
import { venueFeeFor } from '../src/market-making/backtest/venue-fees';
import { LobReplayHarness, LobReplayMetrics } from '../src/market-making/backtest/lob-replay';
import { L2TapeStep } from '../src/market-making/backtest/l2-tape';

const SOURCE = (process.env.MM_TUNE_SOURCE ?? 'hyperliquid').trim().toLowerCase();
const PREFIX = (process.env.MM_TUNE_TAPE_PREFIX ?? 'docs/research/l2-tapes/hl-fine-20260605').trim();
const COINS = (process.env.MM_TUNE_COINS ?? 'BTC,ETH,SOL,BNB,DOGE').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const MICRO_DEPTH = Number(process.env.MICRO_DEPTH ?? 5);
const GAMMA = Number(process.env.GAMMA ?? 0.0025);
const KAPPA = Number(process.env.KAPPA ?? 0.5);
const FLOOR = Number(process.env.FLOOR ?? 5);
const MAX_BPS = Number(process.env.MAX_BPS ?? 200);
const MAX_LOTS = Number(process.env.MAX_LOTS ?? 2);
const QUOTE_USD = Number(process.env.QUOTE_USD ?? 50_000);
const CAPITAL_USD = Number(process.env.CAPITAL_USD ?? 1_000_000);
const VOL_WINDOW = Number(process.env.VOL_WINDOW ?? 20);
const VOL_FLOOR = Number(process.env.VOL_FLOOR ?? 0.0001);
const DD_LIMIT = Number(process.env.DD_LIMIT ?? 2);
// The live governor base (start-desk defaults) — F3 is measured ON TOP of it.
const SKEW_MULT = Number(process.env.SKEW_MULT ?? 4);
const SHED = Number(process.env.SHED ?? 0.4);
const CONC = { soft: Number(process.env.CONC_SOFT ?? 0.5), hard: Number(process.env.CONC_HARD ?? 0.85), gain: Number(process.env.CONC_SKEW_GAIN ?? 2) };
const STOP_LEVELS = (process.env.STOP_LEVELS ?? '0,0.0001,0.0005,0.001').split(',').map(Number);

const u = (units: bigint): number => Number(units) / 1e6;
const f1 = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(1);
const padL = (s: string | number, n: number): string => String(s).padStart(n);
const padR = (s: string | number, n: number): string => String(s).padEnd(n);

interface Loaded { coin: string; tape: L2TapeStep[]; midPrice: number; }

function loadTapes(): Loaded[] {
  const out: Loaded[] = [];
  for (const coin of COINS) {
    try {
      const tape = parseTape(readFileSync(`${PREFIX}-${coin}.json`, 'utf8'));
      if (tape.length === 0) { console.log(`  ! skip ${coin}: empty`); continue; }
      const mid = midMicros(tape[0].book);
      out.push({ coin: tape[0].book.symbol || coin, tape, midPrice: mid ? Number(mid) / 1e6 : 0 });
    } catch (e) {
      console.log(`  ! skip ${coin}: ${(e as Error).message}`);
    }
  }
  return out;
}

function replay(lt: Loaded, conc: boolean, stopFrac: number): LobReplayMetrics {
  const fee = venueFeeFor(SOURCE);
  const quoteUnits = BigInt(Math.max(1, Math.round((QUOTE_USD / Math.max(lt.midPrice, 1e-9)) * 1e6)));
  const quoter = mmStrategyRegistry.build('mm-glft', {
    quoteSizeUnits: quoteUnits,
    minHalfSpreadBps: FLOOR,
    maxHalfSpreadBps: MAX_BPS,
    maxInventoryLots: MAX_LOTS,
    params: {
      gamma: GAMMA,
      kappa: KAPPA,
      inventorySkewMult: SKEW_MULT,
      inventorySpreadSkew: SHED,
      hardInventoryCap: 1,
      ...(conc ? { concSoft: CONC.soft, concHard: CONC.hard, concSkewGain: CONC.gain } : {}),
    },
  });
  const riskGate = new CompositeRiskGate({
    maxInventoryUnits: quoteUnits * BigInt(MAX_LOTS),
    minNavRatio: 1 - DD_LIMIT / 100,
    vpinPauseThreshold: 2,
    vpinPauseMs: 30_000,
    maxAdverseUnits: 1_000_000_000_000_000n,
    adversePauseMs: 30_000,
  });
  return new LobReplayHarness().run({
    tape: lt.tape,
    quoter,
    quoteSizeUnits: quoteUnits,
    gamma: GAMMA,
    kappa: KAPPA,
    horizonBars: 1,
    volWindowBars: VOL_WINDOW,
    volFloor: VOL_FLOOR,
    makerFeeBps: fee.makerBps,
    capitalUnits: BigInt(Math.round(CAPITAL_USD * 1e6)),
    symbol: lt.coin,
    riskGate,
    microDepth: MICRO_DEPTH,
    lossStopFrac: stopFrac > 0 ? stopFrac : undefined,
  });
}

/** Warehouse term ≈ carry attribution + final unrealised (the run-end MTM of held inventory). */
const whse = (m: LobReplayMetrics): number => u(m.attribution.inventoryCarryUnits + m.unrealisedPnlUnits);

function main(): void {
  const tapes = loadTapes();
  console.log(`\n=== F3 INVENTORY SWEEP — conc controls A/B + loss-stop curve (${tapes.length} coins) ===`);
  console.log(`  base: skewMult ${SKEW_MULT}, shed ${SHED}, hardCap on | conc: soft ${CONC.soft} hard ${CONC.hard} gain ${CONC.gain}`);
  console.log(`  γ=${GAMMA} κ=${KAPPA} floor=${FLOOR} lots=${MAX_LOTS} lot=$${QUOTE_USD.toLocaleString()} micro=${MICRO_DEPTH}\n`);

  console.log('  -- A/B: BASE vs +CONC (no stop) — the F3 gate: warehouse cut, fees not up --');
  console.log('  coin    |  BASE: whse     net   fees  fills |  +CONC: whse     net   fees  fills | Δwhse    Δnet');
  let bW = 0, bN = 0, cW = 0, cN = 0;
  for (const lt of tapes) {
    const base = replay(lt, false, 0);
    const conc = replay(lt, true, 0);
    bW += whse(base); bN += u(base.netPnlUnits); cW += whse(conc); cN += u(conc.netPnlUnits);
    const better = whse(conc) > whse(base) ? '✅' : '·';
    console.log(
      `  ${padR(lt.coin, 6)}  | ${padL(f1(whse(base)), 8)} ${padL(f1(u(base.netPnlUnits)), 8)} ${padL(f1(u(base.feesUnits)), 6)} ${padL(base.queueFills, 5)} ` +
      `| ${padL(f1(whse(conc)), 8)} ${padL(f1(u(conc.netPnlUnits)), 8)} ${padL(f1(u(conc.feesUnits)), 6)} ${padL(conc.queueFills, 5)} ` +
      `| ${padL(f1(whse(conc) - whse(base)), 7)} ${padL(f1(u(conc.netPnlUnits) - u(base.netPnlUnits)), 7)} ${better}`,
    );
  }
  console.log(`  ${padR('DESK', 6)}  | ${padL(f1(bW), 8)} ${padL(f1(bN), 8)}              | ${padL(f1(cW), 8)} ${padL(f1(cN), 8)}              | ${padL(f1(cW - bW), 7)} ${padL(f1(cN - bN), 7)}\n`);

  console.log('  -- loss-stop sweep (with +CONC on): stop level vs realised / warehouse saved / stop tax --');
  console.log('  coin    | stop%  | stops | stopFees | realised |   whse  |    net  | maxDD%');
  for (const lt of tapes) {
    for (const stop of STOP_LEVELS) {
      const m = replay(lt, true, stop);
      console.log(
        `  ${padR(lt.coin, 6)}  | ${padL(stop > 0 ? (stop * 100).toFixed(2) : 'off', 6)} | ${padL(m.lossStops, 5)} | ${padL(f1(u(m.lossStopFeesUnits)), 8)} ` +
        `| ${padL(f1(u(m.realisedPnlUnits)), 8)} | ${padL(f1(whse(m)), 7)} | ${padL(f1(u(m.netPnlUnits)), 7)} | ${m.maxDrawdownPct.toFixed(2)}`,
      );
    }
  }
  console.log('\n  Gate (F3): desk Δwhse ≥ +50% of the BASE warehouse loss, fees not up. The stop level with');
  console.log('  the best net at acceptable maxDD becomes the per-book MM_LOSS_STOP_FRAC prior.\n');
}

main();
