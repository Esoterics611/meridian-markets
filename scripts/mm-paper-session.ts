/**
 * mm-paper-session — a long-horizon, DB-free, HTTP-free automated market-making
 * session against LIVE Binance public data. This is the "show me MM running for
 * hours, stable profit, large lots, equity conserved" harness. It drives the SAME
 * live `MmBook` the app's control plane runs (src/market-making/live/mm-book.ts)
 * and the SAME quoter registry — no new strategy code, no server, no Postgres.
 *
 * Two modes (MM_SESSION_MODE):
 *   replay (default) — backfill MM_SESSION_HOURS of real 1m history per symbol and
 *                      replay it bar-by-bar. Deterministic; runs anywhere with
 *                      network. Produces a multi-"hour" equity curve + report NOW.
 *   live            — same books on the real BinancePublicBarFeed, polled every
 *                      MM_SESSION_POLL_MS for MM_SESSION_HOURS wall-clock. The
 *                      literal "running for hours" — run this on your own box.
 *
 * Honesty (desk doctrine + MARKET_MAKING.md):
 *  - Fills use the fill-on-touch bar model (fill-model.ts) — an UPPER BOUND on
 *    fills, not a promise. Read fill counts as a ceiling.
 *  - The driving book runs at MM_SESSION_MAKER_BPS (default −1 = Binance VIP maker
 *    rebate). The report ALSO derives net at 0 bps (no fee/no rebate = the
 *    STRUCTURAL edge = spread − adverse) and +1 bps (retail maker cost), so you
 *    see what is structural vs what is a fee-tier subsidy. Conservation is judged
 *    on the STRUCTURAL equity curve, never on the rebate.
 *
 * Feed (MM_SESSION_SOURCE): unset = Binance public (default). Set to a reference
 * source id ('geckoterminal') to run the SAME books on a DEX preset — the
 * discovery frontier (Journal #16). A DEX session should use a coarser bar
 * (MM_SESSION_INTERVAL=1h) since on-chain pools are thin at 1m, and is sized by
 * DOLLAR notional (MM_SESSION_QUOTE_USD, default $50k for a source) ÷ price — raw
 * unit sizing only ≈ dollars for $1 stablecoins.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts
 *   MM_SESSION_HOURS=6 MM_SESSION_STRATEGY=mm-glft \
 *     npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts
 *   # DEX session — quote an on-chain Uniswap-v3 STABLE pool (GeckoTerminal), hourly:
 *   MM_SESSION_SOURCE=geckoterminal MM_SESSION_INTERVAL=1h \
 *     MM_SESSION_SYMBOLS=USDCUSDT MM_SESSION_HOURS=720 \
 *     npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts
 *   # NOTE: the stable peg is the valid case today. High-priced pools (WETH/WBTC)
 *   # expose that the QUOTER's σ/γ are calibrated for ~$1 assets (σ in absolute
 *   # price units) — they mis-scale until the quoter normalizes σ as a return
 *   # fraction. Notional sizing (above) is fixed; σ-normalization is a next step.
 *   # live, for hours, on your own machine:
 *   MM_SESSION_MODE=live MM_SESSION_HOURS=8 \
 *     npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts
 */
import { Bar } from '../src/stat-arb/backtest/bar';
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { BinancePublicBarFeed } from '../src/stat-arb/feed/binance-public-bar-feed';
import { IBarFeed } from '../src/stat-arb/feed/live-feed.interface';
import { mmStrategyRegistry } from '../src/market-making/registry/mm-strategy-registry';
import { MmBook } from '../src/market-making/live/mm-book';
import { CompositeRiskGate } from '../src/market-making/risk/risk-gate';
import {
  ReferenceSourceRegistry,
  buildReferenceSources,
} from '../src/market-data/reference/reference-bar-loader';
import { ReferenceBarFeed } from '../src/market-data/reference/reference-bar-feed';
import {
  IReferenceBarSource,
  intervalToSeconds,
} from '../src/market-data/reference/reference-source.interface';

