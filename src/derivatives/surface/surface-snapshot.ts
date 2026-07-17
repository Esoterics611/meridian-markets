// surface-snapshot — pure selection logic for the O-0 IV-surface tape
// (OPTIONS_DESK.md O-E1): given one underlying's Deribit chain, pick per target
// tenor the expiry and the named smile points every LHO trigger consumes —
// ATM, 25Δ put, 10Δ put, 25Δ call — by Black-Scholes delta at each option's own
// mark IV (r=0, the §2 crypto convention). Pure functions, no I/O: the collector
// script feeds it a live chain; the spec feeds it a synthetic one.
//
// Selection honesty rules:
//  - an expiry qualifies for a tenor only within tolerance (±max(2d, 35% of
//    target)) — a 90d row silently backed by a 45d expiry would poison every
//    threshold later set from the tape, so "no expiry near the tenor" ⇒ no row;
//  - a wing pick must land within ±40% of its target |delta| (25Δ: ±0.10; 10Δ:
//    ±0.04) — when the chain's strike grid is too sparse to give a real 10Δ, the
//    point is omitted, never approximated by a 17Δ wearing a 10Δ label.

import { DeribitOption } from '../deribit/deribit-client';
import { blackScholes } from '../greeks/black-scholes';

export interface SurfacePointPick {
  instrumentName: string;
  strike: number;
  /** Mark IV, fraction. */
  iv: number;
  /** BS delta at mark IV, r=0. */
  delta: number;
}

export interface TenorSurfacePicks {
  underlying: string;
  targetTenorDays: number;
  expiryMs: number;
  daysToExpiry: number;
  spot: number;
  atmStrike: number;
  /** Average of call+put mark IV at the ATM strike (call-only if the put is missing). */
  atmIv: number;
  put25?: SurfacePointPick;
  put10?: SurfacePointPick;
  call25?: SurfacePointPick;
  /** 25Δ risk reversal (putIv − callIv), fraction — present only when both wings are. */
  rr25?: number;
}

const DAY_MS = 24 * 3600 * 1000;

/** Nearest expiry to the target tenor, within ±max(2d, 35% of target); undefined if none qualifies. */
export function pickExpiryForTenor(expiriesMs: number[], targetDays: number, nowMs: number): number | undefined {
  const tol = Math.max(2, 0.35 * targetDays);
  let best: number | undefined;
  let bestErr = Infinity;
  for (const e of expiriesMs) {
    const days = (e - nowMs) / DAY_MS;
    if (days <= 0) continue;
    const err = Math.abs(days - targetDays);
    if (err <= tol && err < bestErr) {
      best = e;
      bestErr = err;
    }
  }
  return best;
}

function deltaOf(o: DeribitOption, spot: number, nowMs: number): number {
  const tYears = Math.max((o.expiryMs - nowMs) / (365 * DAY_MS), 1e-9);
  return blackScholes({ type: o.type, spot, strike: o.strike, tYears, iv: o.markIv, rate: 0 }).delta;
}

function pickByDelta(
  candidates: DeribitOption[],
  spot: number,
  nowMs: number,
  targetAbsDelta: number,
  maxDeltaErr = 0.4 * targetAbsDelta,
): SurfacePointPick | undefined {
  let best: SurfacePointPick | undefined;
  let bestErr = Infinity;
  for (const o of candidates) {
    const delta = deltaOf(o, spot, nowMs);
    const err = Math.abs(Math.abs(delta) - targetAbsDelta);
    if (err <= maxDeltaErr && err < bestErr) {
      best = { instrumentName: o.instrumentName, strike: o.strike, iv: o.markIv, delta };
      bestErr = err;
    }
  }
  return best;
}

/** One tenor's smile points off one underlying's chain; undefined when no expiry qualifies. */
export function selectTenorPicks(
  chain: DeribitOption[],
  targetTenorDays: number,
  nowMs: number,
): TenorSurfacePicks | undefined {
  const live = chain.filter((o) => o.markIv > 0 && o.underlyingPrice > 0 && o.expiryMs > nowMs);
  if (live.length === 0) return undefined;
  const expiryMs = pickExpiryForTenor([...new Set(live.map((o) => o.expiryMs))], targetTenorDays, nowMs);
  if (expiryMs === undefined) return undefined;

  const atExp = live.filter((o) => o.expiryMs === expiryMs);
  const spot = atExp[0].underlyingPrice;

  // ATM: the strike nearest spot that has a call quoted (straddle IV = call/put average).
  const callStrikes = [...new Set(atExp.filter((o) => o.type === 'CALL').map((o) => o.strike))];
  if (callStrikes.length === 0) return undefined;
  const atmStrike = callStrikes.sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))[0];
  const atmCall = atExp.find((o) => o.strike === atmStrike && o.type === 'CALL')!;
  const atmPut = atExp.find((o) => o.strike === atmStrike && o.type === 'PUT');
  const atmIv = atmPut ? (atmCall.markIv + atmPut.markIv) / 2 : atmCall.markIv;

  // Wings: OTM only — delta targeting on the correct side of spot.
  const otmPuts = atExp.filter((o) => o.type === 'PUT' && o.strike < spot);
  const otmCalls = atExp.filter((o) => o.type === 'CALL' && o.strike > spot);
  const put25 = pickByDelta(otmPuts, spot, nowMs, 0.25);
  const put10 = pickByDelta(otmPuts, spot, nowMs, 0.1);
  const call25 = pickByDelta(otmCalls, spot, nowMs, 0.25);

  return {
    underlying: atExp[0].currency,
    targetTenorDays,
    expiryMs,
    daysToExpiry: (expiryMs - nowMs) / DAY_MS,
    spot,
    atmStrike,
    atmIv,
    put25,
    put10,
    call25,
    rr25: put25 && call25 ? put25.iv - call25.iv : undefined,
  };
}
