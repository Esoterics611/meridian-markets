import { FlowToxicityScaler } from './flow-toxicity';

const mk = () => new FlowToxicityScaler({ windowBars: 10, minScale: 0.5, maxScale: 3 });

describe('FlowToxicityScaler (F3 adverse-selection defence)', () => {
  it('is neutral (scale 1) on no flow and on the first balanced observation', () => {
    const s = mk();
    expect(s.scale(0n, 0n)).toBe(1); // no aggressor flow ⇒ τ=0, nothing to widen for
    expect(s.scale(100n, 100n)).toBe(1); // perfectly two-sided ⇒ τ=0, avg=0 ⇒ neutral
  });

  it('WIDENS (scale > 1) when a one-sided sweep follows calm flow — the informed-flow case', () => {
    const s = mk();
    for (let i = 0; i < 5; i++) s.scale(55n, 45n); // calm history, τ=0.1
    const toxic = s.scale(100n, 0n); // a pure one-sided sweep, τ=1 ≫ recent average
    expect(toxic).toBeGreaterThan(1);
    expect(toxic).toBe(3); // raw=1/0.25=4, clamped to maxScale
  });

  it('TIGHTENS (scale < 1) when flow goes calm relative to a toxic history — rebate farming', () => {
    const s = mk();
    for (let i = 0; i < 5; i++) s.scale(100n, 0n); // toxic history, τ=1
    const calm = s.scale(50n, 50n); // two-sided ⇒ τ=0 ≪ average
    expect(calm).toBeLessThan(1);
    expect(calm).toBe(0.5); // raw=0, clamped to minScale
  });

  it('clamps to [minScale, maxScale]', () => {
    const s = new FlowToxicityScaler({ windowBars: 3, minScale: 0.8, maxScale: 1.5 });
    s.scale(51n, 49n); // tiny τ to seed a small average
    const big = s.scale(100n, 0n); // huge ratio
    expect(big).toBeLessThanOrEqual(1.5);
    expect(big).toBeGreaterThanOrEqual(0.8);
  });
});
