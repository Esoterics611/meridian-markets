import { SweepRegimeDetector } from './sweep-regime-detector';

// Deterministic tick driver: 1 tick / 100ms, constant per-tick aggressor volumes + a mid path.
const tick = (d: SweepRegimeDetector, t: number, mid: number, buy: number, sell: number) =>
  d.update(t, BigInt(Math.round(mid * 1e6)), BigInt(buy), BigInt(sell));

describe('SweepRegimeDetector (S4)', () => {
  it('stays calm on a balanced, flat tape', () => {
    const d = new SweepRegimeDetector();
    let s = 'calm';
    for (let i = 0; i < 600; i++) s = tick(d, i * 100, 100, 500, 500);
    expect(s).toBe('calm');
    expect(d.stats().engagements).toBe(0);
  });

  it('flags a one-sided sweep WITH price confirmation, then cools down, then re-engages quoting', () => {
    const d = new SweepRegimeDetector({ cooldownMs: 5_000 });
    // warm balanced
    let t = 0;
    for (let i = 0; i < 100; i++, t += 100) tick(d, t, 100, 500, 500);
    // sellers sweep + price falls 1bp/tick (≈30bps over the 30s window)
    let s = 'calm';
    for (let i = 0; i < 400; i++, t += 100) s = tick(d, t, 100 - i * 0.01, 50, 950);
    expect(s).toBe('sweep');
    expect(d.flow()).toBeLessThan(-0.65);
    expect(d.stats().engagements).toBe(1);
    // tape turns two-sided + price stabilises ⇒ the flow EWMA decays below threshold over a
    // few ticks (one balanced tick must NOT flip it — that would be noise-chasing) ⇒ cooldown…
    let after = 'sweep';
    for (let i = 0; i < 10; i++, t += 100) after = tick(d, t, 96, 500, 500);
    expect(after).toBe('cooldown');
    // …then calm again once the cooldown expires
    for (let i = 0; i < 60; i++, t += 100) s = tick(d, t, 96, 500, 500);
    expect(s).toBe('calm');
  });

  it('does NOT flag one-sided flow that the price absorbs (no drift = no sweep)', () => {
    const d = new SweepRegimeDetector();
    let t = 0;
    let s = 'calm';
    // heavy sellers but the mid holds — absorption by a liquidity wall, keep quoting
    for (let i = 0; i < 600; i++, t += 100) s = tick(d, t, 100, 50, 950);
    expect(s).toBe('calm');
    expect(d.stats().engagements).toBe(0);
  });

  it('does NOT flag drift against the flow sign (price up while sellers sweep = not our pattern)', () => {
    const d = new SweepRegimeDetector();
    let t = 0;
    let s = 'calm';
    for (let i = 0; i < 400; i++, t += 100) s = tick(d, t, 100 + i * 0.01, 50, 950);
    expect(s).toBe('calm');
  });
});
