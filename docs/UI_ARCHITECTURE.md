# UI Architecture — role-scoped, server-rendered desk

> **Status:** decided + six slices shipped (2026-06-06…07): **`/exec`** (read-only),
> **`/ops`** (first action page), **`/desk/mm`** and **`/desk/statarb`** (the two rich
> desk consoles), **`/risk`** (drawdown/exposure/verdicts + cross-desk kill switch), and
> **`/research`** (static findings/KEEP-CUT board + the copy-the-runbook-command helper,
> no execution). This is the design the [UI_REDESIGN_PROMPT.md](UI_REDESIGN_PROMPT.md) brief asked for:
> the chosen stack (with the trade-off recorded), the route map, the shared-component
> inventory, the SSE feed list, the action⇄API map, and the module layout — plus the
> vertical slices that prove the stack (read path, write path, forms + tape + blotter)
> end-to-end, and the **migration plan** to retire the 100KB `/demo` `index.html`.

This document is the contract for the redesign. Read it before adding a role page.

---

## 1. The doctrine this UI obeys (binding)

From [CLAUDE.md](../CLAUDE.md) §1/§6/§10 and the brief's non-negotiables:

- **The UI is a thin read-only view over the engine.** The NestJS server owns the
  truth; the browser renders it and holds **no business state**. No number on screen
  is computed in the browser — every cell traces to an engine endpoint.
- **No React, no SPA, no separate frontend build/service.** Served by the existing
  Nest app. Light, terminal-aesthetic (dark, monospace, dense, fast).
- **Honest + paper-only.** No mock data in a live view. The nav tells the truth about
  what's built (unbuilt pages render as disabled launcher entries, not dead links).
- **Modular + testable.** Server-rendered fragments are pure functions → unit-tested
  (`render → assert HTML`), so the UI rejoins the test discipline the monolith
  `index.html` had escaped.

---

## 2. Chosen stack (and why — the §4 trade-off, recorded)

| Layer | Choice | Note |
|---|---|---|
| **Page render** | **Nest server-rendered partials** via small pure TS functions + an auto-escaping `html\`\`` tagged template (`src/ui/render/html.ts`) | The "A" spine from the brief. The server emits HTML; the browser swaps it. |
| **Live transport** | **SSE** (`@Sse`), native `EventSource` on the client | The "E" choice — push, not 4s polling. The event tape / NAV / health are *streams*. |
| **Shared widgets** | **Native Web Components** (vanilla custom elements), one file each | The "C" choice — real reuse across role pages, zero framework lock-in. First one: `<desk-feed>`. |
| **Styling** | **One hand-rolled terminal CSS** (`src/ui/public/ui.css`) | The "F" choice — on-brand, small, no CSS framework. |
| **Actions (write path)** | **vanilla `<desk-action>` Web Component** → POST existing control-plane endpoints | Decided at `/ops` (see below). Not htmx. |

### Why **no template engine** (Eta/Handlebars/EJS) and **no htmx/Alpine library yet**

The brief's default recommendation was *htmx + a template engine + Alpine sprinkles*.
After building the first page the honest refinement is: **the read-only pages need
none of those libraries.**

- A **template engine** buys nothing over a 40-line auto-escaping tagged template,
  and a tagged template keeps the render functions **pure TS** — directly
  unit-testable and type-checked against the engine's snapshot types. Adding a
  dependency would *reduce* testability and type-safety here. So: hand-rolled.