// ---- config -----------------------------------------------------------------
const MODE = (process.env.MM_SESSION_MODE ?? 'replay').toLowerCase();
const SYMBOLS = (process.env.MM_SESSION_SYMBOLS ?? 'FDUSD,USDC,TUSD').split(',').map((s) => s.trim()).filter(Boolean);
const STRATEGY = process.env.MM_SESSION_STRATEGY ?? 'mm-glft';
// Reference data source id (e.g. 'geckoterminal' for a DEX session); empty =
// the default Binance public feed. INTERVAL is the bar granularity; DEX pools
// are thin at 1m, so a DEX session should use a coarser bar (e.g. 1h).
const SOURCE = (process.env.MM_SESSION_SOURCE ?? '').trim().toLowerCase();
const INTERVAL = process.env.MM_SESSION_INTERVAL ?? (SOURCE ? '1h' : '1m');
const BARS_PER_HOUR = Math.max(1, Math.round(3600 / intervalToSeconds(INTERVAL)));
const QUOTE_UNITS = BigInt(process.env.MM_SESSION_QUOTE_UNITS ?? '50000000000'); // $50k/quote (raw asset units; ≈$ only for $1 assets)
// If >0, size each book by DOLLAR notional ÷ the asset's price — the correct lever
// for non-$1 assets (WETH, WBTC, crypto majors). Raw QUOTE_UNITS assumes price≈$1
// (stablecoins), so it over-sizes a $1,860 WETH lot ~1860×. Defaults on for a
// reference/DEX source, where pools are rarely pegged to $1.
const QUOTE_USD = Number(process.env.MM_SESSION_QUOTE_USD ?? (SOURCE ? 50_000 : 0));
const CAPITAL_UNITS = BigInt(process.env.MM_SESSION_CAPITAL_UNITS ?? '1000000000000'); // $1M/book
const MAX_LOTS = Number(process.env.MM_SESSION_MAX_LOTS ?? 8);
const MIN_BPS = Number(process.env.MM_SESSION_MIN_BPS ?? 1);
const MAX_BPS = Number(process.env.MM_SESSION_MAX_BPS ?? 200);
const HOURS = Number(process.env.MM_SESSION_HOURS ?? 24);
const MAKER_BPS = Number(process.env.MM_SESSION_MAKER_BPS ?? -1); // driving maker fee (signed; −1 = rebate)
const MIN_NAV = Number(process.env.MM_SESSION_MIN_NAV ?? 0.95);
const POLL_MS = Number(process.env.MM_SESSION_POLL_MS ?? 60_000);
const GAMMA = Number(process.env.MM_SESSION_GAMMA ?? 0.0025);
const KAPPA = Number(process.env.MM_SESSION_KAPPA ?? 2);
const VOL_WINDOW = Number(process.env.MM_SESSION_VOL_WINDOW ?? 30);
const REPORT_EVERY = Number(process.env.MM_SESSION_REPORT_EVERY ?? BARS_PER_HOUR); // bars per sim-"hour" line
const DD_LIMIT_PCT = Number(process.env.MM_SESSION_DD_LIMIT_PCT ?? 2);

const MICROS = 1_000_000n;
const usd = (units: bigint): string => (Number(units) / 1e6).toFixed(2);
const sgn = (units: bigint): string => (units >= 0n ? '+' : '') + usd(units);
const pad = (s: string | number, n: number): string => String(s).padStart(n);

// ---- per-book wiring ---------------------------------------------------------
interface ReplayCursor {
  bars: Bar[];
  idx: number;
}

/** Resolve the configured reference data source (e.g. GeckoTerminal DEX), or undefined for Binance. */
function resolveRefSource(): IReferenceBarSource | undefined {
  if (!SOURCE) return undefined;
  const src = new ReferenceSourceRegistry(buildReferenceSources({})).get(SOURCE);
  if (!src) {
    throw new Error(
      `unknown MM_SESSION_SOURCE '${SOURCE}' — try 'geckoterminal' | 'pyth' | 'defillama' | 'bit2c' (or unset for Binance)`,
    );
  }
  return src;
}

