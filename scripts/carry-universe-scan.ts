/**
 * carry-universe-scan — PROFIT_PIVOT_II P1(a): the FULL-universe carry scan.
 *
 * hl-funding-discovery ranks the top-N by volume with the IN-SAMPLE scorer; this
 * script runs the DESK'S OWN GATE (rankCarryUniverse: OOS split + posFrac stability
 * + the #72 recency veto — exactly what carry-desk-live gates entries with) over
 * EVERY main-dex HL perp (~230), so the P1 breadth target (≥8 gated legs) is fed by
 * the whole universe, not the ten majors CD_SYMBOLS defaulted to.
 *
 * RATE-LIMIT REALITY: fundingHistory is one of HL's heavyweight info calls — a naive
 * 231-coin × 90d sweep (~5 pages/coin) gets 429'd after ~25 coins. So the scan is
 * TWO-STAGE: (A) one 14d page per coin for the whole universe → sieve out streams
 * too thin to ever rank (they'd fail the recency veto or land dead-last anyway);
 * (B) the full 90d desk gate on the survivors only. All HL requests go through one
 * paced queue (~1.1s apart) with exponential 429 backoff. The sieve floor is a
 * completeness trade-off and is recorded in the artifact.
 *
 * Deployability is more than the gate: the cross-venue pair needs a Binance SPOT
 * leg (long spot / short perp), so each coin is annotated with spot availability
 * (one /api/v3/ticker/price sweep — a k-prefixed HL coin like kPEPE maps to the
 * unprefixed Binance market) and a liquidity floor. DEPLOYABLE = gate ∧ spot ∧ liquid.
 *
 * Run (DB-free, real public APIs; ~6–10 min wall time at the polite pace):
 *   npx ts-node -r tsconfig-paths/register scripts/carry-universe-scan.ts
 * Knobs: CUS_DAYS(90) CUS_SIEVE_DAYS(14) CUS_SIEVE_MIN_PCT(3.5) CUS_MIN_POS_FRAC(0.65)
 *        CUS_RECENCY_DAYS(7) CUS_MIN_VOL_USD(5e6) CUS_SPOT_FEE_BPS(4.5)
 *        CUS_PERP_FEE_BPS(2.5) CUS_PACE_MS(1100) CUS_TOP(40)
 *
 * Writes the ranked board to docs/research/carry-universe/scan-<ts>.json and prints
 * the recommended CD_SYMBOLS line for the live desk.
 */
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { HyperliquidFundingClient, HYPERLIQUID_PERIODS_PER_YEAR } from '../src/market-data/funding/hyperliquid-funding-client';
import { parseHlUniverse, HlPerpCtx } from '../src/market-making/screen/hl-universe-discovery';
import { rankCarryUniverse, OosFundingResult, OosGateConfig } from '../src/market-data/funding/funding-carry-oos';
import { FundingPoint } from '../src/market-data/funding/funding-source.interface';

const HL_BASE = (process.env.CUS_HL_BASE_URL ?? 'https://api.hyperliquid.xyz').replace(/\/+$/, '');
const BINANCE_BASE = (process.env.CUS_BINANCE_BASE_URL ?? 'https://api.binance.com').replace(/\/+$/, '');
const DAYS = Number(process.env.CUS_DAYS ?? 90); // mirror the desk gate window
const SIEVE_DAYS = Number(process.env.CUS_SIEVE_DAYS ?? 14); // stage A: one page per coin
const SIEVE_MIN_PCT = Number(process.env.CUS_SIEVE_MIN_PCT ?? 3.5); // |14d ann funding| floor for stage B
const MIN_POS_FRAC = Number(process.env.CUS_MIN_POS_FRAC ?? 0.65);
const RECENCY_DAYS = Number(process.env.CUS_RECENCY_DAYS ?? 7);
const MIN_VOL_USD = Number(process.env.CUS_MIN_VOL_USD ?? 5_000_000);
const SPOT_FEE_BPS = Number(process.env.CUS_SPOT_FEE_BPS ?? 4.5);
const PERP_FEE_BPS = Number(process.env.CUS_PERP_FEE_BPS ?? 2.5);
const PACE_MS = Number(process.env.CUS_PACE_MS ?? 1100); // ~55 heavyweight info calls/min
const TOP = Number(process.env.CUS_TOP ?? 40);

