# Next-session kickoff brief — harvest the L2 tune, then a backlog item

> Paste the **Kickoff prompt** below to start. A fresh session auto-loads `CLAUDE.md` + the memory index; this brief points at everything else. Work autonomously — **do not ask for approval**; verify with `tsc` + `jest`, commit each phase on `master` (CLAUDE.md §0). `npm run start:dev` exits 144 in the sandbox, so any live run is a hand-off to the operator.

---

## 🔴 LIVE SESSION LOG — 2026-06-04 (evening), gap-closing run (UPDATE AS YOU GO)

Goal this session: close the **real remaining gaps + pushed-off items** one by one, leaving every step committed so a credit-out is safe. Doc reorg was done **manually by the operator** (accepted as done — committed as the "archive completed plan docs" commit). Priority order chosen: stat-arb event tape → stat-arb persistence → a research backlog item → harvest L2.

**DONE ✅ — (1) Stat-arb business-event tape (Telemetry P2 remainder).** The flagged gap ([[feedback_business_event_logging]]): MM logged every fill, stat-arb logged only lifecycle. Now closed end-to-end, 3 commits on master:
- *Phase A* — generalised `DeskEvent.desk` → `'mm' | 'stat-arb'`; new `src/execution/live-desk-events.ts` (pair-shaped OPEN/CLOSE/block/lifecycle builders reusing the shared `DeskEventInput`); wired `IDeskEventSink` (NULL default) into `LivePaperTrader` — emits on open / blocked-open / close / start / stop / reconfigure. Specs: `live-desk-events.spec.ts` + new cases in `live-paper-trader.spec.ts`.
- *Phase B* — `LivePortfolioTrader` emits launch/remove/desk-start/stop; `StatArbModule` provides its **own** `DeskEventLog` (separate instance from MM; the module does NOT import MarketMakingModule) injected into the single trader, every portfolio sub-book, and the portfolio; `GET /api/stat-arb/live/events` on `LiveController` (seq-cursor long-poll, `@Optional`). Specs: `live.controller.spec.ts` + portfolio emit test.
- *Phase C* — `/demo` Desk tab "Activity — live trade tape" feed polling the new endpoint (OPEN=teal, CLOSE=amber, block=red), JS syntax-checked.
- Verify: **151 suites / 1002 tests, tsc clean** (was 149/993). Honest note: stat-arb fills carry no BUY/SELL `side` (pair trade) so the feed colours by `action`; the durable ledger is still `stat_arb_trades` — this tape is the live "what just happened", same as MM.

**IN PROGRESS 🟡 — (2) Stat-arb live persistence (restart-safe books).** See task list + below. Mirror the MM persistence arc (Phase 1 serialize/restore → Phase 2 `stat_arb_book_state` migration + repo behind `IStatArbStateStore` Postgres/Null → Phase 3 rehydrate-on-boot + checkpoint-per-tick + soft-close). Default off ⇒ no-DB/tests unchanged.

**REMAINING this session:** (3) one research backlog item (funding-carry basket OR γ/κ distribution), (4) harvest the L2 tune once the 20-perp/6h capture finishes (~00:14 — runs all session; tapes at `docs/research/l2-tapes/hl-discovery-20260604-*.json`, `DATE=20260604 bash scripts/tune-hl-l2.sh`).

---

---

## Shipped 2026-06-04 (this session) — the business-event tape + Activity feed (Telemetry P2)

