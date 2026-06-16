/**
 * regime-book-live — P4 of the standalone "take sides" book (REGIME_DIRECTIONAL_BOOK.md,
 * playbook S3). THE FORWARD-PAPER RUNNER + a live terminal cockpit you leave running for
 * hours. This is what produces the track record.
 *
 * GATE FIRST (the honesty discipline): it runs the exact same OOS gate as the morning
 * board (regime-board.ts) and trades ONLY symbols VALIDATED today — non-validated symbols
 * are refused, with the reason printed. For each eligible symbol it builds a
 * RegimeDirectionalBook + a ConsensusBiasSource (the validated funding / momentum signals
 * + a manual house-view slot) + a RegimeMonitor. Each poll it fetches mid + funding +
 * basis, computes the consensus reading + the monitor's stand-aside, calls book.update,
 * and books the fill against the book's own InventoryBook (paper — no orders placed). The
 * OOS IC is passed into the tick so conviction is IC-capped.
 *
 * THE DASHBOARD redraws in place each poll: a CARD per book (side, size, entry/mark,
 * unrealised, funding, a DISTANCE-TO-STOP gauge — the hero widget — the live bias with a
 * ↗/↘ decay arrow, and age), a desk header (realised + unrealised, maxDD, books live /
 * aside), and a weather-strip footer. The FINAL VERDICT is realised-first: realised +
 * funding − fees per book + desk, judged on realised, never unrealised marks.
 *
 * Paper-only, DB-free, no API key — real HL public candles + funding (+ Binance for basis).
 *
 * Run (leave it running; Ctrl-C prints the verdict):
 *   npx ts-node -r tsconfig-paths/register scripts/regime-book-live.ts
 *   RBL_SYMBOLS=BTC,ETH,SOL RBL_HOURS=6 RBL_BASE_NOTIONAL_USD=50000 \
 *     npx ts-node -r tsconfig-paths/register scripts/regime-book-live.ts
 */
import 'dotenv/config';
import { Bar } from '../src/stat-arb/backtest/bar';
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';
import { HyperliquidFundingClient } from '../src/market-data/funding/hyperliquid-funding-client';
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { FundingPoint } from '../src/market-data/funding/funding-source.interface';
import { RegimeSeries, defaultRegimeSignalSpecs, trailingFundingPerHour } from '../src/market-making/directional/regime-signals';
import { scoreRegimeBoard, bestPerSymbol, validatedSignalsPerSymbol, BoardRow } from '../src/market-making/directional/regime-board';
import { RegimeDirectionalBook } from '../src/market-making/directional/regime-directional-book';
import { RegimeMonitor, RegimeState, RegimeColor, REGIME_LEVEL_COLOR, REGIME_OVERALL_COLOR, regimeChangeEvent } from '../src/market-making/directional/regime-monitor';
import { ConsensusBiasSource } from '../src/market-making/directional/consensus-bias-source';
import { FundingBiasSource } from '../src/market-making/bias/funding-bias-source';
import { MomentumBiasSource } from '../src/market-making/bias/momentum-bias-source';
import { ManualBiasSource } from '../src/market-making/bias/manual-bias-source';
import { IBiasSource, effectiveBias, BiasReading } from '../src/market-making/bias/bias-source.interface';
import { DeskEventInput, controlEvent } from '../src/market-making/events/desk-event';
import { RegimeDeskRisk, BookRiskInput, DeskRiskAssessment } from '../src/market-making/directional/regime-desk-risk';
import { IRegimeStateStore, NullRegimeStateStore, RegimeBookRecord, RegimeNavInsert, reconcileResume } from '../src/market-making/directional/regime-state-store';
import { PostgresRegimeStateStore } from '../src/market-making/directional/postgres-regime-state-store';
import { FillCostModel, NoSlippageModel, SlippageImpactModel } from '../src/market-making/directional/fill-cost-model';
import { RegimeBetaHedge, BookBeta, estimateBeta } from '../src/market-making/directional/regime-beta-hedge';
import { InventoryBook } from '../src/market-making/inventory/inventory-book';
import { DataSource } from 'typeorm';

// ── Config ──────────────────────────────────────────────────────────────────
const SYMBOLS = (process.env.RBL_SYMBOLS ?? 'BTC,ETH,SOL,BNB,XRP,DOGE,ADA').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const GATE_DAYS = Number(process.env.RBL_GATE_DAYS ?? 90);
const INTERVAL = process.env.RBL_INTERVAL ?? '1h';
const FWD_HOURS = (process.env.RBL_FWD_HOURS ?? '8,24,72').split(',').map(Number).filter((h) => h > 0);
const MOM_LOOKBACK_HOURS = (process.env.RBL_MOM_LOOKBACK_HOURS ?? '24,72').split(',').map(Number).filter((h) => h > 0);
const FUNDING_WINDOW_HOURS = Number(process.env.RBL_FUNDING_WINDOW_HOURS ?? 24);
const FOLDS = Number(process.env.RBL_FOLDS ?? 5);
const EMBARGO_FRAC = Number(process.env.RBL_EMBARGO_FRAC ?? 0.01);

const BASE_NOTIONAL_USD = Number(process.env.RBL_BASE_NOTIONAL_USD ?? 50_000);
const MAX_NOTIONAL_USD = Number(process.env.RBL_MAX_NOTIONAL_USD ?? BASE_NOTIONAL_USD);
const STOP_FRAC = Number(process.env.RBL_STOP_FRAC ?? 0.02);
const B_ENTER = Number(process.env.RBL_BENTER ?? 0.15);
const B_EXIT = Number(process.env.RBL_BEXIT ?? 0.07);
const TAKER_FEE_BPS = Number(process.env.RBL_TAKER_FEE_BPS ?? 4.5);
const SLIPPAGE_BPS = Number(process.env.RBL_SLIPPAGE_BPS ?? 0); // half-spread, bps (0 ⇒ frictionless)
const IMPACT_BPS_PER_MM = Number(process.env.RBL_IMPACT_BPS_PER_MM ?? 0); // linear impact, bps per $1M notional

