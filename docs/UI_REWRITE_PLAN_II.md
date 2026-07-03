# UI Rewrite Plan II — the continuation: put the flagship desk on screen

*2026-07-03. Successor to the shipped role-scoped rewrite ([UI_ARCHITECTURE.md](UI_ARCHITECTURE.md),
[UI_ROLE_GUIDE.md](UI_ROLE_GUIDE.md)); the 2026-05-31 [archive/UI_REWRITE_SPEC.md](archive/UI_REWRITE_SPEC.md)
is historical. Written plan-first (Ronnie, 2026-07-03) so any session — including a
cheaper implementation pass — can build it mechanically. Doctrine unchanged and binding:
thin read-only views over the engine, server-rendered partials + SSE + vanilla Web
Components, no SPA, no fabricated numbers, honest empty states.*

---

## 0. Where the rewrite stands

Shipped and live: `/` launcher, `/exec`, `/ops`, `/desk/mm`, `/desk/statarb`, `/risk`,
`/research` (+ later additions `/desk/markout`, `/desk/toxicity`), the component kit
(`<desk-feed>` SSE swap, `<desk-action>` writes, `<desk-form>`, `<nav-spark>`,
`<activity-tape>`, `<copy-cmd>`), and the pure-render test discipline (every page =
controller + `render/*-view.ts` + spec). That architecture won; nothing below changes it.

## 1. The gap, from first principles

The UI's one job is to be the **supervisory surface** over the engine — the screen that
answers "what is the desk doing, and is anything wrong?" Judge it by that job and the
priority is obvious:

