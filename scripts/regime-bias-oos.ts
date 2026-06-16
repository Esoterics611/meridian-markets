/**
 * regime-bias-oos — P2 of the standalone "take sides" book (REGIME_DIRECTIONAL_BOOK.md,
 * playbook S1). THE VALIDATED BOARD: the one screen a trader reads each morning to know
 * "what can I bet on today".
 *
 * For every symbol it screens the candidate directional signals (funding-paid-side +
 * momentum, from the shared, no-look-ahead src/market-making/directional/regime-signals.ts
 * library) across several forward horizons, scores each through the repo's honest OOS
 * gate (purged k-fold + deflated-Sharpe over the WHOLE sweep's trials — forward-return-ic.ts),
 * picks the BEST signal per symbol, and prints ONE row per symbol:
 *
 *   SYMBOL | BEST SIGNAL | OOS IC | HIT% | DSR | VERDICT | CONV CAP | ELIGIBLE
 *
 * Only ✅ ELIGIBLE (VALIDATED) symbols are ever allowed to take a side in the live book
 * (playbook S3). A symbol with no validated signal shows ⛔ and is excluded — that is the
 * CORRECT outcome, not a failure (honesty is the whole game, CLAUDE.md §1).
 *
 * This is the trader-facing sibling of scripts/directional-bias-oos.ts (which dumps EVERY
 * trial as a research artifact); both share the exact same signal definitions + gate, so
 * the board can never drift from the research sweep.
 *
 * DB-free, no API key — real HL public candles + HL hourly funding (or Binance). Writes a
 * compact JSON board to docs/research/ that the live runner (S3) reads for its eligible set.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/regime-bias-oos.ts
 *   RBO_DAYS=90 RBO_SYMBOLS=BTC,ETH,SOL,BNB,XRP,DOGE,ADA \
 *     RBO_FWD_HOURS=8,24,72 npx ts-node -r tsconfig-paths/register scripts/regime-bias-oos.ts
 *   RBO_SOURCE=binance npx ts-node -r tsconfig-paths/register scripts/regime-bias-oos.ts
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
  RegimeSeries,
  RegimeSignalSpec,
  defaultRegimeSignalSpecs,
  regimeSignalPairs,
} from '../src/market-making/directional/regime-signals';
import {
  oosForwardReturnIc,
  verdictFor,
  biasMagnitudeCap,
  OosIcReport,
  BiasVerdict,
} from '../src/market-making/bias/oos/forward-return-ic';
import { sharpeStats } from '../src/stat-arb/research/deflated-sharpe';

// ── Config ──────────────────────────────────────────────────────────────────
const SOURCE = (process.env.RBO_SOURCE ?? 'hyperliquid').trim().toLowerCase();
const IS_BINANCE = SOURCE === 'binance';
const DAYS = Number(process.env.RBO_DAYS ?? 90);
const INTERVAL = process.env.RBO_INTERVAL ?? '1h';
const FWD_HOURS = (process.env.RBO_FWD_HOURS ?? '8,24,72').split(',').map(Number).filter((h) => h > 0);
const MOM_LOOKBACK_HOURS = (process.env.RBO_MOM_LOOKBACK_HOURS ?? '24,72').split(',').map(Number).filter((h) => h > 0);
const FUNDING_WINDOW_HOURS = (process.env.RBO_FUNDING_WINDOW_HOURS ?? '24').split(',').map(Number).filter((h) => h > 0);
const FOLDS = Number(process.env.RBO_FOLDS ?? 5);
const EMBARGO_FRAC = Number(process.env.RBO_EMBARGO_FRAC ?? 0.01);
const SYMBOLS = (process.env.RBO_SYMBOLS ?? 'BTC,ETH,SOL,BNB,XRP,DOGE,ADA,SUI')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

// ── ANSI (guarded: off on non-TTY / NO_COLOR so piping stays clean) ───────────
const USE_COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string, s: string) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => wrap('32', s);
const amber = (s: string) => wrap('33', s);
const red = (s: string) => wrap('31', s);
const dim = (s: string) => wrap('2', s);
const bold = (s: string) => wrap('1', s);

const r3 = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const signed = (x: number, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
const pctI = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—');

function intervalHours(iv: string): number {
  const m = /^(\d+)([mhd])$/.exec(iv.trim());
  if (!m) return 1;
  const n = Number(m[1]);
  return m[2] === 'h' ? n : m[2] === 'd' ? n * 24 : n / 60;
}

function verdictColor(v: BiasVerdict): (s: string) => string {
  if (v === 'VALIDATED') return green;
  if (v === 'INCONCLUSIVE') return amber;
  return red; // NOT_VALIDATED / INSUFFICIENT
}

async function fetchSymbol(symbol: string, fromMs: number, toMs: number): Promise<{ bars: Bar[]; funding: FundingPoint[] } | null> {
  const ivHours = intervalHours(INTERVAL);
  const wantBars = Math.ceil((DAYS * 24) / ivHours) + 16;
  try {
    if (IS_BINANCE) {
      const px = new BinancePublicClient({ quote: 'USDT' });
      const fund = new BinanceFundingClient({ quote: 'USDT' });
      const bars = await px.historicalKlines(symbol, INTERVAL, fromMs, toMs);
      const funding = await fund.fundingHistory(symbol, fromMs, toMs).catch(() => [] as FundingPoint[]);
      return bars.length ? { bars, funding } : null;
    }
    const px = new HyperliquidClient();
    const fund = new HyperliquidFundingClient();
    const bars = await px.klines(symbol, INTERVAL, wantBars);
    const funding = await fund.fundingHistory(symbol, fromMs, toMs).catch(() => [] as FundingPoint[]);
    return bars.length ? { bars: bars.filter((b) => b.timestamp.getTime() >= fromMs), funding } : null;
  } catch (e) {
    process.stdout.write(`  ${symbol}: ERR(${(e as Error).message.slice(0, 48)})\n`);
    return null;
  }
}

interface Trial {
  symbol: string;
  spec: RegimeSignalSpec;
  fwdHours: number;
  report: OosIcReport;
  verdict: BiasVerdict;
}

/** The best signal a symbol can bet on: a VALIDATED one with the strongest IC if any
 *  exists, else the highest-IC contender (shown so the trader sees the near-miss). */
