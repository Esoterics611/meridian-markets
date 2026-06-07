/**
 * Directional-bias OOS sweep — the honesty gate before the AXED maker rests at
 * q* = bias·Q_max (DIRECTIONAL_MM_STRATEGY.md §9). "A blind bias is just a
 * leveraged way to lose", so before any candidate directional signal sizes live
 * carry it must show a positive OOS forward-return correlation, per coin /
 * per asset class, AFTER the multiple-testing haircut.
 *
 * It tests TWO interpretable signals (no ML — CLAUDE.md doctrine):
 *   1. FUNDING-CARRY SIGN ("be long the funding-PAID side"): on a perp, +funding ⇒
 *      longs pay ⇒ SHORT is paid ⇒ bias b = −sign(funding). We feed the BIAS itself
 *      (= −trailing-mean funding) as the signal, so a POSITIVE IC means leaning the
 *      paid side predicts forward return. This is the FundingBiasSource claim and
 *      is a DISTINCT claim from merely harvesting carry — only forward-return
 *      prediction counts here.
 *   2. MOMENTUM / TREND: the trailing L-bar log return predicts the forward return.
 *      bias b = trailing return (a long-the-trend view). Tested at a couple of
 *      lookback × forward horizons.
 *
 * Method (honest, OOS): each signal at bar t uses data up to t ONLY (no
 * look-ahead). We measure its IC (Pearson + Spearman) and the deflated Sharpe of
 * the direction-only P&L stream sign(b)·fwdRet via PURGED K-FOLD with an embargo
 * that covers the forward horizon (no label leakage), then DEFLATE for the whole
 * sweep's trials (coins × signals × horizons) using the cross-trial Sharpe
 * dispersion σ_SR. Reuses the repo's deflated-Sharpe + purged-kfold machinery
 * unchanged (src/market-making/bias/oos/forward-return-ic.ts).
 *
 * DB-free, no key — real HL public candles + real HL hourly funding (or Binance,
 * see DBO_SOURCE). Writes a JSON artifact under docs/research/.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/directional-bias-oos.ts
 *   DBO_DAYS=180 DBO_INTERVAL=1h DBO_FWD_HOURS=8,24,72 \
 *     DBO_COINS=BTC,ETH,SOL,BNB,XRP,AVAX,LINK,ARB,DOGE \
 *     npx ts-node -r tsconfig-paths/register scripts/directional-bias-oos.ts
 *   DBO_SOURCE=binance npx ts-node -r tsconfig-paths/register scripts/directional-bias-oos.ts
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { Bar } from '../src/stat-arb/backtest/bar';
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';
import { HyperliquidFundingClient } from '../src/market-data/funding/hyperliquid-funding-client';
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { BinanceFundingClient } from '../src/market-data/funding/binance-funding-client';
import { FundingPoint } from '../src/market-data/funding/funding-source.interface';
import {
  buildSignalForwardPairs,
  oosForwardReturnIc,
  verdictFor,
  biasMagnitudeCap,
  OosIcReport,
  BiasVerdict,
} from '../src/market-making/bias/oos/forward-return-ic';
import { sharpeStats } from '../src/stat-arb/research/deflated-sharpe';

// ── Config ──────────────────────────────────────────────────────────────────
const SOURCE = (process.env.DBO_SOURCE ?? 'hyperliquid').trim().toLowerCase();
const IS_BINANCE = SOURCE === 'binance';
const DAYS = Number(process.env.DBO_DAYS ?? 180);
const INTERVAL = process.env.DBO_INTERVAL ?? '1h';
// Forward-return horizons in HOURS (hours→days, the bias' weekly/daily scope).
const FWD_HOURS = (process.env.DBO_FWD_HOURS ?? '8,24,72,168').split(',').map(Number).filter((h) => h > 0);
// Momentum lookbacks in HOURS.
const MOM_LOOKBACK_HOURS = (process.env.DBO_MOM_LOOKBACK_HOURS ?? '24,72').split(',').map(Number).filter((h) => h > 0);
// Trailing-funding window (hours) for the funding-sign signal — the carry "regime".
const FUNDING_WINDOW_HOURS = Number(process.env.DBO_FUNDING_WINDOW_HOURS ?? 24);
const FOLDS = Number(process.env.DBO_FOLDS ?? 5);
const EMBARGO_FRAC = Number(process.env.DBO_EMBARGO_FRAC ?? 0.01);

// Majors vs alts so the per-asset-class verdict is meaningful.
const MAJORS = (process.env.DBO_MAJORS ?? 'BTC,ETH,SOL,BNB,XRP').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const ALTS = (process.env.DBO_ALTS ?? 'AVAX,LINK,ARB,DOGE').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const COINS_OVERRIDE = (process.env.DBO_COINS ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const classOf = (coin: string): 'majors' | 'alts' => (MAJORS.includes(coin) ? 'majors' : 'alts');
const COINS = COINS_OVERRIDE.length ? COINS_OVERRIDE : [...MAJORS, ...ALTS];

const r3 = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '—');

function intervalHours(iv: string): number {
  const m = /^(\d+)([mhd])$/.exec(iv.trim());
  if (!m) return 1;
  const n = Number(m[1]);
  return m[2] === 'h' ? n : m[2] === 'd' ? n * 24 : n / 60;
}

/** Inner-join price bars + a per-bar trailing-funding-mean series (no look-ahead). */
function trailingFundingPerHour(barTimesMs: number[], funding: FundingPoint[], windowHours: number): number[] {
  // funding sorted ascending by time; for each bar t, mean rate over (t−window, t].
  const sorted = [...funding].sort((a, b) => a.fundingTimeMs - b.fundingTimeMs);
  const out: number[] = new Array(barTimesMs.length).fill(NaN);
  const winMs = windowHours * 3_600_000;
  for (let i = 0; i < barTimesMs.length; i++) {
    const t = barTimesMs[i];
    let sum = 0;
    let cnt = 0;
    for (const f of sorted) {
      if (f.fundingTimeMs > t) break; // strictly past data only
      if (f.fundingTimeMs > t - winMs) {
        sum += f.fundingRate;
        cnt++;
      }
    }
    out[i] = cnt > 0 ? sum / cnt : NaN; // mean funding/hr over the trailing window
  }
  return out;
}

