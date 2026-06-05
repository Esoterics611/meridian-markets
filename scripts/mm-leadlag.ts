/**
 * mm-leadlag — F2 of the fair-value engine: MEASURE the HL↔Binance lead-lag (HL is
 * itself a price-discovery venue, so we do NOT assume Binance leads), then BACKTEST
 * the cross-venue fusion on the saved tapes.
 *
 * For each coin: fetch Binance 1s klines over the tape window, align the most recent
 * fully-closed Binance price to each HL step (no lookahead), compute the two-sided
 * lead-lag cross-correlation + the error-correction β, then replay the LobReplayHarness
 * three ways — quote off the mid / the micro-price / the micro+cross-venue-fused price —
 * and report the adverse-selection reduction per coin. β is fit per coin; β≈0 (HL self-
 * sufficient) ⇒ the fused result ≈ the micro result, which is the honest answer there.
 *
 *   MM_TUNE_TAPE_PREFIX=docs/research/l2-tapes/hl-discovery-20260604 \
 *   MM_TUNE_COINS=BTC,ETH,SOL,BNB,XRP,DOGE,ADA,SUI \
 *   MICRO_DEPTH=5 GAMMA=0.0025 KAPPA=0.5 FLOOR=5 MAX_LOTS=2 MAX_LAG=4 \
 *     npx ts-node -r tsconfig-paths/register scripts/mm-leadlag.ts
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
import { leadLagProfile, dominantLead, estimateErrorCorrectionBeta } from '../src/market-making/microstructure/cross-venue';
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';

const STRATEGY = process.env.MM_TUNE_STRATEGY ?? 'mm-glft';
const SOURCE = (process.env.MM_TUNE_SOURCE ?? 'hyperliquid').trim().toLowerCase();
const PREFIX = (process.env.MM_TUNE_TAPE_PREFIX ?? '').trim();
const COINS = (process.env.MM_TUNE_COINS ?? 'BTC,ETH,SOL,BNB,XRP,DOGE,ADA,SUI').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
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
const MAX_LAG = Number(process.env.MAX_LAG ?? 4); // in HL steps (~18s each)

const u = (x: bigint): number => Number(x) / 1e6;
const f2 = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(2);
const padL = (s: string | number, n: number): string => String(s).padStart(n);
const padR = (s: string | number, n: number): string => String(s).padEnd(n);

interface Loaded { coin: string; tape: L2TapeStep[]; midPrice: number; }

function loadTape(coin: string): Loaded | undefined {
  const file = `${PREFIX}-${coin}.json`;
  try {
    const tape = parseTape(readFileSync(file, 'utf8'));
    if (tape.length === 0) return undefined;
    const m = midMicros(tape[0].book);
    return { coin: tape[0].book.symbol || coin, tape, midPrice: m ? Number(m) / 1e6 : 0 };
  } catch { return undefined; }
}

/** Most recent fully-closed Binance price (close of a 1s bar ending ≤ ts) per HL step. */
async function alignedBinanceMids(coin: string, tape: L2TapeStep[], binance: BinancePublicClient): Promise<(number | undefined)[]> {
  const firstTs = tape[0].book.ts.getTime();
  const lastTs = tape[tape.length - 1].book.ts.getTime();
  const bars = await binance.historicalKlines(coin, '1s', firstTs - 5_000, lastTs + 1_000);
  if (bars.length === 0) return tape.map(() => undefined);
  // (closeTimeMs, close) sorted ascending; close time of a 1s bar = open + 999ms.
  const series = bars.map((b) => ({ t: b.timestamp.getTime() + 999, p: b.close })).sort((a, b) => a.t - b.t);
  return tape.map((s) => {
    const ts = s.book.ts.getTime();
    // binary search: latest bar with closeTime <= ts (no lookahead).
    let lo = 0, hi = series.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].t <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? series[ans].p : undefined;
  });
}

function replay(lt: Loaded, micro: boolean, lead?: { mids: (number | undefined)[]; beta: number }): LobReplayMetrics {
  const fee = venueFeeFor(SOURCE);
  const quoteUnits = BigInt(Math.max(1, Math.round((QUOTE_USD / Math.max(lt.midPrice, 1e-9)) * 1e6)));
  const quoter = mmStrategyRegistry.build(STRATEGY, {
    quoteSizeUnits: quoteUnits, minHalfSpreadBps: FLOOR, maxHalfSpreadBps: MAX_BPS,
    maxInventoryLots: MAX_LOTS, params: { gamma: GAMMA, kappa: KAPPA },
  });
  const riskGate = new CompositeRiskGate({
    maxInventoryUnits: quoteUnits * BigInt(MAX_LOTS), minNavRatio: 1 - DD_LIMIT / 100,
    vpinPauseThreshold: 2, vpinPauseMs: 30_000, maxAdverseUnits: 1_000_000_000_000_000n, adversePauseMs: 30_000,
  });
  return new LobReplayHarness().run({
    tape: lt.tape, quoter, quoteSizeUnits: quoteUnits, gamma: GAMMA, kappa: KAPPA, horizonBars: HORIZON,
    volWindowBars: VOL_WINDOW, volFloor: VOL_FLOOR, makerFeeBps: fee.makerBps,
    capitalUnits: BigInt(Math.round(CAPITAL_USD * 1e6)), symbol: lt.coin, riskGate,
    microDepth: micro ? MICRO_DEPTH : 0,
    leadMicros: lead ? lead.mids.map((p) => (p !== undefined && p > 0 ? BigInt(Math.round(p * 1e6)) : undefined)) : undefined,
    leadBeta: lead?.beta,
  });
}

