// ChartSpec — the one normalized JSON contract between a chart endpoint and the
// <mkt-chart> Web Component (UI_REWRITE_PLAN_III P1). The SERVER builds the whole
// spec (series, colors, bands, markers) with the pure functions below; the client
// component renders it verbatim and computes no business number (CLAUDE.md §1 —
// same doctrine as <nav-spark>, at chart scale).
//
// Time is epoch SECONDS (lightweight-charts' native unit); money arrives as the
// engine's 6-dec unit strings/bigints and leaves as float dollars — a display
// conversion, same as render/format.ts.
import { money } from './format';

/** Series colors — validated against the ui.css dark surface (#0b0e11) with the
 *  dataviz six-checks script (lightness band / chroma / CVD ΔE≥42 / contrast ≥3:1).
 *  pos/neg/warn mirror ui.css semantics EXACTLY (green=for us, red=against us,
 *  amber=caution) and are reserved for polarity; s1–s5 are identity (categorical)
 *  and deliberately never impersonate them. */
export const CHART_COLORS = {
  pos: '#3fb950',
  neg: '#f85149',
  warn: '#d29922',
  s1: '#3987e5', // blue    — primary series (equity, leg A)
  s2: '#d95926', // orange  — leg B, funding
  s3: '#0ea5a0', // teal    — z-score, realised
  s4: '#a371f7', // violet  — inventory MTM
  s5: '#d55181', // magenta — fees (contribution)
  dim: '#6e7681',
} as const;

export interface ChartPoint {
  time: number;
  value: number;
  /** Optional per-point paint (histogram polarity); the client passes it through. */
  color?: string;
}

export interface ChartMarker {
  time: number;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  color: string;
  text?: string;
}

export interface ChartPriceLine {
  value: number;
  color: string;
  title: string;
  dashed?: boolean;
}

export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartSeries {
  type: 'line' | 'area' | 'histogram' | 'candlestick';
  name: string;
  color: string;
  data: ChartPoint[] | CandlePoint[];
  priceLines?: ChartPriceLine[];
  markers?: ChartMarker[];
  /** Candlestick paint (server-decided, like every other color). */
  upColor?: string;
  downColor?: string;
}

export interface ChartPanel {
  title: string;
  series: ChartSeries[];
  /** Pane height hint in px (client default 140; first panel 220). */
  heightPx?: number;
}

export interface ChartSpecOk {
  enabled: true;
  title: string;
  panels: ChartPanel[];
  /** Honest caveat rendered under the chart (data source, cadence, gaps). */
  note?: string;
}

export interface ChartSpecOff {
  enabled: false;
  reason: string;
}

export type ChartResponse = ChartSpecOk | ChartSpecOff;

const MICROS = 1e6;

/** 6-dec integer units (string|bigint) → float dollars (display conversion). */
export function unitsToUsd(units: string | bigint): number {
  return Number(BigInt(units)) / MICROS;
}

/** Enforce lightweight-charts' contract: strictly-ascending unique times (keep the
 *  LAST point per timestamp — the newest write wins, matching append-only reads). */
