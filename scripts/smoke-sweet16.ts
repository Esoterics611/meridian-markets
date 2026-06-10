// smoke-sweet16.ts — verify every Sweet-16 book is REACHABLE through the engine's own
// HyperliquidClient before a run launches it (BOOK_SELECTION_ANALYSIS.md → launch-mm-10h.sh).
// DB-free, no server needed: pulls a real L2 snapshot + recent 1m candles per symbol and
// prints mid / spread / depth / bar count. A book that fails here must NOT be launched.
//
//   npx ts-node -r tsconfig-paths/register scripts/smoke-sweet16.ts [SYM ...]
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';

const DEFAULT_BOOKS = [
  // HIP-3 (trade.xyz dex) — exact-case coin keys, no maker rebate assumed (venue-fees.ts)
  'xyz:GOLD', 'xyz:SILVER', 'xyz:XYZ100', 'xyz:SP500', 'xyz:CL', 'xyz:BRENTOIL', 'xyz:NVDA', 'xyz:TSLA',
  // main dex
  'HYPE', 'FARTCOIN', 'kPEPE', 'PURR', 'SUI', 'SOL', 'ADA', 'DOGE',
];

async function main(): Promise<void> {
  const books = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_BOOKS;
  const hl = new HyperliquidClient();
  let failures = 0;
  console.log('symbol          mid          spread(bps)  bidLvls askLvls  1mBars');
  for (const sym of books) {
    try {
      const [l2, bars] = await Promise.all([hl.l2Snapshot(sym), hl.klines(sym, '1m', 30)]);
      const bid = l2.bids[0]?.priceMicros ?? 0n;
      const ask = l2.asks[0]?.priceMicros ?? 0n;
      const mid = Number(bid + ask) / 2 / 1e6;
      const spreadBps = bid > 0n && ask > 0n ? (Number(ask - bid) / (Number(bid + ask) / 2)) * 1e4 : NaN;
      const ok = bid > 0n && ask > 0n && bars.length > 0;
      if (!ok) failures++;
      console.log(
        `${sym.padEnd(14)} ${mid.toFixed(4).padStart(12)} ${spreadBps.toFixed(2).padStart(12)} ${String(l2.bids.length).padStart(7)} ${String(l2.asks.length).padStart(7)} ${String(bars.length).padStart(7)}${ok ? '' : '   << FAIL'}`,
      );
    } catch (err) {
      failures++;
      console.log(`${sym.padEnd(14)} ERROR: ${(err as Error).message}   << FAIL`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} book(s) unreachable — fix or drop them before launching.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll books reachable through HyperliquidClient.');
  }
}

void main();
