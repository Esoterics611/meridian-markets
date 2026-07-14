/**
 * vrp-live — THE VRP SATELLITE (paper): sell the measured variance risk premium,
 * delta-hedged, gated, stopped. (PROFIT_PIVOT_II P2/E6 — the desk's largest validated,
 * quantified, never-run edge: #12 = +5.9/+3.7 vol pts BTC/ETH; #42 = short-vol won
 * 86.3% of 117 rolling 24h windows.)
 *
 * Per poll: if a straddle is open → mark, band-rehedge with a paper HL perp, enforce
 * the hard loss stop, settle at expiry. If flat → measure trailing realized vol from
 * HL 1h candles, read the ATM daily straddle off Deribit, and open ONLY when
 * iv − rv ≥ VRP_MIN_PTS (gate closed ⇒ sit out, doctrine #5).
 *
 * Honesty caveats: entry premium is Deribit MARK minus a haircut (VRP_HAIRCUT_FRAC,
 * default 2% — options spreads are wide; tighten only with measured executable quotes);
 * marking uses entry IV for the position's life (no vega mark — v0 simplification,
 * realised at settle is exact); hedge fills at HL mid + taker fee, no queue model.
 *
 * Run (operator, DB-free):
 *   npx ts-node -r tsconfig-paths/register scripts/vrp-live.ts
 * Knobs:
 *   VRP_UNDERLYINGS(BTC,ETH) VRP_POLL_MS(60000) VRP_MIN_PTS(0.03) VRP_CONTRACTS(0.1)
 *   VRP_BAND(0.25) VRP_HEDGE_FEE_BPS(3.5) VRP_STOP_USD(400) VRP_MIN_H(6)
 *   VRP_RV_HOURS(24) VRP_HAIRCUT_FRAC(0.02) VRP_HOURS(0=indefinite)
 *   VRP_JOURNAL(docs/research/vrp)
 */
import * as fs from 'fs';
import * as path from 'path';
import { DeribitClient } from '../src/derivatives/deribit/deribit-client';
import { VrpBook, VrpBookConfig } from '../src/derivatives/vrp/vrp-book';
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';
import { HyperliquidOutcomeClient } from '../src/prediction/hyperliquid-outcome-client';

const UNDERLYINGS = (process.env.VRP_UNDERLYINGS ?? 'BTC,ETH').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const POLL_MS = Number(process.env.VRP_POLL_MS ?? 60_000);
const HOURS = Number(process.env.VRP_HOURS ?? 0);
const RV_HOURS = Number(process.env.VRP_RV_HOURS ?? 24);
const HAIRCUT = Number(process.env.VRP_HAIRCUT_FRAC ?? 0.02);
const CFG: VrpBookConfig = {
  minVrpPts: Number(process.env.VRP_MIN_PTS ?? 0.03),
  contractsCoin: Number(process.env.VRP_CONTRACTS ?? 0.1),
  hedgeBandFrac: Number(process.env.VRP_BAND ?? 0.25),
  hedgeFeeBps: Number(process.env.VRP_HEDGE_FEE_BPS ?? 3.5),
  maxLossBudgetUsd: Number(process.env.VRP_STOP_USD ?? 400),
  minHoursToExpiry: Number(process.env.VRP_MIN_H ?? 6),
};

