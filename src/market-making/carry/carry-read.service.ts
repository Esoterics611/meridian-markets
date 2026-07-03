import { Injectable, Optional } from '@nestjs/common';
import { DbService } from '@database/db.service';
import { CarryDirection } from '../../market-data/funding/funding-carry-discovery';
import { FundingCarryBookState } from './funding-carry-book';

// CarryReadService — the read-only projection of the carry desk for the UI
// (UI_REWRITE_PLAN_II U1). The carry desk runs as a SEPARATE supervised process
// (scripts/carry-desk-live.ts); the Nest app neither drives nor owns it. What the
// app CAN do — and what #92 proved it must do — is read the desk's durable
// checkpoints (carry_book_state + mm_nav desk='carry') and answer the
// supervisor's two questions: "is the desk alive?" and "what is it holding?".
//
// Liveness is derived from checkpoint age: the runner checkpoints every poll
// (60s), so a fresh `updated_at` IS the heartbeat. No DB / no rows are honest
// states of their own (dbOff / IDLE), never faked.

/** The int-spec's well-known fixture symbol — excluded from every read (see
 *  postgres-carry-state-store.int-spec.ts, which upserts this one row per run). */
export const CARRY_TEST_FIXTURE_SYMBOL = 'ITFIXTURE';

/** Runner checkpoint cadence is 60s: <3min = LIVE, <15min = STALE, else DOWN. */
export const CARRY_LIVE_MAX_MS = 3 * 60_000;
export const CARRY_STALE_MAX_MS = 15 * 60_000;

export type CarryLivenessState = 'LIVE' | 'STALE' | 'DOWN' | 'IDLE';

export interface CarryLiveness {
  state: CarryLivenessState;
  /** Age of the newest OPEN-book checkpoint; null when no book is open (IDLE). */
  ageMs: number | null;
}

/** The #92 stall, as a classifier: checkpoint age → is the desk process alive? */
export function classifyCarryLiveness(newestOpenCheckpointMs: number | null, nowMs: number): CarryLiveness {
  if (newestOpenCheckpointMs === null) return { state: 'IDLE', ageMs: null };
  const ageMs = Math.max(0, nowMs - newestOpenCheckpointMs);
  if (ageMs < CARRY_LIVE_MAX_MS) return { state: 'LIVE', ageMs };
  if (ageMs < CARRY_STALE_MAX_MS) return { state: 'STALE', ageMs };
  return { state: 'DOWN', ageMs };
}

/** One carry_book_state row, DB-typed. */
export interface CarryStateRow {
  symbol: string;
  direction: CarryDirection;
  gateAnnualizedPct: number;
  status: 'OPEN' | 'CLOSED';
  state: FundingCarryBookState;
  updatedMs: number;
}

/** Latest mm_nav row per '@carry…' book_key (basis MTM for open books + desk aggregate). */
export interface CarryNavLatest {
  bookKey: string;
  unrealisedUnits: bigint;
  maxDrawdownPct: number;
  asOfMs: number;
}

/** One book as the page shows it. Money as serialised 6-dec unit strings (format.ts dialect). */
export interface CarryBookView {
  symbol: string;
  direction: CarryDirection;
  status: 'OPEN' | 'CLOSED';
  gateAnnualizedPct: number;
  openedMs: number | null;
  fundingUnits: string;
  feesUnits: string;
  realisedUnits: string;
  /** realised − fees + funding — THE judged number (realised-first). */
  realisedFirstUnits: string;
  /** Latest checkpointed basis MTM (OPEN books; null when no nav row / CLOSED). */
  basisMtmUnits: string | null;
  updatedMs: number;
}

export interface CarryDeskView {
  /** True when the DB is absent/unreachable — the page says so, shows nothing else. */
  dbOff: boolean;
  liveness: CarryLiveness;
  books: CarryBookView[];
  desk: {
    realisedFirstUnits: string;
    fundingUnits: string;
    feesUnits: string;
    /** Sum of open books' checkpointed basis MTM. */
    basisMtmUnits: string;
    /** From the latest '@carry' aggregate nav row (as of the runner's last checkpoint). */
    maxDrawdownPct: number | null;
    openCount: number;
    closedCount: number;
  };
  asOfMs: number;
}

const sumLegs = (s: FundingCarryBookState, field: 'realisedUnits' | 'feesUnits'): bigint =>
  BigInt(s.spotLeg[field]) + BigInt(s.perpLeg[field]);

