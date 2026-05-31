/**
 * In-process smoke for the automated market-making desk, against LIVE Binance
 * public data. DB-free and HTTP-free (the MM path touches no Postgres), so it
 * runs anywhere with network — including the sandbox where the watch server
 * cannot. Proves the full MM vertical on real data:
 *   1. backfill real stablecoin bars (Binance public klines, no key)
 *   2. run the bar backtest across all three quoter families, four-component P&L
 *   3. drive a live MmBook one closed-bar tick and print its book
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/smoke-mm-stablecoin.ts
 *   SMOKE_MM_SYMBOLS=FDUSD,USDC,TUSD SMOKE_MM_BARS=400 npx ts-node ... (overrides)
 */
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { BinancePublicBarFeed } from '../src/stat-arb/feed/binance-public-bar-feed';
import { mmStrategyRegistry } from '../src/market-making/registry/mm-strategy-registry';
import { MmBacktestRunner } from '../src/market-making/backtest/mm-backtest-runner';
import { MmBook } from '../src/market-making/live/mm-book';
import { CompositeRiskGate } from '../src/market-making/risk/risk-gate';

const usdc = (units: bigint) => (Number(units) / 1e6).toFixed(4);
const px = (micros: string | bigint | null) => (micros == null ? '—' : (Number(micros) / 1e6).toFixed(6));

const QUOTE_SIZE = 1_000_000_000n; // 1000 asset units
const MIN_BPS = 1;
const MAX_BPS = 200;
const MAX_LOTS = 8;
const STRATEGIES = ['mm-symmetric', 'mm-avellaneda-stoikov', 'mm-glft'];

async function main(): Promise<void> {
  const client = new BinancePublicClient({ quote: 'USDT' });
  const symbols = (process.env.SMOKE_MM_SYMBOLS ?? 'FDUSD,USDC,TUSD').split(',').map((s) => s.trim());
  const barCount = Number(process.env.SMOKE_MM_BARS ?? 400);

  console.log(`\n=== 1. backfill real Binance 1m bars (${barCount}) ===`);
  const barsBySymbol = new Map<string, Awaited<ReturnType<typeof client.klines>>>();
  for (const sym of symbols) {
    const bars = await client.klines(sym, '1m', barCount);
    barsBySymbol.set(sym, bars);
    const last = bars[bars.length - 1];
    console.log(`  ${sym}USDT: ${bars.length} bars, last close ${last.close} @ ${last.timestamp.toISOString()}`);
  }

  console.log(`\n=== 2. bar backtest — all three quoters × ${symbols.length} stablecoins ===`);
  console.log('  symbol  strategy                 fills  fillRate   spread    fees    adverse   netPnL   maxDD%  endInv');
  for (const sym of symbols) {
    const bars = barsBySymbol.get(sym)!;
    for (const id of STRATEGIES) {
      const quoter = mmStrategyRegistry.build(id, {
        quoteSizeUnits: QUOTE_SIZE,
        minHalfSpreadBps: MIN_BPS,
        maxHalfSpreadBps: MAX_BPS,
        maxInventoryLots: MAX_LOTS,
      });
      const m = new MmBacktestRunner().run({
        bars,
        quoter,
        quoteSizeUnits: QUOTE_SIZE,
        gamma: 0.0025,
        kappa: 2,
        horizonBars: 1,
        volWindowBars: 30,
        volFloor: 0.0001,
        makerFeeBps: -1, // Binance maker rebate ≈ −1 bps
        capitalUnits: 100_000_000_000n,
      });
      console.log(
        `  ${sym.padEnd(6)}  ${id.padEnd(22)}  ${String(m.fills).padStart(4)}  ${m.fillRate.toFixed(3).padStart(7)}  ` +
          `${usdc(m.attribution.spreadCapturedUnits).padStart(8)}  ${usdc(m.feesUnits).padStart(6)}  ` +
          `${usdc(m.attribution.adverseSelectionUnits).padStart(7)}  ${usdc(m.netPnlUnits).padStart(7)}  ` +
          `${m.maxDrawdownPct.toFixed(2).padStart(5)}  ${usdc(m.finalInventoryUnits).padStart(6)}`,
      );
    }
  }

  console.log(`\n=== 3. live MmBook — one real closed-bar tick (AS quoter on ${symbols[0]}) ===`);
  const feed = new BinancePublicBarFeed(client, '1m');
  const quoter = mmStrategyRegistry.build('mm-avellaneda-stoikov', {
    quoteSizeUnits: QUOTE_SIZE,
    minHalfSpreadBps: MIN_BPS,
    maxHalfSpreadBps: MAX_BPS,
    maxInventoryLots: MAX_LOTS,
  });
  const book = new MmBook({
    symbol: symbols[0],
    strategyId: 'mm-avellaneda-stoikov',
    quoter,
    quoteSizeUnits: QUOTE_SIZE,
    gamma: 0.0025,
    kappa: 2,
    horizonBars: 1,
    volWindowBars: 30,
    volFloor: 0.0001,
    makerFeeBps: -1,
    capitalUnits: 100_000_000_000n,
    nextBar: (s) => feed.nextBar(s),
    warmupCloses: async (s) => (await client.klines(s, '1m', 120)).map((b) => b.close),
    riskGate: new CompositeRiskGate({
      maxInventoryUnits: QUOTE_SIZE * BigInt(MAX_LOTS),
      minNavRatio: 0.9,
      vpinPauseThreshold: 2,
      vpinPauseMs: 30_000,
      maxAdverseUnits: 100_000_000_000n,
      adversePauseMs: 30_000,
    }),
  });
  await book.warmup();
  await book.tick();
  const s = book.snapshot();
  console.log(
    `  ${s.symbol}: warm=${s.warm} mid=${px(s.midMicros)} bid=${px(s.bidMicros)} ask=${px(s.askMicros)} ` +
      `halfSpread=${px(s.halfSpreadMicros)} inv=${usdc(BigInt(s.inventoryUnits))} equity=${usdc(BigInt(s.equityUnits))} verdict=${s.lastVerdict}`,
  );

  console.log('\nSMOKE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nSMOKE FAIL:', e?.message ?? e);
  process.exit(1);
});
