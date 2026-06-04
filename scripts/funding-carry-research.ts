/**
 * funding-carry-research — DB-free, HTTP-free* research harness for the FIRST
 * non-stat-arb strategy on the desk: delta-neutral funding-rate carry (long spot
 * + short perp, harvest funding). Per STRATEGY_LIBRARY_REWRITE.md #2 — build this
 * first because Binance funding is public (no new venue). (*hits Binance public
 * REST directly; no server, no Postgres.)
 *
 * For each perp it pulls real funding history + spot 8h closes over FC_DAYS,
 * computes the realised static cash-and-carry net of fees + basis (funding-carry.ts),
 * ranks the basket, and prints a deploy/wait/need-data verdict — the same
 * conservation-first bar the stat-arb gate uses (no in-sample shipping).
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/funding-carry-research.ts
 *   FC_DAYS=60 FC_SYMBOLS=BTC,ETH,SOL npx ts-node ... funding-carry-research.ts
 *   FC_SOURCE=hyperliquid FC_DAYS=20 npx ts-node ... funding-carry-research.ts  (HOURLY funding)
 *
 * FC_SOURCE=hyperliquid prices the HL funding STREAM (the carry edge + its
 * persistence/sign) — the cash flow that accrues on whatever inventory the HL MM
 * book holds (MM course §8.10). HL is perps-only, so there is no spot leg and the
 * basis term is ~0 (single-venue); a delta-neutral CAPTURE would short the HL perp
 * against spot on another venue (a cross-venue carry, a later step).
 */
import { BinancePublicClient } from '../src/stat-arb/feed/binance-public-client';
import { BinanceFundingClient } from '../src/market-data/funding/binance-funding-client';
import { HyperliquidFundingClient, HYPERLIQUID_PERIODS_PER_YEAR } from '../src/market-data/funding/hyperliquid-funding-client';
import { HyperliquidClient } from '../src/market-data/reference/hyperliquid-client';
import { IFundingRateSource } from '../src/market-data/funding/funding-source.interface';
import { Bar } from '../src/stat-arb/backtest/bar';
import { staticCarry } from '../src/market-data/funding/funding-carry';

// FC_SOURCE picks the venue: 'binance' (8h funding, real spot leg) or 'hyperliquid'
// (HOURLY funding, perps-only ⇒ no spot leg, basis ~0; prices the funding STREAM,
// the input to the MM book's inventory carry — MM course §8.10).
const SOURCE = (process.env.FC_SOURCE ?? 'binance').trim().toLowerCase();
const IS_HL = SOURCE === 'hyperliquid';
const PERIODS_PER_YEAR = IS_HL ? HYPERLIQUID_PERIODS_PER_YEAR : (365 * 24) / 8;
const BAR_INTERVAL = IS_HL ? '1h' : '8h'; // funding-settlement cadence

const SYMBOLS = (process.env.FC_SYMBOLS ?? 'BTC,ETH,SOL,BNB,XRP,DOGE').split(',').map((s) => s.trim()).filter(Boolean);
const DAYS = Number(process.env.FC_DAYS ?? 30);
const NOTIONAL = BigInt(process.env.FC_NOTIONAL_UNITS ?? '100000000000'); // $100k/leg
const SPOT_FEE_BPS = Number(process.env.FC_SPOT_FEE_BPS ?? (IS_HL ? 0 : 10)); // HL has no spot leg
const PERP_FEE_BPS = Number(process.env.FC_PERP_FEE_BPS ?? (IS_HL ? 2.5 : 5)); // HL perp taker 2.5bps
const POS_FRAC_MIN = Number(process.env.FC_POS_FRAC_MIN ?? 0.7); // carry-direction stability bar

const usd = (units: bigint): string => (Number(units) / 1e6).toFixed(0);
const sgn = (units: bigint): string => (units >= 0n ? '+' : '') + usd(units);
const pad = (s: string | number, n: number): string => String(s).padStart(n);

interface Row {
  symbol: string;
  periods: number;
  annFundingPct: number;
  annNetPct: number;
  posFrac: number;
  breakevenDays: number;
  netUnits: bigint;
  fundingUnits: bigint;
  basisUnits: bigint;
  feesUnits: bigint;
  verdict: string;
}

