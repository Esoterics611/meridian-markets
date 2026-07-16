import { Controller, Get, Header, Inject, MessageEvent, Optional, Query, Sse } from '@nestjs/common';
import { Observable, interval, startWith, switchMap } from 'rxjs';
import { MmPortfolioTrader } from '../market-making/live/mm-portfolio-trader';
import { DeskEventLog } from '../market-making/events/desk-event-log';
import { MM_BINANCE_CLIENT } from '../market-making/mm-tokens';
import { MM_MARKET_PRESETS } from '../market-making/markets/mm-market-presets';
import { ReferenceSourceRegistry } from '../market-data/reference/reference-bar-loader';
import { IL2BookSource } from '../market-data/reference/reference-source.interface';
import { BinancePublicClient } from '../stat-arb/feed/binance-public-client';
import { Bar } from '../stat-arb/backtest/bar';
import { buildMarketChartSpec, ChartResponse, FillMarkerInput } from './render/chart-spec';
import { renderMarketsPage, renderMarketsStrip, StripData } from './render/markets-view';

// The /markets terminal (UI_REWRITE_PLAN_III P2) — the market on screen. Declared
// in MarketMakingModule (views/specs in src/ui — the StatArbDeskController
// precedent): it injects the MM trader (our-quote overlays), the DeskEventLog
// (fill markers + tape) and the module's ReferenceSourceRegistry; market-data must
// stay free of market-making imports, so the page cannot live there.
//
//   GET /markets                    — the page (picker · strip · chart · ladder · tape)
//   GET /markets/stream             — SSE: the header strip every 2s
//   GET /markets/chart              — ChartSpec: live venue klines + overlays
//   GET /api/market-data/l2         — one L2 depth frame (JSON; E1)
//   GET /api/market-data/l2/stream  — SSE: the depth frame ~1/s (the ladder's feed)
//
// All read-only. Every frame is venue-fresh (live klines / live l2Book) — nothing
// here reads the stored-bar DB, and every failure is an {enabled:false, reason}.

const STRIP_STREAM_MS = 2000;
const L2_STREAM_MS = 1000;
/** 24h-range reads are cached this long (the strip ticks at 2s; the range doesn't). */
const RANGE_CACHE_MS = 60_000;
const CHART_FILL_LIMIT = 200;
const VENUES = ['hyperliquid', 'binance'] as const;

const MICROS = 1e6;

function toNum(micros: string | bigint | null): number | undefined {
  if (micros === null) return undefined;
  return Number(BigInt(micros)) / MICROS;
}

function normVenue(raw?: string): string {
  return VENUES.includes((raw ?? '') as (typeof VENUES)[number]) ? (raw as string) : 'hyperliquid';
}

function normSymbol(raw?: string): string {
  return (raw ?? 'BTC').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || 'BTC';
}

/** Chart window → (interval, bar count): 1m intraday, 5m for days, 1h for weeks. */
export function intervalFor(hours: number): { interval: string; limit: number } {
  if (hours <= 8) return { interval: '1m', limit: Math.min(500, hours * 60) };
  if (hours <= 48) return { interval: '5m', limit: Math.min(600, Math.ceil(hours * 12)) };
  return { interval: '1h', limit: Math.min(400, Math.ceil(hours)) };
}

function clampHours(raw?: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.max(1, Math.min(336, Math.floor(n)));
}

interface L2FrameLevel {
  px: number;
  sz: number;
  n: number;
}
type L2Frame =
  | { enabled: true; symbol: string; venue: string; tsMs: number; bids: L2FrameLevel[]; asks: L2FrameLevel[]; ourBid?: number; ourAsk?: number }
  | { enabled: false; reason: string };

@Controller()
export class MarketsController {
  private readonly rangeCache = new Map<string, { ts: number; hi: number; lo: number; open24: number }>();

  constructor(
    @Inject(MM_BINANCE_CLIENT) private readonly binance: BinancePublicClient,
    private readonly registry: ReferenceSourceRegistry,
    private readonly mm: MmPortfolioTrader,
    @Optional() @Inject(DeskEventLog) private readonly eventLog: DeskEventLog | null = null,
  ) {}

