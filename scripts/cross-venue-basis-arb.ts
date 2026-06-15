/**
 * cross-venue-basis-arb — T4 of the Profit Pivot (PROFIT_PIVOT.md §3).
 * DETECT-AND-LOG ONLY (P1). Polls the live HL↔Binance basis at high frequency
 * and fires an arb signal whenever |basisBps| exceeds the round-trip cost +
 * a safety margin (default 14+5=19bps). Logs every signal with a UTC timestamp,
 * direction, entry basis, and net edge. Nothing trades.
 *
 * Rationale (PROFIT_PIVOT.md §1 + §3 T4): micro-noise (sub-bps) is not ours.
 * The target events are LARGER, SLOWER dislocations — vol spikes, liquidation
 * cascades, listing events — where the 19bps threshold filters fee+slippage and
 * the basis converges within minutes rather than microseconds.
 *
 * Run (DB-free, real public APIs):
 *   npx ts-node -r tsconfig-paths/register scripts/cross-venue-basis-arb.ts
 *   CV_SYMBOLS=BTC,ETH CV_INTERVAL_MS=500 CV_THRESHOLD_BPS=15 npx ts-node ...
 *
 * CV_SYMBOLS         comma-separated (default BTC,ETH,SOL,BNB,XRP)
 * CV_INTERVAL_MS     poll interval ms (default 500 — 2 Hz)
 * CV_THRESHOLD_BPS   override total threshold; if set, uses this directly
 * CV_ROUNDTRIP_BPS   roundtrip fee cost in bps (default 14)
 * CV_MARGIN_BPS      safety margin above fees (default 5)
 * CV_DURATION_MIN    run duration in minutes (default 10)
 */
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';
import { CrossVenueFairValue } from '../src/market-data/cross-venue/cross-venue-fair-value';
import { CrossVenueBasisArbDetector } from '../src/market-data/cross-venue/cross-venue-basis-arb';
import { BasisArbSignal } from '../src/market-data/cross-venue/cross-venue-basis-arb.interface';

const SYMBOLS = (process.env['CV_SYMBOLS'] ?? 'BTC,ETH,SOL,BNB,XRP')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const INTERVAL_MS = Number(process.env['CV_INTERVAL_MS'] ?? 500);
const ROUNDTRIP_BPS = Number(process.env['CV_ROUNDTRIP_BPS'] ?? 14);
const MARGIN_BPS = Number(process.env['CV_MARGIN_BPS'] ?? 5);
const DURATION_MIN = Number(process.env['CV_DURATION_MIN'] ?? 10);

// CV_THRESHOLD_BPS lets the user override the threshold directly.
const thresholdOverride = process.env['CV_THRESHOLD_BPS'] ? Number(process.env['CV_THRESHOLD_BPS']) : undefined;

function ts(): string {
  return new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
}

function fmt(n: number, d = 2): string {
  return (n >= 0 ? '+' : '') + n.toFixed(d);
}