export function ascending(points: ChartPoint[]): ChartPoint[] {
  const byTime = new Map<number, ChartPoint>();
  for (const p of points) {
    if (Number.isFinite(p.time) && Number.isFinite(p.value)) byTime.set(p.time, p);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Snap a marker to the nearest series time (markers must ride the series' own
 *  timeline); null when the series is empty. */
export function snapToSeries(times: number[], t: number): number | null {
  if (!times.length) return null;
  let best = times[0];
  let bestD = Math.abs(t - best);
  for (const x of times) {
    const d = Math.abs(t - x);
    if (d < bestD) {
      best = x;
      bestD = d;
    }
  }
  return best;
}

// ── NAV / equity charts (mm desk + book, carry desk + book, exec embeds) ────────

/** The subset of a durable mm_nav row the chart needs (repo rows already carry
 *  bigints; controller-serialized rows carry strings — both accepted). */
export interface NavPointLike {
  asOf: Date;
  equityUnits: string | bigint;
  realisedPnlUnits: string | bigint;
  unrealisedPnlUnits: string | bigint;
  feesUnits: string | bigint;
  fundingUnits: string | bigint;
}

/** A fill to mark on the equity curve (from the DeskEventLog ring buffer). */
export interface FillMarkerInput {
  ts: number; // epoch ms
  side: 'BUY' | 'SELL';
  action?: string;
  realisedDeltaUnits?: string;
}

const MAX_FILL_MARKERS = 100;

function fillMarkers(fills: FillMarkerInput[], seriesTimes: number[]): ChartMarker[] {
  const markers: ChartMarker[] = [];
  for (const f of fills.slice(-MAX_FILL_MARKERS)) {
    const time = snapToSeries(seriesTimes, Math.floor(f.ts / 1000));
    if (time === null) continue;
    const exit = f.action === 'reduce' || f.action === 'close' || f.action === 'flip';
    const text = exit && f.realisedDeltaUnits !== undefined ? money(f.realisedDeltaUnits) : '';
    markers.push(
      f.side === 'BUY'
        ? { time, position: 'belowBar', shape: 'arrowUp', color: CHART_COLORS.pos, text }
        : { time, position: 'aboveBar', shape: 'arrowDown', color: CHART_COLORS.neg, text },
    );
  }
  return markers.sort((a, b) => a.time - b.time);
}

/** Running drawdown % from the equity curve (peak-to-now, positive = down). A
 *  presentation derivation of the served equity points — not a new business number;
 *  the engine's own judged maxDD stays authoritative on the cards. */
export function drawdownSeries(equity: ChartPoint[]): ChartPoint[] {
  let peak = -Infinity;
  return equity.map((p) => {
    peak = Math.max(peak, p.value);
    const dd = peak > 0 ? ((peak - p.value) / peak) * 100 : 0;
    return { time: p.time, value: dd };
  });
}

export interface NavChartOpts {
  title: string;
  points: NavPointLike[];
  /** The desk's drawdown budget (2% MM / 0.5% carry) — drawn as the amber line. */
  ddBudgetPct: number;
  fills?: FillMarkerInput[];
  note?: string;
}

/**
 * The durable-NAV chart: equity (area) with fill markers, running drawdown vs the
 * budget, and the cumulative P&L components (realised / inv MTM / fees-contrib /
 * funding — the same four lines the book card sums to net). Honest empty state
 * when there aren't enough persisted samples to draw.
 */
export function buildNavChartSpec(opts: NavChartOpts): ChartResponse {
  const equity = ascending(opts.points.map((p) => ({ time: Math.floor(p.asOf.getTime() / 1000), value: unitsToUsd(p.equityUnits) })));
  if (equity.length < 2) {
    return { enabled: false, reason: 'no NAV history yet — needs a few persisted samples (MM_PERSIST + Postgres)' };
  }
  const comp = (pick: (p: NavPointLike) => string | bigint, flip = false): ChartPoint[] =>
    ascending(
      opts.points.map((p) => ({
        time: Math.floor(p.asOf.getTime() / 1000),
        value: unitsToUsd(pick(p)) * (flip ? -1 : 1),
      })),
    );
  const equitySeries: ChartSeries = {
    type: 'area',
    name: 'equity',
    color: CHART_COLORS.s1,
    data: equity,
  };
  const markers = fillMarkers(opts.fills ?? [], equity.map((p) => p.time));
  if (markers.length) equitySeries.markers = markers;
  return {
    enabled: true,
    title: opts.title,
    note: opts.note,
    panels: [
      { title: 'equity (durable NAV)', heightPx: 220, series: [equitySeries] },
      {
        title: 'drawdown % vs budget',
        series: [
          {
            type: 'line',
            name: 'drawdown %',
            color: CHART_COLORS.neg,
            data: drawdownSeries(equity),
            priceLines: [{ value: opts.ddBudgetPct, color: CHART_COLORS.warn, title: 'budget', dashed: true }],
          },
        ],
      },
      {
        title: 'P&L components (cumulative — these sum to net)',
        series: [
          { type: 'line', name: 'realised', color: CHART_COLORS.s3, data: comp((p) => p.realisedPnlUnits) },
          { type: 'line', name: 'inv MTM', color: CHART_COLORS.s4, data: comp((p) => p.unrealisedPnlUnits) },
          // Fees plotted as their CONTRIBUTION to net (−fees): a rebate climbs, a cost sinks —
          // the same dialect as the book card + tape.
          { type: 'line', name: 'fees (contrib)', color: CHART_COLORS.s5, data: comp((p) => p.feesUnits, true) },
          { type: 'line', name: 'funding', color: CHART_COLORS.s2, data: comp((p) => p.fundingUnits) },
        ],
      },
    ],
  };
}

// ── The market terminal chart (/markets — candles + volume + our-quote overlays) ─

export interface MarketChartInput {
  symbol: string;
  venue: string;
  /** OHLCV candles, oldest-first (live klines — not the DB). */
  candles: (CandlePoint & { volume: number })[];
  /** Our CURRENT resting quotes when an MM book quotes this instrument (display
   *  dollars). Horizontal price lines — quote *history* waits on the E6 ring. */
  quotes?: { bid?: number; ask?: number; reservation?: number };
  fills?: FillMarkerInput[];
  note?: string;
}

/**
 * The /markets candle chart: price candles with our-quote price lines + tape fill
 * markers, and a volume pane colored by the bar's direction. Every overlay is a
 * lesson: the bid/ask lines straddling the last candles ARE the spread being
 * quoted around fair value.
 */
export function buildMarketChartSpec(input: MarketChartInput): ChartResponse {
  const candles = [...input.candles]
    .filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time)
    .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);
  if (candles.length < 2) {
    return { enabled: false, reason: `no ${input.venue} candles for ${input.symbol} — the venue returned an empty window` };
  }
  const priceLines: ChartPriceLine[] = [];
  if (input.quotes?.bid !== undefined) priceLines.push({ value: input.quotes.bid, color: CHART_COLORS.pos, title: 'our bid', dashed: true });
  if (input.quotes?.ask !== undefined) priceLines.push({ value: input.quotes.ask, color: CHART_COLORS.neg, title: 'our ask', dashed: true });
  if (input.quotes?.reservation !== undefined) priceLines.push({ value: input.quotes.reservation, color: CHART_COLORS.s4, title: 'reservation', dashed: true });

  const candleSeries: ChartSeries = {
    type: 'candlestick',
    name: `${input.symbol} · ${input.venue}`,
    color: CHART_COLORS.s1,
    upColor: CHART_COLORS.pos,
    downColor: CHART_COLORS.neg,
    data: candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })),
  };
  if (priceLines.length) candleSeries.priceLines = priceLines;
  const markers = fillMarkers(input.fills ?? [], candles.map((c) => c.time));
  if (markers.length) candleSeries.markers = markers;

  return {
    enabled: true,
    title: `${input.symbol} — ${input.venue}`,
    note: input.note,
    panels: [
      { title: 'price (+ our current quotes when a book runs)', heightPx: 300, series: [candleSeries] },
      {
        title: 'volume',
        heightPx: 90,
        series: [
          {
            type: 'histogram',
            name: 'volume',
            color: CHART_COLORS.dim,
            data: candles.map((c) => ({
              time: c.time,
              value: Number.isFinite(c.volume) ? c.volume : 0,
              color: c.close >= c.open ? CHART_COLORS.pos + '66' : CHART_COLORS.neg + '66',
            })),
          },
        ],
      },
    ],
  };
}

