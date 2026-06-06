// Display formatters for the role pages. Money/qty live in 6-decimal integer
// units (CLAUDE.md §3); these turn the engine's serialised *string* units into
// human cells. We reuse the desk-event money formatter so the UI and the
// Activity tape speak the same dialect (DRY: one rounding rule for the desk).
import { fmtMoney } from '../../market-making/events/desk-event';

const MICROS = 1_000_000;

/** Signed P&L from serialised units, e.g. "1234000" → "+$1.23", "-60000" → "−$0.06". */
export function money(unitsStr: string): string {
  return fmtMoney(BigInt(unitsStr));
}

/** Unsigned dollars from serialised units, e.g. "100000000000" → "$100,000.00". */
export function usd(unitsStr: string): string {
  const n = Number(BigInt(unitsStr)) / MICROS;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A percentage with a fixed precision, e.g. pct(2.4) → "2.40%". */
export function pct(n: number, dp = 2): string {
  return `${n.toFixed(dp)}%`;
}

/** Net P&L as a fraction of starting capital, signed, e.g. "+0.34%". */
export function returnPct(netUnitsStr: string, capitalUnitsStr: string): string {
  const cap = Number(BigInt(capitalUnitsStr));
  if (cap === 0) return '—';
  const r = (Number(BigInt(netUnitsStr)) / cap) * 100;
  const sign = r < 0 ? '−' : '+';
  return `${sign}${Math.abs(r).toFixed(2)}%`;
}

/** A coarse human duration from seconds, e.g. 3723 → "1h 02m", 75 → "1m 15s", 8 → "8s". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** Age of a past event in ms → "never" / "850ms ago" / "1m 02s ago". */
export function age(ms: number | null): string {
  if (ms === null) return 'never';
  if (ms < 1000) return `${Math.round(ms)}ms ago`;
  return `${duration(ms / 1000)} ago`;
}