- **htmx** was the brief's recommendation for the action pages. When we built the
  first one (`/ops`) the test was concrete: htmx's value is `hx-post → server
  returns an HTML fragment → swap it in`. But our **control-plane endpoints return
  JSON** (a desk snapshot), not HTML fragments — so htmx doesn't fit without
  inventing HTML-returning *wrapper* endpoints (more surface, duplicated render).
  The better fit, given we already push the live region over SSE: an action button
  just **POSTs to the existing validated endpoint**, and the page's `<desk-feed>`
  stream reflects the new state within one tick. That's a ~40-line vanilla
  `<desk-action>` Web Component — matches `<desk-feed>`, zero dependencies, fully
  testable. So **htmx is not adopted**; the write path is `<desk-action>`. (If a
  future page genuinely needs fragment-swap-on-post, revisit then.)
- **Alpine** is for genuinely local interactivity (a thesis editor, a launch form).
  Same rule: add it (a single static file) when a page actually needs it, on a short
  leash, kept out of the read-only pages.

This is a deliberate deviation from the brief's library list, made to honour the
brief's deeper goal — *light, thin-client, testable* — more faithfully. The libraries
aren't rejected; they're **deferred to the page that needs them** so we never ship a
dependency a page doesn't use.

**Rejected outright (recorded):** a SPA framework (React/Vue/Svelte + Vite) — fights
the thin-view doctrine, needs a build/deploy pipeline, drifts business logic to the
client. `xterm.js` as the primary metaphor — too heavy for aesthetics; allowed later
*only* for the one read-only log/console pane if the terminal feel is worth the weight.

---

## 3. Route map — one URL per role (replaces `/demo`)

Each page injects the engine service that owns its data and renders it server-side.
"Drives" lists the **existing** control-plane endpoints a page's action palette will
call (see §6); read-only pages drive nothing.

| URL | Role | Data source(s) | Drives (curated actions) | Status |
|---|---|---|---|---|
| `/exec` | Executive | `MmPortfolioTrader.snapshot()` | — (read-only) | **shipped** |
| `/ops` | Operator | readiness probe + `MmPortfolioTrader.snapshot()` (process/feed/DB health, tick freshness, persistence, MM desk) | start/stop/flatten the MM desk | **shipped** (MM scope; stat-arb desk panel + cross-desk kill switch deferred — §8) |
| `/desk/mm` | MM desk | `MmPortfolioTrader.snapshot()` + the MM `DeskEventLog` (per-book quotes/inventory/attribution + Activity tape) | launch/stop/remove/reconfigure a book | **shipped** |
| `/desk/statarb` | Stat-arb desk | `LivePortfolioTrader.snapshot()` + stat-arb `DeskEventLog` + `StatArbRepository` (per-pair z/β/regime/position, blotter, tape) | launch/stop/remove/reconfigure a pair | **shipped** |
| `/risk` | Risk | `MmPortfolioTrader.snapshot()` + MM `DeskEventLog` (drawdown vs budget, exposure, adverse-selection toxicity, verdict transitions) | stop/flatten (per desk) + remove (per book); cross-desk kill switch | **shipped** (pause/deny + limits still an endpoint gap — §6) |
| `/research` | Quant | curated findings (from `docs/RESEARCH_FINDINGS.md` + CLAUDE.md §8) + doc links — static | **no exec** — copy-the-runbook-command helper (`<copy-cmd>`) | **shipped** (live funding board / screener deferred — no endpoint) |
| `/pm` | PM / house view | Thesis Register *(not built — §6)* | add/edit/close a thesis | future |
| `/` | launcher | static | — | planned |

A shared **top bar** (brand, role launcher, clock) is on every page; the live numbers
live in each page's SSE-refreshed region. A shared **Activity tape** component
(reads `…/events`) is the next shared widget after `<desk-feed>`.

---

## 4. Shared-component inventory

| Component | Kind | File | Status | Reuse |
|---|---|---|---|---|
| top bar + role launcher | server partial | `src/ui/render/layout.ts` (`topBar`, `pageShell`) | **shipped** | every page |
| `<desk-feed>` | Web Component | `src/ui/public/desk-feed.js` | **shipped** | every page (point at its `/…/stream` + region) |
| money/pct/units formatters | pure TS | `src/ui/render/format.ts` | **shipped** | every page |
| `html\`\`` + escaping | pure TS | `src/ui/render/html.ts` | **shipped** | every render fn |
| `<desk-action>` | Web Component | `src/ui/public/desk-action.js` | **shipped** | the write path on ops/desk/risk/pm |
| `<desk-form>` | Web Component | `src/ui/public/desk-form.js` | **shipped** | any input form (launch book, launch pair, add thesis) |
| `<copy-cmd>` | Web Component | `src/ui/public/copy-cmd.js` | **shipped** | the runbook copy helper (research; any "copy a command" surface) |
| desk controls + Activity tape | server partials | `src/ui/render/components.ts` (`deskControls`, `statArbControls`, `activityTape`) | **shipped** | ops, desk/mm, desk/statarb (+ risk next) |
| `<nav-spark>` (equity sparkline) | Web Component | _planned_ | — | exec/ops/desk |

**`<desk-feed src target>`** is the one live-update (read) primitive: it opens an SSE
connection to `src` and swaps each pushed HTML fragment into `#target`. The server
renders `#target` for a correct first paint, then `<desk-feed>` keeps it live. It
holds no business logic — it only swaps server markup.

