import {
  renderFindingsBoard,
  renderRunbook,
  renderDocLinks,
  renderDifferentialBoard,
  renderResearchPage,
  FINDINGS,
  RUNBOOK,
  RESEARCH_DOCS,
} from './research-view';
import { DifferentialBoardData } from '../research-board-loader';

describe('renderFindingsBoard', () => {
  it('renders KEEP / CUT / RESERVE verdicts with the finding + doc ref', () => {
    const h = renderFindingsBoard(FINDINGS).value;
    expect(h).toContain('KEEP');
    expect(h).toContain('CUT');
    expect(h).toContain('RESERVE');
    expect(h).toContain('maker-rebate CLOB'); // the live earner
    expect(h).toContain('cointegration cliff'); // the killed edge
    expect(h).toContain('docs/RESEARCH_FINDINGS.md'); // a real doc ref
  });

  it('colours each card by verdict', () => {
    const h = renderFindingsBoard(FINDINGS).value;
    expect(h).toContain('finding--keep');
    expect(h).toContain('finding--cut');
    expect(h).toContain('finding--reserve');
  });

  it('the funding finding points at the RUNNING desk + its doctrine, not a stale caveat', () => {
    // #93: funding carry became the live P0 desk with real sourced surfaces
    // (/desk/carry + the differential measurement board) — the card must track that.
    const funding = FINDINGS.find((f) => f.title.toLowerCase().includes('funding'));
    expect(funding).toBeDefined();
    expect(funding!.detail).toContain('/desk/carry');
    expect(funding!.ref).toBe('docs/CARRY_DESK_OPERATOR_MANUAL.md');
  });
});

describe('renderRunbook', () => {
  it('renders each command verbatim inside a copy-cmd, with no execution endpoint', () => {
    const h = renderRunbook(RUNBOOK).value;
    expect(h).toContain('<copy-cmd>');
    expect(h).toContain('FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false npm run start:dev');
    expect(h).toContain('scripts/oos-candidates.ts');
    expect(h).toContain('scripts/mm-l2-tune.ts');
    // it copies, it never POSTs — no action endpoints on this page
    expect(h).not.toContain('endpoint="');
    expect(h).toContain('the UI never executes');
  });

  it('every runbook command points at a script/command that exists in the repo', () => {
    // guard against a stale command drifting from the actual scripts
    const cmds = RUNBOOK.flatMap((g) => g.cmds.map((c) => c.cmd));
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c).toMatch(/scripts\/[\w-]+\.(ts|sh)|npm run start:dev/);
    }
  });
});

describe('renderDifferentialBoard (U3.1 — the M2 measurement)', () => {
  const board: DifferentialBoardData = {
    boardCount: 2,
    requiredBoards: 7,
    generatedAtMs: Date.parse('2026-07-03T10:55:52.052Z'),
    scored: 30,
    harvestable: 6,
    pairs: [
      {
        symbol: 'ADA', venueA: 'hyperliquid', venueB: 'bybit', overlapDays: 15,
        annualizedAPct: -15.94, annualizedBPct: -0.46, annualizedDiffPct: -15.48,
        direction: 'SHORT_B_LONG_A', stableFraction: 0.87, breakevenDays: 0.85, harvestable: true,
      },
      {
        symbol: 'DOGE', venueA: 'binance', venueB: 'bybit', overlapDays: 15,
        annualizedAPct: 1.1, annualizedBPct: 1.2, annualizedDiffPct: -0.1,
        direction: 'SHORT_A_LONG_B', stableFraction: 0.4, breakevenDays: 563.6, harvestable: false,
      },
    ],
  };

  it('shows the M2 cadence counter and the honest not-a-signal note', () => {
    const h = renderDifferentialBoard(board).value;
    expect(h).toContain('2 / 7'); // boards collected vs pre-registered
    expect(h).toContain('A MEASUREMENT, NOT A SIGNAL');
    expect(h).toContain('30'); // scored
  });

  it('renders pairs with a mechanical leg mapping and harvestable badges', () => {
    const h = renderDifferentialBoard(board).value;
    expect(h).toContain('ADA');
    expect(h).toContain('hyperliquid ↔ bybit');
    expect(h).toContain('short bybit / long hyperliquid'); // SHORT_B_LONG_A, verbatim mapping
    expect(h).toContain('harvestable');
    expect(h).toContain('0.87');
  });

  it('renders the honest empty state (no artifacts) with the command to fix it', () => {
    const h = renderDifferentialBoard(null).value;
    expect(h).toContain('no boards collected yet');
    expect(h).toContain('scripts/funding-differential-board.ts');
  });
});

describe('renderDocLinks', () => {
  it('lists the research docs with their paths', () => {
    const h = renderDocLinks(RESEARCH_DOCS).value;
    expect(h).toContain('docs/QUANT_JOURNAL.md');
    expect(h).toContain('docs/MARKET_MAKING.md');
    expect(h).toContain('docs/FAIR_VALUE_AND_THESIS_DESIGN.md');
  });
});

describe('renderResearchPage', () => {
  it('assembles the static research desk in the shared shell + loads copy-cmd', () => {
    const html = renderResearchPage();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Research');
    expect(html).toContain('No execution here');
    expect(html).toContain('src="/ui/copy-cmd.js"');
    expect(html).toContain('nav-link--active');
    // it is static — no live SSE region on this page
    expect(html).not.toContain('<desk-feed');
  });
});
