/**
 * Quant session — drive the desk end-to-end against LIVE Binance data, in paper
 * mode, and prove the live loop ENTERS trades.
 *
 * This is the headless twin of what a quant does in the /demo console:
 *   1. list the strategy catalogue + market presets
 *   2. backfill a preset from real Binance history
 *   3. discover cointegrated pairs (spreads to monitor)
 *   4. backtest EVERY catalogue strategy on the top pair's real history
 *   5. run each strategy through the REAL live loop (LivePaperTrader) over a
 *      replay of recent real 1m bars — same class production paper mode uses,
 *      only the feed is a deterministic replay of real history instead of the
 *      realtime poller — and report the trades it entered
 *   6. arm the DI control-plane (LiveController) on the best pair+strategy so the
 *      /demo UI shows it live, and tick it once against a fresh real bar
 *
 * Run (Postgres on :5433 must be up, migrations applied):
 *   FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
 *     LIVE_AUTOSTART=false \
 *     npx ts-node -r tsconfig-paths/register scripts/quant-session.ts
 *
 * Everything here is paper: PaperVenue simulates fills at real prices. No key,
 * no account, no real money. EXECUTION_MODE=live + LIVE_TRADING_ARMED is a
 * separate engineering decision and is NOT exercised by this script.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { MarketDataController } from '../src/market-data/market-data.controller';
import { LiveController } from '../src/execution/live.controller';
import { BINANCE_CLIENT, BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { LivePaperTrader } from '../src/execution/live-paper-trader';
import { PaperVenue } from '../src/execution/paper-venue';
import { IBarFeed } from '../src/stat-arb/feed/live-feed.interface';
import { Bar } from '../src/stat-arb/backtest/bar';
import { strategyRegistry } from '../src/stat-arb/strategies/strategy-registry';
import { RiskEngine } from '../src/stat-arb/risk/risk-engine';
import { DrawdownGate } from '../src/stat-arb/risk/drawdown-gate';

const USDC = 1_000_000n;

/** Deterministic replay of pre-fetched real bars through the live IBarFeed seam. */
class ReplayBarFeed implements IBarFeed {
  readonly feedId = 'binance.spot.replay';
  private readonly cursor = new Map<string, number>();
  constructor(
    private readonly series: Record<string, Bar[]>,
    private readonly markPrice: Map<string, number>,
  ) {}
  async nextBar(symbol: string): Promise<Bar | null> {
    const i = this.cursor.get(symbol) ?? 0;
    const arr = this.series[symbol] ?? [];
    if (i >= arr.length) return null;
    this.cursor.set(symbol, i + 1);
    const bar = arr[i];
    this.markPrice.set(symbol, bar.close); // so the paper venue fills at this bar
    return bar;
  }
}

/** Inner join two real-kline series on timestamp → equal-length aligned arrays. */
function alignPair(a: Bar[], b: Bar[]): { a: Bar[]; b: Bar[] } {
  const bByTs = new Map(b.map((x) => [x.timestamp.getTime(), x]));
  const oa: Bar[] = [];
  const ob: Bar[] = [];
  for (const x of a) {
    const y = bByTs.get(x.timestamp.getTime());
    if (y) { oa.push(x); ob.push(y); }
  }
  return { a: oa, b: ob };
}

const fmtUsdc = (units: string | bigint) => (Number(BigInt(units)) / 1e6).toFixed(2);

