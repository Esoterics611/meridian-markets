import { FlowRegimeMachine, FlowTransition } from './flow-regime';

// F4 Stage A — the flow-reactive risk throttle. The tests pin: hysteresis + dwell
// (no chatter), the ramp g, the per-regime throttle responses (§2.2–§2.4), and the
// HARD INVARIANT that FLATTEN-ONLY is reachable only when A<0 — HARVEST never flattens.

const LOT = 1_000_000n;

/** Drive `n` volume ticks of pure one-sided flow (sign ±1), 1s apart, from `t0`. */
function drive(m: FlowRegimeMachine, n: number, dir: 1 | -1, inv: bigint, t0: number, stepMs = 1000) {
  let last = m.update(t0, 0n, 0n, inv);
  for (let i = 0; i < n; i++) {
    const buy = dir > 0 ? 1000n : 0n;
    const sell = dir > 0 ? 0n : 1000n;
    last = m.update(t0 + (i + 1) * stepMs, buy, sell, inv);
  }
  return last;
}

describe('FlowRegimeMachine (F4 Stage A — throttle only, κ=0)', () => {
  it('stays NORMAL with neutral responses on balanced flow', () => {
    const m = new FlowRegimeMachine();
    let t = 0;
    for (let i = 0; i < 50; i++) {
      const out = m.update((t += 1000), 500n, 500n, 2n * LOT);
      expect(out.regime).toBe('normal');
      expect(out.spreadScale).toBe(1);
      expect(out.bidSizeScale).toBe(1);
      expect(out.askSizeScale).toBe(1);
    }
    expect(m.stats().transitions).toBe(0);
  });

  it('one informed print does not move quotes (persist gate): g stays 0 below persistMin', () => {
    const m = new FlowRegimeMachine({ persistMin: 3, persistFull: 10 });
    // a single fully one-sided tick: EWMA barely moves, persist 0 → everything neutral
    const out = m.update(1000, 1000n, 0n, -2n * LOT);
    expect(out.g).toBe(0);
    expect(out.regime).toBe('normal');
    expect(out.spreadScale).toBe(1);
  });

  it('enters DEFENSIVE on sustained flow AGAINST inventory (A<0) and widens/cuts the toxic side', () => {
    // thetaHigh 2 (> any |f|): pin the DEFENSIVE responses without the FLATTEN escalation
    const m = new FlowRegimeMachine({ persistMin: 2, persistFull: 6, dwellMs: 0, thetaHigh: 2 });
    // short inventory, sustained BUY flow ⇒ A<0; buy flow hits the ASK ⇒ ask is toxic
    const out = drive(m, 40, 1, -2n * LOT, 0);
    expect(out.regime).toBe('defensive');
    expect(out.A).toBe(-1);
    expect(out.g).toBe(1);
    expect(out.spreadScale).toBeGreaterThan(1); // §2.2 symmetric widen
    expect(out.askHalfScale).toBeGreaterThan(out.bidHalfScale); // §2.3 toxic side wider
    expect(out.askSizeScale).toBeLessThan(1); // §2.4 toxic-side size cut
    expect(out.askSizeScale).toBeGreaterThanOrEqual(0.2); // floored, never pulled in DEFENSIVE
    expect(out.bidSizeScale).toBe(1);
  });

  it('enters HARVEST on sustained flow WITH inventory (A>0): reducing side NOT widened, no size cut', () => {
    const m = new FlowRegimeMachine({ persistMin: 2, persistFull: 6, dwellMs: 0 });
    // long inventory, sustained BUY flow ⇒ A>0; the ask (toxic/reducing) stays at base
    const out = drive(m, 40, 1, 2n * LOT, 0);
    expect(out.regime).toBe('harvest');
    expect(out.A).toBe(1);
    expect(out.spreadScale).toBe(1);
    expect(out.askHalfScale).toBe(1); // do NOT widen the side flow is flattening us on
    expect(out.bidHalfScale).toBeGreaterThanOrEqual(1); // mild safe-widen on the adding side
    expect(out.askSizeScale).toBe(1); // we WANT those fills
    expect(out.bidSizeScale).toBe(1);
  });

  it('HARD INVARIANT: HARVEST never reaches FLATTEN-ONLY, even at maximal sustained flow', () => {
    const m = new FlowRegimeMachine({ persistMin: 2, persistFull: 4, dwellMs: 0, thetaHigh: 0.5 });
    // A>0 throughout: |f| → ~1 (≫ θ_high), persist ≫ persistFull, hours of it
    let flattenSeen = false;
    let t = 0;
    for (let i = 0; i < 5000; i++) {
      const out = m.update((t += 1000), 1000n, 0n, 5n * LOT);
      if (out.regime === 'flatten-only') flattenSeen = true;
    }
    expect(flattenSeen).toBe(false);
    expect(m.stats().flattenEntries).toBe(0);
    expect(m.stats().flattenEntriesNotAligned).toBe(0);
    expect(m.stats().ticksHarvest).toBeGreaterThan(4000);
  });

  it('escalates DEFENSIVE → FLATTEN-ONLY only on sustained |f|>θ_high with A<0, pulling the toxic side', () => {
    const m = new FlowRegimeMachine({ persistMin: 2, persistFull: 4, dwellMs: 0, thetaHigh: 0.5 });
    // long inventory, sustained SELL flow ⇒ A<0; sell flow hits the BID (toxic = adding side)
    const out = drive(m, 60, -1, 3n * LOT, 0);
    expect(out.regime).toBe('flatten-only');
    expect(out.bidSizeScale).toBe(0); // toxic/adding side pulled entirely
    expect(out.askSizeScale).toBe(1); // reducing side keeps quoting
    expect(out.askHalfScale).toBeLessThan(1); // tightened to shed into the flow
    expect(m.stats().flattenEntries).toBe(1);
    expect(m.stats().flattenEntriesNotAligned).toBe(0);
  });

  it('hysteresis: stays engaged between θ_exit and θ_enter, releases only below θ_exit', () => {
    const m = new FlowRegimeMachine({ thetaEnter: 0.4, thetaExit: 0.25, persistMin: 2, persistFull: 6, dwellMs: 0, thetaHigh: 2 });
    let out = drive(m, 40, 1, -2n * LOT, 0); // engage hard
    expect(out.regime).toBe('defensive');
    // mildly one-sided flow that keeps the EWMA in the (0.25, 0.4) band: no release
    let t = 100_000;
    for (let i = 0; i < 70; i++) out = m.update((t += 1000), 660n, 340n, -2n * LOT); // imb=0.32
    expect(Math.abs(out.f)).toBeGreaterThan(0.25);
    expect(Math.abs(out.f)).toBeLessThan(0.4);
    expect(out.regime).toBe('defensive');
    // balanced flow drags the EWMA under θ_exit ⇒ NORMAL
    for (let i = 0; i < 100; i++) out = m.update((t += 1000), 500n, 500n, -2n * LOT);
    expect(out.regime).toBe('normal');
  });

  it('min dwell blocks release chatter: a regime younger than dwellMs cannot exit', () => {
    const m = new FlowRegimeMachine({ persistMin: 2, persistFull: 6, dwellMs: 60_000 });
    let out = drive(m, 20, 1, -2n * LOT, 0); // defensive at t≈20s
    expect(out.regime).toBe('defensive');
    const engagedAt = 20_000;
    // calm flow immediately after — still inside the dwell window ⇒ held
    out = m.update(engagedAt + 5000, 500n, 500n, -2n * LOT);
    expect(out.regime).toBe('defensive');
    // well past the dwell with calm flow ⇒ released
    let t = engagedAt + 61_000;
    let r = m.update(t, 500n, 500n, -2n * LOT);
    for (let i = 0; i < 100 && r.regime !== 'normal'; i++) r = m.update((t += 1000), 500n, 500n, -2n * LOT);
    expect(r.regime).toBe('normal');
  });

  it('flip resets persist and decays g smoothly instead of snapping', () => {
    const m = new FlowRegimeMachine({ persistMin: 2, persistFull: 6, dwellMs: 0 });
    const engaged = drive(m, 40, 1, -2n * LOT, 0);
    expect(engaged.g).toBe(1);
    // hammer the opposite side until the EWMA crosses zero — the flip tick
    let out = engaged;
    let t = 100_000;
    let flipped = false;
    for (let i = 0; i < 60 && !flipped; i++) {
      out = m.update((t += 1000), 0n, 1000n, -2n * LOT);
      flipped = out.flip;
    }
    expect(flipped).toBe(true);
    expect(out.persist).toBe(0);
    expect(out.g).toBeLessThan(1); // decaying…
    expect(out.g).toBeGreaterThan(0); // …not snapped to zero
    expect(m.stats().flips).toBeGreaterThan(0);
  });

  it('emits a transition event with the full triggering FlowState', () => {
    const seen: FlowTransition[] = [];
    const m = new FlowRegimeMachine({ persistMin: 2, persistFull: 6, dwellMs: 0, onTransition: (tr) => seen.push(tr) });
    drive(m, 40, 1, -2n * LOT, 0);
    expect(seen.length).toBeGreaterThan(0);
    const tr = seen[0];
    expect(tr.from).toBe('normal');
    expect(tr.to).toBe('defensive');
    expect(tr.A).toBe(-1);
    expect(Math.abs(tr.f)).toBeGreaterThan(tr.thetaEnter);
    expect(tr.inventoryUnits).toBe(-2n * LOT);
  });

  it('T blends VPIN when configured', () => {
    const m = new FlowRegimeMachine({ vpinBlend: 0.5 });
    const out = m.update(1000, 500n, 500n, 0n, 0.8); // |f|≈0, vpin 0.8 ⇒ T ≈ 0.4
    expect(out.T).toBeCloseTo(0.4, 5);
  });

  it('flat inventory (A=0) defends but can never flatten (nothing to shed)', () => {
    const m = new FlowRegimeMachine({ persistMin: 2, persistFull: 4, dwellMs: 0, thetaHigh: 0.5 });
    const out = drive(m, 100, -1, 0n, 0);
    expect(out.regime).toBe('defensive'); // pick-off protection still engages
    expect(m.stats().flattenEntries).toBe(0); // A=0 ⇒ escalation unreachable
  });
});
