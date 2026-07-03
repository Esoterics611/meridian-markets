/**
 * carry-desk-live — THE CARRY DESK (PROFIT_PIVOT_II P0): the validated edge, running.
 *
 * Gate-first (90d OOS persistence + the #72 recency veto), then holds delta-neutral
 * funding-carry pairs (FundingCarryBook: long spot / short perp or the mirror) and
 * accrues funding TIME-WEIGHTED, for days — the 30-day forward track record IS the demo.
 *
 * Judged REALISED-FIRST: funding + realised − fees (never the basis mark). Honest by
 * construction: slippage on entry/exit, per-leg margin with forced liquidation, a
 * desk DD kill-switch, daily re-gate (a book that fails today's gate is CLOSED, not
 * ridden — the #72 rule), and durable persistence that RESUMES the held pair on
 * restart (carry is hold-past-breakeven; flatten-on-restart would pay the round-trip
 * fee every reboot). On resume the offline gap is accrued from the venue's ACTUAL
 * settled funding history, not an estimate.
 *
 * Run (operator):
 *   npm run migration:run                # once, if MM_PERSIST
 *   MM_PERSIST=true npx ts-node -r tsconfig-paths/register scripts/carry-desk-live.ts
 *
 * MAKER ENTRY (P1/E2, default ON): patient entries/exits rest post-only at the touch
 * (Binance bookTicker / HL L2 best) and escalate to a cross only after CD_MAKER_PATIENCE_S
 * — killing the 14bps taker round trip that was the whole breakeven story (#72). Every
 * leg logs its TCA (maker/taker, waited, signed shortfall vs arrival mid). Urgent paths
 * (margin liquidation, DD kill-switch) never wait.
 *
 * Knobs: CD_SYMBOLS CD_GATE_DAYS CD_MIN_POS_FRAC CD_RECENCY_DAYS CD_NOTIONAL_USD
 *        CD_MAX_LEGS CD_POLL_MS CD_HOURS(0=indefinite) CD_SPOT_FEE_BPS CD_PERP_FEE_BPS
 *        CD_SLIPPAGE_BPS CD_IMPACT_BPS_PER_MM CD_MAX_LEVERAGE CD_MAINT_FRAC
 *        CD_REGATE_HOURS CD_DD_BUDGET_FRAC CD_ALERT_WEBHOOK MM_PERSIST DATABASE_URL_APP
 *        CD_MAX_BASIS_PCT(5 — the #92 ticker-collision guard on every entry/resume)
 *        CD_MAKER_ENTRY(true) CD_MAKER_PATIENCE_S(45) CD_MAKER_TICK_MS(2000)
 *        CD_SPOT_MAKER_FEE_BPS(1 = Binance spot maker) CD_PERP_MAKER_FEE_BPS(−0.2 = HL rebate)
 */
import { DataSource } from 'typeorm';
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';
import { CrossVenueFairValue } from '../src/market-data/cross-venue/cross-venue-fair-value';
import { HyperliquidFundingClient, HYPERLIQUID_PERIODS_PER_YEAR } from '../src/market-data/funding/hyperliquid-funding-client';
import { rankCarryUniverse, OosFundingResult, OosGateConfig } from '../src/market-data/funding/funding-carry-oos';
import { checkSameUnderlyingBasis, DEFAULT_MAX_BASIS_PCT, isKScaledCoin } from '../src/market-data/funding/cross-venue-symbol-match';
import { FundingPoint } from '../src/market-data/funding/funding-source.interface';
import { FundingCarryBook, LegExecution } from '../src/market-making/carry/funding-carry-book';
import { acquireFill, ExecutedFill, TouchSource } from '../src/market-making/execution/maker-execution';
import { venueFeeFor } from '../src/market-making/backtest/venue-fees';
import {
  CarryNavInsert,
  ICarryStateStore,
  NullCarryStateStore,
  reconcileCarryResume,
} from '../src/market-making/carry/carry-state-store';
import { PostgresCarryStateStore } from '../src/market-making/carry/postgres-carry-state-store';
import { NoSlippageModel, SlippageImpactModel } from '../src/market-making/directional/fill-cost-model';
import { AlertDispatcher, buildAlertSink } from '../src/market-making/directional/feed-watchdog';
import { computeTearsheet, EquityPoint, BenchPoint } from '../src/market-making/directional/regime-tearsheet';

