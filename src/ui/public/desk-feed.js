// <desk-feed src="/exec/stream" target="exec-live"> — the one shared live-update
// primitive for every role page. It opens an SSE connection to `src`, and on each
// server push swaps the rendered HTML fragment into the element with id `target`
// (which the server already rendered for a correct first paint). This is the
// htmx-over-SSE pattern in vanilla custom-element form: the server owns the markup,
// the browser only swaps it in — no business logic in the client (CLAUDE.md §1).
//
// Reusable as-is across /ops, /risk, /desk/* etc: point each page's <desk-feed> at
// its own /stream endpoint and its own server-rendered live region.

class DeskFeed extends HTMLElement {
  connectedCallback() {
    const src = this.getAttribute('src');
    const targetId = this.getAttribute('target');
    if (!src || !targetId) return;
    this._target = () => document.getElementById(targetId);

    this._es = new EventSource(src);
    this._es.onmessage = (ev) => {
      let payload;
      try {
        payload = JSON.parse(ev.data);
      } catch (_) {
        return; // ignore a malformed frame rather than blank the view
      }
      const el = this._target();
      if (el && typeof payload.html === 'string') {
        el.innerHTML = payload.html;
        this.removeAttribute('data-stale');
      }
    };
    // EventSource auto-reconnects; we only flag the UI as stale while disconnected
    // so the operator can see the feed dropped instead of trusting frozen numbers.
    this._es.onerror = () => this.setAttribute('data-stale', '');
  }

  disconnectedCallback() {
    if (this._es) this._es.close();
  }
}

customElements.define('desk-feed', DeskFeed);
