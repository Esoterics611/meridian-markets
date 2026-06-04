# Next-session kickoff brief — the FAIR-VALUE engine (price, don't widen)

> Paste the **Kickoff prompt** at the bottom to start. A fresh session auto-loads `CLAUDE.md` + the memory index; this brief points at the rest. Work autonomously — **do not ask for approval**; verify with `tsc` + `jest`, commit each item on `master` (CLAUDE.md §0), then push one feature branch + PR. `npm run start:dev` exits 144 in the sandbox, so any live run is a hand-off to the operator.

---

## Where we are (2026-06-04 → 06-05)

- **Engine gaps closed (PR #11, on `master`):** stat-arb business-event tape, restart-safe stat-arb books, HL funding-carry universe discovery. 153 suites / 1019 tests.
- **The 6h MM harvest is done and it reframed the whole desk** ([QUANT_JOURNAL #27–#28](QUANT_JOURNAL.md)):
  - Naive spread MM **loses to adverse selection at every spread width** — proven with an inventory-clamped + widened sweep. `spread − adverse < 0` on every liquid coin. The only positive P&L term is inventory carry.
  - **Widening does not fix it** — adverse is a *fair-value* problem (stale-mid selection), not a width problem.
  - **Toxic coins cut** (NEAR,HYPE,WLD,LIT,ZEC,XPL,TON,VVV) by a regime-robust disqualifier rule; **KEEP** the liquid low-σ set (DOGE,BNB,ETH,SOL,XRP,ADA,SUI,+ENA/ONDO/PUMP, BTC benchmark). Baked into the capture/tune script defaults.
- **An 8h validation run is IN FLIGHT** (launched 2026-06-05 ~00:30, finishes ~08:30) — keep coins, wider 5bps floor + clamped 2-lot inventory + κ=0.5. Tapes: `docs/research/l2-tapes/hl-keep-20260605-*.json`; log: `docs/research/l2-tapes/capture-keep-20260605*.log`.
- **Two design specs written:** [DIRECTIONAL_MM_STRATEGY.md](DIRECTIONAL_MM_STRATEGY.md) (intentional inventory carry / the "axe") and **[FAIR_VALUE_AND_THESIS_DESIGN.md](FAIR_VALUE_AND_THESIS_DESIGN.md) (the next headline — the theo engine + Thesis Register).**

---

## ⏳ Priority 0 — harvest the 8h keep-coin run (perishable, offline)

When `hl-keep-20260605` has finished (~08:30; `ps aux | grep mm-l2-session` or just use the tapes):
1. Read the end-of-run replay in the capture log (the wide-5bps + clamped-2-lot result).
2. Compare disciplined vs full-carry: `DATE=20260605 LOTS=2 GAMMAS=0.0005,0.0025,0.01 KAPPAS=0.5,1 FLOORS=2,5,8,12,20 bash scripts/tune-hl-l2.sh` (clamped diagnostic) **and** `DATE=20260605 bash scripts/tune-hl-l2.sh` (full).
3. Record in `TUNED_PARAMS.md` + **QUANT_JOURNAL #29**: over 8h on the liquid set, is the disciplined maker **steadily** positive (real, low-DD) or does net→0 (confirming it was carry)? Either way it sets the baseline the fair-value engine must beat.

---

## 🎯 The headline — the FAIR-VALUE ("theo") engine

The whole project's edge is **quoting around a better price, not a wider spread** (#28). Build it incrementally, each layer measurable on the 20 saved tapes before any live risk. Spec + math + best-practice grounding: **[FAIR_VALUE_AND_THESIS_DESIGN.md](FAIR_VALUE_AND_THESIS_DESIGN.md)**.

- **F1 — Microprice quoter** (book-imbalance fair value, `μ = mid + (spread/2)·g(imbalance)`) as a new `IQuoter` + an extended `QuoteContext(μ,Σ)`; replay on the saved tapes. **The test:** does `spread − adverse` rise on the liquid coins vs the mid-quoter? (Re-run the #28 diagnostic.)
- **F2 — Binance→HL lead-lag** fair value (our structural edge: a faster/deeper lead venue we already pull via `BinancePublicClient`). Measure the HL-vs-Binance sub-minute lead; fold it into `μ`. **Likely the single biggest adverse-selection cut available — do F1+F2 first.**
- **F3+** — flow drift + confidence-scaled spread/size (Kalman), the **Thesis Register** (the house view, durable + P&L-graded → feeds the directional MM), the technical predictor (OOS-gated). See the doc's phase table.

---

## Kickoff prompt

```
GOAL (one session, autonomous — do NOT ask for approval; verify tsc+jest, commit each
item on master, then push ONE feature branch + open a PR):

FIRST read: docs/NEXT_SESSION.md (this file), docs/FAIR_VALUE_AND_THESIS_DESIGN.md (the
headline), docs/QUANT_JOURNAL.md (#27, #28, + the design note), docs/research/TUNED_PARAMS.md
(KEEP/CUT list), docs/DIRECTIONAL_MM_STRATEGY.md, and the memory index
([[project_mm_frontier_state]] + [[project_next_session_backlog]]).

PRIORITY 0 — harvest the 8h keep-coin run if it has finished (tapes
docs/research/l2-tapes/hl-keep-20260605-*.json): read its end-replay, run the clamped
vs full tune (commands in NEXT_SESSION.md), record TUNED_PARAMS + QUANT_JOURNAL #29.
Pure offline analysis. If still running, note ETA and proceed to F1.

THEN ship the FAIR-VALUE ENGINE, F1 first (the real unlock per #28):
  F1) MICROPRICE QUOTER — a new IQuoter that quotes around the book-imbalance micro-price
      μ = mid + (spread/2)·g(imbalance) (start g(I)=I), with an extended QuoteContext
      carrying μ (and Σ later). Register in MmStrategyRegistry; replay on the 20 saved
      tapes via the LobReplayHarness. PROVE IT: does spread−adverse rise on the liquid
      coins (BNB,DOGE,ETH,SOL,XRP,ADA,SUI) vs the mid quoter? (re-run the #28 clamped test.)
      b=0/μ=mid must reproduce today's quoter bit-for-bit (swap-seam default).
  F2) BINANCE→HL LEAD-LAG — measure the HL-vs-Binance return lead at sub-minute lags
      (we already pull both); fold the lead-corrected price into μ. Report its OOS IC +
      the further spread−adverse improvement. This is our structural edge — prioritise it.

CONSTRAINTS: paper-only; honesty is the whole game (each signal earns its weight by an OOS
IC before it moves a live quote; interpretable before ML); modular monolith (CLAUDE.md §6);
swap-seam discipline (§7); process.env only in app-config.factory.ts; append-only tables get
SELECT,INSERT only (mutable caches +UPDATE, no DELETE); verify tsc+jest; commit on master with
a Co-Authored-By trailer; hand any multi-hour live run to the operator. We price better, not
bet bigger. Proceed autonomously to the end.
```

---

## Backlog (after the fair-value engine has a foothold)

- **Directional / axed MM** ([DIRECTIONAL_MM_STRATEGY.md](DIRECTIONAL_MM_STRATEGY.md)) — intentional inventory carry; q*=bias·Qmax; the Thesis Register feeds it. Carry is the dominant P&L term → make it chosen alpha.
- **Funding-carry cross-venue live book** (short HL perp / long Binance spot) — the deployable form behind Entry #26.
- **γ/κ distribution** across regimes; **capital allocator** across MM + stat-arb books → the **agentic layer**.

## State at hand-off
- Tests 153 suites / 1019; tsc clean. PR #11 open (the 3 engine items). The MM-research docs (Journal #27–28, TUNED_PARAMS, the two design specs, script defaults) are committed on `master` after PR #11's branch point — fold them into the next PR or their own.
- Restart-safe books + business-event tapes now cover BOTH desks. The 8h run is the last MM datapoint before the fair-value engine; the engine is the path to a desk that earns steady, low-drawdown income on a short list of liquid coins, then scales venues.
