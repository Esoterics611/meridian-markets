/**
 * Close-the-flag: run the REAL-history walk-forward OOS gate + deflated Sharpe on
 * the standing deploy candidates (Journal Entry #2 left "ai-data z-score @ eZ2–2.5"
 * blocked on OOS). DB-free — fetches real bars directly from Binance (crypto) or
 * Alpaca (US equities), like scripts/quant-research.ts / cointegration-stability.ts,
 * so it needs no server and no Postgres.
 *
 * What it does, per candidate pair:
 *   1. pull ~N days of real bars (default 30d × 15m for regime coverage, P0.5),
 *   2. walk-forward: re-fit β on each TRAIN slice (Engle-Granger), trade the next
 *      TEST slice OOS, net of fee + half-spread + impact (P0.1) + short-borrow
 *      carry on the short leg (P0.4 — the dominant cost for equities),
 *   3. pool the OOS trades → pooled Sharpe, PSR, and DEFLATED Sharpe over the
 *      number of pairs scanned in the class (selection-bias haircut, P0.3).
 *
 * Source switch (mirrors cointegration-stability.ts):
 *   OOS_SOURCE=binance (default, crypto)  — fee 5bps, half-spread 2bps, no borrow.
 *   OOS_SOURCE=alpaca  (US equities)      — commission-free (fee 0bps), tight
 *     half-spread (1bps), and short-borrow carry ON (50bps/yr = easy-to-borrow
 *     large-cap default; raise OOS_BORROW_BPS_YEAR for hard-to-borrow names).
 *     Requires ALPACA_KEY_ID + ALPACA_SECRET. NOTE: the free `iex` feed undercounts
 *     consolidated volume, so the impact ADV is conservative (overstates impact).
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
 *   OOS_PRESET=ai-data OOS_DAYS=30 OOS_INTERVAL=15m OOS_ENTRY=2.0,2.5 npx ts-node ... scripts/oos-candidates.ts
 *   OOS_SOURCE=alpaca OOS_PRESET=equity-banks OOS_DAYS=120 npx ts-node ... scripts/oos-candidates.ts
 */
import { Bar } from '../src/stat-arb/backtest/bar';
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { AlpacaDataClient } from '../src/stat-arb/feed/alpaca/alpaca-data-client';
import { discoverPairs } from '../src/stat-arb/discovery/pair-discovery';
import { walkForward } from '../src/stat-arb/research/walk-forward';
import { HistoricalReplayVenue } from '../src/stat-arb/historical-replay-venue';
import { strategyRegistry } from '../src/stat-arb/strategies/strategy-registry';
import { cointegrationTest } from '../src/stat-arb/signal/cointegration';
import { sharpeStats, deflatedSharpe } from '../src/stat-arb/research/deflated-sharpe';
import { getAnyPreset } from '../src/stat-arb/markets/market-presets';

const USDC = 1e6;
// OOS_SOURCE=binance (crypto, default) | alpaca (US equities — the pivot).
const SOURCE = (process.env.OOS_SOURCE ?? 'binance').trim().toLowerCase();
const IS_ALPACA = SOURCE === 'alpaca';
const PRESET = process.env.OOS_PRESET ?? (IS_ALPACA ? 'equity-banks' : 'ai-data');
const DAYS = Number(process.env.OOS_DAYS ?? 30);
const INTERVAL = process.env.OOS_INTERVAL ?? '15m';
const ENTRY_GRID = (process.env.OOS_ENTRY ?? '2.0,2.5').split(',').map(Number);
const NOTIONAL = BigInt(Math.round(Number(process.env.OOS_NOTIONAL_USDC ?? 100_000))) * 1_000_000n;
const TRAIN = Number(process.env.OOS_TRAIN ?? 300);
const TEST = Number(process.env.OOS_TEST ?? 100);
const TOPK = Number(process.env.OOS_TOPK ?? 3);
// Cost model — source-aware defaults (env overrides win). Equities on Alpaca are
// commission-free with tight large-cap spreads, but pay short-borrow carry.
const TAKER_FEE_BPS = BigInt(Math.round(Number(process.env.OOS_TAKER_FEE_BPS ?? (IS_ALPACA ? 0 : 5))));
const HALF_SPREAD_BPS = Number(process.env.OOS_HALF_SPREAD_BPS ?? (IS_ALPACA ? 1 : 2));
const IMPACT_LAMBDA_BPS = Number(process.env.OOS_IMPACT_LAMBDA_BPS ?? 10);
const BORROW_BPS_YEAR = Number(process.env.OOS_BORROW_BPS_YEAR ?? (IS_ALPACA ? 50 : 0));
const r2 = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const fmtUsd = (units: bigint) => (Number(units) / USDC).toLocaleString(undefined, { maximumFractionDigits: 0 });

