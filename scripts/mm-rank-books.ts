/*
 * mm-rank-books.ts — rank a finished screen's books by REALISED FILL EDGE → a launch-ready
 * KEEP set + hedge map (MASTER_PLAN.md §3.2, Journal #67). This is the SELECTION layer on top
 * of mm-leak-table.ts: it consumes the leak-table JSON (the authoritative per-book identity,
 * net = fillEdge + warehouse + funding − fees) so it never re-derives the accounting.
 *
 * WHY fillEdge, NOT net (the whole point): net is contaminated by WAREHOUSE DRIFT, which is luck
 * the desk provably cannot predict (#65 κ-gate). On the 25-screen, HYPE's +$226 net was fillEdge
 * −$120 (badly picked off, adverse +509) rescued by +$344 FAVOURABLE drift that reverts — a
 * mirage. fillEdge = spreadCaptured − adverse = the quoter's OWN edge, the only term that
 * persists. Market selection keeps the books whose quoter earns; the inventory TIME-STOP (armed
 * in the concentrate run) cuts the warehouse drift. So we rank on the edge and let the time-stop
 * handle the drift — never the other way round.
 *
 * Output (stdout + docs/research/rank-books-<label>.{md,json}):
 *   • a fillEdge-ranked table with a category (KEEP / WATCH / CUT) and flags per book,
 *   • a ready-to-paste  BOOKS=( … )  array (the KEEP set, capped to --keep if given),
 *   • MM_HEDGE_BETA_MAP (only books with a real factor hedge: underlying≠self & R²≥--min-r2),
 *   • MM_FAST_SYMBOLS, and the NAKED list (their warehouse control is the time-stop, not a hedge).
 *
 * It RECOMMENDS; the operator decides (trading-policy is the operator's). The thresholds are all
 * flags so the rule is transparent and tunable, not a black box.
 *
 * Run: npx ts-node -r tsconfig-paths/register scripts/mm-rank-books.ts \
 *        [--leak docs/research/leak-table-<label>.json]  (default: newest leak-table-*.json) \
 *        [--keep 8] [--min-fill-edge 0] [--min-fills 10] [--min-r2 0.5] \
 *        [--warehouse-flag 50] [--adverse-ratio 0.8] [--label concentrate]
 */
