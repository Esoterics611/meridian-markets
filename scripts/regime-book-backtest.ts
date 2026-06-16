/**
 * regime-book-backtest — P8 of the "take sides" build (Playbook II). The book-level
 * WALK-FORWARD backtest: it proves the BOOK (gate→consensus→size→stop→fees→funding→slippage)
 * makes money after costs on out-of-sample history — distinct from, and stricter than, the
 * signal's IC gate (P2). It replays the EXACT live logic via the shared pure engine
 * (src/market-making/directional/regime-backtest.ts), so backtest and live are one code path.
 *
 * WALK-FORWARD (no look-ahead): the gate is re-fit on a trailing TRAIN window and used to trade
 * the next TEST window, rolling forward. At each bar the consensus + monitor see only past data
 * (the engine hands the signal bars[0..i]). A window where nothing validates trades NOTHING.
 *
 * Output: a realised-first scorecard per symbol + desk (realised+funding−fees−slippage, maxDD,
 * #entries/#stops, hit rate, exposure, the per-trade Sharpe + the DEFLATED Sharpe over the grid),
 * plus a JSON artifact. The pre-registered bar: a book is "validated" only if its walk-forward
 * realised P&L is positive, its per-trade PSR clears 0, AND maxDD stays inside the budget.
 *
 * Paper-only, DB-free, no API key — real HL public candles + funding.
 *
 * Run:  RBT_SYMBOLS=BTC,ETH,SOL RBT_DAYS=180 npx ts-node -r tsconfig-paths/register scripts/regime-book-backtest.ts
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Bar } from '../src/stat-arb/backtest/bar';
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';
import { HyperliquidFundingClient } from '../src/market-data/funding/hyperliquid-funding-client';
import { FundingPoint } from '../src/market-data/funding/funding-source.interface';
import { RegimeSeries, defaultRegimeSignalSpecs } from '../src/market-making/directional/regime-signals';
import { scoreRegimeBoard, validatedSignalsPerSymbol, LoadedSeries } from '../src/market-making/directional/regime-board';
import { replayRegimeBook, BacktestBar, RegimeReplayResult } from '../src/market-making/directional/regime-backtest';
import { RegimeMonitor } from '../src/market-making/directional/regime-monitor';
import { ConsensusBiasSource } from '../src/market-making/directional/consensus-bias-source';
import { FundingBiasSource } from '../src/market-making/bias/funding-bias-source';
import { MomentumBiasSource } from '../src/market-making/bias/momentum-bias-source';
import { IBiasSource } from '../src/market-making/bias/bias-source.interface';
import { SlippageImpactModel, NoSlippageModel, FillCostModel } from '../src/market-making/directional/fill-cost-model';
import { sharpeStats, deflatedSharpe } from '../src/stat-arb/research/deflated-sharpe';

// ── Config ──────────────────────────────────────────────────────────────────
const SYMBOLS = (process.env.RBT_SYMBOLS ?? 'BTC,ETH,SOL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const DAYS = Number(process.env.RBT_DAYS ?? 180);
const INTERVAL = process.env.RBT_INTERVAL ?? '1h';
const TRAIN_BARS = Number(process.env.RBT_TRAIN_BARS ?? 24 * 30); // 30d train
const TEST_BARS = Number(process.env.RBT_TEST_BARS ?? 24 * 7); // 7d test, rolled
const FOLDS = Number(process.env.RBT_FOLDS ?? 5);
const EMBARGO_FRAC = Number(process.env.RBT_EMBARGO_FRAC ?? 0.01);
const FWD_HOURS = (process.env.RBT_FWD_HOURS ?? '8,24,72').split(',').map(Number).filter((h) => h > 0);
const MOM_LOOKBACK_HOURS = (process.env.RBT_MOM_LOOKBACK_HOURS ?? '24,72').split(',').map(Number).filter((h) => h > 0);
const FUNDING_WINDOW_HOURS = Number(process.env.RBT_FUNDING_WINDOW_HOURS ?? 24);

const BASE_NOTIONAL_USD = Number(process.env.RBT_BASE_NOTIONAL_USD ?? 50_000);
const STOP_FRAC = Number(process.env.RBT_STOP_FRAC ?? 0.02);
const B_ENTER = Number(process.env.RBT_BENTER ?? 0.15);
const B_EXIT = Number(process.env.RBT_BEXIT ?? 0.07);
const TAKER_FEE_BPS = Number(process.env.RBT_TAKER_FEE_BPS ?? 4.5);
const SLIPPAGE_BPS = Number(process.env.RBT_SLIPPAGE_BPS ?? 1.0); // honest by default in backtest
const IMPACT_BPS_PER_MM = Number(process.env.RBT_IMPACT_BPS_PER_MM ?? 5.0);
const MIN_AGREE = Number(process.env.RBT_MIN_AGREE ?? 1);
const FUNDING_FULL_RATE = Number(process.env.RBT_FUNDING_FULL_RATE ?? 1.25e-5);
const MOM_FULL_RETURN = Number(process.env.RBT_MOM_FULL_RETURN ?? 0.05);
const DD_BUDGET_FRAC = Number(process.env.RBT_DD_BUDGET_FRAC ?? 0.02);
const OUT_DIR = process.env.RBT_OUT_DIR ?? 'docs/research';

const ivHours = (() => {
  const m = /^(\d+)([mhd])$/.exec(INTERVAL.trim());
  if (!m) return 1;
  const n = Number(m[1]);
  return m[2] === 'h' ? n : m[2] === 'd' ? n * 24 : n / 60;
})();
const FUNDING_WINDOW_BARS = Math.max(1, Math.round(FUNDING_WINDOW_HOURS / ivHours));
const RET_LOOKBACK_BARS = Math.max(...MOM_LOOKBACK_HOURS.map((h) => Math.round(h / ivHours)), 80);

// ── ANSI ──────────────────────────────────────────────────────────────────────
const USE_COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (c: string, s: string) => (USE_COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const green = (s: string) => wrap('32', s);
const red = (s: string) => wrap('31', s);
const dim = (s: string) => wrap('2', s);
const bold = (s: string) => wrap('1', s);
const cyan = (s: string) => wrap('36', s);
const MICROS = 1_000_000;
const usd = (u: bigint) => `${Number(u) / MICROS >= 0 ? '+' : '−'}$${Math.abs(Number(u) / MICROS).toFixed(2)}`;

async function fetchSeries(sym: string, fromMs: number, toMs: number): Promise<{ bars: Bar[]; funding: FundingPoint[] } | null> {
  const wantBars = Math.ceil((DAYS * 24) / ivHours) + 16;
  try {
    const bars = (await new HyperliquidClient().klines(sym, INTERVAL, wantBars)).filter((b) => b.timestamp.getTime() >= fromMs);
    const funding = await new HyperliquidFundingClient().fundingHistory(sym, fromMs, toMs).catch(() => [] as FundingPoint[]);
    return bars.length ? { bars, funding } : null;
  } catch (e) {
    process.stdout.write(`  ${sym}: ERR(${(e as Error).message.slice(0, 48)})\n`);
    return null;
  }
}

/** A consensus over the symbol's currently-validated signals (null ⇒ nothing validated ⇒ flat). */
function buildConsensus(validated: { kind: string; lookbackBars?: number }[]): ConsensusBiasSource | null {
  const sources: IBiasSource[] = [];
  for (const v of validated) {
    if (v.kind === 'funding-paid-side') sources.push(new FundingBiasSource({ fullBiasRatePerHour: FUNDING_FULL_RATE, validated: true }));
    else if (v.kind === 'momentum') sources.push(new MomentumBiasSource({ fullBiasReturn: MOM_FULL_RETURN, lookback: v.lookbackBars, validated: true }));
  }
  if (!sources.length) return null;
  return new ConsensusBiasSource(sources, { minAgree: MIN_AGREE });
}

