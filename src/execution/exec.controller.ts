import { Controller, Get, Post, Query } from '@nestjs/common';
import { DEMO_ALGO_IDS, DemoAlgoId, ExecDemoService, ExecEvent } from './exec-demo.service';

// /api/stat-arb/exec/* — Exec-desk endpoint. Lets the dashboard fire a
// parent order through the router and read back the routing decision plus
// any per-child cap events. Mock-default like the rest of the demo.

interface ApiExecRoute {
  venueId: string;
  allocationUnits: string;
  estImpactBps: number;
  estCostUnits: string;
  childCount: number;
}

interface ApiExecEvent {
  id: string;
  ts: string;
  algoId: DemoAlgoId;
  parent: { symbol: string; side: 'BUY' | 'SELL'; totalNotionalUnits: string };
  routes: ApiExecRoute[];
  totalEstCostUnits: string;
  filledNotionalUnits: string;
  blockedByCapCount: number;
  realisedCostUnits: string;
  underfilled: boolean;
}

function parseAlgo(s: string | undefined): DemoAlgoId {
  if (s !== undefined && (DEMO_ALGO_IDS as readonly string[]).includes(s)) return s as DemoAlgoId;
  return 'twap';
}

function parseSide(s: string | undefined): 'BUY' | 'SELL' {
  return s === 'SELL' ? 'SELL' : 'BUY';
}

function parseNotional(s: string | undefined): bigint {
  if (!s) return 1_000_000n;
  try {
    const n = BigInt(s);
    return n > 0n ? n : 1_000_000n;
  } catch {
    return 1_000_000n;
  }
}

function serialise(e: ExecEvent): ApiExecEvent {
  return {
    id: e.id,
    ts: e.ts.toISOString(),
    algoId: e.algoId,
    parent: {
      symbol: e.parent.symbol,
      side: e.parent.side,
      totalNotionalUnits: e.parent.totalNotionalUnits.toString(),
    },
    routes: e.routes.map((r) => ({
      venueId: r.venueId,
      allocationUnits: r.allocationUnits.toString(),
      estImpactBps: r.estImpactBps,
      estCostUnits: r.estCostUnits.toString(),
      childCount: r.childCount,
    })),
    totalEstCostUnits: e.totalEstCostUnits.toString(),
    filledNotionalUnits: e.filledNotionalUnits.toString(),
    blockedByCapCount: e.blockedByCapCount,
    realisedCostUnits: e.realisedCostUnits.toString(),
    underfilled: e.underfilled,
  };
}

@Controller('api/stat-arb/exec')
export class ExecController {
  constructor(private readonly exec: ExecDemoService) {}

  @Post('run')
  async run(
    @Query('algo') algo?: string,
    @Query('notional') notional?: string,
    @Query('side') side?: string,
  ): Promise<ApiExecEvent> {
    const evt = await this.exec.runDemoOrder({
      algoId: parseAlgo(algo),
      notionalUnits: parseNotional(notional),
      side: parseSide(side),
    });
    return serialise(evt);
  }

  @Get('recent')
  recent(@Query('limit') limit?: string): { events: ApiExecEvent[] } {
    const n = limit ? Math.max(1, Math.min(parseInt(limit, 10) || 25, 100)) : 25;
    return { events: this.exec.recent(n).map(serialise) };
  }

  @Post('reset')
  reset(): { ok: true } {
    this.exec.reset();
    return { ok: true };
  }
}
