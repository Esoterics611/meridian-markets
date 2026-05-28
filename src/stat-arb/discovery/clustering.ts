import { Bar } from '../backtest/bar';
import { PairCandidate } from './pair-discovery';

// Clustering — given the universe symbol set and a pair-discovery result,
// group symbols by correlation and emit one representative per cluster. This
// prevents the Universe card from showing 10 candidate pairs that are all
// effectively the same trade.
//
// Approach: hierarchical agglomerative clustering with single-linkage on the
// Pearson-distance metric (d = 1 - |rho|). Cut the dendrogram at
// `distanceThreshold` to form flat clusters.
//
// Representative selection per cluster: keep the symbol with highest average
// pairwise |correlation| against its cluster-mates. That's the "central" node
// that summarises the cluster.

export interface ClusterAssignment {
  /** Stable cluster id, 0-indexed. */
  clusterId: number;
  symbols: string[];
  /** Symbol nominated to represent this cluster on the dashboard. */
  representative: string;
}

export interface ClusteringResult {
  clusters: ClusterAssignment[];
  /** Map from symbol → cluster id (inverse lookup). */
  symbolToCluster: Map<string, number>;
  /** Filtered candidate list: at most one pair per (clusterA, clusterB) bucket. */
  representativePairs: PairCandidate[];
}

export interface ClusteringConfig {
  /** Hierarchical-cut threshold on distance (1 - |rho|). 0.3 → |rho| > 0.7 merges. */
  distanceThreshold: number;
}

export function clusterSymbols(
  universe: Map<string, Bar[]>,
  cfg: ClusteringConfig,
): { clusters: ClusterAssignment[]; symbolToCluster: Map<string, number> } {
  const symbols = [...universe.keys()];
  const n = symbols.length;
  if (n === 0) return { clusters: [], symbolToCluster: new Map() };

  // Pre-compute log-price series per symbol for correlation calcs.
  const logSeries = symbols.map((s) => universe.get(s)!.map((b) => Math.log(b.close)));

  // Pairwise distance matrix — d(i,j) = 1 - |rho(i,j)|. Symmetric, diag=0.
  const dist: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const m = Math.min(logSeries[i].length, logSeries[j].length);
      const d = 1 - Math.abs(pearson(logSeries[i].slice(0, m), logSeries[j].slice(0, m)));
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }

  // Single-linkage agglomerative clustering with a threshold. We track
  // each cluster as a list of member indices; merge any two clusters whose
  // single-linkage distance is below the threshold; iterate until no more
  // merges are possible.
  let clusters: number[][] = symbols.map((_, i) => [i]);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let ci = 0; ci < clusters.length; ci++) {
      for (let cj = ci + 1; cj < clusters.length; cj++) {
        const link = singleLinkage(clusters[ci], clusters[cj], dist);
        if (link < cfg.distanceThreshold) {
          clusters[ci] = clusters[ci].concat(clusters[cj]);
          clusters.splice(cj, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  // Build the assignment list with per-cluster representatives.
  const out: ClusterAssignment[] = clusters.map((memberIdx, cid) => {
    const memberSymbols = memberIdx.map((i) => symbols[i]);
    const rep = nominateRepresentative(memberIdx, dist, symbols);
    return { clusterId: cid, symbols: memberSymbols, representative: rep };
  });
  const symbolToCluster = new Map<string, number>();
  out.forEach((c) => c.symbols.forEach((s) => symbolToCluster.set(s, c.clusterId)));
  return { clusters: out, symbolToCluster };
}

/** Filter a pair-discovery candidate list down to representative pairs only. */
export function pickRepresentativePairs(
  candidates: PairCandidate[],
  symbolToCluster: Map<string, number>,
): PairCandidate[] {
  // For each (clusterA, clusterB) bucket, keep the best-scoring pair.
  const bestByBucket = new Map<string, PairCandidate>();
  for (const c of candidates) {
    const ca = symbolToCluster.get(c.symbolA);
    const cb = symbolToCluster.get(c.symbolB);
    if (ca === undefined || cb === undefined) continue;
    const key = ca < cb ? `${ca}|${cb}` : `${cb}|${ca}`;
    const prev = bestByBucket.get(key);
    if (!prev || c.score < prev.score) bestByBucket.set(key, c);
  }
  return [...bestByBucket.values()].sort((a, b) => a.score - b.score);
}

export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const ax = a[i] - ma, bx = b[i] - mb;
    num += ax * bx;
    da += ax * ax;
    db += bx * bx;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

function singleLinkage(a: number[], b: number[], dist: number[][]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const i of a) for (const j of b) {
    if (dist[i][j] < min) min = dist[i][j];
  }
  return min;
}

function nominateRepresentative(memberIdx: number[], dist: number[][], symbols: string[]): string {
  if (memberIdx.length === 1) return symbols[memberIdx[0]];
  let bestIdx = memberIdx[0];
  let bestAvgCorr = -Infinity;
  for (const i of memberIdx) {
    let sum = 0, count = 0;
    for (const j of memberIdx) if (j !== i) { sum += (1 - dist[i][j]); count++; }
    const avg = count > 0 ? sum / count : 0;
    if (avg > bestAvgCorr) { bestAvgCorr = avg; bestIdx = i; }
  }
  return symbols[bestIdx];
}