// ── Knobs ────────────────────────────────────────────────────────────────────────
const SYMBOLS = (process.env.CD_SYMBOLS ?? 'BTC,ETH,SOL,BNB,XRP,DOGE,ADA,XMR,LINK,AVAX')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const GATE_DAYS = Number(process.env.CD_GATE_DAYS ?? 90);
const MIN_POS_FRAC = Number(process.env.CD_MIN_POS_FRAC ?? 0.65);
const RECENCY_DAYS = Number(process.env.CD_RECENCY_DAYS ?? 7);
const NOTIONAL_USD = Number(process.env.CD_NOTIONAL_USD ?? 50_000);
const MAX_LEGS = Number(process.env.CD_MAX_LEGS ?? 8);
const POLL_MS = Number(process.env.CD_POLL_MS ?? 60_000);
const RUN_HOURS = Number(process.env.CD_HOURS ?? 0); // 0 = run until Ctrl-C
const SPOT_FEE_BPS = Number(process.env.CD_SPOT_FEE_BPS ?? 4.5);
const PERP_FEE_BPS = Number(process.env.CD_PERP_FEE_BPS ?? 2.5);
const SLIPPAGE_BPS = Number(process.env.CD_SLIPPAGE_BPS ?? 1);
const IMPACT_BPS_PER_MM = Number(process.env.CD_IMPACT_BPS_PER_MM ?? 0);
const MAX_LEVERAGE = Number(process.env.CD_MAX_LEVERAGE ?? 3);
const MAINT_FRAC = Number(process.env.CD_MAINT_FRAC ?? 0.8);
const REGATE_HOURS = Number(process.env.CD_REGATE_HOURS ?? 24);
const DD_BUDGET_FRAC = Number(process.env.CD_DD_BUDGET_FRAC ?? 0.005); // the P0 pre-registered 0.5%
const MAKER_ENTRY = (process.env.CD_MAKER_ENTRY ?? 'true').toLowerCase() === 'true';
const MAKER_PATIENCE_S = Number(process.env.CD_MAKER_PATIENCE_S ?? 45);
const MAKER_TICK_MS = Number(process.env.CD_MAKER_TICK_MS ?? 2_000);
const SPOT_MAKER_FEE_BPS = Number(process.env.CD_SPOT_MAKER_FEE_BPS ?? venueFeeFor('binance').makerBps);
const PERP_MAKER_FEE_BPS = Number(process.env.CD_PERP_MAKER_FEE_BPS ?? venueFeeFor('hyperliquid').makerBps);
const MAX_BASIS_PCT = Number(process.env.CD_MAX_BASIS_PCT ?? DEFAULT_MAX_BASIS_PCT);
const PERSIST = (process.env.MM_PERSIST ?? 'false').toLowerCase() === 'true';
const DATABASE_URL_APP =
  process.env.DATABASE_URL_APP ?? 'postgresql://meridian_markets_app:meridian_markets_app@localhost:5433/meridian_markets';

const HOUR_MS = 3_600_000;
const DESK_CAPITAL_USD = MAX_LEGS * 2 * NOTIONAL_USD; // both legs, fully collateralised (no leverage flattering)
const usd = (units: bigint): string => `${Number(units) / 1e6 >= 0 ? '+' : ''}${(Number(units) / 1e6).toFixed(2)}`;
const pct = (x: number, d = 1): string => `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`;
const micros = (px: number): bigint => BigInt(Math.round(px * 1e6));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Wiring ───────────────────────────────────────────────────────────────────────
const binance = new BinancePublicClient({ quote: 'USDT' });
const hl = new HyperliquidClient();
const fv = new CrossVenueFairValue(binance, hl);
const fund = new HyperliquidFundingClient();
const alerts = new AlertDispatcher(buildAlertSink(process.env.CD_ALERT_WEBHOOK));
const fillModel = SLIPPAGE_BPS > 0 || IMPACT_BPS_PER_MM > 0
  ? new SlippageImpactModel({ halfSpreadBps: SLIPPAGE_BPS, impactBpsPerMillionUsd: IMPACT_BPS_PER_MM })
  : new NoSlippageModel();

interface LiveBook {
  symbol: string;
  gate: OosFundingResult;
  book: FundingCarryBook;
  entryMs: number | null;
  lastRatePerHour: number;
  lastSpotMid: bigint;
  lastPerpMid: bigint;
  stale: boolean;
}

const books = new Map<string, LiveBook>();
const gateCfg: OosGateConfig = {
  periodsPerYear: HYPERLIQUID_PERIODS_PER_YEAR,
  spotFeeBps: SPOT_FEE_BPS,
  perpFeeBps: PERP_FEE_BPS,
  notionalUnits: BigInt(Math.round(NOTIONAL_USD * 1_000_000)),
  minPosFrac: MIN_POS_FRAC,
  recencyDays: RECENCY_DAYS,
};

function newBook(symbol: string, direction: 'SHORT_PERP' | 'LONG_PERP'): FundingCarryBook {
  return new FundingCarryBook({
    symbol,
    direction,
    notionalUsd: NOTIONAL_USD,
    spotFeeBps: SPOT_FEE_BPS,
    perpFeeBps: PERP_FEE_BPS,
    fundingPeriodMs: HOUR_MS,
    maxLeverage: MAX_LEVERAGE,
    maintenanceFrac: MAINT_FRAC,
    fillModel,
    onEvent: (e) => console.log(`  ${new Date(e.ts).toISOString().slice(11, 19)} ${e.message}`),
  });
}

