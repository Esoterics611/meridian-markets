# 11 · Portfolio construction — Greeks budgets & stress-as-sizing

## What it is

Seven books (§4–§10) do not make a desk; a desk is the layer that knows what the seven books add up to *right now* and what they would add up to *in the scenario that matters*. For an options portfolio that layer cannot be a volatility number or a historical VaR — options P&L is nonlinear, and the entire point of several books is that their risk lives in states history under-samples. The desk layer is therefore built on two instruments: the **Greeks budget** (a small table of hard aggregate limits, marked continuously) and **stress-as-sizing** (a scenario grid through the validated pricer that is the *binding* sizing arbiter for every sleeve). Nothing here is novel — this is how real options desks are actually supervised — but it is the chapter that separates a desk from seven scripts that happen to share a database.

## Math sketch

### Aggregation: Greeks add, stories don't

Every position's Greeks (per §2's conventions) sum linearly across the desk at each mark:

$$\Delta_{\text{desk}} = \sum_i q_i \Delta_i,\quad \Gamma_{\text{desk}} = \sum_i q_i \Gamma_i,\quad \nu_{\text{desk}} = \sum_i q_i \nu_i,\quad \Theta_{\text{desk}} = \sum_i q_i \Theta_i$$

The budget table — hard limits, marked every cycle, breach ⇒ **pause all new entries desk-wide** (the engine's existing Allow/Deny/Pause gate pattern):

| Aggregate | Limit (per desk options NAV) | What it guards |
|---|---|---|
| net delta | ≤ 5% of NAV per 1% spot move | the desk is a vol desk; direction is either hedged (§6), floored (§5), or budgeted here — never accidental |
| net vega | ≤ 0.5% of NAV per vol point | the "all books are short the same vol spike" concentration (see below) |
| net gamma | bounded below (short-gamma cap), **credited** for §5/§9/§10's long wings | the gap scenario's first derivative-of-a-derivative |
| net theta | reported, not limited | the earnings engine; a limit here would be a return target in disguise — forbidden by charter |

The most important line in that table is the vega line's *reason*: in a crash, **every short-vol book is the same trade**. The wheel's short put, the ladder's strangles, the calendar's short front — pairwise "diversified" in calm regimes, perfectly correlated in the one scenario that can kill the desk. Correlation matrices estimated on calm data are actively misleading here, which is why the desk's concentration control is a *sum of vegas* (model-free, regime-independent) and, below, a scenario grid that prices the crash directly rather than inferring it from history.

### Stress-as-sizing: the grid is the sizer, not the alarm

The desk's binding constraint — the rule every sleeve cap in §4–§10 defers to:

$$\max_{\text{cell}} \; \text{Loss}\big(\text{desk} \mid \Delta S,\, \Delta\sigma\big) \;\le\; 2\%\ \text{of desk NAV}, \qquad \text{grid} = \{\pm 15\%, \pm 30\%\} \times \{\times 0.75, \times 1.5, \times 2\}\ \text{IV}$$

Every open and candidate position is re-priced through the validated `IOptionPricer` at each grid cell (spot shocked, each leg's IV shocked multiplicatively, plus the skew-steepening overlay on the wings — crashes don't move the surface in parallel, §8), and the worst cell must stay inside the DD budget **including the candidate**. Sizing questions stop being judgment calls: *can the 30d ladder rung open?* becomes *does the worst cell still clear with it on?* Notice what the grid does to the desk's internal economics: §9's tail ladder and §5's floors have large *positive* values exactly in the worst cells, so they **enlarge** every income sleeve's admissible size — the "insurance bought with the income it enables" inequality of §9 is computed here, not asserted.

Two design notes that keep the grid honest. First, **no diversification credit inside the grid**: cells are evaluated with all books marked simultaneously at the same shock — the crash correlation is 1 by construction. Second, the grid's IV shocks are multiplicative (×2 of IV 37 is 74) because vol shocks scale with the level — an additive grid quietly understresses high-vol regimes, which are exactly when the desk is largest in premium terms.

### Collateral and the sleeve ledger

Per the mandate (§1's code shape): every short is fully collateralized — cash-secured (§4), covered by inventory (§4's call leg), or stress-sized (§6) — and **sleeve cash is segregated per book in the paper ledger**, no netting benefit assumed between books. This deliberately overstates capital needs relative to a portfolio-margin venue; the conservative direction is chosen because the desk's product is a *trustworthy* curve, and "we survived because we assumed less netting than we'd get" is a sentence a paper demo can be proud of. The R9a lesson (the carry plan shipped without a margin model and had to retrofit one) is inherited as a birth requirement here.

### The allocator seat

The options desk is one sleeve of the *firm's* capital allocator (E7), entering at a fixed **≤ 20% of desk capital** — M3's original satellite mandate extended to the whole desk — with vol-targeted weights *inside* the options sleeve (income / insurance / efficiency) starting dumb (fixed) and earning sophistication only as the scored record (§12) accumulates. The allocator's one options-specific rule: **theta is not income until the cycle closes.** Premium collected sits in a reserve line and transfers to the allocatable NAV only at cycle settlement — the warehouse-trap lesson (green unrealized masking realized losses) already paid for once on the MM desk, institutionalized here from day one.

## When it works / when it breaks

**Works:** whenever it is allowed to be boring. The budget table plus grid make the desk's worst month a *pre-computed number*; month after month of "worst cell: −1.7%, realized: −0.3%" is precisely the demonstration the mission asks for.

**Breaks:** at the meta-level, in exactly two ways. (1) **The grid's model risk** — the pricer is validated (§2), but the *scenario set* is a choice: a 45% weekend gap is outside a ±30% grid, and pretending the grid ends the conversation is the same overconfidence VaR was criticized for. Defense: the grid's outermost cell is deliberately beyond the worst observed crypto daily move, the block-bootstrap (§12.3) cross-checks the grid against resampled history, and the desk's honest posture is "bounded under these named scenarios," never "bounded." (2) **Budget erosion** — the same organizational failure as §9's budget creep: limits that live in config files get edited under pressure. The desk's defense is procedural and inherited from the repo's regression discipline: the budget table lives in the *mandate document*, the config is spec-tested against it, and a change requires changing the written mandate in the same commit.

## Code shape

```typescript
export interface DeskGreeks { delta: number; gamma: number; vega: number; theta: number; }

export interface GreeksBudget {
  maxAbsDeltaFracNav: number;   // 0.05
  maxAbsVegaFracNavPerPt: number; // 0.005
  minGamma: number;             // the short-gamma floor (negative number), long wings credited
}

export type BudgetVerdict = 'ALLOW' | 'PAUSE-NEW-ENTRIES';

export function checkBudget(g: DeskGreeks, b: GreeksBudget, navUsd: number): BudgetVerdict {
  const vegaPerPt = Math.abs(g.vega) / 100;
  if (Math.abs(g.delta) > b.maxAbsDeltaFracNav * navUsd) return 'PAUSE-NEW-ENTRIES';
  if (vegaPerPt > b.maxAbsVegaFracNavPerPt * navUsd) return 'PAUSE-NEW-ENTRIES';
  if (g.gamma < b.minGamma) return 'PAUSE-NEW-ENTRIES';
  return 'ALLOW';
}

/** The sizing arbiter: worst grid cell with the candidate included, all books marked together. */
export function stressAdmits(positions: PricedPosition[], candidate: PricedPosition,
                             pricer: IOptionPricer, navUsd: number, ddBudgetFrac = 0.02): boolean {
  const grid = { spotShocks: [-0.30, -0.15, 0.15, 0.30], ivMults: [0.75, 1.5, 2.0] };
  let worst = 0;
  for (const ds of grid.spotShocks) for (const m of grid.ivMults) {
    const pnl = [...positions, candidate].reduce((a, p) => a + scenarioPnl(p, ds, m, pricer), 0);
    worst = Math.min(worst, pnl);
  }
  return -worst <= ddBudgetFrac * navUsd;
}
```

## Sources

- Taleb, *Dynamic Hedging* — Greeks aggregation and why scenario grids beat moment-based risk for option books.
- The Basel/desk-supervision literature on stressed-VaR vs scenario matrices (background for why every real options desk runs a grid).
- Meridian: `docs/OPTIONS_DESK.md` §3 (the desk layer this chapter teaches), the P11 stress-harness pattern it extends, and the MM desk's warehouse-trap lesson (#64/#65) that dictated the theta-reserve rule.
