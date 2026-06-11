// The role launcher (`/`) — the index that replaces the old "redirect to /demo"
// root. It is pure static chrome: a card per role page pointing at its URL, with
// the not-yet-built ones (pm) rendered as disabled "soon" cards so the launcher
// tells the truth about what exists (CLAUDE.md §1 — honest nav, no dead links).
//
// One pure export: renderLandingPage() — no engine data, so it is trivially
// unit-tested (render → assert HTML, UI_ARCHITECTURE.md §10).
import { html, raw, SafeHtml } from './html';
import { pageShell } from './layout';

export interface LauncherEntry {
  href: string;
  label: string;
  /** One-line description of what the page is for. */
  blurb: string;
  /** False ⇒ rendered as a disabled "soon" card (not built yet). */
  live: boolean;
}

// The role pages, in operator-priority order. Mirrors ROLE_LINKS in layout.ts but
// carries the blurb each card shows. Keep the two in sync when a page goes live.
export const LAUNCHER_ENTRIES: LauncherEntry[] = [
  { href: '/exec', label: 'exec', blurb: 'Executive overview — desk NAV, net P&L, drawdown vs the 2% budget. Read-only.', live: true },
  { href: '/ops', label: 'ops', blurb: 'Operator console — process / feed / DB health + start · stop · flatten the desk.', live: true },
  { href: '/desk/mm', label: 'desk · mm', blurb: 'Market-making desk — per-book quotes, 4-component PnL attribution, launch / remove books.', live: true },
  { href: '/desk/markout', label: 'desk · markout', blurb: 'Markout / TCA — per-book multi-horizon markout curves by side + the F3 reaction. Am I getting picked off?', live: true },
  { href: '/desk/toxicity', label: 'desk · toxicity', blurb: 'Flow toxicity — VPIN gauges (warmed-aware), F3 scale, signed imbalances + 15-min strips.', live: true },
  { href: '/desk/statarb', label: 'desk · statarb', blurb: 'Stat-arb desk — per-pair z / β / regime, the persisted blotter, launch / remove pairs.', live: true },
  { href: '/risk', label: 'risk', blurb: 'Risk console — drawdown, net / gross exposure, verdict feed + the cross-desk kill switch.', live: true },
  { href: '/research', label: 'research', blurb: 'Research desk — findings KEEP / CUT board + copy-the-runbook-command (no execution).', live: true },
  { href: '/pm', label: 'pm', blurb: 'PM / house view — the thesis register. Waiting on the engine surface (not built yet).', live: false },
];

function launchCard(e: LauncherEntry): SafeHtml {
  const inner = html`
    <span class="launch-h">
      <span class="launch-label">${e.label}</span>
      ${e.live ? html`<span class="launch-go">open →</span>` : html`<span class="badge badge--pause">soon</span>`}
    </span>
    <span class="launch-blurb">${e.blurb}</span>
  `;
  if (!e.live) return html`<span class="launch-card launch-card--soon" title="not built yet">${inner}</span>`;
  return html`<a class="launch-card" href="${e.href}">${inner}</a>`;
}

/** The full `/` document: shared shell + the role-card grid. No engine data, no SSE. */
export function renderLandingPage(): string {
  const body = html`
    <h1 class="page-title">Meridian — paper desk</h1>
    <p class="research-intro dim">
      An AI-agent-run quant desk, paper-trading live market data. Pick a role console below — every
      number on every page traces to an engine endpoint (the UI holds no business state). <span class="badge badge--paper">PAPER</span>
    </p>
    <section class="launcher-grid">${LAUNCHER_ENTRIES.map(launchCard)}</section>
    <p class="asof dim">thin read-only view over the engine · <code>/demo</code> still runs alongside until parity</p>
  `;
  return pageShell({ title: 'Meridian · launcher', activeHref: '/', body: raw(body.value) });
}
