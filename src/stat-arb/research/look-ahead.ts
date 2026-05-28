import { BarContext, IStrategy, DesiredOrder } from '../backtest/strategy.interface';

// LookAheadGuard — wraps a strategy in a Proxy that throws if onBar() reads
// historyA[i] or historyB[i] for any i > ctx.index. That's the classical
// look-ahead bias: peeking at a future bar inside a "live" callback.
//
// Lighter-weight than full property-based testing — every backtest can opt
// in. We use it in research tests to assert determinism of the strategy
// callbacks before promoting them to walk-forward + sweep evaluation.

export class LookAheadBiasError extends Error {
  constructor(field: 'historyA' | 'historyB', readIndex: number, currentIndex: number) {
    super(`look-ahead bias: strategy read ${field}[${readIndex}] when current bar index is ${currentIndex}`);
    this.name = 'LookAheadBiasError';
  }
}

export function wrapWithLookAheadGuard(strategy: IStrategy): IStrategy {
  return {
    onBar(ctx: BarContext): DesiredOrder[] {
      const guard = (field: 'historyA' | 'historyB') =>
        new Proxy(ctx[field], {
          get(target, prop) {
            if (typeof prop === 'string' && /^\d+$/.test(prop)) {
              const idx = Number(prop);
              if (idx > ctx.index) throw new LookAheadBiasError(field, idx, ctx.index);
            }
            return Reflect.get(target, prop);
          },
        });
      const safeCtx: BarContext = {
        ...ctx,
        historyA: guard('historyA'),
        historyB: guard('historyB'),
      };
      return strategy.onBar(safeCtx);
    },
  };
}
