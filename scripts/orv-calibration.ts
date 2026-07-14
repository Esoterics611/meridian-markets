/**
 * orv-calibration — PHASE 0 of the prediction-market maker plan (+ the #96 Brier gate).
 * Collector only: NO positions, NO quotes — it records what a maker WOULD have seen.
 *
 * Two pre-registered questions, one tape (docs/PREDICTION_MARKET_MM_RESEARCH.md §5):
 *   1. MAKER: if the desk rested two-sided quotes around its live-spot RND fair on the
 *      HIP-4 YES books, what would fill? → snapshot fair + L2 depth every OCAL_SNAP_MS;
 *      scripts/orv-maker-replay.ts answers offline (width × cadence grid).
 *   2. CALIBRATION (#96, for the parked position book): at T−6h/3h/1h freeze (fair, mid);
 *      at settle score Brier(RND) vs Brier(market mid). ≥100 settles + bootstrap CI
 *      decide. HONESTY: HIP-4 lists ~2 Deribit-priceable dailies (BTC, ETH — Deribit has
 *      no SOL chain, probed 2026-07-14) ⇒ ~2 settles/day ⇒ this gate needs WEEKS of tape.
 *      The maker verdict does not wait for it (§4 of the memo).
 *
 * The millisecond-model mechanic: the Deribit smile (iv, dσ/dK at strike) refreshes every
 * OCAL_SMILE_MS; BETWEEN refreshes fair is recomputed EVERY TICK off the live HL perp mid
 * — the smile moves in minutes, the spot term in milliseconds (#27–#33 applied here).
 * Frozen-smile honesty: iv-at-strike drifts as spot moves (vanna); second-order over 60s
 * at daily tenor. The #92 spot guard (venue vs Deribit ±5%) runs at refresh AND per tick.
 *
 * Call budget: 1 allMids + N_markets × l2Book per snap (~3 req/s at 2 priceable markets,
 * 1s cadence) + 1 Deribit chain per ccy per OCAL_SMILE_MS. Well inside public limits.
 *
 * Run (operator, DB-free; tape rotates daily, ~50–100MB/day/market — git-ignored):
 *   npx ts-node -r tsconfig-paths/register scripts/orv-calibration.ts
 * Knobs:
 *   OCAL_SNAP_MS(1000) OCAL_DEPTH(5) OCAL_SMILE_MS(60000) OCAL_DISCOVERY_MS(60000)
 *   OCAL_HEARTBEAT_MS(30000) OCAL_HOURS(0=indefinite) OCAL_DIR(docs/research/orv-maker/tapes)
 */
import * as fs from 'fs';
import * as path from 'path';
import { DeribitClient } from '../src/derivatives/deribit/deribit-client';
import { impliedDigital } from '../src/derivatives/rnd/implied-digital';
import {
  DeribitDigitalSource,
  MAX_SPOT_DISAGREE_FRAC,
} from '../src/prediction/deribit-digital-source';
import { HyperliquidOutcomeClient } from '../src/prediction/hyperliquid-outcome-client';
import { CalibrationBook, brierSummary } from '../src/prediction/calibration-score';
import { PriceBinarySpec } from '../src/prediction/binary-market.types';
import { TapeSnap } from '../src/prediction/maker-tape.types';

const SNAP_MS = Number(process.env.OCAL_SNAP_MS ?? 1_000);
const DEPTH = Number(process.env.OCAL_DEPTH ?? 5);
const SMILE_MS = Number(process.env.OCAL_SMILE_MS ?? 60_000);
const DISCOVERY_MS = Number(process.env.OCAL_DISCOVERY_MS ?? 60_000);
const HEARTBEAT_MS = Number(process.env.OCAL_HEARTBEAT_MS ?? 30_000);
const HOURS = Number(process.env.OCAL_HOURS ?? 0);
const DIR = process.env.OCAL_DIR ?? 'docs/research/orv-maker/tapes';
/** Deribit-priceable underlyings only (SOL/HYPE have no chain — never guessed). */
const PRICEABLE = new Set(['BTC', 'ETH']);
/** Dedup: skip writing when the depth-view is unchanged and fair moved less than this. */
const DEDUP_FAIR_EPS = 5e-4;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

const log = (msg: string) => console.log(`[ocal ${new Date().toISOString().slice(11, 19)}] ${msg}`);