async function main(): Promise<void> {
  const presetId = process.env.QS_PRESET ?? 'crypto-majors';
  const lookbackHours = Number(process.env.QS_HOURS ?? 24);
  const capitalUsdc = Number(process.env.QS_CAPITAL ?? 100_000);
  const notionalUnits = BigInt(process.env.QS_NOTIONAL_UNITS ?? '1000000000'); // 1000 USDC/leg

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  await app.init();
  const md = app.get(MarketDataController);
  const live = app.get(LiveController);
  const client = app.get<BinancePublicClient>(BINANCE_CLIENT);

  console.log('\n════════ MERIDIAN QUANT SESSION — live Binance, paper mode ════════');

  // 1. Catalogue + presets ---------------------------------------------------
  const strategies = live.strategies().strategies;
  console.log('\n[1] Strategy catalogue (live-capable):');
  for (const s of strategies) console.log(`    ${s.id.padEnd(16)} ${s.family.padEnd(14)} ${s.courseRef}`);
  console.log('    presets:', md.presets().presets.map((p) => p.id).join(', '));

  // 2. Backfill real history -------------------------------------------------
  console.log(`\n[2] Backfilling ${presetId} (${lookbackHours}h real Binance) …`);
  const bf: any = await md.backfillPreset({ presetId, lookbackHours });
  console.log(`    symbols=${bf.symbols} barsInserted=${bf.totalBarsInserted}`);

  // 3. Discover spreads to monitor ------------------------------------------
  const uni: any = await md.universe(presetId, 'binance.spot', String(lookbackHours));
  if ('needsBackfill' in uni) {
    console.log('    discovery needs more bars:', JSON.stringify(uni.perSymbol));
    await app.close();
    process.exit(1);
  }
  console.log(`\n[3] Discovered ${uni.topPairs.length} candidate spreads:`);
  uni.topPairs.slice(0, 6).forEach((p: any) =>
    console.log(`    ${`${p.symbolA}/${p.symbolB}`.padEnd(12)} β=${p.beta.toFixed(3)} p=${p.pValue.toFixed(3)} halfLife=${p.halfLifeBars.toFixed(1)}b vol=${p.regime.vol}`),
  );
  const top = uni.topPairs[0];
  if (!top) { console.log('no pairs discovered'); await app.close(); process.exit(1); }

  // 4. Backtest every strategy on the top pair's real history ----------------
  console.log(`\n[4] Backtesting all strategies on ${top.symbolA}/${top.symbolB} (real history):`);
  for (const s of strategies) {
    const bt: any = await md.backtest({
      symbolA: top.symbolA, symbolB: top.symbolB, beta: top.beta, lookbackHours, strategyId: s.id,
    });
    if (bt.error) { console.log(`    ${s.id.padEnd(16)} ${bt.error}`); continue; }
    console.log(`    ${s.id.padEnd(16)} trades=${String(bt.tradeCount).padStart(3)} pnl=${fmtUsdc(bt.metrics.totalPnlUnits).padStart(10)} USDC  sharpe=${bt.metrics.sharpeRatio.toFixed(2)} winRate=${(bt.metrics.winRate * 100).toFixed(0)}%`);
  }

  // 5. Run each strategy through the REAL live loop over replayed real bars ---
  console.log(`\n[5] Live loop (LivePaperTrader) over replayed real 1m bars for ${top.symbolA}/${top.symbolB}:`);
  const seedBars = 150;
  const rawA = await client.klines(top.symbolA, '1m', 1000);
  const rawB = await client.klines(top.symbolB, '1m', 1000);
  const { a: alA, b: alB } = alignPair(rawA, rawB);
  console.log(`    pulled ${alA.length} aligned real bars (seed ${seedBars}, replay ${Math.max(0, alA.length - seedBars)})`);

  let best: { id: string; pnl: bigint; trades: number } | null = null;
  for (const s of strategies) {
    const markPrice = new Map<string, number>();
    const replaySeries: Record<string, Bar[]> = {
      [top.symbolA]: alA.slice(seedBars),
      [top.symbolB]: alB.slice(seedBars),
    };
    const feed = new ReplayBarFeed(replaySeries, markPrice);
    const venue = new PaperVenue({
      pricePoller: async (sym) => BigInt(Math.round((markPrice.get(sym) ?? 0) * 1e6)),
    });
    const strat = strategyRegistry.build(s.id, { beta: top.beta, notionalUnits });
    const trader = new LivePaperTrader(
      strat, venue, feed,
      {
        symbolA: top.symbolA, symbolB: top.symbolB, strategyId: s.id,
        pollIntervalMs: 1, maxHistory: 1000,
        riskEngine: new RiskEngine({ drawdown: new DrawdownGate({ maxDrawdownPct: 25 }) }),
        capitalUnits: BigInt(capitalUsdc) * USDC,
      },
    );
    trader.seedHistory(alA.slice(0, seedBars), alB.slice(0, seedBars)); // warm context, no trades
    for (let i = 0; i < replaySeries[top.symbolA].length; i++) await trader.tick();
    const snap = trader.snapshot();
    const closed = trader.closedTrades();
    const realised = closed.reduce((acc, t) => acc + t.pnlUnits, 0n);
    console.log(
      `    ${s.id.padEnd(16)} entered ${String(closed.length).padStart(3)} round-trips  ` +
      `realised=${fmtUsdc(realised).padStart(10)} USDC  openNow=${snap.openPosition ? snap.openPosition.side : '—'}  lastZ=${snap.lastZ.toFixed(2)}`,
    );
    if (closed.length > 0 && closed.length <= 3) {
      for (const t of closed) console.log(`        • ${t.side} z ${t.entryZ.toFixed(2)}→${t.exitZ.toFixed(2)}  pnl=${fmtUsdc(t.pnlUnits)} USDC`);
    }
    if (!best || realised > best.pnl) best = { id: s.id, pnl: realised, trades: closed.length };
  }

  // 6. Arm the production control-plane (what the /demo UI drives) ------------
  console.log(`\n[6] Arming the live control-plane on ${top.symbolA}/${top.symbolB} via ${best?.id} …`);
  live.configure({ startingCapitalUsdc: capitalUsdc });
  const armed: any = live.configure({ symbolA: top.symbolA, symbolB: top.symbolB, beta: top.beta, strategyId: best?.id });
  live.start();
  await live.tick(); // pull one fresh real bar through the production loop
  const ls: any = live.snapshot();
  console.log(`    pair=${ls.symbolA}/${ls.symbolB} strategy=${ls.strategyId} feed=${ls.feedId} venue=${ls.venueId}`);
  console.log(`    running=${ls.running} seededBars=${ls.seededBars} barsSeen=${ls.barsSeen} lastZ=${Number(ls.lastZ).toFixed(2)} regime=${ls.regime}`);
  console.log(`    equity=${fmtUsdc(ls.equityUnits)} USDC realised=${fmtUsdc(ls.realisedPnlUnits)} open=${ls.openPosition ? ls.openPosition.side : '—'} closedTrades=${ls.closedTradeCount}`);
  live.stop();

  console.log('\n════════ SESSION SUMMARY ════════');
  console.log(`Best strategy on ${top.symbolA}/${top.symbolB}: ${best?.id} → ${best?.trades} live-loop round-trips, ${fmtUsdc(best?.pnl ?? 0n)} USDC realised.`);
  console.log('The same LivePaperTrader class is what /demo arms in real time — open http://localhost:3100/demo to watch it enter live trades.');

  await app.close();
  console.log('\nQUANT SESSION OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nQUANT SESSION FAIL:', e?.stack ?? e?.message ?? e);
  process.exit(1);
});