/** Re-gate the symbol on a trailing TRAIN slice; return the validated signal set + max IC. */
function gateWindow(sym: string, full: RegimeSeries, fromIdx: number, toIdx: number): { validated: { kind: string; lookbackBars?: number }[]; ic: number } {
  const prices = full.prices.slice(fromIdx, toIdx);
  const barTimesMs = full.barTimesMs.slice(fromIdx, toIdx);
  const t0 = barTimesMs[0];
  const t1 = barTimesMs[barTimesMs.length - 1];
  const funding = full.funding.filter((f) => f.fundingTimeMs >= t0 && f.fundingTimeMs <= t1);
  const series: RegimeSeries = { prices, barTimesMs, funding };
  const loaded: LoadedSeries[] = [{ symbol: sym, series }];
  const specs = defaultRegimeSignalSpecs({ intervalHours: ivHours, momentumLookbackHours: MOM_LOOKBACK_HOURS, fundingWindowHours: [FUNDING_WINDOW_HOURS] });
  try {
    const board = scoreRegimeBoard(loaded, specs, { fwdHours: FWD_HOURS, ivHours, folds: FOLDS, embargoFrac: EMBARGO_FRAC });
    const vset = (validatedSignalsPerSymbol(board).get(sym) ?? []).map((t) => ({ kind: t.spec.kind, lookbackBars: t.spec.lookbackBars }));
    const ic = vset.length ? Math.max(...(validatedSignalsPerSymbol(board).get(sym) ?? []).map((t) => t.oosIc)) : 0;
    return { validated: vset, ic };
  } catch {
    return { validated: [], ic: 0 };
  }
}

