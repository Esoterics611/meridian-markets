# Meridian Markets — The Master Plan (single source of truth)

> **Living document — last updated 2026-06-14.** This is the ONE plan. It absorbs and supersedes
> the previously scattered plans, now in [`docs/archive/`](archive/) for detail: the F-chain
> session chain (`MASTER_PLAN_SESSIONS`), `ROADMAP`, the wealth-desk red-team (`MASTER_PLAN_III_v2`),
> the residual-risk roadmap + study, and the point-in-time handoffs/prompts
> (`NEXT_SESSION*`, `NEXT_RUN_PREREG`, `FOLLOWUP_BUILD_PLAN`, `MERIDIAN_BRIEFING`, `CADENCE_LIVE_LOOP_PLAN`,
> the build/session prompts).
>
> Chronological run log: [QUANT_JOURNAL.md](QUANT_JOURNAL.md). Citable verdicts:
> [RESEARCH_FINDINGS.md](RESEARCH_FINDINGS.md). Operate the desk: [RUN_THE_DESK.md](RUN_THE_DESK.md).
> The live next-session plan also lives in the agent memory backlog.

---

## 1. The goal (binding)

**Make money** — steady, conserved, **honest realised P&L** — by market-making the **Hyperliquid
rebate CLOB** and the broader HL perp universe, as a **paper-trading demonstration of an
AI-agent-run quant desk** (CLAUDE.md §1). Paper-only for the foreseeable future; real capital /
production routing is **parked**. The MM desk is the live earner; **honesty about the numbers is
the whole game** — a demo that reports inflated returns is worthless.

**The one metric that matters: desk REALISED P&L ≥ 0 with per-book maxDD ≤ ~1.5%.** Net flatters
the desk when open inventory is marked into a favourable move; we judge on **realised**.

---

## 2. Where we are (2026-06-14, honest)

