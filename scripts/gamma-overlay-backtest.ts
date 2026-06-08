/**
 * gamma-overlay-backtest.ts — does a long-gamma overlay clear its premium in OUR windows?
 *
 * The MM desk is structurally SHORT gamma (HEDGING_MODEL.md §3): it bleeds ≈ ½Γ(ΔS)² on realised
 * moves (that bleed is adverse selection). Buying gamma offsets it but costs implied vol. The whole
 * decision is REALISED vol vs IMPLIED vol — so this measures both on live data.
 *
 *   realised vol  ← Hyperliquid BTC candles over the window
 *   implied vol   ← Deribit nearest-expiry ATM BTC mark_iv
 *   cash-gamma    ← calibrated from the desk's measured short-gamma bleed (not a guess)
 *   verdict       ← gammaOverlay(): recover fraction 1 − iv²/rv², net = bleed·fraction − cost
 *
 * Single window:  npx ts-node -r tsconfig-paths/register scripts/gamma-overlay-backtest.ts [hours] [bleedUsd] [costUsd]
 * Distribution:   npx ts-node -r tsconfig-paths/register scripts/gamma-overlay-backtest.ts dist [days] [bleedUsd]
 */
import { realizedVolAnnualized, gammaOverlay, calibrateCashGamma, gammaLossForMove } from '../src/market-making/hedge/gamma-overlay';

const HL = 'https://api.hyperliquid.xyz/info';
const DERIBIT = 'https://www.deribit.com/api/v2/public';
const YEAR_HOURS = 365 * 24;

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function hlBtcCloses(hours: number, interval: '1m' | '1h'): Promise<number[]> {
  const end = Date.now();
  const start = end - hours * 3_600_000;
  const body = JSON.stringify({ type: 'candleSnapshot', req: { coin: 'BTC', interval, startTime: start, endTime: end } });
  const rows = (await getJson(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body })) as Array<{ c: string }>;
  return rows.map((r) => parseFloat(r.c)).filter((x) => Number.isFinite(x) && x > 0);
}

