// <desk-form endpoint="/api/..." label="Launch book"> …named inputs/selects… </desk-form>
// The shared form primitive: it enhances its server-rendered fields with a submit
// button that gathers [name] fields into a JSON body and POSTs the curated endpoint.
// Number inputs are coerced to numbers; empty fields are omitted. It surfaces the
// engine's own error (these control-plane endpoints answer 200 with {error:"…"} on
// bad input) so the operator sees *why* a launch was rejected. No business logic —
// the server validates; this only collects + POSTs + flashes. (UI_ARCHITECTURE.md §4.)

class DeskForm extends HTMLElement {
  connectedCallback() {
    if (this._btn) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'action-btn action-btn--ok';
    btn.textContent = this.getAttribute('label') || 'submit';
    btn.addEventListener('click', () => this._submit(btn));
    this.appendChild(btn);
    this._btn = btn;
  }

  _collect() {
    const body = {};
    this.querySelectorAll('[name]').forEach((el) => {
      const name = el.getAttribute('name');
      const val = el.value;
      if (val === '' || val == null) return;
      if (el.type === 'number') {
        const n = Number(val);
        if (!Number.isNaN(n)) body[name] = n;
      } else {
        body[name] = val;
      }
    });
    return body;
  }

  _flash(ok) {
    this.setAttribute(ok ? 'data-ok' : 'data-err', '');
    window.setTimeout(() => {
      this.removeAttribute('data-ok');
      this.removeAttribute('data-err');
    }, 1800);
  }

  async _submit(btn) {
    const url = this.getAttribute('endpoint');
    if (!url) return;
    // client-side required check (the server re-validates regardless)
    const missing = Array.prototype.filter.call(this.querySelectorAll('[required]'), (el) => !el.value);
    if (missing.length) {
      this._flash(false);
      return;
    }
    btn.disabled = true;
    this.removeAttribute('data-ok');
    this.removeAttribute('data-err');
    try {
      const res = await fetch(url, {
        method: this.getAttribute('method') || 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this._collect()),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || (json && json.error)) throw new Error((json && json.error) || 'HTTP ' + res.status);
      this._flash(true);
      this.dispatchEvent(new CustomEvent('desk-form-ok', { bubbles: true }));
    } catch (e) {
      this._flash(false);
    } finally {
      btn.disabled = false;
    }
  }
}

customElements.define('desk-form', DeskForm);
