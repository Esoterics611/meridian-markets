import { BUS_SCHEMA_VERSION, BusMessage, topicMatches, TOPICS } from './bus.interface';
import { InProcBus } from './inproc-bus';

describe('topicMatches (NATS-compatible grammar)', () => {
  it('matches exact, * (one token), and trailing > (one-or-more)', () => {
    expect(topicMatches('md.mids.hyperliquid', 'md.mids.hyperliquid')).toBe(true);
    expect(topicMatches('md.book.hip4.*', 'md.book.hip4.831')).toBe(true);
    expect(topicMatches('md.book.hip4.*', 'md.book.hip4.831.extra')).toBe(false);
    expect(topicMatches('md.>', 'md.book.hip4.831')).toBe(true);
    expect(topicMatches('md.>', 'md')).toBe(false); // > needs ≥1 token
    expect(topicMatches('md.*.hyperliquid', 'md.mids.hyperliquid')).toBe(true);
    expect(topicMatches('px.>', 'md.mids.hyperliquid')).toBe(false);
  });
});

describe('InProcBus', () => {
  it('stamps monotonic per-topic seq and the schema version (bus laws #1/#3)', async () => {
    const bus = new InProcBus({ keepHistory: true });
    await bus.publish('a.one', { x: 1 });
    await bus.publish('a.two', { x: 2 });
    await bus.publish('a.one', { x: 3 }, 1234);
    const [m1, m2, m3] = bus.published;
    expect([m1.seq, m2.seq, m3.seq]).toEqual([1, 1, 2]); // per topic, not global
    expect(m3.tsVenue).toBe(1234);
    expect(m1.tsVenue).toBeNull();
    expect(m1.schemaVersion).toBe(BUS_SCHEMA_VERSION);
  });

  it('delivers on wildcard subscriptions and honors unsubscribe', async () => {
    const bus = new InProcBus();
    const got: string[] = [];
    const unsub = bus.subscribe('md.>', (m) => got.push(m.topic));
    await bus.publish(TOPICS.hlMids, {});
    await bus.publish('other.topic', {});
    unsub();
    await bus.publish(TOPICS.hlMids, {});
    expect(got).toEqual([TOPICS.hlMids]);
  });

  it("a consumer's exception never breaks the producer or other consumers", async () => {
    const bus = new InProcBus();
    const got: BusMessage[] = [];
    bus.subscribe('t', () => {
      throw new Error('bad consumer');
    });
    bus.subscribe('t', (m) => got.push(m));
    await expect(bus.publish('t', 1)).resolves.toBeUndefined();
    expect(got).toHaveLength(1);
  });
});
