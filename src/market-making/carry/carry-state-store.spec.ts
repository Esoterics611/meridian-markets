import { CarryBookRecord, NullCarryStateStore, reconcileCarryResume } from './carry-state-store';
import { FundingCarryBook } from './funding-carry-book';

// Pure unit tests — no network, no DB.

function record(symbol: string, direction: 'SHORT_PERP' | 'LONG_PERP' = 'SHORT_PERP'): CarryBookRecord {
  const book = new FundingCarryBook({
    symbol,
    direction,
    notionalUsd: 50_000,
    spotFeeBps: 4.5,
    perpFeeBps: 2.5,
    fundingPeriodMs: 3_600_000,
  });
  book.open(0, 3_000_000_000n, 2_998_800_000n);
  return { symbol, direction, gateAnnualizedPct: 8.1, entryMs: 0, state: book.serializeState() };
}

describe('reconcileCarryResume', () => {
  it('resumes a persisted OPEN pair that is still gated in the same direction', () => {
    const plan = reconcileCarryResume([{ symbol: 'ETH', direction: 'SHORT_PERP' }], [record('ETH')]);
    expect(plan.resume.map((r) => r.symbol)).toEqual(['ETH']);
    expect(plan.startFlat).toEqual([]);
    expect(plan.orphaned).toEqual([]);
  });

  it('starts flat when gated with no persisted record', () => {
    const plan = reconcileCarryResume([{ symbol: 'ETH', direction: 'SHORT_PERP' }], []);
    expect(plan.resume).toEqual([]);
    expect(plan.startFlat).toEqual(['ETH']);
  });

  it('orphans a persisted pair that FAILS today gate — the #72 rule: never ride a de-validated carry', () => {
    const plan = reconcileCarryResume([{ symbol: 'BTC', direction: 'SHORT_PERP' }], [record('BNB')]);
    expect(plan.orphaned.map((r) => r.symbol)).toEqual(['BNB']);
    expect(plan.startFlat).toEqual(['BTC']);
  });

  it('orphans AND reopens when the gated direction flipped across the restart', () => {
    const plan = reconcileCarryResume([{ symbol: 'XMR', direction: 'LONG_PERP' }], [record('XMR', 'SHORT_PERP')]);
    expect(plan.orphaned.map((r) => r.symbol)).toEqual(['XMR']); // close the stale side…
    expect(plan.startFlat).toEqual(['XMR']); // …then open the newly-gated side
    expect(plan.resume).toEqual([]);
  });

  it('is case-insensitive on symbols', () => {
    const plan = reconcileCarryResume([{ symbol: 'eth', direction: 'SHORT_PERP' }], [record('ETH')]);
    expect(plan.resume).toHaveLength(1);
    expect(plan.orphaned).toEqual([]);
  });
});

describe('NullCarryStateStore', () => {
  it('is disabled and every call is a harmless no-op', async () => {
    const store = new NullCarryStateStore();
    expect(store.enabled).toBe(false);
    await expect(store.saveBook(record('ETH'))).resolves.toBeUndefined();
    await expect(store.loadOpen()).resolves.toEqual([]);
    await expect(store.closeBook('ETH')).resolves.toBeUndefined();
    await expect(store.appendNav([])).resolves.toBeUndefined();
  });
});
