import { LookAheadBiasError, wrapWithLookAheadGuard } from './look-ahead';
import { BarContext, IStrategy } from '../backtest/strategy.interface';
import { Bar } from '../backtest/bar';

function bars(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol: 'A', timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)),
    open: i, high: i, low: i, close: i, volume: 1,
  }));
}

function makeCtx(index: number, n = 10): BarContext {
  const all = bars(n);
  return { a: all[index], b: all[index], index, historyA: all, historyB: all };
}

const honest: IStrategy = {
  onBar: (ctx) => {
    // Only reads historyA[ctx.index] — the current bar.
    const _ = ctx.historyA[ctx.index]?.close;
    void _;
    return [];
  },
};

const cheats: IStrategy = {
  onBar: (ctx) => {
    // Reads one bar in the future.
    const _ = ctx.historyA[ctx.index + 1]?.close;
    void _;
    return [];
  },
};

describe('wrapWithLookAheadGuard', () => {
  it('lets an honest strategy through with no error', () => {
    const wrapped = wrapWithLookAheadGuard(honest);
    expect(() => wrapped.onBar(makeCtx(3))).not.toThrow();
  });

  it('throws LookAheadBiasError when the strategy peeks ahead', () => {
    const wrapped = wrapWithLookAheadGuard(cheats);
    expect(() => wrapped.onBar(makeCtx(3))).toThrow(LookAheadBiasError);
  });

  it('error message names the offending field and indices', () => {
    const wrapped = wrapWithLookAheadGuard(cheats);
    try {
      wrapped.onBar(makeCtx(3));
      fail('expected throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/historyA\[4\]/);
      expect((e as Error).message).toMatch(/current bar index is 3/);
    }
  });

  it('preserves the strategy return value when honest', () => {
    const returning: IStrategy = {
      onBar: () => [{ symbol: 'A', side: 'BUY', notionalUnits: 100n, reason: 'OPEN_LONG' }],
    };
    const out = wrapWithLookAheadGuard(returning).onBar(makeCtx(2));
    expect(out.length).toBe(1);
  });

  it('reading current and past bars is allowed', () => {
    const reader: IStrategy = {
      onBar: (ctx) => {
        for (let i = 0; i <= ctx.index; i++) void ctx.historyB[i].close;
        return [];
      },
    };
    expect(() => wrapWithLookAheadGuard(reader).onBar(makeCtx(4))).not.toThrow();
  });

  it('detects peeking on historyB independently of historyA', () => {
    const peekB: IStrategy = {
      onBar: (ctx) => {
        void ctx.historyB[ctx.index + 2]?.close;
        return [];
      },
    };
    expect(() => wrapWithLookAheadGuard(peekB).onBar(makeCtx(1))).toThrow(/historyB\[3\]/);
  });

  it('non-numeric property reads (e.g. .length) pass through without raising', () => {
    const reader: IStrategy = {
      onBar: (ctx) => {
        void ctx.historyA.length;
        return [];
      },
    };
    expect(() => wrapWithLookAheadGuard(reader).onBar(makeCtx(5))).not.toThrow();
  });

  it('passing ctx.index = 0 still catches peek at index 1', () => {
    expect(() => wrapWithLookAheadGuard(cheats).onBar(makeCtx(0))).toThrow(LookAheadBiasError);
  });
});
