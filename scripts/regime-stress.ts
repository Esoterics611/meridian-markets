/**
 * regime-stress — the scenario / stress harness runner (Playbook II P11). Runs the four
 * canonical shocks (flash crash / vol spike / funding flip / feed blackout) through the REAL
 * desk — RegimeDirectionalBook (stop) + RegimeMonitor (STAND_ASIDE) + RegimeDeskRisk (kill-switch)
 * — and prints a scorecard of the protective responses. The logic lives in the pure
 * src/market-making/directional/regime-stress.ts module (jest-locked); this is the human view.
 *
 * Run (DB-free, no network, deterministic):
 *   npx ts-node -r tsconfig-paths/register scripts/regime-stress.ts
 *   RS_SYMBOLS=BTC,ETH,SOL,BNB RS_BASE_NOTIONAL_USD=50000 RS_MAXDD=0.02 \
 *     npx ts-node -r tsconfig-paths/register scripts/regime-stress.ts
 */
import { runStressScenario, STRESS_SCENARIOS, StressResult } from '../src/market-making/directional/regime-stress';

const USE_COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (c: string, s: string) => (USE_COLOR ? `\x1b[${c}m${s}\x1b[0m` : s);
const green = (s: string) => wrap('32', s);
const red = (s: string) => wrap('31', s);
const bold = (s: string) => wrap('1', s);
const dim = (s: string) => wrap('2', s);
const cyan = (s: string) => wrap('36', s);
const ok = (b: boolean) => (b ? green('✓') : red('✗'));

const symbols = (process.env.RS_SYMBOLS ?? 'BTC,ETH,SOL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const baseNotionalUsd = Number(process.env.RS_BASE_NOTIONAL_USD ?? 50_000);
const maxDrawdownFrac = Number(process.env.RS_MAXDD ?? 0.02);

console.log(bold(cyan(`\n=== REGIME DESK · STRESS SCORECARD ===`)));
console.log(dim(`universe ${symbols.join(', ')}  ·  base $${baseNotionalUsd.toLocaleString('en-US')}/book  ·  maxDD budget ${(maxDrawdownFrac * 100).toFixed(1)}%\n`));

const results: StressResult[] = [];
let allGreen = true;
for (const kind of STRESS_SCENARIOS) {
  const r = runStressScenario(kind, { symbols, baseNotionalUsd, maxDrawdownFrac });
  results.push(r);
  const protectedOk = r.budgetRespected;
  if (!protectedOk) allGreen = false;
  console.log(bold(`${kind.toUpperCase().padEnd(14)}`));
  console.log(
    `  maxDD ${(r.maxDrawdownFrac * 100).toFixed(2)}% / ${(r.budgetFrac * 100).toFixed(1)}% budget   ` +
    `HALT ${r.deskHalted ? red('YES') : dim('no')}${r.haltReason ? dim(` (${r.haltReason})`) : ''}`,
  );
  console.log(
    `  stops ${r.stopsFired}   stand-aside ${r.standAsideBooks}/${r.symbols} books   ` +
    `regime-transitions ${r.regimeTransitions}   flat-at-end ${r.flatAtEnd ? green('yes') : dim('no')}`,
  );
  console.log(`  ${ok(r.budgetRespected)} budget respected (inside budget OR halted)   ${ok(r.allHeldStoodAside)} every held book stood aside\n`);
}

console.log(bold(allGreen ? green('STRESS OK — every scenario kept the desk protected.') : red('STRESS FAIL — a scenario breached the budget without halting.')));
console.log(dim('(deterministic synthetic shocks — the assertions are locked in regime-stress.spec.ts as a regression guard)\n'));
process.exit(allGreen ? 0 : 1);
