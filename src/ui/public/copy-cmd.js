// <copy-cmd><code>the exact terminal command</code></copy-cmd>
// The /research "copy-the-runbook-command" helper (UI_REDESIGN_PROMPT.md §5): research
// + long-running jobs run from the operator's terminal, NOT the browser. So the UI
// never executes anything — it just renders the exact command and copies it to the
// clipboard on click. This is the safe alternative to an embedded shell.

class CopyCmd extends HTMLElement {
  connectedCallback() {
    if (this._btn) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'copy';
    btn.addEventListener('click', () => this._copy(btn));
    this.appendChild(btn);
    this._btn = btn;
  }

  _text() {
    const code = this.querySelector('code, pre');
    return ((code ? code.textContent : this.getAttribute('cmd')) || '').trim();
  }

  async _copy(btn) {
    const text = this._text();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.setAttribute('data-ok', '');
      btn.textContent = 'copied';
    } catch (e) {
      this.setAttribute('data-err', '');
      btn.textContent = 'copy failed';
    }
    window.setTimeout(() => {
      this.removeAttribute('data-ok');
      this.removeAttribute('data-err');
      btn.textContent = 'copy';
    }, 1500);
  }
}

customElements.define('copy-cmd', CopyCmd);
