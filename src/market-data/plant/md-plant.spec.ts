import { InProcBus } from '../../bus/inproc-bus';
import { TOPICS } from '../../bus/bus.interface';
import { DEFAULT_MD_PLANT, MdPlant, OptionChainFeed, OutcomeFeed } from './md-plant';

const spec = (marketId: string, underlying: string, expiryMs: number) => ({
  marketId,
  underlying,
  targetPrice: 100,
  expiryMs,
  period: '1d',
});

function feeds(over: Partial<OutcomeFeed & OptionChainFeed> = {}) {
  const outcome: OutcomeFeed = {
    listPriceBinarySpecs: async () => [
      spec('831', 'BTC', 10 * 3_600_000),
      spec('833', 'SOL', 10 * 3_600_000), // unpriceable — filtered
      spec('830', 'ETH', 1_000), // expired at t0 — filtered
    ],
    mids: async () => ({ BTC: 62_000, '#8310': 0.48 }),
    bookDepth: async (marketId) => ({
      bids: [[0.48, 100]] as [number, number][],
      asks: [[0.49, 50]] as [number, number][],
      serverTimeMs: 777,
    }),
    ...over,
  };
  const chain: OptionChainFeed = {
    optionChain: over.optionChain ?? (async () => []),
  };
  return { outcome, chain };
}

const T0 = 3_600_000; // clear of every -Infinity/expiry edge

describe('MdPlant', () => {
  it('publishes meta/chains/mids/books on their own cadences', async () => {
    const bus = new InProcBus({ keepHistory: true });
    const plant = new MdPlant(bus, feeds(), { ...DEFAULT_MD_PLANT, priceableUnderlyings: ['BTC'] });
    await plant.cycle(T0);
    let topics = bus.published.map((m) => m.topic);
    expect(topics).toEqual([
      TOPICS.hip4Meta,
      TOPICS.deribitChain('BTC'),
      TOPICS.hlMids,
      TOPICS.hip4Book('831'),
    ]);
    // one second later: only mids + books are due again
    await plant.cycle(T0 + 1_000);
    topics = bus.published.slice(4).map((m) => m.topic);
    expect(topics).toEqual([TOPICS.hlMids, TOPICS.hip4Book('831')]);
    expect(plant.stats.errors).toBe(0);
  });

  it('meta filters to priceable, unexpired markets (SOL and the expired ETH never publish books)', async () => {
    const bus = new InProcBus({ keepHistory: true });
    const plant = new MdPlant(bus, feeds(), DEFAULT_MD_PLANT);
    await plant.cycle(T0);
    const meta = bus.published.find((m) => m.topic === TOPICS.hip4Meta)!;
    expect((meta.payload as { marketId: string }[]).map((s) => s.marketId)).toEqual(['831']);
    const bookTopics = bus.published.filter((m) => m.topic.startsWith('md.book.'));
    expect(bookTopics).toHaveLength(1);
  });

  it('stamps tsVenue on book messages from the venue book timestamp', async () => {
    const bus = new InProcBus({ keepHistory: true });
    const plant = new MdPlant(bus, feeds(), { ...DEFAULT_MD_PLANT, priceableUnderlyings: ['BTC'] });
    await plant.cycle(T0);
    const book = bus.published.find((m) => m.topic === TOPICS.hip4Book('831'))!;
    expect(book.tsVenue).toBe(777);
  });

  it('re-publishes cached meta/chain snapshots for late joiners without re-fetching', async () => {
    const bus = new InProcBus({ keepHistory: true });
    let metaFetches = 0;
    const f = feeds({
      listPriceBinarySpecs: async () => {
        metaFetches++;
        return [spec('831', 'BTC', 10 * 3_600_000)];
      },
    });
    const plant = new MdPlant(bus, f, {
      ...DEFAULT_MD_PLANT,
      priceableUnderlyings: ['BTC'],
      snapshotRepubMs: 5_000,
    });
    await plant.cycle(T0); // fetch + publish
    await plant.cycle(T0 + 5_000); // repub window: cached meta+chain again, NO fetch
    const metaMsgs = bus.published.filter((m) => m.topic === TOPICS.hip4Meta);
    const chainMsgs = bus.published.filter((m) => m.topic === TOPICS.deribitChain('BTC'));
    expect(metaMsgs).toHaveLength(2);
    expect(chainMsgs).toHaveLength(2);
    expect(metaMsgs[1].payload).toEqual(metaMsgs[0].payload);
    expect(metaMsgs[1].seq).toBe(2);
    expect(metaFetches).toBe(1); // the re-publish cost zero venue calls
  });

  it('one feed failing does not stop the other topics (partial data beats no data)', async () => {
    const bus = new InProcBus({ keepHistory: true });
    const bad = feeds({
      mids: async () => {
        throw new Error('venue 503');
      },
    });
    const plant = new MdPlant(bus, bad, { ...DEFAULT_MD_PLANT, priceableUnderlyings: ['BTC'] });
    await plant.cycle(T0);
    const topics = bus.published.map((m) => m.topic);
    expect(topics).toContain(TOPICS.hip4Meta);
    expect(topics).toContain(TOPICS.hip4Book('831'));
    expect(topics).not.toContain(TOPICS.hlMids);
    expect(plant.stats.errors).toBe(1);
    expect(plant.stats.lastError).toMatch(/mids: venue 503/);
  });
});
