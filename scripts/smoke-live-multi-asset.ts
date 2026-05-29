/**
 * In-process live smoke for the Session-18 multi-asset surface.
 *
 * Boots the Nest app context (no HTTP listen — short-lived, so it runs in CI /
 * the sandbox where the watch server cannot), then drives the real path against
 * LIVE Binance + Postgres: presets -> backfill -> discovery -> backtest ->
 * candles -> live configure/snapshot. Prints results and exits.
 *
 * Run:
 *   echo 5784 | sudo -S docker compose up -d postgres && npm run migration:run
 *   FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false LIVE_AUTOSTART=false \
 *     npx ts-node -r tsconfig-paths/register scripts/smoke-live-multi-asset.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { MarketDataController } from '../src/market-data/market-data.controller';
import { LiveController } from '../src/execution/live.controller';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  await app.init();
  const md = app.get(MarketDataController);
  const live = app.get(LiveController);

  const presetId = process.env.SMOKE_PRESET ?? 'crypto-majors';
  const lookbackHours = Number(process.env.SMOKE_HOURS ?? 6);

  console.log('\n=== 1. presets ===');
  console.log(md.presets().presets.map((p) => p.id).join(', '));

  console.log(`\n=== 2. backfill ${presetId} (${lookbackHours}h, real Binance) ===`);
  const bf = await md.backfillPreset({ presetId, lookbackHours });
  console.log(JSON.stringify({ symbols: (bf as any).symbols, totalBarsInserted: (bf as any).totalBarsInserted }));

  console.log('\n=== 3. discovery over real bars ===');
  const uni = await md.universe(presetId, 'binance.spot', String(lookbackHours));
  let top: any = null;
  if ('needsBackfill' in uni) {
    console.log('needsBackfill — perSymbol bar counts:', uni.perSymbol);
  } else {
    console.log('source:', uni.source, '| symbols:', uni.symbols.length, '| topPairs:', uni.topPairs.length);
    uni.topPairs.slice(0, 4).forEach((p) =>
      console.log(`  ${p.symbolA}/${p.symbolB}  β=${p.beta.toFixed(3)} p=${p.pValue.toFixed(3)} hl=${p.halfLifeBars.toFixed(1)} vol=${p.regime.vol}`),
    );
    top = uni.topPairs[0] ?? null;
  }

  if (top) {
    console.log('\n=== 4. backtest top pair on real history ===');
    const bt: any = await md.backtest({ symbolA: top.symbolA, symbolB: top.symbolB, beta: top.beta, lookbackHours });
    console.log(bt.error ? JSON.stringify(bt) : JSON.stringify({ pair: bt.pair, bars: bt.window.bars, source: bt.source, metrics: bt.metrics, tradeCount: bt.tradeCount }));
  }

  console.log('\n=== 5. candles (Lightweight Charts shape) ===');
  const c = await md.candles('BTC', 'binance.spot', String(lookbackHours));
  console.log('BTC candles:', c.candles.length, '| first:', JSON.stringify(c.candles[0] ?? null));

  console.log('\n=== 6. live configure: capital + pair, then snapshot ===');
  live.configure({ startingCapitalUsdc: 100_000 });
  const snap: any = live.configure({ symbolA: top?.symbolA ?? 'ETH', symbolB: top?.symbolB ?? 'BTC', beta: top?.beta ?? 1 });
  console.log(JSON.stringify({ pair: `${snap.symbolA}/${snap.symbolB}`, capitalUnits: snap.capitalUnits, equityUnits: snap.equityUnits, beta: snap.beta, running: snap.running, feedId: snap.feedId, venueId: snap.venueId }));

  console.log('\n=== 7. multi-currency portfolio: top-3 pairs concurrently ===');
  const pairs = 'needsBackfill' in uni ? [] : uni.topPairs.slice(0, 3).map((p) => ({ symbolA: p.symbolA, symbolB: p.symbolB, beta: p.beta }));
  if (pairs.length) {
    live.setPortfolio({ pairs, capitalUsdc: 300_000 });
    await live.tickPortfolio();           // one aligned-bar pass across all books
    const ps: any = live.portfolioSnapshot();
    console.log(JSON.stringify({ pairCount: ps.pairCount, capitalUnits: ps.capitalUnits, equityUnits: ps.equityUnits }));
    ps.books.forEach((b: any) => console.log(`  ${b.pair}  cap=${b.capitalUnits} eq=${b.equityUnits} z=${b.lastZ?.toFixed?.(2)} bars=${b.barsSeen}`));
  } else {
    console.log('skipped (no discovered pairs)');
  }

  await app.close();
  console.log('\nSMOKE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nSMOKE FAIL:', e?.message ?? e);
  process.exit(1);
});
