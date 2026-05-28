import { ResearchController } from './research.controller';
import { ConfigService } from '@nestjs/config';
import { MockTradingVenue } from '../mock-trading-venue';

function makeController() {
  const cfg = {
    getOrThrow: () => ({
      statArb: { demoPairA: 'BTC', demoPairB: 'ETH', demoBarCount: 90, mockEnabled: true },
    }),
  } as unknown as ConfigService;
  return new ResearchController(cfg, new MockTradingVenue());
}

describe('ResearchController', () => {
  it('GET /walk-forward returns the report with windows + averages', async () => {
    const r = await makeController().walkForwardEndpoint('80', '40', '300');
    expect(r.windows.length).toBeGreaterThan(0);
    expect(typeof r.avgTestSharpe).toBe('number');
    expect(typeof r.positiveWindowShare).toBe('number');
    // bigints are serialised as strings.
    expect(typeof r.windows[0].test.totalPnlUnits).toBe('string');
  });

  it('GET /walk-forward defaults work without query params', async () => {
    const r = await makeController().walkForwardEndpoint();
    expect(r.windows.length).toBeGreaterThan(0);
  });

  it('GET /sweep returns a non-empty Cartesian product of cells', async () => {
    const r = await makeController().sweepEndpoint();
    expect(r.cells.length).toBe(4 * 3); // 4 entryZ × 3 exitZ
    expect(typeof r.cells[0].totalPnlUnits).toBe('string');
  });

  it('GET /sweep returns cells ranked by sharpe desc', async () => {
    const r = await makeController().sweepEndpoint();
    for (let i = 1; i < r.cells.length; i++) {
      expect(r.cells[i - 1].sharpeRatio).toBeGreaterThanOrEqual(r.cells[i].sharpeRatio);
    }
  });

  it('GET /monte-carlo returns p05/p50/p95 arrays of the same length', async () => {
    const r = await makeController().monteCarloEndpoint('50', '7');
    expect(r.p05.length).toBe(r.p50.length);
    expect(r.p50.length).toBe(r.p95.length);
    expect(r.replications).toBe(50);
  });

  it('GET /monte-carlo summary is deterministic for the same seed', async () => {
    const a = await makeController().monteCarloEndpoint('100', '99');
    const b = await makeController().monteCarloEndpoint('100', '99');
    expect(a.summary.medianFinalPnl).toBe(b.summary.medianFinalPnl);
  });
});