/** Nearest-expiry ATM BTC implied vol from Deribit (mark_iv is a %; → fraction). */
async function deribitAtmIv(): Promise<{ iv: number; instrument: string; index: number }> {
  const idx = (await getJson(`${DERIBIT}/get_index_price?index_name=btc_usd`)).result.index_price as number;
  const summary = (await getJson(`${DERIBIT}/get_book_summary_by_currency?currency=BTC&kind=option`)).result as Array<{
    instrument_name: string;
    mark_iv: number | null;
  }>;
  const parsed = summary
    .map((o) => {
      const [, exp, strikeStr] = o.instrument_name.split('-');
      const strike = Number(strikeStr);
      const expMs = Date.parse(exp.replace(/(\d+)([A-Z]+)(\d+)/, '$1 $2 20$3'));
      return { name: o.instrument_name, iv: o.mark_iv, strike, expMs };
    })
    .filter((o) => o.iv != null && Number.isFinite(o.strike) && Number.isFinite(o.expMs));
  const nearestExp = Math.min(...parsed.map((o) => o.expMs));
  const atm = parsed
    .filter((o) => o.expMs === nearestExp)
    .sort((a, b) => Math.abs(a.strike - idx) - Math.abs(b.strike - idx))[0];
  return { iv: (atm.iv as number) / 100, instrument: atm.name, index: idx };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

async function singleWindow(hours: number, bleedUsd: number, costUsd: number) {
  const [closes, atm] = await Promise.all([hlBtcCloses(hours, '1m'), deribitAtmIv()]);
  const realizedVol = realizedVolAnnualized(closes, YEAR_HOURS * 60);
  const years = hours / YEAR_HOURS;
  const r = gammaOverlay({ realizedVol, impliedVol: atm.iv, bleedUsd, costUsd });
  const cashGamma = calibrateCashGamma(bleedUsd, realizedVol, years);

  console.log(`\n=== gamma-overlay backtest (${hours}h, ${closes.length} BTC 1m candles) ===`);
  console.log(`BTC index           $${atm.index.toFixed(0)}`);
  console.log(`realised vol (HL)   ${pct(realizedVol)}  annualised`);
  console.log(`implied vol (Deribit ATM ${atm.instrument})  ${pct(atm.iv)}`);
  console.log(`vol gap (rv − iv)   ${pct(realizedVol - atm.iv)}  ⇒ vol was ${realizedVol > atm.iv ? 'UNDER' : 'OVER'}priced by options`);
  console.log(`\ndesk short-gamma bleed (input)  $${bleedUsd.toLocaleString()}   option cost $${costUsd.toLocaleString()}`);
  console.log(`calibrated cash-gamma G         $${cashGamma.toLocaleString(undefined, { maximumFractionDigits: 0 })}  ⇒ ~$${gammaLossForMove(cashGamma, 0.01).toFixed(0)} bled per 1% move`);
  console.log(`recover fraction (1 − iv²/rv²)  ${pct(r.recoverFraction)}`);
  console.log(`overlay NET (recover − cost)    $${r.netUsd.toFixed(0)}`);
  console.log(`\nVERDICT: long gamma ${r.clears ? 'CLEARS its premium — buy gamma this regime' : 'does NOT clear — insurance only (eat the bleed or size small)'}`);
  console.log(`(one window, ATM proxy; the honest rail is realised>implied+cost, measured — not assumed)\n`);
}

async function distribution(days: number, bleedUsd: number) {
  const windowHrs = 24;
  const stepHrs = 6;
  const [closes, atm] = await Promise.all([hlBtcCloses(days * 24, '1h'), deribitAtmIv()]);
  const rvs: number[] = [];
  for (let i = 0; i + windowHrs <= closes.length; i += stepHrs) {
    const rv = realizedVolAnnualized(closes.slice(i, i + windowHrs), YEAR_HOURS);
    if (rv > 0) rvs.push(rv);
  }
  rvs.sort((a, b) => a - b);
  const clears = rvs.filter((rv) => rv > atm.iv).length;
  const nets = rvs.map((rv) => gammaOverlay({ realizedVol: rv, impliedVol: atm.iv, bleedUsd }).netUsd);
  const meanNet = nets.reduce((a, b) => a + b, 0) / Math.max(1, nets.length);

  console.log(`\n=== gamma-overlay DISTRIBUTION (${days}d of BTC 1h, ${windowHrs}h windows step ${stepHrs}h) ===`);
  console.log(`windows             ${rvs.length}`);
  console.log(`implied vol (Deribit ATM ${atm.instrument})  ${pct(atm.iv)}  (held flat across windows — sticky proxy, the honest caveat)`);
  console.log(`realised vol p25 / median / p75 / max   ${pct(quantile(rvs, 0.25))} / ${pct(quantile(rvs, 0.5))} / ${pct(quantile(rvs, 0.75))} / ${pct(rvs[rvs.length - 1])}`);
  console.log(`windows where realised > implied (long gamma clears)   ${clears}/${rvs.length}  = ${pct(clears / rvs.length)}`);
  console.log(`mean overlay NET on a $${bleedUsd.toLocaleString()} bleed   $${meanNet.toFixed(0)}  (− ⇒ VRP wins on average, overlay is insurance)`);
  console.log(`\nREAD: long gamma is a REGIME tool — it pays in the upper tail of realised vol (the MM's`);
  console.log(`worst windows), and bleeds the volatility-risk-premium the rest of the time.\n`);
}

async function main() {
  if (process.argv[2] === 'dist') {
    await distribution(Number(process.argv[3] ?? 30), Number(process.argv[4] ?? 2_345));
  } else {
    await singleWindow(Number(process.argv[2] ?? 12), Number(process.argv[3] ?? 2_345), Number(process.argv[4] ?? 0));
  }
}

main().catch((e) => {
  console.error('gamma-overlay-backtest failed:', e.message);
  process.exit(1);
});
