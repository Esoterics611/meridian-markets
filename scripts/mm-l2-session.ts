/**
 * mm-l2-session — the QUEUE-AWARE market-making session: poll Hyperliquid's
 * public `l2Book` (20×20 depth, no key) live, build a real L2 tape, and run the
 * LobReplayHarness so fills are FIFO queue-aware instead of fill-on-touch. This is
 * the honest counterpart to scripts/mm-paper-session.ts: where that one fills the
 * instant a quote price is touched (an UPPER BOUND on fills, course §1.6), this
 * fills a resting maker order only once the size that was AHEAD of it at its price
 * level has actually been consumed by aggressive flow. It is the single biggest
 * backtest-fidelity upgrade and the thing standing between "−0.6% conserved" and a
 * real verdict on whether the HL maker-rebate CLOB nets positive.
 *
 * The headline number: queueFills vs touchFills — how much fill-on-touch overstated.
 * The structural net is then judged on the queue-aware fills, against the −0.2bps HL
 * maker rebate (the ≤0bps order-book venue the AS/GLFT book was built for).
 *
 * WHY LIVE (not replay): HL's `l2Book` gives a snapshot but NO history, and an honest
 * queue depth cannot be reconstructed from OHLC candles (the candle has no spread or
 * depth). So a real tape is built by POLLING the live book over a session. Each poll
 * is one tape step: REAL time-varying depth + the REAL aggressive flow that arrived
 * over the interval, drained from the HL trades WebSocket (per-trade prints, signed by
 * HL's taker side — `openTradeStream`). This replaces the old candle-volume estimate;
 * the estimate remains only as a warmup/no-egress fallback (MM_L2_TRADES_WS=false).
 *
 * Run (quick smoke — ~30s, 6 polls at 5s; thin tape, proves the path):
 *   MM_L2_POLL_S=5 MM_L2_DURATION_MIN=0.5 \
 *     npx ts-node -r tsconfig-paths/register scripts/mm-l2-session.ts
 * Run (a real read — poll once a minute for 2 hours on your own box):
 *   MM_L2_POLL_S=60 MM_L2_DURATION_MIN=120 MM_L2_COINS=BTC,ETH,SOL \
 *     npx ts-node -r tsconfig-paths/register scripts/mm-l2-session.ts
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { Bar } from '../src/stat-arb/backtest/bar';
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';
import { ITradeStream } from '../src/market-data/reference/reference-source.interface';
import { HyperliquidFundingClient } from '../src/market-data/funding/hyperliquid-funding-client';
import { mmStrategyRegistry } from '../src/market-making/registry/mm-strategy-registry';
import { CompositeRiskGate } from '../src/market-making/risk/risk-gate';
import { LobReplayHarness, LobReplayConfig, LobReplayMetrics } from '../src/market-making/backtest/lob-replay';
import { L2TapeStep, l2SnapshotToOrderBook } from '../src/market-making/backtest/l2-tape';
import { serializeTape } from '../src/market-making/backtest/l2-tape-io';
import { midMicros } from '../src/market-making/microstructure/order-book';
import { IQuoter } from '../src/market-making/quote/quoter.interface';

// ---- config -----------------------------------------------------------------
const COINS = (process.env.MM_L2_COINS ?? 'BTC,ETH,SOL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const STRATEGY = process.env.MM_L2_STRATEGY ?? 'mm-glft';
const INTERVAL = process.env.MM_L2_INTERVAL ?? '1m'; // candle interval used for the volume estimate
const POLL_S = Number(process.env.MM_L2_POLL_S ?? 60);
const DURATION_MIN = Number(process.env.MM_L2_DURATION_MIN ?? 20);
const QUOTE_USD = Number(process.env.MM_L2_QUOTE_USD ?? 50_000);
const CAPITAL_USD = Number(process.env.MM_L2_CAPITAL_USD ?? 1_000_000);
const MAKER_BPS = Number(process.env.MM_L2_MAKER_BPS ?? -0.2); // HL maker rebate (signed; driving fee)
const MAX_LOTS = Number(process.env.MM_L2_MAX_LOTS ?? 8);
const MIN_BPS = Number(process.env.MM_L2_MIN_BPS ?? 1);
const MAX_BPS = Number(process.env.MM_L2_MAX_BPS ?? 200);
const GAMMA = Number(process.env.MM_L2_GAMMA ?? 0.0025);
const KAPPA = Number(process.env.MM_L2_KAPPA ?? 2);
const VOL_WINDOW = Number(process.env.MM_L2_VOL_WINDOW ?? 20);
const MIN_NAV = Number(process.env.MM_L2_MIN_NAV ?? 0.9);
const AGGRESSOR_SPLIT = Number(process.env.MM_L2_AGGRESSOR_SPLIT ?? 0.6); // fraction of interval volume to the up/down-tick side
const DD_LIMIT_PCT = Number(process.env.MM_L2_DD_LIMIT_PCT ?? 2);
// REAL aggressor flow from the HL trades WS (replaces the candle-volume estimate).
// On by default — it's the whole point of the queue-aware harness; set to 'false'
// to force the legacy candle estimate (e.g. an env with no WS egress).
const TRADES_WS = (process.env.MM_L2_TRADES_WS ?? 'true').toLowerCase() !== 'false';
// Accrue real HL funding on held inventory (MM course §8.10). On by default; the
// live hourly rate is fetched per coin at startup and applied pro-rata each step.
const FUNDING = (process.env.MM_L2_FUNDING ?? 'true').toLowerCase() !== 'false';

const MICROS = 1_000_000n;
const usd = (units: bigint): string => (Number(units) / 1e6).toFixed(2);
const sgn = (units: bigint): string => (units >= 0n ? '+' : '') + usd(units);
const pad = (s: string | number, n: number): string => String(s).padStart(n);
const intervalSeconds = (iv: string): number => (iv.endsWith('h') ? 3600 : iv.endsWith('d') ? 86400 : 60) * (parseInt(iv, 10) || 1);

interface BookState {
  coin: string;
  quoter: IQuoter;
  quoteUnits: bigint;
  riskGate: CompositeRiskGate;
  tape: L2TapeStep[];
  lastMidMicros?: bigint;
  candleVolPerSec: number; // base-asset units/sec, refreshed each minute
  candleHighMicros?: bigint; // real traded high of the current candle (touch gate)
  candleLowMicros?: bigint; // real traded low of the current candle (touch gate)
  candleMinute: number; // wall-minute the candle was last refreshed for
  stepsReal: number; // tape steps fed by REAL trades-WS aggressor flow
  stepsEst: number; // tape steps that fell back to the candle estimate
  fundingRatePerHour: number; // live HL funding rate (signed; + longs pay shorts)
}

function makeQuoter(quoteUnits: bigint): IQuoter {
  return mmStrategyRegistry.build(STRATEGY, {
    quoteSizeUnits: quoteUnits,
    minHalfSpreadBps: MIN_BPS,
    maxHalfSpreadBps: MAX_BPS,
    maxInventoryLots: MAX_LOTS,
  });
}

function makeRiskGate(quoteUnits: bigint): CompositeRiskGate {
  return new CompositeRiskGate({
    maxInventoryUnits: quoteUnits * BigInt(MAX_LOTS),
    minNavRatio: MIN_NAV,
    vpinPauseThreshold: 2,
    vpinPauseMs: 30_000,
    maxAdverseUnits: 1_000_000_000_000_000n,
    adversePauseMs: 30_000,
  });
}

function cfgFor(s: BookState): LobReplayConfig {
  return {
    tape: s.tape,
    quoter: s.quoter,
    quoteSizeUnits: s.quoteUnits,
    gamma: GAMMA,
    kappa: KAPPA,
    horizonBars: 1,
    volWindowBars: VOL_WINDOW,
    volFloor: 0.0001,
    makerFeeBps: MAKER_BPS,
    capitalUnits: BigInt(Math.round(CAPITAL_USD * 1e6)),
    symbol: s.coin,
    riskGate: s.riskGate,
    fundingRatePerHour: FUNDING ? s.fundingRatePerHour : 0,
  };
}

// ---- fee-sweep helpers (mirror mm-paper-session) -----------------------------
function netAtBps(structural: bigint, feesAtDriving: bigint, bps: number): bigint {
  if (MAKER_BPS === 0) return structural;
  const feesAt = (feesAtDriving * BigInt(Math.round(bps * 1000))) / BigInt(Math.round(MAKER_BPS * 1000));
  return structural - feesAt;
}

async function refreshCandle(client: HyperliquidClient, s: BookState): Promise<void> {
  const minute = Math.floor(Date.now() / 60_000);
  if (minute === s.candleMinute) return;
  const bars: Bar[] = await client.klines(s.coin, INTERVAL, 2).catch(() => [] as Bar[]);
  const last = bars[bars.length - 1];
  if (last) {
    s.candleVolPerSec = last.volume / intervalSeconds(INTERVAL);
    s.candleHighMicros = BigInt(Math.round(last.high * 1e6));
    s.candleLowMicros = BigInt(Math.round(last.low * 1e6));
    s.candleMinute = minute;
  }
}

async function poll(client: HyperliquidClient, s: BookState, dtSec: number, stream?: ITradeStream): Promise<bigint | undefined> {
  const snap = await client.l2Snapshot(s.coin).catch(() => undefined);
  if (!snap) return undefined;
  const book = l2SnapshotToOrderBook(snap);
  const mid = midMicros(book);
  if (mid === undefined) return undefined;
  const u = (x: number): bigint => BigInt(Math.max(0, Math.round(x * 1e6)));

  // REAL aggressor flow first: drain the trades-WS accumulator for this coin. If it
  // saw prints this interval, use the real taker buy/sell volume AND the real traded
  // extremes (exact between polls, not a 1m-candle proxy). Only fall back to the
  // candle-volume estimate when the stream is off or saw no prints (e.g. warmup).
  const flow = stream?.drain(s.coin);
  let aggressiveBuyUnits: bigint;
  let aggressiveSellUnits: bigint;
  let tradedHighMicros: bigint | undefined;
  let tradedLowMicros: bigint | undefined;
  if (flow && flow.tradeCount > 0) {
    aggressiveBuyUnits = flow.aggressiveBuyUnits;
    aggressiveSellUnits = flow.aggressiveSellUnits;
    tradedHighMicros = flow.highMicros;
    tradedLowMicros = flow.lowMicros;
    s.stepsReal++;
  } else {
    await refreshCandle(client, s);
    const intervalUnits = Math.max(0, s.candleVolPerSec * dtSec);
    const up = s.lastMidMicros === undefined ? null : mid > s.lastMidMicros ? true : mid < s.lastMidMicros ? false : null;
    const buyFrac = up === true ? AGGRESSOR_SPLIT : up === false ? 1 - AGGRESSOR_SPLIT : 0.5;
    aggressiveBuyUnits = u(intervalUnits * buyFrac);
    aggressiveSellUnits = u(intervalUnits * (1 - buyFrac));
    tradedHighMicros = s.candleHighMicros;
    tradedLowMicros = s.candleLowMicros;
    s.stepsEst++;
  }

  const step: L2TapeStep = {
    book, // REAL time-varying depth → real queue
    aggressiveBuyUnits,
    aggressiveSellUnits,
    // Touch gate: our bid fills only if a trade actually printed down to it (low ≤ bid),
    // our ask only if a print reached up to it (high ≥ ask). Real per-poll extremes when
    // the trades WS fed this step; the matching candle's extremes on the estimate path.
    tradedHighMicros,
    tradedLowMicros,
  };
  s.tape.push(step);
  s.lastMidMicros = mid;
  return mid;
}

// ---- reporting --------------------------------------------------------------
function reportCoin(coin: string, quoteUnits: bigint, m: LobReplayMetrics): void {
  const structural = m.realisedPnlUnits + m.unrealisedPnlUnits;
  console.log(
    `  ${coin.padEnd(5)}  steps=${pad(m.steps, 4)}  quoting=${pad(m.quotingSteps, 4)}  ` +
      `touchFills=${pad(m.touchFills, 5)}  queueFills=${pad(m.queueFills, 5)}  ratio=${m.fillRatio.toFixed(3)}  ` +
      `| spread=${sgn(m.attribution.spreadCapturedUnits).padStart(9)}  adverse=${sgn(m.attribution.adverseSelectionUnits).padStart(9)}  ` +
      `struct=${sgn(structural).padStart(9)}  net=${sgn(m.netPnlUnits).padStart(9)}  maxDD=${m.maxDrawdownPct.toFixed(3)}%`,
  );
}

function finalReport(states: BookState[], metrics: Map<string, LobReplayMetrics>): void {
  console.log(`\n=== per-coin QUEUE-AWARE result (driving HL maker ${MAKER_BPS}bps) ===`);
  console.log('  coin   steps      quoting   touchFills  queueFills  ratio   | spread      adverse     struct      net         maxDD');
  let deskStruct = 0n;
  let deskFees = 0n;
  let deskCap = 0n;
  let deskTouch = 0;
  let deskQueue = 0;
  let deskMaxDD = 0;
  let deskReal = 0;
  let deskEst = 0;
  let deskFunding = 0n;
  for (const s of states) {
    const m = metrics.get(s.coin);
    if (!m) continue;
    reportCoin(s.coin, s.quoteUnits, m);
    deskStruct += m.realisedPnlUnits + m.unrealisedPnlUnits;
    deskFees += m.feesUnits;
    deskFunding += m.fundingUnits;
    deskCap += BigInt(Math.round(CAPITAL_USD * 1e6));
    deskTouch += m.touchFills;
    deskQueue += m.queueFills;
    deskReal += s.stepsReal;
    deskEst += s.stepsEst;
    if (m.maxDrawdownPct > deskMaxDD) deskMaxDD = m.maxDrawdownPct;
  }

  const ratio = deskTouch > 0 ? deskQueue / deskTouch : 0;
  const pct = (units: bigint): string => (deskCap > 0n ? ((Number(units) / Number(deskCap)) * 100).toFixed(4) : '0') + '%';
  console.log(`\n=== DESK TOTAL on $${usd(deskCap)} capital ===`);
  console.log(`  THE HONESTY NUMBER: fill-on-touch logged ${deskTouch} fills; queue-aware logged ${deskQueue} (ratio ${ratio.toFixed(3)}).`);
  console.log(`    → a fill-on-touch backtest overstated fills by ${deskQueue > 0 ? (deskTouch / deskQueue).toFixed(1) : '∞'}×.`);
  const structPlusFunding = deskStruct + deskFunding;
  console.log(`  structural (0bps, no fee/no rebate) : ${sgn(deskStruct)}  (${pct(deskStruct)})  ← the trading edge (spread − adverse)`);
  if (FUNDING) {
    console.log(`  funding (held inventory)            : ${sgn(deskFunding)}  (${pct(deskFunding)})  ← perp carry on inventory held`);
    console.log(`  structural + funding                : ${sgn(structPlusFunding)}  (${pct(structPlusFunding)})  ← the real edge incl. carry`);
  }
  console.log(`  rebate net (${MAKER_BPS}bps HL maker)${FUNDING ? ' + funding' : '       '}: ${sgn(netAtBps(deskStruct, deskFees, MAKER_BPS) + deskFunding)}  (${pct(netAtBps(deskStruct, deskFees, MAKER_BPS) + deskFunding)})`);
  console.log(`  cost net   (+1bps retail maker)${FUNDING ? '+ funding' : '     '}: ${sgn(netAtBps(deskStruct, deskFees, 1) + deskFunding)}  (${pct(netAtBps(deskStruct, deskFees, 1) + deskFunding)})`);

  console.log(`\n=== CONSERVATION (judged on queue-aware structural P&L${FUNDING ? ' incl. funding' : ''}) ===`);
  const ddVerdict = deskMaxDD <= DD_LIMIT_PCT ? 'PASS' : 'FAIL';
  const edge = FUNDING ? structPlusFunding : deskStruct;
  const profitVerdict = edge > 0n ? 'PASS' : 'FAIL';
  console.log(`  desk max drawdown: ${deskMaxDD.toFixed(4)}%  (limit ${DD_LIMIT_PCT}%)  → ${ddVerdict}`);
  console.log(`  ${FUNDING ? 'structural+funding' : 'structural'} net > 0: ${edge > 0n ? 'yes' : 'no'}  → ${profitVerdict}`);

  const totSteps = deskReal + deskEst;
  const realPct = totSteps > 0 ? ((deskReal / totSteps) * 100).toFixed(0) : '0';
  console.log(`\n  AGGRESSOR-FLOW SOURCE: ${deskReal} steps REAL (HL trades WS) / ${deskEst} estimated  (${realPct}% real).`);
  console.log(`\n  CAVEATS (read every number through these):`);
  if (deskEst > 0) {
    console.log(`   • ${deskEst} step(s) fell back to the candle-volume ESTIMATE (1m volume × mid tick, split`);
    console.log(`     ${AGGRESSOR_SPLIT}/${(1 - AGGRESSOR_SPLIT).toFixed(1)}) — typically WS warmup; real prints feed the rest. Depth is always REAL l2Book.`);
  } else {
    console.log(`   • Aggressive volume + traded extremes are REAL per-trade prints (HL trades WS); depth is REAL l2Book.`);
  }
  console.log(`   • queueFills is a realistic LOWER-ish bound (strict FIFO, queue priority kept only while`);
  console.log(`     the quote price is unchanged); touchFills is the upper bound. Truth is between.`);
  if (FUNDING) {
    console.log(`   • Funding accrues on held inventory at the LIVE hourly rate captured at startup (static over`);
    console.log(`     the run, pro-rated per step); a real multi-hour book sees the rate drift — re-read for precision.`);
  }
  console.log(`   • A short session is a thin tape — run --DURATION_MIN 120+ at POLL_S 60 for a real read.`);
}

// ---- main -------------------------------------------------------------------
async function main(): Promise<void> {
  if (!mmStrategyRegistry.has(STRATEGY)) throw new Error(`unknown MM strategy '${STRATEGY}' — try mm-glft | mm-avellaneda-stoikov | mm-symmetric`);
  const client = new HyperliquidClient({ baseUrl: process.env.HYPERLIQUID_BASE_URL });

  console.log(`\n=== Meridian MM L2 session — Hyperliquid (queue-aware fills) ===`);
  console.log(`  coins: ${COINS.join(',')} | quoter: ${STRATEGY} | lot: $${QUOTE_USD.toLocaleString()}/quote | cap/book: $${CAPITAL_USD.toLocaleString()}`);
  console.log(`  poll: ${POLL_S}s | duration: ${DURATION_MIN}min | driving HL maker: ${MAKER_BPS}bps | maxInv: ${MAX_LOTS} lots`);

  // Probe each coin once to size the quote by $ notional ÷ price, and read the live
  // HL funding rate (hourly, signed) to accrue on held inventory (MM course §8.10).
  const fundingClient = new HyperliquidFundingClient({ baseUrl: process.env.HYPERLIQUID_BASE_URL });
  const states: BookState[] = [];
  for (const coin of COINS) {
    const snap = await client.l2Snapshot(coin).catch(() => undefined);
    const mid = snap ? midMicros(l2SnapshotToOrderBook(snap)) : undefined;
    const price = mid ? Number(mid) / 1e6 : 0;
    if (!price) {
      console.log(`  ${coin}: no L2 snapshot — skipping`);
      continue;
    }
    const fundingRatePerHour = FUNDING ? await fundingClient.currentFunding(coin).then((f) => f.lastFundingRate).catch(() => 0) : 0;
    const quoteUnits = BigInt(Math.max(1, Math.round((QUOTE_USD / price) * 1e6)));
    states.push({
      coin,
      quoter: makeQuoter(quoteUnits),
      quoteUnits,
      riskGate: makeRiskGate(quoteUnits),
      tape: [],
      candleVolPerSec: 0,
      candleMinute: -1,
      stepsReal: 0,
      stepsEst: 0,
      fundingRatePerHour,
    });
    console.log(
      `  ${coin}: mid $${price.toFixed(2)} → quote ${(QUOTE_USD / price).toFixed(5)} ${coin} ($${QUOTE_USD.toLocaleString()})` +
        `${FUNDING ? `  funding ${(fundingRatePerHour * 10_000).toFixed(3)}bps/h` : ''}`,
    );
  }
  if (states.length === 0) throw new Error('no quotable coins — check connectivity / coin names');

  // Open the REAL aggressor stream (HL trades WS) for all coins at once; it warms up
  // while we poll, and each poll drains the prints accumulated since the last one.
  const tradeStream: ITradeStream | undefined = TRADES_WS ? client.openTradeStream(states.map((s) => s.coin)) : undefined;
  console.log(`  aggressor flow: ${tradeStream ? 'REAL (HL trades WS)' : 'ESTIMATE (1m candle volume × mid tick)'}`);

  const endAt = Date.now() + Math.round(DURATION_MIN * 60_000);
  let polls = 0;
  let lastPollAt = Date.now();
  console.log(`\n=== polling l2Book until ${new Date(endAt).toISOString()} ===`);
  while (Date.now() < endAt) {
    const now = Date.now();
    const dtSec = polls === 0 ? POLL_S : Math.max(1, (now - lastPollAt) / 1000);
    lastPollAt = now;
    const mids: string[] = [];
    for (const s of states) {
      const mid = await poll(client, s, dtSec, tradeStream);
      mids.push(`${s.coin} ${mid ? (Number(mid) / 1e6).toFixed(2) : '—'} (d${s.tape[s.tape.length - 1]?.book.bids.length ?? 0}×${s.tape[s.tape.length - 1]?.book.asks.length ?? 0})`);
    }
    polls++;
    console.log(`  poll ${pad(polls, 3)} @ ${new Date(now).toISOString().slice(11, 19)}  ${mids.join('  ')}`);
    if (Date.now() >= endAt) break;
    await new Promise((r) => setTimeout(r, POLL_S * 1000));
  }
  tradeStream?.close();

  // Persist the captured tape(s) so scripts/mm-l2-tune.ts can sweep γ/κ over the
  // SAME real flow (capture-once, sweep-many). One file per coin: `${path}-${coin}.json`.
  const savePath = (process.env.MM_L2_SAVE_TAPE ?? '').trim();
  if (savePath) {
    mkdirSync(dirname(`${savePath}-x`), { recursive: true });
    for (const s of states) {
      if (s.tape.length === 0) continue;
      const file = `${savePath}-${s.coin}.json`;
      writeFileSync(file, serializeTape(s.tape, s.coin));
      console.log(`  saved ${s.tape.length}-step tape → ${file}`);
    }
  }

  console.log(`\n=== captured ${polls} polls; running the LobReplayHarness ===`);
  const harness = new LobReplayHarness();
  const metrics = new Map<string, LobReplayMetrics>();
  for (const s of states) metrics.set(s.coin, harness.run(cfgFor(s)));
  finalReport(states, metrics);
  console.log(`\nSESSION OK (${polls} polls)`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nSESSION FAIL:', e?.message ?? e);
  process.exit(1);
});