const journalDir = process.env.VRP_JOURNAL ?? 'docs/research/vrp';
fs.mkdirSync(journalDir, { recursive: true });
const journalPath = path.join(journalDir, `vrp-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const jline = (o: Record<string, unknown>) =>
  fs.appendFileSync(journalPath, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const log = (msg: string) => console.log(`[vrp ${new Date().toISOString().slice(11, 19)}] ${msg}`);

/** Annualized close-to-close realized vol from 1h bars. */
function realizedVol(closes: number[]): number {
  if (closes.length < 8) return NaN;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr) * Math.sqrt(24 * 365.25);
}

async function main(): Promise<void> {
  const drb = new DeribitClient();
  const hl = new HyperliquidClient();
  const mids = new HyperliquidOutcomeClient();
  const books = new Map<string, VrpBook>(UNDERLYINGS.map((u) => [u, new VrpBook(CFG)]));
  const t0 = Date.now();
  log(`VRP satellite up — gate ${CFG.minVrpPts * 100}pts, size ${CFG.contractsCoin} coin, stop $${CFG.maxLossBudgetUsd}, journal ${journalPath}`);
  jline({ ev: 'BOOT', cfg: CFG, underlyings: UNDERLYINGS });

  for (;;) {
    const nowMs = Date.now();
    if (HOURS > 0 && nowMs - t0 > HOURS * 3_600_000) break;
    for (const u of UNDERLYINGS) {
      const book = books.get(u)!;
      try {
        const spot = await mids.underlyingMid(u);
        const pos = book.position();
        if (pos?.status === 'OPEN') {
          if (nowMs >= pos.expiryMs) {
            const s = book.settle(spot, nowMs)!;
            log(`SETTLE ${u} K=${s.strike} @${spot.toFixed(0)} realised=$${s.realisedUsd!.toFixed(2)} (premium $${s.premiumUsd.toFixed(2)}, hedges ${s.rehedges}, fees $${s.hedgeFeesUsd.toFixed(2)})`);
            jline({ ev: 'SETTLE', ...s });
          } else {
            const r = book.step(spot, nowMs);
            if (r.stoppedOut) {
              log(`STOP ${u} K=${r.stoppedOut.strike} @${spot.toFixed(0)} realised=$${r.stoppedOut.realisedUsd!.toFixed(2)} — loss budget hit`);
              jline({ ev: 'STOP', ...r.stoppedOut });
            } else if (r.rehedged) {
              log(`REHEDGE ${u} qty=${r.rehedged.qty.toFixed(4)} @${spot.toFixed(0)} mark=$${r.markPnlUsd!.toFixed(2)}`);
              jline({ ev: 'REHEDGE', underlying: u, ...r.rehedged, markPnlUsd: r.markPnlUsd });
            }
          }
          continue;
        }
        // flat → try to open
        const chain = await drb.optionChain(u);
        const minMs = nowMs + CFG.minHoursToExpiry * 3_600_000;
        const expiries = [...new Set(chain.filter((o) => o.expiryMs >= minMs).map((o) => o.expiryMs))].sort((a, b) => a - b);
        if (expiries.length === 0) continue;
        const exp = expiries[0];
        const atExp = chain.filter((o) => o.expiryMs === exp && o.markIv > 0);
        const strikes = [...new Set(atExp.map((o) => o.strike))].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
        const K = strikes[0];
        const call = atExp.find((o) => o.strike === K && o.type === 'CALL');
        const put = atExp.find((o) => o.strike === K && o.type === 'PUT');
        if (!call || !put) continue;
        const premiumUsd = (call.markPriceCoin + put.markPriceCoin) * call.underlyingPrice * (1 - HAIRCUT);
        const bars = await hl.klines(u, '1h', RV_HOURS + 1);
        const rv = realizedVol(bars.map((b) => b.close));
        if (!Number.isFinite(rv)) continue;
        const { pos: opened, reason } = book.tryOpen({
          underlying: u, spot, strike: K, expiryMs: exp, markIv: call.markIv, realizedVol: rv,
          straddlePremiumUsd: premiumUsd, nowMs,
        });
        jline({ ev: 'GATE', underlying: u, iv: call.markIv, rv, K, expiryMs: exp, premiumUsd, opened: !!opened, reason });
        if (opened) {
          log(`OPEN short straddle ${u} K=${K} exp=${new Date(exp).toISOString().slice(0, 16)} iv=${(call.markIv * 100).toFixed(1)} rv=${(rv * 100).toFixed(1)} premium=$${opened.premiumUsd.toFixed(2)}`);
          jline({ ev: 'OPEN', ...opened });
        } else {
          log(`gate ${u}: ${reason} (iv ${(call.markIv * 100).toFixed(1)} / rv ${(rv * 100).toFixed(1)})`);
        }
      } catch (err) {
        log(`ERROR ${u}: ${(err as Error).message}`);
        jline({ ev: 'ERROR', underlying: u, message: (err as Error).message });
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  for (const [u, b] of books) {
    const s = b.snapshot();
    log(`FINAL ${u} realised=$${s.realisedTotalUsd.toFixed(2)} settled=${s.settled} stopped=${s.stopped} W/L=${s.wins}/${s.losses}`);
    jline({ ev: 'FINAL', underlying: u, ...s });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
