# Next-session kickoff — the validated BIAS SIGNAL → directional MM → trades

> Paste the **Kickoff prompt** below. A fresh session auto-loads `CLAUDE.md` + the memory index; this brief points at the rest. Work autonomously — verify `tsc` + `jest`, commit each phase on `master`, push one feature branch + PR. `npm run start:dev` exits 144 in the sandbox, so any live run is a hand-off to the operator.

---

## Where we are (proven, on `master` / PR #12)

The fair-value engine + the directional quoter are built and the edge is **measured, not asserted** (QUANT_JOURNAL #27–#33):

- **Naive spread MM loses** to adverse selection at every width (#28) — it's a fair-value problem, not a width problem.
- **F1 micro-price** quoting cuts adverse ~21% (#29). **F2 cross-venue is a no-op** — HL self-prices (#30). **F3** inconclusive at 18s (#31).
- **THE PROOF (#32):** at **sub-second cadence** the desk `spread − adverse` flipped **−$1,020 (18s) → +$133 (sub-second)** — a 7× swing, **positive on all 5 coins**; ETH/DOGE net-positive at low DD. **Cadence is the dominant lever; the spread business is now profitable.**
- **The only remaining loss is inventory CARRY** on trending coins. The **`mm-directional-glft`** quoter (#33) rests at a target inventory `q*=bias·maxLots` to *choose* the carry's sign (the dealer "axe") — but a **blind bias loses** (leverage on noise). **It needs a VALIDATED bias signal.** ← the next build.

Honest caveat carried forward: the sub-second flow was **88% estimated** (sparse WS prints/0.6s); the qualitative flip is robust, the exact number isn't gospel → a true-ms **WS-event capture** (§6b) is the parallel infra track.

---

## THE NEXT BUILD — `IBiasSource` (validated view → the directional quoter)

Turn carry from a leak into **chosen, validated alpha**. Phases (each measurable on the saved tapes before live; honesty rail: **a bias may size carry only after it passes an OOS forward-return IC**):

- **B1 — `IBiasSource` seam** (`bias(symbol, ctx) → number ∈ [−1,1]`): `NullBiasSource` (0 ⇒ neutral GLFT, default), `MomentumBiasSource` (daily micro-trend of the underlying), `FundingBiasSource` (weekly funding-regime — reuse `funding-carry-discovery`: lean toward the funding-*paid* side), `ManualBiasSource` (the house-view override). Feed `q*` per tick.
- **B2 — the OOS gate** (`scripts/mm-bias-validate.ts`): for each signal, measure its **forward-return IC** on the saved tapes / history (purged k-fold, the existing gates). Only signals with a positive, stable OOS IC are allowed to size carry. Output: per-coin per-signal IC + a verdict.
- **B3 — `scripts/mm-directional-sweep.ts`**: replay `mm-directional-glft` at the **validated** bias per coin on the saved fine tapes; report carry-vs-bias curves + that the validated bias **beats neutral AND beats blind bias** (the #33 demo showed blind bias loses; this proves a *good* bias wins). The honest verdict on directional MM.
- **B4 — the Thesis Register** (`docs/DIRECTIONAL_MM_STRATEGY.md` §4 / `FAIR_VALUE_AND_THESIS_DESIGN.md` §4): durable house-view table (asset, direction, conviction, horizon, invalidation, P&L-graded), feeding the long-term bias + a `/demo` panel. The research→quotes→accountability loop.
- **B5 — wire it live**: the directional quoter + bias source in the live `MmBook`/`MmPortfolioTrader`; a **directional stop** in `CompositeRiskGate`; surface the directional-carry equity curve; run forward paper and watch the Activity feed.

Parallel track (the other headline): **true-ms WS-event capture** (HL `l2Book` + trades WS, optionally Binance depth WS) → ms tapes with **real** flow (kills the 88%-estimate caveat) + realistic cancel/replace latency. See `FAIR_VALUE_AND_THESIS_DESIGN.md` §6b.

---

## END-TO-END RUNBOOK — from data → validated bias → directional MM → trades

The whole pipeline, in order. (Offline analysis runs in this sandbox; the live paper desk is an operator hand-off — `start:dev` exits 144 here.)

### 1. CAPTURE real market data (fine cadence)
```bash
# Sub-second, best coins, full stack baked into the end-replay (single killable process):
DAY=$(date +%Y%m%d)
MM_L2_COINS=BTC,ETH,SOL,BNB,DOGE MM_L2_POLL_S=0.2 MM_L2_DURATION_MIN=480 \
MM_L2_MICRO_DEPTH=5 MM_L2_F3=true MM_L2_GAMMA=0.0025 MM_L2_KAPPA=0.5 MM_L2_MIN_BPS=5 MM_L2_MAX_LOTS=2 \
MM_L2_TRADES_WS=true MM_L2_FUNDING=true MM_L2_CHECKPOINT_MIN=10 \
MM_L2_SAVE_TAPE=docs/research/l2-tapes/hl-fine-$DAY \
  nohup node -r ts-node/register -r tsconfig-paths/register scripts/mm-l2-session.ts \
  > docs/research/l2-tapes/capture-fine-$DAY.log 2>&1 & echo $! > /tmp/fine-run.pid
# watch:  tail -f docs/research/l2-tapes/capture-fine-$DAY.log     stop: kill $(cat /tmp/fine-run.pid)
```

### 2. FAIR VALUE + cadence — prove the spread edge (F1)
```bash
P=docs/research/l2-tapes/hl-fine-$DAY; C=BTC,ETH,SOL,BNB,DOGE
MM_TUNE_TAPE_PREFIX=$P MM_TUNE_COINS=$C MICRO_DEPTH=5 GAMMA=0.0025 KAPPA=0.5 FLOOR=5 MAX_LOTS=2 \
  npx ts-node -r tsconfig-paths/register scripts/mm-microprice-compare.ts   # spread−adverse mid vs micro
```

### 3. BIAS SIGNAL — measure it, then VALIDATE it (B1–B2, to build)
```bash
# which way is each coin's persistent funding paying? (an input to the weekly bias)
FCD_TOP=80 npx ts-node -r tsconfig-paths/register scripts/hl-funding-discovery.ts
# OOS-validate every bias signal's forward-return IC — ONLY positive-IC signals may size carry:
MM_TUNE_TAPE_PREFIX=$P MM_TUNE_COINS=$C \
  npx ts-node -r tsconfig-paths/register scripts/mm-bias-validate.ts        # (B2 — to build)
```

### 4. DIRECTIONAL MM — prove the validated bias beats neutral (B3, to build)
```bash
# carry-vs-bias per coin at the VALIDATED bias; must beat neutral (bias=0) AND blind bias:
MM_TUNE_TAPE_PREFIX=$P MM_TUNE_COINS=$C MICRO_DEPTH=5 GAMMA=0.0025 KAPPA=0.5 FLOOR=5 MAX_LOTS=2 \
  npx ts-node -r tsconfig-paths/register scripts/mm-directional-sweep.ts    # (B3 — to build)
# (today, blind bias on one window: STRATEGY=mm-directional-glft BIAS=0.5 in mm-microprice-compare.ts)
```

### 5. TRADES — run the live paper desk (operator hand-off; finest honest demo)
```bash
# boot the engine on REAL data in paper mode (operator's box — start:dev exits 144 in the sandbox):
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
MM_PERSIST=true STAT_ARB_PERSIST=true TELEMETRY_ENABLED=true \
  npm run start:dev
# then launch a DIRECTIONAL MM book via the control plane (the quoter + the validated bias):
curl -s localhost:3100/api/market-making/launch -H 'content-type: application/json' -d '{
  "symbol":"DOGE","source":"hyperliquid","strategyId":"mm-directional-glft",
  "capitalUsdc":1000000,"params":{"gamma":0.0025,"kappa":0.5,"bias":0.4}
}'
# WATCH THE TRADES (every enter/exit + the directional carry, live):
#   • server log lines (the business-event tape)        • /demo → Market Making → "Activity — live trade tape"
#   • GET /api/market-making/events?since=<seq>          • GET /api/market-making/nav  (durable equity curve)
```

> The honesty discipline runs through all five steps: fair value (not a wider spread), fine cadence (re-quote fast), a bias only after an OOS IC, a drawdown budget (2%), and every fill on the business-event tape. **We price better, and we bet only on a validated view.**

---

## Kickoff prompt

```
GOAL (one session, autonomous — verify tsc+jest, commit each phase on master, push one PR):

FIRST read: docs/NEXT_SESSION.md (this file — the runbook + phases), docs/QUANT_JOURNAL.md
(#28, #32, #33), docs/DIRECTIONAL_MM_STRATEGY.md, docs/FAIR_VALUE_AND_THESIS_DESIGN.md
(§4 Thesis Register, §6b ms-capture), docs/FUNDING_CARRY_DISCOVERY.md, and the memory index
([[project_mm_frontier_state]], [[feedback_business_event_logging]]).

BUILD the validated BIAS SIGNAL → directional MM pipeline (turn carry from leak to chosen alpha):
  B1) IBiasSource seam (bias(symbol,ctx)→[-1,1]): NullBiasSource (default, ≡ neutral GLFT),
      MomentumBiasSource, FundingBiasSource (reuse funding-carry-discovery — lean to the
      funding-PAID side), ManualBiasSource. Feed q* into mm-directional-glft per tick.
  B2) scripts/mm-bias-validate.ts — each signal's OOS forward-return IC on the saved tapes
      (purged k-fold). HONESTY RAIL: a bias may size carry ONLY with a positive, stable OOS IC.
  B3) scripts/mm-directional-sweep.ts — replay mm-directional-glft at the VALIDATED bias on the
      fine tapes; prove it beats neutral (bias=0) AND beats blind bias (#33 showed blind loses).
  B4) the Thesis Register (durable house view, P&L-graded) feeding the long-term bias + /demo panel.
  B5) wire live: directional quoter + bias source in MmBook/MmPortfolioTrader; a directional stop
      in CompositeRiskGate; surface the directional-carry equity curve; forward paper + Activity feed.
  (Parallel headline if time: true-ms WS-event capture — §6b — for real, non-estimated flow.)

CONSTRAINTS: paper-only; honesty is the whole game (no bias live without an OOS IC; interpretable
before ML); modular monolith (§6); swap-seam discipline (§7); process.env only in app-config.factory.ts;
append-only tables SELECT,INSERT only (mutable caches +UPDATE, no DELETE); verify tsc+jest; commit each
phase on master with a Co-Authored-By trailer; hand any multi-hour live run to the operator. The arc:
fair value + cadence made the SPREAD edge real; the validated bias makes the CARRY chosen alpha. GO.
```

## State at hand-off
- 155 suites / 1037 tests, tsc clean. PR #12 open (fair-value engine F1/F2/F3 + directional quoter + research).
- The directional quoter (`mm-directional-glft`) is live in the registry; it just needs the validated signal (B1–B3) to be more than a bet.
- Tapes: `docs/research/l2-tapes/hl-fine-20260605-*.json` (8h sub-second, the proof window).