function returns(xs: (number | undefined)[]): { hl: number[]; idx: number[] } {
  const hl: number[] = []; const idx: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const a = xs[i - 1]; const b = xs[i];
    if (a && b && a > 0) { hl.push((b - a) / a); idx.push(i); }
  }
  return { hl, idx };
}

async function main(): Promise<void> {
  if (!PREFIX) throw new Error('set MM_TUNE_TAPE_PREFIX=docs/research/l2-tapes/<prefix> (+ MM_TUNE_COINS)');
  const binance = new BinancePublicClient({ quote: 'USDT' });
  console.log(`\n=== HL↔Binance LEAD-LAG + cross-venue fusion (F2) — ${COINS.length} coins, ${STRATEGY} ===`);
  console.log(`  fixed: γ=${GAMMA} κ=${KAPPA} floor=${FLOOR}bps maxLots=${MAX_LOTS} micro depth ${MICRO_DEPTH} | lag ±${MAX_LAG} steps (~18s)\n`);
  console.log(`  coin   | leads     lag  peakCorr   β     | s-adv: MID    MICRO   FUSED  | net: MID     MICRO    FUSED`);

  let dMid = 0, dMic = 0, dFus = 0, dMidN = 0, dMicN = 0, dFusN = 0;
  for (const c of COINS) {
    const lt = loadTape(c);
    if (!lt) { console.log(`  ${padR(c, 6)} | skip (no tape)`); continue; }
    let bMids: (number | undefined)[];
    try { bMids = await alignedBinanceMids(c, lt.tape, binance); }
    catch (e) { console.log(`  ${padR(c, 6)} | Binance fetch failed: ${(e as Error).message}`); continue; }
    const have = bMids.filter((x) => x !== undefined).length;
    if (have < lt.tape.length * 0.5) { console.log(`  ${padR(c, 6)} | thin Binance coverage (${have}/${lt.tape.length}) — skip (likely not on Binance spot)`); continue; }

    // Lead-lag: HL returns vs Binance returns, aligned on steps where both exist.
    const hlMids = lt.tape.map((s) => { const m = midMicros(s.book); return m ? Number(m) / 1e6 : undefined; });
    const hlR = returns(hlMids); const bR = returns(bMids);
    const n = Math.min(hlR.hl.length, bR.hl.length);
    const prof = leadLagProfile(hlR.hl.slice(0, n), bR.hl.slice(0, n), MAX_LAG);
    const peak = dominantLead(prof);
    const beta = estimateErrorCorrectionBeta(hlMids.map((x) => x ?? 0), bMids.map((x) => x ?? 0));
    const who = peak.lag > 0 ? 'BINANCE' : peak.lag < 0 ? 'HL' : 'sync';

    const mid = replay(lt, false);
    const mic = replay(lt, true);
    const fus = replay(lt, true, { mids: bMids, beta });
    const sa = (m: LobReplayMetrics) => u(m.attribution.spreadCapturedUnits - m.attribution.adverseSelectionUnits);
    dMid += sa(mid); dMic += sa(mic); dFus += sa(fus);
    dMidN += u(mid.netPnlUnits); dMicN += u(mic.netPnlUnits); dFusN += u(fus.netPnlUnits);
    const flag = sa(fus) > sa(mic) ? '✅' : '·';
    console.log(
      `  ${padR(lt.coin, 6)} | ${padR(who, 7)} ${padL(peak.lag, 4)} ${padL(peak.corr.toFixed(3), 8)} ${padL(beta.toFixed(3), 6)} ` +
      `| ${padL(f2(sa(mid)), 7)} ${padL(f2(sa(mic)), 7)} ${padL(f2(sa(fus)), 7)} ` +
      `| ${padL(f2(u(mid.netPnlUnits)), 7)} ${padL(f2(u(mic.netPnlUnits)), 7)} ${padL(f2(u(fus.netPnlUnits)), 7)} ${flag}`,
    );
  }
  console.log(`  ${padR('DESK', 6)} |                              | ${padL(f2(dMid), 7)} ${padL(f2(dMic), 7)} ${padL(f2(dFus), 7)} | ${padL(f2(dMidN), 7)} ${padL(f2(dMicN), 7)} ${padL(f2(dFusN), 7)}`);
  console.log(`\n  'leads' = who price-discovers (lag>0 ⇒ Binance leads HL; <0 ⇒ HL leads; 0 ⇒ sync). β = error-correction speed.`);
  console.log(`  FUSED beating MICRO on spread−adverse ⇒ the cross-venue term helps THAT coin; β≈0 ⇒ HL self-sufficient (fused≈micro).\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
