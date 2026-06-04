# Quote pricing — the Fair-Value ("theo") engine + the Thesis Register

> **Status:** design spec (2026-06-05). The next sessions' headline. Motivated by
> QUANT_JOURNAL #28: naive spread MM loses to adverse selection at *every* width
> because we quote off a **stale mid**. The fix is not a wider spread — it is a
> **better price to quote around**. This doc designs that price (the "theo"),
> fuses sentiment + technical + microstructure + a proprietary directional view,
> and builds the governance layer (the Thesis Register) that ties the desk's
> **house view** to its **quotes** and measures whether the view pays.
>
> Grounded in real dealer / HFT-MM / capital-markets practice, pushed to the edge
> where we have a structural advantage, and kept strictly buildable on the engine
> we already have (HL L2 + trades-WS + funding; Binance public price; the `IQuoter`
> seam; the OOS / purged-CV honesty gates; the directional-MM spec).

---

## 0. The thesis of this design

A market maker's only durable edge is **knowing the fair value better than the flow
that hits it.** Spread and rebate are the *toll*; the *business* is being right about
where the price is in the next few seconds-to-hours and quoting around **that**, not
around a lagging mid. So we build one thing well — a **real-time fair-value estimate
`μ` with an uncertainty `Σ`** — and everything else (spread width, skew, size,
directional tilt) is a function of `(μ, Σ)`.

Three design commitments, all from the data + the honesty doctrine:
1. **Price, don't widen.** Adverse selection is a fair-value error; fix the price.
2. **Confidence sets the spread.** Quote tight + big when `Σ` is small, wide + small when large. The spread is *earned* by certainty, not guessed.
3. **The view bends the price at its own time scale.** A daily/weekly/long-term thesis enters as a slow drift prior — it can't overrule the microstructure tick, but it tilts the resting center and the inventory we *want* to hold (the directional-MM target). Every view is tracked, time-stamped, and graded by its own P&L.

---

## 1. How the real desks do it (best practice, so we don't reinvent badly)

| Practice | Who / what | What we take |
|---|---|---|
| **Micro-price** (book-imbalance-adjusted fair value) | Stoikov 2017; every HFT MM | the sub-second quote center: `E[mid_{t+Δ} \| imbalance]`, not the mid |
| **"Theo" engine** (a fused theoretical price re-computed continuously) | Citadel Sec / Jump / HRT-style MMs | the architecture: one fair-value number, quotes = theo ± spread, re-quote on every input tick |
| **Lead–lag / cross-venue price transfer** | index-arb, CEX→DEX MMs | quote the **DEX** (HL) around the **faster CEX** price (Binance) — the lead instrument leads price discovery; the lag is our edge |
| **Confidence-scaled quoting** (Kalman / Bayesian theo) | systematic MMs | the filter's variance `Σ` sizes spread + quote size — principled, not a fixed γ |
| **The "axe"** (skew the two-way toward the side you want) | OTC / dealer desks | the directional tilt: better price on the side that builds the position we want |
| **The "house view" / CIO view** (a documented, owned, reviewed directional outlook that sets desk risk appetite) | every bank strategy/IC process | the **Thesis Register** — research→trading bridge, versioned, P&L-graded |
| **Alpha blending** (`α = vol·IC·score`, decorrelated, risk-weighted) | Grinold–Kahn / quant PMs | how we combine many signals across horizons without double-counting or overfitting |
| **Sentiment from market structure** (funding, OI, liquidations, basis) before social/NLP | crypto quant desks | clean quantitative sentiment first; NLP/LLM news later, human-gated |

The honest gap today: we quote `mid ± spread`. The whole industry quotes `theo ± f(Σ)`,
re-quoted continuously, with `theo` fusing the book, the lead venue, flow, and a view.
**That gap is the entire −$7k.**

---

## 2. The Fair-Value engine (the "theo") — the heart