function bestForSymbol(trials: Trial[]): Trial | null {
  if (!trials.length) return null;
  const validated = trials.filter((t) => t.verdict === 'VALIDATED');
  const pool = validated.length ? validated : trials;
  return pool.reduce((a, b) => (b.report.spearmanIc > a.report.spearmanIc ? b : a));
}

async function main() {
  const toMs = Date.now();
  const fromMs = toMs - DAYS * 86_400_000;
  const ivHours = intervalHours(INTERVAL);
  const specs = defaultRegimeSignalSpecs({ intervalHours: ivHours, momentumLookbackHours: MOM_LOOKBACK_HOURS, fundingWindowHours: FUNDING_WINDOW_HOURS });

  console.log(bold(`\n=== REGIME VALIDATED BOARD · source=${SOURCE} · ${DAYS}d × ${INTERVAL} · fwd(h)=${FWD_HOURS.join(',')} · ${FOLDS}-fold purged OOS ===`));
  console.log(dim(`signals: ${specs.map((s) => s.name).join(', ')} | symbols: ${SYMBOLS.join(', ')}`));
  console.log(dim(`the morning read: only ✅ ELIGIBLE (VALIDATED) symbols may take a side today.\n`));

  // ── Load every symbol's real history ───────────────────────────────────────
  const loaded: { symbol: string; series: RegimeSeries }[] = [];
  for (const symbol of SYMBOLS) {
    process.stdout.write(`pulling ${symbol}… `);
    const got = await fetchSymbol(symbol, fromMs, toMs);
    if (!got || got.bars.length < FOLDS * 4) {
      process.stdout.write(`insufficient bars (${got?.bars.length ?? 0}) — skipped\n`);
      continue;
    }
    const series: RegimeSeries = {
      prices: got.bars.map((b) => b.close),
      barTimesMs: got.bars.map((b) => b.timestamp.getTime()),
      funding: got.funding,
    };
    process.stdout.write(`${series.prices.length} bars, ${got.funding.length} funding pts\n`);
    loaded.push({ symbol, series });
    await new Promise((r) => setTimeout(r, 80)); // polite on the public API
  }
  if (!loaded.length) {
    console.log('\nNo symbols loaded — likely no network in this sandbox. Re-run the EXACT command on a networked host.');
    return;
  }

  // ── Build every (symbol × signal × horizon) trial, then deflate over the WHOLE
  //    sweep (TRIALS + σ_SR = the honest multiple-testing haircut) ──────────────
  interface Pending { symbol: string; spec: RegimeSignalSpec; fwdHours: number; horizonBars: number; pairs: ReturnType<typeof regimeSignalPairs>; rawSharpe: number; }
  const pending: Pending[] = [];
  for (const L of loaded) {
    for (const fh of FWD_HOURS) {
      const horizonBars = Math.max(1, Math.round(fh / ivHours));
      for (const spec of specs) {
        const pairs = regimeSignalPairs(spec, L.series, horizonBars);
        if (pairs.length < FOLDS) continue;
        const rawSharpe = sharpeStats(pairs.map((p) => Math.sign(p.signal) * p.forwardReturn)).sharpe;
        pending.push({ symbol: L.symbol, spec, fwdHours: fh, horizonBars, pairs, rawSharpe });
      }
    }
  }
  const TRIALS = pending.length;
  const SIGMA_SR = std(pending.map((p) => p.rawSharpe).filter(Number.isFinite));
  console.log(dim(`\ntrials (symbol × signal × horizon) = ${TRIALS} · σ_SR = ${r3(SIGMA_SR)} (deflation scale)\n`));

  const trials: Trial[] = pending.map((p) => {
    const report = oosForwardReturnIc(p.pairs, p.horizonBars, { folds: FOLDS, embargoFrac: EMBARGO_FRAC, trials: TRIALS, sigmaSR: SIGMA_SR });
    return { symbol: p.symbol, spec: p.spec, fwdHours: p.fwdHours, report, verdict: verdictFor(report) };
  });

  // ── Collapse to ONE best-signal row per symbol → the board ──────────────────
  const bySymbol = new Map<string, Trial[]>();
  for (const t of trials) (bySymbol.get(t.symbol) ?? bySymbol.set(t.symbol, []).get(t.symbol)!).push(t);

  interface Row { symbol: string; signal: string; fwdHours: number; oosIc: number; hitRate: number; dsr: number; psr: number; verdict: BiasVerdict; convCap: number; eligible: boolean; }
  const rows: Row[] = [];
  for (const [symbol, ts] of bySymbol) {
    const best = bestForSymbol(ts);
    if (!best) continue;
    const eligible = best.verdict === 'VALIDATED';
    rows.push({
      symbol,
      signal: `${best.spec.name} ${best.fwdHours}h`,
      fwdHours: best.fwdHours,
      oosIc: best.report.spearmanIc,
      hitRate: best.report.hitRate,
      dsr: best.report.deflated.dsr,
      psr: best.report.deflated.psr,
      verdict: best.verdict,
      convCap: eligible ? biasMagnitudeCap(best.report.spearmanIc) : 0,
      eligible,
    });
  }
  rows.sort((a, b) => b.oosIc - a.oosIc);

  // ── Print the board ─────────────────────────────────────────────────────────
  const W = { sym: 7, sig: 28, ic: 9, hit: 6, dsr: 6, verdict: 15, cap: 9, elig: 8 };
  const pad = (s: string, n: number) => s.padEnd(n);
  const padL = (s: string, n: number) => s.padStart(n);
  console.log(bold(
    pad('SYMBOL', W.sym) + pad('BEST SIGNAL', W.sig) + padL('OOS IC', W.ic) + padL('HIT%', W.hit) +
    padL('DSR', W.dsr) + '  ' + pad('VERDICT', W.verdict) + padL('CONV CAP', W.cap) + '  ' + pad('ELIGIBLE', W.elig),
  ));
  console.log(dim('─'.repeat(W.sym + W.sig + W.ic + W.hit + W.dsr + 2 + W.verdict + W.cap + 2 + W.elig)));
  for (const r of rows) {
    const col = verdictColor(r.verdict);
    const eligCell = r.eligible ? green('✅ yes') : red('⛔ no');
    console.log(
      pad(r.symbol, W.sym) +
      pad(r.signal, W.sig) +
      padL(signed(r.oosIc), W.ic) +
      padL(pctI(r.hitRate), W.hit) +
      padL(r3(r.dsr, 2), W.dsr) + '  ' +
      col(pad(r.verdict, W.verdict)) +
      padL(r.eligible ? r.convCap.toFixed(2) : '—', W.cap) + '  ' +
      eligCell,
    );
  }

  const eligible = rows.filter((r) => r.eligible);
  console.log('');
  if (eligible.length) {
    console.log(green(bold(`  ${eligible.length}/${rows.length} symbols ELIGIBLE today: ${eligible.map((r) => r.symbol).join(', ')}`)));
    console.log(dim(`  Live book trades ONLY these, conviction-capped to CONV CAP, stopped at the directional stop.`));
  } else {
    console.log(amber(bold(`  0/${rows.length} symbols validated this window — the desk trades NOTHING today.`)));
    console.log(dim(`  That is the correct outcome, not a failure (CLAUDE.md §1). Re-gate before every session — regimes shift.`));
  }

  // ── Pre-registered success metric + exact re-run command ─────────────────────
  console.log(bold(`\n  PRE-REGISTERED SUCCESS METRIC (the forward-paper run, S6):`));
  console.log(`    A symbol is ELIGIBLE iff its best signal's deflated Sharpe ≥ 0.95 OOS (after the ${TRIALS}-trial haircut)`);
  console.log(`    AND a positive rank IC. The live book, run on the eligible set, must show REALISED P&L (incl. funding,`);
  console.log(`    net of fees) > 0 with maxDD inside the desk's 2% budget. Judge realised-first, never unrealised marks.`);
  console.log(dim(`\n  Legend: OOS IC = pooled OOS Spearman rank IC · HIT% = sign-match rate · DSR = deflated Sharpe (≥0.95 ⇒ VALIDATED) ·`));
  console.log(dim(`          CONV CAP = conviction magnitude cap (4·|IC|, ≤0.5) the live book sizes inside.`));
  console.log(dim(`\n  Re-run (regimes shift — re-gate every session):`));
  console.log(dim(`    RBO_SOURCE=${SOURCE} RBO_DAYS=${DAYS} RBO_INTERVAL=${INTERVAL} RBO_SYMBOLS=${SYMBOLS.join(',')} \\`));
  console.log(dim(`      npx ts-node -r tsconfig-paths/register scripts/regime-bias-oos.ts`));

  // ── Compact JSON board for the live runner (S3) ─────────────────────────────
  const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const outPath = join('docs', 'research', `${ts}-regime-validated-board-${SOURCE}.json`);
  writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(), source: SOURCE, days: DAYS, interval: INTERVAL,
    fwdHours: FWD_HOURS, momLookbackHours: MOM_LOOKBACK_HOURS, fundingWindowHours: FUNDING_WINDOW_HOURS,
    folds: FOLDS, embargoFrac: EMBARGO_FRAC, trials: TRIALS, sigmaSR: SIGMA_SR,
    eligibleSymbols: eligible.map((r) => r.symbol),
    board: rows,
  }, null, 2));
  console.log(dim(`\n  wrote ${outPath}`));
  console.log(green('\nREGIME-BIAS-OOS OK\n'));
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  let v = 0;
  for (const x of xs) v += (x - mean) ** 2;
  return Math.sqrt(v / (xs.length - 1));
}

main().catch((e) => {
  console.error('\nREGIME-BIAS-OOS FAIL:', e?.message ?? e);
  process.exit(1);
});
