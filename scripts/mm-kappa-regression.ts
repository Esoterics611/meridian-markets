/* eslint-disable no-console */
/*
 * mm-kappa-regression.ts — F4 Stage B honest gate: does aggressor FLOW lead the forward
 * mid-move, per book?  (MASTER PLAN II F4 Stage B; the κ·f·g re-centering term in
 * src/market-making/risk/flow-regime.ts is HARD-WIRED to 0 until this gate clears.)
 *
 * THE QUESTION (the two non-negotiable priors, flow-regime.ts §0): flow is a risk throttle
 * FIRST, directional alpha SECOND. Stage A shipped the throttle (κ=0). Stage B turns on a
 * directional re-center `alpha = κ·f·g` — but ONLY where the data says flow actually predicts
 * the next-horizon price. "A blind bias loses — leverage on noise" (CLAUDE.md). This script is
 * that proof-or-refusal.
 *
 * THE REGRESSION. mm_fill_markout (F0, Journal #59) persists, per (fill × horizon), the signed
 * markout and the aggressor-flow imbalance `flow` AT THE FILL (markout-tracker.ts documents
 * `flow` verbatim as "the κ regression x"). The markout sign convention (markout-tracker.ts):
 *     markout_bps = side · (mid_{t+h} − fairMid_t)/fairMid_t · 1e4     (BUY:+1, SELL:−1)
 * so the RAW forward mid-move, decoupled from our (adversely-selected) fill side, is
 *     r = markout_bps · sideSign        (un-sign by side)
 * and the re-center monetises exactly the predictable part of r given flow. We therefore
 * regress  r ~ flow  per (book, horizon):
 *   • OLS slope κ_raw (bps of mid-move per unit flow) + t-stat — the MAGNITUDE + significance.
 *   • Spearman IC + hit-rate (sign agreement) — the rank-robust PREDICTIVE gate, the same
 *     discipline as scripts/flow-bias-markout.ts and the #1 OOS gate.
 *
 * THE VERDICT (per book, at the pre-registered headline horizon — default 60s, docs/NEXT_RUN_PREREG):
 *   GREEN  slope>0 AND |t|≥2 AND IC>0  — flow LEADS price; a lean candidate. κ_live suggested
 *                                         (κ_raw/1e4, shrunk ×0.5; PROVISIONAL — needs a live A/B).
 *   RED    slope<0 AND |t|≥2           — flow FADES (mean-reverts); leaning WITH flow would lose.
 *   GREY   else / n<MIN_N              — no signal or insufficient volume; κ stays 0.
 * Multiple-testing caveat (books × horizons): the pooled + the single pre-registered horizon are
 * the primary reads; a per-book GREEN at one horizon out of five is a hypothesis, not a law.
 *
 * DB-only, never touches the trading process (S1 rules of engagement). Paper-demo creds
 * (localhost:5433, app role). Run:
 *   npx ts-node -r tsconfig-paths/register scripts/mm-kappa-regression.ts \
 *     --since 2026-06-14T09:52:00Z --until 2026-06-14T14:09:00Z [--horizon 60000] \
 *     [--books SOL,ADA,DOGE,SUI,FARTCOIN,kPEPE] [--label run-20260614-125055] [--min-n 30]
 */
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

interface Row {
  book_key: string;
  side: string;
  horizon_ms: number;
  markout_bps: number;
  flow: number;
}

interface Fit {
  n: number;
  slope: number; // κ_raw: bps mid-move per unit flow
  tStat: number;
  r2: number;
  ic: number; // Spearman rank IC of flow vs r
  hit: number; // sign-agreement fraction (flow vs r), over nonzero
  meanAbsFlow: number;
}

type Verdict = 'GREEN' | 'RED' | 'GREY';