**`<desk-action endpoint label variant confirm body>`** is the one action (write)
primitive: it renders a button that POSTs to an existing, validated control-plane
endpoint, manages only button affordance (disable while in-flight, flash ok/err),
and lets the `<desk-feed>` stream show the result. `confirm` gates destructive
actions (the flatten kill switch, a per-book remove) behind a browser confirm
dialog; `body` carries a fixed JSON payload (e.g. the symbol to remove).

**`<desk-form endpoint label>`** wraps server-rendered `[name]` inputs/selects: on
submit it collects them into a JSON body (number inputs coerced, empty fields
dropped), POSTs the endpoint, and **surfaces the engine's own `{error}`** (these
endpoints answer `200 {error:"…"}` on bad input) so the operator sees *why* a launch
was rejected. Both `<desk-action>` and `<desk-form>` live **outside** the SSE region
so a tick doesn't re-create them mid-interaction (a per-book remove button is the one
exception — it rides inside a card; the in-flight `fetch` still completes if the card
re-renders, and the book vanishing from the cards is the real confirmation).

---

## 5. SSE feed list

| Endpoint | Pushes | Cadence | Status |
|---|---|---|---|
| `GET /exec/stream` | the `/exec` live region (NAV, P&L, drawdown, per-book table) | 2s | **shipped** |
| `GET /ops/stream` | health/readiness/tick-freshness + MM desk + persistence panels | 2s | **shipped** |
| `GET /desk/mm/stream` | desk summary + per-book quotes/inventory/attribution cards + Activity tape | 2s | **shipped** |
| `GET /desk/statarb/stream` | desk summary + per-pair z/β/regime/position cards + Activity tape (blotter is page-load only) | 2s | **shipped** |
| `GET /risk/stream` | drawdown/exposure headline + per-book risk table + verdict-transition feed | 2s | **shipped** |
| _(none — `/research` is static)_ | `/research` is research artifacts + terminal commands, not live state — no stream by design | — | n/a |
| `GET /<page>/events/stream` | a dedicated, append-mode Activity tape (cursor-based) | on event | planned (tape ships today inside the desk streams, full-replace) |

Frame shape (all feeds): `data: {"html":"<fragment>"}`. The HTML is sent **inside a
JSON object on purpose** — `JSON.stringify` escapes newlines, so a multi-line
fragment can't break SSE's newline framing. The client does
`JSON.parse(ev.data).html`.

---

## 6. Action ⇄ API map (for the action pages)

The brief's verdict (§5) — **no embedded shell.** Action pages get a **curated action
palette** (buttons → existing, validated control-plane endpoints) + a **copy-the-
runbook-command** helper for terminal-only jobs (capture/tune/sweep). A read-only SSE
log pane is the optional later "watch it run" view. Never a free-form shell (it's an
RCE surface and breaks the "research runs from the terminal" rule).

Wired today on `/ops` + `/desk/mm` (✅) via `<desk-action>`/`<desk-form>`.

| Page | Action | Endpoint (exists today) |
|---|---|---|
| `/ops` ✅, `/desk/mm` ✅ | start desk | `POST /api/market-making/start` |
| ✅ | stop desk | `POST /api/market-making/stop` |
| ✅ | flatten (kill switch) | `POST /api/market-making/flatten` (confirm-gated) |
| `/desk/mm` ✅ | launch / reconfigure book | `POST /api/market-making/launch` `{symbol,strategyId?,source?,capitalUsdc?,quoteNotionalUsd?}` (re-launch replaces) |
| ✅ | launch a preset | `POST /api/market-making/launch-preset` `{presetId,capitalUsdcPerBook?}` |
| ✅ | remove book (per-card) | `POST /api/market-making/remove` `{symbol}` (confirm-gated) |
| | (read) catalogue | `GET /api/market-making/strategies`, `/markets`, `/screen` (strategies+presets feed the launch form) |
| `/desk/statarb` ✅ | start / stop desk | `POST /api/stat-arb/live/portfolio/start|stop` |
| ✅ | flatten (kill switch) | `POST /api/stat-arb/live/portfolio/flatten` (confirm-gated) |
| ✅ | launch / reconfigure pair | `POST /api/stat-arb/live/portfolio/launch` `{symbolA,symbolB,beta?,strategyId?,source?,capitalUsdc?,notionalUsdc?}` |
| ✅ | remove pair (per-card) | `POST /api/stat-arb/live/portfolio/remove` `{pair:"A/B"}` (confirm-gated) |
| ✅ (read) | persisted blotter | `StatArbRepository.recentTrades('paper', n)` (page-load; needs Postgres) |
| `/risk` ✅ | de-risk / cross-desk kill | `POST /api/market-making/{stop,flatten}` + `POST /api/stat-arb/live/portfolio/flatten` (both flatten = the cross-desk kill switch) |
| ✅ | per-book risk lever | `POST /api/market-making/remove` `{symbol}` (flatten + drop) |
| `/research` ✅ | copy a runbook command | **none** — `<copy-cmd>` copies the exact terminal command to the clipboard (the UI never executes; the operator runs it) |
| `/ops` | health / readiness / metrics | `GET /health`, `/health/ready`, `/metrics` |
| `/exec`, `/ops`, `/desk` | durable NAV curve | `GET /api/market-making/nav?hours=&book=` |
| all | Activity tape | `GET /api/market-making/events?since=`, `GET /api/stat-arb/live/events?since=` |

