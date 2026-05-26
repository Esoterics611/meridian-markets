import { MockHedgeVenue } from './mock-hedge-venue';
import { HedgePositionNotFoundError } from './hedge-venue.interface';

const ONE_USDC = 1_000_000n;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('MockHedgeVenue', () => {
  let nowMs = 1_700_000_000_000;
  const clock = () => new Date(nowMs);
  let venue: MockHedgeVenue;

  beforeEach(() => {
    nowMs = 1_700_000_000_000;
    // 2 bps/day ILS drift, 0ms latency
    venue = new MockHedgeVenue(2, 0, clock);
  });

  it('exposes a stable venueId', () => {
    expect(venue.venueId).toBe('mock');
  });

  it('opens a short and returns refs + parity entry price', async () => {
    const r = await venue.openShort({ notionalUnits: 1_000_000n * ONE_USDC, idempotencyKey: 'o1' });
    expect(r.externalRef).toMatch(/^mock-pos-\d+$/);
    expect(r.filledNotionalUnits).toBe(1_000_000n * ONE_USDC);
    expect(r.entryPriceMicros).toBe(1_000_000n);
  });

  it('rejects zero or negative notional', async () => {
    await expect(venue.openShort({ notionalUnits: 0n, idempotencyKey: 'z' })).rejects.toBeInstanceOf(Error);
    await expect(venue.openShort({ notionalUnits: -1n, idempotencyKey: 'n' })).rejects.toBeInstanceOf(Error);
  });

  it('replays the same open idempotency key (no new position)', async () => {
    const a = await venue.openShort({ notionalUnits: 100n * ONE_USDC, idempotencyKey: 'rep' });
    const b = await venue.openShort({ notionalUnits: 100n * ONE_USDC, idempotencyKey: 'rep' });
    expect(a.externalRef).toBe(b.externalRef);
  });

  it('issues distinct position refs across opens', async () => {
    const a = await venue.openShort({ notionalUnits: ONE_USDC, idempotencyKey: 'a' });
    const b = await venue.openShort({ notionalUnits: ONE_USDC, idempotencyKey: 'b' });
    expect(a.externalRef).not.toBe(b.externalRef);
  });

  it('closes a known position with non-zero pnl after drift elapses', async () => {
    const opened = await venue.openShort({ notionalUnits: 1_000_000n * ONE_USDC, idempotencyKey: 'o1' });
    nowMs += 30 * DAY_MS; // 60 bps cumulative drift (2 bps/day × 30 days)
    const closed = await venue.closeShort({ positionRef: opened.externalRef, idempotencyKey: 'c1' });
    expect(closed.pnlUnits).toBeGreaterThan(0n); // short profits when ILS weakens
    // After close the position is gone.
    await expect(venue.fetchPosition(opened.externalRef)).rejects.toBeInstanceOf(HedgePositionNotFoundError);
  });

  it('close on unknown ref throws HedgePositionNotFoundError', async () => {
    await expect(
      venue.closeShort({ positionRef: 'no-such-ref', idempotencyKey: 'c' }),
    ).rejects.toBeInstanceOf(HedgePositionNotFoundError);
  });

  it('fetchPosition computes mark drift deterministically given a fixed clock', async () => {
    const o1 = await venue.openShort({ notionalUnits: 1_000_000n * ONE_USDC, idempotencyKey: 'o1' });
    const v2 = new MockHedgeVenue(2, 0, clock);
    const o2 = await v2.openShort({ notionalUnits: 1_000_000n * ONE_USDC, idempotencyKey: 'o1' });
    nowMs += 10 * DAY_MS;
    const p1 = await venue.fetchPosition(o1.externalRef);
    const p2 = await v2.fetchPosition(o2.externalRef);
    expect(p1.markPriceMicros).toBe(p2.markPriceMicros);
    expect(p1.unrealizedPnlUnits).toBe(p2.unrealizedPnlUnits);
  });

  it('fetchPosition on unknown ref throws', async () => {
    await expect(venue.fetchPosition('nope')).rejects.toBeInstanceOf(HedgePositionNotFoundError);
  });

  it('fetchHealth returns healthy with funding bps', async () => {
    const h = await venue.fetchHealth();
    expect(h.healthy).toBe(true);
    expect(h.lastFundingBps).toBe(10);
  });
});
