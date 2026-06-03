import { MmScreener, MmScreenPreset, MmScreenerConfig } from './mm-screener';
import { Bar } from '../../stat-arb/backtest/bar';

function calm(symbol: string): Bar[] {
  return Array.from({ length: 60 }, (_, i) => {
    const p = 1.0;
    return { symbol, timestamp: new Date(Date.UTC(2026, 0, 1) + i * 60_000), open: p, high: p * 1.0002, low: p * 0.9998, close: p, volume: 100 };
  });
}
function wild(symbol: string): Bar[] {
  let p = 100;
  return Array.from({ length: 60 }, (_, i) => {
    p = p * (1 + 0.02 * Math.sin(i));
    return { symbol, timestamp: new Date(Date.UTC(2026, 0, 1) + i * 60_000), open: p, high: p * 1.02, low: p * 0.98, close: p, volume: 100 };
  });
}

const data: Record<string, Bar[]> = { STABLE: calm('STABLE'), WILD: wild('WILD') };
const loader = async (s: string): Promise<Bar[]> => data[s] ?? [];
const presets: MmScreenPreset[] = [{ id: 't', label: 'T', assetClass: 'Test', symbols: ['STABLE', 'WILD'] }];
const cfg: MmScreenerConfig = { quoteHalfSpreadBps: 1, makerFeeBps: -1, barsPerDay: 1440, volWindowBars: 20, adverseCoef: 0.5, barsToLoad: 60 };

describe('MmScreener', () => {
  it('ranks the calm rebated stablecoin above the volatile major', async () => {
    const board = await new MmScreener(loader, presets, cfg).screen();
    expect(board.instrumentsScored).toBe(2);
    expect(board.instruments[0].symbol).toBe('STABLE');
    expect(board.instruments[0].attractive).toBe(true);
    const wildRow = board.instruments.find((i) => i.symbol === 'WILD')!;
    expect(wildRow.attractive).toBe(false);
    expect(board.attractive).toBe(1);
  });

  it('passes each preset’s source to the loader (DEX routes off-Binance)', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const srcLoader = async (s: string, source?: string): Promise<Bar[]> => {
      seen.push([s, source]);
      return data[s] ?? calm(s);
    };
    const srcPresets: MmScreenPreset[] = [
      { id: 'dex', label: 'DEX', assetClass: 'DEX', symbols: ['WETHUSDC'], source: 'geckoterminal' },
      { id: 'cex', label: 'CEX', assetClass: 'Stable', symbols: ['STABLE'] },
    ];
    await new MmScreener(srcLoader, srcPresets, cfg).screen();
    expect(seen).toEqual(
      expect.arrayContaining([
        ['WETHUSDC', 'geckoterminal'],
        ['STABLE', undefined],
      ]),
    );
  });

  it('dedups symbols across presets', async () => {
    const dup: MmScreenPreset[] = [
      { id: 'a', label: 'A', assetClass: 'X', symbols: ['STABLE'] },
      { id: 'b', label: 'B', assetClass: 'Y', symbols: ['STABLE', 'WILD'] },
    ];
    const board = await new MmScreener(loader, dup, cfg).screen();
    expect(board.instruments.filter((i) => i.symbol === 'STABLE')).toHaveLength(1);
    expect(board.instruments.find((i) => i.symbol === 'STABLE')!.presetId).toBe('a'); // first preset wins
  });
});
