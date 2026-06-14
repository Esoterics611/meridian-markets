# UI redesign — design-session brief (requested)

> **Status:** requested design session (next week deliverable). The `/demo` single
> `index.html` (~100KB of inline HTML+JS) has outgrown itself — the desk now has an
> MM book, a stat-arb book, restart-safe persistence, a business-event tape, a NAV
> curve, a fair-value engine, a directional quoter, a funding scanner, and a coming
> Thesis Register + bias signals. We need a **light, terminal-aesthetic, NON-React,
> multi-role UI** where each role has its own URL and sees (and safely drives) its
> slice of the desk. This brief frames the problem, lays out many options, and
> critically reviews them against the business. **The session's job is to decide +
> design, then ship a thin vertical slice of one role page** — not to boil the ocean.

---

## 1. The problem + the non-negotiables

**Problem:** one giant `index.html` is unmaintainable, untestable, and conflates seven
audiences into one tab strip. As the agentic layer arrives ("each strategy manned by a
quant agent"), the UI becomes the **human ⇄ agent interface** — it must be modular,
role-scoped, and honest (it shows the real numbers, nothing it can't back with the engine).

**Non-negotiables (from this team + CLAUDE.md):**
- **No React** (the operator's call). Keep it **light** and **terminal-like** (monospace, dark, dense, fast).
- **The UI is a thin read-only view over the engine** (CLAUDE.md §1). The server (NestJS) owns the truth; the UI renders it. No business logic in the browser.
- **Research + markets run from the terminal** (the operator's box). The UI may *trigger* curated, safe control-plane actions (launch/stop/flatten a book) and *show* the runbook command to copy — it is **not** a general shell (see §5).
- **Modular monolith** — one repo, one server; the UI is served by the same Nest app, no separate frontend service/build pipeline if avoidable.
- **Honest + paper-only** — every number on screen traces to an engine endpoint; no mock data in a "live" view.

---

## 2. The roles → one URL each (replace `/demo`)

Map the desk's existing personas (QUANT_ROLE.md, EXECUTIVE_BRIEF.md, OPERATIONS_MANUAL.md,
AGENTIC_HEDGE_FUND_DESIGN.md) to role-scoped pages. Each is the "agent's desk" for that function:

| URL | Role | Sees | Safely drives (curated API actions) |
|---|---|---|---|
| `/exec` | **Executive** | desk NAV + drawdown + per-book P&L, the durable equity curve, today's verdicts | nothing (read-only) |
| `/ops` | **Operator** | process/feed/DB health (`/health`, `/metrics`), tick freshness, persistence state, every desk's status | start/stop the loops, flatten-all (the kill switch) |
| `/desk/mm` | **MM desk** | per-book quotes/inventory/PnL attribution (spread/adverse/carry/fees), the Activity tape, risk verdicts | launch/stop/remove a book, set params/lots (control plane) |
| `/desk/statarb` | **Stat-arb desk** | per-pair z/β/regime, open positions, the persisted blotter, the Activity tape | launch/stop/reconfigure a pair |
| `/risk` | **Risk** | live drawdown vs the 2% budget, VPIN/toxicity, risk-verdict transitions, exposure by book | pause/deny a book, lower limits |
| `/research` | **Quant** | the findings (journal/research links), the KEEP/CUT board, last tune/sweep results, the funding board | *no execution* — shows the **copy-paste runbook command** for capture/tune (terminal-run) |
| `/pm` | **PM / house view** | the **Thesis Register** (active theses, conviction, horizon, per-thesis carry P&L), the directional bias per coin | add/edit/close a thesis (the investment-committee surface) |

A shared **top bar** (clock, desk NAV, drawdown, "armed/paused" state) and a shared
**Activity tape** component appear on every page. A landing `/` is a role launcher.

---

## 3. Tech options (many) — then the critical review

The session should weigh these; my critical take is in §4. All are **build-light** (no
React, no heavy bundler) and serve from the existing Nest app.

**A. Server-rendered partials + htmx.** Nest renders HTML (a template engine — EJS/Handlebars/Eta) and **htmx** swaps fragments over the wire (`hx-get`, `hx-trigger="every 2s"`, SSE). The server owns all state; the browser is dumb. *Pros:* tiniest client, perfectly matches "thin view over the engine," no JSON-plumbing-in-JS, trivially testable (render a fragment, assert HTML). *Cons:* less slick for rich client-only interactions; you think in fragments.

**B. Alpine.js (+ optional htmx).** A ~15KB sprinkle-on reactive layer (tiny Vue-in-HTML) for local interactivity (toggles, forms, client polling), HTML-first, no build. *Pros:* light, ergonomic for small interactivity, pairs with A. *Cons:* logic creeps into `x-data` attributes; can re-grow the index.html sprawl if undisciplined.

**C. Lit / native Web Components.** Standards-based components (`<mm-book-card>`, `<activity-tape>`, `<nav-spark>`), each its own file, no framework lock-in. *Pros:* real modularity (the actual fix for "beyond one index.html"), reusable across role pages, future-proof. *Cons:* a light build/bundle step; more ceremony than htmx for what is mostly read-only.

**D. xterm.js for the terminal aesthetic.** A real terminal emulator in the browser — use it (read-only) to render the **live log / Activity tape** as a scrolling terminal, and/or as the "console" pane. *Pros:* nails the terminal feel; great for log streams. *Cons:* it's a heavy lib for pure aesthetics; only worth it if we lean into the terminal metaphor hard (see §5).

**E. Live transport: SSE or WebSocket** (replace the 4s `fetch` polling). The event tape + NAV + health are *streams*; push them. *Pros:* real-time, less server load, the "watch it live" feel the operator wants. *Cons:* a bit more server plumbing (a `/stream` SSE endpoint per feed).

**F. Styling: a terminal CSS, not a framework.** Hand-rolled CSS (we already have a good dark/mono look) or a tiny terminal theme (e.g. a "terminal.css"/"Pico" base). *Pros:* light, on-brand. *Cons:* none material — just keep it small.

**G. (anti-pattern, name it to reject it) a SPA framework** (React/Vue/Svelte + Vite). *Rejected by constraint* — heavyweight, a build/deploy pipeline, business logic drifts to the client, and it fights the "thin view" doctrine. Listed only so the session records *why not*.

---

## 4. Critical review → a recommended stack

Judged against the business (thin read-only view, light, terminal, no React, modular, testable, paper-only):

> **Recommended: A (htmx + Nest server-rendered partials) as the spine, + B (Alpine) for
> local sprinkles, + a few C (Web Components) for the genuinely-reusable widgets
> (activity tape, NAV spark, book card), + E (SSE) for the live feeds, on F (small terminal
> CSS). Use D (xterm.js) only for the read-only log/console pane, if at all.**

Why this and not the others:
- **htmx-first matches the doctrine exactly:** the UI is a read-only projection of the engine, so render it on the server and stream fragments — the browser never holds business state, and each role page is just "compose these partials from these endpoints." This is the smallest thing that solves the modularity problem.
- **Web Components for the 3–4 shared widgets** gives real reuse across the seven role pages without a framework — the honest fix for "one index.html became unmaintainable" is *components + per-role pages*, and WCs do that with the least lock-in.
- **Alpine only where there's true client interactivity** (a launch form, a thesis editor) — and kept on a short leash so it doesn't re-grow the sprawl.
- **SSE over polling** because "watch it live / running fast" is a stated value (the sub-second capture, the Activity tape) — streams beat 4s `fetch`.
- **Reject the SPA** on constraint and doctrine; **reject xterm.js as the primary metaphor** (heavy for aesthetics) but allow it for the one log/console pane if the terminal feel is worth the weight.

**Testability win:** server-rendered fragments are unit-testable (render → assert HTML), unlike the current 100KB inline blob — so the UI rejoins the test discipline (CLAUDE.md §10).

---

## 5. "Run terminal commands from the UI?" — critically reviewed

The operator floated: a way to run terminal commands from within the UI (or "maybe that's overkill").

**Verdict: a general embedded shell is overkill *and* a real risk — do NOT build it. Build a curated action palette + a copy-command helper instead.**
- **Why not a shell:** it's an RCE surface, it breaks the "research + markets run from the terminal" rule, and the long-running jobs (8h captures, sweeps) want a real terminal anyway (detached, killable, logged). Even paper-only, a browser shell is the wrong door.
- **What to build instead:**
  1. **A curated action palette** — buttons that hit the *existing, safe* control-plane API (launch/stop/flatten a book, set params, add/close a thesis). These are bounded, validated server actions, already built. This covers the live-desk actions a role legitimately drives from the UI.
  2. **A "copy the runbook command" helper** — for the terminal-only tasks (capture, tune, sweep, validate), the `/research` page renders the *exact* command (pre-filled with the chosen coins/dates) as a one-click copy, so the human runs it in their terminal. The UI assists the terminal; it doesn't replace it.
  3. **(optional, later) a read-only log/console pane** (xterm.js or a styled `<pre>`) that *streams* a chosen run's log over SSE — the "watch it run" view, no input.
- This keeps the safety + the terminal-for-research discipline while giving the UI real, useful controls. If a constrained job-runner is ever wanted, gate it behind an allow-list of *named* scripts with fixed args + an audit log — never a free-form shell.

---

## 6. What the design session should deliver

1. **A design doc** (`docs/UI_ARCHITECTURE.md`): the chosen stack (with the §4 trade-off recorded), the route map (§2), the shared-component inventory, the SSE feed list, the action-palette ⇄ API map, and the file/module layout (how it lives in the Nest app, served + tested).
2. **A thin vertical slice** — ONE role page end-to-end (recommend `/exec` or `/ops`: read-only, highest-value, lowest-risk) built in the chosen stack: server-rendered, a shared component or two, one live SSE feed, a unit test for a rendered fragment. Proves the stack before the other six pages.
3. **A migration note** — how `/demo`'s existing panels map onto the role pages, and the retire plan for the monolith `index.html` (keep it until parity, then delete).
4. **Honest scoping** — what's in the slice vs deferred; no half-built six pages.

Keep it light, terminal, server-truthful, and tested. The UI is how a human (and soon an
agent) reads and steers the desk — make it as honest as the numbers behind it.

---

## 7. Kickoff prompt (paste to start the design session)

```
GOAL (a system-developer DESIGN session — design + a thin vertical slice; autonomous):

FIRST read: docs/UI_REDESIGN_PROMPT.md (this brief — roles, options, the critical review,
the "no shell" verdict), CLAUDE.md (§1 thin-view doctrine, §6 modular monolith, §10 tests),
docs/AGENTIC_HEDGE_FUND_DESIGN.md + docs/QUANT_ROLE.md + docs/EXECUTIVE_BRIEF.md (the roles),
docs/OPERATIONS_MANUAL.md (what the operator drives), and the current src/stat-arb/demo/public/
index.html (the thing we're replacing) + the control-plane controllers (mm.controller.ts,
execution/live.controller.ts) for the endpoints the UI projects.

DESIGN the new role-scoped UI (NO React; light; terminal aesthetic; server owns the truth):
  1. Decide the stack — default recommendation: htmx + Nest server-rendered partials (the
     spine) + Alpine sprinkles + a few Web Components for shared widgets + SSE for live feeds
     + a small terminal CSS. Record the trade-off vs the alternatives (Lit, Alpine-only,
     xterm.js, a rejected SPA) honestly.
  2. Route map: one URL per role (/exec /ops /desk/mm /desk/statarb /risk /research /pm),
     a shared top bar + Activity-tape component, a / launcher. Retire /demo on parity.
  3. NO embedded shell — a curated control-plane action palette + a copy-the-runbook-command
     helper + an optional read-only SSE log pane. Justify in the doc.
  4. WRITE docs/UI_ARCHITECTURE.md (stack, routes, components, SSE feeds, action⇄API map,
     module layout) AND ship ONE thin vertical slice (recommend /exec or /ops): server-rendered,
     a shared component, one live SSE feed, a unit test for a rendered fragment.

CONSTRAINTS: served by the existing Nest app (no separate frontend service if avoidable);
every number traces to an engine endpoint (no mock data in a live view); paper-only; modular
monolith; verify tsc+jest; commit phases on master; hand any live server run to the operator
(start:dev exits 144 in the sandbox). Light, terminal, honest, tested. Design first, then the
one-page slice — do not half-build all seven.
```