A real-time estimate of the asset's fair value `μ_t` and its uncertainty `Σ_t`, fused
from layered inputs ordered by *frequency* and *information coefficient (IC)*. We add
layers cheapest-and-highest-IC first; each must earn its weight with an **OOS IC** on
the saved tapes before it can move a live quote (the honesty gate — a low-IC signal in
the price is just leverage on noise).

### Layer A — Microprice (microstructure; sub-second; highest IC, free)
The book already tells us which way the next tick leans. Order-book imbalance
`I = (Q_bid − Q_ask) / (Q_bid + Q_ask) ∈ [−1, 1]`. The micro-price adjusts the mid
toward the heavier *opposite* side:
```
μ_micro = mid + (spread/2) · g(I)          # g monotone, g(0)=0, g(±1)=±1
```
Start with `g(I)=I` (linear, Stoikov's first-order); refine `g` empirically from the
tapes (the imbalance→next-move curve is estimable directly). **This alone is the single
biggest adverse-selection cut available** and needs only the L2 we already capture.

### Layer B — Lead–lag from the CEX (seconds; very high IC, we have the data)
HL perps follow Binance spot/futures price discovery with a lag. Quote HL around the
**Binance-implied** fair value:
```
μ_lead = μ_micro + β · (P_binance − P_hl_mid)      # β fit per coin; the basis-corrected lead
```
We already have `BinancePublicClient` + `HyperliquidClient`. Measuring the HL-vs-Binance
lead-lag (cross-correlation of returns at sub-minute lags) and folding the lead into the
theo is, in my judgment, **the highest-leverage practical edge in the whole project** —
it directly attacks the stale-mid problem with a faster, deeper reference we already pull.

### Layer C — Order/trade-flow drift (seconds–minutes; we capture 45–100% real flow)
Aggressive flow is persistent and predicts short-term drift. From the HL trades-WS:
```
OFI = (buy_vol − sell_vol)/total_vol   over a short window
μ_flow = μ_lead + κ_flow · OFI · σ_price
```
Cap and decay it (flow drift is short-lived); down-weight when VPIN/toxicity is high
(toxic flow predicts *against* us, not for us — that's the adverse-selection signature).

### Layer D — Technical / statistical expectation (minutes–hours)
A small, **interpretable, OOS-validated** predictor of the next-N-minute return sign+size.
Features (all already derivable): recent returns at several lags, realized vol, book
imbalance, OFI, funding, Binance basis, VWAP deviation, support/resistance from L2
liquidity clusters. Model: start **regularized-linear / logistic** (interpretable,
hard to overfit) → only escalate to gradient-boosted trees under the existing
**purged k-fold + embargo + deflated-Sharpe** gates. Output a drift `μ_tech` and a
confidence that feeds `Σ`.

### Layer E — Directional thesis drift (hours–weeks; the house view)
The proprietary outlook (Layer §4) enters as a **slow drift prior**, not a hard target:
```
μ = μ_tech + λ_thesis · b · σ_daily        # b ∈ [−1,1] from the Thesis Register, λ small
```
Because it's a *prior*, the faster layers and the market can override it tick-to-tick; if
the market persistently disagrees, the thesis's own P&L attribution (Layer §4) flags it
for review. The thesis also sets the **target inventory** `q* = b·Q_max` and the **spread
asymmetry** (tighter on the thesis side) — see §3.

### The fusion: a Kalman/Bayesian filter (principled + practical)
Rather than ad-hoc weights, fuse the layers in a **1-D Kalman filter**: hidden state =
true fair value (+ a drift term); observations = `{μ_micro, μ_lead, trade prints}`; the
process model carries the technical+thesis drift. The filter returns the optimal fused
`μ_t` **and its variance `Σ_t`** — exactly the two numbers the quoter needs. This is how
real theo engines stay stable under noisy, asynchronous inputs, and it gives `Σ` for free.
(v1 can be a weighted blend with an EWMA-variance proxy; the Kalman is the v2 upgrade.)

---

## 3. From `(μ, Σ)` to quotes — confidence-scaled, view-skewed

```
reservation   r   = μ − (q − q*) · γ · σ² · (T−t)        # skew toward TARGET inventory q*, not 0
half-spread   s   = base(σ) · (1 + c_Σ·Σ̂ + c_v·VPIN)    # WIDER when uncertain / toxic
size              = size0 · clamp(1 / (1 + c_Σ·Σ̂), …)   # SMALLER when uncertain
asymmetry         : on the thesis side, s_near = s·(1−a·|b|), s_far = s·(1+a·|b|)
```
- **Confidence sets spread + size** (`Σ̂` = normalized filter uncertainty): certain ⇒ tight + big; uncertain ⇒ wide + small. This is the principled replacement for a fixed γ/κ guess and is *the* lever that makes spread − adverse positive (you only quote tight when you actually know the price).
- **The view sets `q*` + the asymmetry**: a bullish thesis rests the book long and shows a better (tighter, larger) bid — you accumulate the position you want **at better-than-mid prices while earning the spread** (the directional-MM/"axe", see [DIRECTIONAL_MM_STRATEGY.md](DIRECTIONAL_MM_STRATEGY.md)).
- **Re-quote on every input tick** (book change, Binance move, new print) — not every 10s. Stale quotes are the adverse-selection tax; the live book must cancel/replace on `μ` moves. (The backtest harness already replays per-step; the live path needs an event-driven re-quote loop.)

All of this fits the existing `IQuoter` seam — the quoter becomes a pure function of an
**extended `QuoteContext`** that carries `μ, Σ, q*, b` (computed by the fair-value engine
the runtime owns), returning `reservationMicros, bidHalf, askHalf, size`. `b=0` + `μ=mid`
+ `Σ=const` reproduces today's quoter exactly (the swap-seam default — nothing regresses).

---

## 4. The Thesis Register — tracking the proprietary directional outlook

The capital-markets "house view" made durable and machine-usable: the bridge from
**research** (we have a view) to **quotes** (the book leans on it) to **accountability**
(did the view pay?). Mirrors the desk's storage doctrine — a mutable, soft-close,
append-history table, swap-seamed (Null/Postgres), surfaced on `/demo`.

### A thesis (one row)
```
thesis_id        directional view id
asset            BTC / ETH / sector / macro-regime
direction        LONG | SHORT | NEUTRAL
conviction       0..1   (sizes b and q*)
horizon          DAY | WEEK | LONG          (sets the drift time-constant)
rationale        the argument (text; later LLM-summarized catalysts)
entry_level      where the view turns on
invalidation     where the view is WRONG → auto-flatten the tilt (the stop)
target           where the view is realized → take the carry
owner            analyst / model / committee
source           HUMAN | MODEL | FUNDING_REGIME | SENTIMENT
status           ACTIVE | CLOSED | INVALIDATED
created_at / updated_at / closed_at
```

### How a thesis becomes a quote
`b(asset) = Σ_theses clamp( sign(direction)·conviction·horizon_weight )` → feeds Layer E
drift + the target inventory `q*` + the spread asymmetry. Multiple theses on one asset
blend (a daily momentum thesis inside a weekly funding-regime thesis inside a long-term
fundamental thesis — horizon laddering).

### The accountability loop (the honesty gate for views)
The `PnlAttributor` already isolates **inventory-carry P&L** — so each thesis gets its own
carry-P&L curve: *did leaning the book on this view actually make money?* A thesis whose
carry attribution is negative across its horizon is **retired**; a `source=MODEL` thesis
must pass an **OOS forward-return IC** before it's allowed to size `q*` live. This is the
investment-committee review, automated: research proposes, the book expresses, the
attribution judges. No view leans the book on conviction alone.

### Sentiment as a thesis source (the user's "sentiment" input)
Start with **market-structure sentiment** (clean, quantitative, no NLP): funding (crowded
positioning), open-interest changes, liquidation cascades, CEX-DEX basis, the funding-carry
discovery's persistent-funding sign ([FUNDING_CARRY_DISCOVERY.md](FUNDING_CARRY_DISCOVERY.md)
tells us which side is *paid*). These auto-generate `source=FUNDING_REGIME/SENTIMENT` theses
with measured IC. **Then** (push-to-edge, later, human-gated) an LLM-summarized news/catalyst
feed proposes `source=HUMAN` draft theses for analyst approval — never auto-traded.

---

## 5. The architecture (one picture)

```
   Binance price ─┐                         THESIS REGISTER
   HL L2 book ────┤   ┌──────────────────┐  (house view, versioned)
   HL trades WS ──┼──▶│  FAIR-VALUE       │◀── b, q*  ─────────┐
   funding ───────┘   │  ENGINE (Kalman)  │                    │
   technical pred ───▶│   → μ  (fair val) │                    │
                      │   → Σ  (confidence)│                   │
                      └─────────┬──────────┘                   │
                                ▼                              │
        spread s=f(Σ,σ,VPIN) · size=f(Σ) · skew→q* · asym→b    │
                                ▼                              │
                    QUOTES (re-quoted on every tick)           │
                                ▼                              │
                         FILLS / inventory ──▶ PnlAttributor ──┘
                    (spread | adverse | CARRY-per-thesis | fees)
                         └────────── did the view pay? grade & retire ───────────┘
```

---

## 6. Build plan (strictly incremental, measurable each step on the saved tapes)

| Phase | Build | Proven by |
|---|---|---|
| **F1** | **Microprice quoter** (Layer A) + extended `QuoteContext(μ,Σ)`; replay on the 20 saved tapes | does `spread − adverse` rise on the liquid coins vs the mid-quoter? (the #28 test, re-run) |
| **F2** | **Binance lead–lag** fair value (Layer B) — measure HL-vs-Binance lead, fold the lead into `μ` | the lead's OOS IC; further `spread − adverse` improvement |
| **F3** | **Flow drift + confidence-scaled spread/size** (Layer C + §3) — Kalman v1 (blend + EWMA Σ) | spread tight-when-certain flips the liquid coins net-positive without carry |
| **F4** | **Thesis Register** (table + `IBiasSource` + `/demo` panel) + directional skew (Layer E + §3) + per-thesis carry attribution | a known forward-drift tape: leaning long raises carry monotonically; invalidation flattens |
| **F5** | **Technical predictor** (Layer D) under purged-CV/deflated-Sharpe; **Kalman v2**; live event-driven re-quote loop | OOS IC gates; forward paper on the keep coins with all layers |

**Honesty rails (binding, every phase):** each signal earns its weight with an OOS IC before
it touches a live quote; interpretable models before ML; paper-only; modular-monolith +
swap-seam discipline; `b=0`/`μ=mid` reproduces today's quoter bit-for-bit; drawdown budget
(2% desk) caps the directional size. We are pricing better, not betting bigger.

---

## 7. Why this is the right edge to chase (the critical-thinking summary)

- The data says the spread can't be tuned into profit; the **price** can be. Fair value is
  the one lever that moves `adverse` — every other knob moves `spread`, which selection
  cancels. So the fair-value engine is not one option among many; it is *the* project.
- We have a **structural advantage most DEX MMs ignore**: a faster, deeper **lead venue
  (Binance)** whose price we already pull. CEX→DEX price transfer is a clean, large,
  buildable-this-week edge. **Do F1+F2 first.**
- Carry is the dominant P&L term; the Thesis Register makes it **chosen, governed, and
  graded** instead of luck — turning the biggest risk into the biggest, accountable alpha,
  and giving the desk the thing a real trading group has that a bot doesn't: a **house view
  with a P&L attached to it.**
- Everything is measurable on tapes we already own before a dollar of (paper) risk — so we
  push to the edge on ideas but never on hope.
