/*
 * hedgeable-universe.ts — the #55b asset-selection rule made operational:
 * "WE DO NOT MAKE MARKETS IN WHAT WE CANNOT DELTA-HEDGE" (operator rule, 2026-06-11).
 *
 * For every candidate book it fits β / R² of the book's returns on each PLAUSIBLE hedge leg
 * (30d × 1h HL candles, OLS on log returns — same math as hedge-beta-fit.ts) and prints a
 * board: book → best leg, β, R², hedgeability verdict. A book is HEDGEABLE when its best
 * R² ≥ HU_MIN_R2 (default 0.5 for crypto factor legs; equities/commodities pairs are judged
 * on the same bar). Books that fail run NAKED and are excluded from the desk by the rule.
 *
 * Candidate→leg map (the desk's actual hedge instruments — all tradeable HL perps):
 *   crypto alts            → BTC, ETH                (the classic factor legs)
 *   xyz:GOLD, xyz:SILVER   → PAXG (HL main dex gold) (+GOLD↔SILVER cross-check)
 *   xyz:CL                 → xyz:BRENTOIL            (WTI↔Brent — the tightest oil pair)
 *   xyz single-name equity → xyz:SP500, xyz:XYZ100   (index factor hedge; idio remains!)
 *
 * HONESTY: (1) equity/commodity xyz series go FLAT off-RTH — zero-return bars corrupt OLS, so
 * bar pairs where either leg printed a 0 return are DROPPED (fit is RTH-co-movement only; n
 * shows the surviving sample). (2) An index hedge on a single name removes the FACTOR only —
 * the idiosyncratic move (most of a single name's variance, R² will say it) stays naked.
 * (3) β drifts; re-fit between runs. DB-free, public HL REST, no key (CLAUDE.md §7).
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/hedgeable-universe.ts
 *      HU_BARS=720 HU_INTERVAL=1h HU_MIN_R2=0.5 npx ts-node ... scripts/hedgeable-universe.ts
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';

const INTERVAL = process.env['HU_INTERVAL'] ?? '1h';
const BARS = parseInt(process.env['HU_BARS'] ?? '720', 10);
const MIN_R2 = parseFloat(process.env['HU_MIN_R2'] ?? '0.5');

/** book symbol → candidate hedge legs (first match by best R² wins). */
const CANDIDATES: Record<string, string[]> = {
  // crypto alts (HL main dex) — the measured-edge set + liquid discovery names
  SOL: ['BTC', 'ETH'], ADA: ['BTC', 'ETH'], DOGE: ['BTC', 'ETH'], SUI: ['BTC', 'ETH'],
  XRP: ['BTC', 'ETH'], kPEPE: ['BTC', 'ETH'], FARTCOIN: ['BTC', 'ETH'], PURR: ['BTC', 'ETH'],
  HYPE: ['BTC', 'ETH'], NEAR: ['BTC', 'ETH'], WLD: ['BTC', 'ETH'], ENA: ['BTC', 'ETH'],
  CRV: ['BTC', 'ETH'], LIT: ['BTC', 'ETH'], VVV: ['BTC', 'ETH'], XMR: ['BTC', 'ETH'],
  ZEC: ['BTC', 'ETH'], INJ: ['BTC', 'ETH'], SPX: ['BTC', 'ETH'], PENGU: ['BTC', 'ETH'],
  // commodities (xyz dex) → real commodity legs
  'xyz:GOLD': ['PAXG', 'xyz:SILVER'],
  'xyz:SILVER': ['PAXG', 'xyz:GOLD'],
  'xyz:CL': ['xyz:BRENTOIL'],
  'xyz:BRENTOIL': ['xyz:CL'],
  'xyz:COPPER': ['PAXG'],
  // single-name / index equities (xyz dex) → index factor legs
  'xyz:NVDA': ['xyz:SP500', 'xyz:XYZ100'], 'xyz:TSLA': ['xyz:SP500', 'xyz:XYZ100'],
  'xyz:SKHX': ['xyz:SP500', 'xyz:XYZ100'], 'xyz:ORCL': ['xyz:SP500', 'xyz:XYZ100'],
  'xyz:SNDK': ['xyz:SP500', 'xyz:XYZ100'], 'xyz:MU': ['xyz:SP500', 'xyz:XYZ100'],
  'xyz:MRVL': ['xyz:SP500', 'xyz:XYZ100'], 'xyz:INTC': ['xyz:SP500', 'xyz:XYZ100'],
  'xyz:ORCL2': [], // (placeholder slot — keep map literal-friendly)
};
delete CANDIDATES['xyz:ORCL2'];

function logReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}

/** OLS of y on x over PAIRED bars, dropping pairs where either return is 0 (closed-session
 *  flats on xyz equities corrupt the fit — honesty note in the header). */
function regress(y: number[], x: number[]): { beta: number; r2: number; n: number } {
  const n0 = Math.min(y.length, x.length);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n0; i++) {
    const xv = x[x.length - n0 + i];
    const yv = y[y.length - n0 + i];
    if (xv !== 0 && yv !== 0) { xs.push(xv); ys.push(yv); }
  }
  const n = xs.length;
  if (n < 50) return { beta: 0, r2: 0, n };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return { beta: 0, r2: 0, n };
  const beta = sxy / sxx;
  const r2 = (sxy * sxy) / (sxx * syy);
  return { beta, r2, n };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const hl = new HyperliquidClient();
  const legs = new Set<string>(Object.values(CANDIDATES).flat());
  const all = new Set<string>([...Object.keys(CANDIDATES), ...legs]);
  console.log(`\nhedgeable-universe — ${BARS}×${INTERVAL} HL candles, hedgeability bar R² ≥ ${MIN_R2}`);
  console.log('='.repeat(100));

  const returns = new Map<string, number[]>();
  for (const sym of all) {
    try {
      const bars = await hl.klines(sym, INTERVAL, BARS);
      const closes = bars.map((b) => b.close);
      if (closes.length < 100) { console.log(`  ${sym.padEnd(14)} SKIP (${closes.length} bars)`); continue; }
      returns.set(sym, logReturns(closes));
    } catch (e) {
      console.log(`  ${sym.padEnd(14)} SKIP (${(e as Error).message})`);
    }
    await sleep(150); // be polite to the public endpoint
  }

  type Row = { book: string; leg: string; beta: number; r2: number; n: number; hedgeable: boolean };
  const rows: Row[] = [];
  for (const [book, candidateLegs] of Object.entries(CANDIDATES)) {
    const y = returns.get(book);
    if (!y) continue;
    let best: Row = { book, leg: '—', beta: 0, r2: 0, n: 0, hedgeable: false };
    for (const leg of candidateLegs) {
      const x = returns.get(leg);
      if (!x) continue;
      const f = regress(y, x);
      if (f.r2 > best.r2) best = { book, leg, beta: f.beta, r2: f.r2, n: f.n, hedgeable: f.r2 >= MIN_R2 };
    }
    rows.push(best);
  }

  rows.sort((a, b) => b.r2 - a.r2);
  console.log(`\n${'book'.padEnd(14)} ${'best leg'.padEnd(14)} ${'β'.padStart(7)} ${'R²'.padStart(6)} ${'n'.padStart(6)}  verdict`);
  console.log('-'.repeat(64));
  for (const r of rows) {
    console.log(
      `${r.book.padEnd(14)} ${r.leg.padEnd(14)} ${r.beta.toFixed(2).padStart(7)} ${r.r2.toFixed(2).padStart(6)} ${String(r.n).padStart(6)}  ${r.hedgeable ? 'HEDGEABLE' : 'NAKED — excluded by the rule'}`,
    );
  }
  const out = `docs/research/hedgeable-universe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(out, JSON.stringify({ interval: INTERVAL, bars: BARS, minR2: MIN_R2, rows }, null, 2));
  console.log(`\nartifact: ${out}`);
  console.log(`paste-ready map (hedgeable only):\n  MM_HEDGE_BETA_MAP="${rows.filter((r) => r.hedgeable).map((r) => `${r.book}:${r.leg}:${r.beta.toFixed(2)}`).join(',')}"`);
}

main().catch((e) => { console.error(e); process.exit(1); });
