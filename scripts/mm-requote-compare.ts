/**
 * mm-requote-compare — F2 quote anti-churn A/B (Journal #61).
 *
 * Replays each saved L2 tape TWICE at one fixed config — once with the pre-F2 behaviour
 * (chase the quoter's price every step, rejoining the back of the FIFO queue on every
 * sub-tick drift) and once with the F2 requote hysteresis + dwell (hold sub-threshold
 * drift, keep queue position) — and prints the per-coin deltas. Both runs use the SAME
 * shared decideRequote/placeRestingOrder mechanics as the live engine, so this is the
 * live logic, not a model of it.
 *
 * The question: does holding the quote through noise RAISE fills (queue position kept)
 * and net WITHOUT giving back the spread−adverse edge (a held quote is staler by
 * construction — the urgent threshold must cap that)?
 *
 * Best tape: the ~1.1s-cadence 14h captures —
 *   MM_TUNE_TAPE_PREFIX=docs/research/l2-tapes/hl-fine-20260605 \
 *   MM_TUNE_COINS=BTC,ETH,SOL,BNB,DOGE \
 *   REQUOTE_MIN_BPS=1 REQUOTE_DWELL_MS=400 REQUOTE_URGENT_BPS=4 \
 *     npx ts-node -r tsconfig-paths/register scripts/mm-requote-compare.ts
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
import { RequoteHysteresisCfg } from '../src/market-making/backtest/queue-fill';

const STRATEGY = process.env.MM_TUNE_STRATEGY ?? 'mm-glft';
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
const HORIZON = Number(process.env.HORIZON ?? 1);
const DD_LIMIT = Number(process.env.DD_LIMIT ?? 2);
const REQUOTE: RequoteHysteresisCfg = {
  minBps: Number(process.env.REQUOTE_MIN_BPS ?? 1),
  dwellMs: Number(process.env.REQUOTE_DWELL_MS ?? 400),
  urgentBps: Number(process.env.REQUOTE_URGENT_BPS ?? 4),
};

const u = (units: bigint): number => Number(units) / 1e6;
const f2 = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(2);
const padL = (s: string | number, n: number): string => String(s).padStart(n);
const padR = (s: string | number, n: number): string => String(s).padEnd(n);

interface Loaded { coin: string; tape: L2TapeStep[]; midPrice: number; }

function loadTapes(): Loaded[] {
  const out: Loaded[] = [];
  for (const coin of COINS) {
    const file = `${PREFIX}-${coin}.json`;
    try {
      const tape = parseTape(readFileSync(file, 'utf8'));
      if (tape.length === 0) { console.log(`  ! skip ${coin}: empty`); continue; }
      const mid = midMicros(tape[0].book);
      out.push({ coin: tape[0].book.symbol || coin, tape, midPrice: mid ? Number(mid) / 1e6 : 0 });
    } catch (e) {
      console.log(`  ! skip ${coin}: ${(e as Error).message}`);
    }
  }
  return out;
}

function replay(lt: Loaded, requote: RequoteHysteresisCfg | undefined): LobReplayMetrics {
  const fee = venueFeeFor(SOURCE);
  const quoteUnits = BigInt(Math.max(1, Math.round((QUOTE_USD / Math.max(lt.midPrice, 1e-9)) * 1e6)));
  const quoter = mmStrategyRegistry.build(STRATEGY, {
    quoteSizeUnits: quoteUnits,
    minHalfSpreadBps: FLOOR,
    maxHalfSpreadBps: MAX_BPS,
    maxInventoryLots: MAX_LOTS,
    params: { gamma: GAMMA, kappa: KAPPA },
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
    horizonBars: HORIZON,
    volWindowBars: VOL_WINDOW,
    volFloor: VOL_FLOOR,
    makerFeeBps: fee.makerBps,
    capitalUnits: BigInt(Math.round(CAPITAL_USD * 1e6)),
    symbol: lt.coin,
    riskGate,
    microDepth: MICRO_DEPTH,
    requote,
  });
}

function main(): void {
  const tapes = loadTapes();
  console.log(`\n=== REQUOTE HYSTERESIS vs CHASE — F2 quote anti-churn (${tapes.length} coins, ${STRATEGY}) ===`);
  console.log(`  fixed: γ=${GAMMA} κ=${KAPPA} floor=${FLOOR}bps maxLots=${MAX_LOTS} lot=$${QUOTE_USD.toLocaleString()} micro=${MICRO_DEPTH}`);
  console.log(`  F2: min ${REQUOTE.minBps}bps · dwell ${REQUOTE.dwellMs}ms · urgent ${REQUOTE.urgentBps}bps`);
  console.log(`  the question: does keeping queue position raise fills + net without giving back spread−adverse?\n`);
  console.log(`  coin    | CHASE: s-adv     net   qFills | F2:   s-adv     net   qFills  holds | Δ(s-adv)    Δnet  Δfills`);

  let cSA = 0, cNet = 0, hSA = 0, hNet = 0;
  for (const lt of tapes) {
    const chase = replay(lt, undefined);
    const held = replay(lt, REQUOTE);
    const chaseSA = u(chase.attribution.spreadCapturedUnits - chase.attribution.adverseSelectionUnits);
    const heldSA = u(held.attribution.spreadCapturedUnits - held.attribution.adverseSelectionUnits);
    const chaseNet = u(chase.netPnlUnits);
    const heldNet = u(held.netPnlUnits);
    cSA += chaseSA; cNet += chaseNet; hSA += heldSA; hNet += heldNet;
    const holds = held.requoteHysteresisHolds + held.requoteDwellHolds;
    const better = heldNet > chaseNet ? '✅' : '·';
    console.log(
      `  ${padR(lt.coin, 6)}  | ${padL(f2(chaseSA), 8)} ${padL(f2(chaseNet), 8)} ${padL(chase.queueFills, 6)} ` +
      `| ${padL(f2(heldSA), 8)} ${padL(f2(heldNet), 8)} ${padL(held.queueFills, 6)} ${padL(holds, 6)} ` +
      `| ${padL(f2(heldSA - chaseSA), 9)} ${padL(f2(heldNet - chaseNet), 8)} ${padL(held.queueFills - chase.queueFills, 6)} ${better}`,
    );
  }
  console.log(`  ${padR('DESK', 6)}  | ${padL(f2(cSA), 8)} ${padL(f2(cNet), 8)}        | ${padL(f2(hSA), 8)} ${padL(f2(hNet), 8)}               | ${padL(f2(hSA - cSA), 9)} ${padL(f2(hNet - cNet), 8)}`);
  console.log(`\n  Δfills > 0 = the queue position the chase was throwing away. If Δ(s-adv) is deeply negative,`);
  console.log(`  the held quotes are getting picked off — lower REQUOTE_URGENT_BPS before shipping.\n`);
}

main();
