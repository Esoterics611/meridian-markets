import { InProcBus } from '../../bus/inproc-bus';
import { TOPICS } from '../../bus/bus.interface';
import { DEFAULT_PLANT_MAX_AGES, PlantClient } from './plant-client';

describe('PlantClient', () => {
  const setup = () => {
    const bus = new InProcBus();
    // The bus stamps tsPlant from the wall clock — the injected clock must start there.
    let now = Date.now();
    const client = new PlantClient(bus, DEFAULT_PLANT_MAX_AGES, () => now);
    return { bus, client, tick: (ms: number) => (now += ms) };
  };

  it('serves the latest published snapshot per topic', async () => {
    const { bus, client } = setup();
    await bus.publish(TOPICS.hlMids, { BTC: 62_000 });
    await bus.publish(TOPICS.hlMids, { BTC: 62_100 });
    expect((await client.mids()).BTC).toBe(62_100);
    expect(await client.underlyingMid('btc')).toBe(62_100);
    await bus.publish(TOPICS.hip4Meta, [{ marketId: '831' }]);
    expect(await client.listPriceBinarySpecs()).toHaveLength(1);
    await bus.publish(TOPICS.deribitChain('BTC'), [{ strike: 1 }]);
    expect(await client.optionChain('btc')).toHaveLength(1);
  });

  it('throws fail-closed on missing and on stale topics (bus law #2)', async () => {
    const { bus, client, tick } = setup();
    await expect(client.mids()).rejects.toThrow(/no data yet/);
    await bus.publish(TOPICS.hlMids, { BTC: 1 });
    tick(DEFAULT_PLANT_MAX_AGES.midsMs + 1_000); // margin over publish-stamp skew
    await expect(client.mids()).rejects.toThrow(/stale/);
  });

  it('bookDepth slices to the requested depth and refuses the NO side (v0)', async () => {
    const { bus, client } = setup();
    await bus.publish(TOPICS.hip4Book('831'), {
      marketId: '831',
      bids: [
        [0.48, 100],
        [0.47, 50],
        [0.46, 10],
      ],
      asks: [[0.49, 5]],
      serverTimeMs: 9,
    });
    const b = await client.bookDepth('831', 0, 2);
    expect(b.bids).toHaveLength(2);
    expect(b.serverTimeMs).toBe(9);
    await expect(client.bookDepth('831', 1, 2)).rejects.toThrow(/YES side only/);
  });

  it('close() unsubscribes — later publishes are not observed', async () => {
    const { bus, client } = setup();
    client.close();
    await bus.publish(TOPICS.hlMids, { BTC: 1 });
    await expect(client.mids()).rejects.toThrow(/no data yet/);
  });
});
