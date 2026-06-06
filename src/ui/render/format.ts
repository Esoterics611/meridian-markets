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
