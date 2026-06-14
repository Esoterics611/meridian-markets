# SESSION PROMPT — Build the Book-Selection & Elevation Infrastructure (MM Master Plan Session D4, expanded)

Copy everything below the line into a fresh Claude Code session at the repo root.

---

## ROLE & GUARDRAILS
You are building research/selection infrastructure inside this repo. **Hard rules:** (1) Never touch, import into, or restart the live trading process or its config; all new code lives under `research/book_selection/` (create it) plus read-only consumers of existing capture data. (2) Read the repo's journals, tool conventions, and existing HL client code FIRST and reuse our client/auth/rate-limit patterns — do not write a second HL client. (3) Every module gets tests; every run writes a dated report to `research/book_selection/reports/`. (4) Public info endpoints only; no order placement anywhere in this codebase. (5) Where the spec below conflicts with what you find in the repo's journals, the journals win — note the conflict in your report.

## CONTEXT
We market-make 8 books on Hyperliquid (GLFT quoter, factor hedging, F3 toxicity rail). Book selection is currently a habit, not a model. You are building the model: a universe scanner, a scoring engine, a competitor-fingerprinting module, and an **elevation pipeline** that takes any asset (HL perp, HIP-3 perp, HL spot, or an external-venue market) through candidate → watch → paper → live-recommendation gates. Reference document: `BOOK_SELECTION_ANALYSIS.md` (the prior scores it produces are to be replaced by measured ones). The live $ model:

```
NetEdge($/day) = Volume × RealizedSpread(markout-adj) × AchievableShare
               − ToxicityCost − InventoryVolCost − HedgeabilityPenalty − MarginCost
               + StructuralAdders(growth-mode fees, maker rebate at our tier, 14d-tier volume value, points programs)
```