const gateCfg: OosGateConfig = {
  periodsPerYear: HYPERLIQUID_PERIODS_PER_YEAR,
  spotFeeBps: SPOT_FEE_BPS,
  perpFeeBps: PERP_FEE_BPS,
  notionalUnits: 50_000_000_000n, // $50k/leg — cancels in the % metrics
  minPosFrac: MIN_POS_FRAC,
  recencyDays: RECENCY_DAYS,
};

/** One scanned coin: the gate result + the deployability annotations. */
export interface CarryUniverseRow extends OosFundingResult {
  dayNtlVlmUsd: number;
  liquid: boolean;
  /** The Binance spot market for the long leg ('PEPEUSDT' for kPEPE), or null. */
  binanceSpotMarket: string | null;
  /** k-prefixed HL coin ⇒ the spot leg trades the unprefixed asset at 1000× quantity. */
  spotScaled: boolean;
  /** Stage-A read: |annualised funding| over the sieve window (all coins have this). */
  sieveAnnualizedPct: number;
  /** passGate ∧ spot leg exists ∧ liquid — what CD_SYMBOLS should be fed from. */
  deployable: boolean;
}

// One paced HL request pipe: heavyweight info calls run ≥PACE_MS apart, and a 429
// backs the whole pipe off exponentially (HL limits by IP, not by endpoint).
let hlChain: Promise<unknown> = Promise.resolve();
let lastHlRequestMs = 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pacedHlPost(url: string, body: unknown): Promise<unknown> {
  const run = async (): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastHlRequestMs + PACE_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastHlRequestMs = Date.now();
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 429 && attempt < 6) {
        const backoff = 5_000 * 2 ** attempt;
        console.log(`  ...429 from HL — backing off ${(backoff / 1000).toFixed(0)}s`);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res.json();
    }
  };
  const next = hlChain.then(run, run);
  hlChain = next.catch(() => undefined); // keep the pipe alive past a failure
  return next;
}

