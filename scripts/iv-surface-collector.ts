/**
 * iv-surface-collector — PHASE O-0 of the Long-Horizon Options Desk
 * (docs/OPTIONS_DESK.md O-E1/O-E2; journal #101). NO POSITIONS — pure measurement.
 *
 * Every cycle (default hourly), per underlying: read the Deribit chain, pick per
 * target tenor {7,14,30,90d} the ATM + 25Δ/10Δ put + 25Δ call smile points
 * (src/derivatives/surface/surface-snapshot.ts — BS delta at mark IV, honesty
 * tolerances), fetch each point's quoted bid/ask IV (the spread-in-vol-points
 * column every LHO cost claim depends on), update the EWMA realized vol (the #96
 * fix, src/derivatives/surface/ewma-rv.ts) from HL 1h candles, and append one
 * JSONL row per underlying×tenor to the tape.
 *
 * The tape is the Phase O-0 deliverable: ≥14 continuous days gate Phase O-1;
 * ≥30 days let the z-score books (O4 calendars, O5 skew) set their triggers from
 * a measured distribution (the R7 rule). Tapes land in docs/research/options-surface/
 * (git-ignored; query with jq).
 *
 * Run (operator): bash scripts/launch-surface-collector.sh   [start|status|stop]
 * One-shot smoke: OSURF_ONCE=1 npx ts-node -r tsconfig-paths/register scripts/iv-surface-collector.ts
 * Knobs:
 *   OSURF_UNDERLYINGS(BTC,ETH) OSURF_TENORS(7,14,30,90) OSURF_INTERVAL_MIN(60)
 *   OSURF_RV_SEED_HOURS(168) OSURF_EWMA_LAMBDA(0.97) OSURF_DIR(docs/research/options-surface)
 */
import * as fs from 'fs';
import * as path from 'path';
import { DeribitClient } from '../src/derivatives/deribit/deribit-client';
import { EwmaRv } from '../src/derivatives/surface/ewma-rv';
import { selectTenorPicks, SurfacePointPick } from '../src/derivatives/surface/surface-snapshot';
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';

const UNDERLYINGS = (process.env.OSURF_UNDERLYINGS ?? 'BTC,ETH').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const TENORS = (process.env.OSURF_TENORS ?? '7,14,30,90').split(',').map(Number).filter((n) => n > 0);
const INTERVAL_MIN = Number(process.env.OSURF_INTERVAL_MIN ?? 60);
const RV_SEED_HOURS = Number(process.env.OSURF_RV_SEED_HOURS ?? 168);
const EWMA_LAMBDA = Number(process.env.OSURF_EWMA_LAMBDA ?? 0.97);
const ONCE = process.env.OSURF_ONCE === '1';
const DIR = process.env.OSURF_DIR ?? 'docs/research/options-surface';

const HOUR_MS = 3_600_000;

