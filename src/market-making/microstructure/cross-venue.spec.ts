import { crossVenueReference, leadLagProfile, dominantLead, estimateErrorCorrectionBeta } from './cross-venue';

describe('crossVenueReference', () => {
  it('pulls the center toward the lead by β·(lead − hlMid)', () => {
    // hlCenter 100.000000, hlMid 100.000000, lead 100.100000, β=0.5 ⇒ +0.5·0.1 = +0.05
    const r = crossVenueReference(100_000_000n, 100_000_000n, 100_100_000n, 0.5);
    expect(r).toBe(100_050_000n);
  });
  it('β=0 (HL self-sufficient) ⇒ the lead term is ignored', () => {
    expect(crossVenueReference(100_000_000n, 100_000_000n, 105_000_000n, 0)).toBe(100_000_000n);
  });
  it('a negative gap (lead below HL) pulls the center down', () => {
    expect(crossVenueReference(100_000_000n, 100_000_000n, 99_000_000n, 1)).toBe(99_000_000n);
  });
});

describe('leadLagProfile / dominantLead', () => {
  it('detects when the lead venue LEADS (peak at lag > 0)', () => {
    // leadReturns drive hlReturns one step later: hl_t = lead_{t-1}.
    const lead = [0.01, -0.02, 0.03, -0.01, 0.02, 0.0, -0.03, 0.01];
    const hl = [0, ...lead.slice(0, -1)]; // hl lags lead by 1
    const prof = leadLagProfile(hl, lead, 3);
    const peak = dominantLead(prof);
    expect(peak.lag).toBe(1); // lead leads HL by 1 step
    expect(peak.corr).toBeGreaterThan(0.9);
  });

  it('detects contemporaneous discovery (peak at lag 0)', () => {
    // A long aperiodic series ⇒ autocorrelation is 1 at lag 0, well below 1 elsewhere.
    const a: number[] = [];
    for (let t = 0; t < 80; t++) a.push(Math.sin(t) * 0.5 + Math.sin(t * 2.7) * 0.3);
    const prof = leadLagProfile(a, a, 4);
    expect(dominantLead(prof).lag).toBe(0);
    expect(dominantLead(prof).corr).toBeCloseTo(1, 6);
  });
});

describe('estimateErrorCorrectionBeta', () => {
  it('is positive when HL reverts toward the lead (lead leads)', () => {
    // HL closes half the basis gap each step toward a lead held above it.
    const lead: number[] = [];
    const hl: number[] = [];
    let h = 100;
    for (let t = 0; t < 200; t++) {
      const l = 101; // lead persistently 1% above
      lead.push(l);
      hl.push(h);
      h = h + 0.5 * (l - h); // revert halfway toward lead
    }
    const beta = estimateErrorCorrectionBeta(hl, lead);
    expect(beta).toBeGreaterThan(0.3);
  });

  it('is ≈0 when HL ignores the lead (self-sufficient / random walk)', () => {
    const hl: number[] = [];
    const lead: number[] = [];
    let h = 100;
    for (let t = 0; t < 300; t++) {
      h += Math.sin(t * 1.3) * 0.1; // deterministic wiggle, uncorrelated with the basis
      hl.push(h);
      lead.push(100 + Math.cos(t * 0.7) * 0.5); // independent
    }
    expect(Math.abs(estimateErrorCorrectionBeta(hl, lead))).toBeLessThan(0.5);
  });
});
