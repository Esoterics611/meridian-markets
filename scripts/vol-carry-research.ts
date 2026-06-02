/**
 * vol-carry-research — rewrite #4: options vol-selling. Measures the VARIANCE RISK
 * PREMIUM (implied − realized vol) on BTC/ETH using the real Deribit option chain
 * (mark IV) vs Binance realized vol, prices the ATM straddle + Greeks with our
 * Black-Scholes pricer, and cross-checks those Greeks against Deribit's own.
 * DB-free; Deribit + Binance public REST, no keys.
 *
 * The edge: implied vol is, on average, richer than what's realised (sellers earn
 * a premium for bearing the gap/jump risk). A delta-hedged short straddle harvests
 * it as theta income — but it is a SHORT-VOL TAIL trade: a Greeks budget
 * (net vega / gamma caps) and continuous delta-hedging are mandatory, exactly the
 * §3.5 gate the rewrite calls for. We size/verdict on VRP, never on the premium alone.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/vol-carry-research.ts
 *   VOL_CCYS=BTC,ETH VOL_TENOR_DAYS=30 npx ts-node ... vol-carry-research.ts
 */
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { DeribitClient, DeribitOption } from '../src/derivatives/deribit/deribit-client';
import { BlackScholesPricer } from '../src/derivatives/greeks/black-scholes';

const CCYS = (process.env.VOL_CCYS ?? 'BTC,ETH').split(',').map((s) => s.trim()).filter(Boolean);
const TENOR_DAYS = Number(process.env.VOL_TENOR_DAYS ?? 30);
const RV_INTERVAL = process.env.VOL_RV_INTERVAL ?? '1h';
const VRP_MIN = Number(process.env.VOL_VRP_MIN ?? 2); // vol points (IV−RV) to call it an edge
const RATE = Number(process.env.VOL_RATE ?? 0);
const pad = (s: string | number, n: number) => String(s).padStart(n);
const pct = (x: number) => (x * 100).toFixed(1) + '%';

const BARS_PER_YEAR: Record<string, number> = { '1h': 24 * 365, '4h': 6 * 365, '1d': 365 };

