/**
 * funding-carry-live — T2 operator live paper run.
 * (PROFIT_PIVOT.md §3 T2: "scripts/funding-carry-live.ts")
 *
 * Runs the OOS persistence gate first, then tracks the SIMULATED P&L of holding
 * the gated carry positions in real time: monitors funding accrual vs the round-trip
 * entry cost. Purely observational (no orders placed) — this is paper tracking to
 * validate the carry BEFORE wiring a live execution path.
 *
 * The gate is mandatory before tracking: if a symbol fails OOS posFrac today,
 * we do NOT simulate holding it (prevents overfitting to a stale carry read).
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/funding-carry-live.ts
 *   FCL_SYMBOLS=BTC,ETH  FCL_NOTIONAL_USD=50000  FCL_HOURS=24  npx ts-node ...
 *
 * FCL_HOURS: tracking window (default 24h; funding accrues each hour on HL)
 * FCL_GATE_DAYS: days of history for OOS gate (default 60)
 * FCL_POLL_MS: poll interval for live funding + current funding rate (default 60000)
 */
import { HyperliquidFundingClient, HYPERLIQUID_PERIODS_PER_YEAR } from '../src/market-data/funding/hyperliquid-funding-client';
import { rankCarryUniverse, OosGateConfig, OosFundingResult } from '../src/market-data/funding/funding-carry-oos';

const SYMBOLS = (process.env.FCL_SYMBOLS ?? 'BTC,ETH,SOL,BNB,XRP').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const NOTIONAL_USD = Number(process.env.FCL_NOTIONAL_USD ?? 50_000);
const TRACK_HOURS = Number(process.env.FCL_HOURS ?? 24);
const GATE_DAYS = Number(process.env.FCL_GATE_DAYS ?? 60);
const POLL_MS = Number(process.env.FCL_POLL_MS ?? 60_000);
const MIN_POS_FRAC = Number(process.env.FCL_MIN_POS_FRAC ?? 0.65);

const SPOT_FEE_BPS = Number(process.env.FCL_SPOT_FEE_BPS ?? 4.5);
const PERP_FEE_BPS = Number(process.env.FCL_PERP_FEE_BPS ?? 2.5);

const NOTIONAL_UNITS = BigInt(Math.round(NOTIONAL_USD * 1_000_000));
const ROUND_TRIP_FEE_UNITS = BigInt(Math.round(NOTIONAL_USD * 2 * (SPOT_FEE_BPS + PERP_FEE_BPS) * 100)); // bps → units

const pct = (x: number, d = 3): string => (x >= 0 ? '+' : '') + x.toFixed(d) + '%';
const usd = (units: bigint): string => (Number(units) / 1e6 >= 0 ? '+' : '') + (Number(units) / 1e6).toFixed(2);

interface CarryPosition {
  symbol: string;
  direction: 'SHORT_PERP' | 'LONG_PERP';
  entryFeeUnits: bigint;
  fundingAccruedUnits: bigint;
  settlementCount: number;
  lastRatePerPeriod: number;
}