## MODULE 1 — Universe scanner (`scanner/`)
Pull and persist (parquet, daily snapshots + intraday where cheap) for EVERY market on HL:
- Perps: `meta`/`metaAndAssetCtxs` (incl. ALL HIP-3 deployer DEXs — enumerate deployers, do not assume the default DEX only), per-asset: mark, oracle, funding, predicted funding, OI, OI cap, day volume, leverage/margin tiers, growth-mode flag if exposed, deployer identity, oracle source.
- Spot: `spotMeta`/`spotMetaAndAssetCtxs`, incl. new-listing detection (diff vs yesterday's snapshot → emit NEW_LISTING event with timestamp).
- L2: `l2Book` sampled (rotating through universe within rate limits; full-depth snapshots for active candidates, sparse for the rest) → depth at 1/5/10/25bp, quoted spread, top-of-book sizes.
- Candles + funding history backfill for anything entering candidate status.
- External venues (phase 2 of this session, stub interfaces now): Lighter, Aster, Paradex, Pacifica public market endpoints — same normalized schema (`venue, market, class, volume, oi, spread, depth, fee_model, points_program_flag`).
Deliverable: `scanner/` with a scheduler entry, normalized DuckDB/parquet store `research/book_selection/data/`, and backfill scripts.

## MODULE 2 — Competitor fingerprinting (`competition/`)
From sampled L2 diffs per market (and trades feed where subscribed):
- Estimate the number of distinct persistent quoting participants: cluster resting-order behavior by (size quantum, tick offsets from mid, requote cadence, two-sidedness, pull-behavior on vol spikes). We cannot see account IDs in L2; cluster on behavioral signatures and report a confidence interval, not a false-precision count.
- Classify each cluster: {pro-MM, casual/grid-bot, deployer-affiliated, unknown} via cadence and reaction-time heuristics.
- Output per market: `n_pro_makers_est`, `top_maker_book_share`, `requote_speed_dist`, `weekend/closed-hours coverage` (do quotes vanish when the underlying closes? → our opportunity).
Validate the method first on our OWN books (we know our signature is in there — the clusterer must find us; that's the unit test).

## MODULE 3 — Scoring engine (`scoring/`)
Implement the NetEdge model with every component measured, not assumed:
- RealizedSpread: effective spread from trades-vs-mid, markout-adjusted at the horizon grid {1s, 5s, 30s, 60s, 300s} using passive-fill simulation against recorded L2 (reuse our queue-aware fill simulator — it exists in the repo; find it).
- AchievableShare: f(our intended size, depth profile, n_pro_makers_est, requote_speed_dist vs our latency budget). Document the functional form and its assumptions; sensitivity-test it.
- ToxicityCost: simulated markout cost per $ quoted from Module 1 data.
- InventoryVolCost: γσ²-based carry cost using our live quoter's γ convention (read it from config, don't hardcode).
- HedgeabilityPenalty: rolling R² and Kalman β stability to our factor set {BTC, ETH, and XYZ100 as the equity factor}; penalty = expected residual variance × our risk price. For RWA books also compute reference-feed availability (Pyth/CME mapping table — integrate the Tessera feed registry if importable, else stub a mapping file).
- MarginCost: margin tier × our funding cost of capital; respect per-HIP-3-DEX margin regimes and USDH-margined books (flag USDH exposure explicitly).
- StructuralAdders: our current fee tier (pull live), growth-mode discount per book, marginal 14d-tier value of the book's expected volume, and a manual `points_program` table for external venues.
Output: ranked table (all markets, all venues), component breakdown per market, confidence flags where data coverage is thin, and a diff vs `BOOK_SELECTION_ANALYSIS.md` priors with commentary on every rank change ≥5 places.

## MODULE 4 — Elevation pipeline (`elevation/`)
State machine per market: `UNIVERSE → CANDIDATE → WATCH → PAPER → LIVE_RECOMMENDED → (LIVE | REJECTED | RETIRED)` with persisted state, timestamps, and a journal entry per transition.
- → CANDIDATE: composite score above threshold OR event triggers (NEW_LISTING, post-vol-event spread persistence, deployer-migration events like the current Felix wind-down, new HIP-3 deployer market).
- → WATCH: automated checklist passes — deployer/oracle diligence (deployer identity, oracle source vs our reference, oracle-deviation history), OI-cap headroom, margin regime understood, hours-calendar assigned (24/7 vs underlying-hours with gap regime), USDH/collateral flags resolved.
- → PAPER: generate a quoter config from the per-class template (crypto-alt / metal / energy / equity-single / index / spot / exotic — templates per MM Master Plan Session E2; create template stubs if E2 isn't built yet) and run it through the shadow/paper harness (Session E3; if E3 isn't built, run replay-only and mark the gate provisional). Minimum 7 paper days.
- → LIVE_RECOMMENDED: paper KPIs clear thresholds (markout-adjusted capture > 0 at p25, ToxicityCost within model bounds, no oracle-sanity violations) AND the rotation rule fires: challenger NetEdge > worst incumbent × (1 + switching_margin), switching_margin default 25% to account for parameter re-fit, data history loss, and tier-volume continuity. Output is a RECOMMENDATION REPORT for human sign-off — this pipeline never touches live config.
- RETIREMENT: incumbents are scored weekly with everyone else; an incumbent below portfolio-median NetEdge for 3 consecutive weeks gets a retirement-review report.

## MODULE 5 — Weekly run & report (`reports/`)
One command (`make book-selection-weekly` or repo-convention equivalent) that: refreshes data, re-scores the universe, advances/regresses pipeline states, and emits `reports/YYYY-MM-DD_book_selection.md` containing: top-20 ranked table with component breakdown, incumbent-vs-challenger table, pipeline state changes, NEW_LISTING/deployer events this week, and a "what changed vs last week and why" narrative section.

## ACCEPTANCE CRITERIA
1. Scanner covers the full HL perp universe including ≥2 HIP-3 deployer DEXs and HL spot; data gaps are reported, not silent.
2. Clusterer finds our own quoting signature on our books (test).
3. Scoring runs end-to-end and reproduces a ranked list with per-component $ estimates; sensitivity analysis on AchievableShare included.
4. Elevation state machine persists across runs; the Felix wind-down and one NEW_LISTING (synthetic if none occurs) are processed as events in the test suite.
5. First weekly report generated against real data, including the diff vs the prior document's Sweet-16 with commentary.
6. Zero imports from this tree into the live trading process; CI/test guard that asserts it.

## ORDER OF WORK
Read journals + existing HL client and fill simulator → Module 1 (HL only) → Module 3 (with stub share model) → Module 2 → refine Module 3 share model with real fingerprints → Module 4 → Module 5 → external-venue scanner stubs last. Write the report as you go, including everything you found in the repo that this spec didn't know about.