/** Annualised realised vol from log returns of close prices. */
function realisedVol(closes: number[], interval: string): number {
  if (closes.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  return Math.sqrt(varr) * Math.sqrt(BARS_PER_YEAR[interval] ?? 24 * 365);
}

/** Pick the chain's ATM call+put at the expiry nearest the target tenor. */
function pickAtm(chain: DeribitOption[], nowMs: number, tenorDays: number): { call: DeribitOption; put: DeribitOption; expiryMs: number; underlying: number } | null {
  if (!chain.length) return null;
  const underlying = chain[0].underlyingPrice;
  const targetMs = nowMs + tenorDays * 86_400_000;
  const expiries = [...new Set(chain.map((o) => o.expiryMs))].filter((e) => e > nowMs);
  if (!expiries.length) return null;
  const expiryMs = expiries.reduce((best, e) => (Math.abs(e - targetMs) < Math.abs(best - targetMs) ? e : best));
  const atExp = chain.filter((o) => o.expiryMs === expiryMs);
  const nearest = (type: 'CALL' | 'PUT') =>
    atExp.filter((o) => o.type === type).reduce((b, o) => (Math.abs(o.strike - underlying) < Math.abs(b.strike - underlying) ? o : b));
  const calls = atExp.filter((o) => o.type === 'CALL');
  const puts = atExp.filter((o) => o.type === 'PUT');
  if (!calls.length || !puts.length) return null;
  return { call: nearest('CALL'), put: nearest('PUT'), expiryMs, underlying };
}

async function main(): Promise<void> {
  const spot = new BinancePublicClient({ quote: 'USDT' });
  const drb = new DeribitClient();
  const pricer = new BlackScholesPricer(RATE);
  const nowMs = Date.now();

  console.log(`\n=== Options vol-selling — variance risk premium (IV vs RV), real Deribit chain + Binance RV ===`);
  console.log(`  target tenor ~${TENOR_DAYS}d · RV from ${RV_INTERVAL} closes · short-straddle Greeks via our Black-Scholes`);
  console.log(`\n  ccy   spot      expiry(d)  atmStrike  IV       RV       VRP(IV−RV)  IV/RV   straddle$/contract  shortΘ/day$  verdict`);

  for (const ccy of CCYS) {
    let chain: DeribitOption[];
    try {
      chain = await drb.optionChain(ccy);
    } catch (e) {
      console.log(`  ${ccy.padEnd(5)} — Deribit fetch failed: ${(e as Error).message}`);
      continue;
    }
    const atm = pickAtm(chain, nowMs, TENOR_DAYS);
    if (!atm) {
      console.log(`  ${ccy.padEnd(5)} — no ATM options near ${TENOR_DAYS}d`);
      continue;
    }
    const days = (atm.expiryMs - nowMs) / 86_400_000;
    const iv = (atm.call.markIv + atm.put.markIv) / 2;

    // Realised vol over a trailing window ~matching the tenor.
    const rvBars = Math.round((RV_INTERVAL === '1d' ? days : days * 24) + 2);
    const bars = await spot.klines(ccy, RV_INTERVAL, Math.min(Math.max(rvBars, 30), 1000));
    const rv = realisedVol(bars.map((b) => b.close), RV_INTERVAL);
    const vrp = iv - rv;

    // Price the ATM straddle + Greeks with our BS pricer at the venue IV.
    const cQ = pricer.price({ type: 'CALL', strike: atm.call.strike, expiryMs: atm.expiryMs }, { spot: atm.underlying, iv, rate: RATE, asOfMs: nowMs });
    const pQ = pricer.price({ type: 'PUT', strike: atm.put.strike, expiryMs: atm.expiryMs }, { spot: atm.underlying, iv, rate: RATE, asOfMs: nowMs });
    const straddleUsd = cQ.price + pQ.price; // BS USD premium for the 1-coin straddle
    const shortThetaPerDay = -(cQ.theta + pQ.theta) / 365; // short straddle EARNS theta (USD/day)

    const verdict = vrp * 100 >= VRP_MIN ? 'CANDIDATE' : vrp > 0 ? 'WATCH' : 'no-edge';
    console.log(
      `  ${ccy.padEnd(5)} ${pad(atm.underlying.toFixed(0), 8)}  ${pad(days.toFixed(1), 9)}  ${pad(atm.call.strike, 9)}  ` +
        `${pad(pct(iv), 7)}  ${pad(pct(rv), 7)}  ${pad((vrp * 100).toFixed(1) + 'pt', 10)}  ${pad((iv / Math.max(rv, 1e-9)).toFixed(2), 6)}  ` +
        `${pad(straddleUsd.toFixed(0), 18)}  ${pad(shortThetaPerDay.toFixed(0), 11)}  ${verdict}`,
    );

    // Cross-check our Greeks against Deribit's own, on the real ATM call.
    try {
      const t = await drb.ticker(atm.call.instrumentName);
      const g = t.greeks ?? {};
      // Deribit vega/theta are per 1% vol / per day; convert ours to match.
      console.log(
        `        greeks check (${atm.call.instrumentName}): ` +
          `Δ ours ${cQ.delta.toFixed(3)} vs deribit ${(g.delta ?? NaN).toFixed(3)} · ` +
          `ν/1% ours ${(cQ.vega / 100).toFixed(1)} vs ${(g.vega ?? NaN).toFixed(1)} · ` +
          `Θ/day ours ${(cQ.theta / 365).toFixed(1)} vs ${(g.theta ?? NaN).toFixed(1)}`,
      );
    } catch {
      /* ticker optional */
    }
  }

  console.log(`\n=== VERDICT (conserve equity; no in-sample shipping) ===`);
  console.log(`  The edge is the VRP (implied richer than realised) — sellers are paid to carry gap/jump risk. A CANDIDATE`);
  console.log(`  (VRP ≥ ${VRP_MIN} vol pts) means short ATM vol has positive expected carry RIGHT NOW. But it is a TAIL trade:`);
  console.log(`  deploy ONLY delta-hedged, under a Greeks budget (net vega/gamma caps — the §3.5 gate), small, and never`);
  console.log(`  naked. Theta is the income; gamma is the risk; a single jump can erase weeks of premium.`);
  console.log(`\n  CAVEATS: one snapshot (not a VRP time series); trailing RV vs forward IV (the standard proxy); excludes`);
  console.log(`  Deribit fees + the cost of continuous delta-hedging; ATM-only (ignores skew/term structure).`);
  console.log('\nVOL-CARRY OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nVOL-CARRY FAIL:', e?.message ?? e);
  process.exit(1);
});
