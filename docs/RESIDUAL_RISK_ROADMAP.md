# Residual-Risk Roadmap — implementing `residual_mm_risk_study.md`

> **Source:** [residual_mm_risk_study.md](residual_mm_risk_study.md) (2026-06-10). The study targets the four
> residual leaks that survive the micro-price + sub-second-cadence fix: **cross-hedge basis**, **trending
> inventory**, **residual adverse selection**, **hedge cost**. This roadmap turns it into ordered, gated work
> packages. **Each session: pick the next unblocked WP, write/refine its spec here, implement, test, log the
> session at the bottom, and update the NEXT SESSION PROMPT.** Experiments run as offline replays on captured
> data before anything touches the live quoter (study §8).
>
> Ordering follows study §8 — each WP gates the next. The §0 reframe governs everything: **the KPI is
> residual marked-P&L variance (factor vs basis split), not residual delta.** The hedger's "99.8% of gross
> delta neutralised" is true and almost irrelevant; with hedge-β R² = 0.5–0.8, 45–71% of each alt's vol is
> still live on the book after a "perfect" delta hedge.

## Already in place (don't rebuild)

| Study item | Existing code |
|---|---|
| Markout curve, multi-horizon (§2.1, partial) | `microstructure/markout-tracker.ts` — live since b92a4e7; lacks per-side + queue-position split and the 300s horizon |
| VPIN (§2.2, partial) | `risk/vpin.ts` + `risk-gate.ts` vpin-toxicity Pause — live since 004fec5; not yet validated against forward markout |
| Per-underlying delta netting | `hedge/desk-delta-hedger.ts` `netDeltaByUnderlying` — books mapped to the same underlying already net; **portfolio Σ / factor netting does not exist** |
| Fixed $2k dead-band | `HedgeConfig.bandUsd` — the static special case WP4 replaces |
| 4-component attribution | `backtest/pnl-attribution.ts` — single markout horizon, no factor/idio split |
| Queue-aware fills, 30ms cancel rail | `backtest/queue-*.ts`, `live/l2-live-fill-engine.ts` — the §2.3 act-on-queue rule is NOT yet a live rule |
| Inventory skew, σ-independent lean, hard cap | quoters + `risk-gate.ts` per-book scalar cap |
| Bias seam for drift (§3.2) | `bias/` — `IBiasSource`, OOS-gated; the drift-to-reservation-price wiring is WP5 |

---

## WP1 — Hedge-quality KPI: residual P&L variance, factor vs basis (study §0, §8.1) — **THIS SESSION**

**Goal.** Until this exists we cannot tell whether any later change helps. Per book and desk-wide, decompose
the marked-P&L variance of held inventory into the **factor** part (β·hedge-underlying move — what the delta
hedge can touch) and the **basis/idiosyncratic** part (the `(1−ρ²)σ²` residual — what it cannot). Surface a
live realized β and R² per book next to the configured β.

