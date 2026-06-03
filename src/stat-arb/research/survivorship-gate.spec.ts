import {
  DEFAULT_SURVIVOR_SAFE_DAYS,
  assessSurvivorship,
  applySurvivorshipGate,
} from './survivorship-gate';

describe('assessSurvivorship', () => {
  it('a window inside the safe horizon is survivor-safe (survivor ≈ live)', () => {
    const a = assessSurvivorship(1825); // exactly ~5yr
    expect(a.survivorSafe).toBe(true);
    expect(a.excessYears).toBe(0);
    expect(a.note).toMatch(/survivor-safe/);
    expect(a.note).toMatch(/negligible/);
  });

  it('a sub-horizon window is survivor-safe', () => {
    expect(assessSurvivorship(365).survivorSafe).toBe(true);
    expect(assessSurvivorship(1500).survivorSafe).toBe(true);
  });

  it('a window past the safe horizon is NOT survivor-safe and reports excess years', () => {
    const a = assessSurvivorship(9000); // ~24.7yr (the Journal #13 long run)
    expect(a.survivorSafe).toBe(false);
    expect(a.excessYears).toBeCloseTo((9000 - 1825) / 365, 5);
    expect(a.note).toMatch(/UPPER BOUND/);
  });

  it('the boundary is inclusive — exactly safeDays is still safe, one day past is not', () => {
    expect(assessSurvivorship(2000, 2000).survivorSafe).toBe(true);
    expect(assessSurvivorship(2001, 2000).survivorSafe).toBe(false);
  });

  it('honours a custom safe horizon', () => {
    expect(assessSurvivorship(3650, 3650).survivorSafe).toBe(true); // 10yr horizon ⇒ 10yr safe
    expect(assessSurvivorship(3650, 1825).survivorSafe).toBe(false); // 5yr horizon ⇒ 10yr unsafe
  });

  it('defaults to ~5yr', () => {
    expect(DEFAULT_SURVIVOR_SAFE_DAYS).toBe(1825);
    expect(assessSurvivorship(1825).safeDays).toBe(DEFAULT_SURVIVOR_SAFE_DAYS);
  });
});

describe('applySurvivorshipGate', () => {
  it('passes every verdict through unchanged on a survivor-safe window', () => {
    for (const v of ['PASS', 'INSUFFICIENT', 'NOISE', 'INCONCLUSIVE'] as const) {
      expect(applySurvivorshipGate(v, true)).toBe(v);
    }
  });

  it('downgrades a strong read (PASS) on a survivor-unsafe window to UPPER-BOUND', () => {
    expect(applySurvivorshipGate('PASS', false)).toBe('UPPER-BOUND');
  });

  it('downgrades INCONCLUSIVE (could-not-rule-out) on a survivor-unsafe window too', () => {
    // Survivorship only ever flatters, so even "couldn't tell" is an upper bound.
    expect(applySurvivorshipGate('INCONCLUSIVE', false)).toBe('UPPER-BOUND');
  });

  it('leaves a "no" verdict (NOISE / INSUFFICIENT) as-is — survivorship cannot worsen it', () => {
    expect(applySurvivorshipGate('NOISE', false)).toBe('NOISE');
    expect(applySurvivorshipGate('INSUFFICIENT', false)).toBe('INSUFFICIENT');
  });

  it('end-to-end: the Journal #13 24yr equity run is capped, the 5yr survivor-safe read is not', () => {
    const long = assessSurvivorship(9000); // ~24yr
    const recent = assessSurvivorship(1825); // ~5yr
    // A PASS on the long window is only an upper bound…
    expect(applySurvivorshipGate('PASS', long.survivorSafe)).toBe('UPPER-BOUND');
    // …while the survivor-safe window's honest read stands (it was INCONCLUSIVE @ ~0.06).
    expect(applySurvivorshipGate('INCONCLUSIVE', recent.survivorSafe)).toBe('INCONCLUSIVE');
  });
});
