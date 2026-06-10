/*
 * toxicity-validation.ts — decide what F3 should consume: VPIN or plain signed-volume imbalance.
 *
 * The study (docs/residual_mm_risk_study.md §2.2e, §7.4): VPIN's predictive power is largely a
 * mechanical volume artifact (Andersen–Bondarenko 2014) — so before trusting it, regress the
 * FORWARD 1-min adverse move on (a) |tradeFlowImbalance| (captured since the flow shadow began)
 * and (b) vpin (captured from WP2 runs onward). If VPIN adds nothing over imbalance, F3 keeps
 * consuming imbalance and we skip the complexity.
 *
 * Method (DB-free, reads docs/research/flow-shadow-*.jsonl):
 *   - per symbol, join each obs to the first obs ≥ horizon (default 60s) forward;
 *   - target = |mid_{t+h}/mid_t − 1| · 1e4  (the unsigned adverse-risk magnitude a maker prices);
 *   - report per covariate: Pearson r, and a quintile table (mean fwd move per covariate quintile)
 *     — the quintile spread (Q5−Q1) is the honest, distribution-free read;
 *   - VERDICT per symbol: vpin wins / imbalance wins / tie (within 10% on Q5−Q1), or
 *     "no vpin captured" on pre-WP2 tapes.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/toxicity-validation.ts                      # all shadow files
 *   npx ts-node -r tsconfig-paths/register scripts/toxicity-validation.ts <file.jsonl> [60]    # one file, horizon s
 */
import * as fs from 'fs';
import * as path from 'path';

interface Obs {
  tsMs: number;
  symbol: string;
  tradeFlowImbalance: number;
  midMicros: string;
  vpin?: number | null;
}

interface Joined {
  tox: number; // |tradeFlowImbalance|
  vpin: number | null;
  fwdBps: number; // |forward move| in bps
}

function loadObs(file: string): Obs[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as Obs;
      } catch {
        return null;
      }
    })
    .filter((o): o is Obs => o !== null && typeof o.tsMs === 'number' && typeof o.midMicros === 'string');
}

/** Join each obs to the first obs ≥ horizonMs forward (same symbol stream, two-pointer). */
function joinForward(obs: Obs[], horizonMs: number): Joined[] {
  const out: Joined[] = [];
  let j = 0;
  for (let i = 0; i < obs.length; i++) {
    while (j < obs.length && obs[j].tsMs - obs[i].tsMs < horizonMs) j++;
    if (j >= obs.length) break;
    const m0 = Number(obs[i].midMicros);
    const m1 = Number(obs[j].midMicros);
    if (!(m0 > 0) || !(m1 > 0)) continue;
    // Skip joins that landed far past the horizon (a capture gap, not a 1-min forward read).
    if (obs[j].tsMs - obs[i].tsMs > horizonMs * 3) continue;
    out.push({
      tox: Math.abs(obs[i].tradeFlowImbalance ?? 0),
      vpin: typeof obs[i].vpin === 'number' ? (obs[i].vpin as number) : null,
      fwdBps: Math.abs(m1 / m0 - 1) * 1e4,
    });
  }
  return out;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 30) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Mean fwd move per covariate quintile; returns [q1..q5] means + the Q5−Q1 spread. */
function quintiles(rows: { x: number; y: number }[]): { means: number[]; spread: number } | null {
  if (rows.length < 50) return null;
  const sorted = [...rows].sort((a, b) => a.x - b.x);
  const per = Math.floor(sorted.length / 5);
  const means: number[] = [];
  for (let q = 0; q < 5; q++) {
    const slice = sorted.slice(q * per, q === 4 ? sorted.length : (q + 1) * per);
    means.push(slice.reduce((a, r) => a + r.y, 0) / slice.length);
  }
  return { means, spread: means[4] - means[0] };
}

function fmt(n: number | null, dp = 2): string {
  return n === null ? '—' : n.toFixed(dp);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const horizonS = args[1] ? parseInt(args[1], 10) : 60;
  const dir = 'docs/research';
  const files = args[0]
    ? [args[0]]
    : fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('flow-shadow-') && f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f));
  if (files.length === 0) {
    console.error('no flow-shadow-*.jsonl files found');
    process.exit(1);
  }

  // Pool all files, split per symbol (each file is one run; streams don't cross runs because the
  // forward join is two-pointer within one sorted stream — so join per file, pool the joins).
  const pooled = new Map<string, Joined[]>();
  for (const f of files) {
    const bySym = new Map<string, Obs[]>();
    for (const o of loadObs(f)) {
      const arr = bySym.get(o.symbol) ?? [];
      arr.push(o);
      bySym.set(o.symbol, arr);
    }
    for (const [sym, arr] of bySym) {
      arr.sort((a, b) => a.tsMs - b.tsMs);
      const joined = joinForward(arr, horizonS * 1000);
      const acc = pooled.get(sym) ?? [];
      acc.push(...joined);
      pooled.set(sym, acc);
    }
  }

  console.log(`toxicity-validation — forward |move| at +${horizonS}s vs toxicity covariates`);
  console.log(`files: ${files.length}, study §2.2e: if VPIN ≤ imbalance, F3 keeps imbalance\n`);
  console.log('symbol\tn\tr(imb)\tQ5−Q1(imb)bps\tn(vpin)\tr(vpin)\tQ5−Q1(vpin)bps\tverdict');

  for (const [sym, rows] of [...pooled.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const imb = rows.map((r) => ({ x: r.tox, y: r.fwdBps }));
    const vp = rows.filter((r) => r.vpin !== null).map((r) => ({ x: r.vpin as number, y: r.fwdBps }));
    const rImb = pearson(imb.map((r) => r.x), imb.map((r) => r.y));
    const qImb = quintiles(imb);
    const rVp = pearson(vp.map((r) => r.x), vp.map((r) => r.y));
    const qVp = quintiles(vp);
    let verdict: string;
    if (vp.length < 50) verdict = 'no vpin captured (pre-WP2 tape)';
    else if (qImb && qVp) {
      verdict = qVp.spread > qImb.spread * 1.1 ? 'VPIN wins' : qImb.spread > qVp.spread * 1.1 ? 'imbalance wins' : 'tie → keep imbalance';
    } else verdict = 'insufficient data';
    console.log(
      `${sym}\t${imb.length}\t${fmt(rImb, 3)}\t${qImb ? fmt(qImb.spread) : '—'}\t${vp.length}\t${fmt(rVp, 3)}\t${qVp ? fmt(qVp.spread) : '—'}\t${verdict}`,
    );
    if (qImb) console.log(`  imb quintile means (bps): ${qImb.means.map((m) => m.toFixed(2)).join('  ')}`);
    if (qVp) console.log(`  vpin quintile means (bps): ${qVp.means.map((m) => m.toFixed(2)).join('  ')}`);
  }
}

void main();
