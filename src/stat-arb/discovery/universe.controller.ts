import { Body, Controller, Get, Post } from '@nestjs/common';
import { generateSyntheticUniverse } from '../backtest/synthetic-universe';
import { discoverPairs } from './pair-discovery';
import { clusterSymbols, pickRepresentativePairs } from './clustering';
import { detectRegime } from '../regime/regime-detector';
import { Bar } from '../backtest/bar';

// GET /api/stat-arb/research/universe — runs discovery + clustering + regime
// detection over a synthetic N-symbol universe and returns the ranked pair
// list with per-pair regime tags. Drives the Universe card on the Research
// desk. Synthetic-feed today; once a real-bar ingest cron lands, this swaps
// to reading from MarketDataRepository without changing the response shape.
//
// POST /api/stat-arb/research/universe/promote — records that a discovered pair
// was selected to trade. No business gate: paper trading needs nothing, and
// arming the live loop on this pair is a single engineering call —
// POST /api/stat-arb/live/configure { symbolA, symbolB, beta } then /start.
// This endpoint is just the selection/audit log; it does not move the loop.

interface UniverseConfig {
  barCount?: number;
  clusterCount?: number;
  symbolsPerCluster?: number;
  noiseSymbols?: number;
}

interface ApiPairRow {
  symbolA: string;
  symbolB: string;
  clusterA: number;
  clusterB: number;
  beta: number;
  pValue: number;
  halfLifeBars: number;
  advA: number;
  advB: number;
  score: number;
  regime: { vol: string; trend: string; decoupling: boolean; pValue: number | null };
}

interface ApiClusterSummary {
  clusterId: number;
  symbols: string[];
  representative: string;
}

export interface ApiUniverseResponse {
  /** Where the bars came from — synthetic fixture, real Binance, or real Yahoo daily (equities). */
  source: 'synthetic' | 'real-binance-history' | 'real-yahoo-daily';
  symbols: string[];
  groundTruthClusters: { clusterId: number; symbols: string[] }[];
  noiseSymbols: string[];
  discoveredClusters: ApiClusterSummary[];
  topPairs: ApiPairRow[];
  representativePairs: ApiPairRow[];
}

interface PromoteRequest {
  symbolA: string;
  symbolB: string;
  note?: string;
}

interface PromoteResponse {
  ok: true;
  loggedAt: string;
  intent: { symbolA: string; symbolB: string; note?: string };
  /** What to do to actually trade it — an engineering action, not a business gate. */
  nextStep: 'POST /api/stat-arb/live/configure then /start';
}

const promotionLog: PromoteResponse[] = [];

@Controller('api/stat-arb/research')
export class UniverseController {
  @Get('universe')
  async universe(): Promise<ApiUniverseResponse> {
    return await runUniverse({});
  }

  @Post('universe/promote')
  async promote(@Body() req: PromoteRequest): Promise<PromoteResponse> {
    const entry: PromoteResponse = {
      ok: true,
      loggedAt: new Date().toISOString(),
      intent: { symbolA: req.symbolA, symbolB: req.symbolB, note: req.note },
      nextStep: 'POST /api/stat-arb/live/configure then /start',
    };
    promotionLog.push(entry);
    if (promotionLog.length > 50) promotionLog.shift();
    return entry;
  }

  @Get('universe/promotions')
  async promotions(): Promise<{ promotions: PromoteResponse[] }> {
    return { promotions: [...promotionLog].reverse() };
  }
}

// Extracted so tests can drive the universe computation without spinning
// up a Nest application context.
export async function runUniverse(opts: UniverseConfig): Promise<ApiUniverseResponse> {
  const u = generateSyntheticUniverse({
    barCount: opts.barCount ?? 240,
    startAt: new Date('2026-01-01T00:00:00Z'),
    barIntervalMs: 60_000,
    clusterCount: opts.clusterCount ?? 3,
    symbolsPerCluster: opts.symbolsPerCluster ?? 3,
    noiseSymbols: opts.noiseSymbols ?? 4,
  });
  return runUniverseOnBars(u.bars, {
    source: 'synthetic',
    groundTruthClusters: u.clusters,
    noiseSymbols: u.noiseSymbols,
  });
}

export interface UniverseOnBarsMeta {
  source: ApiUniverseResponse['source'];
  groundTruthClusters?: { clusterId: number; symbols: string[] }[];
  noiseSymbols?: string[];
  /** Discovery knobs; defaults match the synthetic path. */
  minBars?: number;
  pValueCutoff?: number;
  minHalfLifeBars?: number;
  maxHalfLifeBars?: number;
  distanceThreshold?: number;
  regimeLookbackBars?: number;
}

/**
 * The data-source-agnostic discovery pipeline: discover pairs, cluster, pick
 * representatives, tag regime. Used by BOTH the synthetic fixture path and the
 * real-Binance-history path (MarketDataController) — same response shape, the
 * only difference is where `bars` came from. This is the seam the S16 notes
 * promised: swap the bars source, nothing else changes.
 */
export function runUniverseOnBars(
  bars: Map<string, Bar[]>,
  meta: UniverseOnBarsMeta,
): ApiUniverseResponse {
  const cands = discoverPairs(bars, {
    minBars: meta.minBars ?? 50,
    pValueCutoff: meta.pValueCutoff ?? 0.20,
    minHalfLifeBars: meta.minHalfLifeBars,
    maxHalfLifeBars: meta.maxHalfLifeBars,
  });
  const clustering = clusterSymbols(bars, { distanceThreshold: meta.distanceThreshold ?? 0.35 });
  const reps = pickRepresentativePairs(cands, clustering.symbolToCluster);
  const lookbackBars = meta.regimeLookbackBars ?? 60;

  const enrich = (c: typeof cands[number]): ApiPairRow => {
    const logA = bars.get(c.symbolA)!.map((b) => Math.log(b.close));
    const logB = bars.get(c.symbolB)!.map((b) => Math.log(b.close));
    const regime = detectRegime(logA, logB, { lookbackBars });
    return {
      symbolA: c.symbolA,
      symbolB: c.symbolB,
      clusterA: clustering.symbolToCluster.get(c.symbolA) ?? -1,
      clusterB: clustering.symbolToCluster.get(c.symbolB) ?? -1,
      beta: c.beta,
      pValue: c.pValue,
      halfLifeBars: c.halfLifeBars,
      advA: c.advA,
      advB: c.advB,
      score: c.score,
      regime: { vol: regime.vol, trend: regime.trend, decoupling: regime.decoupling, pValue: regime.pValue },
    };
  };

  return {
    source: meta.source,
    symbols: [...bars.keys()],
    groundTruthClusters: meta.groundTruthClusters ?? [],
    noiseSymbols: meta.noiseSymbols ?? [],
    discoveredClusters: clustering.clusters.map((c) => ({
      clusterId: c.clusterId,
      symbols: c.symbols,
      representative: c.representative,
    })),
    topPairs: cands.slice(0, 20).map(enrich),
    representativePairs: reps.slice(0, 10).map(enrich),
  };
}

/** Test-only access to drain the in-memory promotion log between specs. */
export function _resetPromotionLog(): void {
  promotionLog.length = 0;
}
