# MASTER PLAN — Session Chain (living document)

> **2026-06-11 update:** this file now carries **two plans**. PART IV is the original MASTER PLAN I
> chain (S1–S9; S1/S2 done). **PART V is MASTER PLAN II — the flow-reactive, leak-driven chain
> (F0–F5)** from the operator's Flow-Reactive Quoting spec
> ([FLOW_REACTIVE_QUOTING.md](FLOW_REACTIVE_QUOTING.md)) reconciled with the run55 leak table
> (Journal #58). **PART V is the active chain — paste the next ☐ F-prompt.** The chain protocol
> below applies unchanged to both parts.

> **What this is.** MASTER PLAN I ("MM on Hyperliquid: from not-losing-money to extracting maximum
> profit") evaluated against the desk's own data (Run A″, 2026-06-10), re-ranked, adapted to the
> binding paper-only mission, and broken into **eight self-contained session prompts**. Each prompt
> is designed to be pasted into a **fresh** Claude Code session and to carry all the context that
> session needs (≥50% of the session's bandwidth is in the prompt, not in re-derivation).
>
> **How to use it (the chain protocol).** Run sessions in order. Every session ends by (1) appending
> a QUANT_JOURNAL entry, (2) **updating this file**: mark its session DONE with results, then
> **review every remaining prompt against the new findings** — re-rank, rewrite embedded numbers,
> drop or merge sessions whose premise the results invalidated — and **rewrite the next session's
> prompt in full** so it embeds the fresh numbers/artifact paths, (3) committing, and (4) printing
> the next session's prompt verbatim as its final message. You go prompt → prompt; this file is
> always the current state of the chain.

---

## PART I — The evidence: Run A″ read (2026-06-10, ~19:20Z, mid-flight)

Window: the current desk session (8 GLFT books, $8M, Hyperliquid, hedge ON, F3 ON, directional OFF,
**markout horizons 1s/5s/30s/60s/300s now live**), read ~5h in with restarts at 14:25/17:43/18:07
(MM_PERSIST carried book state across them). Source: `mm_nav` + live `/api/market-making/snapshot`.

**Scorecard (realised-first).**
- **DD bar: PASS.** Per-book maxDD 0.03–1.33% (SOL 1.33, SUI 1.22, BTC 0.91, XRP 0.88, ADA 0.79,
  ETH 0.78, DOGE 0.39, BNB 0.03) — all under the ~1.5% pre-registration bar (A′ was 1.65%).
- **Desk realised +$477** (net −$443, fees −$187) — the first ~breakeven-to-green realised window
  after A′'s −$3,359/2.3h. Carried by SOL +752 and ADA +494; bled by XRP −326, ETH −286, BTC −203.
  Flattery check: SUI net −356 is almost all open mark (−350 unreal); XRP −326 realised is partially
  masked by +197 unreal.
- **Desk unreal −$1,104 vs books-sum ≈ −$66 ⇒ ~−$1.0k sits on the hedge legs.**

**Edge.** `spreadCaptured` positive on 7/8 books (Σ ≈ +$1,657) but adverse ≈ spread (Σ ≈ $1,641):
windowed fill-edge ≈ **$0**. The pick-off war stays won (#47/#48 fix holds); the quoter is
breakeven-per-fill inside the markout windows.

**The 60s/300s horizons confirm #49's hypothesis: the loss lives OUTSIDE the old windows.**
Markout@300s: XRP −16.7bps, SOL −12.3, BTC −9.3, ADA −3.5, SUI −3.2 (monotone decay through 60s);
DOGE +0.7 / BNB +3.5 (decay to 30–60s then revert); **ETH ≈ 0 flat — the one book where fair value
is right**. h* (flattening horizon) is ≥60–300s on majors+XRP, not 1–30s.

**Hedge — the #1 measured leak.** 263 orders / **$9.1M churned notional / ~$2.7k taker cost**
(`hedgeCostUsd` 2,726) vs desk realised +477 — churn cost ≈ **5.7× the realised P&L**. Gross delta
$12.8k → residual $1.7k (the netting works mechanically), but the BTC leg flipped 31× (the
crossing-flat churn signature; the fixed `bandUsd` dead-band at `desk-delta-hedger.ts:122` is the
named fix). **Regression: hedge-quality estimator shows betaLive=0 / r²=0 on all 5 ETH-underlying
alt books** (ADA/DOGE/SOL/SUI/XRP) — broken this run (A′ had real values, e.g. XRP r² 0.51); fix
before any beta work.

**Attribution still doesn't sum** (#49's $5.9k gap persists in sign): windowed components ≈ +$2.7k
(spread 1,657 − adverse 1,641 + carry 2,658 − fees 187) vs actual net −$443. Drift on warehoused
inventory outside the markout windows lands in **no component**. Until this reconciles, every
optimization below is steering by a broken compass.

### Addendum (same session): the Sweet-16 book swap — SHIPPED ahead of the next run

`docs/BOOK_SELECTION_ANALYSIS.md` (2026-06-10) prior-scored the HL universe; this session verified
it against the live API and re-cut the desk from 8 crypto books to **16 books**: 8 HIP-3 RWAs on the
trade.xyz dex (`xyz:GOLD/SILVER/XYZ100/SP500/CL/BRENTOIL/NVDA/TSLA` — live 24h vol $24M–$1.0B each)
+ 8 main-dex (`HYPE FARTCOIN kPEPE PURR SUI SOL ADA DOGE`). BTC/ETH/XRP/BNB **dropped as quoted
books** (BTC/ETH remain hedge legs). Engineering shipped: `hlCoin()` exact-case coin keys (HIP-3
`xyz:` prefix AND k-coins — `kPEPE` was unreachable under the old `toUpperCase`), beta-map
right-anchored parsing + **beta 0 = explicit don't-hedge** (HIP-3 books have no crypto factor;
governor-capped instead), **HIP3_FEE** (no maker rebate assumed on HIP-3 — paper honesty),
`scripts/smoke-sweet16.ts` (all 16 verified reachable), launch/start scripts rewritten ($500k×16 =
same $8M desk). Known gaps, owned by the chain: per-dex funding not wired (xyz books carry funding
0), no fitted betas for HYPE/FARTCOIN/kPEPE/PURR (beta 0 until `hedge-beta-fit` covers them),
HIP-3 fee schedule is an estimate to verify (S6), closed-underlying-hours gap risk on RWA books
is UNMODELED until S4's event calendar + S8's hours template.

---

## PART II — Plan evaluation against the data (what survives, what changes, what's parked)

| Plan item | Verdict from our data | Disposition |
|---|---|---|
| Part 0 ranking (book selection > fees > funding > hedging > microstructure > regime) | Directionally right, but **our** #1 measured leak is hedge churn ($2.7k/window) and #2 is long-horizon adverse selection — both "reduce the loss line" items | **Re-rank: C-phase (hedge) and attribution first**, then funding/book-selection |
| A1 attribution engine + 12 cuts | **Confirmed urgent** — components don't sum (Journal #49, A″); plan assumed working attribution | **S1** (with warehouse-drift component added; repo idiom: ts scripts, not parquet/notebooks) |
| C1 netting / C2 dynamic dead-band / C3 beta bake-off | **Confirmed by A″**: $9.1M churn, BTC-leg flips, r²=0 estimator bug | **S2** — highest-$ session |
| C4 markout-driven F3 v2 | **Confirmed**: h* is 60–300s, F3 windows are 1–30s | **S3** |
| D1 cross-venue (Binance) fair value | **Contradicted at short horizons** — Journal #27–33 measured Binance fusion a no-op for HL at ~1s. But the loss moved to 60–300s where lead-lag may matter | **S3 (re-test, scoped)** — not a greenfield build; `scripts/mm-leadlag.ts` exists |
| A2 regime tagger + event calendar; 3.G kill hierarchy | Plausible, untested here; loss-concentration cut (1.2(12)) will tell | **S4** |
| 3.E / D3 funding-aware skew | Paper-compatible; infra exists (`funding-refresh.cron`, `funding-bias-source`, HL predicted rates) | **S5** |
| 3.F / D4 book selection & rotation | **Supported AND partially executed**: the Sweet-16 swap shipped (Part I addendum) on `BOOK_SELECTION_ANALYSIS.md` priors. S6 is now the **live verification tool** that confirms/kills each [E] prior | **S6** (re-scoped) |
| Multi-venue expansion (analysis §3f: Lighter, Aster, Paradex, Pacifica, edgeX) | New mandate (2026-06-10): integrate additional venues in search of alpha. Paper-adapted: adapters + paper books on their data; points/retro economics modeled as structural adders, not farmed | **S9** (new) |
| 3.A block-cadence / ALO / queue tactics; B1 audit | We are a **paper** desk on the public WS — ALO/block mechanics don't exist in our venue model. Adapt: model cancel-priority + ALO in `LobReplayHarness` (simulator honesty, hard truth #3) | **S7** (replay-side) |
| E1 Tokyo non-validating node | **PARKED** — real infra for live trading; mission is paper-only. Substitute: measure public-path latency, price stale-quote fills (1.2(9)) in replay | folded into **S7** |
| B2 fee ladder / tier climbing / HYPE staking / builder codes (3.D 2–4) | **PARKED** — no real account, no real tiers; rebate compounding loop doesn't exist on paper. Keep `venueFeeFor` schedule accuracy only | dropped (note in S6 scoring: use live fee schedule values) |
| E2 HIP-3 onboarding template; Part 4 new markets | Fits the discovery-frontier mission (paper MM on new/uncompeted books) | **S8** (lighter than spec'd) |
| E3 shadow/paper A/B harness | High value — the permanent promotion rig; we already shadow bias signals (`flow-shadow-*.jsonl`) | **S8** |
| D5 drift-aware quoting | Stays LAST and gated (plan and prior study agree; ETH 270/57 one-sided fills in A′ are the motivation, but it's the directional-risk item) | **S8 decision**, only after the rig exists |
| Phase F deploy loop | Adapted: replay win → shadow win → **live paper desk** (one book) → fleet. No real-capital stage | protocol below |
| B4 "what NOT to build" | Agreed in full (no sub-second ML alpha, no NLP, no latency arb) | binding |

**KPIs (Part 6, adopted):** residual marked-P&L variance + markout-adjusted spread capture per book;
funding-carry capture rate; stale-quote-fill rate; per-book ROI on margin; loss-concentration ratio;
book-selection model alpha. The leak table (S1) is the referee at every stage.

---

## PART III — Rules of engagement (binding for every session)

1. **Paper-only mission** (CLAUDE.md §1). No real-capital work; "deploy" means the live paper desk.
2. **Offline/replay first.** Never touch the live trading process mid-run. New quoting/hedging logic
   lands behind config flags, default off, validated on capture/replay before a paper-desk run.
3. **Token discipline** (CLAUDE.md §12): never read big artifacts end-to-end; jq/grep → narrow Read.
4. **Every claim replay-backed; every session ends with a written report including negative results**
   (journal entry + this file updated).
5. tsc clean + tests green before commit; commit per CLAUDE.md §0.
6. **The chain protocol** (header of this file) is part of every session's definition of done.

---

## PART IV — The session prompts

Status legend: ☐ pending · ◐ in progress · ☑ done (with date + one-line result).

- ☑ **S1 — Attribution that sums + the leak table** (2026-06-11, Journal #52: `inventoryMtmUnits`
  makes net = fillEdge + warehouse + funding − fees exact; r²=0 bug pinned (frozen bookless mark);
  `scripts/mm-leak-table.ts` shipped + run on A″/#51 — **warehouse drift is the #1 leak class in
  both runs** (A″ majors −$657, #51 −$2.3k); hedge churn measured A″ −$2,454 → #51 −$373 (the
  Sweet-16 single-leg netting already banked most of S2's predicted win))
- ☑ **S2 — Warehouse drift: inventory time-stop + hedge dead-band/beta polish** (2026-06-11,
  Journal #53: `TimeStopQuoter` built (proportional skew-to-flat, `ctx.nowMs` seam, 6 specs) —
  replay verdict **MIXED/regime-dependent** (BTC −2,127→−730, ETH realised +291, SOL −1,524 at
  10m) ⇒ wired **default OFF** (`MM_TIME_STOP`), enable only behind S8 A/B or the S4 regime gate;
  windowed spread/adverse now persist across restarts/checkpoints (S1 gap closed); dead-band +
  beta bake-off deferred with numbers (#51 churn $373; betas refit 2026-06-11))
- ⊘ **S3 — Long-horizon adverse selection** — SUPERSEDED: the directional fair-value question is
  now owned by **F4 Stage B** (κ·flow re-centering, markout-gated)
- ◐ **S4 — Regime tagger, event calendar, kill hierarchy** — calendar+blackouts SHIPPED outside the
  chain (#57); binary sweep gate SHIPPED (#56) but run55 showed it wrong-shaped (kPEPE 0 engagements,
  3 stops) — the remainder (kill hierarchy) is superseded by **F4 Stage A**'s regime machine
- ⊘ **S5 — Funding-aware skew (κ_f)** — FOLDED into F0 (persist HIP-3 funding so it's measured) +
  F4 (E[funding·τ] in the flatten inequality)
- ◐ **S6 — Book-selection model + rotation** — live as the UNIVERSE_DISCOVERY ledger + per-run
  fillEdge verdicts (run55: ADA fail, DOGE/SUI probation); capital weighting = **F5**
- ☐ **S7 — Simulator microstructure honesty** — still pending; raises the trust ceiling on every
  F-chain replay gate, schedule after F2 if replay/live deltas diverge
- ☐ **S8 — Shadow A/B rig** — still pending; the clean way to validate F3/F4 live
- ⊘ **S9 — Multi-venue expansion** — parked (appendix)

**MASTER PLAN II — flow-reactive, leak-driven chain (PART V, the active chain):**

- ☑ **F0 — Persistence & attribution instrumentation** — SHIPPED 2026-06-12 (Journal #59): the four
  research tables (`mm_fill_markout` / `mm_hedge_nav` / `mm_hedge_quality` / `mm_desk_event`,
  migration 1723…), per-fill markout sink with fill context (flow/VPIN/σ/q-before/queue-ahead),
  true hedge-leg P&L + hourly/shutdown quality, durable DeskEvent tape, HIP-3 per-dex funding,
  NAV corrupt-mark guard, and the leak-table upgrade (worst5m fixed, per-hour strip, A-quadrant
  split, queue terciles, top-of-hour cut, `--self-check`). Gate: `--self-check` exits 0 only on
  a post-F0 finished run — verify on the FIRST run after this ships.
- ☑ **F1 — Hedge anti-churn** — SHIPPED 2026-06-12 (Journal #60): min-hold 30s + flip-cooldown
  5min + flow-flip add-freeze (θ 0.25) + net-first (primary flatten ⇒ no opposing leg same cycle,
  min-hold restarted) + per-book basis gate (FARTCOIN/kPEPE/ADA → flatten, run55 priors) +
  per-leg band map; every suppression a `BLOCKED ▸`/`FLOW ▸` tape event with numbers; F1.6
  variance-reduction report in the leak table. Replay (mechanical rules only): −17% churn cost;
  the ≥50% gate rests on basis-gate + net-first and is **measured on the first post-F1 run**
  (leak-table hedge-fee line + variance report — data exists via F0).
- ☑ **F2 — Quote anti-churn** — SHIPPED 2026-06-12 (Journal #61): shared `decideRequote`
  hysteresis/dwell/urgent (live engine + replay run the same code), per-trigger taker-cross
  attribution (`takerCrosses` + `trigger` on the fill tape — stop tax separable from SQL),
  grep-able `F2 requote:` interval line, `scripts/mm-requote-compare.ts` A/B. Replay verdict
  MIXED (fill edge up on every coin; net couples to the warehouse path) ⇒ **hysteresis default
  OFF** — arm `MM_REQUOTE_MIN_BPS=1 ` live after F3. Maker-bias (F2.3) is structural: the maker
  engine is post-only; the only taker path is the attributed guardrail flatten.
- ☑ **F3 — Inventory skew** — SHIPPED 2026-06-12 (Journal #62): GLFT concentration controls
  (skew gain ×(1+2r) + adding-side size ramp → reduce-only over conc 0.5→0.85, default ON,
  per-side sizes through both engines), `CONTROL ▸`/`BLOCKED ▸ conc-cap` change-driven tape
  events, loss-stop in the replay harness + `scripts/mm-inventory-sweep.ts`. Sweep verdict:
  **0.01% stop validated** (desk warehouse −95%, maxDD halved on the 14h tapes; 0.05%+ never
  fire); conc mechanism validated where it binds (BNB: whse/net/fills all up), magnitude is
  the next live run's read (ADA conc<70% gate, now on the durable tape).
- ☐ **F4 — Flow-reactive quoting, throttle-first, κ gated** *(fill-edge leak: −99)*
- ☐ **F5 — Capital ∝ measured fillEdge**

---

### S1 PROMPT — Attribution that sums + the leak table

```
You are in /home/nexus/code/meridian-markets (NestJS/TS strict, paper-trading MM desk on
Hyperliquid data; CLAUDE.md is binding — paper-only mission, token discipline §12, commit
discipline §0). This is Session S1 of the MASTER PLAN I chain in docs/MASTER_PLAN_SESSIONS.md
(read its Parts I–III first; do NOT re-read the whole journal — tail it).

CONTEXT YOU NEED (verified 2026-06-10):
- Authoritative P&L: Postgres mm_nav (host localhost:5433, user/db/pass all
  meridian_markets_app; book_key=''=desk, symbols=books, it-nav-*=fixtures to exclude).
- Live attribution/markout/toxicity/hedge state: GET localhost:3100/api/market-making/snapshot
  (units fields are strings — tonumber). Markout horizons now 1s/5s/30s/60s/300s
  (MM_MARKOUT_HORIZONS_MS, default '1000,5000,30000' in src/config/app-config.factory.ts:183).
- Attribution code: src/market-making/backtest/pnl-attribution.ts (+ fast-engine wiring in
  src/market-making/live/). Hedge: src/market-making/hedge/desk-delta-hedger.ts (fixed bandUsd
  dead-band, :122), hedge-quality.ts. Run review playbook: .claude/skills/mm-run-review/SKILL.md.
- THE PROBLEM (Journal #49 + Run A″ 2026-06-10): the 4-component attribution
  (spread/adverse/carry/fees) is marked only over the post-fill markout windows; drift on
  warehoused inventory OUTSIDE those windows lands in NO component. A′: components +$2.7k vs
  actual −$3.2k (~$5.9k gap). A″: components ≈ +$2.5k vs net −$443. The books are steered by a
  compass that doesn't sum.
- SECOND BUG (Run A″): hedge-quality estimator returns betaLive=0 / r²=0 on all 5
  ETH-underlying alt books (ADA/DOGE/SOL/SUI/XRP) — worked in A′ (XRP r² 0.51). Likely broken
  by the MM_PERSIST state restore across the 17:43/18:08 restarts. Reproduce and fix.
- THE DESK IS NOW 16 BOOKS (Sweet-16 swap, Part I addendum of this file): 8 HIP-3 RWAs
  (xyz:GOLD/SILVER/XYZ100/SP500/CL/BRENTOIL/NVDA/TSLA — UNHEDGED by design, beta 0, NO maker
  rebate (HIP3_FEE), funding 0 until per-dex funding is wired) + HYPE/FARTCOIN/kPEPE/PURR/
  SUI/SOL/ADA/DOGE. Your leak table is the FIRST per-book read on the new set — break it out
  HIP-3 vs main-dex, and flag any RWA book whose closed-underlying-hours P&L diverges (the
  unmodeled gap-risk regime). BTC/ETH books are gone; hedge legs remain BTC/ETH perps.

TASKS (in order):
1. Fix the hedge-quality r²=0 regression (test that survives a simulated state restore).
2. Make attribution SUM. Add the missing component(s) so the identity
   NET = spreadCapture + rebate/fees + fundingCarry − adverseSelection(h*) − inventoryCarry
         (warehouse drift, now covering ALL holding time, not just markout windows)
         − hedgeCost − basisResidual
   reconciles against mm_nav net within 5% per book per run. Likely design: mark inventory
   drift continuously (or at each NAV snapshot) instead of only inside post-fill windows;
   hedge legs' P&L and cost become explicit desk-level terms (today desk-unreal −$1,104 vs
   books −$66 hides ~−$1.0k on hedge legs). Unit tests with synthetic fills + drift.
3. Build scripts/mm-leak-table.ts: consumes mm_nav + snapshot (or persisted book state) and
   emits the per-book/per-run leak table (markdown + json under docs/research/):
   each term in $, plus the diagnostic cuts computable from our capture TODAY:
   markout by book×side×hour, fill-rate vs quoted-spread frontier, funding-sign capture rate,
   hedge churn (orders, notional, est cost, flip-vs-track ratio from the HEDGE ▸ log lines),
   per-book ROI on margin, loss concentration (worst-1% 5-min buckets share of losses),
   top-of-hour toxicity (±3min around funding prints). Skip cuts needing data we don't log yet
   (queue tercile at fill) — list them as gaps at the bottom of the report instead.
4. Run it on the 2026-06-10 Run A″ capture and write the ranked leak table.
   Expected top leaks (verify, don't assume): (1) hedge churn ~$2.7k, (2) long-horizon
   adverse on XRP/SOL/BTC (markout@300s −9…−17bps), (3) basis residual.
5. Update .claude/skills/mm-run-review/SKILL.md: replace the manual P&L identity section with
   "run scripts/mm-leak-table.ts" + keep the four DB/log commands as fallback.

DEFINITION OF DONE: identity reconciles ≤5% on the A″ capture; leak table ranked by $/day in
docs/research/; r²=0 bug fixed with test; tsc + jest green.

END-OF-SESSION PROTOCOL (binding):
(a) Append a dated entry to docs/QUANT_JOURNAL.md (realised-first, negative results included).
(b) Update docs/MASTER_PLAN_SESSIONS.md: mark S1 ☑ with a one-line result; REVIEW S2–S8
    against your leak table — re-rank, rewrite their embedded numbers (the S2 prompt cites
    "$2.7k churn"; replace with the measured term), drop/merge anything the data invalidated;
    REWRITE the S2 prompt in full with fresh artifact paths.
(c) Commit (CLAUDE.md §0).
(d) Print the updated S2 prompt verbatim as your final message so the user can paste it into
    a fresh session.
```

---

### S2 PROMPT — Warehouse drift: inventory time-stop + hedge dead-band/beta polish (re-scoped by S1)

```
You are in /home/nexus/code/meridian-markets (CLAUDE.md binding: paper-only, §12 token
discipline, §0 commits). Session S2 of the chain in docs/MASTER_PLAN_SESSIONS.md (read Parts
I–III + the S1 ☑ line; the S1 leak tables in docs/research/leak-table-{run-a2,run51-sweet16}.md
are the referee). If a paper run is LIVE (check :3100/health), develop on a worktree branch and
never edit src/ in the watched checkout — nest --watch restarts the desk on any file change.

CONTEXT (measured by S1, 2026-06-11 — do not re-derive):
- **Warehouse MTM is the desk's #1 leak class in BOTH captures**: #51 Sweet-16 ranked leaks
  1–2 were xyz:BRENTOIL −$1,128 / HYPE −$1,126 warehouse (fill edge only −277/−373); A″'s
  ETH/BTC books had POSITIVE fill edge (+94/+67) yet bled warehouse (−355/−263). The governor
  caps |inventory| but nothing bounds HOLDING TIME — a capped position riding a trend is the
  loss. The identity now measures it live: snapshot `inventoryMtmUnits` (continuous, persisted).
- Hedge churn is SOLVED-BUT-WATCH: A″ −$2,454 (263 orders, 48 flips — cross-flat churn) →
  #51 −$373 (53 orders, 46 track/6 flip) after the Sweet-16 single-ETH-leg netting. The
  remaining polish: a dynamic dead-band (fixed bandUsd $2k today, desk-delta-hedger.ts) and
  the beta bake-off. Betas now LIVE-fitted: FARTCOIN:ETH:1.53 (R².65), kPEPE:ETH:1.20 (R².77),
  PURR unhedged (R².13); hedge-quality KPI fixed in S1 (frozen-mark regression test).
- Risk-averse doctrine (binding, Journal #51 addendum 2): prefer FEWER fills over LOSING
  fills; γ=0.005, F3 widen-only, inv frac 0.15, skew mult 6 are the live defaults.
- Replay rig: src/market-making/backtest/ (LobReplayHarness, mm-backtest-runner); L2 tapes:
  docs/research/l2-tapes/. Leak table: scripts/mm-leak-table.ts (run BEFORE any relaunch —
  relaunch overwrites surviving books' mm_book_state accumulators).

TASKS (in order):
1. REPLAY: the inventory TIME-STOP — bound holding time, not just size. Design space (sweep on
   the L2 tapes + the A″/#51-era captures): exit a position older than T minutes (age-weighted
   by |inventory|/cap), via (a) skew-to-flat escalation vs (b) taker exit at cost. Honesty: a
   taker exit pays the spread+fee you normally earn — the sweep must show net improvement on
   warehouse MTM minus exit costs, per book class (HIP-3 RWA vs main-dex). Negative result =
   report and stop.
2. REPLAY: dynamic hedge dead-band — band(σ_underlying, taker cost, |residual| vs flat):
   widest around zero residual (kill the cross-flat flip class: 48 flips in A″). Frontier:
   hedge cost vs residual-delta variance. Expected gain is now SMALL (#51 churn $373) — if
   the frontier says < ~$100/run, record the negative result and skip the wiring.
3. Beta estimator bake-off (study §4.2): static-OLS (current, refit between runs) vs EWMA vs
   Kalman per book, scored on residual-P&L variance NET of induced hedge churn. The
   hedge-quality KPI (betaLive/r²/basisShare) is the live scorer.
4. Wire winners behind config flags (default = current behaviour), unit-tested. Time-stop
   events must hit the desk-event tape (Ronnie's business-event rule).
5. Persist the engine's windowed spread/adverse into mm_book_state at checkpoint (S1 gap:
   finished runs lose the split today) + checkpoint state at run END (nav cron) so the leak
   table stops depending on remove-order.
6. Re-run scripts/mm-leak-table.ts on the next finished run: report the warehouse line old vs
   new. DoD: replay A/B table (warehouse MTM, exit costs, hedge cost, flips); flags + tests;
   leak-table delta; tsc + jest green.

END-OF-SESSION PROTOCOL (binding):
(a) Journal entry (realised-first, negative results included). (b) Update
docs/MASTER_PLAN_SESSIONS.md: S2 ☑ + result; review S3–S8 against the replay findings (if the
time-stop kills warehouse drift, S3's long-horizon adverse selection may already be half-solved
— re-rank honestly); rewrite the S3 prompt in full with fresh numbers/paths. (c) Commit.
(d) Print the updated S3 prompt verbatim.
```

---

### S3 PROMPT — Long-horizon adverse selection: F3 v2 + cross-venue lead-lag re-test

```
You are in /home/nexus/code/meridian-markets (CLAUDE.md binding). Session S3 of the chain in
docs/MASTER_PLAN_SESSIONS.md (read Parts I–III + S1/S2 result lines + the current leak table).

CONTEXT (updated after S1/S2, 2026-06-11 — do not re-derive):
- S1 leak tables (docs/research/leak-table-{run-a2,run51-sweet16}.md): warehouse MTM is the #1
  leak class; fill-edge pick-off is #2, concentrated in the books we CUT (SILVER/BRENTOIL/HYPE).
  The identity (net = fillEdge + warehouse + funding − fees) is live on the snapshot
  (inventoryMtmUnits) and persists (windowed spread/adverse survive restarts since S2).
- S2: TimeStopQuoter exists DEFAULT OFF (MM_TIME_STOP) — replay verdict MIXED (BTC −2,127→−730
  but SOL −1,524): it must be regime-gated (S4) or A/B-validated (S8) before live enable. Your
  long-horizon AS work and the time-stop attack the SAME dollars — measure together.
- Long-horizon AS evidence: A″ markout@300s XRP −16.7bps / SOL −12.3 / BTC −9.3 monotone
  through 60s; #51 ADA −2.5→−5.1 and SUI −1.4→−3.4 by 30s; ETH ≈0. F3 (VpinEstimator + spread
  scale, now WIDEN-ONLY min scale 1.0 per the risk-averse doctrine) keys off 1–30s flow — it
  does not see the 60–300s bleed.
- Cross-venue caution: #27–33 measured Binance fusion a no-op at ~1s (HL self-prices); the open
  question is 60–300s only. scripts/mm-leadlag.ts exists.
- Data: snapshot .books[].markout/.markoutBySide (1s/5s/30s/60s/300s live); L2 tapes in
  docs/research/l2-tapes/ (main-dex only — **capture an xyz:* HIP-3 tape during the next run**,
  the S2 sweep's out-of-sample gap); flow-shadow-*.jsonl scored by scripts/flow-bias-markout.ts.
- OPS: run scripts/mm-leak-table.ts BEFORE any relaunch; a live desk means worktree-only src
  edits (nest --watch restarts on file change).

TASKS:
1. Per-book h*: from the capture, estimate the markout-flattening horizon per book (the
  plan's h*). Output a table; expect h* ≈ 1–5s on ETH, ≥300s on XRP/SOL/BTC.
2. F3 v2 (markout-driven): re-fit the toxicity window/response so the widening keys off the
  measured h* horizon per book (long-horizon toxicity ⇒ wider base spread / smaller size /
  inventory shedding sooner — NOT just faster re-quote). Replay A/B vs current F3 on
  markout-adjusted spread capture. Keep it a config-flagged variant.
3. Queue-decay pull rule (plan A3 v1): using the L2 tape's queue model
  (src/market-making/backtest/queue-*.ts), replay "cancel/re-post when back-third of a thick
  queue AND toxic flow" — value it in bps/notional per book.
4. Lead-lag RE-TEST at long horizons: with scripts/mm-leadlag.ts (extend if needed), measure
  Binance→HL lead at 10–300s per book. Only if a real lead exists, prototype
  FV_blend = w·micro_HL + (1−w)·(micro_Binance + basis), with the divergence-collapse
  safeguard (blend→local when |HL−ref| z-score spikes), and replay vs local microprice.
  A second confirmed no-op is a VALUABLE negative result — write it down and stop there.

DEFINITION OF DONE: h* table; F3 v2 replay A/B (capture + adverse at all horizons); queue-pull
value table; lead-lag verdict at long horizons; flags default-off; tsc + jest green.

END-OF-SESSION PROTOCOL: (a) journal entry; (b) update docs/MASTER_PLAN_SESSIONS.md — S3 ☑,
review S4–S8 (e.g. if long-horizon AS turns out to be regime-concentrated, S4 rises), rewrite
the S4 prompt in full; (c) commit; (d) print the updated S4 prompt verbatim.
```

---

### S4 PROMPT — Regime tagger, event calendar, kill hierarchy

```
You are in /home/nexus/code/meridian-markets (CLAUDE.md binding). Session S4 of the chain in
docs/MASTER_PLAN_SESSIONS.md (read Parts I–III + S1–S3 result lines + current leak table).

CONTEXT (update from S1–S3):
- Hypothesis to test first (plan diagnostic 1.2(12)): losses are concentrated — if >40% of
  total losses sit in the worst 1% of 5-min buckets, regime/kill work beats any quoting
  refinement. The S1 leak table computes this cut; read it before building anything.
- Inventory-carry losses concentrate in trending hours (Journal #49: ETH 270 bids vs 57 asks
  into a falling tape). γ-by-regime is the named lever (study + plan 3.G).
- Existing inputs: realized vol (quote/volatility.ts), VPIN/toxicity (risk/vpin.ts), funding
  extremity (live/funding-refresh.cron.ts, HL predicted rates), HL mark vs our reference mid.
- HL specifics: hourly funding prints (top-of-hour toxicity cut from S1); liquidation flow is
  publicly visible on HL (transparent chain) — v1 may proxy cascade risk with funding
  extremity + mark-oracle gap + trade-burst volume if direct liquidation feed is not wired.

TASKS:
1. Hour-level (and 5-min) regime tagger {calm, trending, toxic}: threshold rules on realized
  vol + signed volume imbalance + cascade index v1 (funding extremity, mark-reference gap,
  burst volume). Persist tags per book; NO HMM unless thresholds demonstrably fail at
  regime boundaries in replay.
2. Validate: regime-conditional P&L table from the S1 attribution — distributions must be
  statistically distinct (report the test). Then replay γ/spread-by-regime: γ_trending >
  γ_calm sweep on the capture; report the frontier.
3. Event-calendar mute module: CPI/FOMC/NFP UTC timestamps (static table, updatable) +
  top-of-hour funding windows → widen/pull N minutes around; replay the value on capture
  (the S1 top-of-hour cut gives the prior).
4. Kill-switch hierarchy (plan 3.G), spec + implement the cheap layers behind flags:
  mark-reference divergence breaker (pull quotes), stale-data watchdog (feed gap ⇒ pull all),
  per-book + desk drawdown rails (the 1.5% bar, already informally enforced — make it code).
5. Re-run the leak table on a regime-gated replay; report the delta.

DEFINITION OF DONE: tagger + tests; regime-conditional P&L table; replayed value of
regime-γ + event mutes; kill rails coded behind flags; tsc + jest green.

END-OF-SESSION PROTOCOL: (a) journal; (b) update docs/MASTER_PLAN_SESSIONS.md — S4 ☑, review
S5–S8 (funding lean S5 must be gated by THIS regime classifier — pass it the interface),
rewrite the S5 prompt in full; (c) commit; (d) print the updated S5 prompt verbatim.
```

---

### S5 PROMPT — Funding-aware skew (κ_f)

```
You are in /home/nexus/code/meridian-markets (CLAUDE.md binding). Session S5 of the chain in
docs/MASTER_PLAN_SESSIONS.md (read Parts I–III + S1–S4 results + leak table).

CONTEXT (update from S1–S4):
- HL funding settles HOURLY with a published predicted rate; whatever inventory we hold at
  the print pays/receives. A maker indifferent between ±q leaves carry on the table.
- S1's funding-sign cut measured our capture rate (% of prints where inventory sign matched
  the receiving side; random = 50%) — read the number; if we're <50% we are actively
  anti-funding (the mean-reversion-flow trap: crowd long ⇒ they sell to us ⇒ we sit long ⇒
  we PAY funding).
- Infra: live/funding-refresh.cron.ts, bias/funding-bias-source.ts (exists for the
  directional quoter), HyperliquidClient funding endpoints, docs/FUNDING_CARRY_DISCOVERY.md
  (the carry leg research). Regime gate: S4's classifier.
- Quoters: quote/glft-quoter.ts (+ directional-glft-quoter.ts has reservation-price skew
  machinery to reuse).

TASKS:
1. Implement the funding lean in the reservation price (replay first):
  r = micro + skew_inventory + κ_f · predicted_funding · f(time_to_hour), capped so the
  lean NEVER exceeds the inventory band the quoter tolerates anyway, and gated OFF in
  trending/toxic regimes and when the cascade index is elevated (funding chasing in extreme
  regimes is the failure mode — extreme funding correlates with trend/cascade).
2. Replay on the capture: added funding carry vs added inventory variance, per book.
  WIN CONDITION (binding, from the plan): carry gain > 3× the variance-implied cost. Sweep
  κ_f and f(·) (linear ramp over the last 10–20min vs constant).
3. Sizing sanity: at predicted +5bp/h and a $50k book cap, holding −$30k for 20min ≈ $1/print
  — verify our books' caps and typical predicted rates give a number worth the variance at
  desk scale ($8M, 8 books, 24 prints/day) BEFORE wiring anything live.
4. If the win condition passes: flag-gated implementation + tests; if not: negative result,
  write it down, recommend dropping the term (don't keep a dead lever).

DEFINITION OF DONE: replay carry-vs-variance table per book with the 3× verdict; flag-gated
implementation or a written kill; funding-capture KPI added to the leak table; tsc+jest green.

END-OF-SESSION PROTOCOL: (a) journal; (b) update docs/MASTER_PLAN_SESSIONS.md — S5 ☑, review
S6–S8 (S6's book scoring should include each book's funding-carry potential if S5 won),
rewrite the S6 prompt in full; (c) commit; (d) print the updated S6 prompt verbatim.
```

---

### S6 PROMPT — Book-selection verification tool + rotation (the [E]-killer)

```
You are in /home/nexus/code/meridian-markets (CLAUDE.md binding). Session S6 of the chain in
docs/MASTER_PLAN_SESSIONS.md (read Parts I–III + S1–S5 results + leak table).

CONTEXT (update from S1–S5):
- The Sweet-16 swap ALREADY SHIPPED (2026-06-10, Part I addendum) on the PRIOR scores in
  docs/BOOK_SELECTION_ANALYSIS.md — every number there marked [E] is an estimate. This
  session builds the live tool that CONFIRMS OR KILLS each prior (its §4 lists the
  [E]-killers) and the rotation rule that keeps the set honest. By now the desk has run on
  the 16 books for days — the S1 leak table is your ground truth per incumbent.
- Universe tooling exists: scripts/hl-universe-discovery.ts (main dex; EXTEND it to iterate
  perpDexs — POST /info {"type":"perpDexs"} then metaAndAssetCtxs with dex:"<name>"),
  scripts/smoke-sweet16.ts (reachability), GeckoTerminalClient, docs/DATA_SOURCES.md.
- Fees: venueFeeFor(src, symbol) — HIP3_FEE is a conservative ESTIMATE (maker +0.15bps, no
  rebate); task 4 verifies it per deployer. Felix-deployer books are wind-down: DO NOT TOUCH
  (analysis §0). Per-dex funding is unwired (xyz books carry funding 0) — wire it here or
  hand it to S5's funding work, whichever session runs first.

TASKS:
1. Build the per-book scoring tool (scripts/mm-book-score.ts) computing the analysis §1
  rubric FROM LIVE DATA: L2 depth at 1/5/10bp + realized spread distribution (replaces SPR),
  maker-fingerprint count / depth-replenishment speed (replaces SHR), markout curves from
  our own fills where we quote — else taker-flow toxicity proxy (replaces FLW), rolling
  beta/R² to BTC/ETH/XYZ100 factors (replaces HDG), margin/OI-cap headroom, deployer +
  growth-mode status per HIP-3 ticker (gates everything).
2. Score the FULL universe (all perp dexs + main dex + watchlist spot) and the incumbent 16.
  Output the ranked list; flag every incumbent whose live score kills its [E] prior.
3. Rotation rule: replace the worst incumbent only when a challenger exceeds it by a margin
  (switching costs: param re-fit, data history). Apply it: produce the concrete
  rotate/hold recommendation for the current set, with $/day estimates from the leak table.
4. Verify the HIP-3 fee estimate per deployer (fills' fee field in our capture vs HIP3_FEE);
  correct venue-fees.ts if measured ≠ estimated.
5. Document the weekly scoring invocation (no cron — the desk runs manually per session).

DEFINITION OF DONE: scoring tool + ranked universe + incumbent verification table +
rotation recommendation + fee verification; tsc + jest green.

END-OF-SESSION PROTOCOL: (a) journal; (b) update docs/MASTER_PLAN_SESSIONS.md — S6 ☑, review
S7–S9 (if rotation recommends new HIP-3 books, S8's onboarding template rises; S9's venue
list re-ranks by what the universe scan found), rewrite the S7 prompt in full; (c) commit;
(d) print the updated S7 prompt verbatim.
```

---

### S7 PROMPT — Simulator microstructure honesty: ALO/cancel-priority/block cadence + stale-quote pricing

```
You are in /home/nexus/code/meridian-markets (CLAUDE.md binding). Session S7 of the chain in
docs/MASTER_PLAN_SESSIONS.md (read Parts I–III + S1–S6 results + leak table).

CONTEXT (update from S1–S6):
- We are a PAPER desk on HL's public WS/REST; we will never live-race anyone. But HL's
  matching is block-based (HyperBFT, ~70–200ms blocks) and sorts CANCELS and ALO (post-only)
  orders BEFORE GTC/IOC within each block — a structural maker gift our simulator currently
  ignores. Hard truth #3: the replay is only as honest as its fill model; ours
  (src/market-making/backtest/queue-fill.ts, lob-replay.ts, fill-model.ts) is FIFO
  queue-aware but continuous-time.
- The paper-mission substitute for the plan's Tokyo-node session (E1, parked): MEASURE the
  public-path latency we actually have, and PRICE what staleness costs us.

TASKS:
1. Measure: public WS data delay + REST round-trip distribution over a few hours
  (scripts/, reuse capture-hl-l2.sh plumbing). Document in a latency-budget note.
2. Stale-quote-fill pricing (plan 1.2(9)): in replay, count fills that occur between our
  re-quote decision and simulated exchange ack (sweep ack latency over the measured
  distribution); multiply by their markout. Output: $/day lost to staleness per book — this
  number is the permanent answer to "would faster infra pay?" for the paper demo.
3. Extend the replay fill model with block semantics behind a flag: orders bucketed into
  blocks (sampled inter-block times), cancels+ALO sorted first, GTC/IOC after; ALO orders
  that would cross are REJECTED (must be repriced next block — model the gap). Re-run the
  A″-era tapes: how much does continuous-time vs block-aware change measured capture/adverse?
  If the delta is material, all prior replay numbers carry a documented correction factor.
4. Block-cadence quoting experiment (replay only): re-decide once per block arrival vs our
  current cadence; and queue-position-aware {hold, cancel-repost, step-in-one-tick} per book
  (tick-constrained books — optimal half-spread < 2 ticks — get the discrete two-level
  policy instead of continuous δ). Report per-book which dominates.
5. Verdict: which of these belong in the live paper loop (the L2 fill engine,
  src/market-making/live/l2-live-fill-engine.ts, has the same continuous-time assumption).

DEFINITION OF DONE: latency-budget doc; stale-quote $ table; block-aware fill model behind a
flag + correction-factor note; block-cadence/queue-tactic replay verdicts; tsc + jest green.

END-OF-SESSION PROTOCOL: (a) journal; (b) update docs/MASTER_PLAN_SESSIONS.md — S7 ☑, review
S8 (its shadow rig should run on the corrected fill model), rewrite the S8 prompt in full;
(c) commit; (d) print the updated S8 prompt verbatim.
```

---

### S8 PROMPT — Shadow A/B rig + HIP-3 onboarding + the drift-quoting decision

```
You are in /home/nexus/code/meridian-markets (CLAUDE.md binding). Session S8 — the last
planned session of the MASTER PLAN I chain in docs/MASTER_PLAN_SESSIONS.md (read Parts I–III
+ ALL result lines + the current leak table).

CONTEXT (update from S1–S7):
- Everything validated so far sits behind flags with replay wins. The promotion path
  (adapted Phase F) is: replay win → SHADOW win (≥1 week) → one live paper book → fleet.
  The missing piece is the shadow rig.
- We already shadow bias signals (flow-shadow-*.jsonl via bias/flow-shadow-recorder.ts,
  scored by scripts/flow-bias-markout.ts) — the pattern to generalize.
- Drift-aware quoting (plan D5 / study #3) is the deliberately-LAST item: it can turn the
  maker directional. Motivation exists (A′: ETH 270 bids vs 57 asks into a falling tape);
  discipline exists (docs/DIRECTIONAL_MM_STRATEGY.md, directional-glft-quoter.ts, the OOS
  bias gate in bias/oos/). It gets a DECISION this session, not a default-on deploy.

TASKS:
1. Shadow quoter harness: a read-only twin that runs ANY candidate quoter/hedger config
  against the live feed in parallel with the production paper desk, producing the SAME
  attribution as the S1 leak table (one rig, every future candidate). It must share zero
  mutable state with the live books. Document the operating procedure in
  docs/MM_DESK_E2E_WORKFLOW.md.
2. HIP-3 onboarding template: parameterized config so a new HL market (HIP-3
  equity/gold/FX or new HIP-1 spot listing) reaches replay + shadow in <1 day —
  oracle-sanity rail (deployer oracle vs our reference feed), underlying-hours calendar
  (closed-hours = gap-risk regime: widen by gap-vol estimate, hard inventory cap into the
  open), deployer risk limits. Validate the template by onboarding ONE HIP-3 market into
  shadow (not the live desk).
3. The drift decision: with S4's regime gate + S7's corrected fill model, replay the drift
  term (reservation-price drift only in 'trending' regime, cascade index below threshold)
  vs the post-S2/S3 baseline. Deployment recommendation ONLY if it wins net of the
  directional variance it adds; otherwise write the kill memo.
4. Chain retrospective (S1–S8): with the leak-table snapshots so far, write the
  before/after of the program (each leak's $/day at S1 vs now, what shipped, what was
  killed and why) in docs/research/ + a RESEARCH_FINDINGS.md entry. S9 (venue expansion)
  remains; Chain 2 is seeded there.

DEFINITION OF DONE: shadow rig running against the live feed with attribution parity;
one HIP-3 market in shadow; drift verdict written; retrospective written; tsc + jest green.

END-OF-SESSION PROTOCOL: (a) journal; (b) update docs/MASTER_PLAN_SESSIONS.md — S8 ☑, review
S9 against everything learned, rewrite the S9 prompt in full; (c) commit; (d) print the
updated S9 prompt verbatim.
```

---

### S9 PROMPT — Multi-venue expansion: adapters + paper pilots in search of alpha

```
You are in /home/nexus/code/meridian-markets (CLAUDE.md binding: PAPER-ONLY mission, §12
token discipline, §0 commits). Session S9 — the venue-expansion session of the chain in
docs/MASTER_PLAN_SESSIONS.md (read Parts I–III + ALL result lines + the current leak table).

CONTEXT (update from S1–S8 before trusting):
- Mandate (Ronnie, 2026-06-10): integrate additional venues in search of alpha. The venue
  shortlist + economics live in docs/BOOK_SELECTION_ANALYSIS.md §3f: Lighter (zk-L2,
  zero-fee, points seasons), Aster (BNB ecosystem, 1bp→0 maker), Paradex (Starknet,
  zero-fee + points), Pacifica (Solana, pre-TGE), edgeX; dYdX/GMX/Drift = data feeds only;
  Binance/Bybit/OKX = hedge/reference legs only.
- PAPER ADAPTATION (binding): we cannot earn points/retro rewards on paper. The pilot
  question each venue must answer is the MEASURABLE one: are spreads wider, flow more
  naive, and queues shorter than HL for the same risk — i.e. does a queue-aware paper book
  net more per $ of inventory variance there? Points/rebate economics are modeled as
  structural adders in the scoring (venue-fees.ts entry per venue), clearly labeled
  UNREALIZED-ON-PAPER.
- The engine's seams make this mechanical (CLAUDE.md §7): IReferenceBarSource +
  IL2BookSource + ITradeStreamSource (see src/market-data/reference/hyperliquid-client.ts —
  ~200 lines, the template), venueFeeFor for fees, MmBook/MmPortfolioTrader run any source
  that has L2. The HL case-quirk lesson (hlCoin, Part I addendum): verify each venue's
  symbol/case/addressing conventions EMPIRICALLY with curl before writing the adapter.

TASKS:
1. Recon (no code): for the shortlist, verify public market-data APIs exist without keys
  (L2 book, trades, candles, funding). Produce a venue-API matrix (endpoints, depth levels,
  WS availability, rate limits, symbol conventions). Kill any venue without a public L2.
2. Pick the TOP TWO by (measured spread width × volume × API quality) and write adapters
  implementing the three interfaces, with the same offline-tested discipline as
  HyperliquidClient (injected HTTP/WS, canned-payload specs). Register behind the module
  factory, safe default off.
3. Capture: run an L2+trades capture session on 2–3 candidate books per new venue
  (capture-hl-l2.sh pattern); run the γ/κ sweep + queue-aware replay on the tapes.
  Compare per-book expected capture vs the equivalent HL books from the S6 scoring tool.
4. If a venue's replay beats the HL median book: launch 1–2 SMALL paper books there on the
  live loop (capital ≤ $250k each), tagged in mm_nav, and add them to the leak table. If
  none beats HL: write the negative result — "HL remains the franchise" is a finding.
5. Update docs/DATA_SOURCES.md (venue ledger) + BOOK_SELECTION_ANALYSIS.md §3f with
  measured numbers replacing the priors.

DEFINITION OF DONE: venue-API matrix; ≥2 adapters with offline specs; capture + replay
comparison table; paper pilot launched or a written kill per venue; docs updated;
tsc + jest green.

END-OF-SESSION PROTOCOL: (a) journal; (b) update docs/MASTER_PLAN_SESSIONS.md — S9 ☑, mark
the chain COMPLETE, write the chain retrospective if S8 hasn't already, and seed Chain 2
(candidates: stat-arb companion plan, long shadow campaigns, the rotation cadence as a
standing process, venue #3); (c) commit; (d) print the Chain 2 seed prompt (or the explicit
"chain complete" memo) as your final message.
```

---

## PART V — MASTER PLAN II: flow-reactive, leak-driven chain (F0–F5) — ACTIVE

> Source design: [FLOW_REACTIVE_QUOTING.md](FLOW_REACTIVE_QUOTING.md) (operator spec, 2026-06-11).
> Baseline: **run55** leak table (`docs/research/leak-table-run55.{md,json}`, Journal #58):
> desk net −879/3.6h = hedge churn −437 + taker fees −229 + warehouse −95 + fillEdge −99.
> Order is leak-size, not design order: cost fixes first, directional alpha last and gated.
> **Re-run `scripts/mm-leak-table.ts` after every prompt and record the delta vs run55.**
> Chain protocol (file header) applies: journal entry + update this file + rewrite the next
> prompt with fresh numbers + print it verbatim as the session's final message.

Shared stack context (embed in every session): Postgres `localhost:5433`, db/user/pass
`meridian_markets_app`; tables `mm_nav`, `mm_book_state`; leak table
`npx ts-node -r tsconfig-paths/register scripts/mm-leak-table.ts` (window from `mm_nav`
desk-row gaps — copy-paste block in RUN_THE_DESK.md step 0); replay `LobReplayHarness`;
run55 tape/log `docs/research/run-20260611-172435-mm10h.log`. Books: ADA, kPEPE, xyz:GOLD,
FARTCOIN, xyz:CL, SOL, SUI, DOGE. Hedge legs: CL→BRENTOIL, GOLD→PAXG, alts→ETH.
Rules of engagement (PART III) binding: replay-first, flag-gated default-off, tsc+tests green.

**OBSERVABILITY REQUIREMENT (operator, 2026-06-11 — binding for EVERY F-prompt).** The system
responds automatically, with no human in the loop — so **every automatic response must leave an
audit trail**, not just guardrails. Extend the existing `▸` log grammar + `DeskEvent` tape
(`GUARDRAIL ▸`/`REGIME ▸`/`HEDGE ▸`) so each control action emits a structured line + tape event
**with the triggering metrics and the effect**, e.g.:
- `REGIME ▸ <book> NORMAL→DEFENSIVE (f −0.52, T 0.61, A −1, q −12.6, persist 8s)` — state WITH cause;
- `CONTROL ▸ <book> re-center +2.1bps / widen ask ×1.4 / size ask ×0.6 (T 0.61, side ask)` — the
  quote-level response as it takes effect (log on CHANGE, plus a periodic state line — never per-tick spam);
- `PARAM ▸ <book> w_ask 1.2→1.5 (auto-tune: MO60 ask −10bp < band)` — every settings/auto-tune change;
- `BLOCKED ▸ <book> add-side quote suppressed (conc 94% > hard cap)` / `BLOCKED ▸ hedge add frozen
  (flow flip, cooldown 90s)` — every trade/quote NOT placed, with reason;
- `FLATTEN ▸ <book> 40% of q (drift 8.2bps·τ12s > cost 3.1bps)` — the §4 inequality with its numbers.
Every event lands in the ring buffer (`/api/market-making/events`) + the /mm-desk Activity feed,
and (per F0) persists enough to audit a finished run. Tests assert the log fires on each path.

### F0 PROMPT — Persistence & attribution instrumentation *(hard prerequisite)*
```
My MM leak table (scripts/mm-leak-table.ts, Postgres meridian_markets @ localhost:5433)
shows n/a for spread, adverse, wedge, vpin, and markout, and the gaps section says the
data is in-memory only. I cannot evaluate any quoting/hedge change until this is
persisted. Implement persistence so the leak table is fully computable for FINISHED
runs, not just live snapshots:

1. Per-fill markout: persist book × side × horizon (1s/5s/60s) × hour to a new table.
   One row per fill with signed markout in bps and notional; the table must support
   the κ-leads-markout regression in F4.
2. Windowed attribution for finished runs: spread / adverse / wedge per book per
   window, persisted (mm_book_state currently writes 0 for fast books — fix so fast
   books persist real windowed values, not live-snapshot-only).
3. Hedge-leg realised P&L: persist per leg (currently in-memory, DR-2, only implied as
   desk-net − books-sum). The leak table must read true hedge P&L, not infer it.
   ALSO persist hedge.quality (basisShare/betaLive/r2 per book) hourly + on shutdown —
   run55's hedge-quality audit was impossible because the server was down before review.
4. HIP-3 (xyz:*) per-dex funding: wire it so the funding term is measured, not 0 by
   construction.
5. Queue tercile at fill and top-of-hour toxicity (±3min around funding prints): log
   per fill.
6. BUG: worst5m is wrong — kPEPE shows −3,033,717 against −127 net, SOL −20,416 against
   +25 net. Find the units/aggregation error (likely notional vs bps or un-normalised
   per-fill sum) and fix; add a sanity assert that |worst5m| ≤ |window net| × bound.
7. Leak-table additions: a PER-HOUR diagnostic strip (σ / VPIN / flow / fillEdge by hour —
   which hours pay us) and an ALIGNMENT split of fillEdge+markout by quadrant
   A = sign(q)·sign(flow) (A<0 vs A>0) — the calibration data F4's control law needs.

8. OBSERVABILITY (binding, see PART V requirement): persist the DeskEvent/decision tape
   to the DB so a finished run's automatic responses (regime transitions, blocked
   quotes, control/param changes) are auditable post-run from SQL, not only the log.

Backfill from run-20260611-172435-mm10h.log where possible. Add a `--self-check` flag to
the leak table that asserts every column is non-n/a for a finished run and fails loudly
if a persistence path regressed.
```

### F1 PROMPT — Hedge anti-churn *(biggest leak: −437, no signal needed)*
```
The hedge is the largest desk leak: run55 shows 56 hedge orders, 19 flips, $1.62M
churned, est taker cost −437, while implied hedge directional P&L is only ~−21. The
hedge is churning, not mis-positioned (part of the churn is loss-stop-induced: a stop
snaps the book delta to 0 → leg unwinds at taker → re-opens as the book rebuilds).
Cut churn with near-zero directional downside:

1. No-trade band on net beta-weighted delta: only rebalance when |net delta| exceeds a
   per-book band; hold inside it.
2. Min-hold / min-requote interval per hedge leg: no re-fire faster than T_min.
3. Flip cooldown: after a hedge direction flip, freeze further flips for cooldown_flip;
   also freeze hedge ADDS on a flow sign-flip (FLOW_REACTIVE_QUOTING.md §5). Emit a
   `FLOW ▸ flip` DeskEvent on the tape when book lean/flow changes sign (regime flips
   already hit the tape — this is the missing flip event).
4. Net-first: when the primary book flattens inventory (incl. the loss-stop), recompute
   net delta and let the band absorb it — never emit an opposing hedge leg in the same
   cycle as a primary flatten.
5. Basis gate per book: if basis quality is poor (basis ≳ basis_threshold) prefer
   flatten-primary over add-hedge. Given run55 basis (FARTCOIN ~100%, kPEPE/ADA high),
   default these to 'flatten'; SOL/SUI/DOGE/GOLD/CL to 'hedge'. Expose per-book.
6. DIAGNOSTIC: add a hedge variance-reduction report per book — realised variance of
   (primary + hedge) vs primary alone, against hedge cost. Surface books where the
   cross-hedge does not earn its churn so they can be moved to flatten-only.
7. OBSERVABILITY (binding, PART V requirement): every band-hold, min-hold skip, flip
   cooldown, freeze, net-first absorption and basis-gate decision emits a `HEDGE ▸` /
   `BLOCKED ▸` line + tape event WITH the triggering numbers (net delta vs band, time
   since last fire, basis%) — the run must be auditable without a debugger.

Keep directional coverage otherwise intact. Backtest on the run55 tape and report the
delta on the −437 churn line and on per-book net. Target: cut churn cost ≥50% without
worsening warehouse MTM.
```

### F2 PROMPT — Quote anti-churn *(fee leak: −229 taker)*
```
Taker fees are the second leak (−229 books-sum; xyz:CL pays +76 in fees on a −67 net
book — it is breakeven minus its own fee churn; NOTE part of CL's fees are its 3
loss-stop flattens). The quoter is crossing / re-quoting too often. Implement the
chatter-suppression machinery and diagnose the cause:

1. Hysteresis on requote: only move a quote when it would shift by > requote_min ticks;
   separate arm/disarm thresholds.
2. Dwell time: minimum lifetime per quote before cancel/replace.
3. Maker-bias: prefer passive repost over crossing unless a flatten rule (F4/§4)
   explicitly authorises a taker cross.
4. Instrument WHY CL crosses: log every taker fill with the trigger (requote race,
   inventory flatten, hedge, loss-stop, blackout) so the fee source is attributable per
   book per reason in the leak table — this separates "stop tax" from "requote churn".
5. OBSERVABILITY (binding, PART V requirement): suppressed requotes / dwell-holds emit
   rate-bounded `BLOCKED ▸` lines (count + reason on change, periodic summary line);
   every taker cross emits its trigger on the tape.

Backtest on run55 tape; report taker-fee delta per book. Target: CL fee line down
materially without giving back fill edge. Do not touch the hedge (F1 owns crosses
on that side).
```

### F3 PROMPT — Inventory skew *(warehouse / concentration leak: −95)*
```
Warehouse MTM bleeds on one-sided books: ADA −138 at 94% concentration, kPEPE −72,
FARTCOIN −71. DOGE proves the fix — 20% concentration, warehouse +104, net +59 despite
being picked off. The inventory mean-reversion term is too weak. Strengthen it:

1. Increase the inventory-skew gain in the GLFT reservation term so quotes lean harder
   to mean-revert |q|, scaled per book by realised vol and a concentration penalty that
   ramps as conc% rises past a soft band.
2. Asymmetric: skew the reducing side competitively to attract inventory-reducing fills;
   widen/cut size on the adding side as |q| grows.
3. Hard concentration cap per book: above conc_hard, stop quoting the adding side
   entirely (let it only reduce).
4. This is also where flow re-centering pays via the WAREHOUSE channel, not fill edge —
   but keep κ=0 here; F4 owns the flow term. This prompt is inventory-only.
5. LOSS-STOP SWEEP: with the stronger skew in place, sweep the loss-stop threshold
   (current prior 0.01% = $50) on the replay tape — run55 had 12 stops crystallising
   ~−$664; turn the prior into a measured curve (stop level vs realised + induced
   hedge churn vs warehouse saved) and pick per-book levels.
6. OBSERVABILITY (binding, PART V requirement): conc-cap suppressions emit `BLOCKED ▸`
   (book, conc%, side); skew-gain responses emit `CONTROL ▸` on change with q/conc/vol.

Backtest on run55 tape; report warehouse MTM and conc% per book, especially ADA/kPEPE/
FARTCOIN. Target: ADA conc < 70% and warehouse loss cut ≥50% without raising taker fees.
```

### F4 PROMPT — Flow-reactive quoting *(fill-edge leak: −99; throttle-first, κ gated)*
```
Now add the flow layer from docs/FLOW_REACTIVE_QUOTING.md (§1–§6). This SUPERSEDES the
binary S4 sweep gate (SweepRegimeDetector, |flow|>0.65 × drift — run55 showed it
wrong-shaped: kPEPE bled through 3 loss-stops with ZERO engagements while triggers all
fired marginally at 0.65–0.76). Build in two stages and DO NOT ship the directional
term until it is validated against the markout data persisted in F0.

Stage A — throttle-only (κ = 0):
- Implement FlowState (§1): EWMA f, persist, flip, T, A=sign(q)·sign(flow), ramp g, with
  hysteresis (θ_enter 0.40 / θ_exit 0.25) and min dwell.
- Apply ONLY the risk-throttle responses: toxicity spread widen (§2.2), asymmetric widen
  on the toxic side (§2.3), size cut on the toxic side (§2.4), and the regime machine
  (§3) with the hard invariant that flatten is reachable only when A<0 and HARVEST (A>0)
  never flattens.
- No directional re-centering yet (alpha = 0).
- Calibrate θ_enter/θ_exit/dwell per book by replay sweep (replaces the old 0.65/5bps
  binary-gate priors); the flatten inequality (§4) uses κ, τ_persist from F0 markouts
  and E[funding·τ] (absorbs old S5).

Stage B — directional κ, per book, GATED:
- Using the persisted per-fill markout (F0), regress forward markout on f per book.
- Enable the alpha = κ·f·g re-centering term (§2.1) ONLY for books where κ is
  statistically > 0; cap at κ_max with skew_max and jitter (anti skew-sniffing).
- Books that fail the test run throttle-only permanently (κ=0). Log the per-book decision.

OBSERVABILITY (binding, PART V requirement): every state transition logs the full
FlowState (f, T, A, q, persist, g); every re-center/widen/size-cut emits `CONTROL ▸` on
change; every flatten decision emits `FLATTEN ▸` with the §4 inequality's actual numbers
(drift_cost vs flatten_cost, qty chosen); auto-tune param moves emit `PARAM ▸` old→new
with the markout evidence. HARVEST entries/exits are tape events — the A>0 no-flatten
invariant must be assertable from the log alone.

Backtest both stages on run55 tape vs the post-F3 baseline. Report fill-edge
(picked-off) delta and ADVERSE per book. Gate to live: see validation gate table below.
```

### F5 PROMPT — Capital ∝ measured fillEdge
```
Weight per-book capital in scripts/launch-mm-10h.sh by measured fillEdge (multi-run,
shrunk toward equal-weight; floor for measurement, 0 for ledger rotate-outs), reading
the persisted leak-table history (F0). Run55 evidence: GOLD +6 / FARTCOIN +7 / SOL +5
green; SUI/kPEPE flat; ADA −16 (re-admission FAIL), DOGE −46, CL −51 red. Respect the
UNIVERSE_DISCOVERY ledger verdicts; the weighting must re-derive each run, not freeze.
Report the counterfactual run55 P&L under the new weights.
```

### Validation gates (per prompt, on replay vs immediately-prior baseline)

| prompt | pass condition |
|--------|----------------|
| F0 | leak table `--self-check` passes: no n/a on a finished run; worst5m sane; hedge P&L read from persistence not implied; per-hour strip + A-quadrant split render |
| F1 | hedge churn cost cut ≥50%; warehouse MTM not worse; variance-reduction report identifies flatten-only books |
| F2 | taker-fee line down materially (esp. CL); fill edge not worse; fee attributable per trigger |
| F3 | ADA conc < 70%; warehouse loss cut ≥50%; taker fees not up; loss-stop levels measured not prior |
| F4A | ADVERSE down; SPREAD capture given up < ADVERSE saved; zero flatten events in A>0 windows (assert) |
| F4B | per book: κ statistically > 0 or that book is κ=0 throttle-only; no directional skew shipped on an unvalidated book |
| F5 | counterfactual ≥ equal-weight on replay; no book above its ledger-status cap |

Whole-desk target after F0–F3 (cost + inventory, before any directional alpha): the −437
+ −229 + −95 buckets are where the recoverable money is. The −99 fill-edge bucket (F4) is
the smallest and the least certain — treat its P&L as a bonus, not the thesis.

---

## Appendix — parked items (do not build without a written mission change)

- Real fee-tier climbing, HYPE staking discount (+hedged stake), builder/referral codes — no
  real account on the paper mission; the rebate compounding loop doesn't exist on paper.
- Tokyo non-validating node / colocation — real infra serving live trading only. S7's
  stale-quote pricing keeps the decision evidence fresh if the mission ever changes.
- HIP-4 outcome-contract MM, options MM — different disciplines; revisit after this chain.
- Real-capital deploy loop — the mission is the paper demonstration (CLAUDE.md §1).