/** Per-book quote size in 6-decimal asset units: a $ notional ÷ price when
 *  QUOTE_USD is set (correct for any asset), else the raw QUOTE_UNITS. */
function sizeForPrice(firstClose: number): bigint {
  if (QUOTE_USD > 0 && firstClose > 0) return BigInt(Math.max(1, Math.round((QUOTE_USD / firstClose) * 1e6)));
  return QUOTE_UNITS;
}

function makeBook(symbol: string, quoteUnits: bigint, nextBar: (s: string) => Promise<Bar | null>, warmupCloses?: (s: string) => Promise<number[]>): MmBook {
  const quoter = mmStrategyRegistry.build(STRATEGY, {
    quoteSizeUnits: quoteUnits,
    minHalfSpreadBps: MIN_BPS,
    maxHalfSpreadBps: MAX_BPS,
    maxInventoryLots: MAX_LOTS,
  });
  return new MmBook({
    symbol,
    strategyId: STRATEGY,
    quoter,
    quoteSizeUnits: quoteUnits,
    gamma: GAMMA,
    kappa: KAPPA,
    horizonBars: 1,
    volWindowBars: VOL_WINDOW,
    volFloor: 0.0001,
    makerFeeBps: MAKER_BPS,
    capitalUnits: CAPITAL_UNITS,
    nextBar,
    warmupCloses,
    riskGate: new CompositeRiskGate({
      maxInventoryUnits: quoteUnits * BigInt(MAX_LOTS), // the real conservation lever: cap the position
      minNavRatio: MIN_NAV, // protective drawdown stop
      vpinPauseThreshold: 2,
      vpinPauseMs: 30_000,
      // Cumulative one-bar mark-out adverse over a long run is large by construction;
      // keep this pause well clear so the session isn't halted artificially. The
      // demonstrated protections are the inventory cap + the nav stop above.
      maxAdverseUnits: 1_000_000_000_000_000n,
      adversePauseMs: 30_000,
    }),
  });
}

// ---- desk aggregation + reporting -------------------------------------------
interface DeskAgg {
  realised: bigint;
  unrealised: bigint;
  fees: bigint; // signed at the driving MAKER_BPS
  structural: bigint; // realised + unrealised (0 bps)
  rebateNet: bigint; // structural − fees(−1)
  costNet: bigint; // structural − fees(+1)
  equityStructural: bigint; // Σcapital + structural
  fills: number;
  capital: bigint;
}

/** Net P&L at an arbitrary maker fee, derived from the driving book's components. */
function netAtBps(structural: bigint, feesAtDriving: bigint, bps: number): bigint {
  if (MAKER_BPS === 0) return structural; // can't scale from a zero driving fee
  // feesAtDriving = perBps · MAKER_BPS  ⇒  fees(bps) = feesAtDriving · bps / MAKER_BPS
  const feesAt = (feesAtDriving * BigInt(Math.round(bps * 1000))) / BigInt(Math.round(MAKER_BPS * 1000));
  return structural - feesAt;
}

function aggregate(books: MmBook[]): DeskAgg {
  let realised = 0n;
  let unrealised = 0n;
  let fees = 0n;
  let fills = 0;
  let capital = 0n;
  for (const b of books) {
    const s = b.snapshot();
    realised += BigInt(s.realisedPnlUnits);
    unrealised += BigInt(s.unrealisedPnlUnits);
    fees += BigInt(s.feesUnits);
    fills += s.fills;
    capital += BigInt(s.capitalUnits);
  }
  const structural = realised + unrealised;
  return {
    realised,
    unrealised,
    fees,
    structural,
    rebateNet: netAtBps(structural, fees, -1),
    costNet: netAtBps(structural, fees, +1),
    equityStructural: capital + structural,
    fills,
    capital,
  };
}

interface CurvePoint {
  label: string;
  agg: DeskAgg;
  ddPct: number;
}

