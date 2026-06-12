import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@config/app-config.interface';
import { MmPortfolioTrader, MmPortfolioSnapshot } from '../live/mm-portfolio-trader';
import { MmNavRepository, MmNavInsert } from './mm-nav.repository';
import { MmResearchRepository } from './mm-research.repository';

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

  /** Epoch ms of the last hedge-quality write (hourly cadence + a final shutdown write). */
  private lastQualityWriteMs = 0;
  private static readonly QUALITY_INTERVAL_MS = 60 * 60_000;

  constructor(
    private readonly cfg: ConfigService,
    private readonly trader: MmPortfolioTrader,
    // Null when MM_PERSIST is off or no DbService is wired ⇒ the cron no-ops.
    private readonly repo: MmNavRepository | null,
    // F0: hedge-leg P&L per interval + hedge-quality hourly/shutdown (DR-2 closure).
    private readonly research: MmResearchRepository | null = null,
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

  async onModuleDestroy(): Promise<void> {
    if (this.handle) clearInterval(this.handle);
    // F0 shutdown write: the hedge-quality KPI is otherwise in-memory only (DR-2) — run55's
    // basisShare audit was impossible because the server was down before the review. Best-effort.
    if (this.research) {
      try {
        const snap = this.trader.snapshot();
        if (snap.hedge) {
          await this.research.insertHedgeQuality(new Date(), snap.hedge);
          await this.research.insertHedgeNav(new Date(), snap.hedge);
        }
      } catch (err) {
        this.logger.error(`mm hedge shutdown write failed: ${(err as Error).message}`);
      }
    }
  }

  /** One interval: persist the desk + per-book equity snapshot. Never throws. */
  async tick(now: Date = new Date()): Promise<void> {
    if (!this.repo) return;
    try {
      const snap = this.trader.snapshot();
      // F0 sanity guard (run55 worst5m bug): during boot/relaunch a book can briefly mark its
      // inventory against a garbage mid (kPEPE unreal −$3.03M on a $1M book, 14:01–14:10Z) —
      // persisting that poisons the durable equity curve and every downstream worst-bucket /
      // drawdown read. A mark that exceeds the book's own capital is physically impossible
      // under the inventory caps, so the whole batch is SKIPPED (a 1-interval gap is honest;
      // a poisoned curve is not) and the offending book is named loudly.
      const insane = findInsaneMark(snap);
      if (insane) {
        this.logger.error(`NAV ▸ mark rejected — ${insane} — interval SKIPPED (corrupt mid, not P&L)`);
        return;
      }
      const rows = navRowsFromSnapshot(snap, now);
      const n = await this.repo.insertNavSnapshot(rows);
      this.logger.log(`mm NAV booked: ${n} row(s) (desk + ${n - 1} book(s)) asOf=${now.toISOString()}`);
      // F0: persist the hedge legs every interval + the quality KPI hourly.
      if (this.research && snap.hedge) {
        await this.research.insertHedgeNav(now, snap.hedge);
        if (now.getTime() - this.lastQualityWriteMs >= MmNavCron.QUALITY_INTERVAL_MS) {
          await this.research.insertHedgeQuality(now, snap.hedge);
          this.lastQualityWriteMs = now.getTime();
        }
      }
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
 * The corrupt-mark detector (F0, run55 worst5m root cause): a book whose |unrealised| exceeds
 * its own capital is marking against a bogus mid (inventory is capped at a fraction of capital,
 * so even a 100% adverse move cannot produce it). Returns a human-readable description of the
 * first offender, or null when the snapshot is sane. Pure + exported for the unit test.
 */
export function findInsaneMark(s: MmPortfolioSnapshot): string | null {
  for (const b of s.books) {
    const unreal = BigInt(b.unrealisedPnlUnits);
    const cap = BigInt(b.capitalUnits);
    const absUnreal = unreal < 0n ? -unreal : unreal;
    if (cap > 0n && absUnreal > cap) {
      return `${b.symbol} unrealised $${(Number(unreal) / 1e6).toFixed(0)} exceeds capital $${(Number(cap) / 1e6).toFixed(0)}`;
    }
  }
  return null;
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
