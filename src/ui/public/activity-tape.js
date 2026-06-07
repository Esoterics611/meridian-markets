// <activity-tape src="/api/market-making/events" cursor="128" kind="" book="">
//   <ul class="tape"> …server-rendered initial rows… </ul>
// </activity-tape>
//
// The shared APPEND-MODE Activity feed — the cursor-based tape (UI_ARCHITECTURE.md
// §5). The server renders the initial rows (newest-first) + the cursor
// (DeskEventLog.lastSeq()) for a correct first paint; this component then polls
// `src?since=<cursor>` and PREPENDS only the *new* events, advancing the cursor each
// time. So the list is never rebuilt from scratch on a tick and the operator's
// scroll into history is preserved — unlike the full-replace tape inside the SSE
// region. It holds no business state: every row is an engine DeskEvent shown
// verbatim (its pre-rendered `message`), the same as the server-rendered tape
// (CLAUDE.md §1). MUST live OUTSIDE any <desk-feed> SSE region (a swap would recreate
// it and restart the feed).

const POLL_MS = 2000;
const MAX_ROWS = 300;

// Mirror of components.ts kindClass — the badge colour per event kind.
function kindClass(kind) {
  switch (kind) {
    case 'fill':
      return 'tape--fill';
    case 'verdict':
      return 'tape--verdict';
    case 'launch':
    case 'start':
      return 'tape--up';
    case 'remove':
    case 'stop':
      return 'tape--down';
    default:
      return '';
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Identical row shape to the server's tapeRow() so an appended row is indistinguishable
// from a server-rendered one.
function rowHtml(ev) {
  const t = new Date(ev.ts).toISOString().slice(11, 19);
  return (
    '<li class="tape-row ' + kindClass(ev.kind) + '">' +
    '<span class="tape-t">' + t + '</span>' +
    '<span class="tape-kind">' + esc(ev.kind) + '</span>' +
    '<span class="tape-msg">' + esc(ev.message) + '</span>' +
    '</li>'
  );
}

class ActivityTape extends HTMLElement {
  connectedCallback() {
    this._src = this.getAttribute('src');
    this._cursor = Number(this.getAttribute('cursor')) || 0;
    this._kind = this.getAttribute('kind') || '';
    this._book = this.getAttribute('book') || '';
    this._list = this.querySelector('ul.tape');
    if (!this._src || !this._list) return;
    this._timer = setInterval(() => this.poll(), POLL_MS);
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    if (this._abort) this._abort.abort();
  }

  async poll() {
    try {
      if (this._abort) this._abort.abort();
      this._abort = new AbortController();
      const qs = new URLSearchParams({ since: String(this._cursor) });
      if (this._book) qs.set('book', this._book);
      const res = await fetch(this._src + '?' + qs.toString(), { signal: this._abort.signal });
      const data = await res.json();
      const events = Array.isArray(data.events) ? data.events : [];
      const fresh = this._kind ? events.filter((e) => e.kind === this._kind) : events;
      if (fresh.length) this.appendNew(fresh);
      // advance the cursor even when the kind filter dropped everything, so we don't
      // re-fetch the same already-seen events next tick.
      if (typeof data.cursor === 'number') this._cursor = data.cursor;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      // transient poll error — leave the tape as-is and try again next tick
    }
  }

  appendNew(events) {
    const list = this._list;
    const empty = list.querySelector('li.empty');
    if (empty) empty.remove();
    // events arrive oldest-first; prepend each so the newest ends up on top.
    let html = '';
    for (const ev of events) html = rowHtml(ev) + html;
    // preserve the operator's scroll into history: if they were scrolled down, keep
    // the same rows in view by offsetting for the height we prepend.
    const atTop = list.scrollTop <= 1;
    const before = list.scrollHeight;
    list.insertAdjacentHTML('afterbegin', html);
    while (list.children.length > MAX_ROWS) list.removeChild(list.lastElementChild);
    if (!atTop) list.scrollTop += list.scrollHeight - before;
  }
}

customElements.define('activity-tape', ActivityTape);