function header(): void {
  console.log(`\n=== Meridian MM paper session — ${MODE.toUpperCase()} ===`);
  console.log(`  feed: ${SOURCE ? `${SOURCE} (DEX/reference)` : 'Binance public'} | bar: ${INTERVAL}`);
  const lotLabel = QUOTE_USD > 0 ? `$${QUOTE_USD.toLocaleString()} notional/quote` : `$${usd(QUOTE_UNITS)}`;
  const maxInvLabel = QUOTE_USD > 0 ? `${MAX_LOTS} lots ($${(MAX_LOTS * QUOTE_USD).toLocaleString()}/book)` : `${MAX_LOTS} lots ($${usd(QUOTE_UNITS * BigInt(MAX_LOTS))})`;
  console.log(
    `  books: ${SYMBOLS.join(',')} | quoter: ${STRATEGY} | lot: ${lotLabel} | cap/book: $${usd(CAPITAL_UNITS)} | ` +
      `maxInv: ${maxInvLabel} | driving maker: ${MAKER_BPS}bps`,
  );
  console.log(`  horizon: ${HOURS}h | desk capital: $${usd(CAPITAL_UNITS * BigInt(SYMBOLS.length))}`);
}

function reportLine(label: string, agg: DeskAgg, ddPct: number): void {
  console.log(
    `  ${label.padEnd(10)} structural=${sgn(agg.structural).padStart(10)}  ` +
      `rebate(−1bps)=${sgn(agg.rebateNet).padStart(10)}  cost(+1bps)=${sgn(agg.costNet).padStart(10)}  ` +
      `| fills=${pad(agg.fills, 6)}  maxDD=${ddPct.toFixed(3)}%`,
  );
}

function finalReport(books: MmBook[], curve: CurvePoint[], deskMaxDDpct: number): void {
  console.log(`\n=== per-book breakdown (driving maker ${MAKER_BPS}bps) ===`);
  console.log('  symbol  fills  fillRate  spread     adverse    fees      structural  rebateNet  maxDD%   endInv');
  for (const b of books) {
    const s = b.snapshot();
    const structural = BigInt(s.realisedPnlUnits) + BigInt(s.unrealisedPnlUnits);
    const fillRate = s.barsSeen > 0 ? s.fills / s.barsSeen : 0;
    console.log(
      `  ${s.symbol.padEnd(6)}  ${pad(s.fills, 4)}  ${fillRate.toFixed(3).padStart(7)}  ` +
        `${sgn(BigInt(s.spreadCapturedUnits)).padStart(9)}  ${sgn(BigInt(s.adverseSelectionUnits)).padStart(9)}  ` +
        `${sgn(BigInt(s.feesUnits)).padStart(8)}  ${sgn(structural).padStart(10)}  ${sgn(BigInt(s.netPnlUnits)).padStart(9)}  ` +
        `${s.maxDrawdownPct.toFixed(3).padStart(6)}  ${usd(BigInt(s.inventoryUnits)).padStart(9)}`,
    );
  }

  const final = aggregate(books);
  const deskCapital = final.capital;
  const pct = (units: bigint): string => ((Number(units) / Number(deskCapital)) * 100).toFixed(4) + '%';

  // Stability: fraction of hourly buckets whose cumulative STRUCTURAL net was ≥ 0.
  const nonNeg = curve.filter((p) => p.agg.structural >= 0n).length;
  const stableFrac = curve.length ? nonNeg / curve.length : 0;

  console.log(`\n=== DESK TOTAL on $${usd(deskCapital)} capital ===`);
  console.log(`  structural (0bps, no fee/no rebate) : ${sgn(final.structural)}  (${pct(final.structural)})  ← the real edge`);
  console.log(`  rebate net (−1bps VIP maker)        : ${sgn(final.rebateNet)}  (${pct(final.rebateNet)})`);
  console.log(`  cost net   (+1bps retail maker)     : ${sgn(final.costNet)}  (${pct(final.costNet)})`);
  console.log(`  fills: ${final.fills}  |  spread − adverse is the structural engine; the rebate is a tier subsidy.`);

  console.log(`\n=== CONSERVATION (judged on the structural equity curve) ===`);
  const ddVerdict = deskMaxDDpct <= DD_LIMIT_PCT ? 'PASS' : 'FAIL';
  const profitVerdict = final.structural > 0n ? 'PASS' : 'FAIL';
  console.log(`  desk max drawdown (structural): ${deskMaxDDpct.toFixed(4)}%  (limit ${DD_LIMIT_PCT}%)  → ${ddVerdict}`);
  console.log(`  structural net > 0            : ${final.structural > 0n ? 'yes' : 'no'}  → ${profitVerdict}`);
  console.log(`  hourly buckets w/ cum. structural ≥ 0: ${nonNeg}/${curve.length}  (${(stableFrac * 100).toFixed(0)}% — stability)`);

  console.log(`\n  CAVEATS (read every number through these):`);
  console.log(`   • Fills are fill-on-touch (front-of-queue) — an UPPER BOUND, not a promise (fill-model.ts).`);
  console.log(`   • The −1bps rebate is a Binance VIP maker tier; a retail maker may pay +1bps (the cost column).`);
  console.log(`   • Replay is real history but a single window; the live mode is the true multi-hour proof.`);
}

