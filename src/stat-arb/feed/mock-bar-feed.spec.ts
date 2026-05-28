import { MockBarFeed } from './mock-bar-feed';

const fixture = {
  symbolA: 'BTC',
  symbolB: 'ETH',
  barCount: 5,
  spreadPeriodBars: 4,
  spreadAmplitude: 0.05,
  basePriceB: 2000,
  aOverBRatio: 25,
  barIntervalMs: 60_000,
  startAt: new Date('2026-01-01T00:00:00Z'),
};

describe('MockBarFeed', () => {
  it('returns bars in order for each symbol', async () => {
    const feed = new MockBarFeed();
    feed.loadFixture(fixture);
    const a1 = await feed.nextBar('BTC');
    const a2 = await feed.nextBar('BTC');
    expect(a1).not.toBeNull();
    expect(a2).not.toBeNull();
    expect(a1!.timestamp.getTime()).toBeLessThan(a2!.timestamp.getTime());
  });

  it('returns null when the fixture is exhausted', async () => {
    const feed = new MockBarFeed();
    feed.loadFixture(fixture);
    for (let i = 0; i < fixture.barCount; i++) {
      const b = await feed.nextBar('BTC');
      expect(b).not.toBeNull();
    }
    expect(await feed.nextBar('BTC')).toBeNull();
  });

  it('advances symbol cursors independently', async () => {
    const feed = new MockBarFeed();
    feed.loadFixture(fixture);
    await feed.nextBar('BTC');
    await feed.nextBar('BTC');
    const ethFirst = await feed.nextBar('ETH');
    expect(ethFirst!.timestamp.getTime()).toBe(fixture.startAt.getTime());
  });

  it('returns null for unknown symbols', async () => {
    const feed = new MockBarFeed();
    feed.loadFixture(fixture);
    expect(await feed.nextBar('SOL')).toBeNull();
  });

  it('reset() rewinds every cursor', async () => {
    const feed = new MockBarFeed();
    feed.loadFixture(fixture);
    await feed.nextBar('BTC');
    await feed.nextBar('BTC');
    feed.reset();
    const b = await feed.nextBar('BTC');
    expect(b!.timestamp.getTime()).toBe(fixture.startAt.getTime());
  });
});