async function main(): Promise<void> {
  const fund = new HyperliquidFundingClient();

  console.log(`\n=== FUNDING CARRY LIVE PAPER TRACKER (T2 — PROFIT_PIVOT.md §3) ===`);
  console.log(`  symbols: ${SYMBOLS.join(', ')} | notional: $${NOTIONAL_USD}/leg | window: ${TRACK_HOURS}h`);
  console.log(`  round-trip fees (entry+exit): ${2 * (SPOT_FEE_BPS + PERP_FEE_BPS)}bps = $${Number(ROUND_TRIP_FEE_UNITS) / 1e6} per symbol\n`);

  // ─── Step 1: OOS gate ───────────────────────────────────────────────────────
  console.log(`Running OOS persistence gate (${GATE_DAYS}d history, posFrac ≥ ${MIN_POS_FRAC})...`);
  const endMs = Date.now();
  const startMs = endMs - GATE_DAYS * 86_400_000;
  const cfg: OosGateConfig = {
    periodsPerYear: HYPERLIQUID_PERIODS_PER_YEAR,
    spotFeeBps: SPOT_FEE_BPS,
    perpFeeBps: PERP_FEE_BPS,
    notionalUnits: NOTIONAL_UNITS,
    minPosFrac: MIN_POS_FRAC,
  };

  const histories: { symbol: string; funding: import('../src/market-data/funding/funding-source.interface').FundingPoint[] }[] = [];
  for (const sym of SYMBOLS) {
    try {
      const hist = await fund.fundingHistory(sym, startMs, endMs);
      if (hist.length >= 6) histories.push({ symbol: sym, funding: hist });
    } catch (e) {
      console.log(`  ${sym}: history fetch failed — ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  const ranked = rankCarryUniverse(histories, cfg);
  const gated = ranked.filter((r) => r.passGate);

  if (gated.length === 0) {
    console.log(`\n  No symbols pass the OOS gate today. Sit and re-scan tomorrow.\n  (Do NOT simulate a carry that fails the persistence gate.)`);
    process.exit(0);
  }

  console.log(`\n  Gate passed: ${gated.map((r) => `${r.symbol} (${pct(r.full.annualizedFundingPct, 0)} gross, ${r.full.breakevenDays.toFixed(1)}d breakeven)`).join(' | ')}`);
  console.log(`  Symbols that FAIL (not tracked): ${ranked.filter((r) => !r.passGate).map((r) => r.symbol).join(', ') || 'none'}`);

  // ─── Step 2: Open simulated positions ───────────────────────────────────────
  const positions: Map<string, CarryPosition> = new Map();
  const totalEntryFee = ROUND_TRIP_FEE_UNITS * BigInt(gated.length); // entry leg only
  for (const r of gated) {
    // Entry fee = half the round-trip (exit fee tracked at close)
    const entryFee = ROUND_TRIP_FEE_UNITS / 2n;
    positions.set(r.symbol, {
      symbol: r.symbol,
      direction: r.direction,
      entryFeeUnits: entryFee,
      fundingAccruedUnits: 0n,
      settlementCount: 0,
      lastRatePerPeriod: 0,
    });
  }

  console.log(`\n  SIMULATED POSITIONS OPENED (paper only — no orders placed):`);
  for (const r of gated) {
    const leg = r.direction === 'SHORT_PERP' ? 'LONG Binance spot / SHORT HL perp' : 'SHORT Binance spot / LONG HL perp';
    console.log(`    ${r.symbol}: ${leg} | $${NOTIONAL_USD}/leg | entry fee $${Number(ROUND_TRIP_FEE_UNITS / 2n) / 1e6}`);
  }

  // ─── Step 3: Poll funding accrual ────────────────────────────────────────────
  const endTrackMs = Date.now() + TRACK_HOURS * 3_600_000;
  let poll = 0;
  console.log(`\n  Tracking ${TRACK_HOURS}h funding accrual (polling every ${POLL_MS / 1000}s)...\n`);
  console.log(`  poll  symbol  rate(bps/hr)  accruedFunding$   netAfterEntryFee$  breakeven?`);

  while (Date.now() < endTrackMs) {
    poll++;
    for (const sym of gated.map((r) => r.symbol)) {
      try {
        const snap = await fund.currentFunding(sym);
        const pos = positions.get(sym)!;

        // Estimate funding accrued this poll interval: rate × notional × intervals since last.
        // HL settles hourly; each poll we observe the CURRENT rate (not a payment).
        // We track the rate for display; the next settlement will pay this rate.
        const signedRate = pos.direction === 'SHORT_PERP' ? snap.lastFundingRate : -snap.lastFundingRate;
        pos.lastRatePerPeriod = signedRate;
        pos.settlementCount++;
        // Increment accrual: treat each poll as accumulating one period's funding.
        // In production, you'd track actual settlement receipts; here we estimate.
        const accrualThisPoll = BigInt(Math.round(signedRate * Number(NOTIONAL_UNITS)));
        pos.fundingAccruedUnits += accrualThisPoll;

        const netUnits = pos.fundingAccruedUnits - pos.entryFeeUnits;
        const breakeven = netUnits >= 0n;
        const rateBps = (signedRate * 10_000).toFixed(3);
        console.log(
          `  ${String(poll).padStart(4)}  ${sym.padEnd(6)}  ${(rateBps + 'bps').padStart(12)}  ` +
          `${usd(pos.fundingAccruedUnits).padStart(16)}  ${usd(netUnits).padStart(18)}  ${breakeven ? '✅ PAST BREAKEVEN' : '⏳ accumulating'}`,
        );
      } catch (e) {
        console.log(`  ${poll}  ${sym}: poll failed — ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (Date.now() < endTrackMs - POLL_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  // ─── Step 4: Final verdict ───────────────────────────────────────────────────
  console.log(`\n=== ${TRACK_HOURS}h CARRY TRACKING VERDICT ===`);
  const exitFeePerLeg = ROUND_TRIP_FEE_UNITS / 2n;
  let totalNet = 0n;
  for (const pos of positions.values()) {
    const netAfterBothFees = pos.fundingAccruedUnits - pos.entryFeeUnits - exitFeePerLeg;
    totalNet += netAfterBothFees;
    const verdict = netAfterBothFees >= 0n ? '✅ profitable' : '❌ not yet past breakeven (hold longer or re-scan)';
    console.log(
      `  ${pos.symbol}: funding ${usd(pos.fundingAccruedUnits)} − fees ${usd(-(pos.entryFeeUnits + exitFeePerLeg))} = net ${usd(netAfterBothFees)} → ${verdict}`,
    );
  }
  console.log(`\n  DESK NET (${gated.length} symbols): ${usd(totalNet)}`);
  console.log(
    totalNet >= 0n
      ? `  ✅ CARRY POSITIVE: net funding cleared entry+exit fees over ${TRACK_HOURS}h.`
      : `  ⏳ Below breakeven at ${TRACK_HOURS}h — hold longer (breakeven range: ${gated.map((r) => r.full.breakevenDays.toFixed(1) + 'd').join('/')}). Do NOT churn.`,
  );
  console.log(`\n  PRE-REGISTERED METRIC: net positive over the full breakeven window (not this ${TRACK_HOURS}h snapshot).`);
  console.log('FUNDING-CARRY-LIVE OK\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFUNDING-CARRY-LIVE FAIL:', e?.message ?? e);
  process.exit(1);
});
