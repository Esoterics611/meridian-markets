# 6 · Delta-hedged short vol — hedging error, bands, the ladder

## What it is

The purest container for the VRP: sell an option (or a strangle), neutralize its delta with the underlying (here: the paper perp), and re-hedge as the delta drifts. §3's decomposition says the hedged seller's P&L is the IV−RV spread weighted by dollar gamma — no directional view survives the hedge. What the theorem hides is that **you cannot hedge continuously**, and the gap between the theorem's hedger and a real one is a measurable cost with its own literature. This chapter covers that gap — hedging error, band policy, hedge costs — and the desk's container for it all: a **tenor ladder of 20Δ strangles** (7d/14d/30d), each rung gated on its own premium, hedged on a band, and stopped on a budget. This is the Meridian E6 `VrpBook` grown from one daily straddle into the desk's income engine.

## Math sketch

### Hedging error: the price of discreteness

Hedge $N$ times over the option's life instead of continuously and your realized P&L is the theorem's value **plus a zero-mean error** whose standard deviation shrinks only like $1/\sqrt{N}$ (Boyle & Emanuel 1980; Figlewski 1989):

$$\sigma_{\text{hedge error}} \approx \sqrt{\frac{\pi}{4N}}\;\cdot\;\nu\,\sigma_i$$

with $\nu$ the position vega. Concretely, for the course's standard 30d BTC straddle (vega ≈ \$13,700 per 1.00 vol, IV 0.37): daily hedging ($N=30$) leaves ≈ \$800 of one-standard-deviation noise on a position whose expected edge (at +5.9 pts) is also ≈ \$800. **At 30d tenor, daily hedging makes the noise as large as the signal** — which is why (a) the desk hedges on a *band* evaluated continuously rather than on a clock, (b) the edge is judged across many cycles (§12), never one, and (c) the ladder's *longer* rungs demand *more* premium at the gate ($\theta_{\min}$ rising in tenor, §3): hedge-error variance accumulates with $\sqrt{\tau}$ and must be paid for.

### The band: how far to let delta drift

Hedging every tick minimizes variance and maximizes cost (every re-hedge pays taker fee + half-spread); hedging never is a naked position. The classic asymptotic answer (Whalley & Wilmott 1997) is that the optimal no-trade band around zero delta scales as:

$$\text{band} \;\propto\; \left(\frac{\text{cost per trade}}{\text{risk aversion}}\;\Gamma\right)^{1/3}$$

The cube root is the practical content: **the optimal band is remarkably insensitive to the inputs** — being wrong by 3× on your cost or risk-aversion estimate moves the band by 44%. So desks (this one included) skip the utility calibration and use a fixed fractional band with the cube-root lesson in mind: re-hedge when $|\delta_{\text{net}}|$ exceeds a set fraction of position size (the E6 default: 25% of contracts), and don't fine-tune what the math says is flat. Each re-hedge charges the real perp taker fee (E6 default 3.5bps of hedge notional) to the book — hedge costs are P&L, not footnotes.

### Strangle vs straddle, and the ladder

Past the 1-day tenor the desk sells **20Δ strangles**, not ATM straddles: same vega story, meaningfully less gamma while spot stays inside the wings (the strangle's gamma peak is out at the strikes, where spot usually isn't), so fewer forced re-hedges per cycle — at the cost of collecting less premium and a P&L that *jumps* rather than bleeds when a wing is breached. The ladder shape:

| Rung | Structure | Gate ($\sigma_i - \hat\sigma_{EWMA} \ge$) | Why the threshold rises |
|---|---|---|---|
| 7d | 20Δ strangle | 3 pts | shortest hedge-error exposure; premium-capture cycles fast |
| 14d | 20Δ strangle | 4 pts | 2× the error variance; must pay more |
| 30d | 20Δ strangle | 5 pts | the #12 tenor; error ≈ signal at daily hedging — demands the fattest premium |

Rungs are independent: each gates on its own tenor's premium off the surface tape, and a rung that fails two consecutive scored months is cut without argument (pre-registered, §12). The ladder's aggregate exposure answers to one number — the **vega budget** (|net vega| ≤ 0.4% of desk options NAV per vol point, §11) — so "all three rungs open" is a capital-allocation event the stress grid must approve, never an accident of three gates firing.

