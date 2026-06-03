import { IOptionPricer, OptionSpec, OptionQuote, PriceInputs, yearsToExpiry } from './option-pricer.interface';

// Black-Scholes-Merton European option pricing + the full Greek set. Pure,
// deterministic, textbook (Hull, "Options, Futures, and Other Derivatives") —
// the real IOptionPricer behind the derivatives families. Unit-tested against
// known points (ATM delta ≈ 0.5, put-call parity, monotonicity), the same
// "test direction + known values, not magnitude" rigor as the AS quoter.
//
// Conventions documented on IOptionPricer: vega per 1.00 vol, theta per year.

/** Standard normal PDF. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation (|err| < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-0.5 * x * x); // = normPdf(x)
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export interface BsInputs {
  type: 'CALL' | 'PUT';
  spot: number;
  strike: number;
  /** Year-fraction to expiry. */
  tYears: number;
  /** Vol as a fraction (0.55 = 55%). */
  iv: number;
  /** Rate as a fraction. */
  rate: number;
}

/** Black-Scholes price + Greeks. Vega per 1.00 vol, theta per year, rho per 1.00 rate. */
export function blackScholes(p: BsInputs): Omit<OptionQuote, 'tYears'> {
  const { spot: S, strike: K, tYears: T, iv: sigma, rate: r } = p;
  const sqrtT = Math.sqrt(T);

  // Degenerate (expiry/zero-vol): collapse to discounted intrinsic, flat Greeks.
  if (sigma <= 0 || T <= 0 || S <= 0 || K <= 0) {
    const disc = Math.exp(-r * T);
    const intrinsic = p.type === 'CALL' ? Math.max(S - K * disc, 0) : Math.max(K * disc - S, 0);
    const itm = p.type === 'CALL' ? S > K : S < K;
    return { price: intrinsic, delta: itm ? (p.type === 'CALL' ? 1 : -1) : 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }

  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const disc = Math.exp(-r * T);
  const pdfD1 = normPdf(d1);

  // Gamma + vega are the same for calls and puts.
  const gamma = pdfD1 / (S * sigma * sqrtT);
  const vega = S * pdfD1 * sqrtT;

  if (p.type === 'CALL') {
    const Nd1 = normCdf(d1);
    const Nd2 = normCdf(d2);
    return {
      price: S * Nd1 - K * disc * Nd2,
      delta: Nd1,
      gamma,
      vega,
      theta: (-S * pdfD1 * sigma) / (2 * sqrtT) - r * K * disc * Nd2,
      rho: K * T * disc * Nd2,
    };
  }
  const Nnd1 = normCdf(-d1);
  const Nnd2 = normCdf(-d2);
  return {
    price: K * disc * Nnd2 - S * Nnd1,
    delta: -Nnd1, // = N(d1) − 1
    gamma,
    vega,
    theta: (-S * pdfD1 * sigma) / (2 * sqrtT) + r * K * disc * Nnd2,
    rho: -K * T * disc * Nnd2,
  };
}

export class BlackScholesPricer implements IOptionPricer {
  readonly modelId = 'black-scholes';
  constructor(private readonly defaultRate = 0) {}

  price(opt: OptionSpec, inp: PriceInputs): OptionQuote {
    const t = yearsToExpiry(opt.expiryMs, inp.asOfMs);
    const g = blackScholes({
      type: opt.type,
      spot: inp.spot,
      strike: opt.strike,
      tYears: t,
      iv: inp.iv,
      rate: inp.rate ?? this.defaultRate,
    });
    return { ...g, tYears: t };
  }
}
