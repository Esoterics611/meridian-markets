import { Bar } from '../backtest/bar';
import { logSpread } from '../signal/spread';
import { stdev } from '../signal/fee-gate';
import { discoverPairs, PairDiscoveryConfig } from './pair-discovery';
import { scoreNetEdge } from './net-edge-scorer';

// OpportunityScanner — the "scan wide, trade rarely" engine. Sweeps a set of
// asset-class presets, runs pair discovery within each, and ranks every
// cointegrated candidate by EXPECTED NET-OF-FEES PROFIT PER DAY (net-edge-scorer).
// The board it returns is the desk's shortlist: only the pairs whose expected
// reversion clears the fee gate, sorted by how much they pay. Because we trade
// few names, the value is in breadth + ranking, not in any single discovery.
//
// Bar loading is injected (`BarLoader`) so the scanner is DB-free and testable:
// the module wires it to the Binance public client; a test wires a fixture map.
// Symbols are cached within a scan so overlapping presets don't refetch.

export type BarLoader = (symbol: string, source?: string) => Promise<Bar[]>;

export interface ScannerPreset {
  id: string;
  label: string;
  assetClass: string;
  symbols: string[];
  /** Data source id ('binance' default, or a reference source like 'pyth'). */
  source?: string;
}

export interface OpportunityScannerConfig {
  entryZ: number;
  exitZ: number;
  /** Round-trip taker fee in bps (4 legs). */
  feeBps: number;
  /** Safety multiple on the fee floor. */
  minEdgeMultiple: number;
  /** Bars per day at the feed interval (for tradesPerDay). */
  barsPerDay: number;
  /** Window for the σ_spread estimate. */
  sigmaWindowBars: number;
  /** Half-lives per round-trip (frequency proxy). */
  roundTripFactor: number;
  /** Bars to load per symbol. */
  barsToLoad: number;
  discovery: PairDiscoveryConfig;
}

export interface ScoredOpportunity {
  presetId: string;
  assetClass: string;
  /** Data source the pair was scanned from ('binance', 'pyth', ...). */
  source: string;
  symbolA: string;
  symbolB: string;
  beta: number;
  pValue: number;
  halfLifeBars: number;
  sigmaSpread: number;
  perTradeNetEdgeBps: number;
  tradesPerDay: number;
  certainty: number;
  netEdgePerDayBps: number;
  clearsFees: boolean;
}

export interface OpportunityBoard {
  generatedAt: string;
  presetsScanned: number;
  pairsTested: number;
  cleared: number;
  opportunities: ScoredOpportunity[];
}

export class OpportunityScanner {
  constructor(
    private readonly loadBars: BarLoader,
    private readonly presets: ScannerPreset[],
    private readonly cfg: OpportunityScannerConfig,
  ) {}

  /** Scan all presets, or only those whose id is in `filterPresetIds` (faster). */
  async scan(filterPresetIds?: string[]): Promise<OpportunityBoard> {
    const presets =
      filterPresetIds && filterPresetIds.length
        ? this.presets.filter((p) => filterPresetIds.includes(p.id))
        : this.presets;
    const cache = new Map<string, Bar[]>();
    // Cache by source+symbol so a symbol shared across sources never collides.
    const load = async (sym: string, source?: string): Promise<Bar[]> => {
      const key = `${source ?? 'binance'}:${sym}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const bars = await this.loadBars(sym, source).catch(() => [] as Bar[]);
      cache.set(key, bars);
      return bars;
    };

    const opportunities: ScoredOpportunity[] = [];
    let pairsTested = 0;
    let presetsScanned = 0;

    for (const preset of presets) {
      try {
        const universe = new Map<string, Bar[]>();
        for (const sym of preset.symbols) {
          const bars = await load(sym, preset.source);
          if (bars.length >= this.cfg.discovery.minBars) universe.set(sym, bars);
        }
        if (universe.size < 2) {
          presetsScanned += 1;
          continue;
        }
        const candidates = discoverPairs(universe, this.cfg.discovery);
        pairsTested += candidates.length;
        for (const c of candidates) {
          const sigmaSpread = this.sigmaSpreadFor(universe.get(c.symbolA)!, universe.get(c.symbolB)!, c.beta);
          const score = scoreNetEdge({
            sigmaSpread,
            halfLifeBars: c.halfLifeBars,
            pValue: c.pValue,
            entryZ: this.cfg.entryZ,
            exitZ: this.cfg.exitZ,
            feeBps: this.cfg.feeBps,
            barsPerDay: this.cfg.barsPerDay,
            minEdgeMultiple: this.cfg.minEdgeMultiple,
            roundTripFactor: this.cfg.roundTripFactor,
          });
          opportunities.push({
            presetId: preset.id,
            assetClass: preset.assetClass,
            source: preset.source ?? 'binance',
            symbolA: c.symbolA,
            symbolB: c.symbolB,
            beta: c.beta,
            pValue: c.pValue,
            halfLifeBars: c.halfLifeBars,
            sigmaSpread,
            perTradeNetEdgeBps: score.perTradeNetEdgeBps,
            tradesPerDay: score.tradesPerDay,
            certainty: score.certainty,
            netEdgePerDayBps: score.netEdgePerDayBps,
            clearsFees: score.clearsFees,
          });
        }
        presetsScanned += 1;
      } catch {
        // A bad preset (network, malformed data) shouldn't sink the whole scan.
        presetsScanned += 1;
      }
    }

    opportunities.sort((a, b) => b.netEdgePerDayBps - a.netEdgePerDayBps);
    return {
      generatedAt: new Date().toISOString(),
      presetsScanned,
      pairsTested,
      cleared: opportunities.filter((o) => o.clearsFees).length,
      opportunities,
    };
  }

  private sigmaSpreadFor(barsA: Bar[], barsB: Bar[], beta: number): number {
    const n = Math.min(barsA.length, barsB.length);
    const closesA = new Array<number>(n);
    const closesB = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      closesA[i] = barsA[i].close;
      closesB[i] = barsB[i].close;
    }
    const spread = logSpread(closesA, closesB, beta);
    const w = Math.min(this.cfg.sigmaWindowBars, spread.length);
    return stdev(spread.slice(spread.length - w));
  }
}