// ── P9 exposure toggle: outright (default) vs beta-hedged / market-neutral. ────
const EXPOSURE = (process.env.RBL_EXPOSURE ?? 'outright').toLowerCase() === 'hedged' ? 'hedged' : 'outright';
const HEDGE_SYMBOL = (process.env.RBL_HEDGE_SYMBOL ?? 'BTC').toUpperCase();
const HEDGE_BAND_USD = Number(process.env.RBL_HEDGE_BAND_USD ?? 5_000);
const HEDGE_BETA_LOOKBACK = Number(process.env.RBL_HEDGE_BETA_LOOKBACK ?? 72); // bars of returns for beta
const MIN_AGREE = Number(process.env.RBL_MIN_AGREE ?? 1); // each constituent is already OOS-gated
const FUNDING_FULL_RATE = Number(process.env.RBL_FUNDING_FULL_RATE ?? 1.25e-5); // ~11%/yr ⇒ |b|=1
const MOM_FULL_RETURN = Number(process.env.RBL_MOM_FULL_RETURN ?? 0.05); // a 5% trend ⇒ |b|=1

const HOURS = Number(process.env.RBL_HOURS ?? 6);
const POLL_MS = Number(process.env.RBL_POLL_MS ?? 60_000);
const MAX_POLLS = Number(process.env.RBL_MAX_POLLS ?? Infinity); // bounded smoke knob