// ── E2 maker execution (P1) ──────────────────────────────────────────────────────
const spotTouchFor = (symbol: string): TouchSource => async () => {
  const t = await binance.bookTicker(symbol);
  return { bidMicros: micros(t.bidPrice), askMicros: micros(t.askPrice) };
};
const perpTouchFor = (symbol: string): TouchSource => async () => {
  const l2 = await hl.l2Snapshot(symbol);
  const bid = l2.bids[0];
  const ask = l2.asks[0];
  if (!bid || !ask) throw new Error(`${symbol}: empty HL book side`);
  return { bidMicros: bid.priceMicros, askMicros: ask.priceMicros };
};

const tca = (leg: string, f: ExecutedFill): string =>
  `${leg} ${f.liquidity}@${(Number(f.priceMicros) / 1e6).toFixed(4)} ` +
  `(${f.shortfallBps >= 0 ? '+' : ''}${f.shortfallBps.toFixed(2)}bps vs mid, fee ${f.feeBps}bps, waited ${(f.waitedMs / 1000).toFixed(0)}s)`;

/**
 * Open/close a pair through the maker-execution service (rest post-only, escalate on
 * timeout). Returns false when disabled or the touch cannot be fetched — the caller
 * falls back to the legacy mid-based taker path, so an outage degrades, never blocks.
 */
async function executePair(book: FundingCarryBook, symbol: string, direction: 'SHORT_PERP' | 'LONG_PERP', action: 'open' | 'close'): Promise<boolean> {
  if (!MAKER_ENTRY) return false;
  const opening = action === 'open';
  const spotSide = (direction === 'SHORT_PERP') === opening ? 'BUY' : 'SELL';
  const perpSide = spotSide === 'BUY' ? 'SELL' : 'BUY';
  try {
    const patienceMs = MAKER_PATIENCE_S * 1000;
    const [spotFill, perpFill] = await Promise.all([
      acquireFill(spotSide, spotTouchFor(symbol), { patienceMs, tickMs: MAKER_TICK_MS, makerFeeBps: SPOT_MAKER_FEE_BPS, takerFeeBps: SPOT_FEE_BPS }),
      acquireFill(perpSide, perpTouchFor(symbol), { patienceMs, tickMs: MAKER_TICK_MS, makerFeeBps: PERP_MAKER_FEE_BPS, takerFeeBps: PERP_FEE_BPS }),
    ]);
    const spotExec: LegExecution = { priceMicros: spotFill.priceMicros, feeBps: spotFill.feeBps, midMicros: spotFill.arrivalMidMicros };
    const perpExec: LegExecution = { priceMicros: perpFill.priceMicros, feeBps: perpFill.feeBps, midMicros: perpFill.arrivalMidMicros };
    if (opening) book.openWithExecutions(Date.now(), spotExec, perpExec);
    else book.closeWithExecutions(Date.now(), spotExec, perpExec);
    console.log(`  ${symbol}: ${action} TCA — ${tca('spot', spotFill)} | ${tca('perp', perpFill)}`);
    return true;
  } catch (e) {
    console.log(`  ${symbol}: maker-execution ${action} unavailable (${(e as Error).message}) — falling back to taker at mid`);
    return false;
  }
}

/**
 * #92 ticker-collision guard, runner side: two venues listing the same ticker is NOT
 * evidence they list the same asset (HL "LIT" = Lighter vs Binance "LITUSDT" =
 * Litentry, 177% apart at entry). A genuine perp/spot pair trades within a few % —
 * that gap IS the basis funding exists to bound — so beyond CD_MAX_BASIS_PCT the
 * "pair" is two different tokens and the book would be a naked cross-asset bet.
 * This guards ALL entry paths (manual CD_SYMBOLS included), independent of the scan.
 */
function basisGuard(symbol: string, spotMidMicros: bigint, perpMidMicros: bigint): boolean {
  const check = checkSameUnderlyingBasis(
    Number(perpMidMicros) / 1e6, Number(spotMidMicros) / 1e6, isKScaledCoin(symbol), MAX_BASIS_PCT,
  );
  if (!check.ok) {
    console.log(
      `  ⛔ ${symbol}: TICKER-COLLISION GUARD — cross-venue basis ${isFinite(check.basisPct) ? check.basisPct.toFixed(1) : 'NaN'}% ` +
      `exceeds ±${MAX_BASIS_PCT}% (the venues likely list DIFFERENT assets under this ticker — the #92 LIT case).`,
    );
    alerts.lossStop(symbol, `ticker-collision guard: cross-venue basis ${check.basisPct.toFixed(1)}% > ±${MAX_BASIS_PCT}%`);
  }
  return check.ok;
}