/** Inner-join many symbol series on the timestamps present in ALL of them. */
function alignMany(bySymbol: Map<string, Bar[]>): Map<string, Bar[]> {
  const symbols = [...bySymbol.keys()];
  if (!symbols.length) return new Map();
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

function fitBetaOnTrain(a: Bar[], b: Bar[]): number {
  if (a.length < 10 || a.length !== b.length) return 1;
  try {
    const beta = cointegrationTest(a.map((x) => Math.log(x.close)), b.map((x) => Math.log(x.close))).beta;
    return Number.isFinite(beta) ? beta : 1;
  } catch {
    return 1;
  }
}

async function main() {
  const preset = getAnyPreset(PRESET);
  if (!preset) throw new Error(`unknown preset ${PRESET}`);
  if (IS_ALPACA && (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET)) {
    console.error('OOS_SOURCE=alpaca requires ALPACA_KEY_ID and ALPACA_SECRET in the environment.');
    process.exit(1);
  }
  const toMs = Date.now();
  const fromMs = toMs - DAYS * 86_400_000;
  const barSeconds = intervalMinutes(INTERVAL) * 60;

  // Source-agnostic bar loader — the discovery gate + walk-forward downstream is identical.
  const binance = IS_ALPACA ? undefined : new BinancePublicClient({ quote: preset.quote });
  const alpaca = IS_ALPACA
    ? new AlpacaDataClient({
        keyId: process.env.ALPACA_KEY_ID ?? '',
        secret: process.env.ALPACA_SECRET ?? '',
        dataBaseUrl: process.env.ALPACA_DATA_BASE_URL ?? 'https://data.alpaca.markets',
        feed: process.env.ALPACA_DATA_FEED ?? 'iex',
      })
    : undefined;
  const load = (sym: string): Promise<Bar[]> =>
    IS_ALPACA ? alpaca!.historicalBars(sym, INTERVAL, fromMs, toMs)
              : binance!.historicalKlines(sym, INTERVAL, fromMs, toMs);

  const costs = `${TAKER_FEE_BPS}bps fee + ${HALF_SPREAD_BPS}bps half-spread + ${IMPACT_LAMBDA_BPS}bps impact` +
    (BORROW_BPS_YEAR ? ` + ${BORROW_BPS_YEAR}bps/yr short-borrow` : '');
  console.log(`\n=== OOS gate · source=${SOURCE} · preset=${PRESET} · ${DAYS}d × ${INTERVAL} · $${fmtUsd(NOTIONAL)}/leg · costs: ${costs} ===`);
  console.log(`pulling ${preset.symbols.length} symbols from ${IS_ALPACA ? 'Alpaca' : 'Binance'}…`);
  const bySymbol = new Map<string, Bar[]>();
  for (const sym of preset.symbols) {
    try {
      const bars = await load(sym);
      if (bars.length > 0) bySymbol.set(sym, bars);
      process.stdout.write(`  ${sym}:${bars.length}`);
    } catch {
      process.stdout.write(`  ${sym}:ERR`);
    }
  }
  console.log('');
  const aligned = alignMany(bySymbol);
  const lens = [...aligned.values()].map((b) => b.length);
  const minLen = lens.length ? Math.min(...lens) : 0;
  const days = minLen >= 2 ? ((minLen - 1) * intervalMinutes(INTERVAL)) / (60 * 24) : 0;
  console.log(`aligned: ${aligned.size} symbols × ${minLen} common bars (~${r2(days, 1)} days)\n`);
  if (aligned.size < 2 || minLen < TRAIN + TEST) {
    console.log(`NOT ENOUGH DATA: need ≥ ${TRAIN + TEST} aligned bars, have ${minLen}. Increase OOS_DAYS.`);
    return;
  }

  const candidates = discoverPairs(aligned, { minBars: TRAIN + TEST, pValueCutoff: 0.6, maxHalfLifeBars: 240 });
  const trials = candidates.length; // selection pool for the deflated-Sharpe haircut
  console.log(`discovered ${trials} cointegrated candidate pairs (the selection pool / trials).`);
  if (!candidates.length) { console.log('no cointegrated pairs — nothing to gate.'); return; }

  const rows: Array<Record<string, string>> = [];
  for (const cand of candidates.slice(0, TOPK)) {
    const symA = cand.symbolA, symB = cand.symbolB;
    const barsA = aligned.get(symA)!, barsB = aligned.get(symB)!;
    for (const entryZ of ENTRY_GRID) {
      const report = await walkForward({
        barsA, barsB, trainBars: TRAIN, testBars: TEST,
        strategyFactory: (ctx) => strategyRegistry.build('pairs-zscore', {
          beta: fitBetaOnTrain(ctx.trainBarsA, ctx.trainBarsB),
          notionalUnits: NOTIONAL,
          params: { entryZ, exitZ: 0.5 },
        }),
        venueFactory: (sa, sb) => new HistoricalReplayVenue(
          { [symA]: sa, [symB]: sb },
          {
            takerFeeBps: TAKER_FEE_BPS,
            halfSpreadBps: HALF_SPREAD_BPS,
            impactLambdaBps: IMPACT_LAMBDA_BPS,
            borrowBpsPerYear: BORROW_BPS_YEAR,
            barSeconds,
          },
        ),
      });
      const oosTrades = report.windows.flatMap((w) => w.test.tradePnlUnits);
      const splitSharpes = report.windows.map((w) => w.test.sharpeRatio);
      const sigmaSR = std(splitSharpes);
      const stats = sharpeStats(oosTrades.map(Number));
      const ds = deflatedSharpe(stats.sharpe, stats.n, stats.skew, stats.kurtosis, trials, sigmaSR);
      const totalOos = report.windows.reduce((s, w) => s + w.test.totalPnlUnits, 0n);
      const avgTrain = report.windows.length ? report.windows.reduce((s, w) => s + w.train.sharpeRatio, 0) / report.windows.length : 0;
      const verdict = stats.n < 20 ? 'INSUFFICIENT' : ds.dsr >= 0.95 ? 'PASS' : ds.psr < 0.9 ? 'NOISE' : 'INCONCLUSIVE';
      rows.push({
        pair: `${symA}/${symB}`, eZ: String(entryZ), windows: String(report.windows.length),
        oosTrades: String(stats.n), oosSharpe: r2(stats.sharpe), avgTestSharpe: r2(report.avgTestSharpe),
        posWin: `${(report.positiveWindowShare * 100).toFixed(0)}%`, degr: r2(avgTrain - report.avgTestSharpe),
        oosPnl: `$${fmtUsd(totalOos)}`, psr: `${(ds.psr * 100).toFixed(0)}%`,
        eMax: r2(ds.expectedMaxSharpe), dsr: `${(ds.dsr * 100).toFixed(0)}%`, verdict,
      });
    }
  }

  const cols = ['pair', 'eZ', 'windows', 'oosTrades', 'oosSharpe', 'avgTestSharpe', 'posWin', 'degr', 'oosPnl', 'psr', 'eMax', 'dsr', 'verdict'];
  console.log('\n' + cols.map((c) => c.padEnd(c === 'pair' ? 12 : c === 'verdict' ? 13 : 9)).join(''));
  for (const row of rows) console.log(cols.map((c) => (row[c] ?? '').padEnd(c === 'pair' ? 12 : c === 'verdict' ? 13 : 9)).join(''));
  console.log(`\nLegend: oosSharpe=pooled per-trade Sharpe across all OOS test windows · degr=avg train Sharpe − avg test Sharpe (in-sample optimism) · psr=P(Sharpe>0) · eMax=expected max Sharpe by luck over ${trials} trials · dsr=Deflated Sharpe (PASS≥95%).`);
}

function intervalMinutes(iv: string): number {
  const m: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };
  return m[iv] ?? 1;
}
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  let v = 0;
  for (const x of xs) v += (x - mean) ** 2;
  return Math.sqrt(v / (xs.length - 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
