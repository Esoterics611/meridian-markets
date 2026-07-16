// The /learn hub (UI_REWRITE_PLAN_III P3, §5.6) — the academy front door: the two
// courses (served same-origin, D2), the curriculum map from learning stop → live
// page + chapter, the guided tours, and the on-site glossary rendered from the
// explain registry. Static by design: no live data, no execution surface. The
// URLs and ids here are the stable teaching surface (docs/TEACHING_SURFACE.md) —
// mendy-hq prompt seeds point at them; don't rename casually.
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';
import { EXPLAIN_GROUPS, EXPLAIN_REGISTRY, explainEntry } from './explain-registry';

interface Chapter {
  file: string;
  title: string;
}
interface Course {
  id: 'market-making' | 'stat-arb';
  title: string;
  blurb: string;
  chapters: Chapter[];
}

export const COURSES: Course[] = [
  {
    id: 'market-making',
    title: 'Market Making',
    blurb: 'The desk’s earner, taught from zero: microstructure, Avellaneda–Stoikov, execution, risk, and the fair-value findings this desk actually validated live.',
    chapters: [
      { file: '00-charter-and-sources.html', title: '0 · Charter & sources' },
      { file: '01-introduction.html', title: '1 · Introduction' },
      { file: '02-microstructure.html', title: '2 · Microstructure' },
      { file: '03-avellaneda-stoikov.html', title: '3 · Avellaneda–Stoikov' },
      { file: '04-execution.html', title: '4 · Execution' },
      { file: '05-risk.html', title: '5 · Risk' },
      { file: '06-backtesting.html', title: '6 · Backtesting' },
      { file: '07-production.html', title: '7 · Production' },
      { file: '08-the-meridian-desk-stack.html', title: '8 · The Meridian desk stack' },
      { file: '09-the-fair-value-result.html', title: '9 · The fair-value result' },
      { file: '10-the-fair-value-engine.html', title: '10 · The fair-value engine' },
      { file: '11-directional-market-making.html', title: '11 · Directional market making' },
    ],
  },
  {
    id: 'stat-arb',
    title: 'Statistical Arbitrage',
    blurb: 'The diversifier: cointegration, the OU process, honest backtesting, and the equities pivot — including the finding that killed crypto taker stat-arb.',
    chapters: [
      { file: '00-charter-and-sources.html', title: '0 · Charter & sources' },
      { file: '01-introduction.html', title: '1 · Introduction' },
      { file: '02-cointegration.html', title: '2 · Cointegration' },
      { file: '03-ou-process.html', title: '3 · The OU process' },
      { file: '04-execution.html', title: '4 · Execution' },
      { file: '05-risk.html', title: '5 · Risk' },
      { file: '06-backtesting.html', title: '6 · Backtesting' },
      { file: '07-production.html', title: '7 · Production' },
      { file: '08-more-strategies.html', title: '8 · More strategies' },
      { file: '09-testing-in-meridian.html', title: '9 · Testing in Meridian' },
      { file: '10-equities-stat-arb.html', title: '10 · Equities stat-arb' },
    ],
  },
];

/** Learning stop → the live surface + the chapter (the plan §5.6 map; mendy-hq's
 *  curriculum anchors mirror these rows). */
const CURRICULUM_MAP: { stop: string; live: { href: string; label: string }; course: { href: string; label: string } | null }[] = [
  { stop: 'a price is a live thing', live: { href: '/markets', label: '/markets — the strip' }, course: null },
  { stop: 'bid, ask, spread, the order book', live: { href: '/markets?tour=1', label: '/markets — the depth ladder (tour)' }, course: { href: '/courses/market-making/02-microstructure.html', label: 'MM ch.2' } },
  { stop: 'what a market maker does', live: { href: '/desk/mm?tour=1', label: '/desk/mm (tour)' }, course: { href: '/courses/market-making/01-introduction.html', label: 'MM ch.1–2' } },
  { stop: 'fair value & adverse selection', live: { href: '/desk/markout', label: '/desk/markout — the pick-off read' }, course: { href: '/courses/market-making/09-the-fair-value-result.html', label: 'MM ch.9–10' } },
  { stop: 'pairs, cointegration, z-score', live: { href: '/desk/statarb', label: '/desk/statarb — the pair charts' }, course: { href: '/courses/stat-arb/02-cointegration.html', label: 'stat-arb ch.2–3' } },
  { stop: 'a killed strategy is a finding', live: { href: '/research', label: '/research — the CUT board' }, course: { href: '/courses/stat-arb/06-backtesting.html', label: 'stat-arb ch.6' } },
  { stop: 'risk = bounded loss', live: { href: '/risk?tour=1', label: '/risk (tour)' }, course: { href: '/courses/market-making/05-risk.html', label: 'MM ch.5' } },
  { stop: 'carry — being paid to hold', live: { href: '/desk/carry', label: '/desk/carry — the accrual staircase' }, course: { href: '/courses/stat-arb/08-more-strategies.html', label: 'stat-arb ch.8' } },
];

