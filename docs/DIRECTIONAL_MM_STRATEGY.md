# Directional ("Axed") Market-Making — intentional inventory carry

> **Status:** requirement / design spec (2026-06-05). Not yet built. Motivated by the
> 6h L2 finding (QUANT_JOURNAL #27): **inventory carry — not spread capture — was the
> dominant P&L term** (swings of ±$4,000 vs spread capture of ±$800 on a $20M book).
> A pure (inventory-neutral) maker treats that carry as pure risk to be skewed to
> zero. This strategy does the opposite on purpose: where the desk holds a **house
> directional view**, it deliberately rests at a **non-zero target inventory** aligned
> with the view, so the dominant P&L term becomes **chosen alpha** instead of noise —
> while still earning the spread + the venue maker rebate.

---

## 1. Why (the finding that forces this)

The 6h sweep's honest decomposition (`structural = spread − adverse + inventory_carry`,
[pnl-attribution.ts](../src/market-making/backtest/pnl-attribution.ts)):

- **spread − adverse ≤ 0 on 14 of 20 coins** at the default spread — naive MM has ~no clean spread edge; adverse selection eats the half-spread.
- the entire desk P&L (and the per-coin ±$4k swings) was **inventory carry** — the mark-to-market on the position the flow forced the book to hold.
- so the biggest, most controllable lever in the whole system is *which way, and how much, inventory you carry*. Left to chance it's a coin flip (the −$7,352 desk loss was a few coins that trended against forced inventory). **Chosen, it's a position.**

> Insight (Ronnie, 2026-06-05): *if carry dominates, then on coins we have a directional
> bias on, take the carry on purpose — bias the MM to accumulate the side we want.*

This is exactly how real dealer desks run an **"axe"**: when a desk wants to build (or shed)
a position, it quotes tighter/larger on that side and wider/smaller on the other. It is the
bridge between **flow capture** (pure MM) and **alpha capture** (directional). Done well it is
a *better entry* than just buying — you earn the spread + rebate (+ maybe funding) **while**
building the position, i.e. a negative-cost or paid accumulation.

---

## 2. The strategy in one paragraph

Run the existing GLFT/Avellaneda-Stoikov maker, but replace its "mean-revert inventory to
**zero**" objective with "mean-revert inventory to a **target** `q* = bias · Q_max`". A
per-coin **bias signal** `b ∈ [−1, +1]` (the house view, blended across horizons) sets the
target. The quoter skews its reservation price so the book naturally **accumulates and rests
at** `q*`, recycling spread around it; the spread itself stays σ-proportional (still the maker
edge). The result is three aligned income streams — **spread + rebate + directional carry**
(+ funding when the held side is the paid side) — gated by a directional-risk stop so a wrong
view is cut, not ridden.

---

## 3. The math (fits the existing `IQuoter` seam unchanged)

The seam ([quoter.interface.ts](../src/market-making/quote/quoter.interface.ts),
[quote-pair.ts](../src/market-making/quote/quote-pair.ts)) is a pure function
`QuoteContext → {reservationMicros, halfSpreadMicros}`. Avellaneda-Stoikov today:

```
r = mid − q · γ · σ² · (T − t)          # reservation skews AWAY from inventory q toward 0
halfSpread = γ·σ²·(T−t)/2 + (1/γ)·ln(1 + γ/κ)
```

**Directional generalization** — two small, composable changes, both inside the pure quoter
(no runtime/seam change; the book still owns inventory):

1. **Target-inventory skew** (skew toward `q*`, not 0):
   ```
   q*   = b · Q_max                       # b ∈ [−1,+1] bias; Q_max = max inventory in asset units
   r    = mid − (q − q*) · γ · σ² · (T − t)
   ```
   At `q = q*` the skew is zero → the book *rests* at the target, quoting symmetrically around
   it and recycling spread. Below target it leans to **buy** (bid richer), above it leans to
   **sell** — exactly the accumulate-toward-the-view behaviour.

2. **Conviction drift** (optional outright tilt, independent of current inventory):
   ```
   r += b · θ · σ · mid                   # θ = conviction-to-edge gain (config), σ·mid = price σ
   ```
   This shifts *both* quotes toward the view so even at target you fill slightly more on the
   view side — captures momentum while it persists. Keep θ small; it is the knob that converts
   conviction into willingness to pay a touch of spread for the position.

A pure reservation **shift** with a symmetric half-spread already produces **asymmetric fill
probability** (the near quote fills more), so v1 needs no asymmetric-spread plumbing. v2 may
add per-side half-spreads (tighter on the view side, wider on the other) for finer control —
that needs `buildQuotePair` to accept `bidHalf`/`askHalf`.

