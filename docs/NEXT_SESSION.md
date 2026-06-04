# Next-session kickoff brief — harvest the L2 tune, then a backlog item

> Paste the **Kickoff prompt** below to start. A fresh session auto-loads `CLAUDE.md` + the memory index; this brief points at everything else. Work autonomously — **do not ask for approval**; verify with `tsc` + `jest`, commit each phase on `master` (CLAUDE.md §0). `npm run start:dev` exits 144 in the sandbox, so any live run is a hand-off to the operator.

---

## Kickoff prompt

```
GOAL (one session, autonomous — do NOT ask for approval):

FIRST read, in order: docs/ROADMAP.md ("Open quant backlog" + "Housekeeping"),
docs/OPERATIONS_MANUAL.md (the 3 systems + storage map), docs/research/TUNED_PARAMS.md,
docs/research/hl-universe/RUNBOOK.md, docs/QUANT_JOURNAL.md (Entries #23–#25), and the
memory index (esp. [[project_next_session_backlog]] + [[project_mm_frontier_state]]).

PRIORITY 0 — harvest the in-flight L2 capture (do this first; it's perishable data).
A 20-perp / 6h / 10s real-WS L2 capture was kicked off 2026-06-04 (tapes at
docs/research/l2-tapes/hl-discovery-20260604-<COIN>.json, checkpointed every 10min).
  1. Tune it:  DATE=20260604 bash scripts/tune-hl-l2.sh   (wide γ/κ/floor grid; tee's a .txt)
  2. Record the per-coin winners (drawdown-compliant maker-net at the −0.2bps rebate) in
     docs/research/TUNED_PARAMS.md — this is the deliverable: BTC's n=1 read (Entry #23)
     becomes a per-coin board across 20 markets. Write a QUANT_JOURNAL Entry #26 with the
     numbers + the honest caveats (fill counts, single window).
  3. If the tapes are missing/empty (run died), re-run `bash scripts/capture-hl-l2.sh` and
     note it as a hand-off (multi-hour, the operator runs it).
This is analysis + doc work — fully doable in-session (no live server needed).

THEN pick ONE backlog item (all in ROADMAP "Open quant backlog"/§"Housekeeping" +
[[project_next_session_backlog]]) and ship it end-to-end with tsc+jest green, phases
committed on master, then a PR (CLAUDE.md §0):

  A) FUNDING-CARRY BASKET ON HL — which HL perps pay persistent, harvestable funding
     across the universe over N days; price the carry leg + the cross-venue delta-neutral
     form (short HL perp / long Binance spot). Tooling exists: scripts/funding-carry-research.ts
     (FC_SOURCE=hyperliquid), src/market-data/funding/funding-carry.ts (staticCarry),
     HyperliquidFundingClient.fundingHistory. Build a DB-free basket scan + honest verdict
     (mirror the hl-universe-discovery pure-module + script + spec shape). Uncorrelated
     diversifier to MM + stat-arb.

  B) γ/κ DISTRIBUTION — generalise the single-tape tune into a cross-session/regime
     distribution: a small harness that ingests several saved tapes (the Priority-0 one is
     data point #1) and reports per-coin (γ,κ,floor) winners with a stability/confidence band,
     not one window. Turns "directional" into "deployable-or-not". (Mostly a tune aggregator +
     spec; live captures are operator hand-offs.)

  C) HOUSEKEEPING (good when credits are low) — trim docs + dead code for repo size:
     consolidate/retire stale sections (QUANT_JOURNAL is ~1300 lines), and drop the dormant
     legacy treasury/yield module (CLAUDE.md §5) IF confirmed unused (grep for imports first;
     keep the migration + §3/§4 unless fully removing). Trim redundancy, NOT the honest-findings
     trail or git history. Mechanical, low-risk.

  (Bigger pieces, only if you want a multi-session thread: stat-arb live persistence — extend
  restart-safe books to stat-arb; then the capital allocator + the agentic layer (ROADMAP).)

CONSTRAINTS: paper-only; honesty is the whole game; modular monolith (CLAUDE.md §6);
swap-seam discipline (§7); process.env only in app-config.factory.ts; append-only tables
get SELECT,INSERT grants only; verify via `npx tsc --noEmit` + `npx jest`; commit phases on
master with a Co-Authored-By trailer; hand any multi-hour live run to the operator.
Proceed autonomously to the end of the session.
```

---

## Why this order (context for me, not part of the prompt)

The Priority-0 tune harvest is **perishable + high-value**: the operator captured a real 20-perp / 6h L2 tape (the first broad, high-fidelity flow capture — Entry #25), and the whole point was to turn the n=1 BTC read (Entry #23) into a per-coin maker-net board. It's pure analysis (no live server), so it's a clean in-session win that produces a real research artifact (TUNED_PARAMS.md + a journal entry).

After that, the backlog items are the genuinely-deferred quant directions the operator flagged as important ([[project_next_session_backlog]]): **funding-carry** (the next uncorrelated strategy + the deployable delta-neutral form), the **γ/κ distribution** (hardening the MM read), and the **doc/code trim** (repo hygiene as the system grows). Each is self-contained and offline-verifiable with a pattern to mirror (the hl-universe-discovery module/script/spec triple is the template for A).
