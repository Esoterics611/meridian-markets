/*
 * mm-leak-table.ts — the S1 per-book / per-run leak table (MASTER PLAN I, Session S1).
 *
 * Pulls the authoritative run read from the THREE captures we always have — mm_nav (P&L curve),
 * mm_book_state (persisted accumulators incl. the continuous inventory MTM), and the run log
 * (HEDGE ▸ churn lines + zombie check) — plus the live snapshot when the desk is still up, and
 * emits a ranked leak table (markdown + json under docs/research/).
 *
 * The accounting identity it audits (Journal #49/#51 → fixed this session in mm-book.ts):
 *   net = fillEdge + inventoryMtm + funding − fees
 * where inventoryMtm is the CONTINUOUS warehouse term (accrueInterval, persisted as
 * inventoryCarryUnits in mm_book_state) and fillEdge is implied exactly as
 *   fillEdge = net − inventoryMtm − funding + fees.
 * When the desk is live, the snapshot splits fillEdge into the engine's windowed
 * spreadCaptured − adverseSelection, and the leftover is the quote→fill mid WEDGE (stale-quote
 * pick-off between quote placement and fill) — reported, never hidden. For finished runs the
 * windowed split is a GAP (the engine's windowed attribution is not persisted; spread/adverse
 * read 0 in mm_book_state for fast-path books — only the live snapshot has them).
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/mm-leak-table.ts \
 *     [--since 2026-06-10T22:00:00Z] [--until 2026-06-11T06:00:00Z] \
 *     [--log docs/research/run-20260611-012606-mm10h.log] [--label run51]
 *
 * DB creds are the paper-demo defaults (localhost:5433, app role). DB-only — never touches the
 * trading process (S1 rules of engagement).
 */
import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

interface NavRow {
  book_key: string;
  as_of: Date;
  net: number;
  realised: number;
  unreal: number;
  fees: number;
  maxdd: number;
}

interface BookLeak {
  book: string;
  source: string;
  netUsd: number;
  realisedUsd: number;
  unrealUsd: number;
  feesUsd: number; // + = cost paid, − = rebate earned
  fundingUsd: number;
  inventoryMtmUsd: number | null; // continuous warehouse term (state); null if state missing/stale
  fillEdgeUsd: number | null; // implied: net − invMtm − funding + fees
  spreadCapturedUsd: number | null; // live snapshot only
  adverseUsd: number | null; // live snapshot only (+ = loss)
  wedgeUsd: number | null; // fillEdge − (spread − adverse); live only
  maxDdPct: number;
  worstBucketUsd: number; // worst 5-min net delta in the window
  worstBucketShare: number | null; // |worst| / total loss across losing buckets
  fills: number | null; // live snapshot only
  vpin: number | null;
  stateAgeOk: boolean;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const usd = (units: string | number | null | undefined): number =>
  units === null || units === undefined ? 0 : Number(units) / 1e6;
const fmt = (v: number | null): string => (v === null ? 'n/a' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0));