// ── Gate ─────────────────────────────────────────────────────────────────────────
async function runGate(symbols: string[]): Promise<OosFundingResult[]> {
  const endMs = Date.now();
  const startMs = endMs - GATE_DAYS * 86_400_000;
  const histories: { symbol: string; funding: FundingPoint[] }[] = [];
  for (const sym of symbols) {
    try {
      const hist = await fund.fundingHistory(sym, startMs, endMs);
      if (hist.length >= 6) histories.push({ symbol: sym, funding: hist });
      else console.log(`  ${sym}: only ${hist.length} settlements — skipped`);
    } catch (e) {
      console.log(`  ${sym}: history fetch failed — ${(e as Error).message}`);
    }
    await sleep(80);
  }
  return rankCarryUniverse(histories, gateCfg);
}

function printGateBoard(results: OosFundingResult[]): OosFundingResult[] {
  console.log(`\n  symbol   dir         fullFund%  recent7d%  breakeven  IS/OOS posFrac  GATE`);
  for (const r of results) {
    const gateTag = r.passGate ? '✅ PASS' : r.recent.vetoed ? '🚫 VETO(recent)' : '❌ fail';
    console.log(
      `  ${r.symbol.padEnd(7)}  ${r.direction.padEnd(10)}  ${pct(r.full.annualizedFundingPct).padStart(9)}  ` +
      `${pct(r.recent.annualizedFundingPct).padStart(9)}  ` +
      `${(isFinite(r.full.breakevenDays) ? r.full.breakevenDays.toFixed(1) + 'd' : '∞').padStart(9)}  ` +
      `${r.inSample.posFrac.toFixed(2)}/${r.oos.posFrac.toFixed(2)}`.padStart(14) + `  ${gateTag}`,
    );
  }
  const passers = results.filter((r) => r.passGate).slice(0, MAX_LEGS);
  console.log(`\n  ${results.filter((r) => r.passGate).length}/${results.length} pass; funding ${passers.length} legs (max ${MAX_LEGS}).`);
  return passers;
}

// ── Persistence ──────────────────────────────────────────────────────────────────
async function buildStore(): Promise<{ store: ICarryStateStore; ds: DataSource | null }> {
  if (!PERSIST) return { store: new NullCarryStateStore(), ds: null };
  try {
    const ds = new DataSource({
      type: 'postgres', url: DATABASE_URL_APP, entities: [], synchronize: false,
      connectTimeoutMS: 2500, extra: { connectionTimeoutMillis: 2500 },
    });
    await ds.initialize();
    return { store: new PostgresCarryStateStore(ds), ds };
  } catch (e) {
    console.log(`  ⚠ MM_PERSIST=true but the DB is unreachable (${(e as Error).message}) — running WITHOUT persistence.`);
    return { store: new NullCarryStateStore(), ds: null };
  }
}

/** Resume: accrue the offline gap from the venue's ACTUAL settled funding, not an estimate. */
async function accrueOfflineGap(lb: LiveBook, perpMarkMicros: bigint): Promise<void> {
  const state = lb.book.serializeState();
  const from = state.lastAccrualMs;
  if (from === null) return;
  const now = Date.now();
  if (now - from < HOUR_MS / 2) return; // sub-settlement gap — the live loop covers it
  try {
    const settlements = await fund.fundingHistory(lb.symbol, from, now);
    let accrued = 0n;
    for (const s of settlements) accrued += lb.book.accrueFunding(s.fundingTimeMs, s.fundingRate, perpMarkMicros);
    console.log(
      `  ${lb.symbol}: resumed — accrued ${usd(accrued)} over the ${((now - from) / HOUR_MS).toFixed(1)}h offline gap ` +
      `(${settlements.length} settled prints replayed)`,
    );
  } catch (e) {
    console.log(`  ${lb.symbol}: gap-accrual fetch failed (${(e as Error).message}) — gap accrues at the next live rate`);
  }
}

// ── The run ──────────────────────────────────────────────────────────────────────
let shuttingDown = false;

