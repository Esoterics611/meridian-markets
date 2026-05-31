/**
 * Quant research harness — Meridian Markets stat-arb desk.
 *
 * A reproducible, DB-free study run DIRECTLY against live Binance public klines
 * (no server, no Postgres). It exists so a quant (human or a future session) can
 * answer two questions with real numbers:
 *
 *   1. WHERE IS THE VALUE? — sweep asset-class presets × strategy × entry-z and
 *      rank by net-of-fee P&L / Sharpe / per-trade edge (bps). The fee gate is
 *      live, so sub-fee pairs simply don't trade — the output is honest.
 *   2. HOW SHOULD WE SIZE? — under the flat 5 bps/leg replay venue, per-trade
 *      net edge in bps is INVARIANT to notional (gross and fees both scale
 *      linearly), so single-trade size is a risk/leverage lever, not alpha. The
 *      sizing value lives in (a) the fee gate and (b) market impact, which grows
 *      ~quadratically with size → an interior-optimal participation. We show
 *      both empirically.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/quant-research.ts
 *   QR_PRESETS=crypto-majors,l1-smart-contract QR_BARS=1000 npx ts-node ... (overrides)
 *
 * Writes raw results to docs/research/<UTCdate>-quant-research.json for continuity;
 * the prose interpretation lives in docs/QUANT_JOURNAL.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Bar } from '../src/stat-arb/backtest/bar';
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { discoverPairs, PairCandidate } from '../src/stat-arb/discovery/pair-discovery';
import { BacktestRunner } from '../src/stat-arb/backtest/backtest-runner';
import { HistoricalReplayVenue } from '../src/stat-arb/historical-replay-venue';
import { strategyRegistry } from '../src/stat-arb/strategies/strategy-registry';
import { MARKET_PRESETS } from '../src/stat-arb/markets/market-presets';

const USDC = 1e6;
// Per-leg notional in USDC (the strategy prices PnL on this). Default $25k/leg =
// the balanced 25%-per-leg deployment of a $100k book, so the netPnL column
// reads as real dollars on a real book. NOTE: impact (see sizing study) caps the
// honest size below this on thin legs — these are gross figures, pre-impact.
const NOTIONAL = BigInt(Math.round(Number(process.env.QR_NOTIONAL_USDC ?? 25_000))) * 1_000_000n;
const FEE_BPS = 5n;
const TOPK = 4; // top discovered pairs per preset to backtest
const ENTRY_GRID = [1.5, 2.0, 2.5];
const EXIT_Z = 0.5;
const STRATS = (process.env.QR_STRATS?.split(',').map((s) => s.trim()) ?? [
  'pairs-zscore', 'pairs-zscore-selective', 'pairs-zscore-wide',
  'pairs-ewma', 'pairs-ewma-conviction', 'ou-bertram', 'ou-bertram-throttled',
]).filter(Boolean);

const PRESETS = (process.env.QR_PRESETS?.split(',').map((s) => s.trim()) ?? [
  'crypto-majors', 'l1-smart-contract', 'defi-bluechip', 'eth-ecosystem', 'payments-sov', 'stablecoin-peg',
]).filter(Boolean);
const BARS = Number(process.env.QR_BARS ?? 1000);
const INTERVAL = process.env.QR_INTERVAL ?? '1m';
const MIN_PER_BAR: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };
const windowHours = (BARS * (MIN_PER_BAR[INTERVAL] ?? 1)) / 60;

const fmt = (units: bigint | number, d = 2) => (Number(units) / USDC).toLocaleString(undefined, { maximumFractionDigits: d });
const r2 = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

/** Align many symbol series to timestamps present in ALL of them (inner join). */
function alignMany(bySymbol: Map<string, Bar[]>): Map<string, Bar[]> {
  const symbols = [...bySymbol.keys()];
  if (symbols.length === 0) return new Map();
  const counts = new Map<number, number>();
  for (const bars of bySymbol.values()) {
    const seen = new Set<number>();
    for (const b of bars) seen.add(b.timestamp.getTime());
    for (const t of seen) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const common = new Set<number>();
  for (const [t, n] of counts) if (n === symbols.length) common.add(t);
  const out = new Map<string, Bar[]>();
  for (const [sym, bars] of bySymbol) out.set(sym, bars.filter((b) => common.has(b.timestamp.getTime())));
  return out;
}

interface ConfigResult {
  preset: string;
  strategy: string;
  entryZ: number | null;
  pairsTested: number;
  pairsNetPositive: number;
  totalTrades: number;
  netPnlUnits: number;
  avgSharpe: number;
  avgWinRate: number;
  edgePerTradeBps: number; // net, per unit leg-notional
  best: { pair: string; netPnlUnits: number; sharpe: number; trades: number } | null;
}

async function backtestPair(
  barsA: Bar[],
  barsB: Bar[],
  beta: number,
  strat: string,
  entryZ: number | null,
  notionalUnits = NOTIONAL,
) {
  const params = entryZ != null ? { entryZ, exitZ: EXIT_Z } : undefined;
  const strategy = strategyRegistry.build(strat, { beta, notionalUnits, params });
  const venue = new HistoricalReplayVenue(
    { [barsA[0].symbol]: barsA, [barsB[0].symbol]: barsB },
    { takerFeeBps: FEE_BPS },
  );
  const res = await new BacktestRunner().run({ barsA, barsB, strategy, venue });
  return res;
}

async function main(): Promise<void> {
  const client = new BinancePublicClient({});
  const started = new Date();
  console.log(`\n=== Meridian quant research — ${started.toISOString()} ===`);
  console.log(`window: ${BARS} × ${INTERVAL} bars (~${windowHours < 48 ? windowHours.toFixed(0) + 'h' : (windowHours / 24).toFixed(1) + 'd'}) · fee ${FEE_BPS}bps/leg · notional $${fmt(NOTIONAL, 0)}/leg\n`);

  const results: ConfigResult[] = [];
  // Stash the best pair window for the sizing study.
  let bestForSizing: { preset: string; strat: string; entryZ: number | null; a: Bar[]; b: Bar[]; beta: number; pair: PairCandidate } | null = null;
  let bestNet = -Infinity;

  for (const presetId of PRESETS) {
    const preset = MARKET_PRESETS.find((p) => p.id === presetId);
    if (!preset) { console.log(`! unknown preset ${presetId}`); continue; }

    // Pull real klines for every symbol, drop sparse ones, align on common ts.
    const raw = await Promise.all(
      preset.symbols.map(async (s) => [s, await client.klines(s, INTERVAL, BARS).catch(() => [] as Bar[])] as const),
    );
    // Keep only well-covered symbols: a gappy / late-listed ticker spans a
    // longer wall-clock window, so its timestamps don't fully intersect the
    // others and the inner-join collapses to ~0. Drop anything below 90% of the
    // best coverage BEFORE aligning (same spirit as the /universe endpoint).
    const maxRaw = Math.max(...raw.map(([, bars]) => bars.length), 0);
    const bySymbol = new Map<string, Bar[]>();
    for (const [s, bars] of raw) if (bars.length >= Math.max(200, 0.9 * maxRaw)) bySymbol.set(s, bars);
    const aligned = alignMany(bySymbol);
    const minLen = Math.min(...[...aligned.values()].map((b) => b.length), Infinity);
    if (aligned.size < 2 || minLen < 200) { console.log(`[${presetId}] insufficient aligned data (${aligned.size} syms, ${minLen} bars)`); continue; }

    const candidates = discoverPairs(aligned, { minBars: 200, pValueCutoff: 0.6, minHalfLifeBars: 3, maxHalfLifeBars: 240 });
    const top = candidates.slice(0, TOPK);
    console.log(`[${presetId}] ${aligned.size} symbols · ${minLen} aligned bars · ${candidates.length} cointegrated → top ${top.length}: ${top.map((c) => `${c.symbolA}/${c.symbolB}(p=${r2(c.pValue, 2)},hl=${r2(c.halfLifeBars, 0)})`).join(', ')}`);
    if (top.length === 0) continue;

    for (const strat of STRATS) {
      const grid = strat.startsWith('pairs-') ? ENTRY_GRID : [null];
      for (const entryZ of grid) {
        let trades = 0, net = 0, sharpeSum = 0, winSum = 0, npos = 0, npairs = 0;
        let cBest: ConfigResult['best'] = null;
        for (const c of top) {
          const a = aligned.get(c.symbolA)!;
          const b = aligned.get(c.symbolB)!;
          const res = await backtestPair(a, b, c.beta, strat, entryZ);
          const m = res.metrics;
          const pnl = Number(m.totalPnlUnits);
          npairs += 1;
          trades += m.totalTrades;
          net += pnl;
          sharpeSum += m.sharpeRatio;
          winSum += m.winRate;
          if (pnl > 0) npos += 1;
          if (!cBest || pnl > cBest.netPnlUnits) cBest = { pair: `${c.symbolA}/${c.symbolB}`, netPnlUnits: pnl, sharpe: m.sharpeRatio, trades: m.totalTrades };
          if (pnl > bestNet && m.totalTrades >= 5) { bestNet = pnl; bestForSizing = { preset: presetId, strat, entryZ, a, b, beta: c.beta, pair: c }; }
        }
        const edgeBps = trades > 0 ? (net / trades / Number(NOTIONAL)) * 1e4 : 0;
        results.push({
          preset: presetId, strategy: strat, entryZ,
          pairsTested: npairs, pairsNetPositive: npos, totalTrades: trades,
          netPnlUnits: net, avgSharpe: sharpeSum / npairs, avgWinRate: winSum / npairs,
          edgePerTradeBps: edgeBps, best: cBest,
        });
      }
    }
  }

  // --- Report 1: value board (net-of-fee), ranked ---
  console.log(`\n── VALUE BOARD — net of ${FEE_BPS}bps/leg fees, ranked by net P&L ──`);
  console.log('preset            strategy          eZ   pairs  +ve  trades   netPnL(USDC)  edge/trade(bps)  avgSharpe  win%');
  const ranked = [...results].sort((a, b) => b.netPnlUnits - a.netPnlUnits);
  for (const r of ranked) {
    console.log(
      `${r.preset.padEnd(17)} ${r.strategy.padEnd(17)} ${(r.entryZ ?? '·').toString().padStart(3)}  ${String(r.pairsTested).padStart(5)} ${String(r.pairsNetPositive).padStart(4)} ${String(r.totalTrades).padStart(7)}  ${fmt(r.netPnlUnits).padStart(12)}  ${r2(r.edgePerTradeBps).padStart(14)}  ${r2(r.avgSharpe).padStart(9)}  ${r2(r.avgWinRate * 100, 0).padStart(4)}`,
    );
  }

  // --- Report 2: position-sizing study on the single best config ---
  if (bestForSizing) {
    const { preset, strat, entryZ, a, b, beta, pair } = bestForSizing;
    console.log(`\n── SIZING STUDY — best config: ${preset} · ${strat} · eZ=${entryZ ?? '·'} · ${pair.symbolA}/${pair.symbolB} ──`);
    console.log('(A) Notional invariance under flat fees:');
    console.log('   notional(units)    trades    netPnL(USDC)    netPnL/notional(bps)    Sharpe');
    const sizes: bigint[] = [NOTIONAL, NOTIONAL * 10n, NOTIONAL * 100n];
    let edgePerUnit = 0; // a: net edge per unit notional (USDC micros per micro-notional)
    let tradesAtBase = 0;
    for (const N of sizes) {
      const res = await backtestPair(a, b, beta, strat, entryZ, N);
      const pnl = Number(res.metrics.totalPnlUnits);
      const bps = res.metrics.totalTrades > 0 ? (pnl / res.metrics.totalTrades / Number(N)) * 1e4 : 0;
      console.log(`   ${fmt(N, 0).padStart(14)}    ${String(res.metrics.totalTrades).padStart(6)}    ${fmt(pnl).padStart(12)}    ${r2(bps).padStart(20)}    ${r2(res.metrics.sharpeRatio).padStart(6)}`);
      if (N === NOTIONAL) { edgePerUnit = pnl / Number(N); tradesAtBase = res.metrics.totalTrades; }
    }

    // (B) Market-impact-aware optimum. ADV proxy in USDC = mean(volume×close) of
    // the THINNER leg. Impact (bps) at notional N ≈ lambda · N/ADV (square-root
    // models are gentler; linear is conservative). net(N)=a·N − b·N², b derived
    // from 4 fills/round-trip. Optimal participation N* = a/(2b).
    const advUsdc = (bars: Bar[]) => {
      let s = 0; for (const x of bars) s += x.volume * x.close; return (s / bars.length) * USDC; // → micros
    };
    const adv = Math.min(advUsdc(a), advUsdc(b));
    const lambda = Number(process.env.QR_IMPACT_LAMBDA_BPS ?? 10); // impact bps at N=ADV
    const aCoef = edgePerUnit; // USDC-micros of net PnL per micro of notional (>0 if edge)
    const bCoef = (4 * tradesAtBase * lambda) / (1e4 * adv); // quadratic impact coefficient
    console.log('\n(B) Market-impact-aware optimum (linear impact, lambda=' + lambda + 'bps @ ADV):');
    console.log(`   thinner-leg ADV ≈ ${fmt(adv)} USDC/bar · net edge/notional a=${(aCoef * 1e4).toFixed(3)}bps · trades=${tradesAtBase}`);
    if (aCoef > 0 && bCoef > 0) {
      const nStar = aCoef / (2 * bCoef); // micros of notional
      const netAtStar = (aCoef * nStar - bCoef * nStar * nStar);
      console.log(`   → optimal per-leg notional N* ≈ ${fmt(nStar, 0)} units · est. net after impact ≈ ${fmt(netAtStar)} USDC`);
      console.log(`   → at N* the impact cost equals HALF the gross edge (classic linear-impact result).`);
    } else {
      console.log('   → no positive-edge optimum (config is sub-fee or net-negative; impact only makes it worse).');
    }
  } else {
    console.log('\n── SIZING STUDY — no config with ≥5 trades and positive net P&L to size. (fee drag dominates this window.) ──');
  }

  // --- Persist raw results for continuity ---
  const outDir = path.resolve(process.cwd(), 'docs', 'research');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = started.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const outPath = path.join(outDir, `${stamp}-quant-research.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: started.toISOString(), window: { bars: BARS, interval: INTERVAL, hours: windowHours, feeBps: Number(FEE_BPS) },
    presets: PRESETS, strategies: STRATS, entryGrid: ENTRY_GRID, results,
    bestForSizing: bestForSizing ? { preset: bestForSizing.preset, strategy: bestForSizing.strat, entryZ: bestForSizing.entryZ, pair: `${bestForSizing.pair.symbolA}/${bestForSizing.pair.symbolB}`, beta: bestForSizing.beta } : null,
  }, null, 2));
  console.log(`\n✓ raw results → ${path.relative(process.cwd(), outPath)}`);
  console.log('  interpret in docs/QUANT_JOURNAL.md\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