async function main(): Promise<void> {
  const until = arg('until') ? new Date(arg('until')!) : new Date();
  const since = arg('since') ? new Date(arg('since')!) : new Date(until.getTime() - 12 * 3600_000);
  const label = arg('label') ?? `${since.toISOString().slice(0, 16)}_${until.toISOString().slice(11, 16)}`.replace(/[:T]/g, '-');
  const logPath = arg('log');

  const db = new Client({
    host: 'localhost',
    port: 5433,
    user: 'meridian_markets_app',
    password: 'meridian_markets_app',
    database: 'meridian_markets',
  });
  await db.connect();

  // ── mm_nav: the P&L curve per book inside the window ────────────────────────────────────────
  const nav = await db.query(
    `select book_key, as_of,
            net_pnl_units::numeric/1e6 net, realised_pnl_units::numeric/1e6 realised,
            unrealised_pnl_units::numeric/1e6 unreal, fees_units::numeric/1e6 fees,
            max_drawdown_pct maxdd
       from mm_nav
      where as_of >= $1 and as_of <= $2 and book_key !~ '^it-nav-'
      order by book_key, as_of`,
    [since, until],
  );
  const byBook = new Map<string, NavRow[]>();
  for (const r of nav.rows as NavRow[]) {
    const k = r.book_key;
    if (!byBook.has(k)) byBook.set(k, []);
    byBook.get(k)!.push(r);
  }
  if (byBook.size === 0) {
    console.error(`no mm_nav rows in [${since.toISOString()} .. ${until.toISOString()}] — wrong window?`);
    await db.end();
    process.exit(1);
  }

  // ── mm_book_state: persisted accumulators (continuous inventory MTM + funding) ──────────────
  const states = await db.query(
    `select symbol, source, status, updated_at,
            state->>'inventoryCarryUnits' inv_mtm,
            state->>'fundingUnits' funding
       from mm_book_state`,
  );

  // ── live snapshot (optional): the windowed spread/adverse split + fills/vpin ────────────────
  // Only when the window ends ~now — a live snapshot describes the CURRENT run and must never be
  // merged into a historical window (the books reset at relaunch).
  const snapApplies = Date.now() - until.getTime() < 15 * 60_000;
  let snapBooks: Map<string, Record<string, unknown>> | null = null;
  if (snapApplies)
  try {
    const res = await fetch('http://localhost:3100/api/market-making/snapshot', { signal: AbortSignal.timeout(4000) });
    const body = (await res.json()) as { books: Array<Record<string, unknown>> };
    snapBooks = new Map(body.books.map((b) => [String(b['symbol']), b]));
  } catch {
    snapBooks = null; // server down — windowed split becomes a reported gap
  }

  const books: BookLeak[] = [];
  let desk: { netUsd: number; realisedUsd: number; unrealUsd: number; feesUsd: number; hours: number } | null = null;

  for (const [key, rows] of byBook) {
    const last = rows[rows.length - 1];
    const first = rows[0];
    if (key === '') {
      desk = {
        netUsd: Number(last.net),
        realisedUsd: Number(last.realised),
        unrealUsd: Number(last.unreal),
        feesUsd: Number(last.fees),
        hours: (last.as_of.getTime() - first.as_of.getTime()) / 3600_000,
      };
      continue;
    }

    // Worst 5-min bucket of net deltas (loss concentration).
    let worst = 0;
    let lossSum = 0;
    const buckets = new Map<number, number>();
    for (let i = 1; i < rows.length; i++) {
      const d = Number(rows[i].net) - Number(rows[i - 1].net);
      const b = Math.floor(rows[i].as_of.getTime() / 300_000);
      buckets.set(b, (buckets.get(b) ?? 0) + d);
    }
    for (const d of buckets.values()) {
      if (d < worst) worst = d;
      if (d < 0) lossSum += d;
    }

    // The persisted state row, if it plausibly belongs to this run (updated near/after the
    // book's last nav row — a CLOSED checkpoint at remove time, or a live OPEN row).
    const st = (states.rows as Array<Record<string, unknown>>).find((s) => s['symbol'] === key);
    const stateAgeOk =
      !!st && Math.abs(new Date(st['updated_at'] as string).getTime() - last.as_of.getTime()) < 4 * 3600_000;
    const invMtm = stateAgeOk ? usd(st!['inv_mtm'] as string) : null;
    const fundingUsd = stateAgeOk ? usd(st!['funding'] as string) : 0;

    const net = Number(last.net);
    const fees = Number(last.fees);
    const fillEdge = invMtm === null ? null : net - invMtm - fundingUsd + fees;

    const sb = snapBooks?.get(key);
    const spread = sb ? usd(sb['spreadCapturedUnits'] as string) : null;
    const adverse = sb ? usd(sb['adverseSelectionUnits'] as string) : null;
    const wedge = fillEdge !== null && spread !== null && adverse !== null ? fillEdge - (spread - adverse) : null;

    books.push({
      book: key,
      source: st ? String(st['source'] ?? '') : '',
      netUsd: net,
      realisedUsd: Number(last.realised),
      unrealUsd: Number(last.unreal),
      feesUsd: fees,
      fundingUsd,
      inventoryMtmUsd: invMtm,
      fillEdgeUsd: fillEdge,
      spreadCapturedUsd: spread,
      adverseUsd: adverse,
      wedgeUsd: wedge,
      maxDdPct: Number(last.maxdd),
      worstBucketUsd: worst,
      worstBucketShare: lossSum < 0 ? worst / lossSum : null,
      fills: sb ? Number(sb['fills']) : null,
      vpin: sb ? Number(sb['vpin'] ?? 0) : null,
      stateAgeOk,
    });
  }
  books.sort((a, b) => a.netUsd - b.netUsd);

  // ── run-log cuts: hedge churn + zombie check (the in-memory hedge audit trail) ───────────────
  let hedge: { orders: number; notionalUsd: number; estCostUsd: number; flips: number; opens: number; tracks: number; zombieLines: number } | null = null;
  if (logPath && fs.existsSync(logPath)) {
    const text = fs.readFileSync(logPath, 'utf8');
    const lines = text.match(/HEDGE ▸ (BUY|SELL) \$[\d,]+ [\w:]+-perp — (open|reduce|increase|flip)/g) ?? [];
    let notional = 0;
    let flips = 0;
    let opens = 0;
    let tracks = 0;
    for (const l of lines) {
      notional += Number((l.match(/\$([\d,]+)/) ?? ['', '0'])[1].replace(/,/g, ''));
      if (l.endsWith('flip')) flips += 1;
      else if (l.endsWith('open')) opens += 1;
      else tracks += 1;
    }
    hedge = {
      orders: lines.length,
      notionalUsd: notional,
      estCostUsd: notional * 0.00027, // 2.5bps taker + 1bp half-spread ≈ 2.7bps round cost
      flips,
      opens,
      tracks,
      zombieLines: (text.match(/markAll: skipping/g) ?? []).length,
    };
  }

  // ── the ranked leak list: every negative $ term across the desk, largest first ───────────────
  const leaks: Array<{ term: string; usd: number }> = [];
  for (const b of books) {
    if (b.fillEdgeUsd !== null && b.fillEdgeUsd < 0) leaks.push({ term: `${b.book} fill edge (picked off)`, usd: b.fillEdgeUsd });
    if (b.inventoryMtmUsd !== null && b.inventoryMtmUsd < 0) leaks.push({ term: `${b.book} warehouse MTM`, usd: b.inventoryMtmUsd });
    if (b.feesUsd > 0) leaks.push({ term: `${b.book} fees paid`, usd: -b.feesUsd });
    if (b.fundingUsd < 0) leaks.push({ term: `${b.book} funding paid`, usd: b.fundingUsd });
  }
  if (hedge) leaks.push({ term: 'hedge churn (est taker cost)', usd: -hedge.estCostUsd });
  leaks.sort((a, b) => a.usd - b.usd);

  const booksNet = books.reduce((s, b) => s + b.netUsd, 0);
  const hedgeLegImplied = desk ? desk.netUsd - booksNet : null;

  // ── render ───────────────────────────────────────────────────────────────────────────────────
  const md: string[] = [];
  md.push(`# MM leak table — ${label}`);
  md.push(`Window: ${since.toISOString()} → ${until.toISOString()}${logPath ? ` · log: ${path.basename(logPath)}` : ''}`);
  md.push(`Snapshot: ${snapBooks ? 'LIVE (windowed spread/adverse included)' : 'server down — windowed split unavailable (gap)'}\n`);
  if (desk) {
    md.push(
      `**Desk:** net ${fmt(desk.netUsd)} (realised ${fmt(desk.realisedUsd)}, unreal ${fmt(desk.unrealUsd)}, fees ${fmt(desk.feesUsd)}) over ${desk.hours.toFixed(1)}h` +
        ` · books-sum net ${fmt(booksNet)} · implied hedge-leg P&L ${fmt(hedgeLegImplied)}`,
    );
  }
  if (hedge) {
    md.push(
      `**Hedge:** ${hedge.orders} orders · $${Math.round(hedge.notionalUsd).toLocaleString()} churned · est cost $${hedge.estCostUsd.toFixed(0)}` +
        ` · ${hedge.tracks} track / ${hedge.flips} flip / ${hedge.opens} open · zombie lines ${hedge.zombieLines}`,
    );
  }
  md.push('\n## Per-book identity — net = fillEdge + warehouseMTM + funding − fees ($)\n');
  md.push('| book | net | fillEdge | warehouse | funding | fees | spread | adverse | wedge | maxDD% | worst5m | conc | fills | vpin |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const b of books) {
    md.push(
      `| ${b.book}${b.stateAgeOk ? '' : ' ⚠stale-state'} | ${fmt(b.netUsd)} | ${fmt(b.fillEdgeUsd)} | ${fmt(b.inventoryMtmUsd)} | ${fmt(b.fundingUsd)} | ${fmt(b.feesUsd)} | ${fmt(b.spreadCapturedUsd)} | ${fmt(b.adverseUsd)} | ${fmt(b.wedgeUsd)} | ${b.maxDdPct.toFixed(2)} | ${fmt(b.worstBucketUsd)} | ${b.worstBucketShare === null ? 'n/a' : (b.worstBucketShare * 100).toFixed(0) + '%'} | ${b.fills ?? 'n/a'} | ${b.vpin === null ? 'n/a' : b.vpin.toFixed(2)} |`,
    );
  }
  md.push('\n## Ranked leaks ($, largest first)\n');
  leaks.slice(0, 15).forEach((l, i) => md.push(`${i + 1}. ${l.term}: ${fmt(l.usd)}`));
  md.push('\n## Gaps (not computable from today\'s capture)\n');
  md.push('- Windowed spread/adverse for FINISHED runs: the engine\'s windowed attribution is not persisted (mm_book_state has 0 for fast books) — live snapshot only.');
  md.push('- Markout by book×side×hour: per-fill markout records are aggregated in-memory, not persisted per hour.');
  md.push('- Queue tercile at fill, top-of-hour toxicity (±3min funding prints): not logged yet.');
  md.push('- HIP-3 (xyz:*) funding: per-dex funding unwired — funding term is 0 by construction, not measured.');
  md.push('- Hedge leg realised P&L: in-memory only (DR-2); implied here as desk-net − books-sum.');

  const outDir = path.join('docs', 'research');
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, `leak-table-${label}.md`);
  fs.writeFileSync(mdPath, md.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, `leak-table-${label}.json`), JSON.stringify({ since, until, desk, hedgeLegImplied, hedge, books, leaks }, null, 1));
  console.log(md.join('\n'));
  console.error(`\nwritten: ${mdPath} (+ .json)`);
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