const TOURS = [
  { href: '/desk/mm?tour=1', label: 'tour the market-making desk' },
  { href: '/markets?tour=1', label: 'tour the market terminal' },
  { href: '/risk?tour=1', label: 'tour the risk console' },
];

/** The drawer fragment behind GET /learn/explain/:id — null for unknown ids (404). */
export function renderExplainFragment(id: string): SafeHtml | null {
  const e = explainEntry(id);
  if (!e) return null;
  return html`
    <h3 class="xdrawer-term">${e.term}</h3>
    <p class="xdrawer-text">${e.oneLiner}</p>
    ${e.more ? html`<a class="xdrawer-more" href="${e.more.href}">read more → ${e.more.label}</a>` : ''}
  `;
}

function courseCard(c: Course): SafeHtml {
  const chapters = raw(c.chapters.map((ch) => html`<li><a href="/courses/${c.id}/${ch.file}">${ch.title}</a></li>`.value).join(''));
  return html`
    <div class="panel learn-course">
      <div class="panel-h">course — ${c.title}</div>
      <p class="dim">${c.blurb}</p>
      <ul class="learn-chapters">${chapters}</ul>
      <p class="dim hint">served from this desk (same origin) when the course site is built; the page says so honestly otherwise.</p>
    </div>
  `;
}

function glossary(): SafeHtml {
  const groups = EXPLAIN_GROUPS.map((g) => {
    const rows = Object.entries(EXPLAIN_REGISTRY)
      .filter(([, e]) => e.group === g)
      .map(
        ([id, e]) => html`
          <div class="learn-term" id="term-${id}">
            <span class="learn-term-name mono">${e.term}</span>
            <span class="learn-term-def">${e.oneLiner} ${e.more ? html`<a href="${e.more.href}">${e.more.label} →</a>` : ''}</span>
          </div>
        `.value,
      )
      .join('');
    return html`<div class="learn-group"><div class="panel-h">${g}</div>${raw(rows)}</div>`.value;
  });
  return raw(groups.join(''));
}

/** The full /learn document. */
export function renderLearnPage(): string {
  const mapRows = raw(
    CURRICULUM_MAP.map(
      (r) => html`
        <tr>
          <td>${r.stop}</td>
          <td><a href="${r.live.href}">${r.live.label}</a></td>
          <td>${r.course ? html`<a href="${r.course.href}">${r.course.label}</a>` : html`<span class="dim">—</span>`}</td>
        </tr>
      `.value,
    ).join(''),
  );
  const tours = raw(TOURS.map((t) => html`<a class="launch-card" href="${t.href}"><span class="launch-h"><span class="launch-label">${t.label}</span><span class="launch-go">start →</span></span></a>`.value).join(''));
  const body = html`
    <h1 class="page-title">Learn — the academy hub</h1>
    <p class="research-intro dim">
      This desk is a <b>paper-trading</b> quant desk on real market data — real prices, simulated fills,
      honest numbers (an inflated demo would be worthless, so the whole house discipline is keeping the
      P&amp;L truthful). Everything on these pages can explain itself: click any <span class="mono">ⓘ</span>,
      or press <b>learn</b> in the top bar to switch on captions everywhere. Nothing here is financial
      advice and nothing here touches real money.
    </p>
    <section class="learn-courses">${courseCard(COURSES[0])}${courseCard(COURSES[1])}</section>
    <section class="panel">
      <div class="panel-h">the learning path — concept → live surface → chapter</div>
      <table class="book-table">
        <thead><tr><th>learning stop</th><th>see it live</th><th>read the chapter</th></tr></thead>
        <tbody>${mapRows}</tbody>
      </table>
    </section>
    <section class="panel">
      <div class="panel-h">guided tours (spotlight walkthroughs on the live pages)</div>
      <section class="launcher-grid">${tours}</section>
    </section>
    <section class="panel">
      <div class="panel-h">glossary — every ⓘ on the desk, in one place</div>
      ${glossary()}
    </section>
  `;
  return pageShell({ title: 'Meridian · learn', activeHref: '/learn', body: raw(body.value) });
}
