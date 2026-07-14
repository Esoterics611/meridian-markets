/**
 * outcome-rv-live — THE PROBABILITY DESK (paper): HIP-4 binaries vs the Deribit RND.
 *
 * The one thing nobody else on a HIP-4 book has is an options-calibrated fair value.
 * This loop polls every live HIP-4 price binary (BTC/ETH dailies), prices each off the
 * desk's smile-adjusted Deribit digital, and paper-trades ONLY a signed fee-adjusted
 * fair-value edge ≥ ORV_EDGE_MIN. Defined risk (max loss = collateral, known at entry),
 * self-settling within hours (no warehouse), judged REALISED-FIRST — most positions
 * settle the same day, so the honest number arrives daily.
 *
 * Founding read (2026-07-13 18:08 UTC, locked in implied-digital.spec.ts):
 *   HIP-4 BTC daily K=62,814 11.9h out: YES 0.153/0.180 vs smile-adj fair 0.1334
 *   → BUY_NO fee-adjusted edge +1.46c (below the 3c gate — honest: the gate must see
 *   fatter dislocations than the founding snapshot to trade; that is by design).
 *
 * Honesty caveats, stated up front:
 *   - ORV_FEE_PROB is a CONSERVATIVE PLACEHOLDER (HIP-4 opens free, fees on close/settle;
 *     exact schedule unconfirmed). Do not trust the P&L until it is confirmed.
 *   - Settlement uses HL's own mid at expiry vs targetPrice; the venue oracle may differ
 *     at the margin. Disputes/ambiguity are impossible for price binaries — why v0
 *     trades ONLY class:priceBinary.
 *   - Fills are taken at the touch, capped at ORV_TOUCH_FRAC of displayed size; no
 *     queue model on v0 (taker entries only).
 *
 * Run (operator, DB-free):
 *   npx ts-node -r tsconfig-paths/register scripts/outcome-rv-live.ts
 * Knobs:
 *   ORV_POLL_MS(15000) ORV_EDGE_MIN(0.03) ORV_FEE_PROB(0.005) ORV_CONTRACTS(500)
 *   ORV_MAX_MKT_USD(500) ORV_MAX_TOTAL_USD(2000) ORV_MIN_EXP_MIN(45) ORV_TP_FRAC(0.7)
 *   ORV_TOUCH_FRAC(0.5) ORV_HOURS(0=indefinite) ORV_JOURNAL(docs/research/outcome-rv/)
 */
import * as fs from 'fs';
import * as path from 'path';
import { DeribitClient } from '../src/derivatives/deribit/deribit-client';
import { DeribitDigitalSource } from '../src/prediction/deribit-digital-source';
import { HyperliquidOutcomeClient } from '../src/prediction/hyperliquid-outcome-client';
import { OutcomeRvBook, OutcomeRvConfig } from '../src/prediction/outcome-rv-book';

const POLL_MS = Number(process.env.ORV_POLL_MS ?? 15_000);
const HOURS = Number(process.env.ORV_HOURS ?? 0);
const CFG: OutcomeRvConfig = {
  edgeMinProb: Number(process.env.ORV_EDGE_MIN ?? 0.03),
  settleFeeProb: Number(process.env.ORV_FEE_PROB ?? 0.005),
  contractsPerTrade: Number(process.env.ORV_CONTRACTS ?? 500),
  maxCollateralPerMarket: Number(process.env.ORV_MAX_MKT_USD ?? 500),
  maxTotalCollateral: Number(process.env.ORV_MAX_TOTAL_USD ?? 2_000),
  minMinutesToExpiry: Number(process.env.ORV_MIN_EXP_MIN ?? 45),
  takeProfitFrac: Number(process.env.ORV_TP_FRAC ?? 0.7),
  maxTouchFrac: Number(process.env.ORV_TOUCH_FRAC ?? 0.5),
};
/** Underlyings the desk can price (Deribit options exist). Others are skipped, never guessed. */
const PRICEABLE = new Set(['BTC', 'ETH']);