  @Get('markets')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async page(@Query('symbol') symbolQ?: string, @Query('venue') venueQ?: string, @Query('hours') hoursQ?: string): Promise<string> {
    const venue = normVenue(venueQ);
    const symbol = normSymbol(symbolQ);
    return renderMarketsPage({
      symbol,
      venue,
      hours: clampHours(hoursQ),
      symbols: this.symbolsFor(venue, symbol),
      venues: [...VENUES],
      hasL2: this.l2Source(venue) !== null,
      strip: await this.stripData(symbol, venue),
      events: this.eventLog ? this.eventLog.recent({ limit: 40, book: symbol }) : [],
      cursor: this.eventLog ? this.eventLog.lastSeq() : 0,
    });
  }

  @Sse('markets/stream')
  stream(@Query('symbol') symbolQ?: string, @Query('venue') venueQ?: string): Observable<MessageEvent> {
    const venue = normVenue(venueQ);
    const symbol = normSymbol(symbolQ);
    return interval(STRIP_STREAM_MS).pipe(
      startWith(0),
      switchMap(async () => ({ data: { html: renderMarketsStrip(await this.stripData(symbol, venue)).value } }) as MessageEvent),
    );
  }

  /**
   * ChartSpec for the market terminal: live venue klines (candles + volume) with
   * the live MM book's CURRENT quotes as price lines and our recent fills as
   * markers. Venue-fresh by construction — no stored-bar dependency.
   */
  @Get('markets/chart')
  async chart(@Query('symbol') symbolQ?: string, @Query('venue') venueQ?: string, @Query('hours') hoursQ?: string): Promise<ChartResponse> {
    const venue = normVenue(venueQ);
    const symbol = normSymbol(symbolQ);
    const hours = clampHours(hoursQ);
    const { interval: iv, limit } = intervalFor(hours);
    let bars: Bar[];
    try {
      bars = await this.bars(symbol, venue, iv, limit);
    } catch {
      return { enabled: false, reason: `${venue} klines unreachable for ${symbol} — venue error (retry, or pick another market)` };
    }
    const book = this.bookFor(symbol, venue);
    const quotes = book
      ? { bid: toNum(book.bidMicros), ask: toNum(book.askMicros), reservation: toNum(book.reservationMicros) }
      : undefined;
    const fills: FillMarkerInput[] = this.eventLog
      ? this.eventLog
          .recent({ limit: CHART_FILL_LIMIT, book: symbol })
          .filter((e) => e.kind === 'fill' && e.side)
          .map((e) => ({ ts: e.ts, side: e.side as FillMarkerInput['side'], action: e.action, realisedDeltaUnits: e.realisedDeltaUnits }))
      : [];
    return buildMarketChartSpec({
      symbol,
      venue,
      candles: bars.map((b) => ({
        time: Math.floor(b.timestamp.getTime() / 1000),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      })),
      quotes,
      fills,
      note:
        `live ${venue} ${iv} klines (venue-fresh, not the stored DB). ` +
        (quotes
          ? 'dashed lines = the live book’s CURRENT quotes (history waits on the E6 quote ring); '
          : 'no MM book quotes this market right now — launch one to see our quotes straddle mid; ') +
        '▲/▼ = our recent paper fills from the tape',
    });
  }

  /** E1: one L2 depth frame (JSON twin of the SSE stream). */
  @Get('api/market-data/l2')
  async l2(@Query('symbol') symbolQ?: string, @Query('venue') venueQ?: string): Promise<L2Frame> {
    return this.l2Frame(normSymbol(symbolQ), normVenue(venueQ));
  }

