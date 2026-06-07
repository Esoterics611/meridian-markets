/* eslint-disable no-console */
// flow-bias-markout.ts — the markout / forward-return GATE for the shadow flow signal.
//
// Reads a flow-shadow JSONL (the L2LiveFillEngine's MM_FLOW_SHADOW output) and, per
// symbol, joins each observation to its FORWARD return over several horizons (the next
// obs at ≥ t+Δ), then reports the Spearman IC + hit rate of signal vs forward return.
// This is the honest test of whether book-imbalance PREDICTS price on this venue/cadence
// — the same IC discipline as the #1 OOS gate, applied to the live shadow capture. A
// horizon "clears" if its IC is positive AND stable across symbols (not one coin). Only
// then does the flow source earn `validated: true` and start sizing live carry.
//
// DB-free. Run:
//   npx ts-node -r tsconfig-paths/register scripts/flow-bias-markout.ts <file.jsonl> [h1s,h2s,...]
import { readFileSync } from 'fs';

interface Obs {
  tsMs: number;
  symbol: string;
  signal: number;
  bookImbalance: number;
  tradeFlowImbalance: number;
  midMicros: string;
  microMicros: string | null;
}

function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const rank = (a: number[]): number[] => {
    const idx = a.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(n).fill(0);
    for (let i = 0; i < n; ) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1; // average rank for ties (1-based)
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = rx[i] - mx;
    const ay = ry[i] - my;
    num += ax * ay;
    dx += ax * ax;
    dy += ay * ay;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

/** Pair each obs with the first later obs at ≥ t+horizon; forward return off the true mid. */
function fwdReturns(rows: Obs[], horizonMs: number): { sig: number[]; fwd: number[] } {
  const sig: number[] = [];
  const fwd: number[] = [];
  let j = 0;
  for (let i = 0; i < rows.length; i++) {
    const target = rows[i].tsMs + horizonMs;
    if (j < i + 1) j = i + 1;
    while (j < rows.length && rows[j].tsMs < target) j++;
    if (j >= rows.length) break;
    const p0 = Number(rows[i].midMicros);
    const p1 = Number(rows[j].midMicros);
    if (p0 > 0) {
      sig.push(rows[i].signal);
      fwd.push(p1 / p0 - 1);
    }
  }
  return { sig, fwd };
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: flow-bias-markout.ts <file.jsonl> [h1s,h2s,...]');
    process.exit(1);
  }
  const horizonsS = (process.argv[3] ?? '60,300,900').split(',').map((s) => parseInt(s, 10));
  const rows: Obs[] = readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Obs);
  const bySym = new Map<string, Obs[]>();
  for (const r of rows) {
    let arr = bySym.get(r.symbol);
    if (!arr) {
      arr = [];
      bySym.set(r.symbol, arr);
    }
    arr.push(r);
  }
  console.log(`file=${file}  rows=${rows.length}  symbols=${bySym.size}`);
  console.log(['symbol', 'horizon', 'n', 'spearmanIC', 'hit', 'meanFwd|sig>0'].join('\t'));
  for (const [sym, obs] of [...bySym.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    obs.sort((a, b) => a.tsMs - b.tsMs);
    for (const hs of horizonsS) {
      const { sig, fwd } = fwdReturns(obs, hs * 1000);
      if (sig.length < 10) {
        console.log([sym, `${hs}s`, sig.length, 'n/a', '', ''].join('\t'));
        continue;
      }
      const ic = spearman(sig, fwd);
      let hit = 0;
      let cnt = 0;
      let sp = 0;
      let spn = 0;
      for (let i = 0; i < sig.length; i++) {
        if (sig[i] !== 0) {
          cnt++;
          if (Math.sign(sig[i]) === Math.sign(fwd[i])) hit++;
          if (sig[i] > 0) {
            sp += fwd[i];
            spn++;
          }
        }
      }
      console.log(
        [sym, `${hs}s`, sig.length, ic.toFixed(4), cnt ? (hit / cnt).toFixed(3) : 'n/a', spn ? (sp / spn).toExponential(2) : 'n/a'].join('\t'),
      );
    }
  }
}

main();