**Inventory limits become asymmetric:** allow `Q_max` on the bias side and a smaller `Q_opp`
(default 0) on the other, so a max-bullish book never goes net short. The risk gate's
`maxInventoryLots` becomes a signed band `[−Q_opp, +Q_max]·sign(b)`.

---

## 4. The bias signal `b` (the "house view") — sources + horizons

`b` is a **blend across three horizons**, each clamped to [−1,1], combined with configurable
weights `w_d + w_w + w_l = 1`:

| Horizon | Signal candidates (all already in the repo or trivially derivable) | Decay |
|---|---|---|
| **Daily** `b_d` | short-window momentum / micro-trend of the underlying; order-flow imbalance (aggressor buy% − sell% from the trades WS); intraday VWAP deviation | hours |
| **Weekly** `b_w` | **funding regime** (persistent-funding sign from [funding-carry-discovery](FUNDING_CARRY_DISCOVERY.md) — be long the side that's *paid*); multi-day trend; basis | days |
| **Long-term** `b_l` | the **fundamental / DAO / IB house view** (the analyst call — bullish ETH, bearish a token, etc.); on-chain or treasury research from prior DAO work | weeks |

```
b = clamp( w_d·b_d + w_w·b_w + w_l·b_l , −1, +1 )
```

The signal is an **input**, swap-seamed like everything else (`IBiasSource`): a `NullBiasSource`
(b=0 ⇒ behaves exactly like today's neutral GLFT, so nothing regresses) and concrete sources
(funding, momentum, a manual house-view override). Each source must pass the **same honesty
bar** as a stat-arb signal: an OOS / walk-forward read that the bias actually predicts forward
return before it's allowed to size carry (a bad bias signal is just a leveraged way to lose).

---

## 5. P&L decomposition (now four aligned streams)

```
net = spread_captured            # the maker edge (σ-proportional half-spread × fills)
    + maker_rebate               # structural floor (HL −0.2bps)
    + directional_carry          # mark-to-market on the INTENTIONAL q* position  ← the new alpha
    + funding                    # carry on held inventory (positive when q* is the paid side)
    − adverse_selection          # the cost; mitigated by wider view-side discipline
```

The directional-carry term is what we used to call "luck"; here it is a deliberate, sized,
stop-gated position. When the view is right it pays; when wrong, the spread + rebate (+ funding)
**cushion** the loss because the position was *accumulated at better-than-mid prices*. That
asymmetry — paid to enter, cushioned if wrong — is the whole point.

---

## 6. Risk controls (the directional exposure is now real, so gate it)

1. **Directional stop:** a max adverse excursion on the carry leg (e.g. carry P&L < −X·σ·notional
   or a NAV drawdown band) ⇒ flatten the target (`q*→0`) and optionally flip the bias. The
   existing `CompositeRiskGate` (Allow/Pause/Deny) extends to a Deny when the directional loss
   breaches; quoting reverts to neutral mean-reversion to flatten.
2. **Bias decay / expiry:** `b_d` decays over hours, `b_w` over days — a stale view must fade to
   zero, not persist. No signal ⇒ `q*→0` (neutral MM).
3. **Conviction sizing:** `Q_max = base · |b| · conviction`; low conviction ⇒ small or zero
   directional inventory ⇒ collapses to neutral MM. Never let the directional band exceed the
   drawdown budget (the desk's binding 2% maxDD).
4. **Toxicity guard:** keep the existing VPIN/flow-toxicity Pause — when flow is toxic, *widen*
   even on the view side (don't accumulate into informed flow; let the view come to you).
5. **Per-coin allow-list:** only coins that are **TIER-A** in the MM sense (liquid, low-DD, fills
   recycle) AND have a **validated** bias signal are eligible. A thin/volatile coin + a directional
   bet is how you blow up.

---

## 7. How it fits the codebase (implementation sketch)

- **New quoter** `DirectionalGlftQuoter implements IQuoter` (or a `bias`/`targetInventory` field on
  the existing GLFT quoter, since the change is a few lines of reservation math) — registered in
  `MmStrategyRegistry` so it drops into the bar backtest, the `LobReplayHarness`, and the live
  `MmBook` unchanged.
- **New seam** `IBiasSource` (`bias(symbol, ctx) → number`) with `NullBiasSource` default
  (b=0 ⇒ identical to today), `FundingBiasSource` (reuse `funding-carry-discovery`), and
  `ManualBiasSource` (the house-view override, set via the control plane / `/demo`).
- **Risk:** extend `CompositeRiskGate` with a directional-drawdown verdict; `maxInventoryLots`
  → a signed band.
- **Attribution:** `PnlAttributor` already splits spread / adverse / **inventory carry** / fees —
  so the directional-carry stream is *already measured*; just surface it as its own line + its
  own equity curve (so we can see whether the view, not luck, is paying).
- **Validation:** a `directional-mm-sweep` over the saved L2 tapes that replays each coin under a
  range of biases (−1…+1) and reports carry vs spread, so we can see, per coin, how much carry a
  given conviction buys and at what drawdown — the directional analogue of the γ/κ sweep.

---

## 8. Acceptance criteria

- `b = 0` reproduces the current neutral GLFT **bit-for-bit** (no regression; the swap-seam default).
- On a replayed tape with a known forward drift, a positive bias **increases** the inventory-carry
  P&L line and the realised long inventory, monotonically in `b`, with drawdown rising as `|b|·Q_max`.
- The directional stop flattens `q*` when the carry-leg loss breaches the band (unit-tested).
- A bias signal must show a **positive OOS forward-return correlation** before it sizes carry live
  (the honesty gate — a bias is alpha and must be validated like any alpha).
- Tests + tsc green; modular-monolith + swap-seam discipline preserved; paper-only.

---

## 9. Phased plan

1. **P1 — the quoter:** `targetInventoryUnits`/`bias` on a `DirectionalGlftQuoter` + unit tests
   (reservation skews toward `q*`; b=0 ≡ neutral). Offline, no signal yet.
2. **P2 — the sweep:** `directional-mm-sweep.ts` over the 20 saved tapes → per-coin carry-vs-bias
   curves (how much carry, how much drawdown, per conviction). The first honest read on whether
   *intentional* carry beats *neutral* MM on real flow.
3. **P3 — the signal:** `IBiasSource` + `FundingBiasSource` (be long the funding-paid side) +
   `ManualBiasSource`; OOS-validate before live.
4. **P4 — risk + live:** directional stop in `CompositeRiskGate`, signed inventory band, surface the
   directional-carry equity curve on `/demo`, run forward paper.

---

## 10. Other ways to monetise a committed directional bias (daily / weekly / long-term)

Beyond the directional-MM core above, a committed view opens several aligned books (all paper-first,
all swap-seamed, several already partly built):

1. **Funding-carry tilt (synthesis with [FUNDING_CARRY_DISCOVERY.md](FUNDING_CARRY_DISCOVERY.md)).**
   Where the bias side is *also* the funding-paid side, the directional MM earns spread + rebate +
   **funding** all at once. The funding-carry board already tells us which coins pay to hold which
   side — point the bias there and the three streams reinforce. (Weekly horizon — funding regimes
   persist days.)
2. **Paid accumulation / distribution (best-execution alpha).** Even with *no* edge view, when the
   desk simply *wants* a position (treasury/DAO mandate), building it via biased MM beats crossing
   the spread: you earn the half-spread + rebate on the way in. This is a real, low-risk product —
   "we'll build your position and get paid to do it." (Any horizon.)
3. **Carry-as-a-cushioned-option.** Long-biased + right ⇒ carry pays; long-biased + wrong ⇒ the
   spread/rebate/funding you banked while accumulating cushions the markdown. The payoff is convex —
   a cheap directional option financed by the maker edge. (Long-term horizon — let conviction size it.)
4. **Horizon laddering.** Run the *same* coin with a daily momentum bias **inside** a weekly funding
   bias **inside** a long-term fundamental bias; blend into one `q*`. Short-horizon biases trade the
   wiggles, long-horizon sets the resting position — one book, three time scales.
5. **Cross-venue expression.** Express the bias on the **rebate** venue (HL) and lay off the part you
   *don't* want elsewhere (e.g. keep the directional tilt, hedge the residual delta on Binance), or
   pair it with the delta-neutral funding-carry book so the desk runs both a paid-neutral leg and a
   chosen-directional leg.
6. **Vol-regime overlay (short gamma awareness).** A maker is structurally **short gamma** (loses on
   big moves, wins on calm). A vol view says *when* to widen (expect moves → defend) vs tighten/size-up
   (expect calm → harvest). Combine with the directional bias: tighten on the view side in calm,
   widen the other side into expected moves. (Daily/weekly horizon.)

Each is a paper book behind the existing seams; each is honest only after its signal passes an OOS
gate. The directional-MM quoter (this doc) is the engine they all plug into.
