import {
  ascending,
  buildMarketChartSpec,
  buildNavChartSpec,
  buildPairChartSpec,
  CHART_COLORS,
  ChartPoint,
  drawdownSeries,
  indexTo100,
  NavPointLike,
  snapToSeries,
} from './chart-spec';
import type { ChartSeries } from './chart-spec';

/** Typed accessor: the union data field as line points (the nav/pair builders emit points). */
const pts = (s: ChartSeries) => s.data as ChartPoint[];

const navPoint = (sec: number, equity: number, over: Partial<Record<keyof Omit<NavPointLike, 'asOf'>, bigint>> = {}): NavPointLike => ({
  asOf: new Date(sec * 1000),
  equityUnits: BigInt(Math.round(equity * 1e6)),
  realisedPnlUnits: over.realisedPnlUnits ?? 0n,
  unrealisedPnlUnits: over.unrealisedPnlUnits ?? 0n,
  feesUnits: over.feesUnits ?? 0n,
  fundingUnits: over.fundingUnits ?? 0n,
});

describe('chart-spec helpers', () => {
  it('ascending() sorts, dedupes on time (last wins), and drops non-finite points', () => {
    const out = ascending([
      { time: 20, value: 2 },
      { time: 10, value: 1 },
      { time: 20, value: 3 },
      { time: 30, value: NaN },
    ]);
    expect(out).toEqual([
      { time: 10, value: 1 },
      { time: 20, value: 3 },
    ]);
  });

  it('snapToSeries() picks the nearest series time; null on empty', () => {
    expect(snapToSeries([10, 20, 30], 24)).toBe(20);
    expect(snapToSeries([10, 20, 30], 26)).toBe(30);
    expect(snapToSeries([], 26)).toBeNull();
  });

  it('drawdownSeries() computes peak-to-now percent (positive = down)', () => {
    const dd = drawdownSeries([
      { time: 1, value: 100 },
      { time: 2, value: 110 },
      { time: 3, value: 99 },
    ]);
    expect(dd[0].value).toBe(0);
    expect(dd[1].value).toBe(0);
    expect(dd[2].value).toBeCloseTo(10, 6); // 110 → 99 is a 10% drawdown
  });

  it('indexTo100() rebases each leg to 100 at its first point', () => {
    const out = indexTo100([
      { time: 1, value: 50 },
      { time: 2, value: 55 },
    ]);
    expect(out[0].value).toBe(100);
    expect(out[1].value).toBeCloseTo(110);
  });
});

describe('buildNavChartSpec', () => {
  it('refuses honestly with fewer than 2 points', () => {
    const out = buildNavChartSpec({ title: 't', points: [navPoint(1, 100)], ddBudgetPct: 2 });
    expect(out.enabled).toBe(false);
    if (!out.enabled) expect(out.reason).toContain('MM_PERSIST');
  });

  it('serves equity in dollars, a drawdown panel with the budget line, and the four components', () => {
    const out = buildNavChartSpec({
      title: 'BTC book',
      points: [
        navPoint(60, 100, { realisedPnlUnits: 1_000_000n, feesUnits: 500_000n }),
        navPoint(120, 110, { realisedPnlUnits: 2_000_000n, feesUnits: 1_000_000n }),
        navPoint(180, 99, { realisedPnlUnits: 3_000_000n, feesUnits: 1_500_000n }),
      ],
      ddBudgetPct: 2,
    });
    expect(out.enabled).toBe(true);
    if (!out.enabled) return;
    const [equityPanel, ddPanel, compPanel] = out.panels;
    expect(pts(equityPanel.series[0]).map((p) => p.value)).toEqual([100, 110, 99]);
    expect(pts(equityPanel.series[0]).map((p) => p.time)).toEqual([60, 120, 180]);
    const ddLine = ddPanel.series[0];
    expect(pts(ddLine)[2].value).toBeCloseTo(10, 6);
    expect(ddLine.priceLines).toEqual([{ value: 2, color: CHART_COLORS.warn, title: 'budget', dashed: true }]);
    expect(compPanel.series.map((s) => s.name)).toEqual(['realised', 'inv MTM', 'fees (contrib)', 'funding']);
    // fees plotted as their CONTRIBUTION to net (−fees): a cost sinks.
    const fees = compPanel.series[2];
    expect(pts(fees).map((p) => p.value)).toEqual([-0.5, -1, -1.5]);
    const realised = compPanel.series[0];
    expect(pts(realised).map((p) => p.value)).toEqual([1, 2, 3]);
  });

  it('marks fills on the equity curve: BUY up-green below, SELL down-red above, exits carry realised P&L', () => {
    const out = buildNavChartSpec({
      title: 't',
      points: [navPoint(60, 100), navPoint(120, 101)],
      ddBudgetPct: 2,
      fills: [
        { ts: 59_000, side: 'BUY', action: 'open' },
        { ts: 121_000, side: 'SELL', action: 'close', realisedDeltaUnits: '2500000' },
      ],
    });
    expect(out.enabled).toBe(true);
    if (!out.enabled) return;
    const markers = out.panels[0].series[0].markers!;
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ time: 60, position: 'belowBar', shape: 'arrowUp', color: CHART_COLORS.pos, text: '' });
    expect(markers[1]).toMatchObject({ time: 120, position: 'aboveBar', shape: 'arrowDown', color: CHART_COLORS.neg });
    expect(markers[1].text).toBe('+$2.50');
  });
});

