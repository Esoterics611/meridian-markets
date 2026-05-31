import { MmStrategyRegistry, mmStrategyRegistry } from './mm-strategy-registry';

const opts = { quoteSizeUnits: 1_000_000n, minHalfSpreadBps: 1, maxHalfSpreadBps: 200, maxInventoryLots: 8 };

describe('MmStrategyRegistry', () => {
  it('catalogues the three quoter families as live-capable', () => {
    const ids = mmStrategyRegistry.liveCapable().map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['mm-symmetric', 'mm-avellaneda-stoikov', 'mm-glft']));
  });

  it('builds a quoter whose familyId matches the catalogue family', () => {
    expect(mmStrategyRegistry.build('mm-symmetric', opts).familyId).toBe('symmetric');
    expect(mmStrategyRegistry.build('mm-avellaneda-stoikov', opts).familyId).toBe('avellaneda-stoikov');
    expect(mmStrategyRegistry.build('mm-glft', opts).familyId).toBe('glft');
  });

  it('applies per-launch param overrides', () => {
    const q = mmStrategyRegistry.build('mm-avellaneda-stoikov', { ...opts, params: { gamma: 0.01 } });
    expect(q.familyId).toBe('avellaneda-stoikov'); // built without throwing
  });

  it('throws on an unknown id and rejects duplicate registration', () => {
    expect(() => mmStrategyRegistry.get('nope')).toThrow(/unknown/);
    const r = new MmStrategyRegistry();
    expect(() => r.register(r.all()[0])).toThrow(/duplicate/);
  });
});
