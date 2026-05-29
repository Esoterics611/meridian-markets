import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { ITradingVenue, TRADING_VENUE } from '../stat-arb/trading-venue.interface';
import { VenueCapGate } from '../stat-arb/risk/venue-cap';
import { TwapAlgo } from './twap';
import { VwapAlgo } from './vwap';
import { PovAlgo } from './pov';
import { IcebergAlgo } from './iceberg';
import { IExecAlgo } from './exec-algo.interface';
import { MultiVenueOrderRouter, MultiVenueRouterExecuteResult } from './multi-venue-router';
import { estimateSlippage } from './slippage-model';

// ExecDemoService — in-memory history of routed parent orders for the Exec
// persona on the dashboard. No DB persistence in Phase 3 (same posture as
// DemoService). A real execution-log persistence layer would land alongside
// stat_arb_trades — out of scope this session.
//
// Each ExecEvent captures the plan (multi-venue split), the theoretical
// slippage, the realised slippage (here = theoretical since MockTradingVenue
// reports flat fees with zero per-bar drift), and per-venue child counts.

export type DemoAlgoId = 'twap' | 'vwap' | 'pov' | 'iceberg';
export const DEMO_ALGO_IDS: readonly DemoAlgoId[] = ['twap', 'vwap', 'pov', 'iceberg'];

export interface ExecRouteSummary {
  venueId: string;
  allocationUnits: bigint;
  estImpactBps: number;
  estCostUnits: bigint;
  childCount: number;
}

export interface ExecEvent {
  id: string;
  ts: Date;
  algoId: DemoAlgoId;
  parent: {
    symbol: string;
    side: 'BUY' | 'SELL';
    totalNotionalUnits: bigint;
  };
  routes: ExecRouteSummary[];
  totalEstCostUnits: bigint;
  filledNotionalUnits: bigint;
  blockedByCapCount: number;
  /** Realised slippage cost in USDC units across all children. */
  realisedCostUnits: bigint;
  underfilled: boolean;
}

const RECENT_LIMIT = 25;

// Per-venue liquidity profile used by the demo router. In production these
// numbers come from a venue-info API; for the synthetic demo they're hard-
// coded relative ADVs that give a visible split across the three venues.
const DEMO_LIQUIDITY = [
  { venueId: 'mock-a', advUnits: 400_000_000n },
  { venueId: 'mock-b', advUnits: 200_000_000n },
  { venueId: 'mock-c', advUnits: 100_000_000n },
];

@Injectable()
export class ExecDemoService {
  private history: ExecEvent[] = [];
  private nonce = 0;

  // Three replica MockTradingVenue instances so the demo can show split
  // routing without needing a real venue. In production each
  // venueId maps to a distinct ITradingVenue.
  private readonly venuesById: Map<string, ITradingVenue>;

  constructor(
    private readonly cfg: ConfigService,
    @Inject(TRADING_VENUE) private readonly baseVenue: ITradingVenue,
  ) {
    this.venuesById = new Map([
      ['mock-a', this.cloneVenue('mock-a')],
      ['mock-b', this.cloneVenue('mock-b')],
      ['mock-c', this.cloneVenue('mock-c')],
    ]);
  }

  private cloneVenue(id: string): ITradingVenue {
    // Tiny adapter that delegates to the underlying TRADING_VENUE provider
    // but reports a distinct venueId.
    const base = this.baseVenue;
    return {
      venueId: id,
      placeOrder: (req) => base.placeOrder(req),
      fetchPrice: (sym) => base.fetchPrice(sym),
    };
  }

  recent(limit: number = RECENT_LIMIT): ExecEvent[] {
    return this.history.slice(-limit).reverse();
  }

  reset(): void {
    this.history = [];
  }

  async runDemoOrder(opts: {
    algoId: DemoAlgoId;
    notionalUnits: bigint;
    side: 'BUY' | 'SELL';
    symbol?: string;
  }): Promise<ExecEvent> {
    const algo: IExecAlgo = this.algoFor(opts.algoId);
    const app = this.cfg.getOrThrow<AppConfig>('app');
    const symbol = opts.symbol ?? app.statArb.demoPairA;

    // Demo gate: cap each venue at 30% of the parent so the dashboard can
    // visibly show "blocked by cap" events on oversized parents.
    const gate = new VenueCapGate({
      maxNotionalUnitsPerVenue: (opts.notionalUnits * 30n) / 100n,
    });

    const router = new MultiVenueOrderRouter(algo, DEMO_LIQUIDITY, { venueCapGate: gate });
    const result: MultiVenueRouterExecuteResult = await router.execute(
      {
        symbol,
        side: opts.side,
        totalNotionalUnits: opts.notionalUnits,
        maxSlices: 4,
      },
      Array.from(this.venuesById.values()),
    );

    // Realised cost = sum of theoretical impact applied to actually-filled
    // notionals (MockTradingVenue exits at flat fees with no per-trade
    // drift, so realised == theoretical for now). When the demo flips to a
    // real venue, this is where you compare expected vs actual fill prices.
    let realisedCost = 0n;
    for (const r of result.routes) {
      const filledForRoute = r.children.reduce((s, c) => s + c.notionalUnits, 0n);
      const est = estimateSlippage({
        notionalUnits: filledForRoute,
        advUnits: liquidityById(r.venueId).advUnits,
      });
      realisedCost += est.costUnits;
    }

    const evt: ExecEvent = {
      id: `exec-${++this.nonce}`,
      ts: new Date(),
      algoId: opts.algoId,
      parent: { symbol, side: opts.side, totalNotionalUnits: opts.notionalUnits },
      routes: result.routes.map((r) => ({
        venueId: r.venueId,
        allocationUnits: r.allocationUnits,
        estImpactBps: r.estImpactBps,
        estCostUnits: r.estCostUnits,
        childCount: r.children.length,
      })),
      totalEstCostUnits: result.totalEstCostUnits,
      filledNotionalUnits: result.filledNotionalUnits,
      blockedByCapCount: result.blockedByCapCount,
      realisedCostUnits: realisedCost,
      underfilled: result.underfilled,
    };
    this.history.push(evt);
    if (this.history.length > 2 * RECENT_LIMIT) this.history = this.history.slice(-RECENT_LIMIT);
    return evt;
  }

  private algoFor(id: DemoAlgoId): IExecAlgo {
    switch (id) {
      case 'twap': return new TwapAlgo({ horizonMs: 60_000 });
      case 'vwap': return new VwapAlgo({ volumeCurve: [1, 2, 3, 2, 1], horizonMs: 60_000 });
      case 'pov':  return new PovAlgo({ participationPct: 15, intervalVolumeUnits: 1_000_000n, intervalMs: 15_000, horizonMs: 60_000 });
      case 'iceberg': return new IcebergAlgo({ tipSizeUnits: 250_000n, refillIntervalMs: 5_000 });
    }
  }
}

function liquidityById(id: string): { advUnits: bigint } {
  const v = DEMO_LIQUIDITY.find((x) => x.venueId === id);
  if (!v) return { advUnits: 0n };
  return { advUnits: v.advUnits };
}
