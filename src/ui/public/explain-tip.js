// <explain-tip eid="spread"> — the ⓘ affordance of the explain layer
// (UI_REWRITE_PLAN_III P3, §6). Click → a right-side drawer with the term's
// server-rendered explanation, fetched from GET /learn/explain/<eid> (the explain
// registry is the one source of truth; this file renders, never explains).
// Stateless by design: tips inside SSE regions are recreated every tick and that's
// fine — the drawer is a shared singleton on <body> that survives the swaps.

const CACHE = new Map();

function ensureDrawer() {
  let d = document.getElementById('xdrawer');
  if (d) return d;
  d = document.createElement('aside');
  d.id = 'xdrawer';
  d.innerHTML =
    '<div class="xdrawer-card" role="dialog" aria-label="explanation">' +
    '<button class="xdrawer-close" aria-label="close">×</button>' +
    '<div class="xdrawer-body dim">…</div>' +
    '<div class="xdrawer-foot dim">from the desk glossary — more on <a href="/learn">/learn</a></div>' +
    '</div>';
  document.body.appendChild(d);
  const close = () => d.classList.remove('open');
  d.addEventListener('click', (e) => {
    if (e.target === d) close(); // backdrop click; the card swallows its own clicks
  });
  d.querySelector('.xdrawer-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  return d;
}

async function openDrawer(eid) {
  const d = ensureDrawer();
  const body = d.querySelector('.xdrawer-body');
  d.classList.add('open');
  if (CACHE.has(eid)) {
    body.innerHTML = CACHE.get(eid);
    return;
  }
  body.innerHTML = '<span class="dim">loading…</span>';
  try {
    const res = await fetch('/learn/explain/' + encodeURIComponent(eid));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    CACHE.set(eid, html);
    body.innerHTML = html;
  } catch {
    body.innerHTML = '<span class="dim">no explanation available for "' + eid.replace(/[<>&]/g, '') + '" — the registry may not know it yet.</span>';
  }
}

class ExplainTip extends HTMLElement {
  connectedCallback() {
    const eid = this.getAttribute('eid') || '';
    this.innerHTML = '<button class="xtip" type="button" title="what is this?" aria-label="explain">ⓘ</button>';
    this.querySelector('button').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDrawer(eid);
    });
  }
}

customElements.define('explain-tip', ExplainTip);
