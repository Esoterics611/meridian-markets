/**
 * Pure helpers for the `mq` quant terminal (see docs/QUANT_TERMINAL_SPEC.md and
 * bin/mq.ts). Kept under src/ — and free of any I/O — so jest (rootDir: src)
 * exercises the arg-parsing / formatting / ranking logic that the CLI's output
 * depends on. bin/mq.ts is the thin executable shell that adds HTTP + dispatch.
 */

/** Live USDC convention: 6-decimal integer units. 1 USDC = 1_000_000 units. */
const USDC_UNITS = 1_000_000n;

/**
 * Parse a command's argv tail into positionals + flags. Supports `--flag value`,
 * `--flag=value`, and bare boolean flags (e.g. `--json`). Anything in
 * `booleanFlags` never consumes the following token, so `mq trades --json` keeps
 * `--json` boolean even when nothing follows.
 */
export function parseArgs(
  tokens: string[],
  booleanFlags: Set<string> = new Set(['json']),
): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (booleanFlags.has(body)) {
        flags[body] = true;
      } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        flags[body] = tokens[++i];
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

/** Read a flag as a number, falling back when absent or unparseable. */
export function numFlag(flags: Record<string, string | boolean>, name: string, fallback: number): number {
  const v = flags[name];
  if (v === undefined || v === true) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Format 6-decimal USDC units (BIGINT-as-string, as the API serialises them, or
 * a bigint) into a human "$1,234,567.89" with thousands separators and 2dp.
 */
export function fmtUnits(units: string | bigint): string {
  const n = typeof units === 'bigint' ? units : BigInt(units);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / USDC_UNITS;
  const cents = ((abs % USDC_UNITS) / 10_000n).toString().padStart(2, '0');
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${wholeStr}.${cents}`;
}

/** Whole-USDC dollars → 6-decimal units string (for request bodies). */
export function usdcToUnits(usdc: number): string {
  return (BigInt(Math.round(usdc)) * USDC_UNITS).toString();
}

/**
 * Render a fixed-width column table: header row, a dash separator, then rows.
 * Columns are sized to the widest cell. Numbers/strings both accepted.
 */
export function table(headers: string[], rows: Array<Array<string | number>>): string {
  const cell = (v: string | number | undefined): string => (v === undefined || v === null ? '' : String(v));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => cell(r[i]).length), 0),
  );
  const fmtRow = (r: Array<string | number>): string =>
    headers.map((_, i) => cell(r[i]).padEnd(widths[i])).join('  ').replace(/\s+$/, '');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [fmtRow(headers), sep, ...rows.map(fmtRow)].join('\n');
}

/** One strategy's result in a `mq sweep` (or its failure). */
export interface SweepRow {
  strategy: string;
  tradeCount: number;
  sharpe: number;
  pnlUnits: string;
  maxDdPct: number;
  winRate: number;
  error?: string;
}

/**
 * Rank sweep results best-first by Sharpe; rows that errored (or never ran) sink
 * to the bottom regardless of any stale numbers. Returns a sorted copy.
 */
export function rankSweep(rows: SweepRow[]): SweepRow[] {
  return [...rows].sort((a, b) => {
    if (a.error && !b.error) return 1;
    if (b.error && !a.error) return -1;
    return b.sharpe - a.sharpe;
  });
}
