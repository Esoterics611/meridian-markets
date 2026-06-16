import { RegimeSeries } from './regime-signals';
import { scoreRegimeBoard, bestPerSymbol, validatedSignalsPerSymbol, LoadedSeries } from './regime-board';

const H = 3_600_000;

/** A persistent up/down block series — momentum predicts forward return (validates). */
function trendingSeries(): RegimeSeries {
  const prices: number[] = [];
  let p = 100;
  for (let b = 0; b < 12; b++) {
    const up = b % 2 === 0;
    for (let k = 0; k < 40; k++) {
      p *= up ? 1.01 : 0.99;
      prices.push(p);
    }
  }
  return { prices, barTimesMs: prices.map((_, i) => i * H), funding: [] };
}

/** A deterministic random-walk series (seeded LCG) — non-zero momentum that does NOT
 *  predict forward return, so the gate must reject it. */
function chopSeries(): RegimeSeries {
  const prices: number[] = [];
  let p = 100;
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 480; i++) {
    p *= Math.exp((rand() - 0.5) * 0.02); // ±1% i.i.d. returns ⇒ no trend edge
    prices.push(p);
  }
  return { prices, barTimesMs: prices.map((_, i) => i * H), funding: [] };
}

const MOM_SPEC = [{ name: 'momentum(4h)', kind: 'momentum' as const, lookbackBars: 4 }];
const CFG = { fwdHours: [4], ivHours: 1, folds: 5, embargoFrac: 0.01 };

describe('scoreRegimeBoard / the gate', () => {
  it('validates momentum on a trending series and rejects it on chop', () => {
    const loaded: LoadedSeries[] = [
      { symbol: 'TREND', series: trendingSeries() },
      { symbol: 'CHOP', series: chopSeries() },
    ];
    const board = scoreRegimeBoard(loaded, MOM_SPEC, CFG);
    expect(board.trials).toBe(2); // 2 symbols × 1 spec × 1 horizon
    const trend = board.perTrial.find((t) => t.symbol === 'TREND')!;
    const chop = board.perTrial.find((t) => t.symbol === 'CHOP')!;
    expect(trend.verdict).toBe('VALIDATED');
    expect(trend.oosIc).toBeGreaterThan(0);
    expect(chop.verdict).not.toBe('VALIDATED');
  });

  it('bestPerSymbol marks only the validated symbol eligible, sorted by IC', () => {
    const board = scoreRegimeBoard(
      [
        { symbol: 'TREND', series: trendingSeries() },
        { symbol: 'CHOP', series: chopSeries() },
      ],
      MOM_SPEC,
      CFG,
    );
    const rows = bestPerSymbol(board);
    expect(rows).toHaveLength(2);
    expect(rows[0].symbol).toBe('TREND'); // higher IC first
    expect(rows.find((r) => r.symbol === 'TREND')!.eligible).toBe(true);
    expect(rows.find((r) => r.symbol === 'CHOP')!.eligible).toBe(false);
  });

  it('validatedSignalsPerSymbol exposes the constituent set the consensus votes over', () => {
    const board = scoreRegimeBoard([{ symbol: 'TREND', series: trendingSeries() }], MOM_SPEC, CFG);
    const v = validatedSignalsPerSymbol(board);
    expect(v.has('TREND')).toBe(true);
    expect(v.get('TREND')!.map((t) => t.spec.kind)).toEqual(['momentum']);
  });

  it('a symbol whose signals all fail produces no eligible set', () => {
    const board = scoreRegimeBoard([{ symbol: 'CHOP', series: chopSeries() }], MOM_SPEC, CFG);
    expect(validatedSignalsPerSymbol(board).has('CHOP')).toBe(false);
  });
});