The operator's gap: *"I need to see every trade enter/exit in the log, not just DB transactions — I thought we had this."* We had metrics (P1) + durable NAV (P3) but **no per-trade business log**. Now shipped (`src/market-making/events/`):
- **`DeskEvent` + `DeskEventLog`** — every fill (enter = open/add, exit = reduce/close/flip, with the realised P&L), every risk-verdict change (Allow⇄Pause⇄Deny, on transition only), and every book launch/remove/start/stop is emitted **once** from the place it happens (`MmBook`/`MmPortfolioTrader`) and rendered **twice**: a server **log line** + a bounded ring buffer.
- **`GET /api/market-making/events?since=<seq>&limit=&book=`** — seq-cursor long-poll (never miss/double-count).
- **`/demo` → Market Making → "Activity — live trade tape"** — newest-first feed, colored by kind; polls every 4s.
- No-op sink default ⇒ unit tests unchanged. **149 suites / 993 tests, tsc clean.** Code is committed on `master`; PR `ship/mm-business-event-tape`.
- **Honest remainder (P2):** the tape is **MM-specific**. The stat-arb `LivePaperTrader` still logs only lifecycle (start/stop/reconfigure), not per-trade — extending the same `IDeskEventSink` to it (+ a generic structured-JSON log seam) is the P2 remainder. Multi-market scale-up (the operator's "run continuously on a lot of markets") is the forward-paper track that now has a live feed to watch.

---

## Kickoff prompt

```
GOAL (one session, autonomous — do NOT ask for approval):

FIRST read, in order: docs/ROADMAP.md ("Open quant backlog" + "Housekeeping" + the
Telemetry P2 line), docs/OPERATIONS_MANUAL.md (the 3 systems + storage map),
docs/research/TUNED_PARAMS.md, docs/research/hl-universe/RUNBOOK.md,
docs/QUANT_JOURNAL.md (Entries #23–#25), and the memory index (esp.
[[project_next_session_backlog]] + [[project_mm_frontier_state]]).

PRIORITY 0 — harvest the L2 capture (perishable; do this first).
A 20-perp / 6h / 10s real-WS L2 capture was launched 2026-06-04 18:14 (tapes at
docs/research/l2-tapes/hl-discovery-20260604-<COIN>.json, checkpointed every 10min,
finishing ~00:14). 20 coins captured: BTC HYPE ETH ZEC SOL NEAR WLD XRP LIT TON ENA
XPL VVV ONDO BNB SUI ADA DOGE PUMP ASTER.
  1. Confirm the run finished (ps aux | grep mm-l2-session; or just use the checkpoints).
  2. Tune it:  DATE=20260604 bash scripts/tune-hl-l2.sh   (wide γ/κ/floor grid; tee's a .txt)
  3. Record the per-coin winners (drawdown-compliant maker-net at the −0.2bps rebate) in
     docs/research/TUNED_PARAMS.md + write QUANT_JOURNAL Entry #26 with the numbers +
     honest caveats (fill counts, single window). BTC's n=1 read (Entry #23) becomes a
     per-coin board across 20 markets.
This is analysis + doc work — fully in-session (no live server needed).

THEN pick ONE and ship it end-to-end (tsc+jest green, phases on master, then a PR):

  A) FUNDING-CARRY BASKET ON HL — which HL perps pay persistent, harvestable funding
     across the universe; price the carry leg + the cross-venue delta-neutral form
     (short HL perp / long Binance spot). Tooling: scripts/funding-carry-research.ts
     (FC_SOURCE=hyperliquid), src/market-data/funding/funding-carry.ts (staticCarry),
     HyperliquidFundingClient.fundingHistory. Mirror the hl-universe-discovery
     module+script+spec triple. Uncorrelated diversifier.

  B) γ/κ DISTRIBUTION — generalise the single-tape tune into a cross-session/regime
     distribution: a harness that ingests several saved tapes (the Priority-0 one is
     data point #1) and reports per-coin (γ,κ,floor) winners with a stability band.

  C) EXTEND THE BUSINESS-EVENT TAPE (the Telemetry P2 remainder) — wire the same
     IDeskEventSink into the stat-arb LivePaperTrader so its entries/exits also log +
     feed; optionally a generic structured-JSON log transport. Small, high-value for
     the "run continuously on many markets" goal — the feed exists, extend its reach.

  D) HOUSEKEEPING (good when credits are low) — trim docs + dead code; the dormant
     legacy treasury/yield module (CLAUDE.md §5) IF confirmed unused (grep imports
     first). Trim redundancy, NOT the honest-findings trail or git history.

CONSTRAINTS: paper-only; honesty is the whole game; modular monolith (CLAUDE.md §6);
swap-seam discipline (§7); process.env only in app-config.factory.ts; append-only tables
get SELECT,INSERT grants only; verify via `npx tsc --noEmit` + `npx jest`; commit phases on
master with a Co-Authored-By trailer; hand any multi-hour live run to the operator.
Proceed autonomously to the end of the session.
```

---

## Why this order (context for me, not part of the prompt)

The Priority-0 tune harvest is **perishable + high-value**: the operator captured a real 20-perp / 6h L2 tape (Entry #25), and the point was to turn the n=1 BTC read (Entry #23) into a per-coin maker-net board. Pure analysis (no live server) ⇒ a clean in-session win producing a real artifact (TUNED_PARAMS.md + a journal entry).

After that, the backlog items are the genuinely-deferred directions the operator flagged ([[project_next_session_backlog]]): **funding-carry**, the **γ/κ distribution**, the **business-event tape extension** (now that MM has it, stat-arb is the gap), and the **doc/code trim**. Each is self-contained and offline-verifiable with a pattern to mirror.