interface SymbolResult {
  symbol: string;
  result: RegimeReplayResult;
  regates: number;
  windowsValidated: number;
}

function walkForward(sym: string, bars: Bar[], funding: FundingPoint[], fillModel: FillCostModel): SymbolResult | null {
  if (bars.length < TRAIN_BARS + TEST_BARS) return null;
  const closes = bars.map((b) => b.close);
  const times = bars.map((b) => b.timestamp.getTime());
  const full: RegimeSeries = { prices: closes, barTimesMs: times, funding };

  // Per-bar instantaneous funding rate/hour (forward-fill the nearest funding point ≤ bar).
  const fundByBar: number[] = new Array(bars.length).fill(0);
  let fi = 0;
  const sortedF = [...funding].sort((a, b) => a.fundingTimeMs - b.fundingTimeMs);
  for (let i = 0; i < bars.length; i++) {
    while (fi + 1 < sortedF.length && sortedF[fi + 1].fundingTimeMs <= times[i]) fi++;
    fundByBar[i] = sortedF.length ? sortedF[fi].fundingRate : 0;
  }

  // Walk-forward gate generations: re-gate every TEST_BARS using the trailing TRAIN_BARS.
  // gateForBar[i] holds the consensus active at bar i (null until the first train window completes).
  let regates = 0;
  let windowsValidated = 0;
  const gateAt: ({ consensus: ConsensusBiasSource | null; ic: number } | null)[] = new Array(bars.length).fill(null);
  for (let start = TRAIN_BARS; start < bars.length; start += TEST_BARS) {
    const g = gateWindow(sym, full, start - TRAIN_BARS, start);
    regates++;
    if (g.validated.length) windowsValidated++;
    const consensus = buildConsensus(g.validated);
    const end = Math.min(bars.length, start + TEST_BARS);
    for (let i = start; i < end; i++) gateAt[i] = { consensus, ic: g.ic };
  }

  const monitor = new RegimeMonitor(sym);
  const bbars: BacktestBar[] = bars.map((b, i) => ({ tMs: times[i], close: b.close, fundingRatePerHour: fundByBar[i] }));

  const result = replayRegimeBook(
    bbars,
    { baseNotionalUsd: BASE_NOTIONAL_USD, bEnter: B_ENTER, bExit: B_EXIT, stopFrac: STOP_FRAC, takerFeeBps: TAKER_FEE_BPS, fillModel, book: sym, source: 'regime-backtest' },
    (i, window) => {
      const gate = gateAt[i];
      const cur = window[window.length - 1];
      // trailing funding mean (what the signal validated on) + recent log returns from the window.
      const f0 = Math.max(0, window.length - FUNDING_WINDOW_BARS);
      let fSum = 0;
      for (let k = f0; k < window.length; k++) fSum += window[k].fundingRatePerHour ?? 0;
      const trailFund = fSum / Math.max(1, window.length - f0);
      const r0 = Math.max(1, window.length - RET_LOOKBACK_BARS);
      const recentReturns: number[] = [];
      for (let k = r0; k < window.length; k++) recentReturns.push(Math.log(window[k].close / window[k - 1].close));
      const ret = recentReturns.length ? recentReturns[recentReturns.length - 1] : 0;
      const state = monitor.update({ nowMs: cur.tMs, fundingRatePerHour: trailFund, basisBps: undefined, ret });
      if (!gate || !gate.consensus) return { reading: { bias: 0, validated: true, reason: 'no gate / window unvalidated' }, standAside: state.standAside };
      const reading = gate.consensus.bias(sym, { fundingRatePerHour: trailFund, recentReturns, nowMs: cur.tMs, midMicros: BigInt(Math.round(cur.close * MICROS)) });
      return { reading, ic: gate.ic, standAside: state.standAside };
    },
  );
  return { symbol: sym, result, regates, windowsValidated };
}