// ---- modes ------------------------------------------------------------------
async function runReplay(): Promise<void> {
  const refSource = resolveRefSource();
  const client = refSource ? null : new BinancePublicClient({ quote: 'USDT' });
  const endMs = Date.now();
  const startMs = endMs - Math.round(HOURS * 60 * 60 * 1000);
  // A reference source has no (start,end) history call — request the last N bars.
  const refLimit = Math.min(1000, Math.max(VOL_WINDOW + 10, Math.ceil(HOURS * BARS_PER_HOUR)));

  console.log(`\n=== backfill ${HOURS}h of real ${INTERVAL} history via ${refSource ? refSource.label : 'Binance public'} ===`);
  const cursors = new Map<string, ReplayCursor>();
  let maxLen = 0;
  for (const sym of SYMBOLS) {
    const bars = refSource
      ? await refSource.klines(sym, INTERVAL, refLimit).catch(() => [] as Bar[])
      : await client!.historicalKlines(sym, INTERVAL, startMs, endMs);
    cursors.set(sym, { bars, idx: 0 });
    maxLen = Math.max(maxLen, bars.length);
    const last = bars[bars.length - 1];
    const mkt = refSource ? sym : `${sym}USDT`;
    console.log(`  ${mkt}: ${bars.length} bars${last ? `, last close ${last.close} @ ${last.timestamp.toISOString()}` : ' (none)'}`);
  }

  const nextBar = async (s: string): Promise<Bar | null> => {
    const c = cursors.get(s);
    if (!c || c.idx >= c.bars.length) return null;
    return c.bars[c.idx++];
  };
  // Size each book by $ notional ÷ its first close (no warmupCloses: first VOL_WINDOW bars warm σ).
  const books = SYMBOLS.map((s) => {
    const c = cursors.get(s);
    const firstClose = c && c.bars.length ? c.bars[0].close : 1;
    return makeBook(s, sizeForPrice(firstClose), nextBar);
  });

  header();
  console.log(`\n=== replaying ${maxLen} bars (${(maxLen / BARS_PER_HOUR).toFixed(1)} sim-hours) — one line per ${REPORT_EVERY} bars ===`);

  let deskPeakStructural = CAPITAL_UNITS * BigInt(SYMBOLS.length);
  let deskMaxDDpct = 0;
  const curve: CurvePoint[] = [];

  for (let i = 0; i < maxLen; i++) {
    for (const b of books) await b.tick();
    const agg = aggregate(books);
    if (agg.equityStructural > deskPeakStructural) deskPeakStructural = agg.equityStructural;
    const ddPct = deskPeakStructural > 0n ? (Number(deskPeakStructural - agg.equityStructural) / Number(deskPeakStructural)) * 100 : 0;
    if (ddPct > deskMaxDDpct) deskMaxDDpct = ddPct;

    if ((i + 1) % REPORT_EVERY === 0 || i === maxLen - 1) {
      const simH = Math.floor((i + 1) / BARS_PER_HOUR);
      const simM = Math.round(((i + 1) % BARS_PER_HOUR) * (60 / BARS_PER_HOUR));
      const label = `t+${pad(simH, 2)}h${pad(simM, 2)}m`;
      reportLine(label, agg, deskMaxDDpct);
      curve.push({ label, agg, ddPct: deskMaxDDpct });
    }
  }

  finalReport(books, curve, deskMaxDDpct);
  console.log('\nSESSION OK (replay)');
}