// ── The stat-arb pair chart (legs + z + bands + position) ───────────────────────

export interface PairChartInput {
  pair: string;
  strategyLabel: string;
  legA: { symbol: string; points: ChartPoint[] };
  legB: { symbol: string; points: ChartPoint[] };
  /** z-score series (time sec, value z). */
  z: ChartPoint[];
  /** Signed position series (sign is what we draw; magnitude is engine-internal). */
  position: ChartPoint[];
  /** Numeric entry/exit z bands, or null (OU strategies have model-derived bands). */
  bands: { entryZ: number; exitZ: number } | null;
  trades: { openTime: number | null; closeTime: number | null; side: string; pnlUnits: string }[];
  note?: string;
}

/** Index a leg to 100 at its first point, so two price scales share one axis
 *  honestly (indexing, not a dual axis — the anti-pattern the dataviz rules ban). */
export function indexTo100(points: ChartPoint[]): ChartPoint[] {
  const first = points.find((p) => Number.isFinite(p.value) && p.value !== 0);
  if (!first) return [];
  return points.map((p) => ({ time: p.time, value: (p.value / first.value) * 100 }));
}

function tradeMarkers(trades: PairChartInput['trades'], zTimes: number[]): ChartMarker[] {
  const markers: ChartMarker[] = [];
  for (const t of trades) {
    if (t.openTime !== null) {
      const time = snapToSeries(zTimes, t.openTime);
      if (time !== null) {
        markers.push(
          t.side === 'LONG'
            ? { time, position: 'belowBar', shape: 'arrowUp', color: CHART_COLORS.pos, text: 'open L' }
            : { time, position: 'aboveBar', shape: 'arrowDown', color: CHART_COLORS.neg, text: 'open S' },
        );
      }
    }
    if (t.closeTime !== null) {
      const time = snapToSeries(zTimes, t.closeTime);
      if (time !== null) {
        const pnl = BigInt(t.pnlUnits);
        markers.push({
          time,
          position: 'inBar',
          shape: 'circle',
          color: pnl >= 0n ? CHART_COLORS.pos : CHART_COLORS.neg,
          text: money(t.pnlUnits),
        });
      }
    }
  }
  return markers.sort((a, b) => a.time - b.time);
}