async function main(): Promise<void> {
  // Funding source + the price series for the basis leg. Binance = real spot;
  // Hyperliquid = perps-only, so the HL candle IS the price series and basis ≈ 0.
  const fund: IFundingRateSource = IS_HL ? new HyperliquidFundingClient() : new BinanceFundingClient({ quote: 'USDT' });
  const hlPrice = IS_HL ? new HyperliquidClient() : undefined;
  const binSpot = IS_HL ? undefined : new BinancePublicClient({ quote: 'USDT' });
  const priceBars = (sym: string, n: number): Promise<Bar[]> =>
    IS_HL ? hlPrice!.klines(sym, BAR_INTERVAL, n) : binSpot!.klines(sym, BAR_INTERVAL, n);
  const endMs = Date.now();
  const startMs = endMs - DAYS * 86_400_000;
  const roundTripBps = 2 * (SPOT_FEE_BPS + PERP_FEE_BPS);
  const legs = IS_HL ? 'perps-only, single-venue (basis ~0)' : 'delta-neutral (long spot / short perp)';

  console.log(`\n=== Funding-rate carry [${SOURCE}] — ${DAYS}d real history, $${usd(NOTIONAL)}/leg, ${legs} ===`);
  console.log(`  fees: spot ${SPOT_FEE_BPS}bps + perp ${PERP_FEE_BPS}bps per side ⇒ ${roundTripBps}bps round trip | funding cadence: ${BAR_INTERVAL} (${PERIODS_PER_YEAR}/yr) | basket: ${SYMBOLS.join(',')}`);
  console.log(`  carry yield = annualised funding (the edge) · fee = ONE-TIME round trip · basis = mean-zero entry-timing noise for a perp`);
  console.log(`\n  symbol  periods  carry%/yr  posFrac  breakeven  funding$  basis*$   fee$     net(${DAYS}d)$  hold1y%/yr  verdict`);

  const rows: Row[] = [];
  for (const sym of SYMBOLS) {
    let funding, bars;
    try {
      funding = await fund.fundingHistory(sym, startMs, endMs);
      bars = await priceBars(sym, Math.max(funding.length + 2, 10));
    } catch (e) {
      console.log(`  ${sym.padEnd(6)}  — fetch failed: ${(e as Error).message}`);
      continue;
    }
    if (funding.length < 3 || bars.length < 2) {
      console.log(`  ${sym.padEnd(6)}  — thin history (${funding.length} settlements) — skip`);
      continue;
    }
    // Align the spot leg to the funding SETTLEMENT instants (8h spot bars open at
    // the same 00/08/16 UTC marks), so the basis term reflects the true perp-spot
    // premium change and not a sampling-offset price drift.
    const closeAt = (ms: number): number => {
      let best = bars[0];
      let bestGap = Math.abs(bars[0].timestamp.getTime() - ms);
      for (const b of bars) {
        const g = Math.abs(b.timestamp.getTime() - ms);
        if (g < bestGap) {
          best = b;
          bestGap = g;
        }
      }
      return best.close;
    };
    const entryMs = funding[0].fundingTimeMs;
    const exitMs = funding[funding.length - 1].fundingTimeMs;
    const r = staticCarry({
      funding,
      spotEntry: closeAt(entryMs),
      spotExit: closeAt(exitMs),
      perpEntry: funding[0].markPrice || closeAt(entryMs),
      perpExit: funding[funding.length - 1].markPrice || closeAt(exitMs),
      notionalUnits: NOTIONAL,
      spotFeeBps: SPOT_FEE_BPS,
      perpFeeBps: PERP_FEE_BPS,
      periodsPerYear: PERIODS_PER_YEAR,
    });
    // Breakeven hold: settlement-periods for mean funding to clear the round-trip
    // fee, × the period length in days (365/periodsPerYear: 8h→1/3, HL 1h→1/24).
    const meanFundingBps = r.meanFundingPerPeriod * 10_000;
    const breakevenDays = meanFundingBps > 0 ? (roundTripBps / meanFundingBps) * (365 / PERIODS_PER_YEAR) : Infinity;
    rows.push({
      symbol: sym,
      periods: r.periods,
      annFundingPct: r.annualizedFundingPct,
      annNetPct: r.annualizedNetPct,
      posFrac: r.positiveFraction,
      breakevenDays,
      netUnits: r.netUnits,
      fundingUnits: r.fundingCollectedUnits,
      basisUnits: r.basisPnlUnits,
      feesUnits: r.feesUnits,
      verdict: '',
    });
  }

  const MIN_YIELD = Number(process.env.FC_MIN_YIELD_PCT ?? 2); // carry must clear a 1yr-amortised fee with margin
  const feeDragPctPerYr = roundTripBps / 100; // one-time round trip, charged once per hold
  rows.sort((a, b) => b.annFundingPct - a.annFundingPct);
  for (const r of rows) {
    const oneSided = r.posFrac >= POS_FRAC_MIN || r.posFrac <= 1 - POS_FRAC_MIN; // funding persistently one direction
    const hold1yr = r.annFundingPct - feeDragPctPerYr; // net carry if held a year (fee amortised, basis ~0)
    r.verdict = r.annFundingPct >= MIN_YIELD && oneSided && hold1yr > 0 ? 'CANDIDATE' : r.annFundingPct > 0 ? 'WATCH' : 'no-edge';
    console.log(
      `  ${r.symbol.padEnd(6)}  ${pad(r.periods, 7)}  ${pad(r.annFundingPct.toFixed(2), 8)}%  ${pad(r.posFrac.toFixed(2), 7)}  ` +
        `${pad(isFinite(r.breakevenDays) ? r.breakevenDays.toFixed(0) + 'd' : '∞', 9)}  ${sgn(r.fundingUnits).padStart(8)}  ${sgn(r.basisUnits).padStart(8)}  ` +
        `${sgn(-r.feesUnits).padStart(7)}  ${sgn(r.netUnits).padStart(9)}  ${pad(hold1yr.toFixed(2), 8)}%  ${r.verdict}`,
    );
  }

  console.log(`\n=== live funding right now (premium index) ===`);
  for (const sym of SYMBOLS) {
    try {
      const s = await fund.currentFunding(sym);
      console.log(`  ${sym.padEnd(6)} lastFunding=${(s.lastFundingRate * 10_000).toFixed(3)}bps/${BAR_INTERVAL}  mark=${s.markPrice}  next=${new Date(s.nextFundingTimeMs).toISOString()}`);
    } catch {
      /* skip */
    }
  }

  const candidates = rows.filter((r) => r.verdict === 'CANDIDATE');
  console.log(`\n=== VERDICT (conserve equity; no in-sample shipping) ===`);
  console.log(`  The edge is the FUNDING STREAM (continuous); the ${roundTripBps}bps round trip is a ONE-TIME cost. So carry is a`);
  console.log(`  HOLD-LONGER trade: breakeven hold ≈ fee ÷ funding-rate; past it, net → the carry yield. Basis is mean-zero`);
  console.log(`  entry-timing noise for a perp (this window it ran ${rows.length ? (rows.reduce((s, r) => s + Number(r.basisUnits), 0) < 0 ? 'against' : 'for') : '—'} us — diversify across entries/symbols to wash it out).`);
  console.log(`  ${candidates.length}/${rows.length} perps clear the bar: carry ≥ ${MIN_YIELD}%/yr, one-sided funding, positive net if held 1yr.`);
  if (candidates.length) {
    console.log(`  CANDIDATES: ${candidates.map((c) => `${c.symbol} (${c.annFundingPct.toFixed(1)}%/yr carry, breakeven ~${c.breakevenDays.toFixed(0)}d)`).join(', ')}`);
    console.log(`  → IN-SAMPLE over ${DAYS}d. DEPLOY CONDITION: hold past breakeven (or MAKER entry, reuse src/market-making/, to cut the ${roundTripBps}bps`);
    console.log(`     → ~${(roundTripBps / 3).toFixed(0)}bps and shorten breakeven ~3×). NEXT: forward-test the funding persistence + size ≤ N* on thin legs.`);
  } else {
    console.log(`  Nothing clears the carry bar — funding too low/unstable this window. Sit and re-scan.`);
  }
  const basisNote = IS_HL ? 'basis ~0 (HL perps-only, no spot leg)' : `basis uses ${BAR_INTERVAL} closes`;
  console.log(`\n  CAVEATS: in-sample / single window; static buy-and-hold (no funding-sign timing); ${basisNote}; perp borrow/liquidation not modelled.`);
  console.log('\nFUNDING-CARRY OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nFUNDING-CARRY FAIL:', e?.message ?? e);
  process.exit(1);
});