async function main(): Promise<void> {
  console.log(`\n=== CARRY DESK — live forward paper run (PROFIT_PIVOT_II P0) ===`);
  console.log(
    `  universe: ${SYMBOLS.join(',')} | gate ${GATE_DAYS}d posFrac≥${MIN_POS_FRAC} + ${RECENCY_DAYS}d recency veto | ` +
    `$${NOTIONAL_USD / 1000}k/leg × ≤${MAX_LEGS} legs | desk capital $${DESK_CAPITAL_USD / 1000}k`,
  );
  console.log(
    `  costs: spot ${SPOT_FEE_BPS}bps + perp ${PERP_FEE_BPS}bps taker, slippage ${SLIPPAGE_BPS}bps | ` +
    `margin ${MAX_LEVERAGE}×/maint ${MAINT_FRAC} | DD kill ${(DD_BUDGET_FRAC * 100).toFixed(2)}% | ` +
    `re-gate every ${REGATE_HOURS}h | persist ${PERSIST}`,
  );
  console.log(
    `  execution: ${MAKER_ENTRY
      ? `MAKER-FIRST (E2) — rest ≤${MAKER_PATIENCE_S}s at the touch (maker spot ${SPOT_MAKER_FEE_BPS} / perp ${PERP_MAKER_FEE_BPS}bps), escalate to taker on timeout; urgent closes never wait`
      : 'taker-at-mid (CD_MAKER_ENTRY=false)'}`,
  );
  console.log(`  PRE-REGISTERED (P0): rolling-7d (funding − fees + realised) > 0 AND desk maxDD < ${(DD_BUDGET_FRAC * 100).toFixed(1)}%.\n`);

  console.log(`Gate (${GATE_DAYS}d + recency veto)...`);
  let passers = printGateBoard(await runGate(SYMBOLS));
  if (passers.length === 0) {
    console.log(`\n  No symbol passes today. The honest move is to SIT — re-run tomorrow. (Exit 0.)`);
    process.exit(0);
  }

  const { store, ds } = await buildStore();

  // Boot reconciliation: resume held pairs still gated; orphan the rest (the #72 rule).
  const openRecords = await store.loadOpen();
  const plan = reconcileCarryResume(passers.map((r) => ({ symbol: r.symbol, direction: r.direction })), openRecords);
  for (const rec of plan.orphaned) {
    try {
      const snap = await fv.getBasis(rec.symbol);
      const b = newBook(rec.symbol, rec.direction);
      b.restoreState(rec.state);
      if (b.isOpen() && !(await executePair(b, rec.symbol, rec.direction, 'close'))) {
        b.close(Date.now(), micros(snap.binanceMid), micros(snap.hlMid));
      }
      const s = b.snapshot(micros(snap.binanceMid), micros(snap.hlMid));
      console.log(`  ${rec.symbol}: ORPHANED (fails today's gate) — closed at market, realised-first ${usd(s.realisedFirstUnits)}`);
      await store.saveBook({ ...rec, state: b.serializeState() });
      await store.closeBook(rec.symbol);
    } catch (e) {
      console.log(`  ${rec.symbol}: orphan close FAILED (${(e as Error).message}) — row left OPEN for the next boot`);
    }
  }

  for (const r of passers) {
    const resumed = plan.resume.find((x) => x.symbol.toUpperCase() === r.symbol.toUpperCase());
    try {
      const snap = await fv.getBasis(r.symbol);
      const spotMid = micros(snap.binanceMid);
      const perpMid = micros(snap.hlMid);
      if (spotMid <= 0n || perpMid <= 0n) throw new Error('bad mids');
      const lb: LiveBook = {
        symbol: r.symbol, gate: r, book: newBook(r.symbol, r.direction),
        entryMs: null, lastRatePerHour: 0, lastSpotMid: spotMid, lastPerpMid: perpMid, stale: false,
      };
      if (resumed) {
        lb.book.restoreState(resumed.state);
        lb.entryMs = resumed.entryMs;
        await accrueOfflineGap(lb, perpMid);
        if (!basisGuard(r.symbol, spotMid, perpMid)) {
          // The exact #92 LIT scenario: a held book whose two legs aren't the same
          // asset. Close it at market (honest funding already accrued above), never
          // carry it forward.
          if (lb.book.isOpen() && !(await executePair(lb.book, r.symbol, r.direction, 'close'))) {
            lb.book.close(Date.now(), spotMid, perpMid);
          }
          const s = lb.book.snapshot(spotMid, perpMid);
          console.log(`  ${r.symbol}: resumed book CLOSED by the collision guard — realised-first ${usd(s.realisedFirstUnits)}`);
          await checkpoint(store, lb);
          await store.closeBook(r.symbol);
        } else {
          books.set(r.symbol, lb);
          await checkpoint(store, lb);
        }
      } else if (basisGuard(r.symbol, spotMid, perpMid)) {
        if (!(await executePair(lb.book, r.symbol, r.direction, 'open'))) lb.book.open(Date.now(), spotMid, perpMid);
        lb.entryMs = Date.now();
        console.log(
          `  ${r.symbol}: OPEN ${r.direction === 'SHORT_PERP' ? 'long spot / SHORT perp' : 'short spot / LONG perp'} ` +
          `$${NOTIONAL_USD / 1000}k/leg — gross ${pct(r.full.annualizedFundingPct)} · recent7d ${pct(r.recent.annualizedFundingPct)} · ` +
          `breakeven ~${r.full.breakevenDays.toFixed(1)}d · basis ${snap.basisBps.toFixed(1)}bps`,
        );
        books.set(r.symbol, lb);
        await checkpoint(store, lb);
      }
    } catch (e) {
      console.log(`  ${r.symbol}: open failed — ${(e as Error).message} (skipped)`);
    }
    await sleep(150);
  }
  if (books.size === 0) {
    console.log('\n  No books opened (fetches failed, or every candidate was guard-refused) — exiting.');
    if (ds) await ds.destroy();
    process.exit(1);
  }

  // ── Poll loop ──────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const endMs = RUN_HOURS > 0 ? t0 + RUN_HOURS * HOUR_MS : Infinity;
  let lastRegateMs = t0;
  let poll = 0;
  let peakEquityUnits = 0n; // desk net P&L peak (starts at 0 — a loss from the open counts, the honest budget)
  let maxDdFrac = 0;
  const curve: EquityPoint[] = [];
  const bench: BenchPoint[] = [];

  const onSigint = (): void => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
  };
  process.on('SIGINT', onSigint);

  while (!shuttingDown && Date.now() < endMs) {
    poll++;
    const now = Date.now();
    let deskRealisedFirst = 0n;
    let deskBasis = 0n;
    let deskFunding = 0n;
    let deskFees = 0n;
    const navRows: CarryNavInsert[] = [];

    for (const lb of books.values()) {
      try {
        const [snap, fSnap] = await Promise.all([fv.getBasis(lb.symbol), fund.currentFunding(lb.symbol)]);
        const spotMid = micros(snap.binanceMid);
        const perpMid = micros(snap.hlMid);
        if (spotMid <= 0n || perpMid <= 0n) throw new Error('bad mids');
        lb.lastSpotMid = spotMid;
        lb.lastPerpMid = perpMid;
        lb.lastRatePerHour = fSnap.lastFundingRate;
        if (lb.stale) { lb.stale = false; alerts.feedStale(lb.symbol, false); }
        lb.book.accrueFunding(now, fSnap.lastFundingRate, perpMid);

        const s = lb.book.snapshot(spotMid, perpMid, now);
        // Margin honesty: a leg at maintenance is force-closed, like a real venue would.
        if (s.wouldLiquidate) {
          alerts.lossStop(lb.symbol, `margin: spot ${(s.spotMarginUtil * 100).toFixed(0)}% / perp ${(s.perpMarginUtil * 100).toFixed(0)}% of leg margin`);
          lb.book.close(now, spotMid, perpMid);
          const closed = lb.book.snapshot(spotMid, perpMid, now);
          console.log(`  ⚠ ${lb.symbol}: LEG MARGIN LIQUIDATION — pair force-closed, realised-first ${usd(closed.realisedFirstUnits)}`);
          await checkpoint(store, lb);
          await store.closeBook(lb.symbol);
          books.delete(lb.symbol);
          continue;
        }
        deskRealisedFirst += s.realisedFirstUnits;
        deskBasis += s.basisUnrealisedUnits;
        deskFunding += s.fundingUnits;
        deskFees += s.feesUnits;
        navRows.push(navRow(lb, s.realisedFirstUnits, s.basisUnrealisedUnits, s.feesUnits, s.fundingUnits, s.qtyUnits, now));
      } catch (e) {
        if (!lb.stale) { lb.stale = true; alerts.feedStale(lb.symbol, true, (e as Error).message); }
        console.log(`  ${lb.symbol}: poll failed — ${(e as Error).message}`);
      }
    }

    // Desk equity + DD (on the TOTAL mark incl. basis — the conservative read for risk).
    const deskNet = deskRealisedFirst + deskBasis;
    if (deskNet > peakEquityUnits) peakEquityUnits = deskNet;
    const ddFrac = Number(peakEquityUnits - deskNet) / 1e6 / DESK_CAPITAL_USD;
    if (ddFrac > maxDdFrac) maxDdFrac = ddFrac;

    curve.push({ tMs: now, equityUsd: DESK_CAPITAL_USD + Number(deskRealisedFirst) / 1e6 }); // judged curve: realised-first
    const btc = books.get('BTC');
    bench.push({ tMs: now, price: btc ? Number(btc.lastSpotMid) / 1e6 : bench.length ? bench[bench.length - 1].price : 1 });

    const hh = Math.floor((now - t0) / HOUR_MS);
    const mm = Math.floor(((now - t0) % HOUR_MS) / 60_000);
    console.log(
      `t+${String(hh).padStart(3)}:${String(mm).padStart(2, '0')} | legs ${books.size} | ` +
      `funding ${usd(deskFunding)} | fees ${usd(-deskFees)} | REALISED-FIRST ${usd(deskRealisedFirst)} | ` +
      `basisMTM ${usd(deskBasis)} | net ${usd(deskNet)} | maxDD ${(maxDdFrac * 100).toFixed(3)}%`,
    );
    if (poll % 30 === 0) printBookTable();

    if (navRows.length > 0) {
      navRows.push({
        asOf: new Date(now), bookKey: '',
        equityUnits: BigInt(Math.round(DESK_CAPITAL_USD * 1e6)) + deskNet,
        realisedPnlUnits: deskRealisedFirst - deskFunding + deskFees, // raw realised (identity: rf = r − fees + funding)
        unrealisedPnlUnits: deskBasis, feesUnits: deskFees, fundingUnits: deskFunding,
        inventoryUnits: 0n, maxDrawdownPct: maxDdFrac * 100,
      });
      await store.appendNav(navRows).catch((e) => console.log(`  ⚠ nav write failed: ${(e as Error).message}`));
      for (const lb of books.values()) await checkpoint(store, lb);
    }

    // DD kill-switch: budget breached ⇒ flatten everything, report honestly, exit 1.
    if (maxDdFrac >= DD_BUDGET_FRAC) {
      alerts.drawdownBreach(maxDdFrac, DD_BUDGET_FRAC);
      alerts.deskHalt(`carry desk DD ${(maxDdFrac * 100).toFixed(3)}% breached the ${(DD_BUDGET_FRAC * 100).toFixed(2)}% budget`);
      console.log(`\n  ⛔ DD BUDGET BREACHED — flattening the desk (the basis moved more than the budget allows).`);
      await flattenAll(store, 'dd-breach');
      await verdict(store, ds, curve, bench, 1);
      return;
    }

    // Daily re-gate: the standing #72 discipline — never hold what today's gate refuses.
    if (Date.now() - lastRegateMs >= REGATE_HOURS * HOUR_MS) {
      lastRegateMs = Date.now();
      console.log(`\n  RE-GATE (${REGATE_HOURS}h cadence)...`);
      try {
        const results = await runGate(SYMBOLS);
        passers = printGateBoard(results);
        const stillGated = new Map(passers.map((r) => [r.symbol, r]));
        for (const lb of [...books.values()]) {
          const g = stillGated.get(lb.symbol);
          if (!g || g.direction !== lb.gate.direction) {
            const s = lb.book.snapshot(lb.lastSpotMid, lb.lastPerpMid, Date.now());
            if (lb.book.isOpen() && !(await executePair(lb.book, lb.symbol, lb.gate.direction, 'close'))) {
              lb.book.close(Date.now(), lb.lastSpotMid, lb.lastPerpMid);
            }
            console.log(`  ${lb.symbol}: DE-VALIDATED at re-gate — closed (was realised-first ${usd(s.realisedFirstUnits)})`);
            await checkpoint(store, lb);
            await store.closeBook(lb.symbol);
            books.delete(lb.symbol);
          }
        }
        for (const r of passers) {
          if (books.has(r.symbol) || books.size >= MAX_LEGS) continue;
          try {
            const snap = await fv.getBasis(r.symbol);
            const lb: LiveBook = {
              symbol: r.symbol, gate: r, book: newBook(r.symbol, r.direction),
              entryMs: Date.now(), lastRatePerHour: 0, lastSpotMid: micros(snap.binanceMid), lastPerpMid: micros(snap.hlMid), stale: false,
            };
            if (!basisGuard(r.symbol, lb.lastSpotMid, lb.lastPerpMid)) continue;
            if (!(await executePair(lb.book, r.symbol, r.direction, 'open'))) lb.book.open(Date.now(), lb.lastSpotMid, lb.lastPerpMid);
            books.set(r.symbol, lb);
            await checkpoint(store, lb);
            console.log(`  ${r.symbol}: NEWLY GATED — opened ${r.direction} (recent7d ${pct(r.recent.annualizedFundingPct)})`);
          } catch (e) {
            console.log(`  ${r.symbol}: open-at-regate failed — ${(e as Error).message}`);
          }
        }
      } catch (e) {
        console.log(`  ⚠ re-gate failed (${(e as Error).message}) — holding the current set until the next cadence`);
      }
    }

    const remaining = endMs === Infinity ? POLL_MS : Math.min(POLL_MS, endMs - Date.now());
    if (remaining > 0) await interruptibleSleep(remaining);
  }

  // ── Shutdown ───────────────────────────────────────────────────────────────────
  if (store.enabled) {
    console.log(`\n  Shutdown: persistence ON — positions checkpointed OPEN (carry resumes on the next boot; no round-trip fee paid).`);
    for (const lb of books.values()) await checkpoint(store, lb);
  } else {
    console.log(`\n  Shutdown: no persistence — flattening so no paper position dangles.`);
    await flattenAll(store, 'shutdown-no-persist');
  }
  await verdict(store, ds, curve, bench, 0);
}