async function binanceSpotMarkets(): Promise<Set<string>> {
  const res = await fetch(`${BINANCE_BASE}/api/v3/ticker/price`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Binance ticker/price -> HTTP ${res.status}`);
  const raw = (await res.json()) as { symbol?: string }[];
  return new Set(raw.map((r) => r.symbol ?? '').filter(Boolean));
}

/** Map an HL coin to its Binance USDT spot market (k-prefix = 1000× wrapper). */
function spotMarketFor(coin: string, markets: Set<string>): { market: string | null; scaled: boolean } {
  const direct = `${coin.toUpperCase()}USDT`;
  if (markets.has(direct)) return { market: direct, scaled: false };
  if (/^k[A-Z]/.test(coin)) {
    const unwrapped = `${coin.slice(1).toUpperCase()}USDT`;
    if (markets.has(unwrapped)) return { market: unwrapped, scaled: true };
  }
  return { market: null, scaled: false };
}

const pad = (s: string | number, n: number): string => String(s).padEnd(n);
const padL = (s: string | number, n: number): string => String(s).padStart(n);
const pct = (x: number, d = 1): string => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;

async function main(): Promise<void> {
  const fund = new HyperliquidFundingClient({ baseUrl: HL_BASE, httpPost: pacedHlPost });
  const endMs = Date.now();

  console.log(`\n=== FULL-UNIVERSE CARRY SCAN — the desk gate over every HL perp (P1a) ===`);
  console.log(`  gate: ${DAYS}d OOS split · posFrac≥${MIN_POS_FRAC} both windows · ${RECENCY_DAYS}d recency veto (#72)`);
  console.log(`  sieve: ${SIEVE_DAYS}d stage-A pass, |ann funding| ≥ ${SIEVE_MIN_PCT}% → full ${DAYS}d gate | pace ${PACE_MS}ms/req`);
  console.log(`  fees: spot ${SPOT_FEE_BPS} + perp ${PERP_FEE_BPS} bps/side | deployable = gate ∧ Binance spot ∧ vol ≥ $${(MIN_VOL_USD / 1e6).toFixed(0)}M\n`);

  // 1. The whole main-dex universe (HIP-3 dex perps have no spot hedge — out of scope here).
  const [universeRaw, spotMarkets] = await Promise.all([
    pacedHlPost(`${HL_BASE}/info`, { type: 'metaAndAssetCtxs' }),
    binanceSpotMarkets(),
  ]);
  const universe = parseHlUniverse(universeRaw).filter((u) => u.markPx > 0);
  console.log(`  universe: ${universe.length} HL perps · ${spotMarkets.size} Binance spot markets`);

  // 2. Stage A — one ${SIEVE_DAYS}d page per coin, whole universe. Everything below the
  //    sieve floor is recorded (sieveAnnualizedPct) but not gated: a stream that thin
  //    would rank dead-last and mostly fail the recency veto anyway.
  const failures: string[] = [];
  const sieveReads = new Map<string, { funding: FundingPoint[]; annPct: number }>();
  let scanned = 0;
  for (const ctx of universe) {
    try {
      const funding = await fund.fundingHistory(ctx.name, endMs - SIEVE_DAYS * 86_400_000, endMs);
      if (funding.length >= 6) {
        const mean = funding.reduce((s, p) => s + p.fundingRate, 0) / funding.length;
        sieveReads.set(ctx.name, { funding, annPct: Math.abs(mean) * HYPERLIQUID_PERIODS_PER_YEAR * 100 });
      }
    } catch (e) {
      failures.push(`${ctx.name}: ${(e as Error).message}`);
    }
    scanned++;
    if (scanned % 40 === 0) console.log(`  ...stage A ${scanned}/${universe.length}`);
  }
  const survivors = universe.filter((u) => (sieveReads.get(u.name)?.annPct ?? 0) >= SIEVE_MIN_PCT);
  console.log(`  stage A done: ${sieveReads.size} scored, ${failures.length} failures → ${survivors.length} survivors to the ${DAYS}d gate`);

  // 3. Stage B — the desk's own 90d gate on the survivors.
  const histories: { symbol: string; funding: FundingPoint[]; ctx: HlPerpCtx }[] = [];
  scanned = 0;
  for (const ctx of survivors) {
    try {
      const funding = await fund.fundingHistory(ctx.name, endMs - DAYS * 86_400_000, endMs);
      if (funding.length >= 6) histories.push({ symbol: ctx.name, funding, ctx });
    } catch (e) {
      failures.push(`${ctx.name}: ${(e as Error).message}`);
    }
    scanned++;
    if (scanned % 10 === 0) console.log(`  ...stage B ${scanned}/${survivors.length}`);
  }
  if (failures.length > 0) console.log(`  ${failures.length} fetch failures (kept out of the board): ${failures.slice(0, 5).join(' · ')}${failures.length > 5 ? ' …' : ''}`);

  // 4. The desk gate over the survivors, then the deployability annotations.
  const gated = rankCarryUniverse(histories.map(({ symbol, funding }) => ({ symbol, funding })), gateCfg);
  const rows: CarryUniverseRow[] = gated.map((r) => {
    const ctx = universe.find((u) => u.name === r.symbol);
    const vol = ctx?.dayNtlVlmUsd ?? 0;
    const { market, scaled } = spotMarketFor(r.symbol, spotMarkets);
    const liquid = vol >= MIN_VOL_USD;
    return {
      ...r,
      dayNtlVlmUsd: vol,
      liquid,
      binanceSpotMarket: market,
      spotScaled: scaled,
      sieveAnnualizedPct: sieveReads.get(r.symbol)?.annPct ?? 0,
      deployable: r.passGate && market !== null && liquid,
    };
  });

  // Rank by the harvestable stream: |full annualised funding| among passers first.
  rows.sort((a, b) => Number(b.passGate) - Number(a.passGate) || Math.abs(b.full.annualizedFundingPct) - Math.abs(a.full.annualizedFundingPct));
  const passers = rows.filter((r) => r.passGate);
  const deployable = rows.filter((r) => r.deployable);

  console.log(`\n  symbol    dir         fullFund%  recent7d%  IS/OOS posFrac  breakeven  vol$M  spot      GATE`);
  for (const r of rows.slice(0, TOP)) {
    const spotTag = r.binanceSpotMarket ? (r.spotScaled ? 'scaled' : 'yes') : 'NO';
    const gateTag = r.deployable ? '✅ DEPLOY' : r.passGate ? (r.binanceSpotMarket ? '· illiq' : '· no-spot') : r.recent.vetoed ? '🚫 veto' : '❌';
    console.log(
      `  ${pad(r.symbol, 8)}  ${pad(r.direction, 10)}  ${padL(pct(r.full.annualizedFundingPct), 8)}  ${padL(pct(r.recent.annualizedFundingPct), 9)}  ` +
      `${padL(`${r.inSample.posFrac.toFixed(2)}/${r.oos.posFrac.toFixed(2)}`, 13)}  ` +
      `${padL(isFinite(r.full.breakevenDays) ? r.full.breakevenDays.toFixed(1) + 'd' : '∞', 9)}  ${padL((r.dayNtlVlmUsd / 1e6).toFixed(0), 5)}  ${pad(spotTag, 8)}  ${gateTag}`,
    );
  }

  console.log(`\n  universe ${universe.length} · stage-A scored ${sieveReads.size} · gated ${rows.length} · GATE-PASS ${passers.length} · DEPLOYABLE ${deployable.length}`);
  console.log(`\n  Recommended for the live desk (deployable, biggest stream first):`);
  console.log(`  CD_SYMBOLS=${deployable.slice(0, 16).map((r) => r.symbol).join(',')}`);
  const longPerp = deployable.filter((r) => r.direction === 'LONG_PERP');
  if (longPerp.length > 0) {
    console.log(`  note: ${longPerp.map((r) => r.symbol).join(',')} gate LONG_PERP (short spot leg — needs borrow; the desk models it, flag it honestly).`);
  }

  // 4. Persist the board (the P1a artifact).
  const dir = join('docs', 'research', 'carry-universe');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `scan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  // Sieved-out coins are recorded too (compact), so the completeness trade-off is auditable.
  const sievedOut = universe
    .filter((u) => !rows.some((r) => r.symbol === u.name))
    .map((u) => ({ symbol: u.name, sieveAnnualizedPct: sieveReads.get(u.name)?.annPct ?? null, dayNtlVlmUsd: u.dayNtlVlmUsd }))
    .sort((a, b) => (b.sieveAnnualizedPct ?? -1) - (a.sieveAnnualizedPct ?? -1));
  writeFileSync(
    file,
    JSON.stringify(
      {
        config: { days: DAYS, sieveDays: SIEVE_DAYS, sieveMinPct: SIEVE_MIN_PCT, minPosFrac: MIN_POS_FRAC, recencyDays: RECENCY_DAYS, minVolUsd: MIN_VOL_USD, spotFeeBps: SPOT_FEE_BPS, perpFeeBps: PERP_FEE_BPS, universeSize: universe.length, stageAScored: sieveReads.size, gated: rows.length, gatePass: passers.length, deployable: deployable.length, failures },
        rows,
        sievedOut,
      },
      null,
      2,
    ),
  );
  console.log(`\n  → ${file}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
