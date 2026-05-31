import { OpportunityScanner, ScannerPreset, OpportunityScannerConfig } from './opportunity-scanner';
import { generateSyntheticUniverse } from '../backtest/synthetic-universe';
import { Bar } from '../backtest/bar';

const u = generateSyntheticUniverse({
  barCount: 240, startAt: new Date('2026-01-01T00:00:00Z'), barIntervalMs: 60_000,
  clusterCount: 2, symbolsPerCluster: 3, noiseSymbols: 3,
});
const symbols = [...u.bars.keys()];
const loader = async (s: string): Promise<Bar[]> => u.bars.get(s) ?? [];
const preset: ScannerPreset = { id: 'syn', label: 'Synthetic', assetClass: 'Synthetic', symbols };
const cfg: OpportunityScannerConfig = {
  entryZ: 2, exitZ: 0.5, feeBps: 5, minEdgeMultiple: 1.5, barsPerDay: 1440,
  sigmaWindowBars: 60, roundTripFactor: 2, barsToLoad: 240,
  discovery: { minBars: 50, pValueCutoff: 0.1 },
};

describe('OpportunityScanner', () => {
  it('discovers cointegrated pairs, scores net-edge, and ranks the board', async () => {
    const board = await new OpportunityScanner(loader, [preset], cfg).scan();
    expect(board.presetsScanned).toBe(1);
    expect(board.pairsTested).toBeGreaterThan(0);
    expect(board.opportunities.length).toBeGreaterThan(0);
    // Sorted descending by netEdgePerDayBps.
    for (let i = 1; i < board.opportunities.length; i++) {
      expect(board.opportunities[i - 1].netEdgePerDayBps).toBeGreaterThanOrEqual(board.opportunities[i].netEdgePerDayBps);
    }
    // The cluster pairs carry real edge → at least one clears the fee gate and tops the board.
    expect(board.cleared).toBeGreaterThanOrEqual(1);
    expect(board.opportunities[0].clearsFees).toBe(true);
    expect(board.opportunities[0].netEdgePerDayBps).toBeGreaterThan(0);
    expect(board.opportunities[0].sigmaSpread).toBeGreaterThan(0);
  });

  it('skips a preset with fewer than two loadable symbols', async () => {
    const board = await new OpportunityScanner(async () => [], [preset], cfg).scan();
    expect(board.opportunities).toEqual([]);
    expect(board.pairsTested).toBe(0);
    expect(board.cleared).toBe(0);
  });
});
