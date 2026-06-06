// The Quant / research role page (/research) — UI_REDESIGN_PROMPT.md §2/§5: the
// findings + KEEP/CUT board, the research-doc links, and the copy-the-runbook-command
// helper. **No execution** — research + long jobs run from the operator's terminal;
// this page only shows the exact command to copy (<copy-cmd>).
//
// This page is intentionally STATIC: its content is research artifacts (verdicts,
// commands, doc paths), not live engine state. A live funding board + the MM screener
// are deferred until they have a serving endpoint (today funding has none — we do not
// fabricate one). The KEEP/CUT verdicts are curated from docs/RESEARCH_FINDINGS.md +
// CLAUDE.md §8; the `ref` on each card is where to read the detail.
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';

export type Verdict = 'KEEP' | 'CUT' | 'RESERVE';

export interface Finding {
  verdict: Verdict;
  title: string;
  detail: string;
  ref: string;
}

// Sourced from docs/RESEARCH_FINDINGS.md + CLAUDE.md §8 (the consolidated findings).
// Update here when the journal verdict changes — this board must track the docs.
export const FINDINGS: Finding[] = [
  {
    verdict: 'KEEP',
    title: 'MM on a maker-rebate CLOB (Hyperliquid)',
    detail: 'The live earner — first net-positive honest-fill read (HL BTC tuned: +$345 / 2h / $1M, maxDD 0.53%, real WS aggressor flow + queue-aware fills + −0.2bps rebate).',
    ref: 'docs/MARKET_MAKING.md',
  },
  {
    verdict: 'KEEP',
    title: 'Fair-value (micro-price) + sub-second re-quote cadence',
    detail: 'The fix for adverse selection: naive spread MM loses at every width; micro-price center + fast re-quote flipped spread-vs-adverse −$1,020 (18s) → +$133 (sub-second) on an 8h window. One window, ~88% est. flow — the flip is robust, the exact number isn’t gospel.',
    ref: 'docs/FAIR_VALUE_AND_THESIS_DESIGN.md',
  },
  {
    verdict: 'KEEP',
    title: 'Funding carry (perp majors)',
    detail: 'Real but modest — ~3–8%/yr on majors, hold past breakeven. Live funding-board ingest (HL) is a next task; no live funding endpoint yet.',
    ref: 'docs/QUANT_JOURNAL.md',
  },
  {
    verdict: 'RESERVE',
    title: 'Options VRP',
    detail: 'Positive variance-risk premium; our BS Greeks match Deribit (validated). In reserve — not on the live loop.',
    ref: 'docs/RESEARCH_FINDINGS.md',
  },
  {
    verdict: 'CUT',
    title: 'Crypto taker stat-arb',
    detail: 'Killed — the cointegration cliff: a short-window artifact that collapses to ≈0 by 90–180d. Not a tradeable taker edge.',
    ref: 'docs/RESEARCH_FINDINGS.md',
  },
  {
    verdict: 'CUT',
    title: 'FX-stable basis (as a taker)',
    detail: 'Reverts reliably but sub-fee for a taker → route to a maker book, don’t take it.',
    ref: 'docs/RESEARCH_FINDINGS.md',
  },
  {
    verdict: 'KEEP',
    title: 'Equities sector stat-arb (forward-paper)',
    detail: 'Real but ~0.06 Sharpe and survivorship-bound — forward paper is the verdict, not a backtest claim. Watch the live curve.',
    ref: 'docs/EQUITIES_STATARB_PLAN.md',
  },
];

export interface RunbookCmd {
  label: string;
  cmd: string;
  note: string;
}

export interface RunbookGroup {
  group: string;
  cmds: RunbookCmd[];
}

