# UI Architecture — role-scoped, server-rendered desk

> **Status:** decided + two slices shipped (2026-06-06): **`/exec`** (read-only) and
> **`/ops`** (the first *action* page). This is the design the
> [UI_REDESIGN_PROMPT.md](UI_REDESIGN_PROMPT.md) brief asked for: the chosen stack
> (with the trade-off recorded), the route map, the shared-component inventory, the
> SSE feed list, the action⇄API map, and the module layout — plus the two vertical
> slices that prove the stack (read path + write path) end-to-end, and the
> **migration plan** to retire the 100KB `/demo` `index.html`.

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
| `/desk/mm` | MM desk | `/api/market-making/*` | launch/stop/remove book, set params | planned |
| `/desk/statarb` | Stat-arb desk | `/api/stat-arb/live/*` | launch/stop/reconfigure pair | planned |
| `/risk` | Risk | snapshots (drawdown, verdicts, VPIN) | pause/deny book *(endpoint gap — §6)* | planned |
| `/research` | Quant | research/journal endpoints + static findings | **no exec** — copy-runbook-command helper | planned |
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
| `<activity-tape>` | Web Component | _planned_ | — | mm/statarb/risk |
| `<nav-spark>` (equity sparkline) | Web Component | _planned_ | — | exec/ops/desk |

**`<desk-feed src target>`** is the one live-update (read) primitive: it opens an SSE
connection to `src` and swaps each pushed HTML fragment into `#target`. The server
renders `#target` for a correct first paint, then `<desk-feed>` keeps it live. It
holds no business logic — it only swaps server markup.

**`<desk-action endpoint label variant confirm>`** is the one action (write)
primitive: it renders a button that POSTs to an existing, validated control-plane
endpoint, manages only button affordance (disable while in-flight, flash ok/err),
and lets the `<desk-feed>` stream show the result. `confirm` gates destructive
actions (the flatten kill switch) behind a browser confirm dialog. It lives
**outside** the SSE region so a tick doesn't re-create it mid-click.

---

## 5. SSE feed list

| Endpoint | Pushes | Cadence | Status |
|---|---|---|---|
| `GET /exec/stream` | the `/exec` live region (NAV, P&L, drawdown, per-book table) | 2s | **shipped** |
| `GET /ops/stream` | health/readiness/tick-freshness + MM desk + persistence panels | 2s | **shipped** |
| `GET /desk/mm/stream` | per-book quotes/inventory/attribution | sub-2s | planned |
| `GET /<page>/events/stream` | the Activity tape (fills/verdicts/lifecycle) from `…/events` | on event | planned |

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

Wired today on `/ops` (✅) via `<desk-action>`; the rest land with their page.

| Page | Action | Endpoint (exists today) |
|---|---|---|
| `/ops` ✅, `/desk/mm` | start desk | `POST /api/market-making/start` |
| ✅ | stop desk | `POST /api/market-making/stop` |
| ✅ | flatten (kill switch) | `POST /api/market-making/flatten` (confirm-gated) |
| `/desk/mm` | launch book | `POST /api/market-making/launch` `{symbol,strategyId?,source?,capitalUsdc?,quoteNotionalUsd?}` |
| | launch a preset | `POST /api/market-making/launch-preset` `{presetId,...}` |
| | remove book | `POST /api/market-making/remove` `{symbol}` |
| | (read) catalogue | `GET /api/market-making/strategies`, `/markets`, `/screen` |
| `/ops`, `/desk/statarb` | start/stop/kill | `POST /api/stat-arb/live/start|stop|kill` |
| | flatten / flatten-all | `POST /api/stat-arb/live/flatten`, `/portfolio/flatten` |
| `/desk/statarb` | launch/remove pair | `POST /api/stat-arb/live/portfolio/launch`, `/portfolio/remove` |
| `/ops` | health / readiness / metrics | `GET /health`, `/health/ready`, `/metrics` |
| `/exec`, `/ops`, `/desk` | durable NAV curve | `GET /api/market-making/nav?hours=&book=` |
| all | Activity tape | `GET /api/market-making/events?since=`, `GET /api/stat-arb/live/events?since=` |

