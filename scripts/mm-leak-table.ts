/*
 * mm-leak-table.ts — the S1 per-book / per-run leak table (MASTER PLAN I S1; F0 upgrade, Journal #59).
 *
 * Pulls the authoritative run read from the captures we always have — mm_nav (P&L curve),
 * mm_book_state (persisted accumulators incl. the continuous inventory MTM AND, since S2/F0,
 * the engine's windowed spread/adverse), the F0 research tables (mm_fill_markout per-fill
 * markouts, mm_hedge_nav per-leg hedge P&L, mm_hedge_quality), and the run log (HEDGE ▸ churn
 * lines + zombie check) — plus the live snapshot when the desk is still up. Emits a ranked
 * leak table (markdown + json under docs/research/).
 *
 * The accounting identity it audits (Journal #49/#51):
 *   net = fillEdge + inventoryMtm + funding − fees
 * where inventoryMtm is the CONTINUOUS warehouse term (accrueInterval, persisted as
 * inventoryCarryUnits in mm_book_state) and fillEdge is implied exactly as
 *   fillEdge = net − inventoryMtm − funding + fees.
 * The windowed spread/adverse split now persists for FINISHED runs (mm_book_state carries the
 * fast engine's windowed attribution since S2; checkpointed at remove/shutdown); the leftover
 * is the quote→fill mid WEDGE (stale-quote pick-off). The live snapshot, when present, is
 * preferred (it is more current than the last checkpoint).
 *
 * F0 additions: true hedge-leg P&L from mm_hedge_nav (no longer implied as desk−books),
 * hedge quality (basisShare/betaLive/R²), per-hour diagnostic strip (fills/flow/VPIN/σ/markout
 * by hour), the A = sign(q)·sign(flow) alignment quadrant split, markout by queue tercile,
 * top-of-hour (±3min) toxicity, a corrupt-mark filter on the nav curve (run55: a boot-window
 * mark of −$3.03M on a $1M book poisoned worst5m), and `--self-check` (assert no n/a columns
 * for a finished run; non-zero exit if a persistence path regressed).
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/mm-leak-table.ts \
 *     [--since 2026-06-10T22:00:00Z] [--until 2026-06-11T06:00:00Z] \
 *     [--log docs/research/run-20260611-012606-mm10h.log] [--label run51] [--self-check]
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
  equity: number;
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
  spreadCapturedUsd: number | null; // live snapshot, else mm_book_state checkpoint
  adverseUsd: number | null; // + = loss
  wedgeUsd: number | null; // fillEdge − (spread − adverse)
  maxDdPct: number;
  worstBucketUsd: number; // worst 5-min net delta in the window (corrupt marks filtered)
  worstBucketShare: number | null; // |worst| / total loss across losing buckets
  worstBucketSuspect: boolean; // |worst5m| breached the sanity bound even after filtering
  corruptRowsDropped: number; // nav rows excluded by the corrupt-mark filter
  fills: number | null; // live snapshot, else mm_fill_markout count
  vpin: number | null;
  markoutShortBps: number | null; // mean per-fill markout at the shortest horizon
  markoutLongBps: number | null; // mean per-fill markout at the longest horizon
  stateAgeOk: boolean;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const usd = (units: string | number | null | undefined): number =>
  units === null || units === undefined ? 0 : Number(units) / 1e6;
const fmt = (v: number | null): string => (v === null ? 'n/a' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0));
const fmt1 = (v: number | null): string => (v === null ? 'n/a' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1));

/** Worst5m sanity bound (F0 item 6): a single 5-min bucket beyond max(20×|net|, $500) on a
 *  capped paper book means corrupt marks, not P&L. */
const worstBucketBound = (netUsd: number): number => Math.max(20 * Math.abs(netUsd), 500);