**Spec.**
- New pure model `src/market-making/hedge/hedge-quality.ts` — `HedgeQualityTracker`:
  - Fed once per hedge tick with the same `(books: BookDelta[], marks, tsMs)` the hedger already resolves —
    no new data path.
  - Per book *i* with hedge mapping `(u, β)` from the existing `betaMap`: per-tick returns `r_i` (book mid),
    `r_u` (hedge underlying mark); marked-P&L increment on the inventory held *before* the tick
    `pnl_i = q_usd,prev · r_i`, split `factor_i = q_usd,prev · β · r_u`, `basis_i = pnl_i − factor_i`.
  - Time-decayed (half-life, default 30min) EWMA second moments, normalised by dt → **USD vol per √hour**.
    Uncentered (drift ≪ vol at sub-second cadence). Desk-level series are summed per tick *then* EWMA'd, so
    cross-book netting shows up in the desk numbers (the WP3 prize, measured before it's built).
  - Live `β_live = cov(r_i,r_u)/var(r_u)` and `R² = ρ²` per book (return-based EWMA, inventory-independent).
- `DeskHedgeController` owns one tracker (built from its own `betaMap`), updates it in `rebalance()`, and
  exposes `quality?: HedgeQualitySnapshot` on `HedgeSnapshot` → flows to `/api/market-making` + UI for free.
- **KPI read:** `deskBasisVolUsdPerHour` is the unhedgeable leak; `basisShare` per book ranks names for the
  WP6 self-vs-proxy decision and basis-priced caps. Optimization target from here on:
  **residual variance per dollar of spread captured.**

**Win condition.** On a live run, desk factor vol ≈ what the hedge suppresses; desk basis vol is the number
that stays — confirm it is the same order as the realised "hedged but still bleeding" P&L noise of runs A′/#48.

**Gates:** everything below.

## WP2 — Markout completion + toxicity-signal validation (study §2, §8.2)

**Goal.** Establish the true adverse-selection horizon and pick F3's input honestly.

**Spec sketch** (refine at session start):
- Extend the markout instrumentation: horizons out to **300s**; split per **side** and per **queue position
  at fill** (front/middle/back third — the queue model already knows position). Per-book curves on the API.
- Capture per fill: `{book, side, fill_price, queue_pos_at_fill, depth_at_level, micro_price, mid}` + mids at
  `+{0.1,1,5,30,60,300}s` into the flow-shadow JSONL so curves are re-derivable offline (study §8 capture list).
- Offline script: regress forward 1-min markout on (a) VPIN, (b) realized signed-volume imbalance. **If VPIN
  adds nothing over imbalance, F3 consumes imbalance and we drop the VPIN complexity** (Andersen–Bondarenko
  caveat, study §2.2d/§7.4). Bias the F3 mapping toward caution either way.
- Hypothesis to reject: "markout is flat after 1s." If it slopes to 60s, F3's window and the hedge cadence
  are both too short.
- Live queue rule (§2.3): if our resting order has decayed to the back third of a thick queue AND flow is
  toxic on that side → cancel/re-post. Mind the rebate: excessive churn forfeits −0.2bps resting rebate.

**Gate:** the validated toxicity signal + horizon feed WP4's band and WP7's regime features.

## WP3 — Portfolio layer: net correlated inventory before hedging (study §5.1–5.2, §8.3) — **lever #1**

**Goal.** Stop hedging 8 books independently. One inventory vector `q`, live EWMA Σ, net factor exposure
hedged once; correlated inventories offset internally (zero taker cost, zero basis).

**Spec sketch:**
- **Replay experiment first** (the highest-leverage single test): replay a captured desk window as
  (A) 8 independent hedgers (current) vs (B) portfolio-netted single residual-factor hedge. Compare taker
  cost, gross hedge notional, residual P&L variance (WP1 KPI is the judge). Expect a large drop in (B).
- Live: a portfolio risk layer in front of `DeskHedgeController` — aggregates `q`, holds live Σ (extend WP1's
  EWMA moments to the full cross-book covariance), computes net factor delta (BTC/ETH factors), issues ONE
  hedge instruction for the residual. Per-book quoter skew reads the portfolio risk contribution `(Σq)_i`,
  not just local `q_i` — diversifying inventory is skewed less.
- **Correlation-aware caps** (§5.2): portfolio cap on `qᵀΣq` / factor-VaR evaluated on fills, with **stressed
  Σ (correlations → high) for the cap** even while live Σ drives the hedge — calm-market Σ is too loose in a
  flush. Per-book hard caps stay as backstops.
- Failure modes to design for: correlation spike-to-1 in crashes; Σ estimation error; the layer is hot-path —
  keep it O(n²) incremental, no refits on tick.

**Gate:** WP4's band and WP6's instrument choice operate on the *netted residual*, not per-book deltas.

## WP4 — Adaptive hedge band + internalize/externalize (study §3.3 + §4.4, §8.4) — one object, built once

**Goal.** Replace `bandUsd: 2000` with the Barzykin–Bergault–Guéant structure: an inventory region where the
optimal action is to NOT hedge (skew/internalize — client flow flattens you for free), outside which the
hedge **rate rises with distance past the band**, plus a stop-and-flatten hard backstop at the cap when the
mark moves persistently against us.

**Spec sketch:**
- `band(σ, hedgeCost, toxicity)`: widens with hedge cost and franchise/flow rate, narrows with vol and basis;
  **capped** (a vol-scaled band must not balloon in a vol spike, §4.4d).
- Outside the band: hedge rate ∝ distance past it (continuous externalization), not a binary flatten.
- At the hard cap AND adverse-move rate > threshold: cross to flatten (tail-loss cap; tune for *persistent*
  moves, not spikes — "stopped out at the bottom" is the failure mode).
- Experiment: sweep band width / adaptive-vs-fixed on the hedge-cost vs residual-variance frontier (captured
  data); pick the frontier point. Also (A) skew-only-to-cap vs (B) flatten-at-cap vs (C) continuous threshold
  on the worst trending window — C should dominate 5th-percentile P&L per unit cost.

## WP5 — Drift-aware quoting, gated (study §3.2, §8.5) — the dangerous one, deliberately last of the core set

**Goal.** Stop accumulating against trends: add a short-horizon drift/alpha term to the reservation price
(micro-price velocity / OBI momentum / signed-trade EWMA via the existing `IBiasSource` seam) so the desk
raises both quotes and pulls the offer pre-emptively in an up-trend.

**Spec sketch:** additive reservation-price shift + against-trend quote pull; **gated** (on only when
|signal| > threshold AND toxicity confirms); small vs the spread; capped inventory effect; never overrides
the hard cap. Measure the wrong-signal tail cost explicitly — if it exceeds the trending-window gain, ship it
off (study §3.2e). Raise γ in trending regimes (§3.1) as the cheap companion knob.

## WP6 — Hedge-instrument & estimator economics (study §4.1, §4.2, ranked #4, §8.6)

**Spec sketch:**
- **Self-vs-proxy per name:** per alt, realized basis-vol cost of proxy-hedging vs realized taker cost of
  self-hedging (HL lists own perps for all 8 names); `hedge_with ∈ {own_perp, major_proxy}` switch in the
  beta map. Resolve the tension with WP3: net first, hedge residual factor, direct-hedge only names whose
  idio residual stays too big.
- **Beta bake-off:** static-30d-OLS vs EWMA vs Kalman, scored on **residual variance minus extra hedge cost**
  (WP1 KPI) — the literature says Kalman often wins tracking and loses economics; test, don't assume.
- **Price the basis** (study #4): widen an alt's half-spread ∝ its basis vol; tighten its cap when R² is low
  (SUI/DOGE-class names earn more to be warehoused and are allowed less warehouse).

## WP7 (optional, after 1–6) — Regime detection & parameter switching (study §5.3)

Calm/trending/toxic classifier (realized vol, signed-flow autocorr, validated toxicity signal) switching
{γ, F3 mapping, drift gate, band, cap multiplier} with **hysteretic** transitions. Only worth it if
per-regime params beat global params OOS net of switching cost.

---

## Session log

### 2026-06-10 — Session 1: roadmap + WP1
- Read the study; verified what already exists (markouts b92a4e7, VPIN 004fec5, per-underlying netting).
- Wrote this roadmap.
- WP1 implemented: `hedge/hedge-quality.ts` (`HedgeQualityTracker`), owned by `DeskHedgeController`,
  updated each `rebalance()` (same books + resolved marks the hedge itself trades off — no new data
  path), surfaced as `HedgeSnapshot.quality`, reset by `reset()` (the closeAll ritual). Tests + tsc
  green. See the WP1 section above for the spec as built.
- **UI QA (wiring verified end-to-end + choices):** the snapshot flows
  `DeskHedgeController.snapshot()` → `MmPortfolioTrader.snapshot().hedge` (mm-portfolio-trader.ts:484)
  → `GET /api/market-making/snapshot` → both UIs; the quality block is float/null-only so JSON-safe.
  Choices: (1) **new UI hedge panel** (`src/ui/render/mm-desk-view.ts`) gets a `basis σ` stat — desk
  basis vol USD/√h + "% unhedgeable" (basisVar/pnlVar) — placed deliberately NEXT TO "% neutralised",
  because §0's whole point is that the neutralised number over-promises; plus a per-book quality row
  (`SOL→BTC β1.10→1.03 R²0.72 basis 29%`) — the live ranking that will drive WP6 self-vs-proxy hedging
  and basis-priced caps. (2) **legacy `/demo`** header line gets the same desk-level basis read
  (kept to one line — /demo is retirement-pending, no panel work there). (3) Both render only once the
  tracker has samples (show only what's measured). View specs cover render + the still-priming case.
- **Verification:** tsc clean; full suite 187 suites / 1261 tests — 186 suites green; the one failure is
  the **known pre-existing telemetry suite** (Ronnie: known-failing before this work, do NOT investigate).
- **Process rules set this session (binding):** no background tasks — run verification foreground, hand
  long-running runs to Ronnie's terminal; per-session UI-wiring QA is standing (see prompt below).

### 2026-06-10 (later) — Session 1b: first live WP1 baseline + the Epps fix (WP1.1)
- **First live read** (10h run, ~1,800 hedge-tick samples, desk net +$8.5 at read time; SOL short
  −$50k dominating): `deskPnlVol ≈ $170/√h`, `deskFactorVol ≈ $115/√h`, `deskBasisVol ≈ $172/√h` —
  **more than half the desk's marked-P&L variance is basis the delta hedge cannot touch**, exactly
  the study's §0 claim, now measured on our own desk. SOL: pnlVol 167 / basis 170 / factor 111,
  basisShare ≈ 1 at tick cadence.
- **Measurement caveat found live (the Epps effect):** at 100ms sampling, alt/major returns
  decorrelate mechanically (asynchronous ticks) — ADA printed betaLive −29 at R² 0.002, and the split
  over-attributes variance to basis. The 30d×1h OLS map (R² 0.5–0.8) and the 100ms read are both
  true at their own horizons; the KPI's job is inventory-carry risk, which lives at seconds-to-minutes.
- **WP1.1 fix:** the tracker now samples on **60s buckets** (compounded returns bucket-open→close,
  inventory valued at bucket open; `HedgeConfig.qualityBucketMs`, default 60_000) instead of per
  hedge tick. Per-tick feeding is unchanged — the controller still calls `update()` every rebalance;
  the tracker closes a bucket when ≥ bucketMs has elapsed. β_live/R² and the factor/basis split are
  now read at the horizon the hedge actually defends. **The 10h run still serves the per-tick numbers
  (old code in-process) — re-baseline on the FIRST RUN AFTER this ships**; expect β_live to move
  toward the OLS map and basisShare to drop from ≈1 to the honest 1−R² (~0.2–0.5).

---

## NEXT SESSION PROMPT

> We are implementing `docs/residual_mm_risk_study.md` via `docs/RESIDUAL_RISK_ROADMAP.md`. WP1 (hedge-quality
> KPI: factor-vs-basis residual variance, live β/R², `HedgeSnapshot.quality`) shipped on 2026-06-10.
> **Do WP2 now:** (1) extend markout instrumentation to 300s with per-side and per-queue-position splits and
> per-fill capture into the flow shadow; (2) the offline regression of forward 1-min markout on VPIN vs
> realized signed-volume imbalance — decide F3's input and window from the data, biased toward caution;
> (3) the live back-of-queue + toxic-side cancel/re-post rule, rebate-aware. Write the detailed WP2 spec into
> the roadmap first, then build. Before starting, run a desk session (or use the latest flow-shadow JSONL in
> `docs/research/`) so WP1's `quality` block has a real read — log the first desk factor-vs-basis numbers in
> the session log; they baseline every later WP. Keep experiments offline-replay-first; commit at session end
> and update this prompt.
>
> **Standing per-session QA (Ronnie, 2026-06-10):** before closing any session, trace the UI wiring for
> what you changed (API field → both UIs), add/adjust the rendering where it makes sense, and document
> the choices in the session log. Also note: `master` and `feat/mm-desk-diagnostics-and-guide` have
> diverged (branch is the newer work line, 43 commits ahead / 9 behind by SHA — the "behind" commits'
> content already exists on the branch); reconcile deliberately in a maintenance pass, don't auto-merge.