describe('buildMarketChartSpec', () => {
  const candle = (time: number, open: number, close: number, volume = 5) => ({
    time, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume,
  });

  it('refuses honestly on an empty candle window', () => {
    const out = buildMarketChartSpec({ symbol: 'BTC', venue: 'hyperliquid', candles: [] });
    expect(out.enabled).toBe(false);
    if (!out.enabled) expect(out.reason).toContain('no hyperliquid candles');
  });

  it('serves candles + a direction-colored volume pane, sorted and deduped', () => {
    const out = buildMarketChartSpec({
      symbol: 'BTC', venue: 'hyperliquid',
      candles: [candle(120, 100, 99), candle(60, 98, 100), candle(120, 100, 99)],
    });
    expect(out.enabled).toBe(true);
    if (!out.enabled) return;
    const [price, vol] = out.panels;
    const c = price.series[0];
    expect(c.type).toBe('candlestick');
    expect(c.upColor).toBe(CHART_COLORS.pos);
    expect((c.data as { time: number }[]).map((p) => p.time)).toEqual([60, 120]);
    const volPoints = vol.series[0].data as ChartPoint[];
    expect(volPoints[0].color).toBe(CHART_COLORS.pos + '66'); // up bar
    expect(volPoints[1].color).toBe(CHART_COLORS.neg + '66'); // down bar
    // trader-review axis hints: volume compacts to K/M; price decimals fit the scale
    expect(vol.series[0].format).toBe('volume');
    expect(c.precision).toBe(3); // last close 99 → 3dp
  });

  it('scales price-axis precision to the instrument (sub-dollar tokens get real decimals)', () => {
    const cheap = buildMarketChartSpec({
      symbol: 'PEPE', venue: 'hyperliquid',
      candles: [candle(60, 0.004, 0.0041, 1), candle(120, 0.0041, 0.0042, 1)],
    });
    if (!cheap.enabled) throw new Error('expected enabled');
    expect(cheap.panels[0].series[0].precision).toBe(6);
  });

  it('draws our current quotes as price lines (bid green, ask red, reservation violet)', () => {
    const out = buildMarketChartSpec({
      symbol: 'BTC', venue: 'hyperliquid',
      candles: [candle(60, 98, 100), candle(120, 100, 99)],
      quotes: { bid: 99.5, ask: 100.5, reservation: 100.1 },
    });
    if (!out.enabled) throw new Error('expected enabled');
    const lines = out.panels[0].series[0].priceLines!;
    expect(lines).toEqual([
      { value: 99.5, color: CHART_COLORS.pos, title: 'our bid', dashed: true },
      { value: 100.5, color: CHART_COLORS.neg, title: 'our ask', dashed: true },
      { value: 100.1, color: CHART_COLORS.s4, title: 'reservation', dashed: true },
    ]);
  });

  it('omits the quote lines when no book quotes the instrument (no fabricated levels)', () => {
    const out = buildMarketChartSpec({ symbol: 'BTC', venue: 'hyperliquid', candles: [candle(60, 98, 100), candle(120, 100, 99)] });
    if (!out.enabled) throw new Error('expected enabled');
    expect(out.panels[0].series[0].priceLines).toBeUndefined();
  });
});

