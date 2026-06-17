// RegimePortfolioRisk — the risk-manager's view of the "take sides" desk (Playbook II P10).
// The per-book cards show each position in isolation; a risk manager needs the PORTFOLIO read:
// how much is at risk, how much of it is the crypto market factor vs the desk's own bets, and
// what a bad day looks like. This is the pure aggregation behind the runner's risk header.
//
// Three reads:
//   1. EXPOSURE   — gross (Σ|notional|), net (Σ signed), and net BETA exposure (Σ signed·β):
//                   the dollar move per 1.00 move in the market factor.
//   2. VOLATILITY — per-symbol realised vol (sample stdev of recent log returns) and the desk
//                   P&L vol via a SINGLE-FACTOR risk model (the market = the hedge instrument):
//                     r_i = β_i·r_m + ε_i,  var(ε_i) = σ_i² − β_i²·σ_m²  (idiosyncratic, floored ≥0)
//                     factorVar$ = (Σ N_i β_i)²·σ_m²      (correlated — does NOT diversify away)
//                     idioVar$   = Σ (N_i·σ_idio_i)²       (independent — DOES diversify)
//                     σ_desk$    = √(factorVar$ + idioVar$)
//                   Naively summing per-book vol would understate the risk of an all-crypto book
//                   (everything moves together); the factor model captures that the beta piece is
//                   common. This ties the VaR to the SAME beta concept the P9 hedge neutralises.
//   3. VaR        — parametric (Gaussian): VaR_c = z_c · σ_desk$ · √horizonBars. 95% / 99%.
//
// Pure + clock-free (returns + notionals + betas in, numbers out), so it is fully unit-testable
// at the boundaries. USD throughout for the risk read (notionals are USD); the beta-P&L
// accrual helper returns USDC-units to feed the bigint TCA ledger.

/** Standard-normal one-tailed z for the common VaR confidences. */
export const Z95 = 1.645;
export const Z99 = 2.326;

const MICROS = 1_000_000;

/** Sample standard deviation (n−1). 0 for fewer than 2 points. */
export function sampleStdev(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const x of xs) mean += x;
  mean /= n;
  let ss = 0;
  for (const x of xs) ss += (x - mean) * (x - mean);
  return Math.sqrt(ss / (n - 1));
}

export interface BookRiskRead {
  readonly symbol: string;
  /** + long, − short, 0 flat (USD). */
  readonly signedNotionalUsd: number;
  /** Beta to the market factor (the hedge instrument). */
  readonly beta: number;
  /** Recent per-bar log returns of the symbol (for realised vol). */
  readonly returns: readonly number[];
}

export interface PortfolioRiskConfig {
  /** Desk capital (USD) — the denominator for the risk-budget (heat) read. */
  readonly capitalUsd: number;
  /** VaR horizon in bars (√-time scaled). Default 1. */
  readonly horizonBars?: number;
}

export interface PerSymbolRisk {
  readonly symbol: string;
  /** Realised vol: sample stdev of recent log returns (per bar). */
  readonly volPerBar: number;
  /** Per-bar P&L vol in USD = |notional|·volPerBar. */
  readonly pnlVolUsd: number;
}

export interface PortfolioRisk {
  readonly grossUsd: number;
  readonly netUsd: number;
  /** Σ signedNotional·β — the desk's dollar exposure to a 1.00 market-factor move. */
  readonly netBetaUsd: number;
  readonly perSymbol: readonly PerSymbolRisk[];
  /** Factor (market) component of the desk P&L vol per bar (USD). */
  readonly factorVolUsd: number;
  /** Idiosyncratic component of the desk P&L vol per bar (USD). */
  readonly idioVolUsd: number;
  /** Total desk P&L vol per bar (USD) — √(factor² + idio²). */
  readonly deskVolUsd: number;
  /** Parametric VaR over the horizon (USD, ≥ 0). */
  readonly var95Usd: number;
  readonly var99Usd: number;
  /** VaR95 as a fraction of capital — the risk-budget "heat". */
  readonly var95FracOfCapital: number;
}

/**
 * Aggregate the desk risk read.
 * @param marketReturns recent per-bar log returns of the market factor (the hedge instrument).
 */
export function aggregatePortfolioRisk(
  books: readonly BookRiskRead[],
  marketReturns: readonly number[],
  cfg: PortfolioRiskConfig,
): PortfolioRisk {
  const horizon = Math.max(1, cfg.horizonBars ?? 1);
  const sigmaM = sampleStdev(marketReturns);
  const sigmaM2 = sigmaM * sigmaM;

  let grossUsd = 0;
  let netUsd = 0;
  let netBetaUsd = 0;
  let idioVarUsd2 = 0;
  const perSymbol: PerSymbolRisk[] = [];

  for (const b of books) {
    const n = b.signedNotionalUsd;
    const absN = Math.abs(n);
    grossUsd += absN;
    netUsd += n;
    netBetaUsd += n * b.beta;

    const sigmaI = sampleStdev(b.returns);
    perSymbol.push({ symbol: b.symbol, volPerBar: sigmaI, pnlVolUsd: absN * sigmaI });

    // Idiosyncratic variance = total − systematic, floored at 0 (noisy small samples can invert).
    const idioVar = Math.max(0, sigmaI * sigmaI - b.beta * b.beta * sigmaM2);
    idioVarUsd2 += absN * absN * idioVar; // independent across symbols ⇒ variances add
  }

  // The market factor is COMMON to every book ⇒ the beta exposures sum (then square), they do
  // not diversify: factor$ vol = |Σ N_i β_i| · σ_m.
  const factorVolUsd = Math.abs(netBetaUsd) * sigmaM;
  const idioVolUsd = Math.sqrt(idioVarUsd2);
  const deskVolUsd = Math.sqrt(factorVolUsd * factorVolUsd + idioVarUsd2);

  const sqrtH = Math.sqrt(horizon);
  const var95Usd = Z95 * deskVolUsd * sqrtH;
  const var99Usd = Z99 * deskVolUsd * sqrtH;
  const var95FracOfCapital = cfg.capitalUsd > 0 ? var95Usd / cfg.capitalUsd : 0;

  return {
    grossUsd,
    netUsd,
    netBetaUsd,
    perSymbol,
    factorVolUsd,
    idioVolUsd,
    deskVolUsd,
    var95Usd,
    var99Usd,
    var95FracOfCapital,
  };
}

/**
 * The market-factor (beta) P&L earned over one interval on a held position: signedNotional·β·r_m,
 * in USDC-units (to accumulate into the bigint TCA ledger). This is the textbook factor
 * attribution — accrued each poll on the position HELD over the interval, exactly as funding is.
 */
export function betaPnlIncrementUnits(signedNotionalUsd: number, beta: number, marketReturn: number): bigint {
  if (!Number.isFinite(signedNotionalUsd) || !Number.isFinite(beta) || !Number.isFinite(marketReturn)) return 0n;
  return BigInt(Math.round(signedNotionalUsd * beta * marketReturn * MICROS));
}