**Known gaps to design (not faked in the UI):**
- **`/risk` soft pause/deny + lower-limit** still has no dedicated endpoint — the risk
  gate is engine-internal. `/risk` ships with the levers that *do* exist (stop / flatten
  per desk + flatten-drop per book) and says so on the page; a proper
  `POST /api/market-making/risk/{pause,limit}` is a future engine task.
- **VPIN is not surfaced live** — the MM gate currently passes `vpin=0` (`mm-book.ts`),
  so `/risk` shows **adverse selection** as the live toxicity signal and notes VPIN is
  computed-but-unwired. No fabricated VPIN number.
- **`/pm` Thesis Register** endpoints don't exist yet (the register is "coming" per
  CLAUDE.md §8). `/pm` is **future** — it waits on the engine surface.
- **`/research` copy-command** helper renders runbook strings client-side from the
  page's chosen coins/dates; it triggers nothing server-side.

---

## 7. Module / file layout

The UI lives in **one module** that imports the engine modules whose exported services
it projects (mirrors how `TelemetryModule` imports `MarketMakingModule` and injects
the exported `MmPortfolioTrader` — read the ledger, don't duplicate it).

```
src/ui/
  ui.module.ts                 UiModule — imports MarketMakingModule; declares the controllers
  exec.controller.ts           GET /exec (page) + @Sse GET /exec/stream         [slice 1, read]
  exec.controller.spec.ts      controller wiring + SSE frame shape
  ops.controller.ts            GET /ops (page) + @Sse GET /ops/stream            [slice 2, action]
  ops.controller.spec.ts       wiring + async SSE frame + DB-ping/readiness assembly
  mm-desk.controller.ts        GET /desk/mm (page) + @Sse GET /desk/mm/stream    [slice 3, console]
  mm-desk.controller.spec.ts   wiring + catalogue + tape-from-DeskEventLog + SSE frame
  statarb-desk.controller.ts   GET /desk/statarb + @Sse /desk/statarb/stream    [slice 4; declared in StatArbModule]
  statarb-desk.controller.spec.ts  wiring + catalogue + blotter try/catch + tape + SSE frame
  risk.controller.ts           GET /risk (page) + @Sse GET /risk/stream         [slice 5, risk console]
  risk.controller.spec.ts      wiring + verdict-only event filter + SSE frame
  research.controller.ts       GET /research (static page, no deps)             [slice 6, research desk]
  research.controller.spec.ts  renders board + runbook; asserts no execution surface
  ui-asset.controller.ts       GET /ui/:file — serves ui.css + desk-{feed,action,form}.js + copy-cmd.js (allow-listed)
  ui.module.spec.ts            offline DI compile — proves the graph resolves (start:dev can't run here)
  render/
    html.ts                    auto-escaping html`` tagged template + escape/raw
    format.ts                  money/usd/pct/return/signClass + duration/age formatters
    layout.ts                  pageShell + shared topBar + ROLE_LINKS launcher
    components.ts              SHARED partials: deskControls (palette) + activityTape
    exec-view.ts               renderExecLive (live region) + renderExecPage (full doc)
    exec-view.spec.ts          render → assert HTML  (the brief's required fragment test)
    ops-view.ts                renderOpsLive (panels) + renderOpsPage
    ops-view.spec.ts           render → assert HTML (panels, palette wiring, kill-switch confirm)
    mm-desk-view.ts            renderMmDeskLive (cards+tape) + renderLaunchForm + renderMmDeskPage
    mm-desk-view.spec.ts       render → assert HTML (cards, attribution, remove wiring, tape order, forms)
    statarb-desk-view.ts       renderStatArbLive (pair cards+tape) + renderStatArbBlotter + renderStatArbLaunchForm + renderStatArbPage
    statarb-desk-view.spec.ts  render → assert HTML (z/β/regime/position, remove wiring, blotter states, form)
    risk-view.ts               renderRiskLive (drawdown/exposure + risk table + verdict feed) + renderRiskActions + renderRiskPage
    risk-view.spec.ts          render → assert HTML (breach flags, exposure, adverse/VPIN note, verdict feed)
    research-view.ts           FINDINGS/RUNBOOK/RESEARCH_DOCS consts + renderFindingsBoard/renderRunbook/renderDocLinks/renderResearchPage
    research-view.spec.ts      render → assert HTML (verdict cards, runbook in copy-cmd, no execution surface)
  public/
    ui.css                     the terminal theme (shared)
    desk-feed.js               <desk-feed> Web Component (shared live-update / read primitive)
    desk-action.js             <desk-action> Web Component (shared action / write primitive)
    desk-form.js               <desk-form> Web Component (shared input-form / write primitive)
    copy-cmd.js                <copy-cmd> Web Component (clipboard copy; the research runbook helper)
```

- Wired in `app.module.ts` (`UiModule` added to `imports`).
- `nest-cli.json` copies `ui/public/**/*` into `dist` (so prod build serves the
  assets; dev/ts-node reads from `src/` via the same locate trick `/demo` uses).
- **A new role page = a new controller + a `render/<role>-view.ts` + (maybe) a shared
  WC.** No new providers/state.
- **Where the controller is *declared* depends on its data source's module weight:**
  - If the engine module's graph compiles light (e.g. `MarketMakingModule` resolves
    under a ConfigModule-only test), `UiModule` **imports** it and declares the
    controller (exec / ops / desk-mm).
  - If the module's graph is heavy (e.g. `StatArbModule` — clients + a `StatArbRepository`
    with a required `DbService`), declare the controller **in that module** instead, so
    `UiModule` doesn't transitively pull the whole graph (which would break its offline
    DI compile test). The **view + spec still live in `src/ui/render`**; only the
    `@Controller` registration moves. `/desk/statarb` follows this — same precedent as
    `TelemetryModule` declaring `HealthController` to read MM state. Such a controller's
    DI is validated at app boot (like `LiveController`), not by the `UiModule` compile test.

