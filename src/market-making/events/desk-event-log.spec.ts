import { DeskEventLog } from './desk-event-log';
import { lifecycleEvent } from './desk-event';

function ev(book: string) {
  return lifecycleEvent({ ts: Date.now(), kind: 'launch', book, message: `launched ${book}` });
}

describe('DeskEventLog — the live business-event tape', () => {
  it('assigns a monotonic seq and serves events oldest-first', () => {
    const log = new DeskEventLog(10);
    log.emit(ev('BTC'));
    log.emit(ev('ETH'));
    const all = log.recent();
    expect(all.map((e) => e.seq)).toEqual([1, 2]);
    expect(all.map((e) => e.book)).toEqual(['BTC', 'ETH']);
    expect(log.lastSeq()).toBe(2);
  });

  it('long-poll cursor: sinceSeq returns only newer events', () => {
    const log = new DeskEventLog();
    log.emit(ev('A'));
    log.emit(ev('B'));
    const cursor = log.lastSeq();
    log.emit(ev('C'));
    const fresh = log.recent({ sinceSeq: cursor });
    expect(fresh.map((e) => e.book)).toEqual(['C']);
  });

  it('filters by book and caps with limit (keeping the newest)', () => {
    const log = new DeskEventLog();
    log.emit(ev('BTC'));
    log.emit(ev('ETH'));
    log.emit(ev('BTC'));
    expect(log.recent({ book: 'BTC' }).map((e) => e.seq)).toEqual([1, 3]);
    expect(log.recent({ limit: 2 }).map((e) => e.seq)).toEqual([2, 3]);
  });

  it('is a bounded ring buffer — old events drop, seq keeps climbing', () => {
    const log = new DeskEventLog(3);
    for (let i = 0; i < 5; i++) log.emit(ev(`S${i}`));
    const all = log.recent();
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.seq)).toEqual([3, 4, 5]); // 1 + 2 evicted
    expect(log.lastSeq()).toBe(5);
  });

  // F0 (PART V observability req #8): with a persist sink wired, every event — including
  // ones the ring buffer later evicts — is enqueued for the durable mm_desk_event tape.
  it('enqueues every event on the persist sink, with its assigned seq', () => {
    const persisted: Array<{ seq: number; book?: string }> = [];
    const log = new DeskEventLog(2, { enqueue: (e) => persisted.push({ seq: e.seq, book: e.book }) });
    for (let i = 0; i < 4; i++) log.emit(ev(`S${i}`));
    expect(persisted.map((e) => e.seq)).toEqual([1, 2, 3, 4]); // none lost to ring eviction
    expect(log.recent()).toHaveLength(2);
  });
});
