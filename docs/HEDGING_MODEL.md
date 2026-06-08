# Hedging the desk — delta (perps) + gamma (options)

**Status:** delta-hedge model shipped (`src/market-making/hedge/desk-delta-hedger.ts`, pure + tested);
live taker leg = next wiring step. Options/gamma overlay = model + validation plan here, not yet built.
**Origin:** Journal #41 — the governed neutral run lost −$9,952 realised with per-book maxDD to 17.6%
even with inventory bounded, because **bounding lots ≠ bounding the desk's net delta.**

---

## 0. Why this is the unlock (the #41 read)

The 10h governed run separated the desk's P&L cleanly:

- **Spread capture: positive on every book** (ETH +$683, SUI +$527, …).
- **Fees: −$262 total** — the −0.2bps maker rebate works; costs are *not* the leak.
- **The loss is directional inventory** run over by price: BTC/SOL/SUI/ETH all drew down in the
  same window. The 8 "independent" books are **one short-gamma crypto-beta bet.**

So the market-making edge (spread + rebate − adverse selection) is real but small, and it sits
*underneath* a high-variance, slightly-negative directional bet we never chose. **Hedge the delta
and you isolate the MM edge from the directional variance.** That is the move that turns the desk
from a levered beta punt into a working market-making mode.

Two orders of exposure, two instruments:

| Order | Exposure | Instrument | Status |
|---|---|---|---|
| 1st (δ) | net delta — price drift runs over inventory | **perp** (linear, cheap, same venue) | model shipped; wire next |
| 2nd (Γ) | short gamma — *moves* run over resting quotes (= adverse selection) | **long options** (buy gamma) | model + plan below |

---

## 1. The delta hedge (perps) — `DeskDeltaHedger`

**Model.** Each book's USD delta is `δᵢ = (inventoryUnits/1e6)·(midMicros/1e6)`. Map each book to a
hedge underlying with a beta (`SOL→{BTC, 1.1}`) so correlated alts net into one perp leg — the
capital-efficient read of "8 books = 1 bet". Net delta per underlying `Dᵤ = Σ βᵢ·δᵢ`.

**Banded rebalance.** Hold a perp carrying the opposite sign. Residual `R = D + hedge`. Only trade
when `|R| > bandUsd` — the dead-band stops us paying the taker spread to chase noise around flat.
When it fires, trade `−R` to flatten; cost `= |trade|·(takerBps + halfSpreadBps)/1e4`.

```
δ(book)      = units · price                         bookDeltaUsd()
D(underlying)= Σ β·δ                                 netDeltaByUnderlying()
R            = D + currentHedge
order        = (|R|>band) ? −R @ taker+half-spread : none   computeHedge()  → {states, orders, cost, grossDelta}
```

All pure, all tested (`desk-delta-hedger.spec.ts`). `hedgeOrderUnits(usd, mid)` converts an order to
6-dec perp units at the venue boundary (same convention as `quoteUnitsForNotional`).