**Not yet realised-profitable — the screen gave us the winners; the first concentrate run (#68) failed
and the journal re-read corrected the fix.** The 25-screen (#66/#67) showed fillEdge is positive on the
clean books (TRUMP +20, ZEC +18, ENA +17, SUI +16, BNB +4) and **the entire bleed is warehouse drift**.
The first concentrate run (#68) lost **realised −$1,126** — in a toxic overnight regime fillEdge
collapsed, and (the mistake) the armed inventory time-stop NEVER FIRED behind the validated 0.01%
loss-stop. The journal re-read fixed it: the **0.01% loss-stop is the VALIDATED warehouse control (#62)**
so keep it; the **time-stop is redundant/regime-dependent (#53)** so drop it; **a guardrail can't fix
negative fillEdge (#55)** so the driver is regime + market selection; and the real lever is the **F4
flow regime gate (#56, "the most important knob")** which prevents inventory building into a sweep. The
corrected `launch-concentrate.sh` (#68) = KEEP-8 + flow gate + F2 + validated loss-stop, launched in a
LIQUID session. The same picture repeats #41 → #64/#65/#66/#67/#68 + the live run:

- **The quoter is fine.** Adverse selection is ~closed on the rebate books (micro-price centre +
  sub-second re-quote + F3 toxicity + the inventory governor): desk **fillEdge ≈ 0**, slightly
  positive on SOL/kPEPE/SUI/ADA, fees ≈ 0 (rebate intact), **DD tight** (≤0.40% on #64).
- **The bleed is WAREHOUSE DRIFT.** Inventory held for minutes drifts against us — the loss lives
  *outside* the 1–30s markout window (#49). The governor caps the *size* of inventory, not the drift.
- **We cannot predict the drift.** The F4 Stage B κ-gate (#65) proved **flow does NOT lead price**
  (pooled IC 0.12@1s → 0.004@300s). So no directional lean is justified — directional is parked.
- **Some markets don't drift.** SOL/DOGE post positive realised live; ADA/kPEPE bleed. The
  difference is the *market* (naive two-sided flow keeps inventory flat), **not the config**.

**Shipped (the defence stack):** F0 research persistence · F1 hedge anti-churn · F2 quote
anti-churn (OFF) · F3 inventory concentration + toxicity (ON) · F4 Stage A throttle (OFF) + Stage B
κ-gate (κ=0, by data) · inventory governor (notional cap + skew, ON) · 0.01% loss-stop · delta
hedge · the 25-book universe-screen tooling. Engine/UI/telemetry detail in CLAUDE.md §8 + the
archived `ROADMAP`.

---

## 3. The path to profit — THE active priority chain

The strategy is empirical: **find the markets where the rebate beats the drift → concentrate
there → cut the drift → compound.** In order:

1. **[DONE #66/#67] The 25-market wide screen** — 25 books × $1M ranked the HL universe by realised
   fillEdge (`leak-table-screen25-s2.md`). Verdict: quoter fine, warehouse drift is the whole bleed.
2. **[DONE #68 — FAILED, corrected] First concentrate run** — KEEP-8 + (mistakenly) the inventory
   time-stop, ran deep-overnight: realised −$1,126, time-stop never fired (redundant behind the
   validated 0.01% loss-stop). Journal re-read corrected the lever (see §2). `scripts/mm-rank-books.ts`
   built — ranks any screen's leak-JSON by realised fillEdge → KEEP set + hedge map.
3. **[NEXT — operator launches] The CORRECTED concentrate run** — `scripts/launch-concentrate.sh`:
   KEEP-8 + **F4 flow gate (`MM_REGIME_GATE=flow`)** + **F2** + the **validated 0.01% loss-stop**
   (time-stop OFF), capital held constant ($1M/book), **launched in a LIQUID session** (not overnight).
   Tests for **real realised profit**. If realised flips +, the run after scales capital on survivors.
4. **Compound + automate** — longer runs to compound the rebate on the winners; build
   `scripts/learn-from-run.ts` (the training loop: run → fitters → proposed next-config diff,
   human-gated — [RUN_TRAINING_LOOP.md](RUN_TRAINING_LOOP.md)); re-run the standing κ-gate across more markets/volume.

---

## 4. The defence stack — F-chain status (condensed; detail in archived `MASTER_PLAN_SESSIONS`)

| Phase | What | Status |
|---|---|---|
| **F0** | research persistence / attribution (mm_fill_markout, mm_hedge_nav, leak table) | SHIPPED #59 |
| **F1** | hedge anti-churn (min-hold / flip-cooldown / net-first / basis gate) | SHIPPED #60, **ON** |
| **F2** | quote anti-churn (requote hysteresis/dwell) | SHIPPED #61, **OFF** → arm on concentrate run |
| **F3** | inventory concentration + toxicity widen + 0.01% loss-stop | SHIPPED #62, **ON** |
| **F4A** | flow-reactive risk throttle (κ=0) | SHIPPED #63, **OFF** (gate not cleared on calm tapes) |
| **F4B** | κ·flow re-centre (directional) | gate BUILT+run #65 — **NOT cleared, κ=0 by data; F4 = throttle-only** |
| **F5** | taker / cross-venue economics | pending, low priority (maker-only desk) |

MASTER PLAN I (S1–S9): S1/S2 (leak table + the warehouse-drift framing) done; the rest folded into the F-chain.

---

## 5. Parked / off-mission (explicitly NOT now)

- **Directional / bias MM** — PARKED by #65 (flow doesn't lead price). The design docs
  [DIRECTIONAL_MM_STRATEGY](DIRECTIONAL_MM_STRATEGY.md) / [FAIR_VALUE_AND_THESIS_DESIGN](FAIR_VALUE_AND_THESIS_DESIGN.md)
  stand as reference; the standing κ-gate re-admits it **only if** a market ever shows a desk-wide flow lead.
- **The wealth desk** (archived `MASTER_PLAN_III_v2`) — mostly off the paper-only mission. Only
  **W9** (24/7 HIP-3 trend) + **W17** (cross-sectional alt momentum) + **EV1** (event/news feed) are
  schedulable; the rest is recorder-only or parked. Queued **behind** the MM profit chain.
- **The agentic layer** ([AGENTIC_HEDGE_FUND_DESIGN.md](AGENTIC_HEDGE_FUND_DESIGN.md)) — "each
  strategy manned by a quant agent" — the eventual destination, after the MM desk earns.
- **Capital allocator** across books/agents (risk-aware sizing vs even split) — the next big infra piece once we have winners.
- **Real capital / production / canary-live** — PARKED per the mission (CLAUDE.md §1/§7).
- **Stat-arb** (crypto killed by the cointegration cliff; equities ~0.06 Sharpe, survivorship-bound) — PARKED, kept only so deps don't break.
- **Residual-risk WPs** (archived `RESIDUAL_RISK_ROADMAP`): WP1 hedge-quality KPI shipped; **WP3**
  portfolio netting before hedge and **WP5** drift-aware quoting are the live refinements — fold into
  the concentrate phase if the hedge cost stays material.

---

## 6. Quant backlog (deferred, not perishable)

- Cross-venue delta-neutral **funding-carry** book (short HL perp / long Binance spot; XMR/majors persistent funding).
- Turn the n=1 γ/κ reads into a **distribution** across regimes (capture-once-sweep-many).
- More perp-DEX CLOBs for discovery (dYdX / Drift / Bybit / OKX).

---

## 7. Rules of engagement (binding every session)

1. **Realised-first.** Judge on desk realised ≥ 0 + per-book maxDD ≤ ~1.5%. Call out any book green only on unrealised.
2. **Honesty gates.** OOS / survivorship / cost / queue-aware fills. A market is kept only if it **earns**, not if it's liquid.
3. **Isolate one change per run** where possible; pre-register the success metric.
4. **Run-review method:** truth is the DB (`mm_nav` / `mm_book_state` / the leak table) — NEVER read the multi-MB run log whole (the `mm-run-review` skill).
5. **Git:** work in `/home/nexus/code/meridian-markets`; commit each phase; one PR per change set; `Co-Authored-By` trailer.
6. **Long / live runs are the operator's to launch** (the dev server doesn't run in-sandbox).

---

## 8. Doc map (where things live now)

- **This file** — the plan + priorities (single source of truth).
- **Logs:** [QUANT_JOURNAL.md](QUANT_JOURNAL.md) (chronological #NN entries) · [RESEARCH_FINDINGS.md](RESEARCH_FINDINGS.md) (citable verdicts) · [SESSION_HISTORY.md](SESSION_HISTORY.md).
- **Operate / read the desk:** [RUN_THE_DESK.md](RUN_THE_DESK.md) · [MM_TRADING_USER_GUIDE.md](MM_TRADING_USER_GUIDE.md) · [DESK_GLOSSARY.md](DESK_GLOSSARY.md) · [RUN_TRAINING_LOOP.md](RUN_TRAINING_LOOP.md).
- **Engine reference:** [MARKET_MAKING.md](MARKET_MAKING.md) · [HEDGING_MODEL.md](HEDGING_MODEL.md) · [PNL_ACCOUNTING.md](PNL_ACCOUNTING.md) · [FLOW_REACTIVE_QUOTING.md](FLOW_REACTIVE_QUOTING.md) · [DATA_SOURCES.md](DATA_SOURCES.md) · [UNIVERSE_DISCOVERY.md](UNIVERSE_DISCOVERY.md).
- **UI (role-scoped desk):** [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) (design contract — read before adding a role page) · [UI_ROLE_GUIDE.md](UI_ROLE_GUIDE.md) (operator's driver's manual).
- **[`docs/archive/`](archive/)** — superseded plans (the F-chain, ROADMAP, MASTER_PLAN_III, residual-risk roadmap+study, and the NEXT_SESSION*/PREREG/FOLLOWUP/briefing/prompt handoffs), kept for detail.
