# 9 · Tail hedging — the honest cost of insurance

## What it is

The tail hedge is a permanent ladder of far-OTM puts — the desk runs **90–180d 10Δ puts** — held not to make money but to change the *shape* of the desk's return distribution: cap the catastrophic left tail so the income books (§4, §6) can run at meaningful size. It is the only book on the desk with a **negative expected P&L on purpose**, which makes it the easiest book to run dishonestly (bury the bleed, brag in the crash) and therefore the one this course treats with the most accounting discipline. The two loudest voices in the field — Universa's "tail hedging raises long-run CAGR" and AQR's "portfolio insurance is pathetically expensive" — are *both right about their own accounting*, and the reconciliation between them is the actual design of this book: a **hard cost budget** and a **mechanical monetization rule**.

## Math sketch

### The geometric argument (why negative-EV insurance can raise CAGR)

Long-run compounded growth is governed by the *geometric* mean, which fat left tails destroy: a −50% year needs +100% to recover. For a return stream $r_t$, $\text{CAGR} \approx \mu - \tfrac{1}{2}\sigma^2$ (the variance drag), and the drag term is dominated by the worst outcomes. So a hedge that costs $c$ per year in arithmetic expectation but truncates the −50% tail to −20% can *raise* the geometric mean of the whole portfolio — insurance with negative EV and positive impact on compounding. This is Spitznagel's argument, and its arithmetic is not controversial.

What *is* controversial is whether real, purchasable puts truncate the tail cheaply enough — because §8 said the put wing is the most systematically overpriced corner of the smile, and §5 cited Israelov (2017): historically, for equities, naive always-on puts cost more than the drag they remove, and simple deleveraging dominates. **Both literatures survive contact with each other only through sizing and monetization:**

- The hedge must be *small* — a budget, not a position. The desk's number: **1.0%/yr of options-desk NAV, spent evenly**, pre-registered as a cost cap. If the budget can't buy meaningful convexity at the tape's prices (thin, wide 10Δ wings — the cost model will say), the honest answer is a smaller income sleeve, not a bigger insurance bill.
- The hedge must be **monetized mechanically**. A 10Δ put that 5×'s in a crash and is held to expiry usually round-trips to zero (vol crushes, spot recovers, insurance re-expires worthless). The rule: **at ≥ 4× cost, sell it and re-strike at 10Δ same tenor** — harvest the convexity, restore the coverage, return the proceeds to the sleeve. No discretion: the one moment a monetization decision must be made (mid-crash) is the one moment no one should be trusted to make it.

### What the convexity is worth (the multiple, not the payoff diagram)

The tail put's value in a crash comes from three channels at once: spot through the strike (intrinsic), the vol spike (a 10Δ put's vega is small in dollars but its *price* is small too — a +20-pt IV move alone can 3× a far-OTM put), and the skew steepening (§8: crashes bid the put wing hardest — the very richness the desk sells in calm it *owns* in the storm). Worked magnitude at the course's smile: a 120d 10Δ BTC put (strike ≈ $41k at 60k spot) costs ≈ 0.9–1.3% of notional; in a −30%/+25-vol-pt scenario (§11's stress grid), it marks at roughly **6–10× cost**. That multiple — not the terminal payoff — is what the monetization rule harvests and what the stress grid credits.

### The interaction that pays the bill (the real reason the book exists)

Standalone, the tail budget is −1%/yr. Its return shows up in a different line: the §11 stress grid sizes every short-vol sleeve so the *worst scenario cell stays inside the desk DD budget* — and the tail ladder's positive convexity in exactly those cells is what makes the constraint bind later. Remove O6 and the stress-grid caps on the wheel and the ladder roughly halve; with it, the same DD budget carries roughly twice the income sleeve. If (income earned on the extra capacity) − (1%/yr) > 0 — and at §3's measured premium it is, by design margin — **the insurance is bought with the income it enables**, which is the only framing under which a tail hedge belongs on a conserve-equity desk at all. That inequality is the book's pre-registered metric, scored on the desk's own record.

## When it works / when it breaks

**Works:** the gap — the same event that is §6's nightmare (spot through the wings before any hedge fires) is this book's payday, which is precisely the point: the desk's books are chosen so the catastrophic scenario has *both* signs represented at pre-registered sizes. Works also as governance: a desk holding visible, budgeted insurance is structurally harder to talk into "just this month without the hedge" — the budget line's existence is part of its value.

**Breaks:** slowly, always, and that is the design — the bleed *is* the product being purchased; the failure modes worth naming are subtler. (1) **The grind-down that never gaps:** a −40% year delivered in 2%-a-week steps keeps the 10Δ puts perpetually just-OTM and re-struck lower — insurance against a crash that arrives as erosion pays little (the collar, §5, covers this case; the two insurance books are complements, not substitutes). (2) **Monetization whipsaw:** the 4× rule sells into a crash that then triples again — the rule forgoes the once-a-decade home run to reliably harvest the once-a-year double; pre-registered and accepted. (3) **The budget creep:** the honest 1% cap quietly becomes 2.5% after a scary quarter — the failure is organizational, and the defense is the tear-sheet line plus the cap being *in the mandate*, changeable only by changing the written mandate.

## Code shape

```typescript
export interface TailLadderConfig {
  tenorDaysMin: 90; tenorDaysMax: 180;
  targetDelta: 0.10;
  annualBudgetFracNav: number;   // 0.010 — a COST CAP, spent evenly; never a P&L target
  monetizeAtMultiple: number;    // 4 — sell + re-strike at 10Δ; mechanical, no mid-crash discretion
  restrikeSameTenor: true;
}

export interface TailLadderReport {
  spentYtdUsd: number;           // vs budget — the honest bleed line, printed every cycle
  budgetYtdUsd: number;
  monetizations: { costUsd: number; soldUsd: number; tsMs: number }[];
  /** The metric that justifies existence: stress-grid income capacity enabled minus cost. */
  enabledCapacityUsd: number;    // Δ(sleeve caps with vs without the ladder), from the §11 grid
}

/** Even spend: never lump the budget into one scared purchase. */
export function budgetAvailable(r: TailLadderReport, yearFracElapsed: number): number {
  return r.budgetYtdUsd * yearFracElapsed - r.spentYtdUsd;
}
```

## Sources

- Spitznagel, *Safe Haven: Investing for Financial Storms* — the geometric-compounding case for negative-EV insurance.
- Israelov (2017), "Pathetic Protection" — the cost case against it; this book's design is the synthesis of the two.
- Taleb, *Dynamic Hedging* ch. on far-OTM options — convexity behavior of wings under vol and skew shocks.
- The March 2020 record of tail-risk funds (public letters: Universa's return vs the category's median) — evidence that *monetization policy*, not ownership, separated outcomes.
- Meridian: `docs/OPTIONS_DESK.md` §2-O6 (budget, roll rule, honesty line) and §3 stress grid (where the enabled-capacity credit is computed).
