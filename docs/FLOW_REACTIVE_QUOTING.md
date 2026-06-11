# Flow-Reactive Quoting — Design Spec (operator second opinion, 2026-06-11)

> **Provenance & status.** Operator-authored spec (Ronnie, 2026-06-11), accepted as the desk's
> quoting/hedging design of record. The **session-by-session implementation chain lives in
> [MASTER_PLAN_SESSIONS.md](MASTER_PLAN_SESSIONS.md) PART V (MASTER PLAN II, sessions F0–F5)** —
> work from there; this file is the design reference the prompts cite.
>
> **Label note:** the spec text says "run54"; the canonical artifact label is **run55**
> (`docs/research/leak-table-run55.{md,json}`; run54 = the aborted 13:46–14:24Z boots — Journal #58).
> All numbers below are the run55 leak table and reconcile exactly (warehouse −95 = Σ books,
> fillEdge −99 = Σ books, churn −437, fees −229 books-sum).
>
> **Code seams the prompts land on:** `SweepRegimeDetector` (risk/sweep-regime-detector.ts — the
> binary S4 gate this design supersedes with the §3 regime machine), `DeskDeltaHedger` +
> `MmPortfolioTrader.deskDeltas()` (the churn source, mm-portfolio-trader.ts:127 mid≤0 dropout),
> `PnlAttributor`/MO60 markouts (in-memory — F0 persists them), `scripts/mm-leak-table.ts` (the
> per-prompt validation instrument), `LobReplayHarness` (the offline gate).

---

## 0. The one frame

The base quoter assumes a martingale mid: `E[Δmid] = 0`. The reservation price is
therefore only unbiased in the **no-information regime**. The flow signal
(`flow ∈ [−1,1]`, signed aggressor-flow imbalance; `|flow|>0.4` = one-sided
informed tape) is a direct conditioner on `E[Δmid | flow]`. Empirically (Cont–
Kukanov–Stoikov 2014) short-horizon price change is near-linear in order-flow
imbalance with slope `≈ 1/depth`.

**Everything below is a single idea: make reservation price and spread conditional
on the flow state.** No new model — a conditioning layer on the existing GLFT
output.

Two non-negotiable priors:

- **Flow is a risk throttle first, directional alpha second.** VPIN-style toxicity
  can lag the move (Andersen–Bondarenko 2014). Reducing exposure when toxic is
  robust; sizing *into* flow as clean alpha is not. Keep the directional gain `κ`
  small until per-book markout proves predictiveness.
- **Toxicity ≠ |flow|. Toxicity = flow aligned against inventory.** The control law
  is driven by `A = sign(q)·sign(flow)`, not `|flow|`.
- **Transaction cost dominates adverse selection on this desk (run55).** ~75% of the
  loss is hedge churn + taker fees, not getting picked. The flow-reactive quoting
  layer below is real, but it targets the *smallest* leak. Build the cost fixes first.

---

## 0.5 Build order is leak-driven (run55: net −879 / 3.6h)

The design (§1–§8) is unchanged. The **sequence** is reordered around where the money
actually goes. Decomposition:

| leak | $ | bucket | targeted by |
|------|---|--------|-------------|
| hedge churn (taker cost) | −437 | transaction cost | F1 |
| quoting fees (taker) | −229 | transaction cost | F2 |
| warehouse MTM (1-sided inv) | −95 | inventory | F3 |
| fill edge (picked off) | −99 | adverse selection | F4 |

Key reads that drive the order:
- Implied hedge-leg directional P&L ≈ −21 (desk-net −879 vs implied hedge −458 with
  −437 of that being churn cost). **The hedge isn't directionally wrong — it's
  churning.** 56 orders / 19 flips / $1.6M turned over for ~flat coverage.
- **DOGE**: picked off (−46 fill edge) but balanced (20% conc) → warehouse +104 → net
  **+59**. Balanced inventory beat getting picked. Inventory management > pick-avoidance
  on this desk.
- **ADA**: 94% concentration → warehouse −138. One-sided accumulation is the real
  warehouse leak, not marking.
- Validation is currently **uncomputable**: spread/adverse/wedge/vpin/markout all
  `n/a`; per-fill markout and windowed attribution are in-memory only. The κ-leads-
  markout gate cannot run until that is persisted → **F0 is a hard prerequisite.**
- `worst5m` column is glitched (kPEPE −3,033,717 vs −127 net) — units/aggregation bug,
  fixed in F0.
- *(Desk note, Journal #58)*: the fee leak is partly the **loss-stop taker flattens**
  (12 stops ≈ −$664 realised incl. their taker cost; CL's $76 fee line includes 3 stops),
  and the hedge churn is partly **stop-induced** (stop snaps book delta → leg unwind →
  re-open). F1's net-first + F2's trigger attribution make this separable.

**Revised sequence:** F0 (instrument) → F1 (hedge anti-churn) → F2 (quote anti-churn)
→ F3 (inventory skew) → F4 (flow-reactive, throttle-first, κ gated) → F5 (capital ∝
measured fillEdge). The directional-alpha work that led the first draft is now last and
gated, because it aims at the −99 bucket you can't yet measure.

---

## 1. Signal layer — `FlowState`

Computed per book, every tick. Raw `flow` already exists; this layer adds
smoothing, persistence gating, toxicity, and alignment.

| field        | definition |
|--------------|-----------|
| `f_raw`      | instantaneous signed aggressor-flow imbalance ∈[−1,1] |
| `f`          | EWMA of `f_raw`, half-life `hl_f` (per book, ~1–5s equiv) |
| `persist`    | # consecutive ticks (or seconds) `|f| > θ_enter`; resets on sign flip |
| `flip`       | bool: `sign(f)` changed this tick (front of move flipping) |
| `T`          | toxicity ∈[0,1] = `clip(|f|, 0, 1)` blended with volume-bucket imbalance (VPIN-lite); see §6 for calibration |
| `A`          | alignment = `sign(q)·sign(f)` ∈ {−1,0,+1} |
| `vol`        | short-horizon σ estimate (existing) |

**Gating rules (kill chatter):**
- The directional/defensive response ramps in via `g = clip((persist - p_min)/(p_full - p_min), 0, 1)`. A single informed print does **not** move quotes; sustained flow does.
- **Hysteresis:** enter defensive at `|f| > θ_enter` (e.g. 0.40), exit only below `θ_exit` (e.g. 0.25). Minimum dwell time per regime.
- On `flip`: freeze hedge adds (see §5), reset `persist`, decay `g` rather than snapping — the front reversing is itself information, don't whipsaw on it.

---

## 2. Control law — augmented quoting

Inputs: base GLFT reservation `r0`, base half-spread `δ0`, `FlowState`, inventory `q`.

### 2.1 Re-center (primary, continuous)
```
alpha   = κ * f * g                 # κ ≈ 1/depth, per book, markout-calibrated
p_star  = mid + alpha * px_scale    # px_scale in price units (σ or tick based)
r       = p_star  -  q * γ * vol^2 * H     # H = GLFT/AS inventory term
```
`κ` capped at `κ_max` (per book) and the *total* skew capped at `skew_max` to limit
information leakage to skew-sniffers (price-reading effect — with non-zero inventory,
over-skewing leaks your position).

### 2.2 Toxicity spread multiplier
```
δ_base = δ0 * (1 + λ * T)           # widen with toxicity
```

### 2.3 Asymmetric per-side widening
Let `toxic_side` = the side flow is hitting (`ask` if `f>0`, `bid` if `f<0`).
```
δ_ask = δ_base * (1 + w_ask * T)    # w_toxic > w_safe
δ_bid = δ_base * (1 + w_bid * T)
ask_px = r + δ_ask
bid_px = r - δ_bid
```
In the **HARVEST** quadrant (A>0) override: do **not** widen the reducing side —
tighten it to `δ0 * (1 - h_harvest)` to exit into favorable flow.

### 2.4 Size scaling
```
size_toxic = size0 * clip(1 - s_cut * T, s_floor, 1)   # cut size flow can dump on you
size_safe  = size0 * (1 + s_boost * T * (A>0))         # boost reducing side in harvest
```

---

## 3. Regime state machine

States per book. Transitions use the hysteresis/dwell rules from §1.

```
                 ┌──────────────────────────────────────────────┐
                 │                   NORMAL                      │
                 │  base GLFT; alpha/widen ~0 (T low)            │
                 └───────────────┬──────────────────────────────┘
                       |f|>θ_enter & persist≥p_min
            ┌──────────┴───────────┐
        A<0 (against inv)      A>0 (with inv)
            │                      │
            ▼                      ▼
     ┌─────────────┐        ┌─────────────┐
     │  DEFENSIVE  │        │   HARVEST   │
     │ max re-cent.│        │ tighten     │
     │ widen toxic │        │ reducing    │
     │ cut toxic sz│        │ side; let   │
     └──────┬──────┘        │ flow flatten│
            │               └─────────────┘
   escalate if:
   |f|>θ_high (sustained) OR |q|>q_hard
   OR markout(side) deteriorating
            ▼
     ┌─────────────┐
     │FLATTEN-ONLY │  pull toxic side entirely; quote reducing side through/at mid;
     │             │  if drift_cost > flatten_cost → cross to flatten (see §4)
     └──────┬──────┘
            │  vol spike / stale feed / |T|→1 disorderly
            ▼
     ┌─────────────┐
     │    HALT      │  pull all quotes; flat-passive; alert
     └─────────────┘
```

`HARVEST` never escalates to flatten on flow alone — flow with you is the exit, not
the threat. It exits to NORMAL once `|q|` is back inside the soft band or `|f|<θ_exit`.

---

## 4. Flatten decision (cross-the-spread inequality)

Do **not** binary-kill then cross late. Evaluate continuously in DEFENSIVE/FLATTEN:

```
drift_cost   = |q| * |κ * f| * px * τ_persist        # expected adverse move over the
                                                     # informed episode's horizon
flatten_cost = |q| * (δ_half + taker_fee + impact(|q|) + E[funding over τ])

flatten_qty  = portion of q where drift_cost(marginal) > flatten_cost(marginal)
```
- `τ_persist` (expected duration of informed flow) and `κ` both come from MO60
  markout regressions (§6). This is *why* the markout layer exists.
- Flatten **partially** to the level where marginal hold cost = flatten cost; rarely
  all-or-nothing.
- In a fast informed run, **speed > impact** — do not TWAP into a move that's leaving
  you behind. Child-order only when the move is slow relative to your size.

---

## 5. Hedge decoupling (kills hedge-churn)

The flow reaction lives in the **quoting** layer. The hedge keeps its own slower,
banded cadence. Coupling them = churn.

- **Net-first:** when flattening primary inventory, recompute net beta-weighted delta
  and let the existing hedge no-trade band absorb it. Do **not** fire an opposing
  hedge leg in the same cycle.
- **Flip cooldown:** on `flip`, freeze hedge *adds* for `cooldown_flip` — the front
  of the move is reversing; hedging now risks buying the top of the hedge leg.
- **Basis gate:** for high-basis books (poor hedge quality — e.g. basis ≳ 60–100%),
  prefer **flatten-primary** over **add-hedge** in toxic regimes. Flattening primary
  removes adverse-selection *and* basis risk simultaneously. (Watch your own basis
  column: SOL→ETH 30% is hedgeable; FARTCOIN→ETH 100% is not — flatten it.)

---

## 6. Calibration loop — markout-driven, per book

Two loops. Real-time flow reacts now; markout (MO60) evaluates and auto-tunes. This
replaces ~20 hand-set magic numbers with per-book estimates.

- **`κ` and `τ_persist`:** regress forward return (1s / 5s / 60s markout) on `f` per
  book. Slope → `κ`; decay of the autocorrelation of `f` → `τ_persist`.
- **Side-toxicity auto-tune:** track realized markout per side. If `MO_side`
  persistently < band, auto-increase that side's `λ`/`w_side` (bounded), and log.
  (xyz:CL `MO60 A −10bp` would trip this immediately → widen/skew ask.)
- **`T` blend:** `T = clip(|f|,0,1)` initially; optionally blend a volume-bucket
  order-imbalance (VPIN-lite) once you have buckets. Validate it *leads* markout per
  book before trusting it — if it only lags, keep it as a throttle, not a predictor.
- Everything per book. CL, GOLD, SOL, ADA, FARTCOIN have different depth, tick, vol,
  basis — global constants will be wrong somewhere.

---

## 7. Safety / failure modes

| failure | guard |
|---------|-------|
| Reacting to noise | EWMA + `persist` gate + hysteresis + min dwell |
| Regime flip-flop | separate enter/exit thresholds, dwell timer |
| Flattening in HARVEST | alignment sign hard-gates flatten to A<0 only |
| Skew leakage to sniffers | `skew_max` cap + small jitter; reduce skew as |q| grows |
| Hedge churn | net-first, flip cooldown, basis gate |
| Crossing late in a fast move | graduated continuous defense, not wait-then-cross |
| Stale/disconnected feed | staleness watchdog → HALT; HL drops are silent, reconnect + snapshot reconcile |
| Over-trusting toxicity | κ small until markout-validated per book; throttle-first |
| Funding leak on held inventory | include E[funding·τ] in flatten_cost |

---

## 7.5 Observability (operator requirement, 2026-06-11 — binding)

The system acts with no human in the loop, so **every automatic response is a logged, structured
event**, not just guardrails: regime transitions WITH the triggering FlowState (f, T, A, q,
persist, g), quote-level responses as they take effect (re-center bps, per-side widen ×, size ×),
every settings/auto-tune change (old→new + the markout evidence), every trade/quote blocked or
suppressed (reason + numbers), every hedge freeze/cooldown/band-hold, every flatten decision with
the §4 inequality's actual values. Grammar: extend the existing `▸` tape (`GUARDRAIL ▸`/`REGIME ▸`/
`HEDGE ▸`) with `CONTROL ▸`, `PARAM ▸`, `BLOCKED ▸`, `FLATTEN ▸`. Log on change + periodic state
line (never per-tick spam); everything lands on the DeskEvent ring buffer + /mm-desk Activity feed
and persists (F0) so a finished run is auditable from SQL. Full per-prompt requirements:
MASTER_PLAN_SESSIONS.md PART V.

## 8. Per-book parameter table (calibrated, not global)

Seed, then let §6 tune. Store per book; never share across books.

```
book        κ_max   λ    w_toxic  w_safe  θ_enter θ_exit θ_high  q_soft q_hard  hl_f   basis_gate
xyz:CL      ...     ...  ...      ...     0.40    0.25   0.70    ...    ...     ...    hedge
xyz:GOLD    ...     ...  ...      ...     0.40    0.25   0.70    ...    ...     ...    hedge
SOL         ...     ...  ...      ...     0.40    0.25   0.70    ...    ...     ...    hedge
ADA         ...     ...  ...      ...     0.40    0.25   0.70    ...    ...     ...    hedge
FARTCOIN    ...     ...  ...      ...     0.45    0.30   0.65    ...    ...     ...    flatten
...
```

---

## Implementation chain & validation gates

**The paste-ready session prompts (F0–F5) and the per-prompt validation gate table live in
[MASTER_PLAN_SESSIONS.md](MASTER_PLAN_SESSIONS.md) PART V** — single source, kept current by the
chain protocol (each session updates the next prompt with fresh numbers). Re-run
`scripts/mm-leak-table.ts` after every prompt and record the delta vs the run55 baseline.
