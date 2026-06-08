import { realizedVolAnnualized, gammaOverlay, variancePnlUsd, calibrateCashGamma, gammaLossForMove } from './gamma-overlay';

describe('gamma-overlay economics', () => {
  it('realizedVolAnnualized scales stdev of log returns by √periodsPerYear', () => {
    // Constant 1% up/down zig-zag ⇒ |log return| ≈ 0.00995 each step.
    const closes = [100, 101, 100, 101, 100, 101, 100];
    const perYear = 365 * 24 * 60; // 1-minute bars
    const v = realizedVolAnnualized(closes, perYear);
    expect(v).toBeGreaterThan(0);
    // sanity: a flat series has zero vol.
    expect(realizedVolAnnualized([100, 100, 100, 100], perYear)).toBe(0);
  });

  it('clears the premium only when realised vol beats implied (recover fraction > 0)', () => {
    // Realised 80% vs implied 50% ⇒ vol was UNDERPRICED ⇒ long gamma recovers most of the bleed.
    const hot = gammaOverlay({ realizedVol: 0.8, impliedVol: 0.5, bleedUsd: 10_000, costUsd: 500 });
    expect(hot.recoverFraction).toBeCloseTo(1 - 0.25 / 0.64, 6); // ≈ 0.609
    expect(hot.recoveredUsd).toBeCloseTo(6_093.75, 1);
    expect(hot.netUsd).toBeGreaterThan(0);
    expect(hot.clears).toBe(true);
  });

  it('does NOT clear when implied ≥ realised (the volatility risk premium) — insurance, not an engine', () => {
    // Realised 40% vs implied 55% ⇒ options richer than the move ⇒ overlay is net-negative.
    const calm = gammaOverlay({ realizedVol: 0.4, impliedVol: 0.55, bleedUsd: 10_000, costUsd: 0 });
    expect(calm.recoverFraction).toBeLessThan(0);
    expect(calm.netUsd).toBeLessThan(0);
    expect(calm.clears).toBe(false);
  });

  it('variancePnlUsd is positive iff realised variance exceeds implied', () => {
    expect(variancePnlUsd(1_000_000, 0.8, 0.5, 1)).toBeGreaterThan(0);
    expect(variancePnlUsd(1_000_000, 0.4, 0.5, 1)).toBeLessThan(0);
  });

  it('calibrateCashGamma is self-consistent: variancePnl(G,rv,iv,T) == the overlay recovery', () => {
    const bleed = 2_345;
    const rv = 0.83;
    const years = 12 / (365 * 24); // a 12h window
    const G = calibrateCashGamma(bleed, rv, years);
    expect(G).toBeGreaterThan(0);
    // The calibrated cash-gamma reproduces the bleed: ½·G·rv²·T == bleed.
    expect(0.5 * G * rv * rv * years).toBeCloseTo(bleed, 6);
    // …and the variance-form overlay P&L matches gammaOverlay's recovered USD at any implied.
    const iv = 0.55;
    expect(variancePnlUsd(G, rv, iv, years)).toBeCloseTo(gammaOverlay({ realizedVol: rv, impliedVol: iv, bleedUsd: bleed }).recoveredUsd, 6);
  });

  it('gammaLossForMove reports the short-gamma bleed per move (½·G·move²)', () => {
    expect(gammaLossForMove(5_000_000, 0.01)).toBeCloseTo(250, 6); // $5M cash-gamma ⇒ $250 per 1% move
    expect(calibrateCashGamma(0, 0.5, 1)).toBe(0); // no bleed ⇒ no gamma
  });
});