async function runLive(): Promise<void> {
  const refSource = resolveRefSource();
  const client = refSource ? null : new BinancePublicClient({ quote: 'USDT' });
  const feed: IBarFeed = refSource ? new ReferenceBarFeed(refSource, INTERVAL) : new BinancePublicBarFeed(client!, INTERVAL);
  const nextBar = (s: string): Promise<Bar | null> => feed.nextBar(s);
  const warmupCloses = refSource
    ? async (s: string): Promise<number[]> => (await refSource.klines(s, INTERVAL, VOL_WINDOW + 90).catch(() => [] as Bar[])).map((b) => b.close)
    : async (s: string): Promise<number[]> => (await client!.klines(s, INTERVAL, VOL_WINDOW + 90)).map((b) => b.close);
  // Notional sizing needs a current price per symbol; probe one (only when QUOTE_USD is on).
  const books: MmBook[] = [];
  for (const s of SYMBOLS) {
    let quoteUnits = QUOTE_UNITS;
    if (QUOTE_USD > 0) {
      const probe = refSource ? await refSource.klines(s, INTERVAL, 1).catch(() => [] as Bar[]) : await client!.klines(s, INTERVAL, 1);
      quoteUnits = sizeForPrice(probe[probe.length - 1]?.close ?? 1);
    }
    books.push(makeBook(s, quoteUnits, nextBar, warmupCloses));
  }
  for (const b of books) await b.warmup();

  header();
  const endAt = Date.now() + Math.round(HOURS * 60 * 60 * 1000);
  console.log(`\n=== LIVE — polling every ${(POLL_MS / 1000).toFixed(0)}s until ${new Date(endAt).toISOString()} ===`);

  let deskPeakStructural = CAPITAL_UNITS * BigInt(SYMBOLS.length);
  let deskMaxDDpct = 0;
  const curve: CurvePoint[] = [];
  let polls = 0;
  let lastReportAt = 0;

  while (Date.now() < endAt) {
    for (const b of books) await b.tick();
    polls++;
    const agg = aggregate(books);
    if (agg.equityStructural > deskPeakStructural) deskPeakStructural = agg.equityStructural;
    const ddPct = deskPeakStructural > 0n ? (Number(deskPeakStructural - agg.equityStructural) / Number(deskPeakStructural)) * 100 : 0;
    if (ddPct > deskMaxDDpct) deskMaxDDpct = ddPct;

    // Report roughly once per simulated "hour" of wall-clock, or every 30 polls.
    if (polls - lastReportAt >= Math.max(1, Math.round((60 * 60 * 1000) / POLL_MS)) || polls === 1) {
      const mins = Math.round((Date.now() - (endAt - HOURS * 60 * 60 * 1000)) / 60000);
      const label = `+${pad(mins, 3)}m`;
      reportLine(label, agg, deskMaxDDpct);
      curve.push({ label, agg, ddPct: deskMaxDDpct });
      lastReportAt = polls;
    }
    if (Date.now() >= endAt) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  finalReport(books, curve, deskMaxDDpct);
  console.log(`\nSESSION OK (live, ${polls} polls)`);
}

async function main(): Promise<void> {
  if (!mmStrategyRegistry.has(STRATEGY)) throw new Error(`unknown MM strategy '${STRATEGY}' — try mm-glft | mm-avellaneda-stoikov | mm-symmetric`);
  if (MODE === 'live') await runLive();
  else await runReplay();
  process.exit(0);
}

main().catch((e) => {
  console.error('\nSESSION FAIL:', e?.message ?? e);
  process.exit(1);
});