fs.mkdirSync(DIR, { recursive: true });
let tapeDate = '';
let tapePath = '';
function jline(o: Record<string, unknown>): void {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== tapeDate) {
    tapeDate = day;
    tapePath = path.join(DIR, `tape-${day}.jsonl`);
    log(`tape → ${tapePath}`);
  }
  fs.appendFileSync(tapePath, JSON.stringify(o) + '\n');
}

interface SmileCache {
  iv: number;
  skewPerDollar: number;
  deribitSpot: number;
  atMs: number;
}

interface ActiveMarket {
  spec: PriceBinarySpec;
  smile: SmileCache | null;
  lastWritten: { fairYes: number; top: string } | null;
  lastWrittenMs: number;
  snapsWritten: number;
}

async function main(): Promise<void> {
  const hl = new HyperliquidOutcomeClient();
  const drb = new DeribitDigitalSource(new DeribitClient(), SMILE_MS);
  const calibration = new CalibrationBook();
  const active = new Map<string, ActiveMarket>();
  const t0 = Date.now();
  let settles = 0;
  let errors = 0;
  let lastDiscovery = 0;
  let lastSummary = 0;
  let lastErrorLog = 0;
  let stopping = false;
  process.on('SIGINT', () => (stopping = true));

  log(
    `phase-0 collector up — snap ${SNAP_MS}ms depth ${DEPTH} smile ${SMILE_MS}ms | NO positions, NO quotes | dir ${DIR}`,
  );
  jline({ ev: 'BOOT', ms: t0, snapMs: SNAP_MS, depth: DEPTH, smileMs: SMILE_MS });

  while (!stopping) {
    const nowMs = Date.now();
    if (HOURS > 0 && nowMs - t0 > HOURS * 3_600_000) break;
    try {
      // Discovery: meta-only, priceable underlyings, not yet expired.
      if (nowMs - lastDiscovery > DISCOVERY_MS) {
        lastDiscovery = nowMs;
        const specs = await hl.listPriceBinarySpecs();
        for (const s of specs) {
          if (!PRICEABLE.has(s.underlying.toUpperCase())) continue;
          if (s.expiryMs <= nowMs || active.has(s.marketId)) continue;
          active.set(s.marketId, {
            spec: s,
            smile: null,
            lastWritten: null,
            lastWrittenMs: 0,
            snapsWritten: 0,
          });
          log(
            `DISCOVER ${s.underlying} K=${s.targetPrice} expiry ${new Date(s.expiryMs).toISOString()} (#${s.marketId})`,
          );
        }
      }

      const mids = await hl.mids();

      for (const [id, m] of active) {
        const { spec } = m;
        const hlMid = mids[spec.underlying.toUpperCase()];

        // Settle first (outcome = venue underlying mid at the first tick ≥ expiry).
        if (nowMs >= spec.expiryMs) {
          if (Number.isFinite(hlMid)) {
            const settledYes = hlMid > spec.targetPrice;
            jline({
              ev: 'SETTLE',
              ms: nowMs,
              marketId: id,
              underlying: spec.underlying,
              targetPrice: spec.targetPrice,
              expiryMs: spec.expiryMs,
              spotAtExpiry: hlMid,
              settledYes,
              oracle: 'hl-mid-approx',
            });
            const contribs = calibration.onSettle(id, settledYes);
            if (contribs.length) jline({ ev: 'BRIER', ms: nowMs, marketId: id, contribs });
            settles++;
            const b = brierSummary(calibration.all());
            log(
              `SETTLE ${spec.underlying} K=${spec.targetPrice} → ${settledYes ? 'YES' : 'NO'} @${hlMid} | brier fair=${b.brierFair?.toFixed(4)} mid=${b.brierMid?.toFixed(4)} n=${b.n}`,
            );
            active.delete(id);
          }
          continue;
        }

        // Smile refresh (Deribit chain is cached inside the source per ccy).
        if (!m.smile || nowMs - m.smile.atMs > SMILE_MS) {
          const { fair, reason } = await drb.fairYes(
            spec.underlying,
            spec.targetPrice,
            spec.expiryMs,
            nowMs,
            Number.isFinite(hlMid) ? hlMid : undefined,
          );
          if (fair) {
            m.smile = {
              iv: fair.iv,
              skewPerDollar: fair.skewPerDollar,
              deribitSpot: fair.deribitSpot,
              atMs: nowMs,
            };
          } else if (!m.smile) {
            jline({ ev: 'NOPRICE', ms: nowMs, marketId: id, reason });
            continue;
          } // else: keep the stale smile one more beat, refresh retries next cycle
        }
        if (!m.smile || !Number.isFinite(hlMid)) continue;

        // Per-tick #92 guard: venue spot vs the smile's Deribit spot.
        if (Math.abs(hlMid - m.smile.deribitSpot) / m.smile.deribitSpot > MAX_SPOT_DISAGREE_FRAC) {
          jline({ ev: 'NOPRICE', ms: nowMs, marketId: id, reason: 'spot-guard tick' });
          m.smile = null; // force a refresh next cycle
          continue;
        }

        // Live-spot fair + book snap.
        const tYears = (spec.expiryMs - nowMs) / YEAR_MS;
        const d = impliedDigital({
          spot: hlMid,
          strike: spec.targetPrice,
          tYears,
          iv: m.smile.iv,
          skewPerDollar: m.smile.skewPerDollar,
        });
        const book = await hl.bookDepth(id, 0, DEPTH);
        if (book.bids.length === 0 && book.asks.length === 0) continue;

        const rec: TapeSnap = {
          ev: 'SNAP',
          ms: nowMs,
          marketId: id,
          underlying: spec.underlying,
          targetPrice: spec.targetPrice,
          expiryMs: spec.expiryMs,
          fairYes: d.smileAdjusted,
          naive: d.naive,
          d2: d.d2,
          tYears,
          iv: m.smile.iv,
          hlMid,
          noMid: mids[`#${id}1`] ?? null,
          smileAgeMs: nowMs - m.smile.atMs,
          bids: book.bids,
          asks: book.asks,
        };

        // Calibration feed (needs a two-sided book for an honest mid).
        if (book.bids.length && book.asks.length) {
          calibration.onSnap(
            id,
            spec.expiryMs,
            nowMs,
            d.smileAdjusted,
            (book.bids[0][0] + book.asks[0][0]) / 2,
          );
        }

        // Dedup: unchanged depth-view + fair within eps ⇒ skip (heartbeat still writes).
        const top = JSON.stringify([rec.bids, rec.asks]);
        const unchanged =
          m.lastWritten &&
          m.lastWritten.top === top &&
          Math.abs(m.lastWritten.fairYes - rec.fairYes) < DEDUP_FAIR_EPS;
        if (!unchanged || nowMs - m.lastWrittenMs > HEARTBEAT_MS) {
          jline(rec as unknown as Record<string, unknown>);
          m.lastWritten = { fairYes: rec.fairYes, top };
          m.lastWrittenMs = nowMs;
          m.snapsWritten++;
        }
      }

      if (nowMs - lastSummary > 10 * 60_000) {
        lastSummary = nowMs;
        const b = brierSummary(calibration.all());
        const perMkt = [...active.values()]
          .map((m) => `${m.spec.underlying}:${m.snapsWritten}`)
          .join(' ');
        log(
          `SUMMARY active=${active.size} [${perMkt}] settles=${settles} brierN=${b.n} errors=${errors}`,
        );
        jline({ ev: 'SUMMARY', ms: nowMs, active: active.size, settles, brierN: b.n, errors });
      }
    } catch (err) {
      errors++;
      if (nowMs - lastErrorLog > 60_000) {
        lastErrorLog = nowMs;
        log(`ERROR ${(err as Error).message} (absorbed; ${errors} total)`);
      }
    }
    const elapsed = Date.now() - nowMs;
    if (elapsed < SNAP_MS) await new Promise((r) => setTimeout(r, SNAP_MS - elapsed));
  }

  const b = brierSummary(calibration.all());
  log(
    `FINAL settles=${settles} brier fair=${b.brierFair?.toFixed(4)} mid=${b.brierMid?.toFixed(4)} n=${b.n} errors=${errors} | replay: npx ts-node -r tsconfig-paths/register scripts/orv-maker-replay.ts ${DIR}/tape-*.jsonl`,
  );
  jline({ ev: 'FINAL', ms: Date.now(), settles, brierN: b.n, errors });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
