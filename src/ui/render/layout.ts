// Shared page chrome for every role page: the document shell + the top bar with
// the role launcher. The top bar is the brief's shared component (§2) — brand,
// role nav, a client clock — rendered once as static chrome. The *numbers*
// (desk NAV, drawdown, armed/paused) live in each page's SSE-refreshed live
// region, not here, so the chrome never goes stale.
import { html, SafeHtml } from './html';

export interface RoleLink {
  href: string;
  label: string;
  /** False ⇒ rendered but disabled with a "soon" hint (honest: not yet built). */
  live: boolean;
}

// The seven role pages from UI_REDESIGN_PROMPT.md §2. Only the ones shipped so
// far are `live`; the rest render as disabled launcher entries so the nav tells
// the truth about what exists today (no dead links pretending to work).
export const ROLE_LINKS: RoleLink[] = [
  { href: '/exec', label: 'exec', live: true },
  { href: '/ops', label: 'ops', live: true },
  { href: '/desk/mm', label: 'desk·mm', live: true },
  { href: '/desk/statarb', label: 'desk·statarb', live: true },
  { href: '/risk', label: 'risk', live: true },
  { href: '/research', label: 'research', live: false },
  { href: '/pm', label: 'pm', live: false },
];

function navItems(active: string): SafeHtml[] {
  return ROLE_LINKS.map((r) => {
    const cls = ['nav-link', r.href === active ? 'nav-link--active' : '', r.live ? '' : 'nav-link--soon']
      .filter(Boolean)
      .join(' ');
    if (!r.live) return html`<span class="${cls}" title="not built yet">${r.label}</span>`;
    return html`<a class="${cls}" href="${r.href}">${r.label}</a>`;
  });
}

/** The shared top bar: brand · role launcher · live clock. */
export function topBar(active: string): SafeHtml {
  return html`
    <header class="topbar">
      <span class="brand">MERIDIAN<span class="brand-dim"> // paper desk</span></span>
      <nav class="nav">${navItems(active)}</nav>
      <span class="clock" id="clock" data-clock>--:--:--</span>
    </header>
  `;
}

export interface ShellOpts {
  /** <title> + the active nav href. */
  title: string;
  activeHref: string;
  /** The page body (already-safe HTML). */
  body: SafeHtml;
}

/** Full HTML document: terminal CSS, shared top bar, body, the shared desk-feed component. */
export function pageShell(opts: ShellOpts): string {
  return (
    '<!doctype html>' +
    html`
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${opts.title}</title>
          <link rel="stylesheet" href="/ui/ui.css" />
        </head>
        <body>
          ${topBar(opts.activeHref)}
          <main class="page">${opts.body}</main>
          <script type="module" src="/ui/desk-feed.js"></script>
          <script type="module" src="/ui/desk-action.js"></script>
          <script type="module" src="/ui/desk-form.js"></script>
          <script>
            // Cosmetic local clock (no business state) — the one allowed client sprinkle.
            (function () {
              var el = document.getElementById('clock');
              function tick() {
                if (el) el.textContent = new Date().toISOString().slice(11, 19) + 'Z';
              }
              tick();
              setInterval(tick, 1000);
            })();
          </script>
        </body>
      </html>
    `.value
  );
}
