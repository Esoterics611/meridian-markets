import { Body, Controller, Get, Post } from '@nestjs/common';
import { generateSyntheticUniverse } from '../backtest/synthetic-universe';
import { discoverPairs } from './pair-discovery';
import { clusterSymbols, pickRepresentativePairs } from './clustering';
import { detectRegime } from '../regime/regime-detector';

// GET /api/stat-arb/research/universe — runs discovery + clustering + regime
// detection over a synthetic N-symbol universe and returns the ranked pair
// list with per-pair regime tags. Drives the Universe card on the Research
// desk. Synthetic-feed today; once a real-bar ingest cron lands, this swaps
// to reading from MarketDataRepository without changing the response shape.
//
// POST /api/stat-arb/research/universe/promote — logs a "promote to live"
// intent for a chosen pair. KYB-gated: the endpoint logs and returns ok, but
// does NOT actually flip the pair into live trading. That step requires a
// human-approved flag flip (Phase 4 fund + business sign-off per
// PHASED_PLAN.md). The intent log is the audit trail for that approval flow.

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

interface ApiUniverseResponse {
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
  gate: 'KYB_REQUIRED_BEFORE_LIVE';
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
      gate: 'KYB_REQUIRED_BEFORE_LIVE',
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

  const cands = discoverPairs(u.bars, { minBars: 50, pValueCutoff: 0.20 });
  const clustering = clusterSymbols(u.bars, { distanceThreshold: 0.35 });
  const reps = pickRepresentativePairs(cands, clustering.symbolToCluster);

  const enrich = (c: typeof cands[number]): ApiPairRow => {
    const logA = u.bars.get(c.symbolA)!.map((b) => Math.log(b.close));
    const logB = u.bars.get(c.symbolB)!.map((b) => Math.log(b.close));
    const regime = detectRegime(logA, logB, { lookbackBars: 60 });
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
    symbols: [...u.bars.keys()],
    groundTruthClusters: u.clusters,
    noiseSymbols: u.noiseSymbols,
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
