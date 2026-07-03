import { CarryDeskView } from '../../market-making/carry/carry-read.service';
import { livenessBanner, renderCarryLive, renderCarryPage } from './carry-desk-view';

// Pure render → assert HTML (UI_ARCHITECTURE §10). The states that matter most are
// the HONEST ones: DOWN (the #92 stall must scream), dbOff, IDLE, CLOSED rows visible.

const NOW = 1_783_100_000_000;

function view(over: Partial<CarryDeskView> = {}): CarryDeskView {
  return {
    dbOff: false,
    liveness: { state: 'LIVE', ageMs: 60_000 },
    books: [
      {
        symbol: 'AAVE', direction: 'SHORT_PERP', status: 'OPEN', gateAnnualizedPct: 9.27,
        openedMs: NOW - 3_600_000, fundingUnits: '5730974', feesUnits: '21509691',
        realisedUnits: '0', realisedFirstUnits: '-15778717', basisMtmUnits: '-12000000',
        updatedMs: NOW - 60_000,
      },
      {
        symbol: 'LIT', direction: 'SHORT_PERP', status: 'CLOSED', gateAnnualizedPct: 12.13,
        openedMs: NOW - 7_200_000, fundingUnits: '5290000', feesUnits: '41140000',
        realisedUnits: '304130000', realisedFirstUnits: '268280000', basisMtmUnits: null,
        updatedMs: NOW - 300_000,
      },
    ],
    desk: {
      realisedFirstUnits: '252501283', fundingUnits: '11020974', feesUnits: '62649691',
      basisMtmUnits: '-12000000', maxDrawdownPct: 0.328, openCount: 1, closedCount: 1,
    },
    asOfMs: NOW,
    ...over,
  };
}

describe('livenessBanner', () => {
  it('LIVE renders green with the checkpoint age', () => {
    const h = livenessBanner(view()).value;
    expect(h).toContain('DESK LIVE');
    expect(h).toContain('badge--allow');
    expect(h).toContain('1m 00s ago');
  });

  it('DOWN renders red and tells the operator how to relaunch (the #92 lesson)', () => {
    const h = livenessBanner(view({ liveness: { state: 'DOWN', ageMs: 3 * 3_600_000 } })).value;
    expect(h).toContain('DESK DOWN');
    expect(h).toContain('badge--deny');
    expect(h).toContain('launch-carry-30d.sh');
    expect(h).toContain('INERT'); // the kill-switch/re-gate warning
  });

  it('IDLE is a neutral state, not an alarm', () => {
    const h = livenessBanner(view({ liveness: { state: 'IDLE', ageMs: null } })).value;
    expect(h).toContain('DESK IDLE');
    expect(h).toContain('badge--paper');
  });
});

describe('renderCarryLive', () => {
  it('shows the judged number and keeps CLOSED books visible with realised P&L', () => {
    const h = renderCarryLive(view()).value;
    expect(h).toContain('realised-first (judged)');
    expect(h).toContain('AAVE');
    expect(h).toContain('LIT');
    expect(h).toContain('CLOSED');
    expect(h).toContain('+$268.28'); // the LIT close stays on screen — honesty rule
  });

  it('marks a CLOSED book’s basis MTM as — (no live mark to report)', () => {
    const h = renderCarryLive(view()).value;
    // the LIT row has basisMtmUnits null ⇒ an em-dash cell instead of a number
    expect(h.split('LIT')[1]).toContain('—');
  });

  it('dbOff renders the DB-off panel and no fabricated zeros', () => {
    const h = renderCarryLive(view({ dbOff: true })).value;
    expect(h).toContain('DB OFF');
    expect(h).toContain('docker compose up -d postgres');
    expect(h).not.toContain('realised-first (judged)');
  });

  it('an empty (IDLE) desk says so in the table instead of faking rows', () => {
    const h = renderCarryLive(view({ books: [], liveness: { state: 'IDLE', ageMs: null } })).value;
    expect(h).toContain('no carry books yet');
  });
});

describe('renderCarryPage', () => {
  it('is a full document with the SSE region, NAV spark on @carry, and the runbook palette', () => {
    const h = renderCarryPage(view());
    expect(h).toContain('desk-feed src="/desk/carry/stream"');
    expect(h).toContain('nav-spark book="@carry"');
    expect(h).toContain('launch-carry-30d.sh');
    expect(h).toContain('carry-close-book.ts');
    expect(h).toContain('CARRY_DESK_OPERATOR_MANUAL.md');
  });
});
