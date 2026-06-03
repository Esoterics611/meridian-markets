// IOptionPricer — the pricing/Greeks seam for the derivatives strategy families
// (STRATEGY_LIBRARY_REWRITE.md §3.3). An options book's risk is not a price
// spread or a hedge ratio — it is the Greeks (Δ/Γ/ν/Θ/ρ). This is the contract a
// quoter/strategy and the Greeks-budget risk gate consume, with a real
// (Black-Scholes / Bachelier) and a mock implementation, selected by config —
// the same swap-seam discipline as IBarFeed / ITradingVenue / IQuoter (CLAUDE.md §7).
//
// Conventions (documented because Greeks conventions vary by venue):
//   delta  — ∂price/∂spot, unitless (calls 0..1, puts −1..0)
//   gamma  — ∂²price/∂spot², per 1 unit of spot
//   vega   — ∂price/∂σ for a 1.00 (=100%) change in vol. Per 1% vol = vega/100.
//   theta  — ∂price/∂t per YEAR (calendar). Per day = theta/365.
//   rho    — ∂price/∂r for a 1.00 change in the rate. Per 1% = rho/100.
// price/spot/strike are in the same currency unit; iv and rate are fractions
// (0.55 = 55% vol, 0.03 = 3%); time is derived from expiryMs − asOfMs.

export const OPTION_PRICER = Symbol('OPTION_PRICER');

export type OptionType = 'CALL' | 'PUT';

export interface OptionSpec {
  type: OptionType;
  strike: number;
  expiryMs: number;
}

export interface PriceInputs {
  spot: number;
  /** Implied volatility as a fraction (0.55 = 55%). */
  iv: number;
  /** Risk-free / funding rate as a fraction. */
  rate: number;
  asOfMs: number;
}

export interface Greeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
}

export interface OptionQuote extends Greeks {
  price: number;
  /** Year-fraction to expiry used in the calc. */
  tYears: number;
}

export interface IOptionPricer {
  readonly modelId: string;
  price(opt: OptionSpec, inp: PriceInputs): OptionQuote;
}

/** Year-fraction to expiry, floored at a tiny epsilon so an expiring option is finite. */
export function yearsToExpiry(expiryMs: number, asOfMs: number): number {
  return Math.max((expiryMs - asOfMs) / (365 * 24 * 3600 * 1000), 1e-9);
}

// MockOptionPricer — deterministic, model-free default (safe default per §7). Not
// a real model: price = intrinsic + a flat time-value proportional to iv·√T·spot;
// Greeks are crude stand-ins. Lets the engine/tests run with no BS dependency.
export class MockOptionPricer implements IOptionPricer {
  readonly modelId = 'mock';
  price(opt: OptionSpec, inp: PriceInputs): OptionQuote {
    const t = yearsToExpiry(opt.expiryMs, inp.asOfMs);
    const intrinsic = opt.type === 'CALL' ? Math.max(inp.spot - opt.strike, 0) : Math.max(opt.strike - inp.spot, 0);
    const timeValue = inp.iv * Math.sqrt(t) * inp.spot * 0.4;
    return {
      price: intrinsic + timeValue,
      tYears: t,
      delta: opt.type === 'CALL' ? 0.5 : -0.5,
      gamma: 0,
      vega: Math.sqrt(t) * inp.spot * 0.4,
      theta: -timeValue / Math.max(t * 365, 1),
      rho: 0,
    };
  }
}
