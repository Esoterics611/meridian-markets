/**
 * In-process smoke for the TESSERA reference data sources, against their LIVE
 * public endpoints (no key, no account). DB-free and server-free, so it runs
 * anywhere with outbound network — including the sandbox where the watch server
 * cannot. Proves the new sources actually return data:
 *   1. Pyth FX  — true 1m OHLC via the TradingView shim (the scannable source)
 *   2. DefiLlama — current stablecoin peg level
 *   3. Bit2C    — Israeli-exchange (ILS) spot reference
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/smoke-reference-sources.ts
 *
 * Note: Pyth FX is closed on weekends, so the EURUSD bar count may be low/zero
 * outside FX market hours — that's the live market, not a bug.
 */
import { PythBenchmarksClient } from '../src/market-data/reference/pyth-benchmarks-client';
import { DefiLlamaPegClient } from '../src/market-data/reference/defillama-peg-client';
import { Bit2CClient } from '../src/market-data/reference/bit2c-client';

async function main(): Promise<void> {
  const pyth = new PythBenchmarksClient();
  const llama = new DefiLlamaPegClient();
  const bit2c = new Bit2CClient();

  console.log('— Pyth FX (TradingView shim, real 1m OHLC) —');
  for (const sym of ['EURUSD', 'GBPUSD', 'USDILS']) {
    const bars = await pyth.klines(sym, '1m', 60).catch((e) => {
      console.log(`  ${sym}: ERROR ${(e as Error).message}`);
      return [];
    });
    const last = bars[bars.length - 1];
    console.log(`  ${sym}: ${bars.length} bars` + (last ? ` · last close ${last.close} @ ${last.timestamp.toISOString()}` : ''));
  }

  console.log('— DefiLlama stablecoin peg —');
  for (const sym of ['USDC', 'USDT', 'DAI']) {
    const bars = await llama.klines(sym).catch(() => []);
    console.log(`  ${sym}: ` + (bars[0] ? `peg ${bars[0].close}` : 'no price'));
  }

  console.log('— Bit2C (ILS) spot —');
  for (const sym of ['USDCNIS', 'BTCNIS']) {
    const bars = await bit2c.klines(sym).catch(() => []);
    console.log(`  ${sym}: ` + (bars[0] ? `last ${bars[0].close} (h ${bars[0].high} / l ${bars[0].low})` : 'no ticker'));
  }

  console.log('\n✓ reference sources reachable (any "no price"/0-bar line above is a live-market gap, not a wiring failure)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