**The desk that matters most has no page.** Since PROFIT_PIVOT_II (#90, 2026-07-02) the
flagship P0 strategy is the **funding-carry desk** — the 30-day forward run that *is*
the demo. It postdates the UI docs, runs as a separate supervised process
(`carry-desk-live.ts`), and its only surfaces today are a log file and `psql`. The #92
incident is the cost of that gap, stated precisely: the run died at t+9.6h and **sat
3h+ with eight open books and nobody could tell without querying the DB**. Meanwhile a
ticker-collision book bled four digits and was found only by an offline review.

Both #92 failures are, at root, *visibility* failures, and both are one query away from
a screen: `carry_book_state.updated_at` ages tell you the desk is alive or down;
`mm_nav WHERE desk='carry'` is the equity curve. The data is already persisted — the
rewrite's continuation starts by projecting it.

Priority also follows the plan's own operating rule R-A (*winners get the hours*): the
running, accruing desk gets the page before any refinement of desks that aren't the
demo.

## 2. U1 — `/desk/carry` (build first)

**Read-only.** The carry runner is a separate OS process; the Nest app must not pretend
to control it. The page's "actions" are `<copy-cmd>` helpers for the real controls:
`bash scripts/launch-carry-30d.sh` / `status` / `stop`, and
`CCB_SYMBOL=<sym> … scripts/carry-close-book.ts` for an out-of-band close.

### Data sources (both already persisted by the runner)

| Source | Provides |
|---|---|
| `carry_book_state` | one row per book: symbol, direction, gate %, entry time, `status` OPEN/CLOSED, `state` JSONB (funding, fees, legs, realised), `updated_at` = last checkpoint |
| `mm_nav` `desk='carry'` | equity curve: `@carry` = desk aggregate, `@carry:SYM` per book; realised/unrealised/fees/funding columns; maxDD |

### Liveness — the #92 lesson as a UI element

The runner checkpoints every poll (60s). So define, in one pure function
(`classifyCarryLiveness(newestUpdatedAt, now)`):

- **LIVE** — newest OPEN-book `updated_at` < 3 min old.
- **STALE** — < 15 min (missed polls; investigate).
- **DOWN** — older, with the age printed ("last checkpoint 3h12m ago") in red, plus the
  copy-command to relaunch. No open books + no recent nav ⇒ **IDLE** (not an error).

This banner is the headline element of the page. It is the exact thing that would have
screamed during the #92 stall.

### Page layout (terminal idiom, dense)

1. **Status strip:** liveness banner · realised-first (funding + realised − fees, the
   judged number) · funding accrued · fees · basis MTM · desk maxDD vs the 0.5% kill
   budget · open books n/cap.
2. **NAV panel:** `<nav-spark>` pointed at the `@carry` aggregate (needs the nav
   endpoint to accept the carry namespace — see API below).
3. **Books table:** one row per `carry_book_state` row, OPEN first then recent CLOSED:
   symbol · direction · gate% at entry · age · funding · fees · realised-first ·
   basis MTM (OPEN, from latest `@carry:SYM` nav row) or final realised (CLOSED) ·
   last-checkpoint age. CLOSED rows stay visible — the LIT close is *supposed* to be
   seen, not buried (honesty doctrine).
4. **Runbook palette:** `<copy-cmd>` for launch/status/stop/close-book + a pointer to
   [TICKER_COLLISION_POSTMORTEM.md](TICKER_COLLISION_POSTMORTEM.md) for what the
   collision guard refuses and why.

### Engine surface (new, read-only)

- `CarryReadService` — lives with its data: `src/market-making/carry/carry-read.service.ts`,
  exported from `MarketMakingModule`. Injects the app `DataSource` (DatabaseModule is
  global); queries the two tables; returns typed rows. **DB unreachable ⇒ returns a
  `dbOff` flag and the page says "persistence off / DB unreachable" — never a fake.**
- `GET /api/carry/state` — JSON: liveness + books + desk aggregates (the API twin of
  the page, per the business-event-logging rule: every live surface machine-readable).
- `GET /desk/carry` + `GET /desk/carry/stream` (SSE, 5s — data only changes per 60s
  checkpoint; 5s keeps the liveness banner honest without load).

### Files (follow the `markout-desk` pattern, the newest exemplar)

```
src/market-making/carry/carry-read.service.ts        (+ .spec.ts — SQL-free unit tests
                                                       via a stubbed DataSource; an
                                                       .int-spec.ts against :5433)
src/ui/carry-desk.controller.ts                       (+ .spec.ts)
src/ui/render/carry-desk-view.ts                      (+ .spec.ts — pure render fns:
                                                       liveness banner states, books
                                                       table incl. CLOSED row, empty/
                                                       dbOff states)
src/ui/render/landing-view.ts                         (add the launcher tile)
docs/UI_ROLE_GUIDE.md                                 (new §: /desk/carry)
```

### Pre-item (hygiene, 10 minutes)

`postgres-carry-state-store.int-spec.ts` leaked its fixture row (`ITA5NED7`, CLOSED,
plus one `@carry:ITA5NED7` nav row) into the real paper DB. Fix the spec to clean up
after itself (delete by its own symbol in `afterAll`) and delete the stray rows once.
Filter nothing in the read service — with the leak fixed there is nothing to hide.

### Acceptance

- With the runner up: strip shows LIVE, books tick each checkpoint, curve grows.
- Kill the runner: banner flips STALE→DOWN with the age; nothing else pretends.
- With LIT's CLOSED row: the table shows it with realised **+$268.29** — visible,
  labelled closed.
- `npx tsc --noEmit` clean; new specs green; no existing spec touched.

## 3. U2 — the fund view knows both desks

`/exec` today reads only `MmPortfolioTrader.snapshot()`. The executive page should show
the **fund** = MM desk + carry desk: add a carry summary strip (from `CarryReadService`)
next to the MM aggregate, and the `/` launcher tile. Explicitly *not* merged into one
curve — different capital bases and cadences; two honest curves beat one synthetic one
(same reasoning as realised-first judging).

## 4. U3 — ordered backlog (unchanged items from the role guide's §10 caveats)

1. **`/research` live funding board** — serve the newest
   `docs/research/funding-differentials/board-*.json` + carry-universe scan (now with
   basis%/collision tags) as a read-only board. Cheap, high-signal, measurement-first.
2. **`/risk` soft pause/deny + limit-lowering** — needs the engine endpoint
   (`POST /api/market-making/risk/{pause,limit}`) first; UI follows.
3. **Per-book `<nav-spark>` sparklines** in desk cards (endpoint already filters by book).
4. **Mode-aware blotter + desk-aggregate drawdown** refinements.
5. **`/pm` Thesis Register** — still endpoint-blocked; waits on the engine surface.
6. **Retire `/demo`** (UI_ARCHITECTURE §9) once the stat-arb console reaches parity —
   call it explicitly in a session, don't let it rot half-alive.

## 5. Notes for the implementing session

- Copy the idiom, don't invent one: `markout-desk.controller.ts` +
  `render/markout-desk-view.ts` + their specs are the newest complete example of a
  read-only page with an SSE stream.
- All markup through the `html``` tagged template (auto-escaping); money/percent via
  `render/format.ts`; components documented in UI_ARCHITECTURE §4.
- §10.1 discipline applies: render functions are pure and spec'd (including the DOWN
  and dbOff states — the honest states are the ones that matter); `tsc` + touched-area
  jest before commit; journal the ship.
- Do not add a write path to the carry page. If a future session wants in-app carry
  control, that is an *engine* design decision (the runner would need a control plane),
  not a UI one.