describe('buildPairChartSpec', () => {
  const mkZ = (n: number): ChartPoint[] => Array.from({ length: n }, (_, i) => ({ time: 60 * (i + 1), value: Math.sin(i / 3) * 2 }));

  const baseInput = () => ({
    pair: 'ETH/BTC',
    strategyLabel: 'pairs-zscore',
    legA: { symbol: 'ETH', points: [{ time: 60, value: 2000 }, { time: 120, value: 2100 }] },
    legB: { symbol: 'BTC', points: [{ time: 60, value: 60000 }, { time: 120, value: 60600 }] },
    z: mkZ(20),
    position: mkZ(20).map((p, i) => ({ time: p.time, value: i < 5 ? 0 : i < 12 ? 3 : -3 })),
    bands: { entryZ: 2, exitZ: 0.5 },
    trades: [{ openTime: 300, closeTime: 720, side: 'LONG', pnlUnits: '-1000000' }],
  });

  it('refuses honestly with too few overlapping bars', () => {
    const out = buildPairChartSpec({ ...baseInput(), z: mkZ(5) });
    expect(out.enabled).toBe(false);
    if (!out.enabled) expect(out.reason).toContain('backfill');
  });

  it('indexes both legs to 100 so one axis is honest (no dual axis)', () => {
    const out = buildPairChartSpec(baseInput());
    expect(out.enabled).toBe(true);
    if (!out.enabled) return;
    const legs = out.panels[0].series;
    expect(legs.map((s) => s.name)).toEqual(['ETH', 'BTC']);
    expect(pts(legs[0])[0].value).toBe(100);
    expect(pts(legs[1])[0].value).toBe(100);
    expect(pts(legs[0])[1].value).toBeCloseTo(105);
    expect(pts(legs[1])[1].value).toBeCloseTo(101);
  });

  it('draws the entry/exit bands as price lines on the z panel (amber entry, dim exit + zero)', () => {
    const out = buildPairChartSpec(baseInput());
    if (!out.enabled) throw new Error('expected enabled');
    const lines = out.panels[1].series[0].priceLines!;
    expect(lines.map((l) => l.value)).toEqual([2, -2, 0.5, -0.5, 0]);
    expect(lines[0].color).toBe(CHART_COLORS.warn);
    expect(lines[2].color).toBe(CHART_COLORS.dim);
  });

  it('omits entry/exit bands when the strategy has none (OU) but keeps the zero line', () => {
    const out = buildPairChartSpec({ ...baseInput(), bands: null });
    if (!out.enabled) throw new Error('expected enabled');
    expect(out.panels[1].series[0].priceLines!.map((l) => l.value)).toEqual([0]);
  });

  it('marks trades on the z panel and colors the close by realised P&L', () => {
    const out = buildPairChartSpec(baseInput());
    if (!out.enabled) throw new Error('expected enabled');
    const markers = out.panels[1].series[0].markers!;
    expect(markers[0]).toMatchObject({ time: 300, shape: 'arrowUp', color: CHART_COLORS.pos, text: 'open L' });
    expect(markers[1]).toMatchObject({ time: 720, shape: 'circle', color: CHART_COLORS.neg });
    expect(markers[1].text).toBe('−$1.00');
  });

  it('renders position as a sign histogram colored long-green / short-red / flat-dim', () => {
    const out = buildPairChartSpec(baseInput());
    if (!out.enabled) throw new Error('expected enabled');
    const pos = pts(out.panels[2].series[0]);
    expect(pos[0]).toMatchObject({ value: 0, color: CHART_COLORS.dim });
    expect(pos[6]).toMatchObject({ value: 1, color: CHART_COLORS.pos });
    expect(pos[15]).toMatchObject({ value: -1, color: CHART_COLORS.neg });
  });
});
