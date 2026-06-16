# Regime Directional Book — Multi-Session Execution Playbook

> **What this is.** A copy-paste **session playbook** for finishing the standalone "take sides"
> strategy ([REGIME_DIRECTIONAL_BOOK.md](REGIME_DIRECTIONAL_BOOK.md)). Each numbered session below is a
> self-contained **PROMPT block** you paste into a fresh `claude` session in your Linux terminal. They
> are ordered, but each carries enough context to run cold. The emphasis throughout is **how a trader
> actually runs and watches this** — every session ships a *visual* deliverable (a clean terminal
> dashboard or a `/demo` cockpit panel), not just an engine change.
>
> **Status of the build:** P1 (the book core) is **done and committed** (commit `18e3310`, Journal #73).
> Sessions S1–S6 below take it from "unit-tested core" to "a trader-operable desk with a live track
> record." Companion docs: the spec is [REGIME_DIRECTIONAL_BOOK.md](REGIME_DIRECTIONAL_BOOK.md); the
> plain-English term list is [DESK_GLOSSARY.md](DESK_GLOSSARY.md) §3g; UI conventions live in
> [UI_ROLE_GUIDE.md](UI_ROLE_GUIDE.md).

---

## 0. How to use this playbook

1. **One session = one PROMPT block.** Open a terminal, `cd` to the repo, run `claude`, and paste the
   block verbatim. Each block tells the session what to read first, what to build, what the *trader*
   should see, the acceptance bar, and the commit instruction.
2. **Run them in order** (S1 → S6). S1–S3 are the engine + terminal tools; S4–S5 are the `/demo` web
   cockpit; S6 is the live forward-paper run that produces the demo's track record. S4 depends on S2/S3
   (it surfaces what they compute); S6 depends on everything.
3. **Each session ends green + committed** (CLAUDE.md §0 + §10.1): `npx tsc --noEmit` exit 0, the
   touched `jest` area green, one coherent commit with the `Co-Authored-By: Claude Opus 4.8` trailer.
4. **Paper-only, OOS-gated, realised-first** — the binding discipline. A signal that doesn't validate
   OOS trades nothing; that's a correct outcome, not a failure.
5. **You can stop after any session** — the repo is always shippable between them.

---

## 1. The product in one screen (the trader's mental model)

You are running a desk that **takes a side only when the data says it's obvious, and sits flat the rest
of the time.** Three questions drive every position, and the whole UI is built to answer them at a glance:

| Trader question | What answers it | Where they look |
|---|---|---|
| **"What am I even allowed to bet on today?"** | The **Validated Board** (S1) — per-symbol OOS verdict: did this signal predict forward return out-of-sample, after the multiple-testing haircut? | Regime Desk ▸ *Validated* table |
| **"What's the weather right now?"** | The **Regime Monitor** (S2) — per-symbol funding / basis / vol state, and an alert when it *flips* | Regime Desk ▸ *Weather strip* + Activity feed |
| **"How are my open bets doing, and how close am I to getting stopped out?"** | The **Live position cards** (S3/S4) — side, size, unrealised P&L, **distance-to-stop gauge**, conviction decay, funding | Regime Desk ▸ *Positions* |

The discipline the trader enforces by watching these: **only trade VALIDATED symbols, in FAVORABLE
weather, and respect the stop.** The engine does this automatically — the UI lets the trader *see it
happening* and intervene (FLATTEN / HALT) if they disagree.

---

## 2. What's already built (P1) — file map + how to run

**Built and committed (`src/market-making/directional/`):**
- `regime-directional-book.ts` — `RegimeDirectionalBook`: the position engine. Pure/clock-free; per
  `update(tick)` it sizes by conviction, applies the directional **stop** (preempts all), and
  exits on **decay / flip / stand-aside**. Owns an `InventoryBook`; accrues funding; emits `DeskEvent`s.
- `consensus-bias-source.ts` — `ConsensusBiasSource`: a view only when ≥k OOS-validated signals agree.
- `*.spec.ts` — 70 tests locking the acceptance criteria.

**Reuse map (do NOT rebuild these — they exist):**
- Signals + the `validated` honesty flag: `src/market-making/bias/` (`funding-bias-source.ts`,
  `flow-bias-source.ts`, `manual-bias-source.ts`; `bias-source.interface.ts` → `effectiveBias`).
- OOS gate: `src/market-making/bias/oos/forward-return-ic.ts` (`buildSignalForwardPairs`,
  `oosForwardReturnIc`, `verdictFor`, `biasMagnitudeCap`).
- P&L: `src/market-making/inventory/inventory-book.ts`.
- Regime inputs: `src/market-data/funding/funding-carry.ts` (`staticCarry`),
  `src/market-data/cross-venue/cross-venue-fair-value.ts` (basis), `src/market-making/risk/flow-regime.ts`.
- Funding/candle clients: `src/market-data/funding/hyperliquid-funding-client.ts`,
  `binance-funding-client.ts`; HL candles/L2 via `src/market-data/.../hyperliquid-client.ts`.
- Event tape: `src/market-making/events/desk-event.ts` + `desk-event-log.ts`
  (served at `GET /api/market-making/events?since=<seq>`, rendered on the `/demo` Activity feed).
- Equity curve: durable `mm_nav` table + `GET /api/market-making/nav` (`MM_PERSIST=true`).
- `/demo` console: `src/stat-arb/demo/public/index.html` (tabbed panels via `data-tab`), served on
  **:3100**. MM control plane: `src/market-making/mm.controller.ts` (`/api/market-making/*`).

**Run the desk (the trader's everyday command):**
```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false MM_PERSIST=true npm run start:dev
# → open http://localhost:3100/demo
```
**Run a research/live script (terminal tools, no server needed):**
```bash
npx ts-node -r tsconfig-paths/register scripts/<name>.ts
```

---

## 3. The trader's visual cockpit — the design every UI session builds toward

This is the **target** the web sessions (S4/S5) implement and the terminal sessions (S1/S3) mirror in
ASCII. Read it before building any UI so the pieces cohere.

### 3.1 A new `/demo` tab — "◆ Regime Desk" (`data-tab="regime"`)
Sits beside the existing Desk / Launch / Signal / MM tabs. Four stacked panels, top to bottom:

**(A) Weather strip** — one row per eligible symbol, the at-a-glance regime read:
```
BTC   Funding ● paid-short   Basis ● calm −3bp    Vol ● quiet     →  ✅ TRADEABLE
ETH   Funding ● paid-short   Basis ● calm −4bp    Vol ● rising    →  ✅ TRADEABLE
SOL   Funding ● flat         Basis ● calm −4bp    Vol ● SPIKE     →  ⛔ STAND-ASIDE
DOGE  Funding ● paid-long    Basis ● BLOWOUT 22bp Vol ● quiet     →  ⛔ STAND-ASIDE
```
- Each of the three cells is a **colored chip**: 🟢 green = favorable/calm, 🟡 amber = neutral/watch,
  🔴 red = adverse/blowout. The right column is the **overall verdict** the book acts on.
- **Color law (define once, reuse everywhere):** green = the book may take/hold a position; amber =
  hold only, no new entry; red = stand aside / flatten. This must match the engine's actual logic, not
  be cosmetic.

**(B) Validated board** — what the desk is *allowed* to bet on today (from S1's OOS gate):
```
SYMBOL  BEST SIGNAL        OOS IC   HIT%   DSR    VERDICT        CONV CAP   ELIGIBLE
BTC     funding-sign(8h)   +0.11    54%    0.97   VALIDATED      0.44       ✅
ETH     momentum(24h)      +0.08    53%    0.93   INCONCLUSIVE   —          ⛔
SOL     funding-sign(8h)   −0.01    49%    0.40   NOT_VALIDATED  —          ⛔
```
- Trader reads top-down: only ✅ rows can hold a position. The conviction cap (`biasMagnitudeCap`) is
  shown so they understand *why* a position is small.

**(C) Live positions** — one **card** per book that currently holds (or recently held):
```
┌ BTC ───────────────────────────── LONG ─┐
│  size   $44,000  (0.88 BTC)  conv 0.44   │
│  entry  50,120   mark 50,460   +0.68%    │
│  uPnL   +$299      funding +$12          │
│  STOP   ██████████░░░░░░░░  −0.7% / −2.0%│   ← distance-to-stop gauge (fills toward red)
│  bias   0.41 ↘ (decaying toward 0.07)    │
│  age    1h 12m         [ FLATTEN ]       │
└──────────────────────────────────────────┘
```
- The **stop gauge** is the single most important risk widget: a horizontal bar showing current
  drawdown as a fraction of the stop band. Green when far, amber past ~60%, red near the stop.
- `bias ↘` shows the view **decaying** — the trader anticipates a decay-exit before it happens.

**(D) Equity + alerts** — the regime desk's own NAV sparkline (from `mm_nav`, filtered to the regime
desk), a **maxDD** readout, and the regime-change **alert feed** (`REGIME ▸ BTC funding flipped
paid-short → paid-long` etc., from the Activity tape).

### 3.2 Top-strip badge
Add a badge next to the existing `desk-pnl` / `feed` / `venue` badges:
```
REGIME +$311 · 2 live · 1 aside
```
desk P&L (realised-first), books holding, books standing aside.

### 3.3 Safety controls (reuse, don't reinvent)
- **FLATTEN** (one book) and **HALT REGIME** (stand the whole regime desk aside) buttons, wired to the
  same flatten/close mechanism the MM desk uses (`/api/market-making/flatten` pattern).
- These mirror the existing `⚑ FLATTEN ALL` / `■ HALT ALL` affordances so the trader's muscle memory
  carries over.

---

## 4. The session prompts

> Paste one block per session. Each already says what to read, build, show the trader, and commit.

---

### S1 — P2: The Validated Board (the OOS gate + a trader-readable board)

```text
You are continuing the Meridian "take sides" build. Read first, in order:
  - CLAUDE.md (§0 git, §7 swap seams, §10.1 regression discipline, §12 token discipline)
  - docs/REGIME_DIRECTIONAL_BOOK.md (the spec; you are building its P2)
  - docs/REGIME_DIRECTIONAL_PLAYBOOK.md §1–§2 (the trader model + reuse map)
  - src/market-making/bias/oos/forward-return-ic.ts (the OOS gate you will REUSE — do not rebuild)
  - scripts/funding-carry-oos.ts (the script SHAPE to mirror)

GOAL: produce the "Validated Board" — per symbol, decide which directional signals actually predict
forward return out-of-sample, so only validated symbols are ever allowed to take a side.

BUILD:
1. src/market-making/directional/regime-signals.ts — a PURE library that, given a symbol's real
   history, builds the per-bar (signal, forwardReturn) pairs for each candidate signal:
     - funding-sign: sign/level of trailing funding (reuse staticCarry / FundingPoint).
     - momentum: trailing close-to-close return over a window.
     - (optional) flow: aggressor imbalance if trades history is available.
   Use buildSignalForwardPairs() from forward-return-ic.ts. Signals MUST be computed from data up to t
   only (no look-ahead) — the gate's correctness depends on it. Unit-test this with a synthetic series
   where the answer is known (a signal that IS the forward return must score a high IC; noise ~0).
2. scripts/regime-bias-oos.ts — fetches RBO_DAYS (default 90) of real history per RBO_SYMBOLS for each
   signal × horizon, runs oosForwardReturnIc() + verdictFor(), and prints a BEAUTIFUL terminal board:
   aligned columns SYMBOL | BEST SIGNAL | OOS IC | HIT% | DSR | VERDICT | CONV CAP | ELIGIBLE, sorted
   by IC, with ANSI color (green VALIDATED / amber INCONCLUSIVE / red NOT_VALIDATED). Pass the FULL
   trial count (symbols×signals×horizons) into the deflation so the haircut is honest. Print the
   pre-registered metric and the exact re-run command at the end.

TRADER-FACING OUTPUT: the board IS the deliverable a trader reads each morning to know "what can I bet
on today". Make it skimmable: the ELIGIBLE column is the verdict; everything else explains it.

ACCEPTANCE: tsc clean; jest src/market-making/directional green (incl. the new regime-signals spec);
the script runs against live HL/Binance history and prints the board. A symbol with no validated
signal shows ⛔ and is excluded — that is correct.

DISCIPLINE + COMMIT: per CLAUDE.md §10.1, then ONE commit on master:
  feat(directional): P2 regime-bias OOS validated board
  ...Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Add a QUANT_JOURNAL entry (#74) with the first real validated board (which symbols passed, their IC).
```

---

### S2 — P3: The Regime Monitor (the "weather", with change-alerts on the tape)

```text
You are continuing the Meridian "take sides" build. Read first:
  - CLAUDE.md (§7, §10.1, §12), docs/REGIME_DIRECTIONAL_BOOK.md, docs/REGIME_DIRECTIONAL_PLAYBOOK.md §3
  - src/market-data/funding/funding-carry.ts (staticCarry), src/market-data/cross-venue/cross-venue-fair-value.ts
  - src/market-making/risk/flow-regime.ts (the regime-machine PATTERN: pure, onTransition callback)
  - src/market-making/events/desk-event.ts (controlEvent — reuse for regime-change events)

GOAL: a per-symbol RegimeMonitor that classifies the live "weather" and FIRES an event when it flips.
This is the "monitor regime changes" deliverable AND the book's stand-aside source.

BUILD:
1. src/market-making/directional/regime-monitor.ts — PURE + clock-free (caller passes nowMs + reads),
   one instance per symbol. It classifies three sub-regimes, each into FAVORABLE / NEUTRAL / ADVERSE:
     - funding: sign + persistence of trailing funding (paid-short / flat / paid-long).
     - basis:   structural (|basis| small + stable) vs BLOWOUT (|basis| past a fee+margin threshold;
                reuse the CrossVenueBasisArbDetector threshold idea, ~19bp) ⇒ ADVERSE/stand-aside.
     - vol:     EWMA realised vol from recent returns; a SPIKE past a band ⇒ ADVERSE.
   It exposes: regimeState(symbol) → { funding, basis, vol, overall: TRADEABLE|HOLD_ONLY|STAND_ASIDE }
   and fires onRegimeChange(transition) ONLY on a sub-regime transition (hysteresis + dwell, like
   FlowRegimeMachine — no chatter). Wire onRegimeChange to a `REGIME ▸ <symbol> <what flipped>` event
   via the desk-event tape so it shows in the Activity feed.
2. Define the color law in ONE place (exported enum/const) so S4's UI chips match the engine exactly.
3. Unit-test: each sub-regime classifies correctly at boundaries; a transition fires exactly one event;
   a basis blowout / vol spike yields overall=STAND_ASIDE; quiet+paid yields TRADEABLE.

TRADER-FACING OUTPUT: the regime state object is what the Weather strip (S4) renders; the change events
are what the trader watches in the Activity feed ("BTC funding flipped"). Make the event MESSAGE a
plain-English sentence a non-quant understands.

ACCEPTANCE: tsc clean; jest src/market-making/directional green; STAND_ASIDE is reachable only from a
real adverse read (assert it). Wire nothing destructive — the monitor only READS and emits events.

DISCIPLINE + COMMIT: §10.1, then ONE commit on master (feat(directional): P3 regime monitor + change
events). Journal #75: the first live weather read across the validated symbols.
```

---

### S3 — P4: The Live Paper Runner (a terminal dashboard you can leave running)

```text
You are continuing the Meridian "take sides" build. Read first:
  - CLAUDE.md (§7, §10.1, §12), docs/REGIME_DIRECTIONAL_BOOK.md, docs/REGIME_DIRECTIONAL_PLAYBOOK.md §3
  - src/market-making/directional/regime-directional-book.ts (the book you will DRIVE)
  - src/market-making/directional/consensus-bias-source.ts, regime-monitor.ts (S2), regime-signals.ts (S1)
  - scripts/funding-carry-live.ts (the live-script SHAPE: gate first, then poll, then realised verdict)

GOAL: scripts/regime-book-live.ts — a forward-paper runner the trader leaves running for hours, with a
LIVE TERMINAL DASHBOARD that redraws each poll. This produces the track record.

BUILD:
1. GATE FIRST: run the S1 OOS gate; refuse any symbol that is not VALIDATED today (print why).
2. For each eligible symbol, build a RegimeDirectionalBook + a ConsensusBiasSource (funding + momentum
   + manual house-view slot) + a RegimeMonitor. Each poll: fetch mid + funding + basis, compute the
   consensus reading + the monitor's standAside, call book.update(tick), route fills through the paper
   path. Pass the OOS IC into the tick so conviction is IC-capped.
3. THE DASHBOARD (redraw in place each poll, ANSI): for each book a CARD matching PLAYBOOK §3.1(C):
   side (LONG/SHORT/FLAT, colored), size $/units, entry/mark, unrealised, funding, a DISTANCE-TO-STOP
   gauge built from block chars (█░) showing currentDD/-stopFrac, the live bias with a ↗/↘ decay arrow,
   and age. A header line: desk realised+unrealised P&L, maxDD, books live / aside. A footer: the
   regime weather strip (§3.1(A)) so the trader sees both position and context in one screen.
4. FINAL VERDICT (realised-first): total realised + funding − fees at session end, per book + desk,
   with the pre-registered success metric. Judge on realised, not unrealised marks.

TRADER-FACING OUTPUT: this is the trader's terminal cockpit when not on the web UI. It must be readable
at a glance and update without scrolling (redraw). The stop gauge is the hero widget.

ACCEPTANCE: tsc clean; jest green; the script runs live, opens conviction-sized paper positions on
validated symbols, shows the dashboard, applies the stop + stand-aside, and prints the realised verdict.
No orders on non-validated symbols.

DISCIPLINE + COMMIT: §10.1, then ONE commit (feat(directional): P4 live regime-book runner + dashboard).
Journal #76: the FIRST forward-paper numbers (realised P&L, maxDD, how many entries/stops fired).
```

---

### S4 — UI: the `/demo` Regime Desk cockpit (host the book in-process + the web panel)

```text
You are building the Meridian "take sides" WEB cockpit. Read first:
  - CLAUDE.md (§6 modular monolith, §7, §10.1), docs/REGIME_DIRECTIONAL_PLAYBOOK.md §3 (the full UI spec)
  - src/market-making/mm.controller.ts (the control-plane PATTERN: snapshot/nav/events endpoints)
  - src/market-making/live/mm-book.ts + the MmPortfolioTrader (how a book runs IN-PROCESS on the loop)
  - src/stat-arb/demo/public/index.html (the tabbed panels; you add data-tab="regime")
  - src/ui/render/risk-view.ts (render conventions)

GOAL: a live "◆ Regime Desk" tab on /demo that renders the cockpit in PLAYBOOK §3 from a real in-process
desk (not the standalone script).

BUILD:
1. ENGINE: a RegimeDeskTrader (analogue of MmPortfolioTrader) that hosts N RegimeDirectionalBook +
   RegimeMonitor on the existing live tick loop, behind the swap seams, off by default (a REGIME_DESK
   env flag / launch action — must not change any existing run). Persist its equity to mm_nav tagged as
   the regime desk so the curve is durable.
2. API: a controller (extend mm.controller or a sibling regime.controller) serving:
     GET  /api/regime/snapshot  → per-symbol regime state (weather) + validated board + position cards
     GET  /api/regime/nav       → the regime desk equity curve
     POST /api/regime/flatten   → flatten one book   ;  POST /api/regime/halt → stand the desk aside
   Regime-change + fill events already flow through the shared /api/market-making/events tape.
3. WEB PANEL (index.html + its JS): the data-tab="regime" section with the four panels from §3.1
   (Weather strip, Validated board, Position cards with the STOP GAUGE, Equity+alerts), the top-strip
   REGIME badge (§3.2), and FLATTEN / HALT buttons (§3.3). Use the EXACT color law exported by the
   regime-monitor (S2) — green/amber/red must mean the same thing the engine does. The stop gauge is a
   styled div bar; the equity curve reuses the existing sparkline helper.

TRADER-FACING OUTPUT: a trader with no terminal can run the whole strategy from this tab: see what's
tradeable, see the weather, watch each position's distance-to-stop, and flatten/halt. Polished, dense,
honest — match the look of the existing Desk/MM tabs.

ACCEPTANCE: tsc clean; jest green; with REGIME_DESK on, /demo shows the live cockpit updating each tick;
with it off, NOTHING about the existing desk changes (assert the default is inert). Verify visually:
launch a book, watch a card appear, watch the stop gauge move, hit FLATTEN and see it go flat.

DISCIPLINE + COMMIT: §10.1, then ONE commit (feat(ui): Regime Desk cockpit on /demo). Update
UI_ROLE_GUIDE.md with the new tab. Journal #77.
```

---

### S5 — UI polish + the operator runbook (alerts, gauges, honesty readouts)

```text
You are polishing the Meridian Regime Desk cockpit. Read first:
  - docs/REGIME_DIRECTIONAL_PLAYBOOK.md §3 + §5, docs/UI_ROLE_GUIDE.md, the S4 panel you are refining.

GOAL: make the cockpit a trader actually trusts under stress — clear alerts, honest readouts, no
ambiguity about risk.

BUILD (all additive, no behavior change to the engine):
1. ALERTS: a prominent banner when ANY held book crosses 60% of its stop band ("⚠ BTC at −1.3% / −2.0%
   stop"), and when a symbol's weather flips to STAND_ASIDE while holding ("⛔ SOL vol SPIKE — flattening").
   Pull from the same regime/fill events; do not invent new state.
2. STOP GAUGE polish: green→amber→red thresholds, a tick mark at the stop, the exact % under it.
3. CONVICTION DECAY: render the bias trail (last N readings) as a tiny sparkline per card so the trader
   SEES a view fading toward the exit band before it exits.
4. HONESTY READOUTS: on each card, separate REALISED vs UNREALISED P&L (never blend them in the headline
   number — realised is the truth, unrealised is a mark). Show funding as its own line. Desk header shows
   realised-first total + maxDD, matching the mm-run-review convention.
5. RUNBOOK: add docs/REGIME_DIRECTIONAL_PLAYBOOK.md §5 content into UI_ROLE_GUIDE.md as the "Regime Desk —
   how to run it" page: the daily routine, what each light means, when to FLATTEN vs HALT.

ACCEPTANCE: tsc + jest green; the alerts fire on a simulated stop-approach in a quick replay; realised
and unrealised are never conflated in the headline. Visual check on /demo.

DISCIPLINE + COMMIT: §10.1, ONE commit (feat(ui): Regime Desk alerts + honesty readouts + runbook).
```

---

### S6 — The forward-paper run (the demo's track record) + the honest write-up

```text
You are running the Meridian Regime Desk forward-paper session and recording it honestly. Read first:
  - docs/REGIME_DIRECTIONAL_BOOK.md, docs/REGIME_DIRECTIONAL_PLAYBOOK.md §5–§6, the mm-run-review skill.

DO:
1. Re-run the S1 OOS gate; record which symbols are VALIDATED today (regimes shift — never trust last
   week's board).
2. Launch the Regime Desk (web cockpit S4 with REGIME_DESK on, MM_PERSIST=true) OR scripts/regime-book-
   live.ts on the validated symbols, for a multi-hour window. Leave it running; watch the cockpit.
3. Use the mm-run-review skill to pull authoritative P&L from the DB (do NOT read the multi-MB log end-
   to-end — CLAUDE.md §12). Produce a realised-first scorecard: realised + funding − fees, maxDD,
   #entries, #stops fired, #stand-asides, which weather changes the desk reacted to.
4. Write QUANT_JOURNAL #78: the honest result. If it made money on validated symbols with tight DD,
   say so with the numbers. If the validated edge didn't show forward, say THAT — a flat, honest demo
   ("we sat aside; nothing validated") is the correct mission outcome, not a failure.

ACCEPTANCE: a committed journal entry with DB-sourced realised numbers and the maxDD. No inflated /
unrealised-led claims. Repo green + committed.
```

---

## 5. Trader runbook — how to actually run the desk day-to-day

**Morning (2 minutes):**
1. Run the **Validated Board** (S1) or open Regime Desk ▸ Validated. Note the ✅ symbols — that's your
   universe for the day. If nothing validates, **you trade nothing today.** That's allowed and correct.
2. Glance at the **Weather strip**. Any symbol already 🔴 (basis blowout / vol spike) is off the table
   even if validated.

**While running (watch, don't fiddle):**
- The desk enters/holds/exits on its own. Your job is to **watch the stop gauges** and the **alert
  banner**. Green gauges = relax. Amber = a position is working against you; the stop will handle it.
- When the Activity feed shows `REGIME ▸ <sym> flipped` or `⛔ STAND-ASIDE`, the desk is reacting to a
  weather change — confirm it flattened/stopped entering that symbol.
- A **decaying bias** (↘ on a card) means a position is on its way to a natural exit — expected, fine.

**When to intervene (rare):**
- **FLATTEN one book** if you have outside knowledge the model doesn't (news, a scheduled event) and
  want that single position off now.
- **HALT REGIME** if something is systemically wrong (feed looks stale, many symbols blowing out at
  once) — it stands the whole desk aside; positions flatten, no new entries.
- You should almost never need these — the stop + stand-aside are the automatic version of them.

**Reading the numbers honestly (the whole point):**
- The **headline P&L is realised + funding − fees.** Unrealised is a *mark*, shown separately, never
  the headline — an open position's paper gain is not money until it's closed.
- **maxDD** is the number that proves "conserved, low-drawdown returns." A small realised P&L with a
  tiny maxDD beats a big unrealised number with a scary drawdown.

---

## 6. Honesty checklist (applies to every session)

- [ ] An **unvalidated** signal sizes **zero** — never bypass the gate to "see it trade."
- [ ] **STAND-ASIDE** is reachable only from a real adverse regime read (not cosmetic).
- [ ] The **stop** is evaluated before the slow exits (a blown view is cut by the stop, by construction).
- [ ] UI **color law** matches engine logic exactly (green/amber/red mean what the book does).
- [ ] Headline P&L is **realised-first**; realised and unrealised are never conflated.
- [ ] Each session: `tsc` clean, touched `jest` green, ONE commit, a journal entry. Paper-only.
- [ ] If the edge doesn't validate or doesn't show forward, the honest write-up says so. Honesty is the
      whole game.