async function interruptibleSleep(ms: number): Promise<void> {
  const step = 500;
  for (let waited = 0; waited < ms && !shuttingDown; waited += step) await sleep(Math.min(step, ms - waited));
}

function navRow(lb: LiveBook, rf: bigint, basis: bigint, fees: bigint, funding: bigint, qty: bigint, now: number): CarryNavInsert {
  return {
    asOf: new Date(now), bookKey: lb.symbol,
    equityUnits: BigInt(Math.round(2 * NOTIONAL_USD * 1e6)) + rf + basis,
    realisedPnlUnits: rf - funding + fees, unrealisedPnlUnits: basis,
    feesUnits: fees, fundingUnits: funding, inventoryUnits: qty, maxDrawdownPct: 0,
  };
}

async function checkpoint(store: ICarryStateStore, lb: LiveBook): Promise<void> {
  await store
    .saveBook({
      symbol: lb.symbol, direction: lb.gate.direction,
      gateAnnualizedPct: lb.gate.full.annualizedFundingPct, entryMs: lb.entryMs, state: lb.book.serializeState(),
    })
    .catch((e) => console.log(`  ⚠ checkpoint ${lb.symbol} failed: ${(e as Error).message}`));
}

async function flattenAll(store: ICarryStateStore, reason: string): Promise<void> {
  for (const lb of books.values()) {
    if (lb.book.isOpen()) {
      lb.book.close(Date.now(), lb.lastSpotMid, lb.lastPerpMid);
      console.log(`  ${lb.symbol}: closed (${reason}) — realised-first ${usd(lb.book.snapshot(lb.lastSpotMid, lb.lastPerpMid).realisedFirstUnits)}`);
    }
    await checkpoint(store, lb);
    await store.closeBook(lb.symbol);
  }
}

