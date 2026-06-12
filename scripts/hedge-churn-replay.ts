/*
 * hedge-churn-replay.ts — F1 validation: replay a finished run's HEDGE ▸ order stream under the
 * anti-churn rules (min-hold, flip cooldown, no-trade band) and report the churn delta.
 *
 * Honest scope: the run log carries the EXECUTED hedge orders (time, side, $notional, leg,
 * reason), so the replay reconstructs each leg's DESIRED hedge position (the cumulative
 * position the old controller walked to) and re-walks it with the new rules — an order fires
 * only when the gap to the desired position exceeds the band AND the leg is out of min-hold /
 * flip-cooldown. First-order estimate: suppressing an order changes the future gaps (path
 * dependence), and the flow-freeze / net-first / basis-gate rules need data the log does not
 * carry (book flow, stop events, per-book delta contributions) — so the replay measures the
 * MECHANICAL rules only (min-hold + flip cooldown + band) and reports the residual tracking
 * gap it carries in exchange (the directional risk the suppression takes on).
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/hedge-churn-replay.ts \
 *     --log docs/research/run-20260611-172435-mm10h.log \
 *     [--band 2000] [--min-hold-s 30] [--cooldown-s 300] [--cost-bps 2.7] [--sweep]
 */
import * as fs from 'fs';

interface HedgeFire {
  tMs: number;
  underlying: string;
  /** Signed notional: BUY +, SELL −. */
  signedUsd: number;
  reason: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Parse the Nest log line: "06/11/2026, 5:37:54 PM ... HEDGE ▸ SELL $35,296 ETH-perp — open …". */
export function parseHedgeLines(text: string): HedgeFire[] {
  const out: HedgeFire[] = [];
  const re = /(\d{2}\/\d{2}\/\d{4}), (\d{1,2}:\d{2}:\d{2} [AP]M).*?HEDGE ▸ (BUY|SELL) \$([\d,]+) ([\w:]+)-perp — (open|reduce|increase|flip)/g;
  for (const m of text.matchAll(re)) {
    const tMs = new Date(`${m[1]}, ${m[2]}`).getTime();
    const usd = Number(m[4].replace(/,/g, ''));
    out.push({ tMs, underlying: m[5], signedUsd: m[3] === 'BUY' ? usd : -usd, reason: m[6] });
  }
  return out;
}

interface ReplayResult {
  orders: number;
  flips: number;
  churnUsd: number;
  estCostUsd: number;
  maxGapUsd: number; // worst |desired − held| carried — the directional risk the suppression takes
  avgGapUsd: number;
}

/** Re-walk one parameterisation over the recorded fire stream. */
export function replay(fires: HedgeFire[], p: { bandUsd: number; minHoldMs: number; cooldownMs: number; costBps: number }): ReplayResult {
  const desired = new Map<string, number>(); // leg → cumulative desired position (the old walk)
  const held = new Map<string, number>(); // leg → simulated position under the new rules
  const lastFire = new Map<string, number>();
  const lastFlip = new Map<string, number>();
  let orders = 0;
  let flips = 0;
  let churn = 0;
  let maxGap = 0;
  let gapSum = 0;
  let gapN = 0;

  for (const f of fires) {
    const u = f.underlying;
    const want = (desired.get(u) ?? 0) + f.signedUsd;
    desired.set(u, want);
    const have = held.get(u) ?? 0;
    const gap = want - have;
    maxGap = Math.max(maxGap, Math.abs(gap));
    gapSum += Math.abs(gap);
    gapN += 1;
    if (Math.abs(gap) <= p.bandUsd) continue; // band-hold
    if (f.tMs - (lastFire.get(u) ?? -Infinity) < p.minHoldMs) continue; // min-hold
    const isFlip = have !== 0 && want !== 0 && Math.sign(want) !== Math.sign(have);
    if (isFlip && f.tMs - (lastFlip.get(u) ?? -Infinity) < p.cooldownMs) continue; // flip cooldown
    held.set(u, want);
    lastFire.set(u, f.tMs);
    if (isFlip) {
      flips += 1;
      lastFlip.set(u, f.tMs);
    }
    orders += 1;
    churn += Math.abs(gap);
  }
  return { orders, flips, churnUsd: churn, estCostUsd: (churn * p.costBps) / 1e4, maxGapUsd: maxGap, avgGapUsd: gapN ? gapSum / gapN : 0 };
}

function main(): void {
  const logPath = arg('log');
  if (!logPath || !fs.existsSync(logPath)) {
    console.error('usage: hedge-churn-replay.ts --log <run log> [--band 2000] [--min-hold-s 30] [--cooldown-s 300] [--cost-bps 2.7] [--sweep]');
    process.exit(1);
  }
  const costBps = Number(arg('cost-bps') ?? '2.7'); // 2.5bps taker + ~1bp half-spread × ~0.8 fill ≈ leak-table's 0.00027
  const fires = parseHedgeLines(fs.readFileSync(logPath, 'utf8'));
  if (fires.length === 0) {
    console.error('no HEDGE ▸ lines found in the log');
    process.exit(1);
  }

  const base = replay(fires, { bandUsd: 0, minHoldMs: 0, cooldownMs: 0, costBps });
  console.log(`baseline (as run): ${base.orders} orders / ${base.flips} flips / $${Math.round(base.churnUsd).toLocaleString()} churned / est cost $${base.estCostUsd.toFixed(0)}`);

  const rows: string[] = ['band$ | hold_s | cd_s | orders | flips | churn$ | cost$ | cost cut | maxGap$ | avgGap$'];
  const params = process.argv.includes('--sweep')
    ? [0, 2000, 4000].flatMap((band) => [0, 30, 60].flatMap((hold) => [0, 120, 300, 600].map((cd) => ({ band, hold, cd }))))
    : [{ band: Number(arg('band') ?? '2000'), hold: Number(arg('min-hold-s') ?? '30'), cd: Number(arg('cooldown-s') ?? '300') }];
  for (const p of params) {
    const r = replay(fires, { bandUsd: p.band, minHoldMs: p.hold * 1000, cooldownMs: p.cd * 1000, costBps });
    const cut = base.estCostUsd > 0 ? 1 - r.estCostUsd / base.estCostUsd : 0;
    rows.push(
      `${p.band} | ${p.hold} | ${p.cd} | ${r.orders} | ${r.flips} | ${Math.round(r.churnUsd).toLocaleString()} | ${r.estCostUsd.toFixed(0)} | ${(cut * 100).toFixed(0)}% | ${Math.round(r.maxGapUsd).toLocaleString()} | ${Math.round(r.avgGapUsd).toLocaleString()}`,
    );
  }
  console.log(rows.join('\n'));
  console.log(
    '\nNOTE: first-order estimate over the recorded fire stream (path-dependent; flow-freeze /' +
      ' net-first / basis-gate not simulable from the log). maxGap$ is the directional residual the' +
      ' suppression carries — the risk bought with the cost cut.',
  );
}

if (require.main === module) main();
