import { L2PollDriver, PollScheduler } from './l2-poll-driver';
import { LiveTick } from './l2-fill-engine-types';
import { IL2BookSource, ITradeStream, L2Snapshot, AggressorFlow } from '../../market-data/reference/reference-source.interface';

// L2PollDriver spec — pure unit: a fake L2 source + fake trade stream + an INJECTED
// scheduler so the loop runs with no real timers and no network, fully deterministic.
// Under test: parallel per-symbol delivery, best-effort error isolation (a failed poll
// skips that symbol's tick, never throws), no-pile-up when a cycle is slow, real flow
// drain when a trade stream is wired, and clean start/stop with no leaked timers.

const px = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
const u = (n: number): bigint => BigInt(Math.round(n * 1_000_000));

function snap(symbol: string, tMs: number): L2Snapshot {
  return { symbol, ts: new Date(tMs), bids: [{ priceMicros: px(99), sizeUnits: u(10), orderCount: 1 }], asks: [{ priceMicros: px(101), sizeUnits: u(10), orderCount: 1 }] };
}

/** Flush the microtask + immediate queues so an async cycle kicked off by a void call settles. */
const flushPromises = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A fake L2 source: per-symbol behaviour can be a snapshot or a thrown error. */
class FakeL2Source implements IL2BookSource {
  calls: string[] = [];
  constructor(private readonly behaviour: (symbol: string) => Promise<L2Snapshot>) {}
  async l2Snapshot(symbol: string): Promise<L2Snapshot> {
    this.calls.push(symbol);
    return this.behaviour(symbol);
  }
}

/** A fake trade stream returning canned aggressor flow per symbol. */
class FakeTradeStream implements ITradeStream {
  closed = false;
  constructor(private readonly flowFor: (symbol: string) => AggressorFlow) {}
  drain(symbol: string): AggressorFlow {
    return this.flowFor(symbol);
  }
  close(): void {
    this.closed = true;
  }
}

/** A scheduler that captures the interval fn instead of arming a real timer; `now()` is steppable. */
class FakeScheduler implements PollScheduler {
  private fn: (() => void) | null = null;
  private nowMs = 0;
  setInterval(fn: () => void): unknown {
    this.fn = fn;
    return Symbol('handle');
  }
  clearInterval(): void {
    this.fn = null;
  }
  now(): number {
    return this.nowMs;
  }
  setNow(ms: number): void {
    this.nowMs = ms;
  }
  /** Is a timer currently armed? (proves start/stop wires/unwires the loop). */
  armed(): boolean {
    return this.fn !== null;
  }
  /** Fire the captured interval fn once (one poll cycle). */
  fire(): void {
    this.fn?.();
  }
}

