/**
 * funding-carry-oos — T2 of the Profit Pivot: the PERSISTENCE OOS gate.
 * (PROFIT_PIVOT.md §3 T2 + §5 honesty gate #1)
 *
 * "Harvest only funding whose posFrac is stable OUT OF SAMPLE, not a one-window
 * snapshot (#5/#8 discipline)." This script is that gate.
 *
 * For each symbol in the carry universe it:
 *   1. Fetches FCO_DAYS of HL hourly funding history.
 *   2. Splits 2/3 train / 1/3 OOS.
 *   3. Scores posFrac in EACH window independently.
 *   4. A symbol PASSES only when both windows are stable (≥ FCO_MIN_POS_FRAC).
 *   5. Prints the ranked board + the pre-registered success metric.
 *
 * Pre-registered success metric (PROFIT_PIVOT §3 T2 gate):
 *   PASS = posFrac_inSample ≥ FCO_MIN_POS_FRAC AND posFrac_OOS ≥ FCO_MIN_POS_FRAC
 *   Size budget = basis-variance budget (§5 #2) — start at $50k/symbol, max $200k/symbol.
 *   Hold-past-breakeven: do NOT churn (breakeven ~0.5–5d for HL hourly funding).
 *
 * Run (DB-free, real HL public API):
 *   npx ts-node -r tsconfig-paths/register scripts/funding-carry-oos.ts
 *   FCO_DAYS=90 FCO_SYMBOLS=BTC,ETH,SOL,BNB,XRP,DOGE,ADA npx ts-node ...
 *   FCO_SOURCE=both  (default: hl; 'binance' for 8h cadence; 'both' = run both)
 */
import { HyperliquidFundingClient, HYPERLIQUID_PERIODS_PER_YEAR } from '../src/market-data/funding/hyperliquid-funding-client';
import { BinanceFundingClient } from '../src/market-data/funding/binance-funding-client';
import { IFundingRateSource } from '../src/market-data/funding/funding-source.interface';
import { oosCarryGate, rankCarryUniverse, OosFundingResult, OosGateConfig } from '../src/market-data/funding/funding-carry-oos';

const SOURCE = (process.env.FCO_SOURCE ?? 'hl').trim().toLowerCase();
const DAYS = Number(process.env.FCO_DAYS ?? 90);
const SYMBOLS = (process.env.FCO_SYMBOLS ?? 'BTC,ETH,SOL,BNB,XRP,DOGE,ADA,SUI').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const TRAIN_FRAC = Number(process.env.FCO_TRAIN_FRAC ?? 0.667);
const MIN_POS_FRAC = Number(process.env.FCO_MIN_POS_FRAC ?? 0.65);
const NOTIONAL_UNITS = BigInt(process.env.FCO_NOTIONAL_UNITS ?? '50000000000'); // $50k/leg

// Fee schedule: HL spot leg via Binance (taker 4.5bps) + HL perp (taker 2.5bps)
const SPOT_FEE_BPS = Number(process.env.FCO_SPOT_FEE_BPS ?? 4.5);
const PERP_FEE_BPS = Number(process.env.FCO_PERP_FEE_BPS ?? 2.5);

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const padL = (s: string | number, n: number): string => String(s).padStart(n);
const pct = (x: number, d = 1): string => `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`;

function printBoard(label: string, results: OosFundingResult[], periodsPerYear: number, minPosFrac: number): void {
  const cadence = periodsPerYear === HYPERLIQUID_PERIODS_PER_YEAR ? 'hourly' : '8h';
  console.log(`\n=== ${label} (${cadence} funding, ${DAYS}d, OOS gate posFrac ≥ ${minPosFrac}) ===`);
  console.log(
    `  ${pad('symbol', 8)}  ${padL('dir', 10)}  ` +
    `${padL('IS posFrac', 10)}  ${padL('OOS posFrac', 11)}  ` +
    `${padL('fullFund%', 9)}  ${padL('breakeven', 9)}  ` +
    `${padL('IS fund%', 9)}  ${padL('OOS fund%', 9)}  ${padL('recent7d%', 9)}  GATE`,
  );

  let pass = 0;
  for (const r of results) {
    const gate = r.passGate ? '✅ PASS' : r.recent.vetoed ? '🚫 VETO(7d)' : '❌ fail';
    if (r.passGate) pass++;
    console.log(
      `  ${pad(r.symbol, 8)}  ${padL(r.direction, 10)}  ` +
      `${padL(r.inSample.posFrac.toFixed(3), 10)}  ${padL(r.oos.posFrac.toFixed(3), 11)}  ` +
      `${padL(pct(r.full.annualizedFundingPct), 9)}  ` +
      `${padL(isFinite(r.full.breakevenDays) ? r.full.breakevenDays.toFixed(1) + 'd' : '∞', 9)}  ` +
      `${padL(pct(r.inSample.annualizedFundingPct), 9)}  ${padL(pct(r.oos.annualizedFundingPct), 9)}  ` +
      `${padL(pct(r.recent.annualizedFundingPct), 9)}  ${gate}`,
    );
  }

  const passSymbols = results.filter((r) => r.passGate);
  console.log(`\n  ${pass}/${results.length} symbols pass the OOS gate.`);

  if (passSymbols.length > 0) {
    console.log(`\n  CARRY CANDIDATES (persistence-gated):`);
    for (const r of passSymbols) {
      const leg = r.direction === 'SHORT_PERP' ? 'LONG Binance spot / SHORT HL perp' : 'SHORT Binance spot / LONG HL perp';
      console.log(
        `    ${r.symbol}: ${pct(r.full.annualizedFundingPct, 1)} gross carry · breakeven ~${r.full.breakevenDays.toFixed(1)}d · IS posFrac ${r.inSample.posFrac.toFixed(2)} / OOS ${r.oos.posFrac.toFixed(2)}`
      );
      console.log(`      Position: ${leg}`);
      console.log(`      Size: $${Number(NOTIONAL_UNITS) / 1e6}k/leg (basis-variance budget — scale after 30d forward track)`);
    }
    console.log(`\n  PRE-REGISTERED SUCCESS METRIC (T2 forward paper run):`);
    console.log(`    PASS: net funding accrued across all carry symbols > entry+exit fee cost over 30d hold.`);
    console.log(`    Expressed: annualised net yield > 0 in the out-of-sample carry window.`);
    console.log(`    Judge: realised-first (total_funding_received − total_fees_paid), NOT unrealised basis P&L.`);
    console.log(`    Hold-past-breakeven: do NOT churn before ${passSymbols.map((r) => `${r.symbol} ${r.full.breakevenDays.toFixed(1)}d`).join(' / ')}.`);
  } else {
    console.log(`\n  No symbols pass the OOS gate this window.`);
    console.log(`  Wait for a regime where carry is persistently one-sided, then re-scan.`);
  }
}

