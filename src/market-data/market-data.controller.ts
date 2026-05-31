import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { BinanceBackfillService } from './ingest/binance-backfill.service';
import { MarketDataRepository, rowToBar, MarketBarRow } from './market-data.repository';
import { ReplayEngine } from './replay/replay-engine';
import { BacktestRunner } from '../stat-arb/backtest/backtest-runner';
import { PairsStrategy } from '../stat-arb/backtest/pairs-strategy';
import { strategyRegistry } from '../stat-arb/strategies/strategy-registry';
import { HistoricalReplayVenue } from '../stat-arb/historical-replay-venue';
import { Bar } from '../stat-arb/backtest/bar';
import { listPresets, getPreset } from '../stat-arb/markets/market-presets';
import { runUniverseOnBars, ApiUniverseResponse } from '../stat-arb/discovery/universe.controller';
import { ReferenceSourceRegistry } from './reference/reference-bar-loader';

/** Align many symbol series to the timestamps present in ALL of them (inner join). */
export function alignMany(bySymbol: Map<string, Bar[]>): Map<string, Bar[]> {
  const symbols = [...bySymbol.keys()];
  if (symbols.length === 0) return new Map();
  // Count how many symbols carry each timestamp; keep only the fully-covered ones.
  const counts = new Map<number, number>();
  for (const bars of bySymbol.values()) {
    const seen = new Set<number>();
    for (const b of bars) seen.add(b.timestamp.getTime());
    for (const t of seen) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const common = new Set<number>();
  for (const [t, n] of counts) if (n === symbols.length) common.add(t);

  const out = new Map<string, Bar[]>();
  for (const [sym, bars] of bySymbol) {
    out.set(sym, bars.filter((b) => common.has(b.timestamp.getTime())));
  }
  return out;
}

// Control plane for the interim in-repo market-data backfill + real-data
// backtests. (The full data platform is a separate repo — see CLAUDE.md §1.)
//
//   POST /api/market-data/backfill  — pull real Binance history into market_bars
//   GET  /api/market-data/bars      — how many bars are stored for a symbol
//   POST /api/market-data/backtest  — run the pairs backtest over REAL stored bars

const HOUR_MS = 3_600_000;

function jsonSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val)));
}

/** Align two bar series to the timestamps present in BOTH (equal-length, ordered). */
function alignPair(a: Bar[], b: Bar[]): { a: Bar[]; b: Bar[] } {
  const bByTs = new Map(b.map((bar) => [bar.timestamp.getTime(), bar]));
  const outA: Bar[] = [];
  const outB: Bar[] = [];
  for (const barA of a) {
    const barB = bByTs.get(barA.timestamp.getTime());
    if (barB) {
      outA.push(barA);
      outB.push(barB);
    }
  }
  return { a: outA, b: outB };
}

@Controller('api/market-data')
export class MarketDataController {
  constructor(
    private readonly backfillSvc: BinanceBackfillService,
    private readonly repo: MarketDataRepository,
    private readonly replay: ReplayEngine,
    private readonly refSources: ReferenceSourceRegistry,
  ) {}

  /**
   * The non-Binance reference data sources wired into the engine (TESSERA):
   * Pyth FX OHLC, DefiLlama peg, Bit2C (ILS). Lets the UI show which external
   * sources are incorporated, each with a sample symbol to probe.
   *   GET /api/market-data/reference/sources
   */
  @Get('reference/sources')
  referenceSources() {
    return {
      sources: this.refSources.list().map((s) => ({
        id: s.sourceId,
        label: s.label,
        sampleSymbol: s.sampleSymbol,
      })),
    };
  }

