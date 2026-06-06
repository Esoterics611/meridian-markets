// <desk-action endpoint="/api/..." label="Stop desk" variant="warn" confirm="..?">
// The shared action-palette primitive. It renders a button that POSTs to a curated,
// already-validated control-plane endpoint — nothing more. The server stays the
// authority: after the POST the page's <desk-feed> stream reflects the new state
// (~one tick). The component only manages button affordance (disable while
// in-flight, flash ok/err), never business logic (CLAUDE.md §1).
//
// Why a vanilla component and not htmx here: the control-plane endpoints return
// JSON (a snapshot), not an HTML fragment, so htmx's hx-post→swap model doesn't
// fit without inventing wrapper endpoints. A ~40-line WC matches <desk-feed> and
// keeps the client dependency-free. (See UI_ARCHITECTURE.md §2.)

class DeskAction extends HTMLElement {
  connectedCallback() {
    if (this._btn) return; // guard against re-entry
    const btn = document.createElement('button');
    btn.className = 'action-btn action-btn--' + (this.getAttribute('variant') || 'default');
    btn.textContent = this.getAttribute('label') || 'action';
    const t = this.getAttribute('title');
    if (t) btn.title = t;
    btn.addEventListener('click', () => this._fire(btn));
    this.appendChild(btn);
    this._btn = btn;
  }

  async _fire(btn) {
    const url = this.getAttribute('endpoint');
    if (!url) return;
    const confirmMsg = this.getAttribute('confirm');
    if (confirmMsg && !window.confirm(confirmMsg)) return;

    btn.disabled = true;
    this.removeAttribute('data-ok');
    this.removeAttribute('data-err');
    try {
      const res = await fetch(url, {
        method: this.getAttribute('method') || 'POST',
        headers: { 'content-type': 'application/json' },
        body: this.getAttribute('body') || undefined,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.setAttribute('data-ok', '');
    } catch (e) {
      this.setAttribute('data-err', '');
    } finally {
      btn.disabled = false;
      // Clear the flash after a moment; the live feed already shows the real state.
      window.setTimeout(() => {
        this.removeAttribute('data-ok');
        this.removeAttribute('data-err');
      }, 1500);
    }
  }
}

customElements.define('desk-action', DeskAction);