fs.mkdirSync(DIR, { recursive: true });
const tapePath = () => path.join(DIR, `surface-${new Date().toISOString().slice(0, 7)}.jsonl`); // monthly file
const jline = (o: Record<string, unknown>) =>
  fs.appendFileSync(tapePath(), JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const log = (msg: string) => console.log(`[surf ${new Date().toISOString().slice(11, 19)}] ${msg}`);

const pt = (p: SurfacePointPick | undefined, spreadVolPts: number | null | undefined) =>
  p ? { name: p.instrumentName, strike: p.strike, iv: p.iv, delta: p.delta, spreadVolPts: spreadVolPts ?? null } : null;

async function main(): Promise<void> {
  const drb = new DeribitClient();
  const hl = new HyperliquidClient();
  const rv = new Map<string, EwmaRv>();
  const lastBarMs = new Map<string, number>();

  // Seed the EWMA from history so the first rows carry a real RV, not a cold start.
  for (const u of UNDERLYINGS) {
    const est = new EwmaRv(EWMA_LAMBDA);
    const bars = await hl.klines(u, '1h', RV_SEED_HOURS + 1);
    const completed = bars.filter((b) => b.timestamp.getTime() + HOUR_MS <= Date.now());
    est.seed(completed.map((b) => b.close));
    if (completed.length > 0) lastBarMs.set(u, completed[completed.length - 1].timestamp.getTime());
    rv.set(u, est);
    log(`${u} EWMA seeded from ${completed.length} 1h bars → rv ${est.rv !== undefined ? (est.rv * 100).toFixed(1) : 'n/a'}`);
  }
  jline({ ev: 'BOOT', underlyings: UNDERLYINGS, tenors: TENORS, intervalMin: INTERVAL_MIN, ewmaLambda: EWMA_LAMBDA, rvSeedHours: RV_SEED_HOURS });
  log(`collector up — ${UNDERLYINGS.join('/')} × {${TENORS.join(',')}}d every ${INTERVAL_MIN}m → ${tapePath()}`);

  let stopping = false;
  process.on('SIGINT', () => { stopping = true; log('SIGINT — finishing the cycle, then exiting (no positions to unwind)'); });
  process.on('SIGTERM', () => { stopping = true; });

  for (;;) {
    const cycleStart = Date.now();
    for (const u of UNDERLYINGS) {
      try {
        // 1. EWMA update from any newly COMPLETED 1h bars (the still-forming bar is skipped).
        const est = rv.get(u)!;
        const bars = await hl.klines(u, '1h', 6);
        for (const b of bars) {
          const ts = b.timestamp.getTime();
          if (ts + HOUR_MS > Date.now() || ts <= (lastBarMs.get(u) ?? 0)) continue;
          const prevIdx = bars.findIndex((x) => x.timestamp.getTime() === ts) - 1;
          const prevClose = prevIdx >= 0 ? bars[prevIdx].close : undefined;
          if (prevClose && prevClose > 0 && b.close > 0) est.update(Math.log(b.close / prevClose));
          lastBarMs.set(u, ts);
        }
        const ewmaRv = est.rv;

        // 2. One chain call → per-tenor smile points.
        const chain = await drb.optionChain(u);
        const nowMs = Date.now();
        for (const tenor of TENORS) {
          const picks = selectTenorPicks(chain, tenor, nowMs);
          if (!picks) {
            jline({ ev: 'SKIP', underlying: u, tenorDays: tenor, reason: 'no expiry within tolerance' });
            continue;
          }
          // 3. Quoted spreads in vol points for each named point (null when a side is unquoted).
          const spread = async (name: string | undefined): Promise<number | null> => {
            if (!name) return null;
            try {
              const t = await drb.ticker(name);
              return t.bidIv !== null && t.askIv !== null ? t.askIv - t.bidIv : null;
            } catch {
              return null;
            }
          };
          const atmCall = chain.find((o) => o.expiryMs === picks.expiryMs && o.strike === picks.atmStrike && o.type === 'CALL');
          const [atmSpread, p25s, p10s, c25s] = [
            await spread(atmCall?.instrumentName),
            await spread(picks.put25?.instrumentName),
            await spread(picks.put10?.instrumentName),
            await spread(picks.call25?.instrumentName),
          ];
          jline({
            ev: 'SURFACE',
            underlying: u,
            tenorDays: tenor,
            daysToExpiry: Number(picks.daysToExpiry.toFixed(2)),
            expiryMs: picks.expiryMs,
            spot: picks.spot,
            atmStrike: picks.atmStrike,
            atmIv: picks.atmIv,
            atmSpreadVolPts: atmSpread,
            put25: pt(picks.put25, p25s),
            put10: pt(picks.put10, p10s),
            call25: pt(picks.call25, c25s),
            rr25: picks.rr25 ?? null,
            ewmaRv: ewmaRv ?? null,
            vrpPts: ewmaRv !== undefined ? picks.atmIv - ewmaRv : null,
          });
          log(
            `${u} ${tenor}d(${picks.daysToExpiry.toFixed(1)}) atm ${(picks.atmIv * 100).toFixed(1)}` +
            `${atmSpread !== null ? ` (spr ${(atmSpread * 100).toFixed(1)}pt)` : ''}` +
            `${picks.rr25 !== undefined ? ` rr25 ${(picks.rr25 * 100).toFixed(1)}` : ''}` +
            `${ewmaRv !== undefined ? ` rv ${(ewmaRv * 100).toFixed(1)} vrp ${((picks.atmIv - ewmaRv) * 100).toFixed(1)}` : ''}`,
          );
        }
      } catch (err) {
        log(`ERROR ${u}: ${(err as Error).message}`);
        jline({ ev: 'ERROR', underlying: u, message: (err as Error).message });
      }
    }
    if (ONCE || stopping) break;
    // Interruptible sleep: a stop signal mid-interval exits within ~2s, not at the next cycle.
    const deadline = cycleStart + Math.max(5_000, INTERVAL_MIN * 60_000);
    while (!stopping && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(2_000, Math.max(1, deadline - Date.now()))));
    }
    if (stopping) break;
  }
  jline({ ev: 'EXIT' });
  log('collector down — tape flushed (append-only, nothing buffered)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
