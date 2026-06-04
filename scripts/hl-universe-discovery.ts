/**
 * hl-universe-discovery — DB-free, server-free quant scan: "which Hyperliquid perp
 * should the desk make markets in?" We only ever quoted the BTC/ETH/SOL preset; HL
 * lists ~150+ perps, and the maker edge usually lives in the MID-TIER coins (wider
 * natural spread, still enough flow to fill) rather than the razor-tight majors.
 * This is the mission's growth frontier — market discovery (CLAUDE.md §1).
 *
 * Two stages, both over HL's public `info` POST (no key, no signing):
 *   1. ONE `metaAndAssetCtxs` call → the WHOLE universe + per-coin funding + daily
 *      $ volume. Shortlist the top HLD_SHORTLIST by volume (bounds the HTTP work).
 *   2. Per shortlisted coin: `candleSnapshot` klines → score with the SAME honest
 *      `scoreMmSuitability` the live screener uses (spread + rebate − adverse,
 *      fillability-weighted). Surface the non-major quotable perps (the discovery).
 *
 * HONESTY: OHLCV proxies, no L2 book / flow tape — this RANKS, it does not forecast
 * fills. The real verdict on the shortlist is the L2 queue-aware capture + γ/κ tune
 * (mm-l2-session → mm-l2-tune). Funding is reported (APR + sign), NOT scored — a
 * maker's inventory is involuntary, so funding only helps when its sign aligns with
 * the inventory the flow forces on the book.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/hl-universe-discovery.ts
 *   HLD_INTERVAL=1h HLD_BARS=240 HLD_MIN_VOL_USD=5000000 HLD_SHORTLIST=50 \
 *     npx ts-node -r tsconfig-paths/register scripts/hl-universe-discovery.ts
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';
import { barsPerDayForInterval } from '../src/stat-arb/discovery/net-edge-scorer';
import {
  parseHlUniverse,
  scoreHlPerp,
  assembleDiscoveryBoard,
  HlDiscoveryConfig,
  HlPerpScore,
} from '../src/market-making/screen/hl-universe-discovery';

const BASE = (process.env['HYPERLIQUID_BASE_URL'] ?? 'https://api.hyperliquid.xyz').replace(/\/+$/, '');
const INTERVAL = process.env['HLD_INTERVAL'] ?? '1h';
const BARS = parseInt(process.env['HLD_BARS'] ?? '240', 10);
const VOL_WINDOW = parseInt(process.env['HLD_VOL_WINDOW'] ?? '30', 10);
const HALF_SPREAD_BPS = parseFloat(process.env['HLD_HALF_SPREAD_BPS'] ?? '1');
const MAKER_FEE_BPS = parseFloat(process.env['HLD_MAKER_FEE_BPS'] ?? '-0.2'); // HL maker rebate
const ADVERSE_COEF = parseFloat(process.env['HLD_ADVERSE_COEF'] ?? '0.5');
const MIN_VOL_USD = parseFloat(process.env['HLD_MIN_VOL_USD'] ?? '5000000'); // $5M/day floor
const SHORTLIST = parseInt(process.env['HLD_SHORTLIST'] ?? '40', 10);
const MAX_DISCOVERIES = parseInt(process.env['HLD_MAX_DISCOVERIES'] ?? '8', 10);
const WRITE = (process.env['HLD_WRITE'] ?? 'true').toLowerCase() === 'true';

const cfg: HlDiscoveryConfig = {
  quoteHalfSpreadBps: HALF_SPREAD_BPS,
  makerFeeBps: MAKER_FEE_BPS,
  volWindowBars: VOL_WINDOW,
  barsPerDay: barsPerDayForInterval(INTERVAL),
  adverseCoef: ADVERSE_COEF,
  minDayNtlVlmUsd: MIN_VOL_USD,
};

async function postInfo(body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL info POST -> HTTP ${res.status}`);
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usdM = (n: number) => `$${(n / 1e6).toFixed(1)}M`;
const pad = (s: string | number, w: number) => String(s).padStart(w);
const padR = (s: string | number, w: number) => String(s).padEnd(w);

async function main(): Promise<void> {
  console.log(`\nHL universe MM discovery — ${INTERVAL} bars, half-spread ${HALF_SPREAD_BPS}bps, maker ${MAKER_FEE_BPS}bps, liq floor ${usdM(MIN_VOL_USD)}/day`);
  console.log('='.repeat(112));

  // ── Stage 1: the whole universe in one call ────────────────────────────────
  const universe = parseHlUniverse(await postInfo({ type: 'metaAndAssetCtxs' }));
  if (universe.length === 0) {
    console.error('No universe returned (shape changed or network blocked). Aborting.');
    process.exit(1);
  }
  const byVol = [...universe].sort((a, b) => b.dayNtlVlmUsd - a.dayNtlVlmUsd);
  const shortlist = byVol.slice(0, SHORTLIST);
  console.log(`universe=${universe.length} perps · shortlisting top ${shortlist.length} by daily volume (≥ ${usdM(shortlist[shortlist.length - 1]?.dayNtlVlmUsd ?? 0)})\n`);

  // ── Stage 2: score each shortlisted perp on real klines ────────────────────
  const client = new HyperliquidClient({ baseUrl: BASE });
  const scored: HlPerpScore[] = [];
  for (const ctx of shortlist) {
    try {
      const bars = await client.klines(ctx.name, INTERVAL, BARS);
      const s = scoreHlPerp(ctx, bars, cfg);
      if (s) scored.push(s);
      process.stdout.write('.');
    } catch {
      process.stdout.write('x'); // skip a coin that errors; keep scanning
    }
    await sleep(80); // be polite to the public endpoint
  }
  console.log('\n');

  const board = assembleDiscoveryBoard(scored, universe.length, { maxDiscoveries: MAX_DISCOVERIES });

  // ── The board ──────────────────────────────────────────────────────────────
  const header =
    `${padR('coin', 8)}${pad('$vol/day', 10)}${pad('mark', 12)}${pad('fundAPR%', 10)}` +
    `${pad('volBps', 9)}${pad('rangeBps', 9)}${pad('fillProb', 9)}${pad('net/RT', 9)}${pad('score/day', 11)}  flags`;
  console.log(header);
  console.log('-'.repeat(112));
  for (const i of board.instruments) {
    const flags = `${i.isMajor ? 'MAJOR ' : ''}${i.quotable ? '✓quotable' : ''}`.trim();
    console.log(
      `${padR(i.symbol, 8)}${pad(usdM(i.dayNtlVlmUsd), 10)}${pad(i.markPx.toPrecision(6), 12)}` +
        `${pad(i.fundingAprPct.toFixed(1), 10)}${pad(i.volBps.toFixed(1), 9)}${pad(i.avgRangeBps.toFixed(1), 9)}` +
        `${pad(i.fillProbPerBar.toFixed(3), 9)}${pad(i.netPerRoundTripBps.toFixed(2), 9)}${pad(i.scorePerDayBps.toFixed(2), 11)}  ${flags}`,
    );
  }

  // ── The discovery payload + honest verdict ─────────────────────────────────
  console.log('\n' + '='.repeat(112));
  console.log(`SCANNED ${board.scored} / shortlist ${shortlist.length} · QUOTABLE ${board.quotable} · NON-MAJOR DISCOVERIES ${board.discoveries.length}`);

  if (board.discoveries.length) {
    console.log(`\nStrict discoveries (non-major, cleared the fixed-spread gate), best score/day first:`);
    for (const d of board.discoveries) {
      console.log(`  ${padR(d.symbol, 8)} score/day ${d.scorePerDayBps.toFixed(2)}bps · net/RT ${d.netPerRoundTripBps.toFixed(2)}bps · vol ${usdM(d.dayNtlVlmUsd)}/day · fundAPR ${d.fundingAprPct.toFixed(1)}%`);
    }
  } else {
    console.log(`\nNo perp clears the FIXED-spread gate — expected: the proxy charges full-σ adverse against a fixed ${HALF_SPREAD_BPS}bps spread, but the live book quotes a σ-PROPORTIONAL spread. So the actionable output is the calmest-liquid shortlist below (lowest inventory risk), not a yes/no.`);
  }

  // The actionable deliverable: the calmest liquid perps to point the L2 capture at.
  console.log(`\nCalmest liquid perps (lowest 1${INTERVAL.replace(/[0-9]/g, '')}-σ → least inventory risk + adverse; the L2-capture shortlist):`);
  for (const c of board.calmestLiquid) {
    console.log(`  ${padR(c.symbol, 8)} σ ${c.volBps.toFixed(1)}bps · vol ${usdM(c.dayNtlVlmUsd)}/day · fundAPR ${c.fundingAprPct.toFixed(1)}%${c.isMajor ? ' (major)' : ''}`);
  }
  console.log(`\nSuggested next L2-capture symbols: [${board.suggestedPresetSymbols.join(', ')}]`);

  console.log(
    `\nHONESTY: OHLCV proxies (no L2 book / flow tape) — this RANKS by inventory risk, it does NOT forecast fills.\n` +
      `The MM edge is the rebate + queue position at a σ-proportional spread, a fill/flow question only the L2\n` +
      `harness resolves. Next: capture a real L2 tape on the shortlist (scripts/mm-l2-session.ts, MM_L2_SAVE_TAPE)\n` +
      `then γ/κ-tune queue-aware (scripts/mm-l2-tune.ts) before quoting size. Funding is reported, not scored.`,
  );

  // ── Artifact ────────────────────────────────────────────────────────────────
  if (WRITE) {
    const dir = 'docs/research/hl-universe';
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `${dir}/discovery-${stamp}.json`;
    writeFileSync(path, JSON.stringify({ config: cfg, interval: INTERVAL, bars: BARS, board }, null, 2));
    console.log(`\nartifact: ${path}`);
  }
}

main().catch((e) => {
  console.error(`hl-universe-discovery failed: ${(e as Error).message}`);
  process.exit(1);
});
