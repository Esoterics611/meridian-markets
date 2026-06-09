import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { MmPortfolioTrader, MmPortfolioSnapshot } from '../live/mm-portfolio-trader';
import { MmNavRepository, MmNavInsert } from './mm-nav.repository';

// MmNavCron — the durable NAV / equity-curve writer (Telemetry P3). Each interval
// it reads the live MM desk snapshot() and appends one DESK row + one row per book
// to mm_nav, building the multi-day track record that survives restart (the
// research deliverable, FR-9). Same setInterval shape as StatArbNavCron, but a
// *per-interval* series (not per-day) — every tick is a row, no idempotency dedupe.
//
// DC-3 (read the ledger, don't duplicate it): every value is DERIVED from
// snapshot() at write time — the cron owns no accounting state of its own. The
// desk row's equity therefore equals the live `meridian_desk_nav_units` gauge to
// the unit (the §8 acceptance criterion), because both read the same snapshot.
//
// It is a strict no-op unless persistence is on AND a repo (DB) is present, so a
// no-DB run / MM_PERSIST=off behaves exactly as before.

@Injectable()
export class MmNavCron implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MmNavCron.name);
  private handle: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: ConfigService,
    private readonly trader: MmPortfolioTrader,
    // Null when MM_PERSIST is off or no DbService is wired ⇒ the cron no-ops.
    private readonly repo: MmNavRepository | null,
  ) {}

  onModuleInit(): void {
    if (!this.repo) return; // persistence off / no DB ⇒ no durable NAV, no timer
    const app = this.cfg.getOrThrow<AppConfig>('app');
    if (app.nodeEnv === 'test') return; // tests drive tick() explicitly
    const intervalMs = app.marketMaking.navIntervalMs;
    this.handle = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.logger.log(`mm NAV cron started: every ${intervalMs}ms (append-only mm_nav, desk + per-book)`);
  }

  onModuleDestroy(): void {
    if (this.handle) clearInterval(this.handle);
  }

  /** One interval: persist the desk + per-book equity snapshot. Never throws. */
  async tick(now: Date = new Date()): Promise<void> {
    if (!this.repo) return;
    try {
      const snap = this.trader.snapshot();
      const rows = navRowsFromSnapshot(snap, now);
      const n = await this.repo.insertNavSnapshot(rows);
      this.logger.log(`mm NAV booked: ${n} row(s) (desk + ${n - 1} book(s)) asOf=${now.toISOString()}`);
      // DR-3: a compact, grep-able F3 line each interval so a post-run `grep 'F3 toxicity'`
      // answers "did the adverse-selection defence fire?" — Journal #44 found it invisible.
      const tox = f3Summary(snap);
      if (tox) this.logger.log(`F3 toxicity: ${tox}`);
    } catch (err) {
      this.logger.error(`mm NAV tick failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Map a desk snapshot to the rows to persist: ONE desk-aggregate row (bookKey '')
 * whose equity equals snapshot.equityUnits — the same number the telemetry
 * collector writes to `meridian_desk_nav_units` — followed by one row per book.
 * Pure + exported so the unit test can assert the mapping without a DB.
 *
 * The desk row's inventory_units / max_drawdown_pct are aggregated from the per-
 * book snapshot data (summed signed inventory; worst per-book drawdown) since the
 * snapshot has no single desk inventory/peak — derived at write time, never a
 * parallel accounting path. The true desk-equity drawdown is always recoverable
 * from the persisted equity curve itself.
 */
/**
 * A compact, grep-able F3 toxicity line (DR-3): per fast-path book, how often the half-spread
 * was widened / tightened, the mean scale, and the worst widen — so a post-run
 * `grep 'F3 toxicity'` answers "did the adverse-selection defence actually fire?" (Journal #44
 * found 0 widen-events and couldn't tell). Returns null when no book carries the scaler (bar
 * path / feature off) ⇒ no line logged. Pure + exported for the unit test.
 */
export function f3Summary(s: MmPortfolioSnapshot): string | null {
  const parts = s.books
    .filter((b) => b.toxicity)
    .map(
      (b) =>
        `${b.symbol} widen=${b.toxicity!.widenSteps} tighten=${b.toxicity!.tightenSteps} ` +
        `avg=${b.toxicity!.avgScale.toFixed(2)} max=${b.toxicity!.maxScale.toFixed(2)} last=${b.toxicity!.lastScale.toFixed(2)}`,
    );
  return parts.length ? parts.join(' | ') : null;
}

export function navRowsFromSnapshot(s: MmPortfolioSnapshot, asOf: Date): MmNavInsert[] {
  let deskInventory = 0n;
  let worstDrawdownPct = 0;
  for (const b of s.books) {
    deskInventory += BigInt(b.inventoryUnits);
    if (b.maxDrawdownPct > worstDrawdownPct) worstDrawdownPct = b.maxDrawdownPct;
  }

  const desk: MmNavInsert = {
    asOf,
    bookKey: '',
    equityUnits: BigInt(s.equityUnits),
    netPnlUnits: BigInt(s.netPnlUnits),
    realisedPnlUnits: BigInt(s.realisedPnlUnits),
    unrealisedPnlUnits: BigInt(s.unrealisedPnlUnits),
    feesUnits: BigInt(s.feesUnits),
    fundingUnits: BigInt(s.fundingUnits),
    inventoryUnits: deskInventory,
    maxDrawdownPct: worstDrawdownPct,
  };

  const perBook: MmNavInsert[] = s.books.map((b) => ({
    asOf,
    bookKey: b.symbol,
    equityUnits: BigInt(b.equityUnits),
    netPnlUnits: BigInt(b.netPnlUnits),
    realisedPnlUnits: BigInt(b.realisedPnlUnits),
    unrealisedPnlUnits: BigInt(b.unrealisedPnlUnits),
    feesUnits: BigInt(b.feesUnits),
    fundingUnits: BigInt(b.fundingUnits),
    inventoryUnits: BigInt(b.inventoryUnits),
    maxDrawdownPct: b.maxDrawdownPct,
  }));

  return [desk, ...perBook];
}