async function runForSource(source: 'hl' | 'binance'): Promise<void> {
  const isHl = source === 'hl';
  const fund: IFundingRateSource = isHl
    ? new HyperliquidFundingClient()
    : new BinanceFundingClient({ quote: 'USDT' });
  const periodsPerYear = isHl ? HYPERLIQUID_PERIODS_PER_YEAR : (365 * 24) / 8;

  const cfg: OosGateConfig = {
    periodsPerYear,
    spotFeeBps: isHl ? SPOT_FEE_BPS : SPOT_FEE_BPS,
    perpFeeBps: PERP_FEE_BPS,
    notionalUnits: NOTIONAL_UNITS,
    trainFraction: TRAIN_FRAC,
    minPosFrac: MIN_POS_FRAC,
  };

  const endMs = Date.now();
  const startMs = endMs - DAYS * 86_400_000;

  const label = isHl
    ? `HL Funding OOS Gate [${DAYS}d hourly, ${Math.round(TRAIN_FRAC * 100)}/${Math.round((1 - TRAIN_FRAC) * 100)} split]`
    : `Binance Funding OOS Gate [${DAYS}d 8h cadence, ${Math.round(TRAIN_FRAC * 100)}/${Math.round((1 - TRAIN_FRAC) * 100)} split]`;

  console.log(`\nFetching ${DAYS}d funding history for ${SYMBOLS.length} symbols from ${source.toUpperCase()}...`);

  const histories: { symbol: string; funding: import('../src/market-data/funding/funding-source.interface').FundingPoint[] }[] = [];
  for (const sym of SYMBOLS) {
    try {
      const funding = await fund.fundingHistory(sym, startMs, endMs);
      if (funding.length >= 6) {
        histories.push({ symbol: sym, funding });
      } else {
        console.log(`  ${sym}: thin history (${funding.length} settlements) — skipping`);
      }
    } catch (e) {
      console.log(`  ${sym}: fetch failed — ${(e as Error).message}`);
    }
    // Polite delay on the public API
    await new Promise((r) => setTimeout(r, 80));
  }

  const results = rankCarryUniverse(histories, cfg);
  printBoard(label, results, periodsPerYear, MIN_POS_FRAC);
}

async function main(): Promise<void> {
  console.log(`\n=== FUNDING CARRY OOS GATE (T2 — PROFIT_PIVOT.md §3) ===`);
  console.log(`  source: ${SOURCE} | symbols: ${SYMBOLS.join(', ')} | days: ${DAYS}`);
  console.log(`  gate: IS posFrac ≥ ${MIN_POS_FRAC} AND OOS posFrac ≥ ${MIN_POS_FRAC} (${Math.round(TRAIN_FRAC * 100)}/${Math.round((1 - TRAIN_FRAC) * 100)} split)`);
  console.log(`  fees: spot ${SPOT_FEE_BPS}bps + perp ${PERP_FEE_BPS}bps/side → ${2 * (SPOT_FEE_BPS + PERP_FEE_BPS)}bps round trip`);
  console.log(`  notional: $${Number(NOTIONAL_UNITS) / 1e6}k/leg | hold-past-breakeven is the discipline\n`);

  if (SOURCE === 'both') {
    await runForSource('hl');
    await runForSource('binance');
  } else if (SOURCE === 'binance') {
    await runForSource('binance');
  } else {
    await runForSource('hl');
  }

  console.log('\nFUNDING-CARRY-OOS OK\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFUNDING-CARRY-OOS FAIL:', e?.message ?? e);
  process.exit(1);
});
