// <desk-tour> — the guided page tour (UI_REWRITE_PLAN_III P3, §6). Steps are
// SERVER-DEFINED (a <script type="application/json"> child rendered by the page's
// view — [{sel, text}, …]); this component only spotlights and steps. Launch via
// the pill (visible in learn mode) or ?tour=1 (how /learn links in). A step whose
// selector matches nothing is skipped — pages change, tours degrade, never break.

class DeskTour extends HTMLElement {
  connectedCallback() {
    let steps = [];
    try {
      steps = JSON.parse(this.querySelector('script[type="application/json"]').textContent);
    } catch {
      /* no steps ⇒ no tour */
    }
    this._steps = (Array.isArray(steps) ? steps : []).filter((s) => s && s.sel && s.text);
    this.insertAdjacentHTML('beforeend', '<button class="tour-pill learn-only" type="button">▶ guided tour</button>');
    this.querySelector('.tour-pill').addEventListener('click', () => this.start());
    if (this._steps.length && new URLSearchParams(location.search).get('tour') === '1') {
      setTimeout(() => this.start(), 400); // let the first paint settle
    }
  }

  disconnectedCallback() {
    this.end();
  }

  start() {
    if (!this._steps.length || this._ring) return;
    this._i = 0;
    this._ring = document.createElement('div');
    this._ring.className = 'tour-ring';
    this._card = document.createElement('div');
    this._card.className = 'tour-card';
    document.body.append(this._ring, this._card);
    this._onKey = (e) => {
      if (e.key === 'Escape') this.end();
      if (e.key === 'ArrowRight') this.step(1);
      if (e.key === 'ArrowLeft') this.step(-1);
    };
    this._onResize = () => this.show();
    document.addEventListener('keydown', this._onKey);
    window.addEventListener('resize', this._onResize);
    this.show();
  }

  step(d) {
    let i = this._i + d;
    // Skip steps whose target no longer exists (in either direction).
    while (i >= 0 && i < this._steps.length && !document.querySelector(this._steps[i].sel)) i += d || 1;
    if (i < 0) return;
    if (i >= this._steps.length) {
      this.end();
      return;
    }
    this._i = i;
    this.show();
  }

  show() {
    if (!this._ring) return;
    const st = this._steps[this._i];
    const el = document.querySelector(st.sel);
    if (!el) {
      this.step(1);
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'auto' });
    const r = el.getBoundingClientRect();
    Object.assign(this._ring.style, {
      left: r.left - 5 + 'px',
      top: r.top - 5 + 'px',
      width: r.width + 10 + 'px',
      height: r.height + 10 + 'px',
    });
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    this._card.innerHTML =
      '<div class="tour-text">' + esc(st.text) + '</div>' +
      '<div class="tour-nav"><span class="dim">' + (this._i + 1) + '/' + this._steps.length + '</span>' +
      '<span><button type="button" class="tour-prev">‹ back</button>' +
      '<button type="button" class="tour-next">' + (this._i + 1 === this._steps.length ? 'done ✓' : 'next ›') + '</button>' +
      '<button type="button" class="tour-end" title="Esc">×</button></span></div>';
    this._card.querySelector('.tour-prev').onclick = () => this.step(-1);
    this._card.querySelector('.tour-next').onclick = () => this.step(1);
    this._card.querySelector('.tour-end').onclick = () => this.end();
    // Card below the target when there's room, above otherwise; clamped to viewport.
    const ch = this._card.offsetHeight || 90;
    const top = r.bottom + 10 + ch < window.innerHeight ? r.bottom + 10 : Math.max(8, r.top - ch - 10);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - this._card.offsetWidth - 12));
    Object.assign(this._card.style, { top: top + 'px', left: left + 'px' });
  }

  end() {
    if (this._ring) this._ring.remove();
    if (this._card) this._card.remove();
    this._ring = this._card = null;
    document.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
  }
}

customElements.define('desk-tour', DeskTour);