/** Trailing L-bar log return at each bar (uses data up to t only). */
function trailingMomentum(prices: number[], lookbackBars: number): number[] {
  const out: number[] = new Array(prices.length).fill(NaN);
  for (let i = lookbackBars; i < prices.length; i++) {
    const p0 = prices[i - lookbackBars];
    const p1 = prices[i];
    out[i] = p0 > 0 && p1 > 0 ? Math.log(p1 / p0) : NaN;
  }
  return out;
}

interface TrialResult {
  coin: string;
  klass: 'majors' | 'alts';
  signal: string;
  fwdHours: number;
  report: OosIcReport;
}

async function fetchCoin(coin: string, fromMs: number, toMs: number): Promise<{ bars: Bar[]; funding: FundingPoint[] } | null> {
  const ivHours = intervalHours(INTERVAL);
  const wantBars = Math.ceil((DAYS * 24) / ivHours) + 16;
  try {
    if (IS_BINANCE) {
      const px = new BinancePublicClient({ quote: 'USDT' });
      const fund = new BinanceFundingClient({ quote: 'USDT' });
      const bars = await px.historicalKlines(coin, INTERVAL, fromMs, toMs);
      const funding = await fund.fundingHistory(coin, fromMs, toMs).catch(() => [] as FundingPoint[]);
      return bars.length ? { bars, funding } : null;
    }
    const px = new HyperliquidClient();
    const fund = new HyperliquidFundingClient();
    // HL candleSnapshot returns the most-recent `limit` bars; ask for the full window.
    const bars = await px.klines(coin, INTERVAL, wantBars);
    const funding = await fund.fundingHistory(coin, fromMs, toMs).catch(() => [] as FundingPoint[]);
    return bars.length ? { bars: bars.filter((b) => b.timestamp.getTime() >= fromMs), funding } : null;
  } catch (e) {
    process.stdout.write(`  ${coin}:ERR(${(e as Error).message.slice(0, 40)})`);
    return null;
  }
}

