// Shared gate primitives. Every risk check follows the same shape:
//   IGate.check(state) → GateDecision
// Decisions are pure: same inputs → same output. No I/O.

export type GateKind =
  | 'DRAWDOWN'
  | 'VENUE_CAP'
  | 'EXPOSURE_GROSS'
  | 'EXPOSURE_NET'
  | 'EXPOSURE_PAIR'
  | 'CORRELATION'
  | 'P_VALUE';

export interface GateDecision {
  allow: boolean;
  /** Populated when allow=false. */
  reason?: string;
  /** Optional informational payload — surfaced to the dashboard event log. */
  detail?: Record<string, number | string>;
}

export const ALLOW: GateDecision = { allow: true };

export function deny(reason: string, detail?: Record<string, number | string>): GateDecision {
  return { allow: false, reason, detail };
}

export interface GateEvent {
  kind: GateKind;
  barIndex: number;
  reason: string;
  detail?: Record<string, number | string>;
}