/** Pure assembly of the desk view — unit-tested without a DB. */
export function buildCarryDeskView(rows: CarryStateRow[], nav: CarryNavLatest[], nowMs: number): CarryDeskView {
  const navByKey = new Map(nav.map((n) => [n.bookKey, n]));
  let deskRealisedFirst = 0n;
  let deskFunding = 0n;
  let deskFees = 0n;
  let deskBasis = 0n;

  const books: CarryBookView[] = rows.map((r) => {
    const funding = BigInt(r.state.fundingUnits);
    const fees = sumLegs(r.state, 'feesUnits');
    const realised = sumLegs(r.state, 'realisedUnits');
    const realisedFirst = realised - fees + funding;
    const navRow = r.status === 'OPEN' ? navByKey.get(`@carry:${r.symbol.toUpperCase()}`) : undefined;
    deskRealisedFirst += realisedFirst;
    deskFunding += funding;
    deskFees += fees;
    if (navRow) deskBasis += navRow.unrealisedUnits;
    return {
      symbol: r.symbol,
      direction: r.direction,
      status: r.status,
      gateAnnualizedPct: r.gateAnnualizedPct,
      openedMs: r.state.openedMs,
      fundingUnits: funding.toString(),
      feesUnits: fees.toString(),
      realisedUnits: realised.toString(),
      realisedFirstUnits: realisedFirst.toString(),
      basisMtmUnits: navRow ? navRow.unrealisedUnits.toString() : null,
      updatedMs: r.updatedMs,
    };
  });

  const newestOpen = rows.filter((r) => r.status === 'OPEN').reduce<number | null>((m, r) => (m === null || r.updatedMs > m ? r.updatedMs : m), null);
  const aggregate = navByKey.get('@carry');
  return {
    dbOff: false,
    liveness: classifyCarryLiveness(newestOpen, nowMs),
    books,
    desk: {
      realisedFirstUnits: deskRealisedFirst.toString(),
      fundingUnits: deskFunding.toString(),
      feesUnits: deskFees.toString(),
      basisMtmUnits: deskBasis.toString(),
      maxDrawdownPct: aggregate ? aggregate.maxDrawdownPct : null,
      openCount: rows.filter((r) => r.status === 'OPEN').length,
      closedCount: rows.filter((r) => r.status === 'CLOSED').length,
    },
    asOfMs: nowMs,
  };
}

/** The honest empty view when no DB is wired/reachable. */
export function carryDbOffView(nowMs: number): CarryDeskView {
  return {
    dbOff: true,
    liveness: { state: 'IDLE', ageMs: null },
    books: [],
    desk: { realisedFirstUnits: '0', fundingUnits: '0', feesUnits: '0', basisMtmUnits: '0', maxDrawdownPct: null, openCount: 0, closedCount: 0 },
    asOfMs: nowMs,
  };
}

@Injectable()
export class CarryReadService {
  // NB: keep the param type a plain class (not a union) — Nest infers the injection
  // token from design:type, and a union emits Object. @Optional ⇒ null-DB configs boot.
  constructor(@Optional() private readonly db?: DbService) {}

  async deskView(nowMs = Date.now()): Promise<CarryDeskView> {
    if (!this.db) return carryDbOffView(nowMs);
    try {
      const [rows, nav] = await this.db.runInSerializableTransaction(async (em) => {
        const stateRows = await em.query<
          { symbol: string; direction: string; gate_annualized_pct: string; status: string; state: unknown; updated_ms: string }[]
        >(
          `SELECT symbol, direction, gate_annualized_pct, status, state,
                  (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ms
           FROM carry_book_state
           WHERE symbol <> $1
           ORDER BY (status = 'OPEN') DESC, updated_at DESC`,
          [CARRY_TEST_FIXTURE_SYMBOL],
        );
        const navRows = await em.query<
          { book_key: string; unrealised_pnl_units: string; max_drawdown_pct: string; as_of_ms: string }[]
        >(
          `SELECT DISTINCT ON (book_key) book_key, unrealised_pnl_units, max_drawdown_pct,
                  (EXTRACT(EPOCH FROM as_of) * 1000)::bigint AS as_of_ms
           FROM mm_nav
           WHERE desk = 'carry' AND book_key LIKE '@carry%'
           ORDER BY book_key, as_of DESC`,
        );
        return [stateRows, navRows] as const;
      });
      return buildCarryDeskView(
        rows.map((r) => ({
          symbol: r.symbol,
          direction: r.direction as CarryDirection,
          gateAnnualizedPct: Number(r.gate_annualized_pct),
          status: r.status as 'OPEN' | 'CLOSED',
          state: (typeof r.state === 'string' ? JSON.parse(r.state) : r.state) as FundingCarryBookState,
          updatedMs: Number(r.updated_ms),
        })),
        nav.map((n) => ({
          bookKey: n.book_key,
          unrealisedUnits: BigInt(n.unrealised_pnl_units),
          maxDrawdownPct: Number(n.max_drawdown_pct),
          asOfMs: Number(n.as_of_ms),
        })),
        nowMs,
      );
    } catch {
      // Unreachable DB ≠ an empty desk — say so, show nothing else.
      return carryDbOffView(nowMs);
    }
  }
}