function printRow(sr: SymbolResult): { sharpe: number; validated: boolean } {
  const r = sr.result;
  const realised = r.realisedUnits;
  const stats = sharpeStats(r.perTradePnlUsd);
  const ddOk = r.maxDrawdownFrac <= DD_BUDGET_FRAC;
  const positive = Number(realised) > 0;
  const sharpePositive = stats.sharpe > 0 && r.perTradePnlUsd.length >= 2;
  const validated = positive && sharpePositive && ddOk;
  const tag = validated ? green('✅ BOOK-VALIDATED') : red('⛔ not validated');
  console.log(
    `  ${sr.symbol.padEnd(5)} realised ${(realised >= 0n ? green : red)(usd(realised))}  ` +
    `(fees ${usd(-r.feesUnits)} funding ${usd(r.fundingUnits)} slip ${usd(-r.slippageUnits)})  ` +
    `maxDD ${red((r.maxDrawdownFrac * 100).toFixed(2) + '%')}  trades ${r.closes} (hit ${(r.hitRate * 100).toFixed(0)}%)  ` +
    `stops ${r.stops}  expo ${(r.exposureFrac * 100).toFixed(0)}%  SR ${stats.sharpe.toFixed(2)}  ${tag}`,
  );
  console.log(dim(`        re-gates ${sr.regates} (${sr.windowsValidated} validated windows)  ·  entries ${r.entries}`));
  return { sharpe: stats.sharpe, validated };
}

