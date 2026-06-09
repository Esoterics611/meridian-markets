/*
 * hedge-beta-fit.ts — OOS β fit for the desk delta-hedge map (Journal #44 DR-3, priority #2).
 *
 * The 8 neutral MM books are one correlated crypto-β bet (#41). The delta hedge can neutralise the
 * BASKET with a single major-perp leg IF we know each alt's β to a major. This script measures those
 * βs from real Hyperliquid candles and prints the MM_HEDGE_BETA_MAP string to paste into the run.
 *
 * Method (plain, honest): pull N hourly candles per coin, compute log returns, and OLS-regress each
 * alt's returns on BTC's and on ETH's (β = cov/var, R² = corr²). Each alt is mapped to whichever
 * major it tracks better (higher R²); BTC/ETH stay self-hedged (omitted ⇒ default self-hedge 1:1).
 * It is DB-free and reads only the public HL REST endpoint — no key, no account (CLAUDE.md §7).
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/hedge-beta-fit.ts            # 720×1h (30d), default universe
 *   npx ts-node -r tsconfig-paths/register scripts/hedge-beta-fit.ts SOL,SUI,ADA 1h 720
 *
 * Honest caveats: β drifts with regime (a 30d fit is a prior, not a constant), R² on alts is modest,
 * and a wrong/over-confident β over-hedges noise — so treat the output as a starting map, re-fit
 * between runs (this IS the run→run training loop, docs/RUN_TRAINING_LOOP.md), and keep the band.
 */
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';

const DEFAULT_UNIVERSE = ['BTC', 'ETH', 'SOL', 'DOGE', 'BNB', 'XRP', 'ADA', 'SUI'];
const MAJORS = ['BTC', 'ETH'];

function logReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  return r;
}

/** OLS slope (β) of y on x and the R² of the fit, over the overlapping length. */
function regress(y: number[], x: number[]): { beta: number; r2: number; n: number } {
  const n = Math.min(y.length, x.length);
  const ys = y.slice(y.length - n);
  const xs = x.slice(x.length - n);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const beta = sxx > 0 ? sxy / sxx : 0;
  const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { beta, r2, n };
}

async function main(): Promise<void> {
  const universe = (process.argv[2] ?? DEFAULT_UNIVERSE.join(',')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const interval = process.argv[3] ?? '1h';
  const limit = parseInt(process.argv[4] ?? '720', 10);
  const symbols = Array.from(new Set([...MAJORS, ...universe]));

  const client = new HyperliquidClient();
  process.stderr.write(`fetching ${symbols.length} symbols × ${limit}×${interval} from Hyperliquid…\n`);

  // Timestamp-aligned closes per symbol (align on shared candle times so returns line up).
  const closesByTs = new Map<string, Map<number, number>>();
  for (const sym of symbols) {
    const bars = await client.klines(sym, interval, limit).catch((e: Error) => {
      process.stderr.write(`  ${sym}: FETCH FAILED — ${e.message}\n`);
      return [];
    });
    const m = new Map<number, number>();
    for (const b of bars) m.set(b.timestamp.getTime(), b.close);
    closesByTs.set(sym, m);
  }

  // Shared timestamps across BTC + ETH define the aligned grid.
  const btcTs = closesByTs.get('BTC');
  const ethTs = closesByTs.get('ETH');
  if (!btcTs?.size || !ethTs?.size) {
    process.stderr.write('no BTC/ETH candles — cannot fit (network down?). Aborting.\n');
    process.exit(1);
  }
  const grid = [...btcTs.keys()].filter((t) => ethTs.has(t)).sort((a, b) => a - b);
  const series = (sym: string): number[] => {
    const m = closesByTs.get(sym)!;
    return grid.filter((t) => m.has(t)).map((t) => m.get(t)!);
  };
  const rBtc = logReturns(grid.filter((t) => btcTs.has(t)).map((t) => btcTs.get(t)!));
  const rEth = logReturns(grid.filter((t) => ethTs.has(t)).map((t) => ethTs.get(t)!));

  const rows: string[] = [];
  const mapEntries: string[] = [];
  rows.push(['coin', 'βBTC', 'R²BTC', 'βETH', 'R²ETH', '→ map'].join('\t'));
  for (const sym of universe) {
    if (MAJORS.includes(sym)) {
      rows.push([sym, '—', '—', '—', '—', `${sym} self-hedge`].join('\t'));
      continue;
    }
    const closes = series(sym);
    if (closes.length < 30) {
      rows.push([sym, 'n/a', '', '', '', 'self-hedge (insufficient data)'].join('\t'));
      continue;
    }
    const rAlt = logReturns(closes);
    const fb = regress(rAlt, rBtc);
    const fe = regress(rAlt, rEth);
    const useEth = fe.r2 > fb.r2;
    const chosen = useEth ? { major: 'ETH', f: fe } : { major: 'BTC', f: fb };
    mapEntries.push(`${sym}:${chosen.major}:${chosen.f.beta.toFixed(2)}`);
    rows.push([sym, fb.beta.toFixed(2), fb.r2.toFixed(2), fe.beta.toFixed(2), fe.r2.toFixed(2), `${sym}→${chosen.major} β${chosen.f.beta.toFixed(2)} (R²${chosen.f.r2.toFixed(2)})`].join('\t'));
  }

  process.stdout.write('\n' + rows.join('\n') + '\n\n');
  process.stdout.write(`MM_HEDGE_BETA_MAP="${mapEntries.join(',')}"\n`);
  process.stdout.write(`\n(paste into scripts/start-desk.sh or export before launch; re-fit between runs — RUN_TRAINING_LOOP.md)\n`);
}

main().catch((e) => {
  process.stderr.write(`hedge-beta-fit failed: ${(e as Error).message}\n`);
  process.exit(1);
});
