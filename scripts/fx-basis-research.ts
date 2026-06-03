/**
 * fx-basis-research — rewrite #3: cross-source FX-stable basis. The EUR on
 * Binance (EUR/USDT, an EUR-stablecoin) is an on-chain EUR/USD quote; Pyth's FX
 * benchmark is the "true" EUR/USD. Their basis = ln(EURUSDT) − ln(EURUSD) is the
 * stablecoin's deviation from FX fair value — a single-leg mean-reversion on
 * EUR/USDT using the benchmark as fair value. Reuses the IReferenceBarSource seam
 * (Pyth, already wired) + the signal libs (logSpread/rollingZScore/ouFit). DB-free.
 *
 * Aligning on the timestamp INTERSECTION drops FX-closed hours (weekends), where
 * the crypto leg keeps moving but the benchmark is stale and the basis is fake.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/fx-basis-research.ts
 *   FXB_PAIRS=EUR:EURUSD,EURI:EURUSD FXB_BARS=1000 npx ts-node ... fx-basis-research.ts
 */
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { PythBenchmarksClient } from '../src/market-data/reference/pyth-benchmarks-client';
import { logSpread } from '../src/stat-arb/signal/spread';
import { rollingZScore } from '../src/stat-arb/signal/z-score';
import { ouFit } from '../src/stat-arb/signal/ou';

const PAIRS = (process.env.FXB_PAIRS ?? 'EUR:EURUSD').split(',').map((p) => p.trim()).filter(Boolean);
const BARS = Number(process.env.FXB_BARS ?? 1000);
const INTERVAL = process.env.FXB_INTERVAL ?? '1m';
const ENTRY_Z = Number(process.env.FXB_ENTRY_Z ?? 2.0);
const EXIT_Z = Number(process.env.FXB_EXIT_Z ?? 0.5);
const LOOKBACK = Number(process.env.FXB_LOOKBACK ?? 60);
const SPOT_FEE_BPS = Number(process.env.FXB_SPOT_FEE_BPS ?? 10); // taker per side on the crypto leg
const pad = (s: string | number, n: number) => String(s).padStart(n);

interface Aligned {
  cryptoCloses: number[];
  fxCloses: number[];
  n: number;
}

function align(crypto: { timestamp: Date; close: number }[], fx: { timestamp: Date; close: number }[]): Aligned {
  const fxByMs = new Map<number, number>();
  for (const b of fx) fxByMs.set(b.timestamp.getTime(), b.close);
  const cryptoCloses: number[] = [];
  const fxCloses: number[] = [];
  for (const b of crypto) {
    const f = fxByMs.get(b.timestamp.getTime());
    if (f !== undefined && f > 0 && b.close > 0) {
      cryptoCloses.push(b.close);
      fxCloses.push(f);
    }
  }
  return { cryptoCloses, fxCloses, n: cryptoCloses.length };
}

/** Mean-reversion backtest on a single z-scored basis series, net of round-trip fee. */
function backtest(basis: number[], z: number[], roundTripBps: number): { trades: number; netBps: number; wins: number; grossBps: number } {
  let pos = 0; // +1 long basis (z<0), −1 short basis (z>0)
  let entryBasis = 0;
  let trades = 0;
  let netBps = 0;
  let grossBps = 0;
  let wins = 0;
  for (let i = 0; i < z.length; i++) {
    if (!isFinite(z[i])) continue;
    if (pos === 0) {
      if (z[i] >= ENTRY_Z) {
        pos = -1;
        entryBasis = basis[i];
      } else if (z[i] <= -ENTRY_Z) {
        pos = 1;
        entryBasis = basis[i];
      }
    } else if (Math.abs(z[i]) <= EXIT_Z || Math.sign(z[i]) === pos) {
      // close: short basis profits when basis falls; long when it rises.
      const moveBps = (entryBasis - basis[i]) * pos * 1e4;
      grossBps += moveBps;
      const net = moveBps - roundTripBps;
      netBps += net;
      if (net > 0) wins += 1;
      trades += 1;
      pos = 0;
    }
  }
  return { trades, netBps, wins, grossBps };
}

