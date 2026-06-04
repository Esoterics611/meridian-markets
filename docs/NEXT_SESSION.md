# Next-session kickoff brief — harvest the L2 tune (#27), then the carry/MM frontier

> Paste the **Kickoff prompt** at the bottom to start. A fresh session auto-loads `CLAUDE.md` + the memory index; this brief points at everything else. Work autonomously — **do not ask for approval**; verify with `tsc` + `jest`, commit each item on `master` (CLAUDE.md §0), then push one feature branch + PR. `npm run start:dev` exits 144 in the sandbox, so any live run is a hand-off to the operator.

---

## Shipped 2026-06-04 (evening) — the gap-closing run (3 items, all on `master`, in PR)

Closed the **real remaining asymmetries** between the MM and stat-arb desks, plus a research-backlog item. Full detail in [SESSION_HISTORY.md §19](SESSION_HISTORY.md) + [QUANT_JOURNAL #26](QUANT_JOURNAL.md). Started 149 suites/993 tests → **153 suites / 1019 tests, tsc clean.**

1. **Stat-arb business-event tape (Telemetry P2 remainder)** — the shared `IDeskEventSink`/`DeskEventLog` is now wired into the stat-arb live loop. Every enter/exit (with realised round-trip P&L), risk-block and book/desk lifecycle emits a `DeskEvent` (`src/execution/live-desk-events.ts`) → a server **log line** + `GET /api/stat-arb/live/events` + a `/demo` **Desk-tab "Activity"** feed. `DeskEvent.desk` is now `'mm' | 'stat-arb'`; each desk owns its own `DeskEventLog`.
2. **Restart-safe stat-arb books** — `StatArbBookState` + `serializeState/restoreState` on `LivePaperTrader` (the stateful pairs strategy resumes its held regime via the new `LiveStrategy.restorePosition(side)`), `stat_arb_book_state` checkpoint table (migration 1722…) behind `IStatArbStateStore` (Null/Postgres), `LivePortfolioTrader` rehydrate-on-boot + checkpoint-per-tick + soft-close + shutdown flatten/checkpoint. Gated by `STAT_ARB_PERSIST` (default off). Scope = the **portfolio** desk.
3. **HL funding-carry universe discovery** — `src/market-data/funding/funding-carry-discovery.ts` + `scripts/hl-funding-discovery.ts` rank the whole HL universe by persistent, harvestable funding (net of the one-time round-trip fee, sign-stability + breakeven + liquidity gates). Real read: 23/49 harvestable, XMR +36%/yr, majors ~8% ([doc](FUNDING_CARRY_DISCOVERY.md)).

**Not done (handed off below):** the **L2-tune harvest** — the 20-perp/6h capture runs all session and finishes ~00:14, so its tune is **next session's Priority 0**.

---

## ⏳ Priority 0 next session — harvest the L2 capture (perishable, pure offline analysis)

The 20-perp / 6h / 10s real-WS L2 capture launched 2026-06-04 18:14 (tapes at `docs/research/l2-tapes/hl-discovery-20260604-<COIN>.json`, checkpointed every 10min, finishing ~00:14). 20 coins: BTC HYPE ETH ZEC SOL NEAR WLD XRP LIT TON ENA XPL VVV ONDO BNB SUI ADA DOGE PUMP ASTER.
1. Confirm it finished (`ps aux | grep mm-l2-session`; or just use the final checkpoints).
2. Tune: `DATE=20260604 bash scripts/tune-hl-l2.sh` (wide γ/κ/floor grid; tee's a `.txt`).
3. Record per-coin drawdown-compliant maker-net winners (at the −0.2bps rebate) in `docs/research/TUNED_PARAMS.md` + write **QUANT_JOURNAL Entry #27** with the numbers + honest caveats (fill counts, single window). Turns the n=1 BTC read (Entry #23) into a per-coin board across 20 markets.

---

## Kickoff prompt

```
GOAL (one session, autonomous — do NOT ask for approval; verify tsc+jest, commit each
item on master, then push ONE feature branch + open a PR):

FIRST read, in order: docs/NEXT_SESSION.md (this file — "Priority 0" + below),
docs/ROADMAP.md (Active + "Open quant backlog"), docs/SESSION_HISTORY.md §19,
docs/QUANT_JOURNAL.md (#23 + #26), docs/research/TUNED_PARAMS.md,
docs/research/hl-universe/RUNBOOK.md, docs/FUNDING_CARRY_DISCOVERY.md, and the memory
index (esp. [[project_mm_frontier_state]] + [[project_next_session_backlog]]).

PRIORITY 0 — harvest the L2 capture (perishable; do this FIRST). The 20-perp/6h/10s
real-WS L2 capture finished ~00:14 (tapes: docs/research/l2-tapes/hl-discovery-20260604-*.json).
  1. DATE=20260604 bash scripts/tune-hl-l2.sh   (wide γ/κ/floor grid; tees a .txt)
  2. Record per-coin drawdown-compliant maker-net winners (−0.2bps rebate) in
     docs/research/TUNED_PARAMS.md + write QUANT_JOURNAL Entry #27 with numbers +
     honest caveats (fill counts, single window). Pure offline analysis, no server.

THEN pick ONE and ship it end-to-end (tsc+jest green, commit on master, PR):
  A) FUNDING-CARRY CROSS-VENUE LIVE BOOK — the deployable form behind the discovery
     shipped this session: long Binance spot / short HL perp, delta-neutral, harvest
     the funding stream. Model the basis + real slippage; mirror the swap-seam
     discipline. (scripts/hl-funding-discovery.ts gives the watchlist; staticCarry +
     funding-carry-discovery.ts are the math.) Uncorrelated diversifier.
  B) γ/κ DISTRIBUTION HARNESS — generalise the single-tape tune into a cross-
     session/regime distribution: ingest several saved L2 tapes (the Priority-0 one
     is data point #1) → per-coin (γ,κ,floor) winners with a stability band.
  C) CAPITAL ALLOCATOR — the "next big piece": per-book/agent capital allocation
     across the MM + stat-arb desks (replace the even split with risk-aware sizing).
     The first real step toward the agentic layer.

CONSTRAINTS: paper-only; honesty is the whole game; modular monolith (CLAUDE.md §6);
swap-seam discipline (§7); process.env only in app-config.factory.ts; append-only
tables get SELECT,INSERT grants only (mutable caches get +UPDATE, no DELETE); verify
via `npx tsc --noEmit` + `npx jest`; commit on master with a Co-Authored-By trailer;
hand any multi-hour live run to the operator. Proceed autonomously to the end.
```

---

## State at hand-off (for context, not part of the prompt)

- **Tests:** 153 suites / 1019 tests, tsc clean. Branch + PR for this session's 3 items is open (see the PR link in the session output).
- **Restart-safe books** now cover BOTH desks (MM via `MM_PERSIST`, stat-arb via `STAT_ARB_PERSIST`) — the foundation for the multi-hour forward-paper track the demo needs.
- **Both desks have the live business-event tape** (MM `/api/market-making/events`, stat-arb `/api/stat-arb/live/events`) + `/demo` Activity feeds — the "see every trade in the log" requirement is met across the board.
- **The frontier** is now (a) the L2-tune distribution (Priority 0 + B), (b) the funding-carry live book (A), and (c) the capital allocator → agentic layer (C) — the pieces that turn a restart-safe multi-strategy system into an agent-run quant group.
