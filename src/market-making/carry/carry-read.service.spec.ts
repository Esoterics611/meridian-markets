import {
  buildCarryDeskView,
  carryDbOffView,
  classifyCarryLiveness,
  CarryNavLatest,
  CarryStateRow,
  CARRY_LIVE_MAX_MS,
  CARRY_STALE_MAX_MS,
} from './carry-read.service';
import { FundingCarryBookState } from './funding-carry-book';

// The pure core of the /desk/carry read path (UI_REWRITE_PLAN_II U1): the #92
// liveness classifier and the desk-view assembly — no DB, no Nest.

const NOW = 1_783_100_000_000;

function state(over: Partial<FundingCarryBookState> = {}): FundingCarryBookState {
  return {
    symbol: 'AAVE',
    direction: 'SHORT_PERP',
    spotLeg: { feesUnits: '22509691', fillCount: 1, avgCostMicros: '87170000', realisedUnits: '0', inventoryUnits: '574267091' },
    perpLeg: { feesUnits: '-1000000', fillCount: 1, avgCostMicros: '87088000', realisedUnits: '0', inventoryUnits: '-574267091' },
    qtyUnits: '574267091',
    fundingUnits: '5730974',
    slippageUnits: '25554885',
    lastAccrualMs: NOW - 60_000,
    openedMs: NOW - 3_600_000,
    entrySpotMidMicros: '87105000',
    entryPerpMidMicros: '87067500',
    ...over,
  };
}

function row(over: Partial<CarryStateRow> = {}): CarryStateRow {
  return { symbol: 'AAVE', direction: 'SHORT_PERP', gateAnnualizedPct: 9.27, status: 'OPEN', state: state(), updatedMs: NOW - 60_000, ...over };
}

describe('classifyCarryLiveness — the #92 stall as a classifier', () => {
  it('LIVE when the newest open checkpoint is fresher than the live window', () => {
    expect(classifyCarryLiveness(NOW - 2 * 60_000, NOW)).toEqual({ state: 'LIVE', ageMs: 2 * 60_000 });
  });

  it('STALE between the live and stale windows (missed polls — investigate)', () => {
    expect(classifyCarryLiveness(NOW - 10 * 60_000, NOW).state).toBe('STALE');
  });

  it('DOWN past the stale window — the #92 case (3h10m unmonitored) reads DOWN', () => {
    const r = classifyCarryLiveness(NOW - 3.17 * 3_600_000, NOW);
    expect(r.state).toBe('DOWN');
    expect(r.ageMs).toBeGreaterThan(3 * 3_600_000);
  });

  it('IDLE when no book is open — not an error state', () => {
    expect(classifyCarryLiveness(null, NOW)).toEqual({ state: 'IDLE', ageMs: null });
  });

  it('window constants stay ordered (live < stale)', () => {
    expect(CARRY_LIVE_MAX_MS).toBeLessThan(CARRY_STALE_MAX_MS);
  });
});

describe('buildCarryDeskView', () => {
  it('computes realised-first = realised − fees + funding per book (the judged number)', () => {
    const v = buildCarryDeskView([row()], [], NOW);
    // fees = 22509691 + (−1000000) = 21509691; realised = 0; funding = 5730974
    expect(v.books[0].feesUnits).toBe('21509691');
    expect(v.books[0].realisedFirstUnits).toBe(String(0 - 21509691 + 5730974));
  });

  it('joins the latest nav basis MTM to OPEN books only, and sums it for the desk', () => {
    const nav: CarryNavLatest[] = [
      { bookKey: '@carry:AAVE', unrealisedUnits: -123_000_000n, maxDrawdownPct: 0.2, asOfMs: NOW - 60_000 },
      { bookKey: '@carry:LIT', unrealisedUnits: -1_054_000_000n, maxDrawdownPct: 0.3, asOfMs: NOW - 60_000 },
      { bookKey: '@carry', unrealisedUnits: -1_177_000_000n, maxDrawdownPct: 0.328, asOfMs: NOW - 60_000 },
    ];
    const closedLit = row({ symbol: 'LIT', status: 'CLOSED', state: state({ symbol: 'LIT' }) });
    const v = buildCarryDeskView([row(), closedLit], nav, NOW);
    expect(v.books.find((b) => b.symbol === 'AAVE')!.basisMtmUnits).toBe('-123000000');
    // CLOSED books carry no live basis mark — realised is the story.
    expect(v.books.find((b) => b.symbol === 'LIT')!.basisMtmUnits).toBeNull();
    expect(v.desk.basisMtmUnits).toBe('-123000000');
    // desk maxDD comes from the '@carry' aggregate row, as of the runner's checkpoint.
    expect(v.desk.maxDrawdownPct).toBeCloseTo(0.328);
  });

  it('desk sums include CLOSED books (realised history is desk P&L — the honesty rule)', () => {
    const closed = row({
      symbol: 'LIT',
      status: 'CLOSED',
      state: state({
        symbol: 'LIT',
        fundingUnits: '5290000',
        spotLeg: { feesUnits: '20000000', fillCount: 2, avgCostMicros: '0', realisedUnits: '-3590000', inventoryUnits: '0' },
        perpLeg: { feesUnits: '21140000', fillCount: 2, avgCostMicros: '0', realisedUnits: '307720000', inventoryUnits: '0' },
      }),
    });
    const v = buildCarryDeskView([closed], [], NOW);
    // realised-first = (−3.59 + 307.72) − (20 + 21.14) + 5.29 ≈ +268.28 (units)
    expect(v.books[0].realisedFirstUnits).toBe(String(-3590000 + 307720000 - 41140000 + 5290000));
    expect(v.desk.closedCount).toBe(1);
    expect(v.desk.openCount).toBe(0);
  });

  it('liveness reads from the newest OPEN checkpoint, ignoring CLOSED rows', () => {
    const staleClosed = row({ symbol: 'LIT', status: 'CLOSED', updatedMs: NOW - 1_000 });
    const oldOpen = row({ updatedMs: NOW - 4 * 3_600_000 });
    const v = buildCarryDeskView([oldOpen, staleClosed], [], NOW);
    expect(v.liveness.state).toBe('DOWN'); // the fresh CLOSED row must not mask a dead runner
  });

  it('no rows at all ⇒ IDLE with empty books, zero sums', () => {
    const v = buildCarryDeskView([], [], NOW);
    expect(v.liveness.state).toBe('IDLE');
    expect(v.books).toHaveLength(0);
    expect(v.desk.realisedFirstUnits).toBe('0');
    expect(v.desk.maxDrawdownPct).toBeNull();
  });
});

describe('carryDbOffView', () => {
  it('is explicit about the DB being off — not an empty desk', () => {
    const v = carryDbOffView(NOW);
    expect(v.dbOff).toBe(true);
    expect(v.books).toHaveLength(0);
  });
});