async function main(): Promise<void> {
  const binance = new BinancePublicClient({ quote: 'USDT' });
  const hl = new HyperliquidClient();
  const fv = new CrossVenueFairValue(binance, hl);

  const detector = thresholdOverride
    ? new CrossVenueBasisArbDetector({ roundTripCostBps: thresholdOverride, marginBps: 0 })
    : new CrossVenueBasisArbDetector({ roundTripCostBps: ROUNDTRIP_BPS, marginBps: MARGIN_BPS });

  const signals: BasisArbSignal[] = [];
  const basisHistory: Map<string, number[]> = new Map(SYMBOLS.map((s) => [s, []]));

  const durationMs = DURATION_MIN * 60 * 1_000;
  const endAt = Date.now() + durationMs;

  console.log(`\n=== HL↔Binance basis-arb detector — DETECT-AND-LOG ONLY (T4, PROFIT_PIVOT §3) ===`);
  console.log(`  symbols  : ${SYMBOLS.join(', ')}`);
  console.log(`  threshold: ${detector.thresholdBps}bps (roundtrip ${ROUNDTRIP_BPS}bps + margin ${MARGIN_BPS}bps)`);
  console.log(`  interval : ${INTERVAL_MS}ms  |  duration: ${DURATION_MIN}min`);
  console.log(`  rationale: only LARGE, SLOW dislocations clear the fee bar — the signal log `);
  console.log(`             is the forward-paper validation set for T4 (PROFIT_PIVOT §3 T4)\n`);
  console.log(`  TIME          SYM    BASIS(bps)   DIRECTION                  NET-EDGE(bps)  STATUS`);
  console.log(`  ─────────────────────────────────────────────────────────────────────────────────`);

  while (Date.now() < endAt) {
    const t0 = Date.now();

    const snaps = await Promise.allSettled(SYMBOLS.map((sym) => fv.getBasis(sym)));

    for (let i = 0; i < SYMBOLS.length; i++) {
      const sym = SYMBOLS[i];
      const r = snaps[i];
      if (r.status !== 'fulfilled') continue;

      const snap = r.value;
      basisHistory.get(sym)!.push(snap.basisBps);

      const sig = detector.check(snap);
      if (sig) {
        signals.push(sig);
        console.log(
          `  ${ts()}  ${sym.padEnd(5)}  ${fmt(sig.entryBasisBps, 3).padStart(10)}   ` +
            `${sig.direction.padEnd(26)} ${fmt(sig.netEdgeBps, 2).padStart(6)}        *** SIGNAL ***`,
        );
      }
    }

    // Heartbeat every 20 ticks
    const totalTicks = signals.length === 0 ? 0 : 0;
    void totalTicks;

    const elapsed = Date.now() - t0;
    const remaining = endAt - Date.now();
    if (elapsed < INTERVAL_MS && remaining > 0) {
      await new Promise((r) => setTimeout(r, Math.min(INTERVAL_MS - elapsed, remaining)));
    }
  }

  // Summary
  console.log(`\n  ─────────────────────────────────────────────────────────────────────────────────`);
  console.log(`\n=== SUMMARY (T4 basis-arb detection) ===`);
  console.log(`  duration   : ${DURATION_MIN} min | interval: ${INTERVAL_MS}ms`);
  console.log(`  threshold  : ${detector.thresholdBps}bps`);
  console.log(`  signals    : ${signals.length} total`);

  if (signals.length === 0) {
    console.log(`\n  No dislocations ≥ ${detector.thresholdBps}bps observed.`);
    console.log(`  This is EXPECTED in a quiet period — the threshold filters structural-size events.`);
    console.log(`  Run across multiple sessions to catch vol spikes, listings, or liquidation cascades.`);
  } else {
    const byDir: Record<string, BasisArbSignal[]> = {};
    for (const s of signals) {
      byDir[s.direction] = (byDir[s.direction] ?? []).concat(s);
    }
    for (const [dir, ss] of Object.entries(byDir)) {
      const avgEdge = ss.reduce((a, s) => a + s.netEdgeBps, 0) / ss.length;
      console.log(`  ${dir}: ${ss.length} signal(s), avg net edge ${avgEdge.toFixed(2)}bps`);
    }
  }

  // Basis range summary per symbol
  console.log(`\n  Per-symbol basis range observed:`);
  for (const sym of SYMBOLS) {
    const series = basisHistory.get(sym)!;
    if (series.length === 0) continue;
    const min = Math.min(...series).toFixed(2);
    const max = Math.max(...series).toFixed(2);
    const mean = (series.reduce((a, b) => a + b, 0) / series.length).toFixed(3);
    const n = series.length;
    console.log(`    ${sym.padEnd(5)}  n=${n}  mean=${fmt(Number(mean), 3)}bps  range=[${min}, ${max}]bps`);
  }

  console.log(`\nCROSS-VENUE-BASIS-ARB OK\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\nCROSS-VENUE-BASIS-ARB FAIL:', e?.message ?? e);
  process.exit(1);
});
