import { VpinEstimator } from './vpin';

describe('VpinEstimator', () => {
  it('rises sharply on a one-sided burst', () => {
    const vpin = new VpinEstimator({ bucketVolumeUnits: 100n, emaWindowBuckets: 5 });
    for (let i = 0; i < 50; i++) vpin.onTrade(10n, i % 2 === 0 ? 'buy' : 'sell');
    const baseline = vpin.current();
    for (let i = 0; i < 50; i++) vpin.onTrade(10n, 'buy');
    expect(vpin.current()).toBeGreaterThan(baseline + 0.3);
  });

  it('stays low under balanced flow', () => {
    const vpin = new VpinEstimator({ bucketVolumeUnits: 100n, emaWindowBuckets: 5 });
    for (let i = 0; i < 100; i++) vpin.onTrade(10n, i % 2 === 0 ? 'buy' : 'sell');
    expect(vpin.current()).toBeLessThan(0.2);
    expect(vpin.bucketsSeen()).toBeGreaterThan(0);
  });
});