// ── P5 desk-risk spine (caps + kill-switch). Defaults scale to the universe. ───
const N_DEFAULT = Math.max(1, SYMBOLS.length);
const MAX_GROSS_USD = Number(process.env.RBL_MAX_GROSS_USD ?? MAX_NOTIONAL_USD * N_DEFAULT); // Σ|notional| cap
const MAX_NET_USD = Number(process.env.RBL_MAX_NET_USD ?? MAX_NOTIONAL_USD * Math.ceil(N_DEFAULT / 2)); // |Σ signed| cap
const DESK_CAPITAL_USD = Number(process.env.RBL_DESK_CAPITAL_USD ?? BASE_NOTIONAL_USD * N_DEFAULT);
const DAILY_LOSS_USD = Number(process.env.RBL_DAILY_LOSS_USD ?? DESK_CAPITAL_USD * 0.015); // realised-loss kill
const DESK_MAX_DD_FRAC = Number(process.env.RBL_DESK_MAX_DD_FRAC ?? 0.02); // peak-to-trough equity budget
const START_HALTED = process.env.RBL_HALT === '1' || process.env.RBL_HALT === 'true';
const START_FLATTEN = (process.env.RBL_FLATTEN ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

const NEUTRAL_READING: BiasReading = { bias: 0, validated: true, reason: 'desk-risk: new entry blocked (exposure cap)' };

// ── P6 durable persistence (off unless MM_PERSIST=true). ───────────────────────
const PERSIST = (process.env.MM_PERSIST ?? 'false').toLowerCase() === 'true';
const DATABASE_URL_APP = process.env.DATABASE_URL_APP ?? 'postgresql://meridian_markets_app:meridian_markets_app@localhost:5433/meridian_markets';

// ── ANSI ──────────────────────────────────────────────────────────────────────
const USE_COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const REDRAW = USE_COLOR && process.env.RBL_NO_REDRAW !== '1';
const wrap = (c: string, s: string) => (USE_COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const green = (s: string) => wrap('32', s);
const red = (s: string) => wrap('31', s);
const amber = (s: string) => wrap('33', s);
const dim = (s: string) => wrap('2', s);
const bold = (s: string) => wrap('1', s);
const cyan = (s: string) => wrap('36', s);
const colorFn = (c: RegimeColor) => (c === 'green' ? green : c === 'amber' ? amber : red);

const MICROS = 1_000_000;
const toMicros = (x: number) => BigInt(Math.round(x * MICROS));
const usd = (units: bigint) => `${Number(units) / MICROS >= 0 ? '+' : '−'}$${Math.abs(Number(units) / MICROS).toFixed(2)}`;
const px = (micros: bigint) => (Number(micros) / MICROS).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function intervalHours(iv: string): number {
  const m = /^(\d+)([mhd])$/.exec(iv.trim());
  if (!m) return 1;
  const n = Number(m[1]);
  return m[2] === 'h' ? n : m[2] === 'd' ? n * 24 : n / 60;
}

/** A horizontal distance-to-stop gauge: green far, amber past 60%, red near the stop. */
function stopGauge(ddFrac: number, width = 18): string {
  const filled = Math.max(0, Math.min(width, Math.round(ddFrac * width)));
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return ddFrac >= 0.85 ? red(bar) : ddFrac >= 0.6 ? amber(bar) : green(bar);
}

interface BookState {
  symbol: string;
  row: BoardRow;
  ic: number;
  book: RegimeDirectionalBook;
  monitor: RegimeMonitor;
  consensus: ConsensusBiasSource;
  fundingBuf: FundingPoint[];
  entryMidMicros: bigint | null;
  entryMs: number | null;
  lastBias: number;
  lastMidMicros: bigint;
  lastState: RegimeState | null;
}

async function fetchHistory(sym: string, fromMs: number, toMs: number): Promise<{ bars: Bar[]; funding: FundingPoint[] } | null> {
  const ivHours = intervalHours(INTERVAL);
  const wantBars = Math.ceil((GATE_DAYS * 24) / ivHours) + 16;
  try {
    const client = new HyperliquidClient();
    const fund = new HyperliquidFundingClient();
    const bars = (await client.klines(sym, INTERVAL, wantBars)).filter((b) => b.timestamp.getTime() >= fromMs);
    const funding = await fund.fundingHistory(sym, fromMs, toMs).catch(() => [] as FundingPoint[]);
    return bars.length ? { bars, funding } : null;
  } catch (e) {
    process.stdout.write(`  ${sym}: ERR(${(e as Error).message.slice(0, 48)})\n`);
    return null;
  }
}

/** Build the consensus from a symbol's VALIDATED signals + a (default-empty) house-view slot. */
function buildConsensus(symbol: string, validated: { kind: string; lookbackBars?: number }[]): ConsensusBiasSource {
  const sources: IBiasSource[] = [];
  for (const v of validated) {
    if (v.kind === 'funding-paid-side') sources.push(new FundingBiasSource({ fullBiasRatePerHour: FUNDING_FULL_RATE, validated: true }));
    else if (v.kind === 'momentum') sources.push(new MomentumBiasSource({ fullBiasReturn: MOM_FULL_RETURN, lookback: v.lookbackBars, validated: true }));
  }
  const manual = new ManualBiasSource(); // the house-view slot (control-plane seam; empty by default)
  const houseRaw = (process.env.RBL_HOUSE_VIEW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const hv of houseRaw) {
    const [sy, b] = hv.split(':');
    if (sy?.toUpperCase() === symbol && Number.isFinite(Number(b))) {
      manual.setView(symbol, { bias: Number(b), validated: true, setAtMs: Date.now(), ttlMs: 7 * 86_400_000, reason: 'house view (RBL_HOUSE_VIEW)' });
    }
  }
  sources.push(manual);
  return new ConsensusBiasSource(sources, { minAgree: MIN_AGREE });
}

const events: DeskEventInput[] = [];
// per-book previous-bias memory for the decay arrow.
const prevBias = new Map<string, number>();
const lastBiasPrevFor = (symbol: string): number => prevBias.get(symbol) ?? 0;
function onEvent(e: DeskEventInput): void {
  events.push(e);
  if (!REDRAW) console.log(dim(`  ${e.message}`)); // in redraw mode the cards show state; log only when scrolling
}

// ── desk-level running stats ────────────────────────────────────────────────
let peakTotalUnits = 0n;
let maxDDUnits = 0n;
let lastAssessment: DeskRiskAssessment | null = null;
// P9: the beta-hedge leg (hedged mode only; null in outright). Paper perp in one hedge instrument.
let hedge: { engine: RegimeBetaHedge; inv: InventoryBook; midMicros: bigint; lastResidualUsd: number; lastBetaUsd: number } | null = null;

/** Current per-book risk input from the book's snapshot at its last-known mid. */
function bookRiskInput(bs: BookState): BookRiskInput {
  if (bs.lastMidMicros === 0n) return { symbol: bs.symbol, notionalUsd: 0, side: 'FLAT', realisedPnlUsd: 0, unrealisedPnlUsd: 0 };
  const snap = bs.book.snapshot(bs.lastMidMicros);
  const inv = snap.inventoryUnits;
  const absInv = inv < 0n ? -inv : inv;
  const notionalUsd = Number((absInv * bs.lastMidMicros) / BigInt(MICROS)) / MICROS;
  const side = inv > 0n ? 'LONG' : inv < 0n ? 'SHORT' : 'FLAT';
  return {
    symbol: bs.symbol,
    notionalUsd,
    side,
    realisedPnlUsd: Number(snap.realisedUnits - snap.feesUnits + snap.fundingUnits) / MICROS,
    unrealisedPnlUsd: Number(snap.unrealisedUnits) / MICROS,
  };
}

/** The durable checkpoint for a book (P6) — ledger state + entry context + identity. */
function bookRecord(bs: BookState): RegimeBookRecord {
  return {
    symbol: bs.symbol,
    signal: bs.row.spec.name,
    ic: bs.ic,
    entryMidMicros: bs.entryMidMicros === null ? null : bs.entryMidMicros.toString(),
    entryMs: bs.entryMs,
    state: bs.book.serializeState(),
  };
}

/** Build the persistence store: a real Postgres store when MM_PERSIST=true and the DB is
 *  reachable, else the no-op Null store (DB-free runs unchanged). Returns the store + its
 *  DataSource (null when not persisting) so the caller can close it on shutdown. */
async function buildStore(): Promise<{ store: IRegimeStateStore; ds: DataSource | null }> {
  if (!PERSIST) return { store: new NullRegimeStateStore(), ds: null };
  try {
    const ds = new DataSource({ type: 'postgres', url: DATABASE_URL_APP, entities: [], synchronize: false, connectTimeoutMS: 2500, extra: { connectionTimeoutMillis: 2500 } });
    await ds.initialize();
    await ds.query('SELECT 1');
    console.log(green(`persistence: ON — regime desk → regime_book_state + mm_nav (desk='regime')`));
    return { store: new PostgresRegimeStateStore(ds), ds };
  } catch (e) {
    console.log(amber(`persistence: requested (MM_PERSIST=true) but DB unreachable (${(e as Error).message.slice(0, 50)}) — running DB-free.`));
    return { store: new NullRegimeStateStore(), ds: null };
  }
}

/** Persist the desk equity curve + each book's checkpoint for this poll (no-op when disabled). */
async function persistDesk(books: BookState[], store: IRegimeStateStore, ddPct: number): Promise<void> {
  if (!store.enabled) return;
  const now = new Date();
  const navRows: RegimeNavInsert[] = [];
  let deskEquity = 0n, deskRealised = 0n, deskUnreal = 0n, deskFees = 0n, deskFunding = 0n;
  for (const bs of books) {
    if (bs.lastMidMicros === 0n) continue;
    const s = bs.book.snapshot(bs.lastMidMicros);
    const equity = s.realisedUnits - s.feesUnits + s.fundingUnits + s.unrealisedUnits;
    deskEquity += equity; deskRealised += s.realisedUnits; deskUnreal += s.unrealisedUnits; deskFees += s.feesUnits; deskFunding += s.fundingUnits;
    navRows.push({ asOf: now, bookKey: bs.symbol, equityUnits: equity, realisedPnlUnits: s.realisedUnits, unrealisedPnlUnits: s.unrealisedUnits, feesUnits: s.feesUnits, fundingUnits: s.fundingUnits, inventoryUnits: s.inventoryUnits, maxDrawdownPct: 0 });
  }
  navRows.unshift({ asOf: now, bookKey: '', equityUnits: deskEquity, realisedPnlUnits: deskRealised, unrealisedPnlUnits: deskUnreal, feesUnits: deskFees, fundingUnits: deskFunding, inventoryUnits: 0n, maxDrawdownPct: ddPct });
  try {
    await store.appendNav(navRows);
    for (const bs of books) await store.saveBook(bookRecord(bs));
  } catch (e) {
    process.stdout.write(amber(`  persist err ${(e as Error).message.slice(0, 50)}\n`));
  }
}

function deskTotals(books: BookState[]): { realised: bigint; unrealised: bigint; funding: bigint; total: bigint; live: number; aside: number } {
  let realised = 0n;
  let unrealised = 0n;
  let funding = 0n;
  let live = 0;
  let aside = 0;
  for (const bs of books) {
    if (bs.lastMidMicros === 0n) continue; // not yet priced this session
    const snap = bs.book.snapshot(bs.lastMidMicros);
    realised += snap.realisedUnits - snap.feesUnits;
    unrealised += snap.unrealisedUnits;
    funding += snap.fundingUnits;
    if (snap.inventoryUnits !== 0n) live++;
    if (bs.lastState?.standAside) aside++;
  }
  return { realised, unrealised, funding, total: realised + funding + unrealised, live, aside };
}

function renderFrame(books: BookState[], pollNo: number): string {
  const t = deskTotals(books);
  if (t.total > peakTotalUnits) peakTotalUnits = t.total;
  const dd = peakTotalUnits - t.total;
  if (dd > maxDDUnits) maxDDUnits = dd;
  const capUsd = BASE_NOTIONAL_USD * books.length;
  const ddPct = capUsd > 0 ? (Number(maxDDUnits) / MICROS / capUsd) * 100 : 0;

  const out: string[] = [];
  out.push(bold(cyan(`◆ REGIME DESK  ·  poll ${pollNo}  ·  ${new Date().toISOString().slice(11, 19)}`)));
  out.push(
    `  realised ${(t.realised >= 0n ? green : red)(usd(t.realised))}   ` +
    `unrealised ${dim(usd(t.unrealised))}   funding ${usd(t.funding)}   ` +
    `maxDD ${red(usd(-maxDDUnits))} (${ddPct.toFixed(2)}%)   ${green(String(t.live))} live / ${amber(String(t.aside))} aside`,
  );
  if (lastAssessment) {
    const a = lastAssessment;
    const deskTag = a.desk.kind === 'Halt' ? red(bold(`HALT — ${a.desk.reason}`)) : green('RUN');
    out.push(
      `  ${dim('desk-risk')} ${deskTag}   gross $${Math.round(a.grossUsd).toLocaleString('en-US')}/${Math.round(MAX_GROSS_USD).toLocaleString('en-US')}   ` +
      `net $${Math.round(a.netUsd).toLocaleString('en-US')}/±${Math.round(MAX_NET_USD).toLocaleString('en-US')}   ` +
      `DD ${(a.drawdownFrac * 100).toFixed(2)}%/${(DESK_MAX_DD_FRAC * 100).toFixed(1)}%   ${dim('[h]=halt [f]=flatten-all')}`,
    );
  }
  out.push(dim('─'.repeat(64)));

  for (const bs of books) {
    if (bs.lastMidMicros === 0n) { out.push(`${bold(bs.symbol.padEnd(5))} ${dim('warming — awaiting first price')}`); continue; }
    const snap = bs.book.snapshot(bs.lastMidMicros);
    const inv = snap.inventoryUnits;
    const sideTxt = inv > 0n ? green('LONG ') : inv < 0n ? red('SHORT') : dim('FLAT ');
    const notionalUnits = (inv < 0n ? -inv : inv) * bs.lastMidMicros / BigInt(MICROS);
    const notionalUsd = Number(notionalUnits) / MICROS;
    const units = Number(inv < 0n ? -inv : inv) / MICROS;
    const conv = Math.min(Math.abs(bs.lastBias), bs.ic > 0 ? Math.min(0.5, 4 * Math.abs(bs.ic)) : 1);
    const prev = lastBiasPrevFor(bs.symbol);
    const arrow = bs.lastBias > prev + 1e-4 ? green('↗') : bs.lastBias < prev - 1e-4 ? amber('↘') : dim('→');

    out.push(`${bold(bs.symbol.padEnd(5))} ${sideTxt}  ${bs.row.spec.name} (OOS IC ${signed(bs.ic)})`);
    if (inv === 0n) {
      out.push(dim(`   flat — ${bs.lastState ? overallChip(bs.lastState) : 'warming'}  bias ${signed(bs.lastBias)} ${arrow}`));
    } else {
      const entry = bs.entryMidMicros ?? bs.lastMidMicros;
      const movePct = Number(bs.lastMidMicros - entry) / Number(entry) * 100 * (inv > 0n ? 1 : -1);
      const ddUnits = snap.unrealisedUnits < 0n ? -snap.unrealisedUnits : 0n;
      const ddFrac = notionalUnits > 0n ? Number(ddUnits) / Number(notionalUnits) / STOP_FRAC : 0;
      const curDDpct = notionalUnits > 0n ? Number(ddUnits) / Number(notionalUnits) * 100 : 0;
      const ageMin = bs.entryMs ? Math.round((Date.now() - bs.entryMs) / 60_000) : 0;
      out.push(`   size $${Math.round(notionalUsd).toLocaleString('en-US')} (${units.toFixed(4)})  conv ${conv.toFixed(2)}  entry ${px(entry)} mark ${px(bs.lastMidMicros)} ${(movePct >= 0 ? green : red)(`${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}%`)}`);
      out.push(`   uPnL ${usd(snap.unrealisedUnits)}  funding ${usd(snap.fundingUnits)}  realised ${usd(snap.realisedUnits - snap.feesUnits)}`);
      out.push(`   STOP ${stopGauge(ddFrac)}  ${red(`−${curDDpct.toFixed(2)}%`)} / −${(STOP_FRAC * 100).toFixed(1)}%   bias ${signed(bs.lastBias)} ${arrow}  age ${Math.floor(ageMin / 60)}h${ageMin % 60}m`);
    }
  }

  out.push(dim('─'.repeat(64)));
  out.push(dim('  weather:'));
  for (const bs of books) if (bs.lastState) out.push('  ' + weatherLine(bs.lastState));
  return out.join('\n');
}

function signed(x: number, d = 2): string {
  return `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
}
function overallChip(s: RegimeState): string {
  return colorFn(REGIME_OVERALL_COLOR[s.overall])(s.overall);
}
function weatherLine(s: RegimeState): string {
  const fund = colorFn(REGIME_LEVEL_COLOR[s.funding.level])(`funding ${s.funding.side}`);
  const basis = colorFn(REGIME_LEVEL_COLOR[s.basis.level])(`basis ${s.basis.basisBps >= 0 ? '+' : ''}${s.basis.basisBps.toFixed(1)}bp`);
  const vol = colorFn(REGIME_LEVEL_COLOR[s.vol.level])(`vol ×${s.vol.ratio.toFixed(2)}`);
  return `${s.symbol.padEnd(5)} ${fund}   ${basis}   ${vol}   → ${overallChip(s)}`;
}

async function main() {
  const binance = new BinancePublicClient({ quote: 'USDT' });
  const hlPx = new HyperliquidClient();
  const hlFund = new HyperliquidFundingClient();
  const ivHours = intervalHours(INTERVAL);

  console.log(bold(cyan(`\n=== REGIME DESK · forward-paper runner · gate ${GATE_DAYS}d × ${INTERVAL} · ${HOURS}h run · poll ${POLL_MS / 1000}s ===`)));
  console.log(dim(`universe: ${SYMBOLS.join(', ')}  ·  base $${BASE_NOTIONAL_USD.toLocaleString('en-US')}/book  ·  stop ${(STOP_FRAC * 100).toFixed(1)}%  ·  bEnter ${B_ENTER} / bExit ${B_EXIT}\n`));

  // ── GATE FIRST ───────────────────────────────────────────────────────────
  const toMs = Date.now();
  const fromMs = toMs - GATE_DAYS * 86_400_000;
  const specs = defaultRegimeSignalSpecs({ intervalHours: ivHours, momentumLookbackHours: MOM_LOOKBACK_HOURS, fundingWindowHours: [FUNDING_WINDOW_HOURS] });
  const loaded: { symbol: string; series: RegimeSeries; funding: FundingPoint[] }[] = [];
  for (const sym of SYMBOLS) {
    process.stdout.write(`gating ${sym}… `);
    const got = await fetchHistory(sym, fromMs, toMs);
    if (!got || got.bars.length < FOLDS * 4) {
      process.stdout.write(`insufficient bars — skipped\n`);
      continue;
    }
    process.stdout.write(`${got.bars.length} bars\n`);
    loaded.push({ symbol: sym, series: { prices: got.bars.map((b) => b.close), barTimesMs: got.bars.map((b) => b.timestamp.getTime()), funding: got.funding }, funding: got.funding });
    await new Promise((r) => setTimeout(r, 80));
  }
  if (!loaded.length) {
    console.log('\nNo symbols loaded — likely no network here. Re-run on a networked host.');
    return;
  }
  const board = scoreRegimeBoard(loaded, specs, { fwdHours: FWD_HOURS, ivHours, folds: FOLDS, embargoFrac: EMBARGO_FRAC });
  const rows = bestPerSymbol(board);
  const validatedMap = validatedSignalsPerSymbol(board);

  console.log(bold(`\nGATE (${board.trials} trials, σ_SR ${board.sigmaSR.toFixed(3)}):`));
  for (const r of rows) {
    const tag = r.eligible ? green('✅ VALIDATED') : red(`⛔ ${r.verdict}`);
    console.log(`  ${r.symbol.padEnd(5)} ${r.spec.name} ${r.fwdHours}h  IC ${signed(r.oosIc)}  DSR ${r.dsr.toFixed(2)}  ${tag}`);
  }
  const eligible = rows.filter((r) => r.eligible);
  if (!eligible.length) {
    console.log(amber(bold(`\n0 symbols validated today — the desk trades NOTHING. (Correct outcome — re-gate next session.)`)));
    return;
  }
  console.log(green(bold(`\nELIGIBLE: ${eligible.map((r) => r.symbol).join(', ')} — building books.\n`)));

  // ── Build a book per eligible symbol ───────────────────────────────────────
  const fillModel: FillCostModel =
    SLIPPAGE_BPS > 0 || IMPACT_BPS_PER_MM > 0
      ? new SlippageImpactModel({ halfSpreadBps: SLIPPAGE_BPS, impactBpsPerMillionUsd: IMPACT_BPS_PER_MM })
      : new NoSlippageModel();
  if (SLIPPAGE_BPS > 0 || IMPACT_BPS_PER_MM > 0) {
    console.log(dim(`fill model: slippage ${SLIPPAGE_BPS}bps half-spread + impact ${IMPACT_BPS_PER_MM}bps/$1M notional (honest fills)`));
  }
  const books: BookState[] = [];
  for (const r of eligible) {
    const validated = (validatedMap.get(r.symbol) ?? []).map((t) => ({ kind: t.spec.kind, lookbackBars: t.spec.lookbackBars }));
    const ic = Math.max(...(validatedMap.get(r.symbol) ?? [{ oosIc: r.oosIc }]).map((t) => t.oosIc));
    const ld = loaded.find((l) => l.symbol === r.symbol)!;
    const book = new RegimeDirectionalBook({
      baseNotionalUsd: BASE_NOTIONAL_USD, maxNotionalUsd: MAX_NOTIONAL_USD, bEnter: B_ENTER, bExit: B_EXIT,
      stopFrac: STOP_FRAC, takerFeeBps: TAKER_FEE_BPS, fillModel, book: r.symbol, source: 'regime-directional', onEvent,
    });
    const monitor = new RegimeMonitor(r.symbol, { onRegimeChange: (tr) => onEvent(regimeChangeEvent(tr)) });
    const bs: BookState = {
      symbol: r.symbol, row: r, ic, book, monitor, consensus: buildConsensus(r.symbol, validated),
      fundingBuf: ld.funding.filter((f) => f.fundingTimeMs >= toMs - 3 * 86_400_000),
      entryMidMicros: null, entryMs: null, lastBias: 0, lastMidMicros: 0n, lastState: null,
    };
    books.push(bs);
  }

  // ── P6 persistence + restart recovery ──────────────────────────────────────
  const { store, ds: persistDs } = await buildStore();
  if (store.enabled) {
    try {
      const open = await store.loadOpen();
      const plan = reconcileResume(books.map((b) => b.symbol), open);
      for (const rec of plan.resume) {
        const bs = books.find((b) => b.symbol.toUpperCase() === rec.symbol.toUpperCase());
        if (!bs) continue;
        bs.book.restoreState(rec.state);
        bs.entryMidMicros = rec.entryMidMicros === null ? null : BigInt(rec.entryMidMicros);
        bs.entryMs = rec.entryMs;
        console.log(green(`  resumed ${rec.symbol}: inv ${Number(bs.book.inventoryUnits()) / MICROS} units, realised ${usd(bs.book.realisedUnits() - bs.book.feesUnits())}, funding ${usd(bs.book.fundingUnits())}`));
      }
      for (const rec of plan.orphaned) {
        await store.closeBook(rec.symbol);
        console.log(amber(`  ⚠ orphaned ${rec.symbol} (signal de-validated today) — row closed, position NOT resumed; re-gate to re-open.`));
      }
      if (!plan.resume.length && !plan.orphaned.length) console.log(dim('  no prior open books to recover — starting flat.'));
    } catch (e) {
      console.log(amber(`  recovery skipped (${(e as Error).message.slice(0, 50)}) — starting flat.`));
    }
  }

  // ── P5 desk-risk spine + manual controls ───────────────────────────────────
  const deskRisk = new RegimeDeskRisk({
    maxGrossUsd: MAX_GROSS_USD, maxNetUsd: MAX_NET_USD, dailyLossLimitUsd: DAILY_LOSS_USD,
    capitalUsd: DESK_CAPITAL_USD, maxDrawdownFrac: DESK_MAX_DD_FRAC,
  });
  if (START_HALTED) deskRisk.manualHalt('RBL_HALT=1 at launch');
  for (const sym of START_FLATTEN) deskRisk.manualFlatten(sym);
  console.log(dim(`desk-risk: gross≤$${MAX_GROSS_USD.toLocaleString('en-US')}  net≤±$${MAX_NET_USD.toLocaleString('en-US')}  daily-loss kill −$${Math.round(DAILY_LOSS_USD).toLocaleString('en-US')}  maxDD ${(DESK_MAX_DD_FRAC * 100).toFixed(1)}% of $${DESK_CAPITAL_USD.toLocaleString('en-US')}${START_HALTED ? red('  · LAUNCHED HALTED') : ''}`));

  // ── P9 exposure mode ────────────────────────────────────────────────────────
  if (EXPOSURE === 'hedged') {
    hedge = { engine: new RegimeBetaHedge({ hedgeSymbol: HEDGE_SYMBOL, rebalanceBandUsd: HEDGE_BAND_USD, takerFeeBps: TAKER_FEE_BPS }, onEvent), inv: new InventoryBook(), midMicros: 0n, lastResidualUsd: 0, lastBetaUsd: 0 };
    console.log(dim(`exposure: HEDGED — net crypto-beta neutralised with ${HEDGE_SYMBOL}-perp (band $${HEDGE_BAND_USD.toLocaleString('en-US')}, β from ${HEDGE_BETA_LOOKBACK} bars)\n`));
  } else {
    console.log(dim(`exposure: OUTRIGHT (default) — directional bets carried unhedged\n`));
  }

  // ── Poll loop ──────────────────────────────────────────────────────────────
  const endMs = Date.now() + HOURS * 3_600_000;
  let poll = 0;
  let stopped = false;
  let haltAnnounced = false;
  process.on('SIGINT', () => { stopped = true; });

  // Live "react" controls: [h] kill-switch the desk, [f] flatten every book. TTY only;
  // a non-interactive run (piped / bounded smoke) is unaffected. Ctrl-C ⇒ graceful flatten.
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void };
  const rawCapable = !!stdin.isTTY && typeof stdin.setRawMode === 'function';
  if (rawCapable) {
    stdin.setRawMode!(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', (key: string) => {
      if (key === '') { stopped = true; return; } // Ctrl-C (raw mode swallows SIGINT)
      if (key === 'h' || key === 'H') {
        deskRisk.manualHalt('keypress kill-switch');
        onEvent(controlEvent({ ts: Date.now(), book: 'DESK', detail: 'KEYPRESS HALT — desk kill-switch engaged; flattening all books' }));
      }
      if (key === 'f' || key === 'F') {
        for (const bs of books) deskRisk.manualFlatten(bs.symbol);
        onEvent(controlEvent({ ts: Date.now(), book: 'DESK', detail: 'KEYPRESS FLATTEN — flattening all open books' }));
      }
    });
  }
  const restoreStdin = () => { if (rawCapable) { try { stdin.setRawMode!(false); stdin.pause(); } catch { /* best effort */ } } };

  while (!stopped && Date.now() < endMs && poll < MAX_POLLS) {
    poll++;

    // PASS 1 — fetch + stage each symbol's fresh tick (no book.update yet, so the desk-risk
    // assessment below sees one coherent snapshot of the whole desk).
    const staged = new Map<string, { now: number; midMicros: bigint; reading: BiasReading; state: RegimeState; curRate: number; recentReturns: number[] }>();
    for (const bs of books) {
      try {
        const bars = await hlPx.klines(bs.symbol, INTERVAL, 80);
        if (bars.length < 2) continue;
        const closes = bars.map((b) => b.close);
        const mid = closes[closes.length - 1];
        const midMicros = toMicros(mid);
        const recentReturns: number[] = [];
        for (let i = 1; i < closes.length; i++) recentReturns.push(Math.log(closes[i] / closes[i - 1]));
        const ret = recentReturns[recentReturns.length - 1];
        const now = Date.now();

        // current + trailing-mean funding (the signal validated on the TRAILING mean).
        const snapF = await hlFund.currentFunding(bs.symbol).catch(() => null);
        const curRate = snapF?.lastFundingRate ?? 0;
        bs.fundingBuf.push({ symbol: bs.symbol, fundingTimeMs: now, fundingRate: curRate, markPrice: mid });
        bs.fundingBuf = bs.fundingBuf.filter((f) => f.fundingTimeMs >= now - (FUNDING_WINDOW_HOURS + 1) * 3_600_000);
        const trailFund = trailingFundingPerHour([now], bs.fundingBuf, FUNDING_WINDOW_HOURS)[0];
        const fundingForSignal = Number.isFinite(trailFund) ? trailFund : curRate;

        // basis (optional — majors rarely blow out; guard a Binance miss).
        const binPx = await binance.lastPrice(bs.symbol).catch(() => NaN);
        const basisBps = Number.isFinite(binPx) && binPx > 0 ? ((mid - binPx) / binPx) * 10_000 : undefined;

        const state = bs.monitor.update({ nowMs: now, fundingRatePerHour: fundingForSignal, basisBps, ret });
        const reading = bs.consensus.bias(bs.symbol, { fundingRatePerHour: fundingForSignal, recentReturns, nowMs: now, midMicros });

        staged.set(bs.symbol, { now, midMicros, reading, state, curRate, recentReturns });
        bs.lastMidMicros = midMicros;
        bs.lastState = state;
      } catch (e) {
        process.stdout.write(`  ${bs.symbol}: poll err ${(e as Error).message.slice(0, 40)}\n`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    // PASS 2 — consult the desk-risk spine on the whole-desk snapshot (positions still pre-update).
    const assessment = deskRisk.assess(books.map(bookRiskInput));
    lastAssessment = assessment;
    if (assessment.desk.kind === 'Halt' && !haltAnnounced) {
      haltAnnounced = true;
      onEvent(controlEvent({ ts: Date.now(), book: 'DESK', detail: `DESK HALT (${assessment.desk.component}): ${assessment.desk.reason} → flattening all books` }));
    }

    // PASS 3 — update each book under its verdict: FlattenNow/Halt ⇒ standAside (flatten);
    // BlockNewEntry ⇒ a flat book is fed a neutral reading so it cannot open (open books unchanged).
    for (const bs of books) {
      const st = staged.get(bs.symbol);
      if (!st) continue;
      const verdict = assessment.perBook.get(bs.symbol);
      const flatten = assessment.desk.kind === 'Halt' || verdict?.kind === 'FlattenNow';
      const blockEntry = verdict?.kind === 'BlockNewEntry';
      const reading = blockEntry && bs.book.inventoryUnits() === 0n ? NEUTRAL_READING : st.reading;
      prevBias.set(bs.symbol, bs.lastBias);
      const action = bs.book.update({ nowMs: st.now, midMicros: st.midMicros, reading, ic: bs.ic, fundingRatePerHour: st.curRate, standAside: st.state.standAside || flatten });
      if (action.action === 'open' || action.action === 'flip') { bs.entryMidMicros = st.midMicros; bs.entryMs = st.now; }
      if (action.action === 'close') { bs.entryMidMicros = null; bs.entryMs = null; }
      bs.lastBias = effectiveBias(reading);
    }

    // PASS 4 — beta-hedge (hedged mode only): neutralise the desk's net crypto-beta with a
    // paper perp leg. Covers EVERY non-flat book (no naked net beta) — the coherence rule.
    if (hedge) await hedgeStep(books, staged, hlPx);

    const frame = renderFrame(books, poll);
    if (REDRAW) process.stdout.write(`\x1b[2J\x1b[H${frame}\n`);
    else console.log(`\n${frame}`);

    // P6: durably checkpoint the equity curve + each book's state every poll (no-op when off).
    const capUsd = DESK_CAPITAL_USD;
    await persistDesk(books, store, capUsd > 0 ? (Number(maxDDUnits) / MICROS / capUsd) * 100 : 0);

    if (!stopped && Date.now() < endMs - POLL_MS && poll < MAX_POLLS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  // ── GRACEFUL SHUTDOWN — flatten every open book (book the realised exit), never leave a
  //    paper position dangling/unrealised at exit. Then the realised-first verdict.
  flattenAllOpenBooks(books, stopped ? 'shutdown (Ctrl-C)' : 'run window elapsed');
  restoreStdin();
  // P6: final checkpoint so the persisted state reflects the flattened (realised) desk, then close.
  await persistDesk(books, store, 0);
  if (persistDs) { try { await persistDs.destroy(); } catch { /* best effort */ } }
  printVerdict(books, poll);
}

/** Flatten every open book at its last-known mid (standAside ⇒ books the realised exit + fee). */
function flattenAllOpenBooks(books: BookState[], reason: string): void {
  const now = Date.now();
  let flattened = 0;
  for (const bs of books) {
    if (bs.book.inventoryUnits() === 0n || bs.lastMidMicros === 0n) continue;
    bs.book.update({ nowMs: now, midMicros: bs.lastMidMicros, reading: NEUTRAL_READING, ic: bs.ic, standAside: true });
    bs.entryMidMicros = null;
    bs.entryMs = null;
    flattened++;
  }
  if (flattened > 0) console.log(amber(`\n  flatten-on-exit (${reason}): closed ${flattened} open book(s) to realised.`));
}

/** P9: re-aim the paper beta-hedge leg at the desk's current net beta (covers all non-flat books). */
async function hedgeStep(books: BookState[], staged: Map<string, { recentReturns: number[] }>, hlPx: HyperliquidClient): Promise<void> {
  if (!hedge) return;
  try {
    const hbars = await hlPx.klines(HEDGE_SYMBOL, INTERVAL, HEDGE_BETA_LOOKBACK + 4);
    if (hbars.length < 2) return;
    const hcloses = hbars.map((b) => b.close);
    hedge.midMicros = toMicros(hcloses[hcloses.length - 1]);
    const hRet: number[] = [];
    for (let i = 1; i < hcloses.length; i++) hRet.push(Math.log(hcloses[i] / hcloses[i - 1]));
    const hRecent = hRet.slice(-HEDGE_BETA_LOOKBACK);

    const bookBetas: BookBeta[] = [];
    for (const bs of books) {
      const inv = bs.book.inventoryUnits();
      if (inv === 0n || bs.lastMidMicros === 0n) continue;
      const signedNotionalUsd = Number((inv * bs.lastMidMicros) / BigInt(MICROS)) / MICROS;
      const beta = bs.symbol === HEDGE_SYMBOL ? 1 : estimateBeta((staged.get(bs.symbol)?.recentReturns ?? []).slice(-HEDGE_BETA_LOOKBACK), hRecent);
      bookBetas.push({ symbol: bs.symbol, signedNotionalUsd, beta });
    }
    const reb = hedge.engine.rebalance(bookBetas, Date.now());
    hedge.lastResidualUsd = reb.residualBetaUsd;
    hedge.lastBetaUsd = reb.netBookBetaUsd;
    if (reb.changed && hedge.midMicros > 0n) {
      const side = reb.deltaNotionalUsd >= 0 ? 'BUY' : 'SELL';
      const sizeUnits = (BigInt(Math.round(Math.abs(reb.deltaNotionalUsd) * MICROS)) * BigInt(MICROS)) / hedge.midMicros;
      if (sizeUnits > 0n) {
        const feeUnits = BigInt(Math.round(((Math.abs(reb.deltaNotionalUsd) * TAKER_FEE_BPS) / 10_000) * MICROS));
        hedge.inv.apply({ side, sizeUnits, priceMicros: hedge.midMicros, feeUnits });
      }
    }
  } catch (e) {
    process.stdout.write(`  hedge err ${(e as Error).message.slice(0, 40)}\n`);
  }
}

function printVerdict(books: BookState[], poll: number): void {
  const t = deskTotals(books);
  console.log(bold(cyan(`\n=== REGIME DESK VERDICT (realised-first · ${poll} polls) ===`)));
  let entries = 0;
  let stops = 0;
  for (const e of events) {
    if (e.kind === 'fill' && (e.action === 'open' || e.action === 'flip')) entries++;
    if (e.kind === 'control' && /loss-stop/.test(e.message)) stops++;
  }
  let deskSlip = 0n;
  for (const bs of books) {
    const s = bs.book.snapshot(bs.lastMidMicros);
    deskSlip += s.slippageUnits;
    const realised = s.realisedUnits - s.feesUnits + s.fundingUnits; // realised-first: realised − fees + funding
    console.log(
      `  ${bs.symbol.padEnd(5)} realised ${(realised >= 0n ? green : red)(usd(realised))} ` +
      `(realised ${usd(s.realisedUnits)} − fees ${usd(-s.feesUnits)} + funding ${usd(s.fundingUnits)})  ` +
      `${s.slippageUnits > 0n ? dim(`slip ${usd(-s.slippageUnits)}  `) : ''}` +
      `${s.inventoryUnits !== 0n ? dim(`[open: unrealised ${usd(s.unrealisedUnits)}]`) : ''}  fills ${s.fills}`,
    );
  }
  const deskRealised = t.realised + t.funding;
  console.log(
    `\n  DESK REALISED (incl. funding, net of fees): ${(deskRealised >= 0n ? green : red)(bold(usd(deskRealised)))}  ·  ` +
    `maxDD ${red(usd(-maxDDUnits))}  ·  entries ${entries}  ·  stops fired ${stops}  ·  ` +
    `${deskSlip > 0n ? `slippage ${dim(usd(-deskSlip))}  ·  ` : ''}open-unrealised ${dim(usd(t.unrealised))}`,
  );
  if (hedge) {
    const hRealised = hedge.inv.realisedUnits() - hedge.inv.feesUnits();
    const hUnreal = hedge.midMicros > 0n ? hedge.inv.unrealisedUnits(hedge.midMicros) : 0n;
    const netOfHedge = deskRealised + hRealised + hUnreal;
    console.log(
      `  HEDGE (${HEDGE_SYMBOL}-perp): leg $${Math.round(hedge.engine.hedgeNotionalUsd()).toLocaleString('en-US')}  ` +
      `realised ${usd(hRealised)}  unrealised ${dim(usd(hUnreal))}  residual β $${Math.round(hedge.lastResidualUsd).toLocaleString('en-US')}  ·  ` +
      `NET-OF-HEDGE ${(netOfHedge >= 0n ? green : red)(bold(usd(netOfHedge)))}`,
    );
  }
  console.log(dim(`\n  PRE-REGISTERED METRIC: realised + funding − fees > 0 with maxDD inside the desk's 2% budget,`));
  console.log(dim(`  on the symbols VALIDATED today. Judge realised, never the open unrealised mark.`));
  console.log(green('\nREGIME-BOOK-LIVE OK\n'));
}

main().catch((e) => {
  console.error('\nREGIME-BOOK-LIVE FAIL:', e?.message ?? e);
  process.exit(1);
});
