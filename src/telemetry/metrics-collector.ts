import { PrometheusRegistry } from './prometheus-registry';
import { M } from './metric-catalog';
import type { MmPortfolioSnapshot } from '../market-making/live/mm-portfolio-trader';

// MetricsCollector — the PULL side of telemetry (DC-3: read the ledger, don't
// duplicate it). On each `/metrics` scrape it reads the live MM desk `snapshot()`
// and process stats and writes them into the registry as gauges. There is no
// parallel accounting path: the snapshot IS the source of truth, telemetry only
// mirrors it. Per-book gauge families are reset each scrape so a removed book's
// series disappears instead of going stale (bounded cardinality, DC-4).
//
// Event-driven metrics (tick / feed-poll / persist counters + histograms) are NOT
// touched here — those are incremented live at their instrumentation points. The
// collector only owns the snapshot-derived gauges + process gauges.

/** What the collector reads — the MM trader satisfies this; tests fake it. */
export interface MmSnapshotSource {
  snapshot(): MmPortfolioSnapshot;
}

const KNOWN_VERDICTS = ['Allow', 'Deny', 'Pause'] as const;

/** Per-book gauge families cleared before each repopulation (books come and go). */
const PER_BOOK_GAUGES = [
  M.bookEquity,
  M.bookNetPnl,
  M.bookRealisedPnl,
  M.bookUnrealisedPnl,
  M.bookFees,
  M.bookFunding,
  M.bookInventory,
  M.bookMaxDrawdownPct,
  M.bookFills,
  M.bookBlockedQuotes,
  M.bookRiskVerdict,
  M.feedLastBarAge,
];

export class MetricsCollector {
  constructor(
    private readonly registry: PrometheusRegistry,
    private readonly mm: MmSnapshotSource | null,
    private readonly enabled: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** Called by GET /metrics immediately before rendering. No-op when disabled. */
  collect(): void {
    if (!this.enabled) return;
    this.collectProcess();
    if (this.mm) this.collectDesk(this.mm.snapshot());
  }

  private g(name: string, value: number, labels?: Record<string, string>): void {
    this.registry.gauge(name)?.set(labels, value);
  }

  private collectProcess(): void {
    this.g(M.uptime, process.uptime());
    const mem = process.memoryUsage();
    this.g(M.residentMemory, mem.rss);
    this.g(M.heapUsed, mem.heapUsed);
    this.g(M.heapTotal, mem.heapTotal);
  }

  private collectDesk(s: MmPortfolioSnapshot): void {
    for (const name of PER_BOOK_GAUGES) this.registry.gauge(name)?.reset();

    const nowMs = this.now();
    for (const b of s.books) {
      const book = b.symbol;
      const source = b.source || 'binance';
      const strategy = b.strategyId;
      this.g(M.bookEquity, Number(BigInt(b.equityUnits)), { book, source, strategy });
      this.g(M.bookNetPnl, Number(BigInt(b.netPnlUnits)), { book });
      this.g(M.bookRealisedPnl, Number(BigInt(b.realisedPnlUnits)), { book });
      this.g(M.bookUnrealisedPnl, Number(BigInt(b.unrealisedPnlUnits)), { book });
      this.g(M.bookFees, Number(BigInt(b.feesUnits)), { book });
      this.g(M.bookFunding, Number(BigInt(b.fundingUnits)), { book });
      this.g(M.bookInventory, Number(BigInt(b.inventoryUnits)), { book });
      this.g(M.bookMaxDrawdownPct, b.maxDrawdownPct, { book });
      this.g(M.bookFills, b.bidFills, { book, side: 'bid' });
      this.g(M.bookFills, b.askFills, { book, side: 'ask' });
      this.g(M.bookBlockedQuotes, b.blockedQuotes, { book });
      // Risk verdict as a state gauge: 1 for the active verdict, 0 for the others.
      for (const v of KNOWN_VERDICTS) this.g(M.bookRiskVerdict, b.lastVerdict === v ? 1 : 0, { book, verdict: v });
      // Feed staleness — the data-quality signal (FR-3).
      if (b.lastBarAt) {
        const ageSec = Math.max(0, (nowMs - new Date(b.lastBarAt).getTime()) / 1000);
        this.g(M.feedLastBarAge, ageSec, { source, symbol: book });
      }
    }

    const eq = Number(BigInt(s.equityUnits));
    this.g(M.deskEquity, eq);
    this.g(M.deskNav, eq);
    this.g(M.deskNetPnl, Number(BigInt(s.netPnlUnits)));
    this.g(M.deskRealisedPnl, Number(BigInt(s.realisedPnlUnits)));
    this.g(M.deskUnrealisedPnl, Number(BigInt(s.unrealisedPnlUnits)));
    this.g(M.deskFees, Number(BigInt(s.feesUnits)));
    this.g(M.deskFunding, Number(BigInt(s.fundingUnits)));
    this.g(M.deskCapital, Number(BigInt(s.capitalUnits)));
    this.g(M.deskBookCount, s.bookCount);
    this.g(M.deskRunning, s.running ? 1 : 0);
  }
}
