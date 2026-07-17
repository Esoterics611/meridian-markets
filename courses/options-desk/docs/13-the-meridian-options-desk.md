# 13 · The Meridian options desk — the build map

## What it is

The previous twelve chapters are the training program; this one is the desk they train you to run. The Meridian **Long-Horizon Options Desk (LHO)** — full plan in [`docs/OPTIONS_DESK.md`](https://github.com/) in the repo — is the third desk of the paper-trading demonstration, next to the funding-carry desk and the (benchmark-status) MM desk. Its defining property, worth stating before any file paths: **almost everything hard was already built and validated for other desks.** The pricing engine, the venue client, the persistence spine, the event tape, the stress harness, the allocator, the calibration doctrine — all exist. The desk is assembled, not invented; the genuinely new work is one data collector, one position model, and seven thin books. This chapter maps chapters → books → code, in build order.

## What already exists (and what it was validated against)

| Layer | Where | Validation status |
|---|---|---|
| Pricing/Greeks (`IOptionPricer`, `blackScholes`) | `src/derivatives/greeks/` | **line-by-line vs Deribit** (journal #12) — §2 of this course |
| Option chain + tickers | `src/derivatives/deribit/deribit-client.ts` | live; feeds the #12/#42 measurements |
| The VRP measurement | journal #12, #42 | +5.9/+3.7 pts; 86.3% of 117 windows — §3 |
| VRP book v0 (gated daily straddle, band hedge, hard stop) | `src/derivatives/vrp/vrp-book.ts` | built + live-smoked; held out honestly all night in #96 |
| Market-data plant (bus, Deribit vertical, tapes) | `src/bus/`, `src/market-data/plant/` | Phase A live (#98) — the surface collector's substrate |
| Calibration scoring (Brier; scored-paper pattern) | `src/prediction/calibration-score.ts`, `orv-calibration.ts` | the #96 doctrine — §12.5 |
| Stress harness pattern | P11 (Take Sides build) | reused as §11's grid |
| Persistence, tear-sheets, DeskEvents, launchers, allocator | `mm_nav`, events tape, `launch-*.sh`, `carry-allocator.ts` | running for the carry desk today |

Read that table the way the desk reads it: the risk of this build is not technical. It is the same risk PROFIT_PIVOT_II R10 named — *building instead of accruing* — which is why the phases below are gated on tape-days and scored cycles, not on code completeness, and why Phase O-0 is designed to run **in the background of the carry desk's runs**, never competing for its hours.

## The new pieces (the O-E chain)

- **O-E1 — the surface tape** (`iv-surface-collector`): hourly rows of ATM IV per tenor {7, 14, 30, 90d} + 25Δ/10Δ wing IVs + **quoted spreads** + EWMA-RV, per underlying, via the md-plant Deribit vertical. §7's `SurfaceTapeRow` is its schema. Every trigger in §4–§8 reads this tape; recording *quoted spreads* is what keeps every cost claim in this course honest.
- **O-E2 — the EWMA-RV estimator + spec** (§3's code shape): the #96 fix, shared by every gate. Ships with the spec that makes the window-edge artifact unrepeatable.
- **O-E3 — `MultiLegBook`**: one position model for all seven books — legs, collateral form, marks through `IOptionPricer` at live chain IV, assignment/settlement, DeskEvents on every transition. Generalizes `VrpBook`; the wheel's state machine (§4), the collar's cycle report (§5), and the vertical (§8) are thin types over it.
- **O-E4 — the scored-paper harness**: §12's `ScoredCycle` logger + capture scorer + `promotionVerdict` — the `orv-calibration.ts` pattern pointed at option cycles.
- **O-E5 — the stress grid** (§11's `stressAdmits`): a pure module consulted by every entry, crediting the long wings.
- **O-E6 — the books**: O1 wheel (§4) · O2 collar (§5) · O3 ladder (§6) · O4 calendar (§7) · O5 skew verticals (§8) · O6 tail budget (§9) · O7 synthetic core (§10).
- **O-E7 — the desk runner + launcher**: `options-desk-live.ts`, `desk='options'` NAV namespace, the supervised-launcher pattern.

## The phases (each blocked on evidence, not enthusiasm)

| Phase | Ships | Pre-registered gate to proceed |
|---|---|---|
| **O-0** | surface tape + EWMA spec (no capital) | ≥ 14 days continuous tape (≥ 30 for z-score books) — *the only phase that can start today* |
| **O-1** | MultiLegBook + stress grid + **O3 ladder** on scored-paper | ≥ 60% positive scored cycles per rung over 14 cycles → token capital |
| **O-2** | **O1 wheel + O2 collar** at token size, **O6 overlay** on | wheel capture ≥ 55%; collar floor-check clean; O6 within budget |
| **O-3** | **O4 calendar + O5 skew** | measured distributions clear tape costs *before any trade* (§12.2) |
| **O-4** | **O7 synthetic** + LHO as the allocator's fourth sleeve | O7's inequality > 0 over 2 scored roll cycles |

A failed gate halts its chain (the operating rule the whole repo runs on). The books' pre-registered metrics are in `OPTIONS_DESK.md` §2 and are quoted in each strategy chapter here — course and desk plan cite each other on purpose, so neither can drift without the drift being visible.

## Explicitly not building (and the reason each temptation is refused)

- **An American/exotics pricer** — Deribit BTC/ETH options are European; BS at chain IV is *correct*, not approximate. Complexity without a consumer.
- **A parametric surface model (SVI/SABR)** — the desk trades quoted strikes at quoted vols; it never needs to interpolate an exotic strike. A fitted surface would add model risk to remove a problem the desk doesn't have.
- **Intraday options market-making** — a different business (the MM course's), with a settled verdict on this venue class.
- **Equity options** — no wired data source; a researcher item if the demo ever wants it. The interfaces (§2) are underlying-agnostic by construction, so the seam is already there.
- **Any book without its gate** — the R10 lesson, permanently: run the validated thing; build only what the running thing needs.

## How the demo tells this story (the operator's view)

The LHO desk's contribution to the paper demonstration is *shape*, not headline: a collared core whose floor is checkable arithmetic (§5), income sleeves whose worst month was pre-computed (§11), an insurance line whose cost is printed every cycle (§9), and a validation trail (§12) where every promotion decision cites its pre-registered bar. On the `/demo` surface it gets what every desk gets — the NAV curve (`desk='options'`), the event tape, the tear-sheet — plus the two lines no other desk has: **the stress grid's worst cell next to realized DD**, and **premium capture next to P&L**. When the numbers are modest, the desk says modest; the entire wager of the mission is that an honest 6% with a provable floor demonstrates more than a flattering 60% ever could.

## Where to go from here

You have the theory (§2–§3), the books (§4–§10), the desk layer (§11), and the epistemics (§12). The working order for a new operator: read `OPTIONS_DESK.md` end-to-end (it is short — the depth lives here), start the O-0 collector, and spend the 14 tape-days working §4 and §6's examples against the live chain by hand — by the time the tape qualifies, the gates' behavior will be intuition rather than configuration. Then let the phases and their gates do what they were designed to do: make the desk earn its way into existence one pre-registered verdict at a time.

## Sources

- `docs/OPTIONS_DESK.md` — the desk plan this chapter compresses; `docs/PROFIT_PIVOT_II.md` — the parent plan and its lessons (R6, R7, R9, R10) that shaped every gate above.
- Journal #12, #42, #96, #98 — the measurements and infrastructure milestones the desk stands on.
- The other two courses — [market making](../../market-making/docs/index.md) ch. 8 (the desk-stack chapter this one mirrors) and [stat-arb](../../stat-arb/docs/index.md) ch. 6 (the honest-backtesting culture §12 extends to slow strategies).
