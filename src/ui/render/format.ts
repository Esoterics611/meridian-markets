// Display formatters for the role pages. Money/qty live in 6-decimal integer
// units (CLAUDE.md §3); these turn the engine's serialised *string* units into
// human cells. We reuse the desk-event money formatter so the UI and the
// Activity tape speak the same dialect (DRY: one rounding rule for the desk).
//
// ── COLOUR SEMANTICS (the desk's one rule: a colour means "for us / against us",
//    NOT "the number is positive/negative") ──────────────────────────────────────
//   green (.pos)  — money working FOR the desk: realised/MTM gains, funding RECEIVED,
//                   a maker REBATE (revenue), net profit. A rebate must read green even
//                   though it's a "fee" — so fees are coloured by their CONTRIBUTION to
//                   net (−feesUnits): a cost reads red, a rebate reads green.
//   red  (.neg)   — money working AGAINST the desk: realised/MTM losses, costs PAID,
//                   funding paid, adverse selection (picked-off markout), a drawdown
//                   over the risk budget.
//   amber (.warn) — caution / the gate intervening (not a loss): blocked quotes, a
//                   non-Allow risk verdict, WARMING. Eyes-here, but we didn't lose money.
//   neutral (.flat / .dim / plain) — DIRECTION & EXPOSURE, where a sign is not good/bad:
//                   inventory, net delta, gross Δ / residual, quotes (bid/mid/ask),
//                   reservation, ½-spread, counts. NEVER run these through signClass —
//                   a net-short isn't "bad" and a net-long isn't "good".
//   Use signClass ONLY on a P&L / cost line where + genuinely means "good for the desk".
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

/** P&L cell colour class from serialised units: "pos" (green) / "neg" (red) / "flat".
 *  ONLY for lines where + means "good for the desk" (see the COLOUR SEMANTICS note above).
 *  Directional/exposure fields (inventory, net delta, residual) must stay neutral. */
export function signClass(unitsStr: string): string {
  const v = BigInt(unitsStr);
  return v > 0n ? 'pos' : v < 0n ? 'neg' : 'flat';
}

/** Signed notional exposure (6-dec units) from inventory (asset units) × mid (price micros). */
export function notionalUnits(invUnitsStr: string, midMicrosStr: string): string {
  return ((BigInt(invUnitsStr) * BigInt(midMicrosStr)) / 1_000_000n).toString();
}

/** Absolute value of a serialised-units string (for gross sums / unsigned display). */
export function absUnits(unitsStr: string): string {
  const v = BigInt(unitsStr);
  return (v < 0n ? -v : v).toString();
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

/** Bytes → a coarse MB string, e.g. 134217728 → "128.0 MB" (process memory panels). */
export function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Age of a past event in ms → "never" / "850ms ago" / "1m 02s ago". */
export function age(ms: number | null): string {
  if (ms === null) return 'never';
  if (ms < 1000) return `${Math.round(ms)}ms ago`;
  return `${duration(ms / 1000)} ago`;
}
