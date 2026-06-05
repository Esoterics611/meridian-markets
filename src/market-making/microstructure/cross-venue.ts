// Cross-venue fair-value fusion (FAIR_VALUE_AND_THESIS_DESIGN.md F2).
//
// HL is itself a price-discovery venue, NOT just a Binance follower — so this is a
// MEASURED fusion, never an assumption. Given HL's own fair value (the micro-price)
// and a lead venue's mid (e.g. Binance spot), pull the quote center toward the lead
// in proportion to a per-coin coefficient β that is FIT FROM THE DATA:
//
//   center = hlCenter + β · (leadMid − hlMid)
//
// β is the error-correction speed — how much of the cross-venue basis gap HL closes
// over the next interval. β > 0 and significant ⇒ the lead venue LEADS (its price is
// information HL hasn't priced yet); β ≈ 0 ⇒ HL self-discovers and the lead term is
// noise to be skipped. The sign + size + stability are an EMPIRICAL, per-coin question
// the lead-lag profile answers (see leadLagProfile / estimateErrorCorrectionBeta).

const MICROS = 1;

/** Fuse the HL fair value with a lead venue's mid by the fit coefficient β (micros in/out). */
export function crossVenueReference(hlCenterMicros: bigint, hlMidMicros: bigint, leadMidMicros: bigint, beta: number): bigint {
  if (!Number.isFinite(beta) || beta === 0) return hlCenterMicros;
  const gap = Number(leadMidMicros) - Number(hlMidMicros);
  return hlCenterMicros + BigInt(Math.round(beta * gap * MICROS));
}

/**
 * Two-sided lead-lag cross-correlation: for each lag in [−maxLag, +maxLag],
 * corr(hlReturn_t, leadReturn_{t−lag}). A positive peak at **lag > 0** means the
 * lead venue's PAST return predicts HL's current return ⇒ the lead venue LEADS HL.
 * A peak at lag < 0 means HL leads. A peak at lag 0 ⇒ contemporaneous. Returns one
 * entry per lag; the caller reads off the peak to decide who leads (and whether to
 * use the cross-venue term at all). Series must be aligned + equal length.
 */
export function leadLagProfile(hlReturns: number[], leadReturns: number[], maxLag: number): { lag: number; corr: number }[] {
  const n = Math.min(hlReturns.length, leadReturns.length);
  const out: { lag: number; corr: number }[] = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let t = 0; t < n; t++) {
      const j = t - lag; // leadReturn_{t-lag}
      if (j < 0 || j >= n) continue;
      xs.push(hlReturns[t]);
      ys.push(leadReturns[j]);
    }
    out.push({ lag, corr: pearson(xs, ys) });
  }
  return out;
}

/** The lag (and its correlation) with the largest |corr| — who leads + how strongly. */
export function dominantLead(profile: { lag: number; corr: number }[]): { lag: number; corr: number } {
  let best = { lag: 0, corr: 0 };
  for (const p of profile) if (Math.abs(p.corr) > Math.abs(best.corr)) best = p;
  return best;
}

/**
 * Error-correction β: regress next HL return on the current cross-venue basis,
 *   (hlMid_{t+1} − hlMid_t)/hlMid_t  ~  β · (leadMid_t − hlMid_t)/hlMid_t,
 * the OLS slope through the origin. β > 0 ⇒ HL reverts toward the lead (lead leads).
 * Inputs are aligned mid series (any units). Returns 0 on degenerate input.
 */
export function estimateErrorCorrectionBeta(hlMids: number[], leadMids: number[]): number {
  const n = Math.min(hlMids.length, leadMids.length) - 1;
  if (n <= 1) return 0;
  let sxy = 0;
  let sxx = 0;
  for (let t = 0; t < n; t++) {
    if (hlMids[t] <= 0) continue;
    const basis = (leadMids[t] - hlMids[t]) / hlMids[t]; // x
    const fwd = (hlMids[t + 1] - hlMids[t]) / hlMids[t]; // y
    sxy += basis * fwd;
    sxx += basis * basis;
  }
  return sxx > 0 ? sxy / sxx : 0;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i]; sxy += xs[i] * ys[i];
  }
  const cov = n * sxy - sx * sy;
  const vx = n * sxx - sx * sx;
  const vy = n * syy - sy * sy;
  const denom = Math.sqrt(vx * vy);
  return denom > 0 ? cov / denom : 0;
}
