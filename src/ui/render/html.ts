// Tiny, dependency-free HTML rendering primitives for the server-rendered role
// pages (docs/UI_ARCHITECTURE.md). The UI is a *thin read-only view over the
// engine* (CLAUDE.md §1), so the server owns the truth and emits HTML; the
// browser never holds business state. We hand-roll an auto-escaping tagged
// template instead of pulling in a template engine (Eta/Handlebars) — it keeps
// the modular monolith lean and the render functions are pure ⇒ unit-testable
// (render → assert HTML, CLAUDE.md §10). See UI_ARCHITECTURE.md §"Why no template engine".

/** A branded already-safe HTML string — produced by `html`/`raw`, never escaped again. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Escape the five HTML-significant characters in untrusted text. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Mark a string as trusted HTML (opt out of escaping). Use only on server-built markup. */
export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

type Interpolable = SafeHtml | string | number | null | undefined | Interpolable[];

function renderValue(v: Interpolable): string {
  if (v === null || v === undefined) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  if (typeof v === 'number') return escapeHtml(String(v));
  return escapeHtml(v);
}

/**
 * Auto-escaping HTML tagged template. Plain interpolations are escaped; nested
 * `SafeHtml` (and arrays of it) pass through unescaped so fragments compose:
 *   html`<ul>${rows.map(r => html`<li>${r.name}</li>`)}</ul>`
 */
export function html(strings: TemplateStringsArray, ...values: Interpolable[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}
