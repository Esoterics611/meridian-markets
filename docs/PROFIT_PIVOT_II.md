# Profit Pivot II — the critical review + the carry-desk plan

> **Status: ADOPTED (operator, 2026-07-02) — now the ACTIVE plan.** Originally an outside-eyes
> critical review of the research record (QUANT_JOURNAL #41→#89, PROFIT_PIVOT, RESEARCH_FINDINGS,
> the Take Sides build) with one question: **where did we leave money on the table, and where is
> the money for real?** Everything cited is pinned to a journal entry. Execution state lives in
> the **§4 session ledger** below — updated at the end of every session so a fresh session can
> pick up cold.

---

## 0. The verdict up front

**The research was excellent. The capital allocation of *our own effort* was inverted.** The desk
spent ~40+ hours of live runtime and ~10 sessions of build on a strategy its own data kept scoring
realised-negative (passive spread MM, #41→#69), and **85 minutes** on the one strategy its own data
scored realised-positive with a structural driver (ETH funding carry, #72). It then diagnosed the
right pivot (#70, PROFIT_PIVOT) — and immediately expressed it as a *directional* desk (P1–P16)
whose own gate re-discovered that **the only validated signal is the carry sign** (#75) and whose
own book-level backtest was **negative** (#80, desk −$1,484) — after which six more infrastructure
phases were built on it anyway (#81–#87). Meanwhile the validated carry book has never existed as
a book: `funding-carry-live.ts` is a 180-line observer script, there is no `FundingCarryBook`
class, the 230-perp universe was never scanned (`rankCarryUniverse` exists and was pointed at 5
symbols), the cross-venue funding differential — named "a second, cleaner spread" in PROFIT_PIVOT
§T2 — was never measured, and the recency-veto gate fix that would have blocked the one carry loss
we took (#72 BNB) was identified the same day and never shipped.

And the single largest **validated, quantified, unexploited** edge in the repo is not carry at all:
it is the **options variance risk premium** — measured at **+5.9 vol pts on BTC / +3.7 on ETH with
our Greeks validated against Deribit** (#12), and confirmed *distributionally* by our own
gamma-overlay study: **short vol won 86.3% of 117 rolling 24h windows over 30 days** (#42 — the
study was framed as "long gamma loses," which is the same finding with the sign flipped, and nobody
flipped it). The Deribit client, the BS Greeks layer, and the vol-carry harness all exist in
`src/derivatives/`. It has been "in reserve" since Session ~20.

Since #89 (2026-06-17) **nothing has run at all** — fifteen days of a demo whose entire product is
a live track record. The mission is "steady, conserved returns over hours and days" (CLAUDE.md §1).
The deliverable is the curve. Every idle day is lost product, and idle-while-validated is a bug of
the same severity as a red build.

**Where the money is for real (ranked, honest):** a **cross-sectional funding-carry portfolio**
across the full HL universe as the core (our own measurements: ETH 8–11%/yr, BNB ~7%/yr on majors
alone; the alt cross-section is wider and gate-able); the **cross-venue same-symbol funding
differential** (HL↔Binance↔Bybit) as the cleanest near-zero-delta spread; a small **VRP short-vol
satellite** on Deribit paper (the highest-carry validated edge, with a known left tail the P11
stress harness was literally built to bound); and an event-driven **basis-convergence sleeve**
sized from the measured basis distribution instead of the a-priori 19bps threshold that never
fires. Spread-MM and the directional desk stay as recorders/benchmarks. Detail, numbers, and
sequencing below.

---

## 1. Where the previous model fell short (the case studies)

Each finding cites the desk's own record. These are process failures, not analysis failures — the
analysis was consistently right; the *follow-through* wasn't.

### R1 — Runtime allocation followed sunk cost, not realised P&L
Ten multi-hour spread-MM runs, every one realised-negative (#41→#68; BNB-solo ≈$0 at size, #69).
The strategy that produced the desk's only positive structural read — ETH carry, **+$18.13 net of
fees in ~85 minutes, funding rate stable at +0.125bps/h every single poll, ~10.95%/yr gross
running rate** (#72) — got those 85 minutes and was never restarted. The journal's own strategic
read that day: *"carry trade is the desk's core business."* The core business has 1.4 hours of
track record. **Rule change proposed in §4: winners get the hours; a validated edge left idle is a
§10.1-severity defect.**

### R2 — The pivot stopped one step short of its own conclusion
PROFIT_PIVOT's residual analysis (#70) is correct and well-argued: our edges are **holding
capacity** and the **two-venue view**. The correct expression of those edges is delta-neutral
carry/basis. What got built instead was the Take Sides desk — an *outright directional* book, i.e.
the full price-risk expression of the same funding signal. The desk's own 90d validated board then
said it plainly: *"the winning signal everywhere is the carry-sign"* — only BTC funding-paid-side
validated (#75). Taking the funding signal outright means collecting the same carry **plus**
uncompensated price variance: strictly worse Sharpe than harvesting it delta-neutral. The P8
book-level walk-forward confirmed: **0/2 books cleared, desk −$1,484** (#80). The honest response
to #80 was to stop and fold the effort back into carry; instead P9–P15 shipped after that read.
The infrastructure built (risk spine, TCA, tear-sheet, stress, persistence, watchdog) is genuinely
institutional-grade and **almost all of it is strategy-agnostic — §3 reuses it wholesale** — but it
was built on the wrong book.

### R3 — Breadth never happened, and breadth is where carry pays
Carry is a portfolio strategy: per-leg it is thin (~4–11%/yr on majors), noisy, and regime-flippy
(#72 BNB); across N gated legs the funding accrual compounds and the basis noise diversifies.
The tooling for breadth **exists**: `rankCarryUniverse` (funding-carry-oos.ts:138) batches over
any symbol list; `hl-universe-discovery.ts` already enumerates all ~230 HL perps with funding in
one `metaAndAssetCtxs` call. It was run over **five majors**. The alt cross-section — where funding
is routinely 5–20× the majors in hot regimes, exactly what the persistence gate exists to filter —
has never been scored.

### R4 — The cleanest spread in the plan was never measured
PROFIT_PIVOT T2 names the **HL↔Binance funding differential** "a second, cleaner spread." Long the
perp on the venue where funding is lower/negative, short it where higher: the underlying legs are
the *same asset*, so delta ≈ 0 and the only risk is the perp-perp basis. Both funding clients
(`BinanceFundingClient`, `HyperliquidFundingClient`) have existed for weeks. The differential
series has never been computed. Bybit was wired in P12 — **klines only**, no funding endpoint,
though its v5 API serves funding history the same way.

### R5 — A known loss-class was left open
The #72 BNB bleed (−$93 in 85min) was root-caused same-day: the 60d OOS gate smoothed over a
current negative regime. The fix was specified same-day — *"weight last 7d at 2× … or a hard
7d-avg veto"* — and marked **deferred**. It is still not shipped. It is a ~20-line change to
`oosCarryGate` plus a spec. Every future carry entry runs through this gate.

### R6 — The VRP: measured, distribution-validated, and parked for a month
#12 measured the premium (BTC IV 37.1 / RV 31.2 ⇒ **+5.9 vol pts**, short-straddle Θ ≈
$110/day/contract; ETH +3.7pts) with Greeks validated line-by-line against Deribit. #42 then ran
the distribution: across **117 rolling 24h windows / 30 days**, long gamma cleared its premium in
only 16 (13.7%) — i.e. **the short-vol side won 86.3% of windows**. That is a persistence read most
carry strategies never get, produced by our own harness — and because the question was framed as
"should the MM buy gamma as insurance," the answer was filed as a negative (long gamma loses)
instead of the positive it contains (short vol earns). RESEARCH_FINDINGS §5 has carried "validated,
in reserve" ever since. `src/derivatives/deribit/`, `src/derivatives/greeks/black-scholes.ts`,
`scripts/vol-carry-research.ts`, and `gamma-overlay-backtest.ts` all exist. The missing piece is a
book — the same gap as carry.

### R7 — The basis finding was measured, then dropped
T1's first live read (#71): HL trades at a **persistent −3.0 to −6.2bps discount** to Binance
across all five majors with σ < |mean| — *"structural discount, not noise."* Two follow-ons were
never taken: (a) the perp discount and positive funding are **one phenomenon** (a discounted perp
is one whose longs are being paid less / shorts more — the joint (basis, funding) state is the real
regime variable, and we monitor them separately); (b) T4's 19bps trigger was set a priori from
fee-math, not from the measured distribution — with mean −4bps / σ ~1bps, 19 never fires in normal
sessions (confirmed: zero signals). The right trigger is a per-symbol **z-score of the basis
against its own rolling distribution**, with the fee threshold as a floor, so the detector actually
samples the tail events (cascades, listings) it was built for.

### R8 — Execution-cost blindness on the slow books
The carry entries in #72 paid **$35 taker per $50k leg (7bps)** — and the entire "breakeven hold"
framing of carry (#8, PROFIT_PIVOT §T2) is driven by that one-time cost. Carry entries are
**latency-insensitive**: nothing about them needs a market order. The desk owns a maker-execution
engine — the entire MM quoting stack — that it spent ten runs trying to turn into a profit center
when its correct role is a **cost center reducer**: rest post-only quotes to *acquire the carry
position* at ≤0bps (HL maker rebate −0.2bps), with a timeout-to-taker fallback. Cutting 7bps to
~0 halves-to-eliminates every carry breakeven. Nobody connected the two systems.

### R9 — Two honesty gaps that flatter the pivot itself
For a desk whose whole game is honest numbers, the carry plan has two soft spots: (a) **no margin
model** — PROFIT_PIVOT lists "hold indefinitely, no margin call" as our edge, but a real
delta-neutral carry position posts margin on both legs and the short-perp leg can be liquidated in
a squeeze; paper must model a margin/leverage constraint or the demo overstates holding capacity.
(b) **T7 (the HLP benchmark) was never built** — so "does active carry beat passive HLP deposit?"
(the hurdle-rate question the plan itself poses) is unanswered. Both are cheap to fix and belong in
the first carry book, not after it.

### R10 — The meta-lesson
The honesty-gate culture is this desk's genuine moat — and it has a failure mode: **gates are
cheap and fast to build; track records are slow to earn; so the desk keeps building gates.** The
journal shows a near-perfect record of correct verdicts (#65 κ=0, #67 screen, #75 board, #80
book-level reject) followed by more construction rather than more *accrual*. The demo's product is
the curve. From here, the bias must be: **run the validated thing, build only what the running
thing needs.**

---

## 2. Where the money is for real (ranked, with honest numbers)

| # | Book | Edge / driver | Our own evidence | Honest expectation | Risk that bounds it |
|---|---|---|---|---|---|
| M1 | **Cross-sectional HL funding-carry portfolio** (core) | persistent one-sided funding; holding capacity; breadth | ETH +10.95%/yr gross live (#72); ETH 8.1 / BTC 4.5%/yr posFrac 75–88% (#8); 230-perp universe unscanned | **6–12%/yr on carry capital** at DD well under 1% with ≥8 gated legs + aggregate beta-hedge | funding regime flips (gated by R5 fix); perp-basis variance; crowding decay |
| M2 | **Cross-venue funding differential** (HL↔Binance↔Bybit, same symbol) | venue clienteles pay different funding on the same asset | named in PROFIT_PIVOT T2, never measured; both clients built | unknown until measured — the *cleanest* spread (delta ≈ 0, basis-of-perps only) | differential may be sub-fee on majors; needs the maker-entry (R8) to clear |
| M3 | **VRP short-vol satellite** (Deribit paper, delta-hedged short strangle/straddle) | variance risk premium — sellers paid for gap risk | **+5.9/+3.7 vol pts** measured, Greeks validated (#12); short side wins **86.3% of 117 windows** (#42) | high-single-digit %/yr on its sleeve, **fat left tail** — sized so a 3σ vol spike stays inside the DD budget | the 13.7% of windows where realised explodes; sizing is everything; P11 stress harness bounds it |
| M4 | **Basis-convergence sleeve** (event-driven, z-scored) | forced-flow dislocations (cascades, listings) overshoot and converge | basis distribution measured (#71); tails observed (XRP −13bps); JELLY case study (#70) | episodic, small; option-like payoff with capped size | fires rarely; convergence can lag; hard caps + loss-stop mandatory |
| M5 | **Stablecoin-peg / FX-stable basis, maker-routed** | the one structural crypto spread (RESEARCH_FINDINGS §2/§5) | reverts reliably, sub-fee for a taker ⇒ maker-only | small, steady; a DD-flattener for the demo curve | thin; needs the maker-execution service |
| — | HLP yield model (T7) | *benchmark, not a book* | never built | the hurdle: if M1–M3 can't beat it net, the honest demo says so | — |
| — | Spread-MM desk + Take Sides desk | *recorders/benchmarks* | #70 verdict stands; #80 verdict stands | zero — they earn their keep as controls and as the maker-execution substrate | — |

**What this portfolio's equity curve looks like** — which is the actual deliverable: M1 accrues
hourly (HL funding cadence) in small, steady increments; M2 the same with near-zero delta; M3 adds
a higher-carry stream with rare, bounded drawdowns; M4/M5 add episodic convergence gains. That is
"steady, conserved returns over hours and days" by construction, not by hope. A truthful outcome
of *"the accessible edge is carry, it is worth X%/yr at DD Y%, here is the live curve"* is mission
success (CLAUDE.md §1) — and for the first time X is positioned to be positive.

---

## 3. Smarter engine models (what to build — almost all of it is assembly)

The Take Sides build (P5–P15) accidentally produced the exact institutional spine the carry desk
needs. Reuse it wholesale; the new code is thin.

- **E1 — `FundingCarryBook` (the real one).** An `InventoryBook`-backed, two-leg, delta-neutral
  position with funding accrual on each leg, entry/exit through a fill-cost model, margin model
  (R9a), persistence via the existing `mm_nav` + state-store seam (`desk='carry'` namespace, the P6
  pattern), DeskEvents on the tape, tear-sheet (P14), watchdog + alerts (P15), and the desk-risk
  spine (P5) above it. `funding-carry-live.ts` remains the scout; the book is what runs for weeks.
- **E2 — Maker-execution service (R8).** One module: `acquirePosition(symbol, side, notional,
  urgency)` — rests post-only at/inside the touch via the existing quoting machinery, escalates to
  taker on timeout. Implementation shortfall measured per entry in TCA (P10's attributor already
  has fees/slippage lines). Every slow book (M1/M2/M4/M5) routes entries and rolls through it.
  This is the redemption arc for the MM stack: from failed profit center to the desk's execution desk.
- **E3 — Gate upgrades (R5).** Recency veto (7d-avg sign veto + 2× recency weighting) in
  `oosCarryGate` + a re-gate cadence (daily cron; reuse P6 `reconcileResume` — a leg whose gate
  drops today is orphaned/closed, the #72 lesson institutionalized).
- **E4 — Cross-venue funding board (R4).** Bybit funding ingest (mirror the two existing funding
  clients) + one script/module that joins the three venues' funding series per symbol and ranks
  differentials net of round-trip cost through E2. Measure first (a week of series), then trade the
  gated tails.
- **E5 — Joint basis+funding regime state (R7).** Extend `RegimeMonitor` with the (basisZ,
  fundingSide) joint state; T4's trigger becomes per-symbol z-score with the fee floor. Feeds M4
  and doubles as M1's stand-aside.
- **E6 — VRP book (M3).** Deribit paper short-strangle book on the existing Greeks layer: entry
  gate = IV−RV spread above threshold (the #12 measurement, kept live), delta-hedged via the
  existing hedge machinery, hard vega/gamma budget, sized by the P11 stress harness (flash-crash
  scenario must stay inside the desk DD budget), same persistence/tear-sheet spine.
- **E7 — The capital allocator.** Core (M1/M2) / satellite (M3) / sleeve (M4/M5) with vol-targeted
  weights and a desk DD budget — the "next big infra piece" MASTER_PLAN §5 already queued; the
  carry desk finally gives it real inputs. Start dumb (fixed 70/20/10), make it smart later.
- **E8 — T7 HLP benchmark.** A modeled HLP deposit curve (public vault APR series) rendered next to
  the desk curve on `/demo`. The hurdle, visible at all times.

**Explicitly NOT building:** more spread-MM levers; more directional signals; more gates without a
running book attached. §12 context discipline and §10.1 regression discipline unchanged.

---

## 4. The plan (phases, each with a pre-registered metric)

### 📌 SESSION LEDGER — the pickup point (update at the end of EVERY session)

> **Last updated: 2026-07-02 (session 2 of the plan — Journal #91).**
>
> **State:** **P0 steps 1–2 BUILT (#90); P1 items 1–3 BUILT & MEASURING (#91)** (7112c08 the
> 231-perp scan · 202b45c E2 maker execution · df29fcf Bybit + differential board). Repo green
> (tsc exit 0; touched-area jest 128 suites / 921 tests). Scan verdict: **68 gate-pass, 13
> deployable** (`GRAM,NEAR,LIT,DYDX,LINK,AAVE,XPL,UNI,PUMP,TAO,BNB,ENA,ZEC`) — the "≥8 gated
> legs" metric is fed. E2 live-smoked: 2/4 legs maker at 30s patience; BNB spot 0.9bps all-in
> (≤2bps metric met on maker legs); escalations now MEASURE the real half-spread (DYDX spot
> +11.65bps) instead of pretending mid. Differential board day 1/7: 7/30 harvestable, ADA
> HL↔Bybit −18%/yr @0.86 stable; majors sub-fee (R4 confirmed). **The 30-day launch — the
> OPERATOR'S — is still the next real event, now with breadth + honest entries.**
>
> **Pick up here (in order):**
> 1. **Operator launches the run** (P0 metric, P1 breadth): postgres + migrations, then
>    `CD_SYMBOLS=<the 13 deployables above> CD_MAKER_PATIENCE_S=300 MM_PERSIST=true
>    npx ts-node -r tsconfig-paths/register scripts/carry-desk-live.ts`.
>    Score each session from `mm_nav WHERE desk='carry'` + the TCA log lines.
> 2. **Daily:** `scripts/funding-differential-board.ts` (M2 needs ≥7 boards; 1 done) and a
>    `scripts/carry-universe-scan.ts` refresh for the deployable set.
> 3. **Next build session = finish P1:** item 4 — E7 allocator v0 (fixed weights) + aggregate
>    beta-hedge (`RegimeBetaHedge`, one BTC/ETH leg). Optional scouting: HL-only variants for
>    the no-spot passers (FARTCOIN/HYPE/PURR tail).
> 4. **Then P2:** E6 VRP book (see below). **Parked-but-pending:** the regime desk P16 forward
>    run (#88) — now a benchmark track, not the priority.
>
> **Do-not-relitigate:** the #65 κ=0 verdict; the #70 spread-MM verdict; realised-first judging;
> resume-not-flatten on the carry desk (#90); measurement-before-trading on M2 (#91 — 7 boards
> before any differential leg opens).

**P0 — Turn the validated edge on and leave it on (days, not weeks).**
1. ~~Ship E3 recency veto (+spec)~~ **DONE #90** — default-ON, trailing-7d mean, BNB case locked.
2. ~~Assemble E1 `FundingCarryBook` v1~~ **DONE #90** — book + margin model + persistence +
   `scripts/carry-desk-live.ts` (gate-first, daily re-gate, DD kill-switch, resume-not-flatten).
3. Launch under `MM_PERSIST` with alerts + tear-sheet and **leave it running 30 days**. This run is
   the demo. Operator launches (sandbox can't, per standing constraint). **← YOU ARE HERE**
- **Pre-registered:** rolling-7d net accrual (funding − all fees) > 0; desk maxDD < 0.5%; no
  ungated leg ever opens.

**P1 — Breadth (weeks 1–2, while P0 accrues).**
1. ~~`rankCarryUniverse` over the full ~230-perp HL universe~~ **DONE #91** — 2-stage
   rate-limit-aware scan, 231 perps, 68 pass / 13 deployable (spot + liquidity annotated).
2. ~~E2 maker-execution service; route all new entries/rolls through it~~ **DONE #91** —
   patient paths routed, urgent paths never wait, per-leg TCA; live-smoked.
3. ~~E4 Bybit funding ingest + the three-venue differential board~~ **BUILT #91** — measuring
   (day 1/7); differential legs stay closed until the week of boards agrees (M2).
4. E7 allocator v0 (fixed weights) + aggregate beta-hedge via the existing `RegimeBetaHedge` (one
   BTC/ETH leg flattens the cross-sectional book's residual delta). **← the remaining P1 item**
- **Pre-registered:** ≥8 gated legs live; desk carry rate ≥ 2× the P0 ETH-solo rate at ≤ 2× its
  realised vol; measured entry cost ≤ 2bps/leg via E2 (vs 7bps taker in #72).

**P2 — The VRP satellite (weeks 2–4).**
1. E6 VRP book, paper, small (≤20% of desk capital), delta-hedged, vega/gamma-budgeted.
2. Stress-gate before launch: P11 flash-crash + vol-spike scenarios must keep desk DD inside
   budget with the VRP sleeve at full size.
- **Pre-registered:** 30d net theta capture (premium − hedge costs − slippage) > 0; worst
  single-day sleeve loss < 1.5× its pre-registered stress estimate (else halve size).

**P3 — Convergence sleeve + the benchmarks (week 4+).**
1. E5 joint state monitor + z-scored T4; M4 entries capped + loss-stopped; measure convergence
   hit-rate paper-only for two weeks before sizing.
2. E8 HLP benchmark on `/demo`.
3. First monthly wrap: desk curve vs HLP vs BTC buy-hold, realised-first, published in the journal.
- **Pre-registered:** the wrap itself — an honest month of curve with attribution summing to the
  cent (the P10 invariant), whatever it shows.

**Operating rules (additions to MASTER_PLAN §7, proposed):**
- **R-A: Winners get the hours.** Runtime allocation follows realised P&L. A validated edge with
  no running book is a defect to be raised in the session log, same severity as a red build.
- **R-B: Build weeks are capped.** No session ships infra-only while zero books are accruing;
  every session either advances a running book or starts one.
- **R-C: A negative verdict halts its build chain.** (#80 → P9–P15 must not recur.) The next
  session after a failed pre-registered metric re-plans; it does not continue the chain.

---

## 5. Honest caveats (so this document doesn't over-claim either)

- **Paper flatters carry.** No counterparty risk, no liquidation engine, no margin funding cost,
  no borrow. E1's margin model narrows the gap but does not close it; the demo must say so on the
  tear-sheet. The numbers in §2 are *paper* expectations.
- **Carry decays and crowds.** Funding compresses as more capital harvests it; the 8–11%/yr ETH
  read is a 2026-06 snapshot, not a constant. The persistence gate + re-gate cadence is the defense,
  not a guarantee.
- **The VRP tail is real.** 86% win-rate strategies lose in lumps. The sleeve is small, budgeted,
  and stress-gated by design — if the stress harness says the size is wrong, the size is wrong.
- **M2 may be sub-fee on majors.** The differential has never been measured (that's R4); it earns
  a place in the plan as a *measurement first*, trade second.
- **One reviewer, one pass.** This document is itself a single read of the record. Where it
  disagrees with a standing verdict (none found — it disagrees only with *allocation*), the
  journal's gated verdicts win.

---

*Doc lineage: supersedes nothing; extends [PROFIT_PIVOT.md](PROFIT_PIVOT.md) (whose §0–§2 analysis
stands in full). Companion reading: [QUANT_JOURNAL.md](QUANT_JOURNAL.md) #64–#89,
[RESEARCH_FINDINGS.md](RESEARCH_FINDINGS.md) §4–§6, [MASTER_PLAN.md](MASTER_PLAN.md) §3.*