  /** E1: the depth ladder's feed — a fresh 20×20 frame ~1/s. Throttled by design:
   *  this is a teaching ladder, not an HFT feed (the plan's own rate cap). */
  @Sse('api/market-data/l2/stream')
  l2Stream(@Query('symbol') symbolQ?: string, @Query('venue') venueQ?: string): Observable<MessageEvent> {
    const venue = normVenue(venueQ);
    const symbol = normSymbol(symbolQ);
    return interval(L2_STREAM_MS).pipe(
      startWith(0),
      switchMap(async () => ({ data: await this.l2Frame(symbol, venue) }) as unknown as MessageEvent),
    );
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private l2Source(venue: string): IL2BookSource | null {
    const src = this.registry.get(venue) as Partial<IL2BookSource> | undefined;
    return src && typeof src.l2Snapshot === 'function' ? (src as IL2BookSource) : null;
  }

  private bookFor(symbol: string, venue: string) {
    return this.mm.snapshot().books.find((b) => b.symbol === symbol && (b.source || 'binance') === venue) ?? null;
  }

  private async l2Frame(symbol: string, venue: string): Promise<L2Frame> {
    const src = this.l2Source(venue);
    if (!src) return { enabled: false, reason: `${venue} has no L2 depth feed — the ladder needs an L2-capable venue (hyperliquid)` };
    try {
      const snap = await src.l2Snapshot(symbol);
      const level = (l: { priceMicros: bigint; sizeUnits: bigint; orderCount: number }): L2FrameLevel => ({
        px: Number(l.priceMicros) / MICROS,
        sz: Number(l.sizeUnits) / MICROS,
        n: l.orderCount,
      });
      const book = this.bookFor(symbol, venue);
      return {
        enabled: true,
        symbol,
        venue,
        tsMs: snap.ts.getTime(),
        bids: snap.bids.map(level),
        asks: snap.asks.map(level),
        ...(book && book.bidMicros !== null ? { ourBid: toNum(book.bidMicros) } : {}),
        ...(book && book.askMicros !== null ? { ourAsk: toNum(book.askMicros) } : {}),
      };
    } catch {
      return { enabled: false, reason: `${venue} depth unreachable for ${symbol} — venue error` };
    }
  }

  private bars(symbol: string, venue: string, iv: string, limit: number): Promise<Bar[]> {
    return venue === 'binance' ? this.binance.klines(symbol, iv, limit) : this.registry.bars(venue, symbol, iv, limit);
  }

  /** Picker options: the MM market presets for the venue (plus the current symbol). */
  private symbolsFor(venue: string, current: string): string[] {
    const fromPresets = MM_MARKET_PRESETS.filter((p) => (p.source ?? 'binance') === venue).flatMap((p) => [...p.symbols]);
    return [...new Set([current, ...fromPresets])].sort();
  }

  private async stripData(symbol: string, venue: string): Promise<StripData> {
    const asOfMs = Date.now();
    try {
      const [range, live] = await Promise.all([this.range24(symbol, venue), this.livePrice(symbol, venue)]);
      return {
        symbol,
        venue,
        last: live.last,
        deltaPct: range && live.last !== null ? ((live.last - range.open24) / range.open24) * 100 : null,
        hi: range?.hi ?? null,
        lo: range?.lo ?? null,
        spreadBps: live.spreadBps,
        asOfMs,
      };
    } catch (e) {
      return {
        symbol,
        venue,
        last: null,
        deltaPct: null,
        hi: null,
        lo: null,
        spreadBps: null,
        asOfMs,
        error: `feed unreachable (${e instanceof Error ? e.message : 'venue error'})`,
      };
    }
  }

  /** Last price: the L2 mid when the venue has depth (also yields the live spread),
   *  else the newest 1m close. */
  private async livePrice(symbol: string, venue: string): Promise<{ last: number | null; spreadBps: number | null }> {
    const frame = await this.l2Frame(symbol, venue);
    if (frame.enabled && frame.bids.length && frame.asks.length) {
      const bid = frame.bids[0].px;
      const ask = frame.asks[0].px;
      const mid = (bid + ask) / 2;
      return { last: mid, spreadBps: mid > 0 ? ((ask - bid) / mid) * 10_000 : null };
    }
    const bars = await this.bars(symbol, venue, '1m', 2);
    return { last: bars.length ? bars[bars.length - 1].close : null, spreadBps: null };
  }

  private async range24(symbol: string, venue: string): Promise<{ hi: number; lo: number; open24: number } | null> {
    const key = `${venue}:${symbol}`;
    const hit = this.rangeCache.get(key);
    if (hit && Date.now() - hit.ts < RANGE_CACHE_MS) return hit;
    const bars = await this.bars(symbol, venue, '1h', 25);
    if (!bars.length) return null;
    const entry = {
      ts: Date.now(),
      hi: Math.max(...bars.map((b) => b.high)),
      lo: Math.min(...bars.map((b) => b.low)),
      open24: bars[0].open,
    };
    this.rangeCache.set(key, entry);
    return entry;
  }
}