import * as fs from 'fs';
import * as path from 'path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const num = (name: string, dflt: number): number => {
  const v = arg(name);
  return v === undefined ? dflt : Number(v);
};
const fmt = (v: number): string => (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(0);
const fmt1 = (v: number): string => (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(1);

interface LeakBook {
  book: string;
  source: string;
  netUsd: number;
  realisedUsd: number;
  unrealUsd: number;
  inventoryMtmUsd: number;
  fillEdgeUsd: number;
  spreadCapturedUsd: number;
  adverseUsd: number;
  maxDdPct: number;
  fills: number | null;
  vpin: number | null;
  markoutLongBps: number | null;
  stateAgeOk: boolean;
}
interface HedgeQ {
  book_key: string;
  underlying: string;
  beta_cfg: number;
  r2: number | null;
}

type Category = 'KEEP' | 'WATCH' | 'CUT';
interface Ranked {
  b: LeakBook;
  category: Category;
  flags: string[];
  hedge: { underlying: string; beta: number } | null; // null ⇒ naked
}

/** Newest docs/research/leak-table-*.json by mtime. */
function newestLeak(): string {
  const dir = path.join('docs', 'research');
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^leak-table-.*\.json$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (files.length === 0) throw new Error('no docs/research/leak-table-*.json found — run mm-leak-table.ts first');
  return path.join(dir, files[0].f);
}

function main(): void {
  const leakPath = arg('leak') ?? newestLeak();
  const minFillEdge = num('min-fill-edge', 0);
  const minFills = num('min-fills', 10);
  const minR2 = num('min-r2', 0.5);
  const warehouseFlag = num('warehouse-flag', 50);
  const adverseRatio = num('adverse-ratio', 0.8);
  const keepN = arg('keep') ? parseInt(arg('keep')!, 10) : undefined;
  const label = arg('label') ?? 'rank';

  const raw = JSON.parse(fs.readFileSync(leakPath, 'utf8')) as {
    books: LeakBook[];
    hedgeQuality: HedgeQ[];
    desk: { realisedUsd: number; netUsd: number; hours: number };
    since: string;
    until: string;
  };
  const hq = new Map<string, HedgeQ>(raw.hedgeQuality.map((q) => [q.book_key, q]));

  const ranked: Ranked[] = raw.books
    .slice()
    .sort((a, b) => b.fillEdgeUsd - a.fillEdgeUsd)
    .map((b) => {
      const flags: string[] = [];
      const fills = b.fills ?? 0;
      const thin = fills < minFills;
      if (b.fillEdgeUsd < 0) flags.push('PICKED-OFF');
      if (b.netUsd > 0 && b.fillEdgeUsd < 0) flags.push('MIRAGE'); // green only on warehouse luck
      if (b.fillEdgeUsd >= minFillEdge && b.inventoryMtmUsd <= -warehouseFlag) flags.push('WAREHOUSE-KILLED'); // good quoter, drift killed it → time-stop is the fix
      if (b.spreadCapturedUsd > 0 && b.adverseUsd / b.spreadCapturedUsd >= adverseRatio) flags.push('HIGH-ADVERSE');
      if (thin) flags.push('THIN');
      if (!b.stateAgeOk) flags.push('STALE-STATE');

      let category: Category;
      if (b.fillEdgeUsd < minFillEdge) category = 'CUT';
      else if (thin) category = 'WATCH'; // earns, but data-poor — operator continuity call
      else category = 'KEEP';

      // Factor hedge only when one really exists (underlying ≠ self & R² clears the bar, rule #55b).
      // Self-underlying (the screen's "naked pad" placeholder) or weak R² ⇒ naked: the time-stop is
      // the warehouse control, not a delta hedge that cannot be fit.
      const q = hq.get(b.book);
      const hedge =
        q && q.underlying !== b.book && (q.r2 ?? 0) >= minR2 ? { underlying: q.underlying, beta: q.beta_cfg } : null;

      return { b, category, flags, hedge };
    });

  // The selected set: KEEP (hard), then fill from WATCH (highest fillEdge) up to --keep if asked.
  const keeps = ranked.filter((r) => r.category === 'KEEP');
  const watches = ranked.filter((r) => r.category === 'WATCH');
  let selected = keeps;
  if (keepN !== undefined) {
    if (keeps.length >= keepN) selected = keeps.slice(0, keepN);
    else selected = keeps.concat(watches.slice(0, keepN - keeps.length));
  }
  const selectedSet = new Set(selected.map((r) => r.b.book));

  const hedgeMap = selected
    .filter((r) => r.hedge)
    .map((r) => `${r.b.book}|${r.hedge!.underlying}|${r.hedge!.beta.toFixed(2)}`)
    .join(',');
  const nakedBooks = selected.filter((r) => !r.hedge).map((r) => r.b.book);
  const fastSymbols = selected.map((r) => r.b.book).join(',');

  // ── markdown report ─────────────────────────────────────────────────────────────────────
  const md: string[] = [];
  md.push(`# MM book ranking — ${label}`);
  md.push(`Source: ${path.basename(leakPath)} · window ${raw.since} → ${raw.until}`);
  md.push(
    `Desk over the screen: realised ${fmt(raw.desk.realisedUsd)} / ${raw.desk.hours.toFixed(1)}h. ` +
      `Rule: KEEP iff fillEdge ≥ ${fmt(minFillEdge)} AND fills ≥ ${minFills}; WATCH = earns but < ${minFills} fills (thin); ` +
      `CUT = fillEdge < ${fmt(minFillEdge)}. Ranked on REALISED FILL EDGE (not net — net is warehouse luck).`,
  );
  md.push('');
  md.push('| rank | book | cat | fillEdge | spread | adverse | warehouse | realised | net | fills | maxDD% | mk300s | flags |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  ranked.forEach((r, i) => {
    const b = r.b;
    md.push(
      `| ${i + 1} | ${b.book} | ${r.category} | ${fmt(b.fillEdgeUsd)} | ${fmt(b.spreadCapturedUsd)} | ${fmt(b.adverseUsd)} | ${fmt(b.inventoryMtmUsd)} | ${fmt(b.realisedUsd)} | ${fmt(b.netUsd)} | ${b.fills ?? 'n/a'} | ${b.maxDdPct.toFixed(2)} | ${b.markoutLongBps === null ? 'n/a' : fmt1(b.markoutLongBps)} | ${r.flags.join(' ') || '—'} |`,
    );
  });
  md.push('');
  md.push(`## Launch-ready (selected ${selected.length}${keepN ? ` of --keep ${keepN}` : ''})`);
  md.push('');
  md.push('```bash');
  md.push(`# BOOKS for launch-concentrate.sh (KEEP${keepN && keeps.length < keepN ? ' + thin WATCH continuity' : ''}, ranked by fillEdge):`);
  md.push(`BOOKS=(${selected.map((r) => r.b.book).join(' ')})`);
  md.push('');
  md.push('# server env (start-desk.sh overrides):');
  md.push(`MM_FAST_SYMBOLS=${fastSymbols}`);
  md.push(`MM_HEDGE_BETA_MAP='${hedgeMap}'`);
  md.push('```');
  md.push('');
  md.push(
    `**Hedged (factor hedge, R²≥${minR2}):** ${selected.filter((r) => r.hedge).map((r) => `${r.b.book}→${r.hedge!.underlying}`).join(', ') || '(none)'}`,
  );
  md.push(
    `**Naked (no fittable factor hedge — the inventory time-stop is their warehouse control):** ${nakedBooks.join(', ') || '(none)'}`,
  );
  md.push('');
  md.push(`**CUT (${ranked.filter((r) => r.category === 'CUT').length}):** ${ranked.filter((r) => r.category === 'CUT').map((r) => r.b.book).join(' ') || '(none)'}`);
  const mirages = ranked.filter((r) => r.flags.includes('MIRAGE'));
  if (mirages.length) md.push(`**⚠ MIRAGE (green net on warehouse luck, fillEdge<0 — do NOT keep on net):** ${mirages.map((r) => `${r.b.book} (net ${fmt(r.b.netUsd)}, fillEdge ${fmt(r.b.fillEdgeUsd)})`).join('; ')}`);

  const outBase = path.join('docs', 'research', `rank-books-${label}`);
  fs.writeFileSync(`${outBase}.md`, md.join('\n') + '\n');
  fs.writeFileSync(
    `${outBase}.json`,
    JSON.stringify(
      {
        leak: path.basename(leakPath),
        params: { minFillEdge, minFills, minR2, warehouseFlag, adverseRatio, keepN: keepN ?? null },
        selected: selected.map((r) => ({ book: r.b.book, fillEdgeUsd: r.b.fillEdgeUsd, hedge: r.hedge, flags: r.flags })),
        booksArray: selected.map((r) => r.b.book),
        hedgeBetaMap: hedgeMap,
        fastSymbols,
        nakedBooks,
        cut: ranked.filter((r) => r.category === 'CUT').map((r) => r.b.book),
        ranked: ranked.map((r) => ({ book: r.b.book, category: r.category, flags: r.flags, fillEdgeUsd: r.b.fillEdgeUsd, realisedUsd: r.b.realisedUsd, netUsd: r.b.netUsd, inventoryMtmUsd: r.b.inventoryMtmUsd })),
      },
      null,
      2,
    ) + '\n',
  );

  // echo the actionable bits to stdout
  console.log(md.join('\n'));
  console.log(`\nwritten: ${outBase}.md (+ .json)`);
}

main();
