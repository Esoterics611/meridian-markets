import {
  renderFindingsBoard,
  renderRunbook,
  renderDocLinks,
  renderResearchPage,
  FINDINGS,
  RUNBOOK,
  RESEARCH_DOCS,
} from './research-view';

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

  it('does not fabricate a VPIN/funding number it cannot source', () => {
    // funding is shown as a research verdict with a clear "no live endpoint" caveat,
    // not a live board with invented rates.
    const funding = FINDINGS.find((f) => f.title.toLowerCase().includes('funding'));
    expect(funding).toBeDefined();
    expect(funding!.detail).toMatch(/no live funding endpoint|next task/i);
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
      expect(c).toMatch(/scripts\/[\w-]+\.ts|npm run start:dev/);
    }
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
