/**
 * mm-microprice-compare — F1 of the fair-value engine (FAIR_VALUE_AND_THESIS_DESIGN.md).
 *
 * The #28 finding: naive MM quotes off a STALE MID and loses to adverse selection at
 * every spread width. The fix is a better quote CENTER. This script replays each saved
 * L2 tape TWICE at one fixed config — once quoting off the mid, once off the book-
 * imbalance MICRO-PRICE — and prints the per-coin P&L decomposition side by side. The
 * spread width is identical in both; only the center moves. Attribution is scored vs the
 * PLAIN mid in both, so the comparison honestly answers the one question that matters:
 *
 *   does quoting around the micro-price REDUCE adverse selection (raise spread − adverse)?
 *
 * Capture-once, compare-many — same tapes as mm-l2-tune:
 *   MM_TUNE_TAPE_PREFIX=docs/research/l2-tapes/hl-discovery-20260604 \
 *   MM_TUNE_COINS=BNB,DOGE,ETH,SOL,XRP,ADA,SUI \
 *   MICRO_DEPTH=5 GAMMA=0.0025 KAPPA=0.5 FLOOR=5 MAX_LOTS=2 \
 *     npx ts-node -r tsconfig-paths/register scripts/mm-microprice-compare.ts
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

const STRATEGY = process.env.MM_TUNE_STRATEGY ?? 'mm-glft';
const SOURCE = (process.env.MM_TUNE_SOURCE ?? 'hyperliquid').trim().toLowerCase();
const PREFIX = (process.env.MM_TUNE_TAPE_PREFIX ?? '').trim();
const COINS = (process.env.MM_TUNE_COINS ?? 'BNB,DOGE,ETH,SOL,XRP,ADA,SUI').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
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

const u = (units: bigint): number => Number(units) / 1e6;
const f2 = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(2);
const padL = (s: string | number, n: number): string => String(s).padStart(n);
const padR = (s: string | number, n: number): string => String(s).padEnd(n);

interface Loaded { coin: string; tape: L2TapeStep[]; midPrice: number; }

function loadTapes(): Loaded[] {
  if (!PREFIX) throw new Error('set MM_TUNE_TAPE_PREFIX=docs/research/l2-tapes/<prefix> (+ MM_TUNE_COINS)');
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

function replay(lt: Loaded, micro: boolean): LobReplayMetrics {
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
    microDepth: micro ? MICRO_DEPTH : 0,
  });
}

function main(): void {
  const tapes = loadTapes();
  console.log(`\n=== MICRO-PRICE vs MID — F1 fair-value test (${tapes.length} coins, ${STRATEGY}) ===`);
  console.log(`  fixed: γ=${GAMMA} κ=${KAPPA} floor=${FLOOR}bps maxLots=${MAX_LOTS} lot=$${QUOTE_USD.toLocaleString()} cap=$${CAPITAL_USD.toLocaleString()} | micro depth ${MICRO_DEPTH}`);
  console.log(`  the question: does quoting off the micro-price RAISE (spread − adverse) vs the mid?\n`);
  console.log(`  coin    | MID:  s-adv     net    qFills | MICRO: s-adv     net    qFills | Δ(s-adv)   Δnet`);

  let mSA = 0, mNet = 0, cSA = 0, cNet = 0; // desk sums (USD)
  for (const lt of tapes) {
    const mid = replay(lt, false);
    const mic = replay(lt, true);
    const midSA = u(mid.attribution.spreadCapturedUnits - mid.attribution.adverseSelectionUnits);
    const micSA = u(mic.attribution.spreadCapturedUnits - mic.attribution.adverseSelectionUnits);
    const midNet = u(mid.netPnlUnits);
    const micNet = u(mic.netPnlUnits);
    mSA += midSA; mNet += midNet; cSA += micSA; cNet += micNet;
    const better = micSA > midSA ? '✅' : '·';
    console.log(
      `  ${padR(lt.coin, 6)}  | ${padL(f2(midSA), 8)} ${padL(f2(midNet), 8)} ${padL(mid.queueFills, 6)} ` +
      `| ${padL(f2(micSA), 8)} ${padL(f2(micNet), 8)} ${padL(mic.queueFills, 6)} ` +
      `| ${padL(f2(micSA - midSA), 9)} ${padL(f2(micNet - midNet), 8)} ${better}`,
    );
  }
  console.log(`  ${padR('DESK', 6)}  | ${padL(f2(mSA), 8)} ${padL(f2(mNet), 8)}        | ${padL(f2(cSA), 8)} ${padL(f2(cNet), 8)}        | ${padL(f2(cSA - mSA), 9)} ${padL(f2(cNet - mNet), 8)}`);
  console.log(`\n  spread−adverse is the SPREAD edge (carry-independent). If MICRO raises it desk-wide, the`);
  console.log(`  micro-price quoter is the real adverse-selection fix — F2 (Binance lead-lag) is next.\n`);
}

main();