function printBookTable(): void {
  console.log(`\n  symbol   dir         rate/h(bps)  funding$   fees$   realFirst$  basisMTM$   margin%  age`);
  for (const lb of books.values()) {
    const s = lb.book.snapshot(lb.lastSpotMid, lb.lastPerpMid, Date.now());
    const ageH = s.ageMs !== null ? (s.ageMs / HOUR_MS).toFixed(1) + 'h' : '—';
    const util = Math.max(s.spotMarginUtil, s.perpMarginUtil);
    console.log(
      `  ${lb.symbol.padEnd(7)}  ${s.direction.padEnd(10)}  ${(lb.lastRatePerHour * 10_000).toFixed(3).padStart(11)}  ` +
      `${usd(s.fundingUnits).padStart(8)}  ${usd(-s.feesUnits).padStart(7)}  ${usd(s.realisedFirstUnits).padStart(10)}  ` +
      `${usd(s.basisUnrealisedUnits).padStart(9)}  ${(util * 100).toFixed(0).padStart(6)}%  ${ageH}`,
    );
  }
  console.log('');
}

async function verdict(
  store: ICarryStateStore, ds: DataSource | null, curve: EquityPoint[], bench: BenchPoint[], exitCode: number,
): Promise<void> {
  console.log(`\n=== CARRY DESK VERDICT (realised-first: funding + realised − fees; the basis mark is reported, not judged) ===`);
  printBookTable();
  // A tear-sheet on a handful of polls is noise (a 3-point flat curve prints an absurd
  // Sharpe) — only render once there is at least half an hour of samples.
  if (curve.length >= 30 && bench.length >= 30) {
    const ts = computeTearsheet({
      curve, benchmark: bench, capitalUsd: DESK_CAPITAL_USD,
      barsPerYear: (365 * 24 * HOUR_MS) / POLL_MS,
    });
    console.log(
      `  tear-sheet: return ${pct(ts.totalReturnPct, 3)} | Sharpe ${ts.sharpe.toFixed(2)} | maxDD ${ts.maxDrawdownPct.toFixed(3)}% | ` +
      `vs BTC: bench ${pct(ts.benchmark.totalReturnPct, 2)} · excess ${pct(ts.benchmark.excessReturnPct, 2)} · β ${ts.benchmark.beta.toFixed(2)}`,
    );
  }
  console.log(`  PRE-REGISTERED METRIC (P0): rolling-7d (funding − fees + realised) > 0 AND desk maxDD < ${(DD_BUDGET_FRAC * 100).toFixed(1)}%.`);
  console.log(`  Truth source when persisted: mm_nav WHERE desk='carry' (never the log end-to-end — §12).`);
  if (ds) await ds.destroy();
  console.log('\nCARRY-DESK-LIVE DONE');
  process.exit(exitCode);
}

main().catch(async (e) => {
  console.error('\nCARRY-DESK-LIVE FAIL:', e?.message ?? e);
  process.exit(1);
});