### The stop: bounding the 13.7%

The E6 pattern carries over unchanged because it is the correct shape: a **hard loss budget per position** (`maxLossBudgetUsd`) — if the marked loss exceeds the budget, the position is bought back at the stop, mechanically, no reassessment, no "it'll mean-revert." §3's inversion episodes are *fast*; a stop evaluated per mark converts "short vol has unbounded loss" into "short vol has a bounded loss and an ugly week." The stop level is set from the block-bootstrap tail (§12.3), sized so the stress-grid worst cell (§11) stays inside the desk DD budget — three layers (gate, stop, budget), each of which must independently fail before the desk takes the textbook blow-up.

## When it works / when it breaks

**Works:** high-premium regimes, especially post-spike — IV stays bid for weeks while realized collapses (vol clustering decays); the gate opens exactly then, by construction. The strangle earns both theta *and* the IV mark-down. #42's 86.3% is this regime's statistics.

**Breaks:** three distinct ways, worth separating because the defenses differ. (1) **The gap** — spot jumps through a wing before any hedge can react (weekend cascade, depeg headline); no band policy helps because the move is one tick — only the stop and position size bound it. (2) **The grind through the band** — a fast trend forces re-hedge after re-hedge, each locking in a loss ("gamma scalping in reverse"); this is realized vol exceeding implied in slow motion, the honest loss the premium exists to compensate over many cycles. (3) **The vol mark-up without a spot move** — IV reprices +10 pts on a headline while spot sits still: the delta hedge does nothing (it's a *vega* loss), the mark hits the stop. Note the v0 book's stated simplification — marking at entry IV — hides exactly this loss channel between marks; the desk fixes it in the ladder (marks at live chain IV) and the difference between the two markings is itself a tear-sheet line, because a book that can't see vega losses would report the #42 tail late.

## Code shape

The real v0 config, quoted from `src/derivatives/vrp/vrp-book.ts`, plus the ladder's extension:

```typescript
// The live E6 v0 knobs (real, in production paper):
export interface VrpBookConfig {
  minVrpPts: number;          // 0.03 — the §3 gate (fraction: 3 vol pts)
  contractsCoin: number;      // 0.1 BTC per straddle
  hedgeBandFrac: number;      // 0.25 — re-hedge past 25% of contracts' delta
  hedgeFeeBps: number;        // 3.5 — perp taker cost per re-hedge, charged to the book
  maxLossBudgetUsd: number;   // 400 — the hard stop that bounds the #42 tail
  minHoursToExpiry: number;   // 6 — never enter into the gamma hours
}

// The ladder generalization (O3): one rung = one gated, banded, stopped strangle.
export interface LadderRungConfig extends Omit<VrpBookConfig, 'minHoursToExpiry'> {
  tenorDays: 7 | 14 | 30;
  wingDelta: number;          // 0.20 — strangle wings chosen from the live chain by delta
  markAtLiveIv: true;         // the v0 simplification removed: vega losses are visible per mark
}

/** The ladder answers to one aggregate number before any rung may open. */
export function ladderVegaOk(openRungVegas: number[], candidateVega: number, navUsd: number, capFracPerVolPt = 0.004): boolean {
  const total = openRungVegas.reduce((a, b) => a + b, 0) + candidateVega;
  return Math.abs(total) / 100 <= capFracPerVolPt * navUsd;  // vega/100 = per vol point (§2 conventions)
}
```

## Sources

- Boyle & Emanuel (1980); Figlewski (1989), "Options Arbitrage in Imperfect Markets" — hedging error scales and why discrete replication leaks.
- Whalley & Wilmott (1997) — the asymptotic optimal hedge band and its forgiving cube root.
- Sinclair, *Volatility Trading* ch. 5–7 — the practitioner's hedge-band evidence and strangle-vs-straddle trade-offs.
- Meridian: journal #42 (the window distribution the stop is sized against), #96 (the estimator fix this book is blocked on), `src/derivatives/vrp/vrp-book.ts` (the running v0), `docs/OPTIONS_DESK.md` §2-O3.
