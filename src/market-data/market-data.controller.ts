import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { BinanceBackfillService } from './ingest/binance-backfill.service';
import { MarketDataRepository } from './market-data.repository';
import { ReplayEngine } from './replay/replay-engine';
import { BacktestRunner } from '../stat-arb/backtest/backtest-runner';
import { PairsStrategy } from '../stat-arb/backtest/pairs-strategy';
import { HistoricalReplayVenue } from '../stat-arb/historical-replay-venue';
import { Bar } from '../stat-arb/backtest/bar';

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
  ) {}

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

    const strategy = new PairsStrategy({
      beta: body.beta ?? 1,
      zLookback: body.zLookback ?? 20,
      entryZ: body.entryZ ?? 2,
      exitZ: body.exitZ ?? 0.5,
      notionalUnits: BigInt(body.notionalUnits ?? '1000000000'),
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
      source: 'real-binance-history',
      metrics: result.metrics,
      tradeCount: result.trades.length,
      trades: result.trades.slice(0, 25),
    });
  }
}