async function main(): Promise<void> {
  const spot = new BinancePublicClient({ quote: 'USDT' });
  const pyth = new PythBenchmarksClient();
  const roundTripBps = 2 * SPOT_FEE_BPS;

  console.log(`\n=== FX-stable basis — Binance EUR-stable vs Pyth FX benchmark (${INTERVAL}, ${BARS} bars) ===`);
  console.log(`  basis = ln(crypto) − ln(fx); entry |z|≥${ENTRY_Z}, exit |z|≤${EXIT_Z}, lookback ${LOOKBACK}; fee ${SPOT_FEE_BPS}bps/side ⇒ ${roundTripBps}bps round trip`);
  console.log(`\n  pair             aligned  σ basis(bps)  meanAbs(bps)  halfLife  |z|>2 %   trades  net/trade(bps)  win%   verdict`);

  for (const spec of PAIRS) {
    const [cryptoSym, fxSym] = spec.split(':');
    let cryptoBars, fxBars;
    try {
      cryptoBars = await spot.klines(cryptoSym, INTERVAL, BARS);
      fxBars = await pyth.klines(fxSym, INTERVAL, BARS);
    } catch (e) {
      console.log(`  ${spec.padEnd(15)}  — fetch failed: ${(e as Error).message}`);
      continue;
    }
    const a = align(cryptoBars, fxBars);
    if (a.n < LOOKBACK + 10) {
      console.log(`  ${spec.padEnd(15)}  — only ${a.n} aligned bars (need ${LOOKBACK + 10}) — skip`);
      continue;
    }
    const basis = logSpread(a.cryptoCloses, a.fxCloses, 1.0); // β=1: same EUR/USD cross
    const mean = basis.reduce((s, x) => s + x, 0) / basis.length;
    const sigma = Math.sqrt(basis.reduce((s, x) => s + (x - mean) ** 2, 0) / basis.length);
    const meanAbs = basis.reduce((s, x) => s + Math.abs(x - mean), 0) / basis.length;
    const fit = ouFit(basis);
    const halfLife = fit.theta > 0 ? Math.log(2) / fit.theta : Infinity;
    const z = rollingZScore(basis, LOOKBACK);
    const zExtreme = z.filter((v) => isFinite(v) && Math.abs(v) > 2).length / z.filter((v) => isFinite(v)).length;
    const bt = backtest(basis, z, roundTripBps);

    const netPerTrade = bt.trades ? bt.netBps / bt.trades : 0;
    const sigmaBps = sigma * 1e4;
    const verdict =
      bt.trades >= 5 && bt.netBps > 0 ? 'CANDIDATE' : bt.grossBps / Math.max(1, bt.trades) > roundTripBps ? 'WATCH' : 'sub-fee';
    console.log(
      `  ${spec.padEnd(15)}  ${pad(a.n, 7)}  ${pad(sigmaBps.toFixed(2), 12)}  ${pad((meanAbs * 1e4).toFixed(2), 12)}  ` +
        `${pad(isFinite(halfLife) ? halfLife.toFixed(0) + 'b' : '∞', 8)}  ${pad((zExtreme * 100).toFixed(1), 7)}%  ` +
        `${pad(bt.trades, 6)}  ${pad(netPerTrade.toFixed(1), 14)}  ${pad(bt.trades ? ((bt.wins / bt.trades) * 100).toFixed(0) : '0', 4)}%  ${verdict}`,
    );
  }

  console.log(`\n=== VERDICT (conserve equity; no in-sample shipping) ===`);
  console.log(`  The EUR-stablecoin tracks EUR/USD tightly (arbitrage keeps it pegged), so the basis σ is small and a TAKER`);
  console.log(`  round trip (${roundTripBps}bps) usually eats the reversion — the same fee-floor wall as crypto stat-arb. A 'CANDIDATE'`);
  console.log(`  means the in-sample reversion cleared the fee; the deploy path is MAKER quoting on the EUR-stable (reuse`);
  console.log(`  src/market-making/), turning this basis into a maker spread rather than a taker round trip. Triangular extension:`);
  console.log(`  add Bit2C BTC/ILS vs Binance BTC/USDT × Pyth USD/ILS for a true 3-venue arb (separate harness).`);
  console.log(`\n  CAVEATS: in-sample / single window; weekend FX gaps dropped by intersection; USDT≈USD assumed; one leg only (benchmark is reference, not tradeable).`);
  console.log('\nFX-BASIS OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFX-BASIS FAIL:', e?.message ?? e);
  process.exit(1);
});