**What it buys.** The residual the desk carries drops from `grossDelta` (8 correlated books, was the
whole #41 loss) to `≤ band`. What's left to earn is the MM spread/rebate edge — which #41 showed is
positive before the directional variance swamps it.

**Honesty rail.** A hedge only helps if `spread + rebate − adverse − hedgeCost > 0`. #41 says spread
≈ adverse and the rebate is the structural plus, so the hedge must be **cheap** (wide band, hedge the
*net* not each book, lean on HL's tight perp spread). Measure the post-hedge residual P&L; don't assume.

## 2. Funding — the hedge can be carry-positive

The hedge perp pays/earns funding. Hedging a **net-long** book means holding a **short** perp, and a
short **earns** funding whenever the rate is positive (longs pay shorts — the normal crypto regime):
`carry = −hedgeNotional·fundingBps/1e4` (`hedgeFundingCarryUsd()`, signed +=desk receives). So in the
usual regime the delta hedge is **paid to exist** — it ties straight into the funding-carry findings
(`FUNDING_CARRY_DISCOVERY.md`). Net funding against rebalance cost to judge the true hedge bill.

**Live wiring (next):** in `MmPortfolioTrader`, each tick (or on a slower hedge clock) gather the books'
`{symbol, inventoryUnits, midMicros}`, call `computeHedge`, fire the orders as **taker** perp fills on
the fast path (the leg #40 deferred), attribute `costUsd` to the books and `fundingCarry` to NAV, and
surface a desk **net-delta** + **residual** gauge on `/demo`. A directional/net-delta stop belongs in
`CompositeRiskGate` (deny new quotes when the un-hedged residual blows the band).

---

## 3. The gamma hedge (options) — the second-order, the deeper insight

Delta is only first-order. **A market maker is structurally short gamma — short realised volatility.**
Every time price *moves*, your resting quotes get run over (that *is* adverse selection and inventory
churn); the running cost of a short-gamma book over a move `ΔS` is

```
P&L_gamma ≈ ½ · Γ · (ΔS)²        (negative for us — Γ_desk < 0)
```

A perp delta-hedge neutralises first-order but you **still bleed on big moves**: you re-hedge *after*
the move and lock the loss ("gamma scalping in reverse"). The fix is to **buy gamma** — a long ATM/near
straddle (or strangle) has `Γ > 0`, so a violent move *helps* the option leg exactly when it hurts the
book. You pay for it in **theta** (time decay ≈ implied variance):

```
P&L_theta ≈ −½ · Γ · σ_impl² · S² · dt        (the premium bleed of the long option)
```

Net the two and the decision rule is clean:

> **Buy gamma when realised vol > implied vol + costs.** Long gamma profits ≈ `½·Γ·(σ_real² − σ_impl²)·S²·dt`
> per unit time, minus option spread/fees. Worth it precisely when the market is *more* volatile than the
> options are priced for — and an MM book's worst regimes (toxic, one-sided sweeps) are exactly high
> realised-vol regimes, so the overlay is naturally anti-correlated with the book's pain.

**We can price this already.** Our Black-Scholes Greeks were **validated against Deribit** (RESEARCH_FINDINGS
— "BS Greeks match Deribit, in reserve"), so we have Γ, Θ, vega and an implied-vol read in hand. The
overlay model is:
1. Estimate `Γ_desk` from the live inventory + quoting intensity (how much we lose per ΔS — calibrate to
   the #41/#39 adverse-selection numbers: realised ½ΓΔS² should reconstruct the adverse column).
2. Pull `σ_impl` (Deribit) for the nearest liquid expiry; compare to a rolling `σ_real` (HL trades/L2).
3. Size a long-gamma position to offset `Γ_desk` **only while `σ_real > σ_impl + cost`**; let it expire/roll
   otherwise. This is a *regime* overlay, not an always-on cost.

**Paper-only caveat.** Perps paper-trade today on HL data; **no options venue is wired**. The gamma overlay
is therefore **model + Deribit-priced validation first** (mark a synthetic long-straddle against realised
vs implied on the saved tapes; prove `½Γ(σ_real²−σ_impl²)S²` would have beaten the eaten adverse-selection
in the #39/#41 windows) **before** any live paper options book. Honesty rail: don't credit the overlay until
the backtest shows realised > implied net of cost in *our* windows — implied is usually rich for a reason.

---

## 4. The arc

```
fair value + fine cadence   → made the SPREAD edge real            (#28–#33)
notional inventory cap      → same RISK per book across prices     (#41 / D1)
perp delta hedge            → kill the 1st-order directional bleed (D2, shipped model)
long-gamma options overlay  → cap the 2nd-order move you re-hedge into (D3, model+validate)
```

Delta hedge first (cheap, linear, carry-positive, same venue). Gamma overlay second (regime, options,
validate vs Deribit). Together they leave the desk earning the market-making edge — spread + rebate −
adverse — with the directional and volatility variance hedged out. **That is the working mode.**

**Next steps:** (a) wire the live taker hedge leg + the net-delta gauge + the risk-gate residual stop;
(b) re-pre-register **Run A′** = governor + notional cap + delta hedge, require per-book maxDD ≤ ~1.5%;
(c) backtest the long-gamma overlay against Deribit IV on the saved tapes before any options book.