async function main() {
  console.log(bold(cyan(`\n=== REGIME BOOK BACKTEST · walk-forward · ${DAYS}d × ${INTERVAL} · train ${TRAIN_BARS} / test ${TEST_BARS} bars ===`)));
  console.log(dim(`universe: ${SYMBOLS.join(', ')}  ·  base $${BASE_NOTIONAL_USD.toLocaleString('en-US')}/book  ·  stop ${(STOP_FRAC * 100).toFixed(1)}%  ·  slippage ${SLIPPAGE_BPS}bps + impact ${IMPACT_BPS_PER_MM}bps/$1M\n`));

  const fillModel: FillCostModel = SLIPPAGE_BPS > 0 || IMPACT_BPS_PER_MM > 0 ? new SlippageImpactModel({ halfSpreadBps: SLIPPAGE_BPS, impactBpsPerMillionUsd: IMPACT_BPS_PER_MM }) : new NoSlippageModel();
  const toMs = Date.now();
  const fromMs = toMs - DAYS * 86_400_000;

  const results: SymbolResult[] = [];
  for (const sym of SYMBOLS) {
    process.stdout.write(`backtesting ${sym}… `);
    const got = await fetchSeries(sym, fromMs, toMs);
    if (!got) { process.stdout.write('no data\n'); continue; }
    const sr = walkForward(sym, got.bars, got.funding, fillModel);
    if (!sr) { process.stdout.write('insufficient bars\n'); continue; }
    process.stdout.write(`${got.bars.length} bars\n`);
    results.push(sr);
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!results.length) { console.log('\nNo symbols backtested — likely no network. Re-run on a networked host.'); return; }

  console.log(bold(`\nWALK-FORWARD SCORECARD (realised-first, out-of-sample):`));
  // Multiple-testing haircut: deflate the BEST per-trade Sharpe over the grid of books tried.
  const perBookSharpe = results.map((sr) => sharpeStats(sr.result.perTradePnlUsd).sharpe);
  const meanSR = perBookSharpe.reduce((a, b) => a + b, 0) / perBookSharpe.length;
  const sigmaSR = Math.sqrt(perBookSharpe.reduce((a, b) => a + (b - meanSR) ** 2, 0) / Math.max(1, perBookSharpe.length - 1)) || 0.1;
  const rows = results.map(printRow);

  // Desk aggregate.
  let deskRealised = 0n, deskFunding = 0n, deskFees = 0n, deskSlip = 0n;
  const deskTrades: number[] = [];
  for (const sr of results) {
    deskRealised += sr.result.realisedUnits; deskFunding += sr.result.fundingUnits; deskFees += sr.result.feesUnits; deskSlip += sr.result.slippageUnits;
    deskTrades.push(...sr.result.perTradePnlUsd);
  }
  const deskStats = sharpeStats(deskTrades);
  const deskDeflated = deflatedSharpe(deskStats.sharpe, deskStats.n, deskStats.skew, deskStats.kurtosis, Math.max(1, results.length), sigmaSR);
  console.log(
    `\n  DESK realised ${(deskRealised >= 0n ? green : red)(bold(usd(deskRealised)))}  ` +
    `(fees ${usd(-deskFees)} funding ${usd(deskFunding)} slip ${usd(-deskSlip)})  ` +
    `trades ${deskTrades.length}  SR ${deskStats.sharpe.toFixed(2)}  PSR ${deskDeflated.psr.toFixed(2)}  DSR ${deskDeflated.dsr.toFixed(2)}`,
  );
  const nValidated = rows.filter((r) => r.validated).length;
  console.log(dim(`\n  PRE-REGISTERED BAR: a book is validated only if walk-forward realised > 0 AND per-trade Sharpe > 0 AND maxDD ≤ ${(DD_BUDGET_FRAC * 100).toFixed(1)}%.`));
  console.log((nValidated > 0 ? green : red)(bold(`  ${nValidated}/${results.length} books cleared the book-level bar.`)));

  // JSON artifact.
  const artifact = {
    generatedAt: new Date().toISOString(),
    config: { symbols: SYMBOLS, days: DAYS, interval: INTERVAL, trainBars: TRAIN_BARS, testBars: TEST_BARS, baseNotionalUsd: BASE_NOTIONAL_USD, stopFrac: STOP_FRAC, slippageBps: SLIPPAGE_BPS, impactBpsPerMm: IMPACT_BPS_PER_MM, ddBudgetFrac: DD_BUDGET_FRAC },
    perSymbol: results.map((sr, i) => ({
      symbol: sr.symbol, regates: sr.regates, windowsValidated: sr.windowsValidated,
      realisedUsd: Number(sr.result.realisedUnits) / MICROS, feesUsd: Number(sr.result.feesUnits) / MICROS,
      fundingUsd: Number(sr.result.fundingUnits) / MICROS, slippageUsd: Number(sr.result.slippageUnits) / MICROS,
      maxDrawdownFrac: sr.result.maxDrawdownFrac, entries: sr.result.entries, stops: sr.result.stops,
      closes: sr.result.closes, hitRate: sr.result.hitRate, exposureFrac: sr.result.exposureFrac,
      sharpe: sharpeStats(sr.result.perTradePnlUsd).sharpe, validated: rows[i].validated,
    })),
    desk: { realisedUsd: Number(deskRealised) / MICROS, fundingUsd: Number(deskFunding) / MICROS, feesUsd: Number(deskFees) / MICROS, slippageUsd: Number(deskSlip) / MICROS, trades: deskTrades.length, sharpe: deskStats.sharpe, psr: deskDeflated.psr, dsr: deskDeflated.dsr, sigmaSR, booksValidated: nValidated },
  };
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `regime-book-backtest-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(artifact, null, 2));
    console.log(dim(`\n  artifact: ${out}`));
  } catch (e) {
    console.log(dim(`\n  (artifact not written: ${(e as Error).message.slice(0, 40)})`));
  }
  console.log(green('\nREGIME-BOOK-BACKTEST OK\n'));
}

main().catch((e) => { console.error('\nREGIME-BOOK-BACKTEST FAIL:', e?.message ?? e); process.exit(1); });
