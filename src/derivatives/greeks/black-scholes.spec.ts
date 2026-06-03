import { blackScholes, normCdf, normPdf, BlackScholesPricer } from './black-scholes';

describe('normCdf / normPdf', () => {
  it('is 0.5 at 0 and saturates', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(8)).toBeCloseTo(1, 6);
    expect(normCdf(-8)).toBeCloseTo(0, 6);
  });
  it('matches known normal CDF points', () => {
    expect(normCdf(1)).toBeCloseTo(0.841345, 4);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
  it('pdf peaks at 0', () => {
    expect(normPdf(0)).toBeCloseTo(0.398942, 5);
  });
});

describe('blackScholes — Hull textbook example (S=K=100, T=1, σ=0.2, r=0.05)', () => {
  const common = { spot: 100, strike: 100, tYears: 1, iv: 0.2, rate: 0.05 };

  it('prices the call at ≈ 10.4506', () => {
    const c = blackScholes({ type: 'CALL', ...common });
    expect(c.price).toBeCloseTo(10.4506, 2);
    expect(c.delta).toBeCloseTo(0.6368, 3);
    expect(c.vega).toBeCloseTo(37.524, 1); // per 1.00 vol
    expect(c.gamma).toBeGreaterThan(0);
    expect(c.theta).toBeLessThan(0); // long option bleeds time value
    expect(c.rho).toBeGreaterThan(0);
  });

  it('prices the put at ≈ 5.5735 and obeys put-call parity', () => {
    const c = blackScholes({ type: 'CALL', ...common });
    const p = blackScholes({ type: 'PUT', ...common });
    expect(p.price).toBeCloseTo(5.5735, 2);
    // C − P = S − K·e^(−rT)
    expect(c.price - p.price).toBeCloseTo(100 - 100 * Math.exp(-0.05), 3);
    expect(p.delta).toBeLessThan(0);
    expect(p.delta).toBeCloseTo(c.delta - 1, 6); // put delta = call delta − 1
    expect(p.gamma).toBeCloseTo(c.gamma, 9); // gamma shared
    expect(p.vega).toBeCloseTo(c.vega, 9); // vega shared
  });
});

describe('blackScholes — structure', () => {
  it('ATM call delta is just above 0.5 (r=0)', () => {
    const c = blackScholes({ type: 'CALL', spot: 100, strike: 100, tYears: 0.25, iv: 0.5, rate: 0 });
    expect(c.delta).toBeGreaterThan(0.5);
    expect(c.delta).toBeLessThan(0.6);
  });
  it('deep ITM call → delta ≈ 1, deep OTM → ≈ 0', () => {
    const itm = blackScholes({ type: 'CALL', spot: 200, strike: 100, tYears: 0.5, iv: 0.4, rate: 0 });
    const otm = blackScholes({ type: 'CALL', spot: 50, strike: 100, tYears: 0.5, iv: 0.4, rate: 0 });
    expect(itm.delta).toBeGreaterThan(0.95);
    expect(otm.delta).toBeLessThan(0.05);
  });
  it('collapses to intrinsic at expiry', () => {
    const c = blackScholes({ type: 'CALL', spot: 120, strike: 100, tYears: 0, iv: 0.5, rate: 0 });
    expect(c.price).toBeCloseTo(20, 6);
    expect(c.vega).toBe(0);
    expect(c.gamma).toBe(0);
  });
});

describe('BlackScholesPricer (IOptionPricer)', () => {
  it('derives T from expiry and returns it', () => {
    const now = 1_000_000_000_000;
    const pricer = new BlackScholesPricer();
    const q = pricer.price(
      { type: 'CALL', strike: 100, expiryMs: now + 365 * 24 * 3600 * 1000 },
      { spot: 100, iv: 0.2, rate: 0.05, asOfMs: now },
    );
    expect(q.tYears).toBeCloseTo(1, 6);
    expect(q.price).toBeCloseTo(10.4506, 2);
    expect(pricer.modelId).toBe('black-scholes');
  });
});
