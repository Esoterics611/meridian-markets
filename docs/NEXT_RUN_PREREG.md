# Next-run pre-registration

Pre-registering the universe, signal, horizon, and success metric **before** the run — the
methodology fix from QUANT_JOURNAL #36 (the BTC-funding "edge" flipped to inconclusive the
moment one more coin was added; a finding that moves when you test one more thing was never
robust). No expanding the sweep mid-run and keeping the survivors.

This is the forward plan that answers the #39 post-mortem (inventory carry was the whole loss;
the spread engine is fine). Two runs, one variable changed at a time.

---

## Run A — the inventory governor, neutral (THIS is the next run)

**Hypothesis (pre-registered):** with the two DEFENSIVE layers on, a neutral spread-capture
desk holds a steady, low-drawdown NAV curve and **unrealised stops being the loss column**.

- **Universe (frozen):** BTC, ETH, SOL, DOGE, BNB, XRP, ADA, SUI — the Entry #28 KEEP set. $1M/book, $8M desk.
- **Strategy:** `mm-glft` (neutral) on every book. NO directional, NO live bias.
- **Changes under test (both inventory-neutral defences, shipped together):**
  1. the **inventory governor** — `MM_HARD_INVENTORY_CAP=true`, `MM_INVENTORY_SKEW_MULT=10`, `MM_MAX_INVENTORY_LOTS=4` (bounds how much inventory you can carry);
  2. the **adverse-selection defence (F3)** — `MM_F3_TOXICITY=true` (widen into informed/one-sided flow, tighten into calm) — validated offline, newly wired live.
  Both are defence, not a directional bet, so bundling them is one coherent hypothesis ("defensive MM holds the curve"); the #39 run is the no-defence baseline to compare against.
- **Everything else held vs #39:** same venue (HL), fast re-quote 100ms, micro-price center, fees/rebate, persistence.
- **Signal capture:** `MM_FLOW_SHADOW=true` stays on — measure-only, zero P&L, keeps growing the directional validation set for Run B.
- **Success metric (pre-registered, judged on `mm_nav`):**
  1. **Desk unrealised |P&L| ≤ ~0.3× |realised|** at the end (inventory is a transient, not a position) — the direct refutation of #39's −$10.5k unreal / −$1.2k realised.
  2. **Per-book maxDD ≤ ~1.5%** (vs SOL 6.5% / BTC 3.4% in #39).
  3. **No book carries inventory > `MM_MAX_INVENTORY_LOTS`** at any checkpoint (the hard cap holds).
- **Run:** `scripts/launch-mm-10h.sh` (header has the exact server env). Score the shadow capture after with `scripts/flow-bias-markout.ts`.

> **VERDICT (2026-06-08, ~10h, Journal #41):** metric 1 **PASS** (unrealised +$1,464 = 0.15× realised −$9,952 — the #39 unrealised-bag pathology is gone); metric 2 **FAIL** (per-book maxDD SUI 17.6% / BTC 10.3% / SOL 7.4% — only DOGE ≤1.5%); metric 3 holds (governor flattening). Desk **−$8,225** net. **Lesson:** the governor fixed the *unrealised* axis only — it crystallised the loss into realised by flattening, it did not stop the bleed, because **a fixed lot-cap ≠ bounded drawdown and the desk's NET DELTA is unhedged.** Fixes shipped: notional inventory cap (`MM_MAX_INVENTORY_NOTIONAL_FRAC`) + the `DeskDeltaHedger` model (`docs/HEDGING_MODEL.md`). **Run A′ supersedes this:** governor + notional cap + delta hedge; same metrics; required before any directional Run B.

## Run B — the time-stopped directional lean (the run AFTER A)

Only after Run A confirms the governor works. Needs phase-B code first (the taker time-stop +
the hedge leg — neither exists yet on the fast path).

- **Universe (frozen, NOT to be expanded):** BTC, ETH, XRP only. These are the coins whose
  flow signal showed **stable positive short-horizon IC** across the #38 and #39 captures
  (30–60s IC ~0.15–0.19); SOL/SUI reverse at longer horizons and are excluded by rule.
- **Signal:** the fast flow-imbalance bias (`RollingIcFlowBiasSource`), self-gated per coin.
- **Horizon (frozen):** the lean is held to **~60s** by a hard inventory **time-stop** — any
  lot older than the horizon is flattened at market. This is the direct fix for #39's root
  cause (a 30s alpha must not become a 30-minute bag).
- **Risk:** desk-level net-delta hedge (the 8 books are one crypto-beta bet, not 8 independent
  ones — #39); hedge cost priced into the quoted half-spread.
- **Success metric (pre-registered):** directional books beat their own neutral baseline
  (Run A) on net P&L **without** their maxDD exceeding ~1.5%. If a coin's live IC decays below
  threshold, it self-disables — that is expected, not a failure.

---

**Standing rule:** if a result only appears after adding a coin / horizon / signal not listed
above, it is a multiple-testing artifact, not an edge. Re-run from a fresh pre-registration.
