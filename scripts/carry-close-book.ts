/**
 * carry-close-book — operator utility: close ONE persisted carry book at live mids,
 * through the book's own accounting (restore → replay the venue's settled funding
 * over the offline gap → close taker-at-mid with the desk's slippage model →
 * persist status=CLOSED with the final realised P&L).
 *
 * Built for the #92 LIT remediation (ticker collision: HL "LIT" is Lighter, Binance
 * "LITUSDT" is Litentry — a naked cross-asset bet, not carry) but general: any OPEN
 * row in carry_book_state can be closed out-of-band when the desk process is down.
 *
 * ONLY run this while the desk process is DOWN — a live runner would checkpoint the
 * book right back to OPEN over this close.
 *
 * The close is judged honestly: the realised loss (or gain) crystallises into the
 * row's final state and MUST be included in month-end desk accounting — a
 * bug-position's loss is still the desk's paper money (CLAUDE.md §1: honesty about
 * the numbers is the entire game). Attribution (bug vs strategy) happens in the
 * journal, not by hiding the row.
 *
 * Run:
 *   CCB_SYMBOL=LIT CCB_REASON="ticker-collision (#92)" \
 *   npx ts-node -r tsconfig-paths/register scripts/carry-close-book.ts
 * Knobs: CCB_SYMBOL (required) CCB_REASON CD_NOTIONAL_USD(50000) CD_SPOT_FEE_BPS(4.5)
 *        CD_PERP_FEE_BPS(2.5) CD_SLIPPAGE_BPS(1) CD_MAX_LEVERAGE(3) DATABASE_URL_APP
 */
import { DataSource } from 'typeorm';
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';
import { CrossVenueFairValue } from '../src/market-data/cross-venue/cross-venue-fair-value';
import { HyperliquidFundingClient } from '../src/market-data/funding/hyperliquid-funding-client';
import { FundingCarryBook } from '../src/market-making/carry/funding-carry-book';
import { PostgresCarryStateStore } from '../src/market-making/carry/postgres-carry-state-store';
import { NoSlippageModel, SlippageImpactModel } from '../src/market-making/directional/fill-cost-model';

const SYMBOL = (process.env.CCB_SYMBOL ?? '').trim().toUpperCase();
const REASON = process.env.CCB_REASON ?? 'operator close';
const NOTIONAL_USD = Number(process.env.CD_NOTIONAL_USD ?? 50_000);
const SPOT_FEE_BPS = Number(process.env.CD_SPOT_FEE_BPS ?? 4.5);
const PERP_FEE_BPS = Number(process.env.CD_PERP_FEE_BPS ?? 2.5);
const SLIPPAGE_BPS = Number(process.env.CD_SLIPPAGE_BPS ?? 1);
const MAX_LEVERAGE = Number(process.env.CD_MAX_LEVERAGE ?? 3);
const DATABASE_URL_APP =
  process.env.DATABASE_URL_APP ?? 'postgresql://meridian_markets_app:meridian_markets_app@localhost:5433/meridian_markets';

const HOUR_MS = 3_600_000;
const usd = (units: bigint): string => `${Number(units) / 1e6 >= 0 ? '+' : ''}${(Number(units) / 1e6).toFixed(2)}`;
const micros = (px: number): bigint => BigInt(Math.round(px * 1e6));

async function main(): Promise<void> {
  if (!SYMBOL) {
    console.error('CCB_SYMBOL is required (e.g. CCB_SYMBOL=LIT).');
    process.exit(2);
  }

  const ds = new DataSource({
    type: 'postgres', url: DATABASE_URL_APP, entities: [], synchronize: false,
    connectTimeoutMS: 2500, extra: { connectionTimeoutMillis: 2500 },
  });
  await ds.initialize();
  const store = new PostgresCarryStateStore(ds);

  const rec = (await store.loadOpen()).find((r) => r.symbol.toUpperCase() === SYMBOL);
  if (!rec) {
    console.error(`${SYMBOL}: no OPEN row in carry_book_state — nothing to close.`);
    await ds.destroy();
    process.exit(1);
  }

  const book = new FundingCarryBook({
    symbol: rec.symbol,
    direction: rec.direction,
    notionalUsd: NOTIONAL_USD,
    spotFeeBps: SPOT_FEE_BPS,
    perpFeeBps: PERP_FEE_BPS,
    fundingPeriodMs: HOUR_MS,
    maxLeverage: MAX_LEVERAGE,
    fillModel: SLIPPAGE_BPS > 0
      ? new SlippageImpactModel({ halfSpreadBps: SLIPPAGE_BPS, impactBpsPerMillionUsd: 0 })
      : new NoSlippageModel(),
    onEvent: (e) => console.log(`  ${new Date(e.ts).toISOString().slice(11, 19)} ${e.message}`),
  });
  book.restoreState(rec.state);
  if (!book.isOpen()) {
    console.error(`${SYMBOL}: row is OPEN but the restored book is flat — closing the row only.`);
    await store.closeBook(rec.symbol);
    await ds.destroy();
    process.exit(0);
  }

  const binance = new BinancePublicClient({ quote: 'USDT' });
  const hl = new HyperliquidClient();
  const fv = new CrossVenueFairValue(binance, hl);
  const fund = new HyperliquidFundingClient();

  const snap = await fv.getBasis(rec.symbol);
  const spotMid = micros(snap.binanceMid);
  const perpMid = micros(snap.hlMid);
  if (spotMid <= 0n || perpMid <= 0n) throw new Error(`${SYMBOL}: bad mids (spot ${snap.binanceMid}, perp ${snap.hlMid})`);

  console.log(`\n=== carry-close-book: ${SYMBOL} (${rec.direction}) — ${REASON} ===`);
  console.log(`  mids: spot ${snap.binanceMid} / perp ${snap.hlMid} (basis ${snap.basisBps.toFixed(1)}bps)`);

  // Accrue the offline gap from ACTUAL settled funding — same honesty as the runner's resume.
  const from = rec.state.lastAccrualMs;
  const now = Date.now();
  if (from !== null && now - from >= HOUR_MS / 2) {
    try {
      const settlements = await fund.fundingHistory(rec.symbol, from, now);
      let accrued = 0n;
      for (const s of settlements) accrued += book.accrueFunding(s.fundingTimeMs, s.fundingRate, perpMid);
      console.log(`  offline gap: ${((now - from) / HOUR_MS).toFixed(1)}h — accrued ${usd(accrued)} from ${settlements.length} settled prints`);
    } catch (e) {
      console.log(`  ⚠ gap-accrual fetch failed (${(e as Error).message}) — closing without the gap's funding`);
    }
  }

  book.close(Date.now(), spotMid, perpMid);
  const s = book.snapshot(spotMid, perpMid, Date.now());
  console.log(
    `\n  CLOSED — realised ${usd(s.realisedUnits)} | funding ${usd(s.fundingUnits)} | fees ${usd(-s.feesUnits)} | ` +
    `slippage ${usd(-s.slippageUnits)} | REALISED-FIRST ${usd(s.realisedFirstUnits)}`,
  );

  await store.saveBook({ ...rec, state: book.serializeState() });
  await store.closeBook(rec.symbol);
  console.log(`  carry_book_state: ${SYMBOL} → CLOSED (final state persisted).`);
  await ds.destroy();
  console.log('\nCARRY-CLOSE-BOOK DONE');
}

main().catch(async (e) => {
  console.error('\nCARRY-CLOSE-BOOK FAIL:', e?.message ?? e);
  process.exit(1);
});