async function main(): Promise<void> {
  const until = arg('until') ? new Date(arg('until')!) : new Date();
  const since = arg('since') ? new Date(arg('since')!) : new Date(until.getTime() - 12 * 3600_000);
  const label = arg('label') ?? `${since.toISOString().slice(0, 16)}_${until.toISOString().slice(11, 16)}`.replace(/[:T]/g, '-');
  const logPath = arg('log');
  const selfCheck = flag('self-check');

  const db = new Client({
    host: 'localhost',
    port: 5433,
    user: 'meridian_markets_app',
    password: 'meridian_markets_app',
    database: 'meridian_markets',
  });
  await db.connect();

  // Tolerant query for the F0 research tables: a pre-F0 database (tables absent) degrades to a
  // reported gap, never a crash.
  const tryRows = async (sql: string, params: unknown[]): Promise<Array<Record<string, unknown>> | null> => {
    try {
      return (await db.query(sql, params)).rows as Array<Record<string, unknown>>;
    } catch {
      return null;
    }
  };

  // ── mm_nav: the P&L curve per book inside the window ────────────────────────────────────────
  const nav = await db.query(
    `select book_key, as_of,
            net_pnl_units::numeric/1e6 net, realised_pnl_units::numeric/1e6 realised,
            unrealised_pnl_units::numeric/1e6 unreal, fees_units::numeric/1e6 fees,
            equity_units::numeric/1e6 equity, max_drawdown_pct maxdd
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

  // ── mm_book_state: persisted accumulators (warehouse MTM, funding, windowed spread/adverse) ──
  const states = await db.query(
    `select symbol, source, status, updated_at,
            state->>'inventoryCarryUnits' inv_mtm,
            state->>'fundingUnits' funding,
            state->>'spreadCapturedUnits' spread,
            state->>'adverseUnits' adverse
       from mm_book_state`,
  );

  // ── F0 research tables ───────────────────────────────────────────────────────────────────────
  const horizons = await tryRows(
    `select distinct horizon_ms from mm_fill_markout where ts >= $1 and ts <= $2 order by 1`,
    [since, until],
  );
  const hList = (horizons ?? []).map((r) => Number(r['horizon_ms']));
  const hShort = hList[0];
  const hLong = hList[hList.length - 1];

  // Per-book per-fill stats at the short + long horizons (fills counted once at the short one).
  const fillStats = hShort
    ? await tryRows(
        `select book_key,
                count(*) filter (where horizon_ms = $3)::int fills,
                avg(vpin) filter (where horizon_ms = $3)::float vpin,
                avg(markout_bps) filter (where horizon_ms = $3)::float mk_short,
                avg(markout_bps) filter (where horizon_ms = $4)::float mk_long
           from mm_fill_markout where ts >= $1 and ts <= $2 group by book_key`,
        [since, until, hShort, hLong],
      )
    : null;
  const fillByBook = new Map((fillStats ?? []).map((r) => [String(r['book_key']), r]));

  // A = sign(q)·sign(flow) alignment quadrant split per book, at the LONG horizon (the
  // adverse-selection read) — F4's calibration data. A0 = flat inventory or zero/absent flow.
  const quad = hLong
    ? await tryRows(
        `select book_key,
                case when flow is null then 'A0'
                     when sign(flow) * sign(inventory_units_before) > 0 then 'A+'
                     when sign(flow) * sign(inventory_units_before) < 0 then 'A-'
                     else 'A0' end quad,
                count(*)::int n,
                avg(markout_bps)::float bps,
                sum(markout_bps / 1e4 * notional_units / 1e6)::float usd
           from mm_fill_markout where ts >= $1 and ts <= $2 and horizon_ms = $3
          group by 1, 2`,
        [since, until, hLong],
      )
    : null;

  // Per-hour diagnostic strip (desk level): which hours pay us.
  const hourly = hLong
    ? await tryRows(
        `select date_trunc('hour', ts) hr,
                count(*)::int fills,
                avg(abs(flow))::float aflow,
                avg(vpin)::float vpin,
                avg(sigma)::float sigma,
                avg(markout_bps)::float bps,
                sum(markout_bps / 1e4 * notional_units / 1e6)::float usd
           from mm_fill_markout where ts >= $1 and ts <= $2 and horizon_ms = $3
          group by 1 order by 1`,
        [since, until, hLong],
      )
    : null;

  // Markout by FIFO queue-position tercile (1 = front of queue) at the long horizon.
  const terciles = hLong
    ? await tryRows(
        `select t, count(*)::int n, avg(bps)::float bps from (
           select markout_bps bps, ntile(3) over (order by queue_ahead_units) t
             from mm_fill_markout
            where ts >= $1 and ts <= $2 and horizon_ms = $3 and queue_ahead_units is not null
         ) x group by t order by t`,
        [since, until, hLong],
      )
    : null;

  // Top-of-hour toxicity: fills within ±3min of the hour (HL funds on the hour) vs the rest.
  const topOfHour = hLong
    ? await tryRows(
        `select case when extract(minute from ts) >= 57 or extract(minute from ts) < 3
                     then 'top' else 'rest' end w,
                count(*)::int n, avg(markout_bps)::float bps
           from mm_fill_markout where ts >= $1 and ts <= $2 and horizon_ms = $3
          group by 1`,
        [since, until, hLong],
      )
    : null;

  // True hedge-leg P&L per underlying (mm_hedge_nav, cumulative per leg → window delta).
  const hedgeLegs = await tryRows(
    `select underlying,
            count(*)::int n,
            (array_agg(pnl_usd order by as_of desc))[1] - (array_agg(pnl_usd order by as_of asc))[1] pnl,
            (array_agg(funding_usd order by as_of desc))[1] - (array_agg(funding_usd order by as_of asc))[1] funding,
            (array_agg(fees_usd order by as_of desc))[1] - (array_agg(fees_usd order by as_of asc))[1] fees,
            (array_agg(residual_usd order by as_of desc))[1] resid,
            (array_agg(notional_usd order by as_of desc))[1] notional
       from mm_hedge_nav where as_of >= $1 and as_of <= $2 group by underlying`,
    [since, until],
  );
  const hedgeMeasuredUsd =
    hedgeLegs && hedgeLegs.length > 0 ? hedgeLegs.reduce((s, l) => s + Number(l['pnl']), 0) : null;

  // Hedge quality (latest per book inside the window): basisShare/betaLive/R² vs configured β.
  const hedgeQuality = await tryRows(
    `select distinct on (book_key) book_key, underlying, beta_cfg, beta_live, r2, basis_share
       from mm_hedge_quality where as_of >= $1 and as_of <= $2
      order by book_key, as_of desc`,
    [since, until],
  );

  // ── live snapshot (optional): the CURRENT windowed split + fills/vpin ────────────────────────
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
    snapBooks = null; // server down — fall back to the persisted checkpoint
  }

  const books: BookLeak[] = [];
  let desk: { netUsd: number; realisedUsd: number; unrealUsd: number; feesUsd: number; hours: number } | null = null;
  let deskRows: NavRow[] = [];

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
      deskRows = rows;
      continue;
    }

    // Corrupt-mark filter (run55 worst5m root cause): a boot/relaunch row can mark inventory
    // against a garbage mid (kPEPE unreal −$3.03M, FARTCOIN −$30k, all in the same 14:01–14:10Z
    // episode). Real |unreal| on these capped books is $0–230 with medians under $3, so a row
    // whose |unreal| exceeds max(100 × the book's median |unreal|, $500) — or the book's median
    // equity outright — is a corrupt mid, not P&L; exclude it from the curve walk. The NAV cron
    // now refuses to write rows beyond capital; this defends history + the sub-capital cases.
    const medianEquity = [...rows].map((r) => Number(r.equity)).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    const medAbsUnreal = [...rows].map((r) => Math.abs(Number(r.unreal))).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    const unrealBound = Math.min(Math.max(100 * medAbsUnreal, 500), Math.max(medianEquity, 1));
    const sane = rows.filter((r) => Math.abs(Number(r.unreal)) <= unrealBound);
    const corruptRowsDropped = rows.length - sane.length;

    // Worst 5-min bucket of net deltas (loss concentration) over the sane curve.
    // Two delta classes are NOT P&L and are skipped (run55: SOL "worst5m −20,416 vs +25 net"):
    //  - a RELAUNCH RESET — the book restarts at net≈0, so the step from the old run's
    //    cumulative net down to 0 is a generation boundary, not a 5-minute loss;
    //  - a delta across a SAMPLING GAP > 10 min (server down between runs) — same boundary.
    let worst = 0;
    let lossSum = 0;
    const buckets = new Map<number, number>();
    for (let i = 1; i < sane.length; i++) {
      const cur = Number(sane[i].net);
      const prev = Number(sane[i - 1].net);
      const gapMs = sane[i].as_of.getTime() - sane[i - 1].as_of.getTime();
      const isReset = Math.abs(cur) < 1 && Math.abs(prev) > 100;
      if (isReset || gapMs > 10 * 60_000) continue;
      const b = Math.floor(sane[i].as_of.getTime() / 300_000);
      buckets.set(b, (buckets.get(b) ?? 0) + (cur - prev));
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

    // Windowed spread/adverse: live snapshot first (most current), else the persisted
    // checkpoint (mm_book_state carries the fast engine's windowed attribution since S2/F0).
    const sb = snapBooks?.get(key);
    const spread = sb ? usd(sb['spreadCapturedUnits'] as string) : stateAgeOk ? usd(st!['spread'] as string) : null;
    const adverse = sb ? usd(sb['adverseSelectionUnits'] as string) : stateAgeOk ? usd(st!['adverse'] as string) : null;
    const wedge = fillEdge !== null && spread !== null && adverse !== null ? fillEdge - (spread - adverse) : null;

    const fb = fillByBook.get(key);
    const worstBucketSuspect = Math.abs(worst) > worstBucketBound(net);

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
      worstBucketSuspect,
      corruptRowsDropped,
      fills: sb ? Number(sb['fills']) : fb ? Number(fb['fills']) : null,
      vpin: sb ? Number(sb['vpin'] ?? 0) : fb && fb['vpin'] !== null ? Number(fb['vpin']) : null,
      markoutShortBps: fb && fb['mk_short'] !== null ? Number(fb['mk_short']) : null,
      markoutLongBps: fb && fb['mk_long'] !== null ? Number(fb['mk_long']) : null,
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
  for (const l of hedgeLegs ?? []) {
    const p = Number(l['pnl']);
    if (p < 0) leaks.push({ term: `hedge leg ${String(l['underlying'])} (measured)`, usd: p });
  }
  if (hedge) leaks.push({ term: 'hedge churn (est taker cost)', usd: -hedge.estCostUsd });
  leaks.sort((a, b) => a.usd - b.usd);

  const booksNet = books.reduce((s, b) => s + b.netUsd, 0);
  const hedgeLegImplied = desk ? desk.netUsd - booksNet : null;

  // Desk net per hour (for the hourly strip).
  const deskHour = new Map<string, number>();
  for (let i = 1; i < deskRows.length; i++) {
    const hr = new Date(deskRows[i].as_of).toISOString().slice(0, 13);
    deskHour.set(hr, (deskHour.get(hr) ?? 0) + (Number(deskRows[i].net) - Number(deskRows[i - 1].net)));
  }

  // ── render ───────────────────────────────────────────────────────────────────────────────────
  const md: string[] = [];
  md.push(`# MM leak table — ${label}`);
  md.push(`Window: ${since.toISOString()} → ${until.toISOString()}${logPath ? ` · log: ${path.basename(logPath)}` : ''}`);
  md.push(
    `Windowed split: ${snapBooks ? 'LIVE snapshot' : 'persisted checkpoint (mm_book_state)'}` +
      ` · per-fill markouts: ${hShort ? `mm_fill_markout @ ${hList.map((h) => `${h / 1000}s`).join('/')}` : 'NOT PERSISTED (pre-F0 run)'}\n`,
  );
  if (desk) {
    md.push(
      `**Desk:** net ${fmt(desk.netUsd)} (realised ${fmt(desk.realisedUsd)}, unreal ${fmt(desk.unrealUsd)}, fees ${fmt(desk.feesUsd)}) over ${desk.hours.toFixed(1)}h` +
        ` · books-sum net ${fmt(booksNet)} · hedge-leg P&L measured ${fmt(hedgeMeasuredUsd)} (implied ${fmt(hedgeLegImplied)})`,
    );
  }
  if (hedge) {
    md.push(
      `**Hedge:** ${hedge.orders} orders · $${Math.round(hedge.notionalUsd).toLocaleString()} churned · est cost $${hedge.estCostUsd.toFixed(0)}` +
        ` · ${hedge.tracks} track / ${hedge.flips} flip / ${hedge.opens} open · zombie lines ${hedge.zombieLines}`,
    );
  }
  if (hedgeLegs && hedgeLegs.length > 0) {
    md.push('\n## Hedge legs — measured (mm_hedge_nav, window Δ per leg)\n');
    md.push('| leg | P&L | funding | fees | last residual | last notional |');
    md.push('|---|---|---|---|---|---|');
    for (const l of hedgeLegs)
      md.push(
        `| ${String(l['underlying'])} | ${fmt1(Number(l['pnl']))} | ${fmt1(Number(l['funding']))} | ${fmt1(Number(l['fees']))} | ${fmt(Number(l['resid']))} | ${fmt(Number(l['notional']))} |`,
      );
  }
  if (hedgeQuality && hedgeQuality.length > 0) {
    md.push('\n## Hedge quality (mm_hedge_quality, latest in window)\n');
    md.push('| book | leg | β cfg | β live | R² | basis share |');
    md.push('|---|---|---|---|---|---|');
    for (const q of hedgeQuality)
      md.push(
        `| ${String(q['book_key'])} | ${String(q['underlying'])} | ${Number(q['beta_cfg']).toFixed(2)} | ${q['beta_live'] === null ? 'n/a' : Number(q['beta_live']).toFixed(2)} | ${q['r2'] === null ? 'n/a' : Number(q['r2']).toFixed(2)} | ${q['basis_share'] === null ? 'n/a' : (Number(q['basis_share']) * 100).toFixed(0) + '%'} |`,
      );
  }
  md.push('\n## Per-book identity — net = fillEdge + warehouseMTM + funding − fees ($)\n');
  md.push(`| book | net | fillEdge | warehouse | funding | fees | spread | adverse | wedge | maxDD% | worst5m | conc | fills | vpin | mk${hShort ? hShort / 1000 : '?'}s | mk${hLong ? hLong / 1000 : '?'}s |`);
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const b of books) {
    md.push(
      `| ${b.book}${b.stateAgeOk ? '' : ' ⚠stale-state'}${b.corruptRowsDropped > 0 ? ` ⚠${b.corruptRowsDropped}-corrupt-marks` : ''} | ${fmt(b.netUsd)} | ${fmt(b.fillEdgeUsd)} | ${fmt(b.inventoryMtmUsd)} | ${fmt(b.fundingUsd)} | ${fmt(b.feesUsd)} | ${fmt(b.spreadCapturedUsd)} | ${fmt(b.adverseUsd)} | ${fmt(b.wedgeUsd)} | ${b.maxDdPct.toFixed(2)} | ${fmt(b.worstBucketUsd)}${b.worstBucketSuspect ? ' ⚠SUSPECT' : ''} | ${b.worstBucketShare === null ? 'n/a' : (b.worstBucketShare * 100).toFixed(0) + '%'} | ${b.fills ?? 'n/a'} | ${b.vpin === null ? 'n/a' : b.vpin.toFixed(2)} | ${fmt1(b.markoutShortBps)} | ${fmt1(b.markoutLongBps)} |`,
    );
  }
  if (quad && quad.length > 0) {
    md.push(`\n## Alignment split — A = sign(q)·sign(flow), markout @ ${hLong! / 1000}s (F4 calibration)\n`);
    md.push('| book | A+ fills | A+ bps | A+ $ | A− fills | A− bps | A− $ |');
    md.push('|---|---|---|---|---|---|---|');
    const byBookQuad = new Map<string, Record<string, Record<string, unknown>>>();
    for (const r of quad) {
      const k = String(r['book_key']);
      if (!byBookQuad.has(k)) byBookQuad.set(k, {});
      byBookQuad.get(k)![String(r['quad'])] = r;
    }
    for (const [k, qs] of [...byBookQuad.entries()].sort()) {
      const p = qs['A+'];
      const m = qs['A-'];
      md.push(
        `| ${k} | ${p ? Number(p['n']) : 0} | ${p ? fmt1(Number(p['bps'])) : 'n/a'} | ${p ? fmt1(Number(p['usd'])) : 'n/a'} | ${m ? Number(m['n']) : 0} | ${m ? fmt1(Number(m['bps'])) : 'n/a'} | ${m ? fmt1(Number(m['usd'])) : 'n/a'} |`,
      );
    }
  }
  if (hourly && hourly.length > 0) {
    md.push(`\n## Per-hour strip — which hours pay (markout @ ${hLong! / 1000}s)\n`);
    md.push('| hour (UTC) | desk netΔ | fills | ⌀abs(flow) | ⌀vpin | ⌀σ | mk bps | mk $ |');
    md.push('|---|---|---|---|---|---|---|---|');
    for (const h of hourly) {
      const hr = new Date(h['hr'] as string).toISOString().slice(0, 13);
      md.push(
        `| ${hr} | ${fmt1(deskHour.get(hr) ?? null)} | ${Number(h['fills'])} | ${h['aflow'] === null ? 'n/a' : Number(h['aflow']).toFixed(2)} | ${h['vpin'] === null ? 'n/a' : Number(h['vpin']).toFixed(2)} | ${h['sigma'] === null ? 'n/a' : Number(h['sigma']).toExponential(1)} | ${fmt1(Number(h['bps']))} | ${fmt1(Number(h['usd']))} |`,
      );
    }
  }
  if ((terciles && terciles.length > 0) || (topOfHour && topOfHour.length > 0)) {
    md.push('\n## Microstructure cuts\n');
    if (terciles && terciles.length > 0)
      md.push(
        `- Markout @ ${hLong! / 1000}s by queue tercile (1 = front): ` +
          terciles.map((t) => `T${Number(t['t'])} ${fmt1(Number(t['bps']))}bps (n=${Number(t['n'])})`).join(' · '),
      );
    if (topOfHour && topOfHour.length > 0) {
      const top = topOfHour.find((r) => r['w'] === 'top');
      const rest = topOfHour.find((r) => r['w'] === 'rest');
      md.push(
        `- Top-of-hour (±3min, funding prints): ${top ? `${fmt1(Number(top['bps']))}bps (n=${Number(top['n'])})` : 'no fills'} vs rest ${rest ? `${fmt1(Number(rest['bps']))}bps (n=${Number(rest['n'])})` : 'n/a'}`,
      );
    }
  }
  md.push('\n## Ranked leaks ($, largest first)\n');
  leaks.slice(0, 15).forEach((l, i) => md.push(`${i + 1}. ${l.term}: ${fmt(l.usd)}`));

  // Remaining gaps — only what is STILL not computable (F0 closed the rest).
  const gaps: string[] = [];
  if (!hShort) gaps.push('Per-fill markouts (mm_fill_markout): no rows in window — pre-F0 run, or persistence regressed.');
  if (!hedgeLegs || hedgeLegs.length === 0) gaps.push('Hedge-leg P&L (mm_hedge_nav): no rows in window — hedge off, pre-F0 run, or persistence regressed.');
  if (!hedgeQuality || hedgeQuality.length === 0) gaps.push('Hedge quality (mm_hedge_quality): no rows in window.');
  if (books.some((b) => b.spreadCapturedUsd === null)) gaps.push('Windowed spread/adverse missing for some books (no live snapshot and stale/absent mm_book_state checkpoint).');
  if (gaps.length > 0) {
    md.push('\n## Gaps (not computable from this capture)\n');
    gaps.forEach((g) => md.push(`- ${g}`));
  }

  const outDir = path.join('docs', 'research');
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, `leak-table-${label}.md`);
  fs.writeFileSync(mdPath, md.join('\n') + '\n');
  fs.writeFileSync(
    path.join(outDir, `leak-table-${label}.json`),
    JSON.stringify({ since, until, desk, hedgeMeasuredUsd, hedgeLegImplied, hedge, hedgeLegs, hedgeQuality, books, leaks, hourly, quad, terciles, topOfHour }, null, 1),
  );
  console.log(md.join('\n'));
  console.error(`\nwritten: ${mdPath} (+ .json)`);
  await db.end();

  // ── --self-check: a finished run must have NO n/a in the load-bearing columns ────────────────
  if (selfCheck) {
    const fails: string[] = [];
    for (const b of books) {
      if (b.fillEdgeUsd === null) fails.push(`${b.book}: fillEdge n/a (mm_book_state checkpoint missing/stale)`);
      if (b.spreadCapturedUsd === null || b.adverseUsd === null) fails.push(`${b.book}: windowed spread/adverse n/a`);
      if (b.wedgeUsd === null) fails.push(`${b.book}: wedge n/a`);
      if (b.fills === null) fails.push(`${b.book}: fills n/a (no mm_fill_markout rows)`);
      if (b.markoutLongBps === null) fails.push(`${b.book}: per-fill markout n/a (mm_fill_markout)`);
      if (b.worstBucketSuspect) fails.push(`${b.book}: worst5m ${b.worstBucketUsd.toFixed(0)} breaches sanity bound ±${worstBucketBound(b.netUsd).toFixed(0)}`);
    }
    if (hedgeMeasuredUsd === null) fails.push('hedge: no measured leg P&L (mm_hedge_nav empty in window)');
    if (!hedgeQuality || hedgeQuality.length === 0) fails.push('hedge: no quality rows (mm_hedge_quality empty in window)');
    if (!hourly || hourly.length === 0) fails.push('per-hour strip: empty');
    if (fails.length > 0) {
      console.error(`\nSELF-CHECK FAILED (${fails.length}):`);
      fails.forEach((f) => console.error(`  ✗ ${f}`));
      process.exit(2);
    }
    console.error('\nSELF-CHECK OK — every load-bearing column computed from persistence.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
