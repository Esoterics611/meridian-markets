import { Bar } from './bar';

// SyntheticUniverse — generates a multi-symbol universe with controlled
// cointegration relationships. Pair-discovery runs over this; the discovery
// engine should find the cluster pairs (high cointegration) and ignore the
// noise symbols (low cointegration).
//
// Structure:
//   * `clusterCount` clusters, each with `symbolsPerCluster` cointegrated symbols.
//     Inside a cluster, all symbols share a common driver process; their log-
//     spreads are bounded sine waves so the Engle-Granger residuals are
//     mean-reverting. Different per-symbol offsets keep the absolute prices
//     distinct.
//   * `noiseSymbols` lone symbols that follow independent drifts and are
//     uncorrelated with everything else.
//
// Deterministic: no RNG. Same inputs → same bars across runs. Pure closed-form
// functions of (cluster index, symbol-in-cluster index, bar index).

export interface UniverseConfig {
  barCount: number;
  startAt: Date;
  barIntervalMs: number;
  /** Number of cointegration clusters. */
  clusterCount: number;
  /** Symbols per cluster. Cluster-internal pairs should be cointegrated. */
  symbolsPerCluster: number;
  /** Additional lone noise symbols (no cointegrated partners). */
  noiseSymbols: number;
}

export interface UniverseFeed {
  /** Per-symbol bar series. Map iteration order matches the universe spec. */
  bars: Map<string, Bar[]>;
  /** Ground-truth cluster membership. discovery should rediscover these. */
  clusters: { clusterId: number; symbols: string[] }[];
  /** Symbols with no cointegrated partners. */
  noiseSymbols: string[];
}

/** Stable symbol naming so test assertions can pin to them. */
export function clusterSymbolName(clusterId: number, idx: number): string {
  return `C${clusterId}-S${idx}`;
}
export function noiseSymbolName(idx: number): string {
  return `N${idx}`;
}

export function generateSyntheticUniverse(cfg: UniverseConfig): UniverseFeed {
  const bars = new Map<string, Bar[]>();
  const clusters: UniverseFeed['clusters'] = [];
  const noiseSymbols: string[] = [];

  // ── clusters ───────────────────────────────────────────────────────────
  for (let c = 0; c < cfg.clusterCount; c++) {
    const clusterSymbols: string[] = [];
    const basePriceForCluster = 100 * (c + 1); // 100, 200, 300, ...

    for (let s = 0; s < cfg.symbolsPerCluster; s++) {
      const sym = clusterSymbolName(c, s);
      clusterSymbols.push(sym);
      const series = makeClusterMember(cfg, c, s, basePriceForCluster, sym);
      bars.set(sym, series);
    }
    clusters.push({ clusterId: c, symbols: clusterSymbols });
  }

  // ── noise ──────────────────────────────────────────────────────────────
  for (let i = 0; i < cfg.noiseSymbols; i++) {
    const sym = noiseSymbolName(i);
    noiseSymbols.push(sym);
    bars.set(sym, makeNoiseSymbol(cfg, i, sym));
  }

  return { bars, clusters, noiseSymbols };
}

function makeClusterMember(
  cfg: UniverseConfig,
  clusterId: number,
  idxInCluster: number,
  basePrice: number,
  sym: string,
): Bar[] {
  const out: Bar[] = [];
  // Cluster-shared driver dominates the trend so all cluster symbols co-move.
  // Each cluster has its own driver waveform (sine + cosine at different
  // periods + small offset). The clusters are linearly independent — pearson
  // between two different cluster drivers is near zero, so clustering by
  // absolute correlation separates them cleanly.
  const driftSlope = 0; // intentionally flat; cluster identity comes from waveform
  const driftAmp = 0.15;
  const driftFreq1 = 47 + clusterId * 31;
  const driftFreq2 = 73 + clusterId * 19;
  const driftPhase = (clusterId * Math.PI) / 3;
  // Per-symbol idiosyncratic residual: AR(1) (mean-reverting) driven by a
  // small deterministic forcing. Sine-wave residuals look stationary but
  // ADF tests reject them because Δr_t isn't linearly related to r_{t-1}
  // for periodic series. AR(1) with ρ < 1 gives a textbook stationary
  // process whose first-difference ADF cleanly rejects.
  const rho = 0.72; // autoregressive coefficient — stationary (|ρ| < 1)
  const eAmp = 0.004 + 0.001 * idxInCluster;
  const eFreq = 11 + idxInCluster * 3;
  const symLevel = 0.4 * idxInCluster; // log-price offset per symbol

  let idio = 0;
  for (let i = 0; i < cfg.barCount; i++) {
    const driver =
      driftSlope * i +
      driftAmp * Math.sin((2 * Math.PI * i) / driftFreq1 + driftPhase) +
      0.5 * driftAmp * Math.cos((2 * Math.PI * i) / driftFreq2);
    const epsilon = eAmp * Math.sin((2 * Math.PI * i) / eFreq);
    idio = rho * idio + epsilon;
    const logP = Math.log(basePrice) + symLevel + driver + idio;
    const p = Math.exp(logP);
    const ts = new Date(cfg.startAt.getTime() + i * cfg.barIntervalMs);
    out.push({
      symbol: sym,
      timestamp: ts,
      open: p,
      high: p * 1.001,
      low: p * 0.999,
      close: p,
      // Vol decreases per intra-cluster index so the first symbol in each
      // cluster looks like the most liquid one. Discovery should prefer it.
      volume: 100 * Math.max(1, cfg.symbolsPerCluster - idxInCluster),
    });
  }
  return out;
}

function makeNoiseSymbol(cfg: UniverseConfig, idx: number, sym: string): Bar[] {
  const out: Bar[] = [];
  // Each noise symbol gets a unique mid-frequency driver so it's not flat
  // but also not cointegrated with any cluster. The slope and freqs are
  // distinct per noise index, so noise symbols aren't cointegrated with
  // each other either.
  const slope = 0.0001 * (idx + 1) * (idx % 2 === 0 ? 1 : -1);
  const freqA = 13 + idx * 3;
  const freqB = 31 + idx;
  const amp = 0.05 + (idx % 4) * 0.01;
  const basePrice = 50 + idx * 7;

  for (let i = 0; i < cfg.barCount; i++) {
    const driver = slope * i + amp * Math.sin((2 * Math.PI * i) / freqA) + 0.01 * Math.cos((2 * Math.PI * i) / freqB);
    const logP = Math.log(basePrice) + driver;
    const p = Math.exp(logP);
    const ts = new Date(cfg.startAt.getTime() + i * cfg.barIntervalMs);
    out.push({
      symbol: sym,
      timestamp: ts,
      open: p,
      high: p * 1.001,
      low: p * 0.999,
      close: p,
      volume: 50,
    });
  }
  return out;
}
