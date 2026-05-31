import { SimpleQueueModel } from './queue-model';

const NOW = new Date('2026-01-01T00:00:00Z');

describe('SimpleQueueModel', () => {
  it('reduces the size ahead as aggressive volume and cancels hit the level', () => {
    const m = new SimpleQueueModel();
    const lvl = { priceMicros: 100n, sizeUnits: 10n, orderCount: 5 };
    const pos = m.enqueue(lvl, 1n, NOW);
    expect(pos.aheadUnits).toBe(10n);
    const decayed = m.decay(pos, { ...lvl, sizeUnits: 6n }, 4n, NOW);
    expect(decayed.aheadUnits).toBeLessThan(pos.aheadUnits);
  });

  it('is certain to fill once nothing is ahead, and more likely over a longer horizon', () => {
    const m = new SimpleQueueModel();
    const front = { priceMicros: 100n, sizeUnits: 1_000_000n, aheadUnits: 0n, joinedAt: NOW };
    expect(m.fillProbability(front, 1, 10)).toBe(1);

    const mid = { ...front, aheadUnits: 5_000_000n };
    const short = m.fillProbability(mid, 1, 10);
    const long = m.fillProbability(mid, 1, 100);
    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThanOrEqual(0);
    expect(long).toBeLessThanOrEqual(1);
  });
});