---

## 8. The shipped vertical slices — `/exec` (read) + `/ops` (action)

### 8a. `/exec` — Executive (read path)

Proves the stack end-to-end with the lowest-risk page (read-only, highest-value):

- **`GET /exec`** — server-rendered Executive overview: desk NAV, net P&L (+ return on
  capital), worst-book drawdown vs the 2% budget, running/paused + paper badge, and a
  per-book table (net P&L, return, max DD, inventory, **current risk verdict**, fills).
  Correct on first paint (rendered from the live snapshot, not an empty shell).
- **`GET /exec/stream`** — SSE pushes the same live region every 2s; `<desk-feed>`
  swaps it in. (Numbers move on the **bar cadence**, ~1 min — the 2s stream just keeps
  the view fresh, it doesn't invent ticks.)
- **Shared components used:** `topBar`/`pageShell`, `<desk-feed>`, the formatters.
- **Tests:** `exec-view.spec.ts` (render → assert HTML, 7 cases incl. empty state +
  drawdown breach + paused), `exec.controller.spec.ts` (page + SSE frame), and
  `ui.module.spec.ts` (real DI graph compiles — catches a wiring break offline).

**In the slice vs deferred (honest scoping):**

| In `/exec` now | Deferred (next) |
|---|---|
| desk NAV, net P&L + return, per-book P&L table | the **durable equity curve** (`/nav`, needs `MM_PERSIST`+Postgres) → as a `<nav-spark>` |
| worst-book drawdown vs 2% budget | a **desk-aggregate** drawdown (engine doesn't expose one yet — we proxy with worst book, labelled) |
| **current** risk verdict per book | verdict **history** / Activity tape (`<activity-tape>` over `…/events`) |
| live SSE refresh, paper badge | the stat-arb book's P&L (this slice reads the MM desk only) |

### 8b. `/ops` — Operator (action path — proves the write path + `<desk-action>`)

The first page with a control surface. Read panels + a curated action palette:

- **`GET /ops`** — server-rendered operator console:
  - **process** — readiness verdict (READY / NOT READY) + each readiness check
    (database / tick_loop / feed) with its detail, and uptime. The readiness decision
    reuses the engine's `assessReadiness()` (the same pure function behind
    `/health/ready`), assembled from the live MM desk.
  - **market-making desk** — loop RUNNING/STOPPED, book count, last-tick age, desk NAV,
    net P&L.
  - **persistence** — `MM_PERSIST` on/off + a live DB reachability ping.
- **action palette** — `<desk-action>` buttons: **Start desk** → `POST …/start`,
  **Stop desk** → `POST …/stop`, **Flatten desk (kill switch)** → `POST …/flatten`
  (confirm-gated). Each POSTs the existing validated endpoint; the result shows in the
  panels within one SSE tick.
- **`GET /ops/stream`** — SSE pushes the status panels every 2s.
- **Wiring guarantee:** the palette mutates the same singleton `MmPortfolioTrader` the
  panels read, so an action is visibly reflected (no client-side optimism, no drift).
- **Tests:** `ops-view.spec.ts` (panels, button→endpoint wiring, single confirm on the
  kill switch, idle/empty states), `ops.controller.spec.ts` (page + async SSE frame +
  DB-ping/readiness assembly, persist on/off), and the `ui.module.spec.ts` DI compile.

**In the `/ops` slice vs deferred (honest scoping):**

| In `/ops` now | Deferred (next) |
|---|---|
| process/feed/DB health, tick freshness, persistence | a Prometheus-metrics summary panel (`/metrics`) |
| MM desk status + Start/Stop/**Flatten** kill switch | the **stat-arb desk** status + controls — wiring it pulls the whole `StatArbModule` into `UiModule` and would make the offline DI test fragile; do it when stat-arb runs in the demo |
| confirm-gated flatten (MM scope) | a **cross-desk** kill switch (flatten MM **and** stat-arb) — needs the stat-arb panel first |

> **Honest label:** the flatten button is scoped to the **MM desk** and says so. It is
> not a whole-desk kill switch yet — that waits on the stat-arb panel. We don't ship a
> button that claims more than it does.

### 8c. `/desk/mm` — MM desk console (the rich page: forms + tape + attribution)

The full operating surface for the market-making desk:

- **`GET /desk/mm`** — server-rendered console:
  - **desk summary** — NAV, net P&L + return, book count, loop RUNNING/STOPPED.
  - **per-book cards** — for each book: quotes (bid / mid / ask / reservation /
    ½-spread), inventory, the 4-component **PnL attribution** (spread captured /
    adverse selection / fees / funding) + net, the risk verdict, fills (bid/ask) /
    blocked / maxDD, a WARMING badge until σ is seeded, and a confirm-gated
    **remove** button (`POST …/remove {symbol}`).
  - **Activity tape** — the live business-event feed (fills / verdict changes /
    lifecycle), newest-first, rendered server-side from the MM `DeskEventLog` (the
    same sink the fills emit into; exported from `MarketMakingModule` for this). The
    engine's pre-rendered `message` is shown **verbatim** — the UI never re-derives
    business text.
- **action surface** — the shared `deskControls()` (start/stop/flatten) **plus** two
  `<desk-form>`s: launch a single book (symbol + strategy + venue + capital + quote
  notional) and launch a whole preset. **Re-launching a symbol replaces its book —
  that *is* "set params/lots"** (there's no separate edit endpoint; recorded in the
  form's hint). Bad input is surfaced from the endpoint's `{error}`.
- **`GET /desk/mm/stream`** — SSE pushes the summary + cards + tape every 2s.
- **Tests:** `mm-desk-view.spec.ts` (cards, attribution money, remove→symbol wiring,
  warming/empty/no-quote states, tape newest-first + verbatim message, the two
  forms), `mm-desk.controller.spec.ts` (catalogue from the real registries, tape from
  an injected `DeskEventLog`, optional-dep degrade, SSE frame), DI compile spec.

**In the `/desk/mm` slice vs deferred (honest scoping):**

| In `/desk/mm` now | Deferred (next) |
|---|---|
| quotes + inventory + 4-component attribution per book | a per-book **equity sparkline** (`<nav-spark>` over `/nav?book=`) |
| launch (single + preset), remove, start/stop/flatten | per-field **param** controls (today = re-launch with new params) |
| Activity tape (full-replace each tick, newest-first) | a dedicated **append-mode** `<activity-tape>` (cursor-based, preserves scroll) over `/events?since=` |
| MM `DeskEventLog` tape | the stat-arb tape (its own `DeskEventLog`) → `/desk/statarb` |

### 8d. `/desk/statarb` — Stat-arb desk console

Mirrors `/desk/mm` for the stat-arb desk (declared in `StatArbModule` — §7):

- **`GET /desk/statarb`** — desk summary (NAV, net = realised + unrealised, pairs,
  loop) + **per-pair cards** (z-score, β, regime, position LONG/SHORT/FLAT badge,
  equity, realised/unrealised, net + return, blocked entries, bars, a confirm-gated
  **remove** → `POST …/portfolio/remove {pair}`) + the **Activity tape** (the stat-arb
  `DeskEventLog`, verbatim messages) + the **persisted blotter** (closed trades from
  `StatArbRepository`, rendered on page-load; degrades to a "needs Postgres" note if
  the DB read throws).
- **action surface** — `statArbControls()` (start/stop/flatten) + a `<desk-form>` to
  launch/reconfigure a pair (symbolA, symbolB, β, strategy, venue, capital, per-leg
  notional). Re-launching a pair **replaces** it (= reconfigure; no edit endpoint).
- **`GET /desk/statarb/stream`** — SSE pushes the summary + cards + tape every 2s; the
  durable blotter is **not** streamed (page-load only) so there's no Postgres query per
  tick.
- **Tests:** `statarb-desk-view.spec.ts` (z/β/regime, position-badge colours, remove→pair
  wiring, blotter available/empty/off states, the form), `statarb-desk.controller.spec.ts`
  (real catalogue, blotter from repo + the no-DB try/catch degrade, tape from the
  injected stat-arb `DeskEventLog`, SSE frame excludes the blotter).

**In the `/desk/statarb` slice vs deferred:**

| In `/desk/statarb` now | Deferred (next) |
|---|---|
| per-pair z/β/regime/position + P&L, launch/remove/start/stop/flatten | a spread/z **sparkline** per pair (`<nav-spark>`) |
| persisted blotter (page-load, `paper` venue, DB-guarded) | a **mode-aware** venue + live blotter refresh |
| stat-arb tape (its own `DeskEventLog`) | (cross-desk kill switch — now shipped on `/risk`, §8e) |

### 8e. `/risk` — Risk console

Where the desk's risk is read and reduced (MM-snapshot data, so in `UiModule`):

- **`GET /risk`** — headline (worst-book drawdown vs the 2% budget, books over budget,
  blocked books with a non-Allow verdict, **net / gross exposure** = Σ inventory × mid)
  + a **per-book risk table** (verdict badge, max DD vs budget, signed exposure,
  **adverse selection** as the live toxicity signal, blocked-quote count, and a per-book
  **flatten + drop** action) + the **risk-verdict transition feed** (the MM `DeskEventLog`
  filtered to `kind==='verdict'`, engine messages verbatim).
- **de-risk palette** — `renderRiskActions()`: **Stop MM quoting**, **Flatten MM desk**,
  **Flatten stat-arb desk** (all confirm-gated). The two flatten buttons together are the
  **cross-desk kill switch**. The page states plainly that soft per-book pause/deny +
  limit-lowering need an engine endpoint that doesn't exist yet.
- **`GET /risk/stream`** — SSE pushes the headline + table + verdict feed every 2s.
- **Honesty:** no VPIN number is shown (the gate passes `vpin=0`); adverse selection is
  the real, surfaced toxicity signal, and the page says VPIN is computed-but-unwired.
- **Tests:** `risk-view.spec.ts` (breach flags, exposure math, adverse/VPIN note, remove
  wiring, verdict feed, empty states), `risk.controller.spec.ts` (verdict-only filter so
  fills don't leak into the risk feed, SSE frame), DI compile spec.

### 8f. `/research` — Quant research desk (static; no execution)

The one page with **no live feed and no write surface** — by design (§5):

- **`GET /research`** — three static panels:
  - **findings — KEEP / CUT / RESERVE** — curated verdict cards from
    `docs/RESEARCH_FINDINGS.md` + CLAUDE.md §8 (MM rebate-CLOB = KEEP live earner;
    micro-price + sub-second cadence = KEEP; funding carry = KEEP modest; options VRP =
    RESERVE; crypto taker stat-arb = CUT; FX-stable-as-taker = CUT; equities = KEEP
    forward-paper). Each card carries the one-line finding + the doc to read.
  - **runbook** — the exact terminal commands (run-the-desk, the honesty gates, MM
    capture/tune), each in a `<copy-cmd>` that copies to the clipboard. **The UI never
    executes** — the operator runs them in their terminal (the "no embedded shell"
    verdict, §5).
  - **research docs** — the key doc paths to open in an editor.
- **Honesty:** the board *tracks the docs* (it doesn't compute) and says so; a **live
  funding board / MM screener are deferred** — funding has no serving endpoint yet, so
  we show the funding *verdict* with that caveat rather than inventing rates. A spec
  asserts there is **no `endpoint="`/`<desk-feed>`** on the page (no execution/stream).
- **Tests:** `research-view.spec.ts` (verdict cards + colours, runbook commands verbatim
  inside `<copy-cmd>` with no action endpoints, doc links, the no-fabricated-funding
  guard), `research.controller.spec.ts` (no execution surface), DI compile spec (no deps).

---

## 9. Migration plan — retire `/demo`

`/demo`'s single `index.html` maps onto the role pages panel-by-panel; we keep it
live until parity, then delete it (`src/stat-arb/demo/public/index.html` + the
`DemoPageController`; the JSON `DemoController` endpoints stay — they're an engine
surface, not UI).

| `/demo` panel | → role page |
|---|---|
| desk NAV / equity / P&L headline | `/exec` (✅ shipped), `/ops` |
| MM book cards (quotes/inventory/attribution) | `/desk/mm` (✅ shipped) |
| launch / remove book controls | `/desk/mm` (✅ shipped, `<desk-form>`/`<desk-action>`) |
| stat-arb pair table (z/β/regime/blotter) | `/desk/statarb` (✅ shipped) |
| launch / remove pair controls | `/desk/statarb` (✅ shipped) |
| Activity feed | shared `activityTape()` — ✅ on `/desk/mm` + `/desk/statarb`; risk next |
| health / metrics / persistence state | `/ops` (✅ shipped; metrics panel pending) |
| desk start/stop/flatten controls | `/ops` (✅ shipped, MM scope) |
| risk verdicts / drawdown / exposure | `/risk` (✅ shipped; + headline on `/exec`) |
| research / findings / runbook | `/research` (✅ shipped; live funding board deferred) |

**Retire criteria:** delete `/demo` once the daily-driver pages exist at parity.
`/exec`, `/ops`, `/desk/mm`, `/desk/statarb`, `/risk`, `/research` **now exist** — the
remaining work before retiring is the deferred panels (NAV sparkline, a metrics panel,
append-mode tape, live funding board) and `/pm` + the `/` launcher. Until then both run
side by side (no behaviour change to `/demo`).

---

## 10. How to run + test the slices

`start:dev` can't run in the build sandbox (exits 144) — the operator runs it. Steps
are in the session summary / commit message; the short version:

```
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false npm run start:dev
# → http://localhost:3100/desk/mm       (MM console — launch books + attribution + tape)
# → http://localhost:3100/desk/statarb  (stat-arb console — launch pairs + z/β/regime + blotter)
# → http://localhost:3100/risk          (drawdown vs 2% budget, exposure, verdicts + de-risk/kill switch)
# → http://localhost:3100/research      (findings KEEP/CUT board + copy-the-runbook-command helper)
# → http://localhost:3100/ops           (operator console — start/stop/flatten + health)
# → http://localhost:3100/exec          (executive overview — read-only)

# /desk/mm: "Launch book" (symbol=BTC, venue=hyperliquid, strategy=GLFT) or
#   "Launch preset" (hl-perps) → a card appears; watch quotes + spread/adverse/fees/
#   funding attribution update each bar; per-card "remove"; "Flatten desk" kill switch.
# /desk/statarb: "Launch pair" (symbolA=ETH, symbolB=BTC, β from discovery, strategy=
#   pairs-zscore) → a card with z/β/regime/position; tape logs entries/exits; the
#   blotter lists closed trades (with Postgres). Re-launching a pair reconfigures it.
# (All wrap existing endpoints, still curl-able, e.g.:)
curl -XPOST localhost:3100/api/market-making/launch-preset -H 'content-type: application/json' \
     -d '{"presetId":"hl-perps","capitalUsdcPerBook":1000000}'
```

Offline verification (what CI / the sandbox runs): `npx tsc -p tsconfig.build.json
--noEmit` and `npx jest src/ui` — both green.