// ── stats ───────────────────────────────────────────────────────────────────
/** Simple OLS y = a + b·x with the t-stat of b (n−2 df) and R². */
function ols(xs: number[], ys: number[]): { slope: number; tStat: number; r2: number } {
  const n = xs.length;
  if (n < 3) return { slope: NaN, tStat: NaN, r2: NaN };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
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
  if (sxx <= 0) return { slope: NaN, tStat: NaN, r2: NaN };
  const slope = sxy / sxx;
  // residual sum of squares = syy − slope²·sxx; se(b) = sqrt(rss/(n−2) / sxx).
  const rss = Math.max(syy - slope * slope * sxx, 0);
  const se = Math.sqrt(rss / (n - 2) / sxx);
  const tStat = se > 0 ? slope / se : NaN;
  const r2 = syy > 0 ? (slope * slope * sxx) / syy : NaN;
  return { slope, tStat, r2 };
}

/** Spearman rank correlation (ties → average rank). Copied discipline from flow-bias-markout.ts. */
function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const rank = (a: number[]): number[] => {
    const idx = a.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(n).fill(0);
    for (let i = 0; i < n; ) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = rx[i] - mx;
    const ay = ry[i] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

function fit(flows: number[], rs: number[]): Fit {
  const { slope, tStat, r2 } = ols(flows, rs);
  const ic = spearman(flows, rs);
  let agree = 0;
  let used = 0;
  let absFlow = 0;
  for (let i = 0; i < flows.length; i++) {
    absFlow += Math.abs(flows[i]);
    if (flows[i] !== 0 && rs[i] !== 0) {
      used += 1;
      if (Math.sign(flows[i]) === Math.sign(rs[i])) agree += 1;
    }
  }
  return { n: flows.length, slope, tStat, r2, ic, hit: used > 0 ? agree / used : NaN, meanAbsFlow: flows.length ? absFlow / flows.length : NaN };
}

function verdict(f: Fit, minN: number): Verdict {
  if (!Number.isFinite(f.tStat) || f.n < minN) return 'GREY';
  if (f.slope > 0 && f.tStat >= 2 && f.ic > 0) return 'GREEN';
  if (f.slope < 0 && f.tStat <= -2) return 'RED';
  return 'GREY';
}

// ── args ────────────────────────────────────────────────────────────────────
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const since = arg('since');
  const until = arg('until');
  if (!since || !until) {
    console.error('usage: mm-kappa-regression.ts --since ISO --until ISO [--horizon 60000] [--books A,B] [--label L] [--min-n 30]');
    process.exit(1);
  }
  const headlineH = parseInt(arg('horizon', '60000')!, 10);
  const minN = parseInt(arg('min-n', '30')!, 10);
  const label = arg('label', `${since.slice(0, 10)}`)!;
  const booksFilter = arg('books')?.split(',').map((s) => s.trim()).filter(Boolean);

  const db = new Client({ host: 'localhost', port: 5433, user: 'meridian_markets_app', password: 'meridian_markets_app', database: 'meridian_markets' });
  await db.connect();
  const res = await db.query<Row>(
    `select book_key, side, horizon_ms, markout_bps::float8 as markout_bps, flow::float8 as flow
       from mm_fill_markout
      where ts >= $1 and ts <= $2 and flow is not null
        ${booksFilter ? 'and book_key = any($3)' : ''}
      order by book_key, horizon_ms`,
    booksFilter ? [since, until, booksFilter] : [since, until],
  );
  await db.end();

  if (res.rows.length === 0) {
    console.error(`No mm_fill_markout rows in [${since}, ${until}]${booksFilter ? ` for ${booksFilter.join(',')}` : ''}. Pre-F0 run, or wrong window.`);
    process.exit(2);
  }

  // r = raw forward mid-move (un-sign the markout by side). x = flow at the fill.
  const sideSign = (s: string): number => (s === 'BUY' ? 1 : -1);
  const horizons = [...new Set(res.rows.map((r) => r.horizon_ms))].sort((a, b) => a - b);
  const books = [...new Set(res.rows.map((r) => r.book_key))].sort();

  // bucket[book][horizon] = { flows, rs }
  const bucket = new Map<string, Map<number, { flows: number[]; rs: number[] }>>();
  const get = (b: string, h: number) => {
    if (!bucket.has(b)) bucket.set(b, new Map());
    const m = bucket.get(b)!;
    if (!m.has(h)) m.set(h, { flows: [], rs: [] });
    return m.get(h)!;
  };
  for (const row of res.rows) {
    const r = row.markout_bps * sideSign(row.side);
    const cell = get(row.book_key, row.horizon_ms);
    cell.flows.push(row.flow);
    cell.rs.push(r);
    const pooled = get('__POOLED__', row.horizon_ms);
    pooled.flows.push(row.flow);
    pooled.rs.push(r);
  }

  // ── assemble ────────────────────────────────────────────────────────────────
  const fmt = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
  const out: string[] = [];
  out.push(`# F4 Stage B κ-gate — does flow lead the forward mid-move?  (${label})`);
  out.push('');
  out.push(`Window \`${since}\` → \`${until}\` · headline horizon **${headlineH / 1000}s** · min-n ${minN}`);
  out.push(`Regression: \`r = markout_bps·sideSign\` (raw fwd mid-move, bps) ~ \`flow\`  ·  slope = κ_raw (bps/unit-flow)`);
  out.push('');

  // Per-book table at every horizon.
  out.push('## Per (book, horizon)');
  out.push('');
  out.push('| book | horizon | n | κ_raw (bps/f) | t | IC | hit% | verdict |');
  out.push('|---|---|---|---|---|---|---|---|');
  const verdictAtHeadline = new Map<string, { f: Fit; v: Verdict }>();
  const rowOrder = ['__POOLED__', ...books];
  for (const b of rowOrder) {
    for (const h of horizons) {
      const cell = bucket.get(b)?.get(h);
      if (!cell) continue;
      const f = fit(cell.flows, cell.rs);
      const v = verdict(f, minN);
      if (h === headlineH) verdictAtHeadline.set(b, { f, v });
      const name = b === '__POOLED__' ? '**POOLED**' : b;
      out.push(`| ${name} | ${h / 1000}s | ${f.n} | ${fmt(f.slope)} | ${fmt(f.tStat)} | ${fmt(f.ic, 3)} | ${Number.isFinite(f.hit) ? Math.round(f.hit * 100) : 'n/a'} | ${v} |`);
    }
  }
  out.push('');

  // Headline verdict + suggested κ for GREEN books.
  out.push(`## Verdict @ ${headlineH / 1000}s (the pre-registered horizon)`);
  out.push('');
  const greens: Array<{ book: string; kappaLive: number; f: Fit }> = [];
  for (const b of rowOrder) {
    const e = verdictAtHeadline.get(b);
    if (!e) continue;
    const name = b === '__POOLED__' ? 'POOLED (all books)' : b;
    if (e.v === 'GREEN') {
      const kappaLive = (e.f.slope / 1e4) * 0.5; // mid-fraction units, shrunk ×0.5 — PROVISIONAL
      greens.push({ book: b, kappaLive, f: e.f });
      out.push(`- **${name}: GREEN** — κ_raw ${fmt(e.f.slope)} bps/f (t ${fmt(e.f.tStat)}, IC ${fmt(e.f.ic, 3)}, n ${e.f.n}). Suggested live κ ≈ ${kappaLive.toExponential(2)} (½-shrunk, PROVISIONAL — needs a live A/B).`);
    } else if (e.v === 'RED') {
      out.push(`- **${name}: RED** — flow FADES (κ_raw ${fmt(e.f.slope)} bps/f, t ${fmt(e.f.tStat)}). Do NOT lean with flow; a κ>0 re-center would lose here.`);
    } else {
      out.push(`- ${name}: GREY — no significant lead (κ_raw ${fmt(e.f.slope)} bps/f, t ${fmt(e.f.tStat)}, n ${e.f.n}${e.f.n < minN ? ' < min-n' : ''}). κ stays 0.`);
    }
  }
  out.push('');
  out.push('## Recommendation');
  out.push('');
  // The gate "clears" ONLY desk-wide (POOLED GREEN @ headline) — the multiple-testing-robust
  // read. A lone per-book GREEN against a flat/negative POOLED is a hypothesis, not a green
  // light: with #books × #horizons tests, ~5% fire at |t|≥2 by chance. We refuse to arm on it.
  const pooled = verdictAtHeadline.get('__POOLED__');
  const bookGreens = greens.filter((g) => g.book !== '__POOLED__');
  if (pooled?.v === 'GREEN') {
    out.push(`**Gate CLEARS desk-wide.** POOLED @ ${headlineH / 1000}s leads price (κ_raw ${fmt(pooled.f.slope)} bps/f, t ${fmt(pooled.f.tStat)}, IC ${fmt(pooled.f.ic, 3)}, n ${pooled.f.n}). ` +
      'Wire `alpha = κ·f·g` with the suggested live κ below, DEFAULT OFF, and confirm on a live A/B (the S8 shadow rig) before it ever sizes blind.');
    out.push('');
    out.push('```');
    out.push(greens.map((g) => `${g.book === '__POOLED__' ? 'DEFAULT' : g.book}|${g.kappaLive.toExponential(3)}`).join(','));
    out.push('```');
  } else if (bookGreens.length === 0) {
    out.push('**Gate NOT cleared.** No book — and not the desk pool — shows a significant, sign-correct flow→price lead at the headline horizon. ' +
      'Keep `alpha = κ·f·g` at κ=0 (the safe Stage-A default). Accumulate more `mm_fill_markout` volume across runs and re-run this gate — ' +
      "one run's per-book n is thin, and a lean built on noise is the exact failure mode this gate exists to prevent.");
  } else {
    out.push(`**Gate NOT cleared desk-wide.** POOLED @ ${headlineH / 1000}s is flat (${pooled?.v ?? 'n/a'}: κ_raw ${pooled ? fmt(pooled.f.slope) : 'n/a'} bps/f, t ${pooled ? fmt(pooled.f.tStat) : 'n/a'}). ` +
      `The lone per-book GREEN(s) — ${bookGreens.map((g) => g.book).join(', ')} — are HYPOTHESES, not a green light: among ${books.length} books × ${horizons.length} horizons (~${books.length * horizons.length} tests) a few fire at |t|≥2 by chance. ` +
      'Do NOT arm κ on them. Flag each as a watch-book and require a dedicated higher-n confirmation run before any lean. κ stays 0.');
    out.push('');
    out.push('Watch-book candidates (NOT armed — provisional κ if ever confirmed):');
    out.push('```');
    out.push(bookGreens.map((g) => `${g.book}|${g.kappaLive.toExponential(3)}`).join(','));
    out.push('```');
  }
  out.push('');

  const md = out.join('\n');
  const dir = path.join(process.cwd(), 'docs', 'research');
  const mdPath = path.join(dir, `kappa-regression-${label}.md`);
  const jsonPath = path.join(dir, `kappa-regression-${label}.json`);
  fs.writeFileSync(mdPath, md);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        label,
        since,
        until,
        headlineH,
        minN,
        perCell: rowOrder.flatMap((b) =>
          horizons
            .filter((h) => bucket.get(b)?.has(h))
            .map((h) => {
              const c = bucket.get(b)!.get(h)!;
              return { book: b, horizonMs: h, ...fit(c.flows, c.rs) };
            }),
        ),
        greens: greens.map((g) => ({ book: g.book, kappaLive: g.kappaLive })),
      },
      null,
      2,
    ),
  );

  console.log(md);
  console.log(`\nwritten: ${path.relative(process.cwd(), mdPath)} (+ .json)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
