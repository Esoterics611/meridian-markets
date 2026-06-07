import { ManualBiasSource } from './manual-bias-source';

describe('ManualBiasSource — the decayed, validated house view', () => {
  it('no view ⇒ neutral', () => {
    expect(new ManualBiasSource().bias('BTC', { nowMs: 1000 }).bias).toBe(0);
  });

  it('returns a fresh validated view at full weight (case-insensitive symbol)', () => {
    const s = new ManualBiasSource();
    s.setView('BTC', { bias: 0.6, setAtMs: 1000, ttlMs: 10_000, validated: true, reason: 'thesis' });
    const r = s.bias('btc', { nowMs: 1000 });
    expect(r.bias).toBeCloseTo(0.6);
    expect(r.validated).toBe(true);
    expect(r.reason).toBe('thesis');
  });

  it('DECAYS linearly to 0 over the TTL — a stale view fades, never rides forever', () => {
    const s = new ManualBiasSource();
    s.setView('BTC', { bias: 1, setAtMs: 0, ttlMs: 10_000, validated: true });
    expect(s.bias('BTC', { nowMs: 5_000 }).bias).toBeCloseTo(0.5);
    expect(s.bias('BTC', { nowMs: 10_000 }).bias).toBe(0);
    expect(s.bias('BTC', { nowMs: 20_000 }).bias).toBe(0);
  });

  it('an unvalidated view reports validated=false (no carry sized from it)', () => {
    const s = new ManualBiasSource();
    s.setView('BTC', { bias: 0.9, setAtMs: 0, ttlMs: 10_000, validated: false });
    expect(s.bias('BTC', { nowMs: 0 }).validated).toBe(false);
  });

  it('clamps an out-of-range view on set and clears back to neutral', () => {
    const s = new ManualBiasSource();
    s.setView('BTC', { bias: 5, setAtMs: 0, ttlMs: 10_000, validated: true });
    expect(s.bias('BTC', { nowMs: 0 }).bias).toBe(1); // clamped
    s.clearView('BTC');
    expect(s.bias('BTC', { nowMs: 0 }).bias).toBe(0);
  });
});
