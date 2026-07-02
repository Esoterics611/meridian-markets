/**
 * funding-differential-board — PROFIT_PIVOT_II P1(c)/E4/R4: the three-venue funding
 * differential board (M2). Pulls per-symbol funding history from Hyperliquid,
 * Binance USDⓈ-M and Bybit linear, aligns the cadences on UTC-day sums, and ranks
 * every pairwise differential net of a MAKER-routed round trip (E2 is the executor
 * that makes those fees real).
 *
 * THIS IS A MEASUREMENT, NOT A TRADE SIGNAL: the plan pre-registers ≥1 week of
 * boards before any differential leg opens (M2 — "measure first, trade the gated
 * tails"). Run it daily; the JSON artifacts under docs/research/funding-differentials/
 * are the series the go/no-go verdict will cite.
 *
 * Run (DB-free, real public APIs):
 *   npx ts-node -r tsconfig-paths/register scripts/funding-differential-board.ts
 * Knobs: FDB_SYMBOLS FDB_DAYS(14) FDB_MIN_OVERLAP_DAYS(5) FDB_MIN_ANN_PCT(3)
 *        FDB_MIN_STABLE(0.7) FDB_MAX_BREAKEVEN_DAYS(20)
 *        FDB_HL_MAKER_BPS(−0.2) FDB_BINANCE_MAKER_BPS(2) FDB_BYBIT_MAKER_BPS(2)
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { HyperliquidFundingClient } from '../src/market-data/funding/hyperliquid-funding-client';
import { BinanceFundingClient } from '../src/market-data/funding/binance-funding-client';
import { BybitFundingClient } from '../src/market-data/funding/bybit-funding-client';
import { IFundingRateSource, FundingPoint } from '../src/market-data/funding/funding-source.interface';
import {
  assembleDifferentialBoard,
  DifferentialConfig,
  FundingDifferentialScore,
  scoreFundingDifferential,
  VenueFundingSeries,
} from '../src/market-data/funding/funding-differential';
import { venueFeeFor } from '../src/market-making/backtest/venue-fees';

const SYMBOLS = (process.env.FDB_SYMBOLS ?? 'BTC,ETH,SOL,XRP,DOGE,BNB,ADA,LINK,AVAX,LTC')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const DAYS = Number(process.env.FDB_DAYS ?? 14);
// Maker fees per venue (bps/side): HL from the fee table (−0.2 rebate); Binance/Bybit
// PERP maker base tiers (~2bps — the fee table's 'binance' row is SPOT, not reused here).
const HL_MAKER_BPS = Number(process.env.FDB_HL_MAKER_BPS ?? venueFeeFor('hyperliquid').makerBps);
const BINANCE_MAKER_BPS = Number(process.env.FDB_BINANCE_MAKER_BPS ?? 2);
const BYBIT_MAKER_BPS = Number(process.env.FDB_BYBIT_MAKER_BPS ?? 2);

const baseCfg: Omit<DifferentialConfig, 'feeBpsA' | 'feeBpsB'> = {
  minOverlapDays: Number(process.env.FDB_MIN_OVERLAP_DAYS ?? 5),
  minAnnualizedPct: Number(process.env.FDB_MIN_ANN_PCT ?? 3),
  minStableFraction: Number(process.env.FDB_MIN_STABLE ?? 0.7),
  maxBreakevenDays: Number(process.env.FDB_MAX_BREAKEVEN_DAYS ?? 20),
};

interface Venue {
  name: string;
  client: IFundingRateSource;
  makerBps: number;
}

const venues: Venue[] = [
  { name: 'hyperliquid', client: new HyperliquidFundingClient(), makerBps: HL_MAKER_BPS },
  { name: 'binance', client: new BinanceFundingClient(), makerBps: BINANCE_MAKER_BPS },
  { name: 'bybit', client: new BybitFundingClient(), makerBps: BYBIT_MAKER_BPS },
];

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const padL = (s: string | number, n: number): string => String(s).padStart(n);
const pct = (x: number, d = 1): string => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const endMs = Date.now();
  const startMs = endMs - DAYS * 86_400_000;

  console.log(`\n=== THREE-VENUE FUNDING DIFFERENTIAL BOARD — HL ↔ Binance ↔ Bybit (E4/M2) ===`);
  console.log(`  window ${DAYS}d · UTC-day alignment · maker round trip: HL ${HL_MAKER_BPS} / Binance ${BINANCE_MAKER_BPS} / Bybit ${BYBIT_MAKER_BPS} bps/side`);
  console.log(`  gates: overlap ≥ ${baseCfg.minOverlapDays}d · |ann diff| ≥ ${baseCfg.minAnnualizedPct}% · stable ≥ ${baseCfg.minStableFraction} · breakeven ≤ ${baseCfg.maxBreakevenDays}d`);
  console.log(`  MEASUREMENT ONLY (M2): ≥1 week of boards before any differential leg trades.\n`);

  // Per-symbol, per-venue history. Serial + spaced — three public APIs, none keyed.
  const series = new Map<string, VenueFundingSeries[]>();
  for (const sym of SYMBOLS) {
    const got: VenueFundingSeries[] = [];
    for (const v of venues) {
      try {
        const points: FundingPoint[] = await v.client.fundingHistory(sym, startMs, endMs);
        if (points.length > 0) got.push({ venue: v.name, points });
        else console.log(`  ${sym}@${v.name}: no settlements — skipped`);
      } catch (e) {
        console.log(`  ${sym}@${v.name}: fetch failed — ${(e as Error).message}`);
      }
      await sleep(150);
    }
    series.set(sym, got);
  }

  // Every venue pair per symbol.
  const feeFor = (name: string): number => venues.find((v) => v.name === name)?.makerBps ?? 2;
  const scores: FundingDifferentialScore[] = [];
  for (const [sym, list] of series) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = scoreFundingDifferential(sym, list[i], list[j], {
          ...baseCfg,
          feeBpsA: feeFor(list[i].venue),
          feeBpsB: feeFor(list[j].venue),
        });
        if (s) scores.push(s);
      }
    }
  }
  const board = assembleDifferentialBoard(scores);

  console.log(`  symbol  pair                    annA%    annB%    DIFF%   stable  breakeven  harvest`);
  for (const p of board.pairs) {
    const short = p.direction === 'SHORT_A_LONG_B' ? p.venueA : p.venueB;
    console.log(
      `  ${pad(p.symbol, 6)}  ${pad(`${p.venueA}↔${p.venueB}`, 22)}  ${padL(pct(p.annualizedAPct), 7)}  ${padL(pct(p.annualizedBPct), 7)}  ` +
      `${padL(pct(p.annualizedDiffPct), 7)}  ${padL(p.stableFraction.toFixed(2), 6)}  ${padL(isFinite(p.breakevenDays) ? p.breakevenDays.toFixed(1) + 'd' : '∞', 9)}  ` +
      `${p.harvestable ? `✅ short ${short}` : '·'}`,
    );
  }
  console.log(`\n  scored ${board.scored} pairs · HARVESTABLE ${board.harvestable}`);
  console.log(`  VERDICT INPUT, NOT A VERDICT: the M2 go/no-go cites ≥7 daily boards, not one.`);

  const dir = join('docs', 'research', 'funding-differentials');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `board-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ config: { days: DAYS, symbols: SYMBOLS, hlMakerBps: HL_MAKER_BPS, binanceMakerBps: BINANCE_MAKER_BPS, bybitMakerBps: BYBIT_MAKER_BPS, ...baseCfg }, board }, null, 2));
  console.log(`\n  → ${file}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
