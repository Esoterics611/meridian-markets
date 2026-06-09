# Next-session handoff (written 2026-06-09, end of Journal #45)

Branch `feat/mm-desk-diagnostics-and-guide`, all committed, tree clean (bar untracked
`docs/research/flow-shadow-*.jsonl` run captures — leave them). Two jobs, in order: **(A) the UI
review** (the explicit ask), then **(B) run + review Run A′** and keep chasing the edge. Don't re-read
the whole repo — the pointers are below.

## Context: what Journal #45 just changed (read `tail -n 80 docs/QUANT_JOURNAL.md` for detail)
The session wired the four "make money" pillars end-to-end so the next run can finally be judged on
**realised** P&L, with nothing silently off:
1. **Hedge on the fast cadence** (DR-4) — `L2PollDriver.afterCycle` → `MmPortfolioTrader.hedgeTick()`.
2. **Hedge cost priced into the maker spread** — `ctx.hedgeCostBps` additive in `buildQuotePair`,
   scaled by `MM_HEDGE_COST_SPREAD_MULT` (default 0.5 = the fill-rate-vs-cost lever).
3. **F3 toxicity instrumented** (DR-3) — `metrics().toxicity` → `MmBookSnapshot.toxicity` → grep-able
   `F3 toxicity:` log line.
4. **OOS hedge β-map** — `scripts/hedge-beta-fit.ts`, baked into `start-desk.sh`.
Plus: `start-desk.sh` now = canonical Run A′ (all four ON); the `/demo` MM view gained a delta-hedge
panel + per-book F3 line; Run A′ re-registered with a realised-≥0 gate; `docs/RUN_TRAINING_LOOP.md`
defines the run→train→re-fit loop.

---

## JOB A — the UI review (do this first; it's the specific ask)

