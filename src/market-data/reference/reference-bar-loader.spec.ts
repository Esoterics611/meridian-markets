import { Bar } from '../../stat-arb/backtest/bar';
import { IReferenceBarSource } from './reference-source.interface';
import { ReferenceSourceRegistry, makeScannerLoader, buildReferenceSources } from './reference-bar-loader';

function fakeSource(id: string, price: number): IReferenceBarSource {
  return {
    sourceId: id,
    label: id,
    sampleSymbol: 'X',
    klines: async (symbol) => [
      { symbol, timestamp: new Date(0), open: price, high: price, low: price, close: price, volume: 0 } as Bar,
    ],
  };
}

describe('ReferenceSourceRegistry', () => {
  it('lists and resolves sources by id', () => {
    const reg = new ReferenceSourceRegistry([fakeSource('pyth', 1.08), fakeSource('bit2c', 3.7)]);
    expect(reg.list().map((s) => s.sourceId).sort()).toEqual(['bit2c', 'pyth']);
    expect(reg.get('pyth')?.sourceId).toBe('pyth');
    expect(reg.get('nope')).toBeUndefined();
  });

  it('bars() returns [] for an unknown source and never throws', async () => {
    const throwing: IReferenceBarSource = {
      sourceId: 'boom', label: 'boom', sampleSymbol: 'X',
      klines: async () => { throw new Error('network'); },
    };
    const reg = new ReferenceSourceRegistry([throwing]);
    expect(await reg.bars('nope', 'X', '1m', 10)).toEqual([]);
    expect(await reg.bars('boom', 'X', '1m', 10)).toEqual([]); // swallowed
  });

  it('buildReferenceSources wires pyth + defillama + bit2c', () => {
    const ids = buildReferenceSources({}).map((s) => s.sourceId).sort();
    expect(ids).toEqual(['bit2c', 'defillama', 'pyth']);
  });
});

describe('makeScannerLoader', () => {
  it('routes binance/undefined to the binance loader and other sources to the registry', async () => {
    const reg = new ReferenceSourceRegistry([fakeSource('pyth', 1.08)]);
    const binance = async (sym: string): Promise<Bar[]> => [
      { symbol: sym, timestamp: new Date(0), open: 100, high: 100, low: 100, close: 100, volume: 0 },
    ];
    const load = makeScannerLoader(binance, reg, '1m', 240);

    expect((await load('BTC'))[0].close).toBe(100); // undefined source -> binance
    expect((await load('BTC', 'binance'))[0].close).toBe(100);
    expect((await load('EURUSD', 'pyth'))[0].close).toBe(1.08); // routed to reference
    expect(await load('EURUSD', 'unknown')).toEqual([]);
  });
});
