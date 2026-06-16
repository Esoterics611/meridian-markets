# Regime Directional Book — Playbook II: Institutional-Grade + Universe Expansion

> **What this is.** The continuation playbook that takes the standalone "take sides" desk from a
> committed P1–P4 core (book + gate + monitor + live runner) to an **institutional-grade paper desk** —
> the peak of the quant desk in paper, *before* any production/real-money decision. Each phase below is a
> self-contained **PROMPT block** you paste into a fresh `claude` session. They are ordered, carry enough
> context to run cold, and each ends **green + committed** (CLAUDE.md §0/§10.1).
>
> **Two locked decisions (operator, 2026-06-16):**
> 1. **Scope = institutional-grade.** Close every demo-blocker AND build desk-level risk aggregation,
>    factor/beta decomposition, TCA, and a scenario/stress harness. Paper-only throughout (no real money).
> 2. **Exposure = a toggle.** Build BOTH the outright book and a beta-hedged / market-neutral mode,
>    switchable via env/UI; **default outright**, flip to hedged to compare the two track records.
>
> **Headline expansion (operator ask):** *expand the universe* — more symbols, more validated signals,
> more venues (perp-DEX CLOBs + DEX), and a **cross-sectional ranking** gate that allocates to the top-N
> validated edges. This is P12 and is the point of the whole exercise; the desk-risk spine (P5–P10) exists
> so a larger universe is *safe*.
>
> **Test discipline (operator):** do NOT test phase-by-phase. Build the whole remaining set, keep the repo
> green + committed at every phase, then run the single all-at-once test at the end (P16).

---

## 0. How to use this playbook

1. **One phase = one PROMPT block = one commit.** `cd` to the repo, run `claude`, paste the block verbatim.
2. **Run in order P5 → P16.** They're modular but the dependencies below are real (risk spine before
   universe; hosted desk before web cockpit; slippage before the book-level backtest).