/**
 * The classic pairs chart: both legs indexed to 100, the spread z-score with the
 * strategy's live entry/exit bands + trade markers, and the position sign. This is
 * the picture the strategy's math draws — the z the card shows is the last point
 * of the middle panel.
 */
export function buildPairChartSpec(input: PairChartInput): ChartResponse {
  const z = ascending(input.z);
  if (z.length < 10) {
    return { enabled: false, reason: 'not enough overlapping bars for this pair — backfill first (see /research runbook)' };
  }
  const zTimes = z.map((p) => p.time);
  const zSeries: ChartSeries = {
    type: 'line',
    name: 'z-score',
    color: CHART_COLORS.s3,
    data: z,
    priceLines: [
      ...(input.bands
        ? [
            { value: input.bands.entryZ, color: CHART_COLORS.warn, title: `entry +${input.bands.entryZ}`, dashed: true },
            { value: -input.bands.entryZ, color: CHART_COLORS.warn, title: `entry −${input.bands.entryZ}`, dashed: true },
            { value: input.bands.exitZ, color: CHART_COLORS.dim, title: `exit`, dashed: true },
            { value: -input.bands.exitZ, color: CHART_COLORS.dim, title: `exit`, dashed: true },
          ]
        : []),
      { value: 0, color: CHART_COLORS.dim, title: '', dashed: false },
    ],
  };
  const markers = tradeMarkers(input.trades, zTimes);
  if (markers.length) zSeries.markers = markers;

  const position: ChartPoint[] = ascending(input.position).map((p) => ({
    time: p.time,
    value: p.value > 0 ? 1 : p.value < 0 ? -1 : 0,
    color: p.value > 0 ? CHART_COLORS.pos : p.value < 0 ? CHART_COLORS.neg : CHART_COLORS.dim,
  }));

  return {
    enabled: true,
    title: `${input.pair} — ${input.strategyLabel}`,
    note: input.note,
    panels: [
      {
        title: 'legs (indexed to 100 at window start)',
        heightPx: 200,
        series: [
          { type: 'line', name: input.legA.symbol, color: CHART_COLORS.s1, data: indexTo100(ascending(input.legA.points)) },
          { type: 'line', name: input.legB.symbol, color: CHART_COLORS.s2, data: indexTo100(ascending(input.legB.points)) },
        ],
      },
      { title: 'spread z-score + entry/exit bands + trades', heightPx: 180, series: [zSeries] },
      { title: 'position (sign: long / short / flat)', heightPx: 80, series: [{ type: 'histogram', name: 'position', color: CHART_COLORS.dim, data: position }] },
    ],
  };
}