**Goal (Ronnie's words):** the `/demo` desk pages must (1) reflect today's drastic rewrites correctly,
(2) **show only real, active stuff** (no dead/legacy/never-populated fields), and (3) use **intuitive
green/red — green = it's working FOR US, red = against us** — researched against how professional
trading systems colour these (a maker-rebate fee that's revenue should NOT read red just because it's a
"fee"; an open short that's winning should read green; adverse selection should read red; etc.).

**Scope / files (don't boil the ocean — these are the live surfaces):**
- `src/ui/render/mm-desk-view.ts` (+ `.spec.ts`) — the MM desk page: summary, the new **hedge panel**,
  per-book cards (cash grid that sums to net, the demoted mark-out diagnostic, the new **F3 line**).
- `src/ui/render/format.ts` — `signClass` / `money` / `usd` / `pct` (the colour + money dialect). The
  colour semantics live here; this is where "green = good for us" gets decided per field.
- `src/ui/render/components.ts`, `layout.ts`, `html.ts` — shared bits + the CSS classes (badges,
  `pos`/`neg`/`flat`, `stat`, `panel`). Find where `pos`→green / `neg`→red is defined and decide if
  every call site's sign actually means "good/bad" (it often doesn't — e.g. inventory sign, residual).
- The other role pages only if time: `statarb-desk-view.ts`, `risk-view.ts`, `exec-view.ts`,
  `ops-view.ts`, `research-view.ts`, `landing-view.ts` (the stat-arb desk is the known monitoring gap —
  see [[feedback_business_event_logging]]).

**Specific things to verify / fix:**
1. **Colour intuition.** Audit every `signClass(...)` call: does a `+` there mean "good for the desk"?
   Cases to get right — fees/rebate (a −0.2bps HL rebate is *revenue* → should read green; the card
   already flips fees to a contribution sign, confirm it's green), adverse selection (always bad →
   red), hedge residual (smaller=better, sign is direction not goodness → probably neutral, not
   red/green), inventory (a sign is a direction, not good/bad → neutral), maxDD (always bad → red/amber
   scale). Consider a 3-state or magnitude-aware scheme where a raw sign is misleading. Research how
   pro terminals (Bloomberg/exchange MM dashboards) colour P&L vs exposure vs cost lines and mirror it.
2. **Show only active stuff.** The hedge panel renders only when `snap.hedge?.enabled` and the F3 line
   only when `b.toxicity` — good; verify nothing ELSE on the pages is a never-populated or legacy field
   (e.g. anything referencing the retired treasury/legacy-hedge, or bar-path-only fields on a
   fast-only desk like `seededBars`/`lastBarAt` that are now always null). Remove or hide the dead ones.
3. **Correctness vs the new accounting.** The desk net now *includes* hedge P&L (folded). Confirm the
   summary "net p&l" and the per-book cards still reconcile and the hedge panel's hedge-P&L isn't
   double-shown as if separate from net. The cash grid must still literally sum to net (#43 invariant).
4. **The hedge panel + F3 line** added this session are functional but un-styled-beyond-reuse and
   colour-naive — this is where most of the polish lands.

**How to see it:** the dev server doesn't run in this sandbox (`npm run start:dev` exits 144 — see
[[feedback_dev_server_sandbox]]); verify via `npx jest src/ui` + tsc, and reason from the render
output in the specs. Hand Ronnie the smoke step (`bash scripts/start-desk.sh` → open
`http://localhost:3100/desk/mm`). Use the `verify` skill if helpful. Note `docs/UI_REDESIGN_PROMPT.md`
exists from an earlier pass — reconcile with it, don't duplicate.

**Deliverable:** the colour-semantics fix + dead-field removal applied + tested, committed in phases on
the branch; a short note in the journal on the colour scheme chosen and why.

---

## JOB B — run + review Run A′, then chase the edge (the real open problem)

1. **Run it** (hand to Ronnie — sandbox can't): `bash scripts/start-desk.sh` (terminal 1, wait for
   `Nest application successfully started`) + `bash scripts/launch-mm-10h.sh` (terminal 2). Let it run
   hours. Confirm in the log: `desk delta hedge ON … target:` (the β-map) and `F3 toxicity:` lines.
2. **Review with the `mm-run-review` skill** — truth is the DB `mm_nav`, NEVER read the multi-MB log
   whole. Score against the Run A′ gate (`docs/NEXT_RUN_PREREG.md`): **desk realised ≥ 0**, per-book
   maxDD ≤ 1.5%, hedge non-trivially live (`.hedge.hedgePnlUsd` ≠ 0, residual < gross), F3 fired
   (widen-events > 0). Append numbers + verdict to the journal.
3. **If realised < 0** (the likely first outcome): the leak is **adverse selection**, not coverage.
   Tune via the training loop (`docs/RUN_TRAINING_LOOP.md`) — F3 min/max scale, γ/κ + min-half-spread
   (the `gamma-kappa-sweep` / `mm-l2-tune` fitters), and `MM_HEDGE_COST_SPREAD_MULT` if the wider
   spread starved fills (check the fill counts first). **Do NOT add coins or reach for the directional
   lean** — that's Run B, gated on Run A′ passing.
4. **Watch for two failure modes the new wiring could introduce:** (a) the hedge-cost premium
   over-widening spreads → fill rate collapses → near-zero P&L (no data) → lower the mult; (b) the
   fast-cadence hedge churning (rebalancing too often) → hedge cost bleed → check `hedge` DeskEvent
   frequency, widen `MM_HEDGE_BAND_USD` if so.

---

## Other known gaps / backlog (lower priority — outline, not blocking the run)
- **Automate the training loop:** build `scripts/learn-from-run.ts` (ingest last run's `mm_nav` +
  shadow capture → run the fitters → print proposed next-run env diff + draft prereg). See
  `docs/RUN_TRAINING_LOOP.md` §"Pushing toward automatic".
- **Persist the spread/adverse/inventory-carry attribution to `mm_nav`** (DR-5) — today only
  realised/unreal/fees/funding survive shutdown, so a post-mortem can't locate the realised leak in the
  DB; the #43 card shows the split live but it dies with the process.
- **The repo-wide simplify/audit pass** Ronnie flagged ("we are touching everything… then the full
  repo audit to simplify"): hunt remaining config-sprawl + dead paths (DR-0), the dormant legacy
  treasury/yield modules, the `telemetry.module.spec` isolation flake (on the stale-repo list — fails
  on pre-session commits too; fix it properly or quarantine, don't keep skipping).
- **Funding-carry basket** + **γ/κ distribution across regimes** (run the capture many times) — the
  long-standing discovery backlog (see [[project_next_session_backlog]]).

Related memory: [[project_mm_frontier_state]], [[feedback_business_event_logging]],
[[feedback_desk_risk_doctrine]], [[feedback_dev_server_sandbox]], [[feedback_proceed_autonomously]].