3. **Every phase ends green + committed:** `npx tsc --noEmit` exit 0, the touched `jest` area green, ONE
   coherent commit on `master` with the `Co-Authored-By: Claude Opus 4.8` trailer, and a `QUANT_JOURNAL`
   entry (#77+). Paper-only, OOS-gated, realised-first — the binding discipline.
4. **Read first, every session:** `CLAUDE.md` (§0 git, §6 monolith, §7 swap seams, §10.1 regression, §12
   token discipline), `docs/REGIME_DIRECTIONAL_BOOK.md` (the spec), this file's §1 (current state + reuse map).

---

## 1. Current state + reuse map (what already exists — do NOT rebuild)

**Built + committed (P1–P4, journals #73–#76):**
- `src/market-making/directional/`:
  - `regime-directional-book.ts` — `RegimeDirectionalBook`: pure/clock-free outright position engine
    (`update(tick)`), conviction sizing (IC-capped), directional **stop** (preempts all), decay/flip/
    stand-aside exits, funding accrual, `snapshot(mid)`, emits `DeskEvent`s via `onEvent`.
  - `consensus-bias-source.ts` — `ConsensusBiasSource(sources, {minAgree, vetoOnConflict})`: a view only
    when ≥k OOS-validated signals agree; vetoes on internal conflict.
  - `regime-signals.ts` — pure no-look-ahead signal library (`funding-paid-side`, `momentum`); the SINGLE
    home of the signal definitions shared by gate + live runner.
  - `regime-board.ts` — the shared scorer: `scoreRegimeBoard` + `bestPerSymbol` + `validatedSignalsPerSymbol`.
  - `regime-monitor.ts` — `RegimeMonitor`: per-symbol weather (funding/basis/vol → TRADEABLE/HOLD_ONLY/
    STAND_ASIDE), hysteresis+dwell, fires `regimeChangeEvent`. **Color law exported once**
    (`REGIME_LEVEL_COLOR`/`REGIME_OVERALL_COLOR`) — the UI must reuse it.
- `src/market-making/bias/`: `funding-bias-source.ts`, `momentum-bias-source.ts`, `manual-bias-source.ts`
  (`setView`), `bias-source.interface.ts` (`effectiveBias` = THE gate), `oos/forward-return-ic.ts`
  (`oosForwardReturnIc`, `verdictFor`, `biasMagnitudeCap`).
- `scripts/`: `regime-bias-oos.ts` (the morning Validated Board), `regime-book-live.ts` (the live
  forward-paper runner + terminal cockpit — gate-first, conviction-sized, stop+stand-aside, realised-first
  verdict). Env knobs are `RBL_*` / `RBO_*`.

**Reuse from the rest of the desk (copy the pattern, don't reinvent):**
- **Hedge / delta:** the MM desk's perp delta-hedge + `HEDGING_MODEL.md` + `hedgeEvent` (desk-event.ts).
- **Persistence:** durable `mm_nav` table + `GET /api/market-making/nav` + `MM_PERSIST` (P3 telemetry).
- **Web cockpit:** `src/market-making/mm.controller.ts` (snapshot/nav/events endpoints pattern),
  `MmPortfolioTrader`/`MmBook` (how a book runs IN-PROCESS on the live tick loop), `src/stat-arb/demo/
  public/index.html` (tabbed `data-tab` panels), `src/ui/render/risk-view.ts`, `docs/UI_ROLE_GUIDE.md`.
- **Execution realism:** `HistoricalReplayVenue` (half-spread + linear impact + short-borrow carry) and
  `LobReplayHarness` (FIFO queue-aware fills) in `src/market-making/` — the slippage/impact model to adapt.
- **Risk + attribution:** `CompositeRiskGate` (Allow/Deny/Pause), `FlowRegimeMachine`, `PnlAttributor`
  (the 4-component attribution to mirror for TCA).
- **Venues + data:** `HyperliquidClient` (candles/L2/funding), `BinancePublicClient`, `GeckoTerminalClient`
  (DEX, 100+ chains), funding clients; the venue ledger is `docs/DATA_SOURCES.md`.
- **Events:** `desk-event.ts` (now has a `regime` kind) + `desk-event-log.ts` (served at
  `/api/market-making/events`, rendered on the `/demo` Activity feed).
- **Honest stats:** `deflated-sharpe.ts` (`sharpeStats`, `deflatedSharpe`), `purged-kfold.ts`.

**Run the desk today:**
```bash
# Morning board: RBO_DAYS=90 RBO_SYMBOLS=BTC,ETH,SOL,BNB,XRP,DOGE,ADA npx ts-node -r tsconfig-paths/register scripts/regime-bias-oos.ts
# Live runner:   RBL_SYMBOLS=… RBL_HOURS=6 RBL_BASE_NOTIONAL_USD=50000 npx ts-node -r tsconfig-paths/register scripts/regime-book-live.ts
```

---

## 2. The phases

> Order matters where noted. Each block is self-contained. Commit + journal each. Keep paper-only.

---

### P5 — Desk risk spine: kill-switch, exposure caps, manual controls, flatten-on-exit

```text
You are continuing the Meridian "take sides" build (Playbook II). Read first: CLAUDE.md (§0,§7,§10.1,§12),
docs/REGIME_DIRECTIONAL_BOOK.md, docs/REGIME_DIRECTIONAL_PLAYBOOK_II.md §1, scripts/regime-book-live.ts,
src/market-making/risk/composite-risk-gate.ts, src/market-making/directional/regime-directional-book.ts.

GOAL: a DESK-LEVEL risk layer so one bad book can't sink the desk, plus the manual "react" controls the
terminal runner lacks today (Ctrl-C currently abandons paper positions instead of flattening).

BUILD:
1. src/market-making/directional/regime-desk-risk.ts — a PURE RegimeDeskRisk(config): each tick it ingests
   per-book {notionalUsd, side, realisedPnl, unrealisedPnl} and enforces, in order: (a) GROSS and NET
   exposure caps (USD); (b) a DAILY-LOSS LIMIT (realised+funding−fees below −X ⇒ HALT the desk); (c) a
   desk maxDD circuit breaker (peak-to-trough beyond Y% of capital ⇒ HALT). It returns a verdict per book
   (Allow / BlockNewEntry / FlattenNow) + a desk verdict (Run / Halt). Pure + unit-tested at the boundaries.
2. Wire it into regime-book-live.ts: before each book.update, consult RegimeDeskRisk; on FlattenNow/Halt set
   standAside (and force-flatten via a 0-target tick). Add a FLATTEN(symbol) + HALT(desk) you can trigger
   (env RBL_FLATTEN / RBL_HALT for the script, or a keypress handler), emitting controlEvent on the tape.
3. GRACEFUL SHUTDOWN: on SIGINT, FLATTEN every open book (book the realised exit at mid+fee), print the
   realised-first verdict, THEN exit. No paper position is ever left dangling/unrealised at shutdown.

ACCEPTANCE: tsc clean; jest src/market-making/directional green incl regime-desk-risk.spec (caps fire at the
boundary; daily-loss HALT flattens all; a halted desk opens nothing). Ctrl-C flattens + books realised.
COMMIT: feat(directional): P5 desk risk spine — caps, kill-switch, flatten-on-exit. Journal #77.
```

---

### P6 — Durable persistence + restart recovery (the track record survives)

```text
Read first: CLAUDE.md (§3 DB, §7, §10.1), docs/REGIME_DIRECTIONAL_PLAYBOOK_II.md §1, the mm_nav usage in
src/market-making (GET /api/market-making/nav, MM_PERSIST), database/ + migrations/.

GOAL: the regime desk's equity curve + open positions survive a crash/restart — an unrecoverable paper run
is not a track record.

BUILD:
1. Persist the regime desk equity to mm_nav TAGGED as the regime desk (reuse the table + writer; add a
   desk/source tag so the curve is filterable from the MM desk's). Gate behind MM_PERSIST as elsewhere.
2. A durable position/state snapshot (a small table or append-only journal) so on restart the runner
   reloads each book's inventory, avg-cost, realised, funding, and entry time, and RESUMES rather than
   re-opening from flat. Idempotent + append-only (CLAUDE.md §3 discipline).
3. On boot, reconcile: if a snapshot exists for today's validated set, resume it; else start flat. Print
   what was recovered.

ACCEPTANCE: tsc clean; jest green (a save→load round-trip reproduces the book state exactly; the #47
rehydrate trap MUST have a regression test). Integration spec auto-skips without Postgres (§10).
COMMIT: feat(directional): P6 durable regime-desk persistence + restart recovery. Journal #78.
```

---

### P7 — Execution realism: slippage + market-impact on the paper fill

```text
Read first: CLAUDE.md (§7,§10.1), src/market-making/.../historical-replay-venue.ts (half-spread + linear
impact + borrow), src/market-making/directional/regime-directional-book.ts (fills at mid+takerFee today).

GOAL: honest paper fills. Frictionless mid-fills overstate the edge; model slippage + impact so the
realised P&L is credible.

BUILD:
1. Give RegimeDirectionalBook a pluggable fill-cost model (interface): default = today's mid+takerFee
   (no regression), plus a SlippageImpactModel(halfSpreadBps, linearImpactPerNotional) that worsens the
   fill price by half-spread + impact·(size/ADV or size/depth). Reuse the HistoricalReplayVenue cost math.
2. Expose it via RBL_SLIPPAGE_BPS / RBL_IMPACT_* in the runner and a fillModel in the ctor. Attribute the
   slippage cost separately in the snapshot (so TCA in P10 can read it).

ACCEPTANCE: tsc clean; jest green (a fill with the model costs strictly more than mid+fee; size 0 ⇒ no
cost; the default model is byte-identical to today — assert no regression). 
COMMIT: feat(directional): P7 slippage + impact fill model. Journal #79.
```

---

### P8 — Book-level backtest / replay (backtest↔live parity — the honesty piece)

```text
Read first: CLAUDE.md (§7,§10.1,§12), docs/REGIME_DIRECTIONAL_PLAYBOOK_II.md §1, regime-board.ts,
regime-book-live.ts, src/stat-arb/research/* (purged-kfold, deflated-sharpe), regime-directional-book.ts.

GOAL: validate the STRATEGY's realised P&L, not just the signal IC. The OOS gate proves the signal predicts
forward return; this proves the BOOK (gate→consensus→size→stop→fees→funding→slippage) actually makes money
after costs, on out-of-sample history.

BUILD:
1. scripts/regime-book-backtest.ts — replays the EXACT live logic over real history: walk the bars, at each
   step recompute the consensus reading + monitor standAside from data up to t only (reuse regime-signals +
   regime-monitor), call book.update with the P7 fill model, accrue funding from the real funding tape.
   Run a WALK-FORWARD: gate on a train window, trade the next test window, roll. No look-ahead.
2. Output a realised-first scorecard per symbol + desk: realised+funding−fees−slippage, maxDD, #entries,
   #stops, hit rate, exposure, and the deflated Sharpe of the realised per-trade stream (multiple-testing
   haircut over the universe×signal grid). Write a JSON artifact under docs/research/.
3. The pre-registered bar: the book is "validated" only if its walk-forward realised Sharpe clears the
   deflated bar AND maxDD stays in budget — distinct from (and stricter than) the signal's IC gate.

ACCEPTANCE: tsc clean; jest green (a synthetic series with a known edge + a known stop produces the
expected realised sign + the stop firing; no look-ahead asserted). The script runs on live HL/Binance
history and prints the walk-forward scorecard.
COMMIT: feat(directional): P8 book-level walk-forward backtest. Journal #80 with the first realised numbers.
```

---

### P9 — Exposure toggle: outright ⇄ beta-hedged / market-neutral

```text
Read first: CLAUDE.md (§7,§10.1), docs/HEDGING_MODEL.md + the MM desk's perp delta-hedge + hedgeEvent
(desk-event.ts), regime-book-live.ts, regime-directional-book.ts.

GOAL: the operator's locked decision — build BOTH exposure modes behind a toggle (default OUTRIGHT), so a
desk that is long several alts can optionally hedge its net crypto-beta and express only the signal's
idiosyncratic edge.

BUILD:
1. src/market-making/directional/regime-beta-hedge.ts — a PURE hedger: from the per-book net signed
   notional + each symbol's beta to a hedge instrument (default BTC or ETH perp; estimate beta from
   trailing returns), compute the perp leg that flattens the desk's net beta. Emit hedgeEvent on rebalance.
2. Toggle: RBL_EXPOSURE=outright|hedged (default outright). In hedged mode the runner maintains the hedge
   leg each poll (band/min-rebalance to avoid churn), books its funding+fees, and reports BOTH the gross
   (book) and net-of-hedge P&L so you can compare the two track records side by side.
3. The hedge is itself paper (a PaperVenue-style perp leg) and must cover EVERY non-flat book (the
   coherence check: no naked net beta in hedged mode — assert it).

ACCEPTANCE: tsc clean; jest green (hedged mode drives net desk beta → ~0; outright leaves it; the hedge
covers all books; rebalance respects the band). 
COMMIT: feat(directional): P9 exposure toggle — outright vs beta-hedged. Journal #81.
```

---

### P10 — Desk risk aggregation + factor decomposition + TCA

```text
Read first: CLAUDE.md (§7,§10.1), src/market-making/.../pnl-attributor.ts (the 4-component attribution to
mirror), regime-desk-risk.ts (P5), regime-beta-hedge.ts (P9), regime-book-live.ts.

GOAL: see the desk like a risk manager — portfolio heat, factor exposure, and where every basis point of
P&L came from.

BUILD:
1. Portfolio risk read: gross/net exposure, per-symbol + desk realised-vol, a simple parametric VaR (or
   historical), and the factor split — crypto-BETA P&L (from the hedge/market move) vs IDIOSYNCRATIC P&L
   (the signal's own edge). Surface it in the runner header + the snapshot.
2. TCA: a RegimeTcaAttributor that decomposes each book's P&L into directional(idiosyncratic) + funding +
   beta(hedged-away or carried) + fees + slippage, reconciling to the realised total to the cent (assert
   the reconciliation). This is the PnlAttributor analogue for the directional desk.
3. Render: a desk-level attribution line (e.g. "realised +$X = dir +$A + funding +$B − fees −$C − slip −$D
   ± beta ±$E") + per-book TCA in the verdict.

ACCEPTANCE: tsc clean; jest green (the attribution sums EXACTLY to realised; beta vs idio split is correct
on a constructed case; VaR/heat at boundaries). 
COMMIT: feat(directional): P10 desk risk aggregation + factor split + TCA. Journal #82.
```

---

### P11 — Scenario / stress harness

```text
Read first: CLAUDE.md (§10.1,§12), regime-book-backtest.ts (P8), regime-desk-risk.ts (P5), regime-monitor.ts.

GOAL: prove the desk behaves under stress before you trust it — flash crash, simultaneous vol spike,
funding flip across all symbols, a stale/gapped feed.

BUILD:
1. scripts/regime-stress.ts — injects scenarios into the replay (a −15% gap, a vol×5 spike on all symbols,
   a funding sign flip, a feed blackout) and asserts the desk's response: stops fire, the monitor flips to
   STAND_ASIDE, the desk-risk kill-switch HALTs when the daily-loss/maxDD breaches, and the realised maxDD
   stays inside the 2% budget (or HALT engages). Output a stress scorecard.
2. Lock the key responses as jest assertions (the stress harness is also a regression guard): a flash crash
   never breaches the budget without a HALT; a vol spike yields STAND_ASIDE on every held book.

ACCEPTANCE: tsc clean; jest green (each scenario asserts the expected protective response). Script runs +
prints the stress scorecard.
COMMIT: feat(directional): P11 scenario/stress harness. Journal #83.
```

---

### P12 — UNIVERSE EXPANSION (the headline): more symbols, signals, venues, cross-sectional ranking

```text
Read first: CLAUDE.md (§6,§7,§10.1,§12), docs/DATA_SOURCES.md, docs/REGIME_DIRECTIONAL_PLAYBOOK_II.md §1,
regime-signals.ts, regime-board.ts, src/market-data/* (HyperliquidClient, GeckoTerminalClient, funding
clients), src/market-making/bias/flow-bias-source.ts.

GOAL: expand what the desk can take sides on — this is the point of the build. More symbols, more validated
signals, more venues, and a CROSS-SECTIONAL ranking gate that allocates capital to the top-N validated
edges instead of an equal split.

BUILD (each new signal MUST be a pure, no-look-ahead addition to regime-signals.ts with a known-answer spec,
and MUST pass the same OOS gate before it can size anything — no exceptions):
1. SYMBOLS: widen the default universe (more majors + liquid alts; add HL perp-DEX symbols). Keep the gate
   honest — most won't validate, that's correct.
2. SIGNALS: add candidate signals beyond funding-sign + momentum: basis-carry (cross-venue), aggressor-flow
   imbalance (reuse flow-bias-source / L2), realised-vol carry, and a CROSS-SECTIONAL momentum/rank signal
   (rank symbols by trailing return; long the top, short the bottom). Each enters defaultRegimeSignalSpecs +
   the OOS board.
3. VENUES: add at least one more perp-CLOB behind IReferenceBarSource/IL2BookSource (dYdX / Drift / Bybit /
   OKX) and wire DEX pools via GeckoTerminalClient as eligible markets. Document each in DATA_SOURCES.md.
4. CROSS-SECTIONAL ALLOCATION: a RegimeUniverseAllocator that, given the board's validated set + each
   edge's IC + the desk's capital + the P5 exposure caps, allocates to the TOP-N by conviction (capital
   budgeting, not equal split), respects per-symbol + gross/net caps, and feeds the runner the sized set.

TRADER-FACING: the board (P2) now ranks a bigger universe; the runner trades the top-N validated edges,
beta-hedged or outright per P9, capped by P5. Show the allocation (symbol → capital → why) in the cockpit.
ACCEPTANCE: tsc clean; jest green (each new signal has a no-look-ahead known-answer spec; the allocator
respects caps + top-N; an over-budget request is trimmed, not breached). Scripts run on the wider universe.
COMMIT: feat(directional): P12 universe expansion — signals, venues, cross-sectional ranking + allocator.
Journal #84 with the first wide-universe validated board (which symbols/signals/venues passed).
```

---

### P13 — The `/demo` web cockpit (Regime Desk tab) — host the desk in-process

```text
Read first: CLAUDE.md (§6,§7,§10.1), docs/REGIME_DIRECTIONAL_PLAYBOOK.md §3 (the full UI spec — reuse it),
src/market-making/mm.controller.ts, MmPortfolioTrader/MmBook, src/stat-arb/demo/public/index.html,
src/ui/render/risk-view.ts, docs/UI_ROLE_GUIDE.md, regime-monitor.ts (REUSE the exported color law).

GOAL: a live "◆ Regime Desk" tab on /demo so a trader with no terminal can run + watch + intervene.

BUILD:
1. ENGINE: a RegimeDeskTrader (analogue of MmPortfolioTrader) hosting the books + monitor + desk-risk (P5) +
   hedge (P9) on the existing live tick loop, behind a REGIME_DESK env flag, OFF by default (assert nothing
   about existing runs changes). Persist equity to mm_nav (P6).
2. API: GET /api/regime/snapshot (weather + validated board + position cards + risk/exposure + TCA),
   GET /api/regime/nav, POST /api/regime/flatten (one book), POST /api/regime/halt (desk). Regime + fill
   events already flow on /api/market-making/events.
3. WEB PANEL (index.html data-tab="regime"): the four panels from PLAYBOOK §3.1 — Weather strip, Validated
   board, Position cards WITH the STOP GAUGE (the hero widget), Equity+alerts — plus the top-strip REGIME
   badge, FLATTEN/HALT buttons, and the exposure toggle. Use the EXACT exported color law.

ACCEPTANCE: tsc clean; jest green; with REGIME_DESK on, /demo shows the live cockpit; with it off, nothing
about the existing desk changes (assert inert default). Verify visually: a card appears, the gauge moves,
FLATTEN goes flat.
COMMIT: feat(ui): P13 Regime Desk cockpit on /demo. Update UI_ROLE_GUIDE.md. Journal #85.
```

---

### P14 — Reporting: the tear-sheet vs a benchmark

```text
Read first: CLAUDE.md (§10.1,§12), src/stat-arb/research/deflated-sharpe.ts, the mm-run-review skill,
regime-book-live.ts / mm_nav.

GOAL: prove the demo honestly — a QuantStats-style scorecard, benchmark-relative.

BUILD:
1. src/market-making/directional/regime-tearsheet.ts — from the equity curve (mm_nav / the run): Sharpe,
   Sortino, maxDD + duration, hit rate, avg win/loss, exposure, turnover, and the return VS A BTC BUY-HOLD
   BENCHMARK over the same window (excess return + correlation/beta to it). Realised-first.
2. Print it at session end (and serve it on the cockpit). Persist the report JSON.

ACCEPTANCE: tsc clean; jest green (metrics correct on a known curve; benchmark-relative numbers correct;
realised never blended with unrealised in the headline). 
COMMIT: feat(directional): P14 regime tear-sheet vs BTC benchmark. Journal #86.
```

---

### P15 — Feed-health watchdog + alerting

```text
Read first: CLAUDE.md (§7,§10.1), regime-monitor.ts (the feedStale input — nothing computes it today),
src/market-making/events/desk-event.ts.

GOAL: data-integrity protection + one alert channel so a trader away from the screen still gets warned.

BUILD:
1. A FeedWatchdog: detects stale ticks (no update within N×poll), price gaps/outliers (|Δ| past a band),
   and cross-venue divergence (HL vs Binance past a band). It drives the monitor's feedStale ⇒ STAND_ASIDE.
2. An alert sink (behind an interface, default no-op): fire on stop-hit, desk HALT, feed-stale, and DD-budget
   breach via ONE channel (webhook/Slack env URL). Reuse the desk-event tape as the source — do not invent
   new state. Off by default; enabled by env.

ACCEPTANCE: tsc clean; jest green (watchdog flags stale/gap/divergence at the boundary; the alert sink fires
exactly once per triggering event; no-op default = no behavior change). 
COMMIT: feat(directional): P15 feed watchdog + alerting. Journal #87.
```

---

### P16 — The all-at-once test: the multi-hour forward run + the honest write-up

```text
Read first: docs/REGIME_DIRECTIONAL_BOOK.md, docs/REGIME_DIRECTIONAL_PLAYBOOK_II.md, the mm-run-review skill.
This is the SINGLE end-to-end test the operator asked for — run only after P5–P15 are all green + committed.

DO:
1. Re-run the wide-universe OOS gate (P12); record today's validated set (regimes shift — never trust a
   stale board).
2. Launch the full desk: web cockpit (P13, REGIME_DESK on, MM_PERSIST on) OR scripts/regime-book-live.ts
   with the institutional stack — desk-risk (P5), persistence (P6), slippage (P7), exposure toggle (P9, run
   BOTH outright and hedged for the comparison), TCA (P10), watchdog+alerts (P15) — on the validated set for
   a multi-hour window. Watch the cockpit; let the controls/stops work.
3. Use the mm-run-review skill to pull authoritative P&L from the DB (do NOT read the multi-MB log end to
   end — §12). Produce the realised-first tear-sheet (P14): realised+funding−fees−slippage, maxDD, hit rate,
   #entries/#stops/#stand-asides, the factor split (beta vs idiosyncratic), and the outright-vs-hedged
   comparison, all vs the BTC benchmark.
4. Write QUANT_JOURNAL #88: the honest result. If it made conserved, low-drawdown money on the validated set
   — say so with the DB numbers. If the edge didn't show forward, say THAT. A flat, honest "we sat aside /
   the edge didn't survive costs" is the correct mission outcome, not a failure.

ACCEPTANCE: a committed journal entry with DB-sourced realised numbers + maxDD + the tear-sheet, no inflated
or unrealised-led claims. Repo green + committed. This is the peak-paper milestone before any production
decision (which remains PARKED — CLAUDE.md §1).
```

---

## 3. Dependency notes (so a cold session sequences correctly)

- **P5 (risk spine) before P12 (universe):** never widen the universe before desk-level caps + kill-switch
  exist — a bigger universe with no desk risk is how a paper demo blows its drawdown budget.
- **P7 (slippage) before P8 (backtest):** a backtest with frictionless fills is dishonest; the parity proof
  needs the cost model.
- **P5 + P9 before P13 (web):** the cockpit hosts the desk-risk + hedge it surfaces; build the engine first.
- **P6 (persistence) before P16:** the all-at-once run's track record must be recoverable + DB-sourced.
- Everything stays **paper-only, OOS-gated, realised-first** (CLAUDE.md §1). Production/real-money is PARKED.