describe('L2PollDriver — fast L2 poll loop', () => {
  it('delivers a fresh snapshot to the sink for every symbol on a cycle', async () => {
    const sched = new FakeScheduler();
    const src = new FakeL2Source(async (s) => snap(s, 1000));
    const sink = jest.fn<void, [string, LiveTick]>();
    const driver = new L2PollDriver({ source: src, symbols: ['BTC', 'ETH'], pollIntervalMs: 500, sink, scheduler: sched });

    await driver.pollOnce();

    expect(sink).toHaveBeenCalledTimes(2);
    const symbols = sink.mock.calls.map((c) => c[0]).sort();
    expect(symbols).toEqual(['BTC', 'ETH']);
    // Each tick carries the source snapshot; no flow when no trade stream is wired.
    expect(sink.mock.calls[0][1].snapshot.symbol).toBeDefined();
    expect(sink.mock.calls[0][1].flow).toBeUndefined();
    expect(driver.stats().snapshotsDelivered).toBe(2);
  });

  it('is best-effort: a thrown poll for one symbol skips that tick but never throws or blocks the others', async () => {
    const sched = new FakeScheduler();
    const src = new FakeL2Source(async (s) => {
      if (s === 'ETH') throw new Error('boom');
      return snap(s, 1000);
    });
    const sink = jest.fn<void, [string, LiveTick]>();
    const driver = new L2PollDriver({ source: src, symbols: ['BTC', 'ETH'], pollIntervalMs: 500, sink, scheduler: sched });

    await expect(driver.pollOnce()).resolves.toBeUndefined(); // never throws
    expect(sink).toHaveBeenCalledTimes(1); // only BTC delivered
    expect(sink.mock.calls[0][0]).toBe('BTC');
    expect(driver.stats().failedPolls).toBe(1);
  });

  it('drains real aggressor flow from the trade stream when one is wired', async () => {
    const sched = new FakeScheduler();
    const src = new FakeL2Source(async (s) => snap(s, 1000));
    const stream = new FakeTradeStream((s) => ({
      aggressiveBuyUnits: s === 'BTC' ? u(3) : 0n,
      aggressiveSellUnits: s === 'BTC' ? u(2) : 0n,
      tradeCount: s === 'BTC' ? 5 : 0, // ETH saw no prints ⇒ depth-only tick
      highMicros: px(101),
      lowMicros: px(99),
    }));
    const sink = jest.fn<void, [string, LiveTick]>();
    const driver = new L2PollDriver({ source: src, symbols: ['BTC', 'ETH'], pollIntervalMs: 500, sink, tradeStream: stream, scheduler: sched });

    await driver.pollOnce();

    const btc = sink.mock.calls.find((c) => c[0] === 'BTC')![1];
    const eth = sink.mock.calls.find((c) => c[0] === 'ETH')![1];
    expect(btc.flow).toBeDefined();
    expect(btc.flow!.aggressiveBuyUnits).toBe(u(3));
    expect(btc.flow!.aggressiveSellUnits).toBe(u(2));
    expect(eth.flow).toBeUndefined(); // tradeCount 0 ⇒ no flow attached (depth-only)
  });

  it('skips a cycle that begins while a prior cycle is still in flight (no pile-up)', async () => {
    const sched = new FakeScheduler();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const src = new FakeL2Source(async (s) => {
      calls++;
      await gate; // hold the first cycle open
      return snap(s, 1000);
    });
    const sink = jest.fn<void, [string, LiveTick]>();
    const driver = new L2PollDriver({ source: src, symbols: ['BTC'], pollIntervalMs: 500, sink, scheduler: sched });

    const first = driver.pollOnce(); // starts, blocks on the gate
    await Promise.resolve();
    await driver.pollOnce(); // should early-return (a cycle is in flight) — no new fetch
    expect(calls).toBe(1);
    release!();
    await first;
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('start arms the loop and stop releases it (no leaked timers); start is idempotent', () => {
    const sched = new FakeScheduler();
    const src = new FakeL2Source(async (s) => snap(s, 1000));
    const driver = new L2PollDriver({ source: src, symbols: ['BTC'], pollIntervalMs: 500, sink: () => undefined, scheduler: sched });

    expect(driver.isRunning()).toBe(false);
    driver.start();
    expect(driver.isRunning()).toBe(true);
    expect(sched.armed()).toBe(true);
    driver.start(); // idempotent — still one timer
    expect(driver.isRunning()).toBe(true);
    driver.stop();
    expect(driver.isRunning()).toBe(false);
    expect(sched.armed()).toBe(false);
    driver.stop(); // idempotent
    expect(driver.isRunning()).toBe(false);
  });

  it('the scheduled interval fn runs a poll cycle (the timer is wired to pollOnce)', async () => {
    const sched = new FakeScheduler();
    const src = new FakeL2Source(async (s) => snap(s, 1000));
    const sink = jest.fn<void, [string, LiveTick]>();
    const driver = new L2PollDriver({ source: src, symbols: ['BTC'], pollIntervalMs: 500, sink, scheduler: sched });

    driver.start();
    sched.fire(); // simulate the interval firing → void this.pollOnce()
    await flushPromises(); // let the async cycle settle (fetch → drain → sink)
    expect(sink).toHaveBeenCalled();
    driver.stop();
  });
});