const journalDir = process.env.ORV_JOURNAL ?? 'docs/research/outcome-rv';
fs.mkdirSync(journalDir, { recursive: true });
const journalPath = path.join(journalDir, `orv-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const jline = (o: Record<string, unknown>) =>
  fs.appendFileSync(journalPath, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
const log = (msg: string) => console.log(`[orv ${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function main(): Promise<void> {
  const hl = new HyperliquidOutcomeClient();
  const drb = new DeribitDigitalSource(new DeribitClient());
  const book = new OutcomeRvBook(CFG);
  const t0 = Date.now();
  log(`probability desk up — gate ${CFG.edgeMinProb} prob, fee ${CFG.settleFeeProb}, caps $${CFG.maxCollateralPerMarket}/mkt $${CFG.maxTotalCollateral} total, journal ${journalPath}`);
  jline({ ev: 'BOOT', cfg: CFG });

  let lastSummary = 0;
  for (;;) {
    const nowMs = Date.now();
    if (HOURS > 0 && nowMs - t0 > HOURS * 3_600_000) break;
    try {
      // 1) settle anything past expiry FIRST (realised is the product).
      for (const pos of book.expiredOpen(nowMs)) {
        const spot = await hl.underlyingMid(pos.underlying);
        const settledYes = spot > pos.targetPrice;
        const s = book.settle(pos.marketId, settledYes, nowMs)!;
        log(`SETTLE ${pos.underlying} K=${pos.targetPrice} → ${settledYes ? 'YES' : 'NO'} | side=${s.side} realised=$${s.realised!.toFixed(2)} | book realised=$${book.snapshot().realisedTotal.toFixed(2)}`);
        jline({ ev: 'SETTLE', marketId: s.marketId, settledYes, spot, side: s.side, realised: s.realised });
      }

      // 2) scan the venue.
      const quotes = (await hl.listPriceBinaries()).filter((q) => PRICEABLE.has(q.underlying.toUpperCase()));
      for (const q of quotes) {
        const venueSpot = await hl.underlyingMid(q.underlying).catch(() => undefined);
        const { fair, reason } = await drb.fairYes(q.underlying, q.targetPrice, q.expiryMs, nowMs, venueSpot);
        if (!fair) {
          jline({ ev: 'NOPRICE', marketId: q.marketId, reason });
          continue;
        }
        const tp = book.tryTakeProfit(q, nowMs);
        if (tp) {
          log(`TAKE-PROFIT ${q.underlying} K=${q.targetPrice} side=${tp.side} exit=${tp.exitProb!.toFixed(3)} realised=$${tp.realised!.toFixed(2)}`);
          jline({ ev: 'TP', marketId: q.marketId, exitProb: tp.exitProb, realised: tp.realised });
        }
        const d = book.evaluate(q, fair.fairYes, nowMs);
        jline({ ev: 'EVAL', marketId: q.marketId, underlying: q.underlying, K: q.targetPrice, expiryMs: q.expiryMs, yesBid: q.yesBid, yesAsk: q.yesAsk, fair: fair.fairYes, naive: fair.naive, iv: fair.iv, action: d.action, edgeOrBest: d.action ? d.edge : d.bestEdge, reason: d.action ? undefined : d.reason });
        if (d.action) {
          const pos = book.enter(q, d, fair.fairYes, nowMs);
          const hoursLock = (q.expiryMs - nowMs) / 3_600_000;
          log(`ENTER ${d.action} ${q.underlying} K=${q.targetPrice} @${d.execProb.toFixed(3)} ×${d.contracts} | fair=${fair.fairYes.toFixed(4)} edge=${d.edge.toFixed(4)} | lock $${pos.collateral.toFixed(0)} for ${hoursLock.toFixed(1)}h`);
          jline({ ev: 'ENTER', ...pos });
        } else if ((d.bestEdge ?? -1) > 0) {
          log(`scan ${q.underlying} K=${q.targetPrice} yes ${q.yesBid}/${q.yesAsk} fair ${fair.fairYes.toFixed(4)} — no trade (${d.reason})`);
        }
      }

      if (nowMs - lastSummary > 10 * 60_000) {
        const s = book.snapshot();
        log(`SUMMARY open=${s.open} settled=${s.settled} early=${s.closedEarly} W/L=${s.wins}/${s.losses} locked=$${s.collateralLocked.toFixed(0)} realised=$${s.realisedTotal.toFixed(2)} fees=$${s.feesPaid.toFixed(2)}`);
        jline({ ev: 'SUMMARY', ...s });
        lastSummary = nowMs;
      }
    } catch (err) {
      log(`ERROR ${(err as Error).message}`);
      jline({ ev: 'ERROR', message: (err as Error).message });
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const s = book.snapshot();
  log(`FINAL realised=$${s.realisedTotal.toFixed(2)} W/L=${s.wins}/${s.losses} (settled ${s.settled}, early ${s.closedEarly}) fees=$${s.feesPaid.toFixed(2)}`);
  jline({ ev: 'FINAL', ...s });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
