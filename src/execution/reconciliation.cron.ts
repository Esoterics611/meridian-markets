import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { PaperVenue } from './paper-venue';

// ReconciliationCron — every reconciliationIntervalMs, compare the internal
// view of the book against the paper venue's recorded fills and emit a drift
// event when they disagree. Drift surfaces here are:
//
//   netDrift — internal net notional vs paper net notional per symbol.
//   missingFills — paper fills not recorded in the internal log (paper ahead).
//   ghostFills — internal log carries fills the paper book never received.
//
// In Phase 3 the cron is paper-only (no real venue persistence yet); when
// EXECUTION_MODE=canary lands in production, the same loop compares paper vs
// real fills + the internal log, and the existing event shape extends with
// a `source: 'paper'|'real'` tag. The MockTradingVenue path is exercised in
// the existing demo flow; only this cron persists drift events.
//
// Threshold: any non-zero drift triggers a WARN event; in production this
// would also feed an alert sink (Slack / PagerDuty — Session 15).

export type DriftKind = 'NET_DRIFT' | 'MISSING_FILL' | 'GHOST_FILL';

export interface DriftEvent {
  kind: DriftKind;
  symbol: string;
  at: Date;
  /** Detail field populated per-kind. NET_DRIFT carries internalNet/paperNet. */
  detail: Record<string, string | number>;
}

export interface InternalBookSnapshot {
  symbol: string;
  netNotionalUnits: bigint;
  /** Idempotency keys the strategy thinks have filled. */
  idempotencyKeys: Set<string>;
}

const RECENT_LIMIT = 50;

@Injectable()
export class ReconciliationCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationCron.name);
  private handle: NodeJS.Timeout | null = null;
  private events: DriftEvent[] = [];
  private internalBook: () => InternalBookSnapshot[] = () => [];
  private paperVenue: PaperVenue | null = null;

  constructor(private readonly cfg: ConfigService) {}

  /** Plug in the internal-book reader. Called by the module wiring; in
   *  Phase 3 the demo passes a static snapshot, in Phase 4 this hooks up to
   *  stat_arb_trades / stat_arb_nav. Mock-default safe. */
  setSources(opts: {
    internalBook: () => InternalBookSnapshot[];
    paperVenue: PaperVenue;
  }): void {
    this.internalBook = opts.internalBook;
    this.paperVenue = opts.paperVenue;
  }

  onModuleInit(): void {
    const app = this.cfg.getOrThrow<AppConfig>('app');
    if (app.nodeEnv === 'test') return; // tests drive tick() explicitly
    const intervalMs = app.execution?.reconciliationIntervalMs ?? 60_000;
    this.handle = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.logger.log(`reconciliation cron started: every ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.handle) clearInterval(this.handle);
  }

  recentEvents(limit: number = RECENT_LIMIT): DriftEvent[] {
    return this.events.slice(-limit).reverse();
  }

  async tick(): Promise<void> {
    if (!this.paperVenue) return;
    try {
      this.reconcileNet();
      this.reconcileFills();
    } catch (err) {
      this.logger.error(`reconciliation tick failed: ${(err as Error).message}`);
    }
  }

  private reconcileNet(): void {
    if (!this.paperVenue) return;
    const internal = this.internalBook();
    const now = new Date();
    for (const i of internal) {
      const paperNet = this.paperVenue.netNotional(i.symbol);
      if (paperNet !== i.netNotionalUnits) {
        this.push({
          kind: 'NET_DRIFT',
          symbol: i.symbol,
          at: now,
          detail: {
            internalNet: i.netNotionalUnits.toString(),
            paperNet: paperNet.toString(),
            delta: (i.netNotionalUnits - paperNet).toString(),
          },
        });
      }
    }
  }

  private reconcileFills(): void {
    if (!this.paperVenue) return;
    const internalKeys = new Set<string>();
    for (const i of this.internalBook()) for (const k of i.idempotencyKeys) internalKeys.add(k);

    const paperBook = this.paperVenue.bookSnapshot();
    const paperKeys = new Set(paperBook.map((o) => o.idempotencyKey));

    const now = new Date();
    // Paper has it, internal doesn't.
    for (const o of paperBook) {
      if (!internalKeys.has(o.idempotencyKey)) {
        this.push({
          kind: 'MISSING_FILL',
          symbol: o.symbol,
          at: now,
          detail: { idempotencyKey: o.idempotencyKey, notionalUnits: o.notionalUnits.toString() },
        });
      }
    }
    // Internal has it, paper doesn't.
    for (const k of internalKeys) {
      if (!paperKeys.has(k)) {
        this.push({
          kind: 'GHOST_FILL',
          symbol: '?',
          at: now,
          detail: { idempotencyKey: k },
        });
      }
    }
  }

  private push(e: DriftEvent): void {
    this.events.push(e);
    if (this.events.length > 2 * RECENT_LIMIT) this.events = this.events.slice(-RECENT_LIMIT);
    this.logger.warn(`drift ${e.kind} on ${e.symbol}: ${JSON.stringify(e.detail)}`);
  }
}
