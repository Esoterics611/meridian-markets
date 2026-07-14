/**
 * NATS integration spec — requires the docker-compose `nats` broker on :4222.
 * Soft-skips (green, with a console note) when the broker is unreachable, matching the
 * repo's describeIfDb convention. CI must start NATS for these assertions to fire.
 */
import { NatsBus } from './nats-bus';
import { BusMessage } from './bus.interface';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('NatsBus (integration)', () => {
  let bus: NatsBus | null = null;

  beforeAll(async () => {
    try {
      bus = await NatsBus.connect(); // fast-fail timeout inside connect()
    } catch {
      bus = null;
      console.warn('NATS not reachable on :4222 — NatsBus int-spec soft-skipped');
    }
  });

  afterAll(async () => {
    await bus?.close();
  });

  it('round-trips envelopes with per-topic seq over a wildcard subscription', async () => {
    if (!bus) return;
    const got: BusMessage[] = [];
    const unsub = bus.subscribe('itest.>', (m) => got.push(m));
    await wait(100); // subscription propagation
    await bus.publish('itest.a', { v: 1 });
    await bus.publish('itest.b', { v: 2 }, 777);
    await bus.publish('itest.a', { v: 3 });
    await wait(200);
    unsub();
    expect(got.map((m) => [m.topic, m.seq])).toEqual([
      ['itest.a', 1],
      ['itest.b', 1],
      ['itest.a', 2],
    ]);
    expect(got[1].tsVenue).toBe(777);
    expect(got[0].payload).toEqual({ v: 1 });
  });
});
