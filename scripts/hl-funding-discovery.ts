/**
 * HL funding-carry universe discovery — "which Hyperliquid perp pays persistent,
 * HARVESTABLE funding?" The carry analogue of the MM universe scan
 * (hl-universe-discovery): it ranks the cross-venue delta-neutral cash-and-carry
 * (long spot / short HL perp, or the reverse for persistently negative funding)
 * across the WHOLE HL perp universe by the funding STREAM it harvests, net of the
 * one-time round-trip fee, with a sign-stability gate.
 *
 * Run (DB-free, real HL public API):
 *   npx ts-node -r tsconfig-paths/register scripts/hl-funding-discovery.ts
 *   FCD_DAYS=14 FCD_TOP=80 FCD_MIN_ANN_PCT=8 npx ts-node ... hl-funding-discovery.ts
 *
 * Honesty: the edge is the funding stream (continuous); the 4-fill round trip is
 * a ONE-TIME cost. A coin is "harvestable" only when its funding is material, its
 * SIGN is STABLE (you can't harvest a stream that flips), the breakeven hold is
 * short, and it's liquid enough to leg in. Basis is excluded (delta-neutral); the
 * funding-only read is the discovery signal — the live cross-venue book is the
 * verdict. Writes a JSON board to docs/research/hl-funding/.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { HyperliquidFundingClient, HYPERLIQUID_PERIODS_PER_YEAR } from '../src/market-data/funding/hyperliquid-funding-client';
import { parseHlUniverse } from '../src/market-making/screen/hl-universe-discovery';
import { scoreFundingCarry, assembleFundingBoard, FundingDiscoveryConfig, FundingCarryScore } from '../src/market-data/funding/funding-carry-discovery';

const BASE_URL = (process.env.FCD_BASE_URL ?? 'https://api.hyperliquid.xyz').replace(/\/+$/, '');
const DAYS = Number(process.env.FCD_DAYS ?? 14);
const TOP = Number(process.env.FCD_TOP ?? 80); // scan the top-N by daily volume (politeness + relevance)

const cfg: FundingDiscoveryConfig = {
  spotFeeBps: Number(process.env.FCD_SPOT_FEE_BPS ?? 4.5), // Binance spot taker (the long leg)
  perpFeeBps: Number(process.env.FCD_PERP_FEE_BPS ?? 2.5), // HL perp taker (the short leg)
  periodsPerYear: HYPERLIQUID_PERIODS_PER_YEAR, // HL settles HOURLY
  notionalUnits: BigInt(process.env.FCD_NOTIONAL_UNITS ?? '100000000000'), // $100k/leg
  minPeriods: Number(process.env.FCD_MIN_PERIODS ?? 24 * 3), // ≥ 3 days of hourly settlements
  minStableFraction: Number(process.env.FCD_MIN_STABLE ?? 0.7),
  minAnnualizedFundingPct: Number(process.env.FCD_MIN_ANN_PCT ?? 8),
  maxBreakevenDays: Number(process.env.FCD_MAX_BREAKEVEN_DAYS ?? 20),
  minDayNtlVlmUsd: Number(process.env.FCD_MIN_VOL_USD ?? 5_000_000),
};

async function httpPost(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const padL = (s: string | number, n: number): string => String(s).padStart(n);
const pct = (x: number, d = 1): string => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;

async function main(): Promise<void> {
  const fund = new HyperliquidFundingClient({ baseUrl: BASE_URL });
  const endMs = Date.now();
  const startMs = endMs - DAYS * 86_400_000;

  console.log(`\n=== HL funding-carry discovery — ${DAYS}d hourly history, top ${TOP} by volume ===`);
  console.log(`  fees: spot ${cfg.spotFeeBps}bps + perp ${cfg.perpFeeBps}bps/side ⇒ ${2 * (cfg.spotFeeBps + cfg.perpFeeBps)}bps round trip | settle: HOURLY (${cfg.periodsPerYear}/yr)`);
  console.log(`  gates: |ann funding| ≥ ${cfg.minAnnualizedFundingPct}% · stable ≥ ${cfg.minStableFraction} · breakeven ≤ ${cfg.maxBreakevenDays}d · vol ≥ $${(cfg.minDayNtlVlmUsd! / 1e6).toFixed(0)}M`);

  // 1. The universe + per-coin daily volume (the liquidity proxy + scan order).
  const universeRaw = await httpPost(`${BASE_URL}/info`, { type: 'metaAndAssetCtxs' });
  const universe = parseHlUniverse(universeRaw).filter((u) => u.markPx > 0);
  const ranked = [...universe].sort((a, b) => b.dayNtlVlmUsd - a.dayNtlVlmUsd).slice(0, TOP);
  console.log(`  universe: ${universe.length} perps; scanning the ${ranked.length} most-traded\n`);

  // 2. Per-coin funding history → score. Sequential with a small delay (polite to the public API).
  const scored: FundingCarryScore[] = [];
  for (const ctx of ranked) {
    try {
      const funding = await fund.fundingHistory(ctx.name, startMs, endMs);
      const s = scoreFundingCarry(ctx.name, funding, cfg, ctx.dayNtlVlmUsd);
      if (s) scored.push(s);
    } catch (e) {
      console.log(`  ${ctx.name.padEnd(8)} — fetch failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 60));
  }

  const board = assembleFundingBoard(scored, universe.length);

  // 3. Print: the harvestable board first, then the full ranked list.
  console.log(`  symbol    dir         annFund%   stable   breakeven  annNet%   vol$M    harvest`);
  for (const s of board.instruments.slice(0, 30)) {
    const flag = s.harvestable ? '✅' : s.liquid ? '·' : 'illiq';
    console.log(
      `  ${pad(s.symbol, 8)}  ${pad(s.direction, 10)}  ${padL(pct(s.annualizedFundingPct), 8)}  ${padL(s.stableFraction.toFixed(2), 6)}  ${padL(s.breakevenDays === Infinity ? '∞' : s.breakevenDays.toFixed(1) + 'd', 9)}  ${padL(pct(s.annualizedNetPct), 7)}  ${padL((s.dayNtlVlmUsd / 1e6).toFixed(0), 6)}  ${flag}`,
    );
  }
  console.log(`\n  scored ${board.scored} · HARVESTABLE ${board.harvestable}: ${board.carries.map((c) => `${c.symbol}(${pct(c.harvestableFundingPct, 0)}% ${c.direction === 'SHORT_PERP' ? 'short' : 'long'})`).join(', ') || '—'}`);
  console.log(`\n  VERDICT: the funding stream is the edge; the round trip is one-time. Harvestable = material + sign-stable + short breakeven + liquid.`);
  console.log(`  The cross-venue delta-neutral form (long Binance spot / short HL perp) is the deployable carry — this board is the watchlist, not a fill forecast.`);

  // 4. Persist the board.
  const dir = join('docs', 'research', 'hl-funding');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `discovery-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ config: { ...cfg, notionalUnits: cfg.notionalUnits.toString(), days: DAYS, top: TOP }, board }, null, 2));
  console.log(`\n  → ${file}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