**Known gaps to design (not faked in the UI):**
- **`/risk` pause/deny + lower-limit** has no dedicated endpoint — the risk gate is
  engine-internal. The risk page launches against `stop`/`flatten` for now; a proper
  `POST /api/market-making/risk/{pause,limit}` is a future engine task.
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
  ui-asset.controller.ts       GET /ui/:file — serves ui.css + desk-feed.js + desk-action.js (allow-listed)
  ui.module.spec.ts            offline DI compile — proves the graph resolves (start:dev can't run here)
  render/
    html.ts                    auto-escaping html`` tagged template + escape/raw
    format.ts                  money/usd/pct/return + duration/age formatters (reuse desk-event money fmt)
    layout.ts                  pageShell + shared topBar + ROLE_LINKS launcher
    exec-view.ts               renderExecLive (live region) + renderExecPage (full doc)
    exec-view.spec.ts          render → assert HTML  (the brief's required fragment test)
    ops-view.ts                renderOpsLive (panels) + renderActionPalette + renderOpsPage
    ops-view.spec.ts           render → assert HTML (panels, palette wiring, kill-switch confirm)
  public/
    ui.css                     the terminal theme (shared)
    desk-feed.js               <desk-feed> Web Component (shared live-update / read primitive)
    desk-action.js             <desk-action> Web Component (shared action / write primitive)
```

- Wired in `app.module.ts` (`UiModule` added to `imports`).
- `nest-cli.json` copies `ui/public/**/*` into `dist` (so prod build serves the
  assets; dev/ts-node reads from `src/` via the same locate trick `/demo` uses).
- **A new role page = a new controller + a `render/<role>-view.ts` + (maybe) a shared
  WC.** It imports whatever engine module exports its data. No new providers/state.

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

---

## 9. Migration plan — retire `/demo`

`/demo`'s single `index.html` maps onto the role pages panel-by-panel; we keep it
live until parity, then delete it (`src/stat-arb/demo/public/index.html` + the
`DemoPageController`; the JSON `DemoController` endpoints stay — they're an engine
surface, not UI).

| `/demo` panel | → role page |
|---|---|
| desk NAV / equity / P&L headline | `/exec` (✅ shipped), `/ops` |
| MM book cards (quotes/inventory/attribution) | `/desk/mm` |
| stat-arb pair table (z/β/regime/blotter) | `/desk/statarb` |
| Activity feed | shared `<activity-tape>` on mm/statarb/risk |
| health / metrics / persistence state | `/ops` (✅ shipped; metrics panel pending) |
| desk start/stop/flatten controls | `/ops` (✅ shipped, MM scope) |
| risk verdicts / drawdown | `/risk` (+ headline on `/exec`) |
| research / findings / funding board | `/research` |

**Retire criteria:** delete `/demo` once `/exec`, `/ops`, `/desk/mm`, `/desk/statarb`
exist at parity for what the operator uses daily. Until then both run side by side
(no behaviour change to `/demo`).

---

## 10. How to run + test the slices

`start:dev` can't run in the build sandbox (exits 144) — the operator runs it. Steps
are in the session summary / commit message; the short version:

```
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false npm run start:dev
# → open http://localhost:3100/ops    (operator console — drive the desk here)
# → open http://localhost:3100/exec   (executive overview — read-only)

# /ops drives the desk directly via the action palette:
#   Start desk / Stop desk / Flatten desk (kill switch, confirm-gated).
# To have books to act on, launch a preset (the future /desk/mm will wrap this):
curl -XPOST localhost:3100/api/market-making/launch-preset -H 'content-type: application/json' \
     -d '{"presetId":"hl-perps","capitalUsdcPerBook":1000000}'
# then on /ops: Stop → panels show STOPPED within ~2s; Start → RUNNING; Flatten → inventory→0.
```

Offline verification (what CI / the sandbox runs): `npx tsc -p tsconfig.build.json
--noEmit` and `npx jest src/ui` — both green.
