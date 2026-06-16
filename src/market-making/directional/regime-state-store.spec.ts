import { NullRegimeStateStore, reconcileResume, RegimeBookRecord } from './regime-state-store';

function rec(symbol: string): RegimeBookRecord {
  return {
    symbol,
    signal: 'momentum(24h)',
    ic: 0.2,
    entryMidMicros: '50000000000',
    entryMs: 1_000,
    state: { book: { inventoryUnits: '500000', avgCostMicros: '50000000000', realisedUnits: '0', feesUnits: '6190', fillCount: 1 }, fundingAccruedUnits: '0', lastMs: 1_000 },
  };
}

describe('reconcileResume (boot reconciliation)', () => {
  it('resumes a symbol that is eligible today AND has a persisted open record', () => {
    const plan = reconcileResume(['BTC', 'ETH'], [rec('BTC')]);
    expect(plan.resume.map((r) => r.symbol)).toEqual(['BTC']);
    expect(plan.startFlat).toEqual(['ETH']); // eligible, no record ⇒ start flat
    expect(plan.orphaned).toEqual([]);
  });

  it('orphans a persisted book whose signal is NOT eligible today (the BNB lesson — never ride a stale view)', () => {
    const plan = reconcileResume(['BTC'], [rec('BTC'), rec('BNB')]);
    expect(plan.resume.map((r) => r.symbol)).toEqual(['BTC']);
    expect(plan.orphaned.map((r) => r.symbol)).toEqual(['BNB']);
    expect(plan.startFlat).toEqual([]);
  });

  it('is case-insensitive on symbol', () => {
    const plan = reconcileResume(['btc'], [rec('BTC')]);
    expect(plan.resume.map((r) => r.symbol)).toEqual(['BTC']);
    expect(plan.orphaned).toEqual([]);
  });

  it('starts everything flat when there are no persisted records', () => {
    const plan = reconcileResume(['BTC', 'ETH'], []);
    expect(plan.startFlat).toEqual(['BTC', 'ETH']);
    expect(plan.resume).toEqual([]);
  });
});

describe('NullRegimeStateStore (the safe default)', () => {
  it('is disabled and every call is a harmless no-op', async () => {
    const s = new NullRegimeStateStore();
    expect(s.enabled).toBe(false);
    await expect(s.saveBook(rec('BTC'))).resolves.toBeUndefined();
    await expect(s.loadOpen()).resolves.toEqual([]);
    await expect(s.closeBook('BTC')).resolves.toBeUndefined();
    await expect(s.appendNav([])).resolves.toBeUndefined();
  });
});