// The exact terminal commands (CLAUDE.md "Run it"). These RUN IN THE TERMINAL — the
// page copies them, it does not execute them.
export const RUNBOOK: RunbookGroup[] = [
  {
    group: 'run the desk (paper, live data)',
    cmds: [
      {
        label: 'stat-arb + MM on the live loop',
        cmd: 'FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false npm run start:dev',
        note: 'then drive it from /desk/mm + /desk/statarb; watch /risk + /exec.',
      },
    ],
  },
  {
    group: 'honesty gates (DB-free)',
    cmds: [
      { label: 'quant research sweep', cmd: 'npx ts-node -r tsconfig-paths/register scripts/quant-research.ts', note: 'asset-class × strategy × entry-z × interval, gated by the historical-replay venue.' },
      { label: 'OOS candidates', cmd: 'npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts', note: 'deflated-Sharpe / PSR + purged k-fold + the survivorship gate.' },
      { label: 'cointegration stability map', cmd: 'npx ts-node -r tsconfig-paths/register scripts/cointegration-stability.ts', note: 'the cliff: β re-fit per train window, p-value vs horizon.' },
      { label: 'equities OOS (free Yahoo history)', cmd: 'OOS_SOURCE=yahoo npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts', note: 'decades of split/div-adjusted daily bars.' },
    ],
  },
  {
    group: 'market-making capture + tune',
    cmds: [
      { label: 'MM paper session', cmd: 'npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts', note: 'a quoter on the live loop, off real bars.' },
      { label: 'L2 capture session', cmd: 'npx ts-node -r tsconfig-paths/register scripts/mm-l2-session.ts', note: 'queue-aware fills off a real L2 tape.' },
      { label: 'γ/κ sweep + tune', cmd: 'npx ts-node -r tsconfig-paths/register scripts/mm-l2-tune.ts', note: 'turn one net-positive read into a distribution across regimes.' },
    ],
  },
];

export interface DocLink {
  title: string;
  path: string;
}

export const RESEARCH_DOCS: DocLink[] = [
  { title: 'Research findings (consolidated, citable)', path: 'docs/RESEARCH_FINDINGS.md' },
  { title: 'Quant journal (per-run numbers + artifact paths)', path: 'docs/QUANT_JOURNAL.md' },
  { title: 'Market-making desk', path: 'docs/MARKET_MAKING.md' },
  { title: 'Fair-value engine + thesis design', path: 'docs/FAIR_VALUE_AND_THESIS_DESIGN.md' },
  { title: 'Directional / axed maker strategy', path: 'docs/DIRECTIONAL_MM_STRATEGY.md' },
  { title: 'Weekly wrap (2026-06-05)', path: 'docs/WEEKLY_WRAP_2026-06-05.md' },
];

function verdictCard(f: Finding): SafeHtml {
  return html`
    <div class="finding finding--${f.verdict.toLowerCase()}">
      <div class="finding-h">
        <span class="badge badge--verdict-${f.verdict.toLowerCase()}">${f.verdict}</span>
        <span class="finding-title">${f.title}</span>
      </div>
      <p class="finding-detail">${f.detail}</p>
      <code class="finding-ref">${f.ref}</code>
    </div>
  `;
}

/** The KEEP / CUT / RESERVE findings board. */
export function renderFindingsBoard(findings: Finding[]): SafeHtml {
  return html`
    <section class="panel">
      <div class="panel-h">findings — KEEP / CUT / RESERVE</div>
      <div class="findings-grid">${findings.map(verdictCard)}</div>
    </section>
  `;
}

function cmdRow(c: RunbookCmd): SafeHtml {
  return html`
    <div class="cmd">
      <div class="cmd-h"><span class="cmd-label">${c.label}</span></div>
      <copy-cmd><code class="cmd-code">${c.cmd}</code></copy-cmd>
      <p class="cmd-note dim">${c.note}</p>
    </div>
  `;
}

/** The copy-the-runbook-command board (no execution — copies to clipboard). */
export function renderRunbook(groups: RunbookGroup[]): SafeHtml {
  return html`
    <section class="panel">
      <div class="panel-h">runbook — copy &amp; run in your terminal (the UI never executes)</div>
      ${groups.map(
        (g) => html`
          <div class="cmd-group">
            <div class="cmd-group-h dim">${g.group}</div>
            ${g.cmds.map(cmdRow)}
          </div>
        `,
      )}
    </section>
  `;
}

/** The research-doc reference list. */
export function renderDocLinks(docs: DocLink[]): SafeHtml {
  return html`
    <section class="panel">
      <div class="panel-h">research docs (read in your editor)</div>
      <ul class="doc-list">
        ${docs.map((d) => html`<li><span class="doc-title">${d.title}</span> <code>${d.path}</code></li>`)}
      </ul>
    </section>
  `;
}

/** The full /research document. Static reference + the copy-command helper; no SSE. */
export function renderResearchPage(): string {
  const body = html`
    <h1 class="page-title">Research — findings, runbook &amp; docs</h1>
    <p class="dim research-intro">
      Read-only research desk. <b>No execution here</b> — research + long jobs run from the terminal;
      copy a command below and run it. The KEEP/CUT board tracks <code>docs/RESEARCH_FINDINGS.md</code>.
    </p>
    ${renderFindingsBoard(FINDINGS)}
    ${renderRunbook(RUNBOOK)}
    ${renderDocLinks(RESEARCH_DOCS)}
  `;
  return pageShell({ title: 'Meridian · research', activeHref: '/research', body: raw(body.value) });
}