  /**
   * Recent bars from one reference source — the latest level for the UI readout
   * (Pyth returns true OHLC history; DefiLlama/Bit2C return the latest spot).
   *   GET /api/market-data/reference?source=pyth&symbol=EURUSD&limit=2
   */
  @Get('reference')
  async reference(
    @Query('source') source = 'pyth',
    @Query('symbol') symbol = 'EURUSD',
    @Query('interval') interval = '1m',
    @Query('limit') limit = '2',
  ) {
    const src = this.refSources.get(source);
    if (!src) {
      return { error: `unknown source: ${source}`, known: this.refSources.list().map((s) => s.sourceId) };
    }
    const lim = Math.min(Math.max(Number(limit) || 2, 1), 500);
    const bars = await src.klines(symbol, interval, lim).catch(() => []);
    const last = bars[bars.length - 1] ?? null;
    return {
      source,
      label: src.label,
      symbol,
      count: bars.length,
      last: last ? { time: Math.floor(last.timestamp.getTime() / 1000), price: last.close } : null,
      bars: bars.slice(-lim).map((b) => ({
        time: Math.floor(b.timestamp.getTime() / 1000),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    };
  }

  @Post('backfill')
  async backfill(
    @Body() body: { symbols?: string[]; interval?: string; lookbackHours?: number; venue?: string },
  ) {
    const symbols = body.symbols ?? ['BTC', 'ETH'];
    const lookbackHours = body.lookbackHours ?? 24;
    const toMs = Date.now();
    const fromMs = toMs - lookbackHours * HOUR_MS;
    const results = await this.backfillSvc.backfill({
      symbols,
      interval: body.interval ?? '1m',
      fromMs,
      toMs,
      venue: body.venue,
    });
    return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), results };
  }

  @Get('bars')
  async bars(
    @Query('symbol') symbol = 'BTC',
    @Query('venue') venue = 'binance.spot',
    @Query('hours') hours = '24',
  ) {
    const to = new Date();
    const from = new Date(to.getTime() - Number(hours) * HOUR_MS);
    const rows = await this.repo.barsBetween(venue, symbol, from, to);
    return {
      venue,
      symbol,
      count: rows.length,
      firstTs: rows[0]?.ts ?? null,
      lastTs: rows[rows.length - 1]?.ts ?? null,
    };
  }

  @Post('backtest')
  async backtest(
    @Body()
    body: {
      symbolA?: string;
      symbolB?: string;
      venue?: string;
      lookbackHours?: number;
      beta?: number;
      zLookback?: number;
      entryZ?: number;
      exitZ?: number;
      notionalUnits?: string;
      strategyId?: string;
      params?: Record<string, number>;
    },
  ) {
    const symbolA = body.symbolA ?? 'BTC';
    const symbolB = body.symbolB ?? 'ETH';
    const venue = body.venue ?? 'binance.spot';
    const to = new Date();
    const from = new Date(to.getTime() - (body.lookbackHours ?? 24) * HOUR_MS);

    const { a, b } = await this.replay.loadPairWindow({ venue, symbolA, symbolB, from, to });
    const aligned = alignPair(a, b);
    if (aligned.a.length < (body.zLookback ?? 20) + 2) {
      return {
        error: 'not enough overlapping bars — run POST /api/market-data/backfill first',
        barsA: a.length,
        barsB: b.length,
        overlap: aligned.a.length,
      };
    }

    const notionalUnits = BigInt(body.notionalUnits ?? '1000000000');
    // Strategy-aware: a registry id (e.g. ou-bertram, pairs-ewma) builds with
    // its catalogue tuning; the legacy path keeps the body's z-score knobs.
    const strategyId =
      body.strategyId && strategyRegistry.has(body.strategyId) ? body.strategyId : null;
    const strategy = strategyId
      ? strategyRegistry.build(strategyId, { beta: body.beta ?? 1, notionalUnits, params: body.params })
      : new PairsStrategy({
          beta: body.beta ?? 1,
          zLookback: body.zLookback ?? 20,
          entryZ: body.entryZ ?? 2,
          exitZ: body.exitZ ?? 0.5,
          notionalUnits,
        });
    const replayVenue = new HistoricalReplayVenue({ [symbolA]: aligned.a, [symbolB]: aligned.b });
    const result = await new BacktestRunner().run({
      barsA: aligned.a,
      barsB: aligned.b,
      strategy,
      venue: replayVenue,
    });

    return jsonSafe({
      window: { from: from.toISOString(), to: to.toISOString(), bars: aligned.a.length },
      pair: `${symbolA}/${symbolB}`,
      strategy: strategyId ?? 'pairs-zscore',
      source: 'real-binance-history',
      metrics: result.metrics,
      tradeCount: result.trades.length,
      trades: result.trades.slice(0, 25),
    });
  }

  /**
   * Position-sizing & fee economics for a pair, over stored real bars. Answers
   * the desk's "does bigger size beat the fees?" question HONESTLY:
   *
   *  - Fees here are 5 bps *of notional* (×4 fills/round-trip), so they scale
   *    linearly with size — net edge *in bps* is INVARIANT to notional. We run
   *    the same backtest at 1×/10×/100× to show net P&L scales linearly while
   *    edge-per-trade (bps) and Sharpe stay flat. (Only a FIXED commission would
   *    make bigger size cheaper per unit; we don't have one.)
   *  - The real size lever is market impact: it grows ~quadratically, so there
   *    is an interior-optimal participation N* = a/(2b) where a = net edge per
   *    unit notional and b is the impact coefficient (from the leg's ADV).
   *
   *   POST /api/market-data/sizing-study
   *     { symbolA, symbolB, beta?, lookbackHours?, strategyId?, params?, impactLambdaBps? }
   */
  @Post('sizing-study')
  async sizingStudy(
    @Body()
    body: {
      symbolA?: string;
      symbolB?: string;
      venue?: string;
      lookbackHours?: number;
      beta?: number;
      strategyId?: string;
      params?: Record<string, number>;
      impactLambdaBps?: number;
    },
  ) {
    const symbolA = body.symbolA ?? 'BTC';
    const symbolB = body.symbolB ?? 'ETH';
    const venue = body.venue ?? 'binance.spot';
    const beta = body.beta ?? 1;
    const to = new Date();
    const from = new Date(to.getTime() - (body.lookbackHours ?? 72) * HOUR_MS);
    const { a, b } = await this.replay.loadPairWindow({ venue, symbolA, symbolB, from, to });
    const aligned = alignPair(a, b);
    if (aligned.a.length < 30) {
      return { error: 'not enough overlapping bars — backfill this market set first', overlap: aligned.a.length };
    }

    const FEE_BPS = 5n;
    const base = 25_000_000_000n; // $25k/leg — balanced 25% deployment of a $100k book
    const hasStrat = !!body.strategyId && strategyRegistry.has(body.strategyId);
    const buildStrategy = (notionalUnits: bigint) =>
      hasStrat
        ? strategyRegistry.build(body.strategyId as string, { beta, notionalUnits, params: body.params })
        : new PairsStrategy({
            beta,
            zLookback: 20,
            entryZ: body.params?.entryZ ?? 2,
            exitZ: body.params?.exitZ ?? 0.5,
            notionalUnits,
          });

    const sizes: { label: string; notionalUnits: bigint }[] = [
      { label: '1×', notionalUnits: base },
      { label: '10×', notionalUnits: base * 10n },
      { label: '100×', notionalUnits: base * 100n },
    ];
    const rows: Array<{ label: string; notionalUnits: string; trades: number; netPnlUnits: string; edgePerTradeBps: number; sharpe: number }> = [];
    let edgePerNotional = 0; // a (USDC-micros net PnL per micro of notional)
    let tradesBase = 0;
    for (const s of sizes) {
      const replayVenue = new HistoricalReplayVenue({ [symbolA]: aligned.a, [symbolB]: aligned.b }, { takerFeeBps: FEE_BPS });
      const res = await new BacktestRunner().run({ barsA: aligned.a, barsB: aligned.b, strategy: buildStrategy(s.notionalUnits), venue: replayVenue });
      const pnl = Number(res.metrics.totalPnlUnits);
      const edgeBps = res.metrics.totalTrades > 0 ? (pnl / res.metrics.totalTrades / Number(s.notionalUnits)) * 1e4 : 0;
      rows.push({ label: s.label, notionalUnits: s.notionalUnits.toString(), trades: res.metrics.totalTrades, netPnlUnits: pnl.toString(), edgePerTradeBps: edgeBps, sharpe: res.metrics.sharpeRatio });
      if (s.notionalUnits === base) { edgePerNotional = pnl / Number(base); tradesBase = res.metrics.totalTrades; }
    }

    // Market-impact-aware optimum. ADV (USDC/bar) of the thinner leg; linear
    // impact lambda·N/ADV; net(N)=a·N−b·N²; N*=a/(2b).
    const advUsdc = (bars: typeof aligned.a) => {
      let s = 0;
      for (const x of bars) s += x.volume * x.close;
      return (s / Math.max(1, bars.length)) * 1e6; // micros
    };
    const adv = Math.min(advUsdc(aligned.a), advUsdc(aligned.b));
    const lambda = body.impactLambdaBps ?? 10;
    const bCoef = (4 * tradesBase * lambda) / (1e4 * Math.max(1, adv));
    const hasOptimum = edgePerNotional > 0 && bCoef > 0;
    const nStar = hasOptimum ? edgePerNotional / (2 * bCoef) : null;
    const netAtStar = nStar != null ? edgePerNotional * nStar - bCoef * nStar * nStar : null;

    return jsonSafe({
      pair: `${symbolA}/${symbolB}`,
      strategy: hasStrat ? body.strategyId : 'pairs-zscore',
      window: { from: from.toISOString(), to: to.toISOString(), bars: aligned.a.length },
      feeBps: Number(FEE_BPS),
      roundTripFeeBps: Number(FEE_BPS) * 4, // 2 legs × open+close
      sizes: rows,
      impact: {
        advUsdcPerBar: adv,
        lambdaBps: lambda,
        edgePerTradeBpsAtBase: rows[0]?.edgePerTradeBps ?? 0,
        optimalNotionalUnits: nStar != null ? Math.round(nStar).toString() : null,
        netAtOptimalUnits: netAtStar != null ? Math.round(netAtStar).toString() : null,
        note: hasOptimum
          ? 'net edge is size-invariant in bps; market impact (∝N²) sets the optimal participation N*'
          : 'no positive-edge optimum — config is sub-fee/net-negative, so any size loses (impact only worsens it)',
      },
    });
  }

  // --- Live multi-asset surface (presaved markets + real-data discovery) ---

  /** The presaved market sets the demo can switch between. */
  @Get('presets')
  presets() {
    return {
      presets: listPresets().map((p) => ({
        id: p.id,
        label: p.label,
        assetClass: p.assetClass,
        description: p.description,
        symbols: p.symbols,
        defaultPair: p.defaultPair,
        quote: p.quote,
      })),
    };
  }

  /** Backfill every symbol in a preset from real Binance history into market_bars. */
  @Post('backfill-preset')
  async backfillPreset(@Body() body: { presetId?: string; interval?: string; lookbackHours?: number; venue?: string }) {
    const preset = getPreset(body.presetId ?? '');
    if (!preset) {
      return { error: `unknown preset: ${body.presetId}`, known: listPresets().map((p) => p.id) };
    }
    const lookbackHours = body.lookbackHours ?? 72;
    const toMs = Date.now();
    const fromMs = toMs - lookbackHours * HOUR_MS;
    const results = await this.backfillSvc.backfill({
      symbols: preset.symbols,
      interval: body.interval ?? '1m',
      fromMs,
      toMs,
      venue: body.venue,
    });
    const totalBars = results.reduce((s, r) => s + r.inserted, 0);
    return {
      presetId: preset.id,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      symbols: preset.symbols.length,
      totalBarsInserted: totalBars,
      results,
    };
  }

  /**
   * Real-data pair discovery over a preset's stored bars. Same response shape as
   * the synthetic /api/stat-arb/research/universe — only the bar source differs.
   * Returns a `needsBackfill` hint when too little data is stored to discover.
   */
  @Get('universe')
  async universe(
    @Query('presetId') presetId = 'crypto-majors',
    @Query('venue') venue = 'binance.spot',
    @Query('hours') hours = '72',
  ): Promise<
    | ApiUniverseResponse
    | { error: string; needsBackfill: boolean; perSymbol: Record<string, number>; dropped?: string[] }
  > {
    const preset = getPreset(presetId);
    if (!preset) return { error: `unknown preset: ${presetId}`, needsBackfill: false, perSymbol: {} };
    const to = new Date();
    const from = new Date(to.getTime() - Number(hours) * HOUR_MS);

    const rowsBySymbol = await this.repo.barsForSymbols(venue, preset.symbols, from, to);
    const barsBySymbol = new Map<string, Bar[]>();
    for (const [sym, rows] of rowsBySymbol) barsBySymbol.set(sym, rows.map(rowToBar));

    // Drop delisted/sparse symbols (a renamed ticker returns ~no bars) BEFORE
    // intersecting timestamps — otherwise one empty symbol collapses the whole
    // preset's common window to nothing, the recurring "nothing comes up".
    const dropped: string[] = [];
    for (const [sym, b] of [...barsBySymbol]) {
      if (b.length < 60) { barsBySymbol.delete(sym); dropped.push(sym); }
    }
    const aligned = alignMany(barsBySymbol);

    const lengths = [...aligned.values()].map((b) => b.length);
    const minLen = lengths.length ? Math.min(...lengths) : 0;
    if (aligned.size < 2 || minLen < 60) {
      const perSymbol: Record<string, number> = {};
      for (const [sym, rows] of rowsBySymbol) perSymbol[sym] = rows.length;
      return { error: 'not enough overlapping real bars — backfill this preset first', needsBackfill: true, perSymbol, dropped };
    }

    // Looser knobs for noisy real 1m crypto so candidates actually surface — a
    // higher p-value cutoff (still ranked best-first) and a wider half-life
    // window than the synthetic default.
    return jsonSafe(
      runUniverseOnBars(aligned, { source: 'real-binance-history', pValueCutoff: 0.6, maxHalfLifeBars: 240 }),
    );
  }

  /** Real OHLC bars for charting (Lightweight Charts format: Unix-seconds time). */
  @Get('candles')
  async candles(
    @Query('symbol') symbol = 'BTC',
    @Query('venue') venue = 'binance.spot',
    @Query('hours') hours = '24',
  ) {
    const to = new Date();
    const from = new Date(to.getTime() - Number(hours) * HOUR_MS);
    const rows: MarketBarRow[] = await this.repo.barsBetween(venue, symbol, from, to);
    return {
      symbol,
      venue,
      candles: rows.map((r) => {
        const bar = rowToBar(r);
        return {
          time: Math.floor(r.ts.getTime() / 1000),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        };
      }),
    };
  }

  /**
   * The signal the strategy actually trades, for the Strategy Chart: per-bar
   * z-score of the spread + entry/exit bands + trade markers, computed by
   * running the chosen strategy over the stored real-bar window (the same
   * backtest path as /backtest, exposing its spreadSeries + trades). Pairs/EWMA
   * carry numeric entry/exit z bands; OU has no z bands (model-derived), so
   * `bands` is null there and the chart shows the z line + markers only.
   *   GET /api/market-data/signal-series?symbolA=ETH&symbolB=BTC&strategyId=ou-bertram&beta=18&hours=72
   */
  @Get('signal-series')
  async signalSeries(
    @Query('symbolA') symbolA = 'BTC',
    @Query('symbolB') symbolB = 'ETH',
    @Query('venue') venue = 'binance.spot',
    @Query('hours') hours = '72',
    @Query('beta') beta = '1',
    @Query('strategyId') strategyId?: string,
  ) {
    const to = new Date();
    const from = new Date(to.getTime() - Number(hours) * HOUR_MS);
    const { a, b } = await this.replay.loadPairWindow({ venue, symbolA, symbolB, from, to });
    const aligned = alignPair(a, b);
    if (aligned.a.length < 30) {
      return { error: 'not enough overlapping bars — backfill first', overlap: aligned.a.length };
    }
    const betaN = Number(beta) || 1;
    const notionalUnits = 1_000_000_000n;
    const hasStrat = !!strategyId && strategyRegistry.has(strategyId);
    const strategy = hasStrat
      ? strategyRegistry.build(strategyId as string, { beta: betaN, notionalUnits })
      : new PairsStrategy({ beta: betaN, zLookback: 20, entryZ: 2, exitZ: 0.5, notionalUnits });
    const replayVenue = new HistoricalReplayVenue({ [symbolA]: aligned.a, [symbolB]: aligned.b });
    const result = await new BacktestRunner().run({ barsA: aligned.a, barsB: aligned.b, strategy, venue: replayVenue });

    const defaults = hasStrat ? strategyRegistry.get(strategyId as string).defaultParams : { entryZ: 2, exitZ: 0.5 };
    const series = result.spreadSeries.map((p) => ({
      time: Math.floor(p.timestamp.getTime() / 1000),
      z: p.zScore,
      position: p.position,
    }));
    const trades = result.trades.map((t) => ({
      openTime: series[t.openIndex]?.time ?? null,
      closeTime: series[t.closeIndex]?.time ?? null,
      side: t.side,
      entryZ: t.entryZ,
      exitZ: t.exitZ,
      pnlUnits: t.pnlUnits.toString(),
    }));
    return jsonSafe({
      pair: `${symbolA}/${symbolB}`,
      strategy: hasStrat ? strategyId : 'pairs-zscore',
      window: { from: from.toISOString(), to: to.toISOString(), bars: aligned.a.length },
      bands: defaults.entryZ != null ? { entryZ: defaults.entryZ, exitZ: defaults.exitZ } : null,
      series,
      trades,
    });
  }
}