async function main() {
  const toMs = Date.now();
  const fromMs = toMs - DAYS * 86_400_000;
  const ivHours = intervalHours(INTERVAL);
  console.log(`\n=== Directional-bias OOS sweep · source=${SOURCE} · ${DAYS}d × ${INTERVAL} · fwd(h)=${FWD_HOURS.join(',')} · mom-lookback(h)=${MOM_LOOKBACK_HOURS.join(',')} · funding-window=${FUNDING_WINDOW_HOURS}h · ${FOLDS}-fold purged ===`);
  console.log(`coins: majors=[${MAJORS.join(',')}] alts=[${ALTS.join(',')}]${COINS_OVERRIDE.length ? ` (override: ${COINS.join(',')})` : ''}\n`);

  // ── Load all coins, build every (coin, signal, horizon) trial's pairs ──────
  interface Loaded { coin: string; klass: 'majors' | 'alts'; prices: number[]; timesMs: number[]; funding: FundingPoint[]; }
  const loaded: Loaded[] = [];
  for (const coin of COINS) {
    process.stdout.write(`pulling ${coin}…`);
    const got = await fetchCoin(coin, fromMs, toMs);
    if (!got || got.bars.length < FOLDS * 4) {
      process.stdout.write(`  ${coin}: insufficient bars (${got?.bars.length ?? 0}) — skipped\n`);
      continue;
    }
    const prices = got.bars.map((b) => b.close);
    const timesMs = got.bars.map((b) => b.timestamp.getTime());
    process.stdout.write(`  ${coin}: ${prices.length} bars, ${got.funding.length} funding pts\n`);
    loaded.push({ coin, klass: classOf(coin), prices, timesMs, funding: got.funding });
  }
  if (!loaded.length) {
    console.log('\nNo coins loaded — likely no network in this sandbox. Re-run the EXACT command on a networked host (see docs/DIRECTIONAL_BIAS_OOS_RESULTS.md).');
    return;
  }

  // Build the trial list. We compute ALL trials first to know the total trial
  // count + the σ_SR dispersion BEFORE deflating (the honest selection haircut).
  interface PendingTrial { coin: string; klass: 'majors' | 'alts'; signal: string; fwdHours: number; pairsLen: number; build: () => OosIcReport; rawSharpe: number; }
  const pending: PendingTrial[] = [];

  for (const L of loaded) {
    const fundingPerHr = trailingFundingPerHour(L.timesMs, L.funding, FUNDING_WINDOW_HOURS);
    const hasFunding = fundingPerHr.some((x) => Number.isFinite(x));

    for (const fh of FWD_HOURS) {
      const horizonBars = Math.max(1, Math.round(fh / ivHours));

      // Signal 1: funding-carry sign. bias = −trailing-mean funding (long the paid side).
      if (hasFunding) {
        const biasSig = fundingPerHr.map((f) => (Number.isFinite(f) ? -f : NaN));
        const pairs = buildSignalForwardPairs(L.prices, biasSig, horizonBars);
        if (pairs.length >= FOLDS) {
          const raw = sharpeStats(pairs.map((p) => Math.sign(p.signal) * p.forwardReturn)).sharpe;
          pending.push({
            coin: L.coin, klass: L.klass, signal: 'funding-paid-side', fwdHours: fh, pairsLen: pairs.length, rawSharpe: raw,
            build: () => oosForwardReturnIc(pairs, horizonBars, { folds: FOLDS, embargoFrac: EMBARGO_FRAC, trials: TRIALS, sigmaSR: SIGMA_SR }),
          });
        }
      }

      // Signal 2: momentum. bias = trailing L-bar return (long the trend).
      for (const lbH of MOM_LOOKBACK_HOURS) {
        const lookbackBars = Math.max(1, Math.round(lbH / ivHours));
        const momSig = trailingMomentum(L.prices, lookbackBars);
        const pairs = buildSignalForwardPairs(L.prices, momSig, horizonBars);
        if (pairs.length >= FOLDS) {
          const raw = sharpeStats(pairs.map((p) => Math.sign(p.signal) * p.forwardReturn)).sharpe;
          pending.push({
            coin: L.coin, klass: L.klass, signal: `momentum-${lbH}h`, fwdHours: fh, pairsLen: pairs.length, rawSharpe: raw,
            build: () => oosForwardReturnIc(pairs, horizonBars, { folds: FOLDS, embargoFrac: EMBARGO_FRAC, trials: TRIALS, sigmaSR: SIGMA_SR }),
          });
        }
      }
    }
  }

  // σ_SR = dispersion of the per-trial (in-sample direction) Sharpe across the
  // WHOLE sweep — the selection-bias scale the deflated Sharpe deflates by. TRIALS
  // = total candidate trials. Both must be known before building deflated reports,
  // so they are module-level lets the builders close over.
  TRIALS = pending.length;
  SIGMA_SR = std(pending.map((p) => p.rawSharpe).filter(Number.isFinite));
  console.log(`\ntrials (coin × signal × horizon) = ${TRIALS} · σ_SR (cross-trial Sharpe dispersion) = ${r3(SIGMA_SR)}\n`);

  // ── Run every trial through the deflated OOS gate ──────────────────────────
  const results: TrialResult[] = pending.map((p) => ({ coin: p.coin, klass: p.klass, signal: p.signal, fwdHours: p.fwdHours, report: p.build() }));

  // ── Per-coin / per-trial table ─────────────────────────────────────────────
  const cols = ['coin', 'class', 'signal', 'fwdH', 'n', 'pearsonIC', 'spearIC', 'hit', 'meanPnL', 'psr', 'dsr', 'verdict', 'biasCap'];
  const w: Record<string, number> = { coin: 6, class: 7, signal: 16, fwdH: 6, n: 7, pearsonIC: 10, spearIC: 9, hit: 6, meanPnL: 10, psr: 6, dsr: 6, verdict: 15, biasCap: 8 };
  const header = cols.map((c) => c.padEnd(w[c])).join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  const rowsForJson: Array<Record<string, unknown>> = [];
  for (const t of results.sort((a, b) => (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : a.signal < b.signal ? -1 : a.fwdHours - b.fwdHours))) {
    const rep = t.report;
    const verdict = verdictFor(rep);
    const recSign = rep.meanDirectionPnl >= 0 ? '+' : '−';
    const cap = verdict === 'VALIDATED' ? biasMagnitudeCap(rep.spearmanIc) : 0;
    const row: Record<string, string> = {
      coin: t.coin, class: t.klass, signal: t.signal, fwdH: `${t.fwdHours}h`, n: String(rep.n),
      pearsonIC: r3(rep.pearsonIc), spearIC: r3(rep.spearmanIc), hit: pct(rep.hitRate),
      meanPnL: r3(rep.meanDirectionPnl * 1e4, 1) + 'bp', psr: pct(rep.deflated.psr), dsr: pct(rep.deflated.dsr),
      verdict, biasCap: verdict === 'VALIDATED' ? `${recSign}${r3(cap, 2)}` : '—',
    };
    console.log(cols.map((c) => (row[c] ?? '').padEnd(w[c])).join(''));
    rowsForJson.push({ ...t, verdict, recommendedSign: recSign, biasCap: cap, report: rep });
  }

  // ── Per-asset-class pooled verdict (pool the OOS direction streams) ─────────
  console.log('\n=== Per-asset-class pooled (signal × class, pooled OOS direction P&L) ===');
  const classCols = ['class', 'signal', 'fwdH', 'coins', 'n', 'spearIC', 'hit', 'meanPnL', 'psr', 'dsr', 'verdict'];
  const cw: Record<string, number> = { class: 7, signal: 16, fwdH: 6, coins: 7, n: 8, spearIC: 9, hit: 6, meanPnL: 10, psr: 6, dsr: 6, verdict: 15 };
  console.log(classCols.map((c) => c.padEnd(cw[c])).join(''));
  const classJson: Array<Record<string, unknown>> = [];
  const groupKey = (klass: string, signal: string, fh: number) => `${klass}|${signal}|${fh}`;
  const groups = new Map<string, TrialResult[]>();
  for (const t of results) {
    const k = groupKey(t.klass, t.signal, t.fwdHours);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  // Class pooling: n-weighted aggregate of the per-coin OOS reports. pooled mean =
  // Σ n_i·mean_i / Σ n_i; pooled IC/hit = n-weighted; a class "validates" only when
  // the weighted edge is positive AND a MAJORITY of its coins individually validated
  // (no single coin carrying the class). We deliberately do NOT claim a class-level
  // deflated Sharpe (cross-coin correlation shrinks effective n) — the per-coin DSR is
  // the rigorous read; the class row is the diversified-direction summary.
  for (const [k, ts] of [...groups.entries()].sort()) {
    const [klass, signal, fhStr] = k.split('|');
    const fh = Number(fhStr);
    let nTot = 0;
    let weightedSpear = 0;
    let weightedMean = 0;
    let weightedHit = 0;
    // Approximate pooled Sharpe via the n-weighted average of per-coin Sharpes
    // (conservative; cross-coin correlation makes effective n smaller, so we judge
    // the class on the WEAKER of pooled-PSR and the per-coin majority).
    let weightedSharpe = 0;
    let validatedCoins = 0;
    for (const t of ts) {
      const rep = t.report;
      nTot += rep.n;
      weightedSpear += rep.spearmanIc * rep.n;
      weightedMean += rep.meanDirectionPnl * rep.n;
      weightedHit += rep.hitRate * rep.n;
      weightedSharpe += rep.stats.sharpe * rep.n;
      if (verdictFor(rep) === 'VALIDATED') validatedCoins++;
    }
    const spear = nTot ? weightedSpear / nTot : 0;
    const mean = nTot ? weightedMean / nTot : 0;
    const hit = nTot ? weightedHit / nTot : 0;
    const sharpe = nTot ? weightedSharpe / nTot : 0;
    // A class "validates" only when the n-weighted edge is positive AND a MAJORITY
    // of its coins individually validated (no single coin carrying the class).
    const majority = ts.length > 0 && validatedCoins / ts.length >= 0.5 && mean > 0 && spear > 0;
    const verdict: BiasVerdict = nTot < 30 ? 'INSUFFICIENT' : majority ? 'VALIDATED' : mean > 0 && spear > 0 ? 'INCONCLUSIVE' : 'NOT_VALIDATED';
    const row: Record<string, string> = {
      class: klass, signal, fwdH: `${fh}h`, coins: `${validatedCoins}/${ts.length}`, n: String(nTot),
      spearIC: r3(spear), hit: pct(hit), meanPnL: r3(mean * 1e4, 1) + 'bp',
      psr: '—', dsr: '—', verdict,
    };
    console.log(classCols.map((c) => (row[c] ?? '').padEnd(cw[c])).join(''));
    classJson.push({ klass, signal, fhHours: fh, coins: ts.map((t) => t.coin), nTot, spearmanIc: spear, meanDirectionPnl: mean, hitRate: hit, pooledSharpeWeighted: sharpe, validatedCoins, totalCoins: ts.length, verdict });
  }

  console.log(`\nLegend: spearIC=pooled OOS Spearman rank IC (effect size) · meanPnL=mean direction-only P&L per obs (bp) · psr=P(Sharpe>0) · dsr=Deflated Sharpe over ${TRIALS} trials (VALIDATED ≥95%) · biasCap=recommended sign + |b| magnitude cap (4·|IC|, ≤0.5).`);
  console.log('NOTE: this is SIGNAL VALIDATION (does the bias predict forward return OOS), NOT a P&L backtest of the live MM engine. A positive verdict licenses a sized, stop-gated carry tilt — not profitability.');

  const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const outPath = join('docs', 'research', `${ts}-directional-bias-oos-${SOURCE}.json`);
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(), source: SOURCE, days: DAYS, interval: INTERVAL,
    fwdHours: FWD_HOURS, momLookbackHours: MOM_LOOKBACK_HOURS, fundingWindowHours: FUNDING_WINDOW_HOURS,
    folds: FOLDS, embargoFrac: EMBARGO_FRAC, majors: MAJORS, alts: ALTS, coins: COINS,
    trials: TRIALS, sigmaSR: SIGMA_SR, perTrial: rowsForJson, perClass: classJson,
  }, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  console.log(`\nwrote ${outPath}`);
}

// Module-level deflation inputs the per-trial builders close over (set after the
// full trial list is known so TRIALS/σ_SR reflect the WHOLE sweep — the honest
// multiple-testing scale).
let TRIALS = 1;
let SIGMA_SR = 0;

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  let v = 0;
  for (const x of xs) v += (x - mean) ** 2;
  return Math.sqrt(v / (xs.length - 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
