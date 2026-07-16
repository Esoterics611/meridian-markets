# Meridian Desk UI — role-by-role operator guide

> **What this is:** how to *use* each page of the role-scoped desk UI — what it shows,
> what you can do on it, and how to read the numbers. For the *design* of the UI (stack,
> components, why-no-React) see [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md); this doc is the
> driver's manual.
>
> **Everything here is PAPER.** Real market data (Binance/Hyperliquid/Alpaca public feeds)
> drives simulated fills on a paper venue. No real capital, no real orders (CLAUDE.md §1).
> Every number on every page is computed by the engine and rendered server-side — the
> browser holds no business state, so what you see *is* what the engine believes.

---

## 0. Start it + open the desk

The UI is served by the same Nest app as the engine, on port **3100**:

```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false npm run start:dev
```

Then open **http://localhost:3100/** — the launcher. (Optional, for the durable equity
sparkline + blotter to have data, add `MM_PERSIST=true` with Postgres up; without it the
desk still runs, those panels just say "off" honestly.)

| URL | Role | Read / act |
|---|---|---|
| `/` | launcher | the role index — pick a console |
| `/exec` | executive | read-only |
| `/ops` | operator | health + start/stop/flatten |
| `/markets` | market terminal | read-only — candles, L2 depth, our quotes/fills overlaid |
| `/desk/mm` | market-making desk | launch/remove books, watch attribution |
| `/desk/statarb` | stat-arb desk | launch/remove pairs, watch z/β/regime |
| `/risk` | risk | drawdown/exposure + the kill switch |
| `/research` | quant research | static findings + runbook commands |
| `/pm` | PM / house view | **not built yet** (greyed out) |

### The shared chrome (on every page)

- **Top bar** — `MERIDIAN // paper desk` (click the brand to return to `/`), the role
  nav (the current page is highlighted; `pm` is greyed "not built yet"), and a UTC clock.
- **`PAPER` badge** — appears wherever desk state is shown, so you never mistake the demo
  for live trading.
- **Live updates** — pages with live data hold an SSE connection that refreshes the live
  region every ~2s. If the connection drops, the region **dims** (a "stale" signal) so you
  don't trust frozen numbers. **Note:** the underlying trade numbers move on the **bar
  cadence (~1 min)**, not every 2s — the stream just keeps the view fresh, it doesn't
  invent ticks.

---

## 1. `/` — Launcher

The home index. One card per role with a one-line description. Live pages are clickable;
unbuilt pages (`/pm`) render as a disabled "soon" card — the nav never shows a dead link.
Nothing here is live and nothing executes; it's purely navigation.

---

## 2. `/exec` — Executive overview (read-only)

The headline state of the desk at a glance. **No buttons** — this page only reports.

**Headline tiles:**
- **desk nav** — total desk equity (capital + P&L + funding).
- **net p&l** — net P&L with **return on capital** beside it.
- **max book drawdown** — the worst single book's drawdown vs the **2% budget**; turns red
  on breach. (This is a *proxy* for desk drawdown — the engine doesn't expose a
  desk-aggregate drawdown yet, so we show the worst book and label it.)
- **state** — `RUNNING` / `PAUSED` + the `PAPER` badge.
- **books** — how many books are live.

**Per-book table:** book · strategy · net P&L · return · max DD · inventory · **risk
verdict** · fills.

**Equity charts (P1 — the sparklines grown up):** under the table, the two full desk
curves (MM + carry), each three synced panes — equity, running drawdown vs its budget
(2% MM / 0.5% carry), and the cumulative P&L components. They reuse the desk pages' own
chart endpoints (needs `MM_PERSIST`; otherwise they say "durable NAV off").

**Use it to:** answer "is the desk green, and is anything breaching drawdown?" in one look.

---

**The fund view (#94):** below the MM table, `/exec` carries the **carry-desk strip** —
process liveness (LIVE/STALE/DOWN off checkpoint age), realised-first, funding, maxDD vs
the 0.5% budget, book counts — with the drill-down link to `/desk/carry`, plus a second
equity sparkline on the `@carry` aggregate. Two desks, two honest curves — deliberately
not merged into one synthetic number.

---

## 2a. `/markets` — Live market terminal (read-only; the teaching centerpiece)

The market itself on screen (UI_REWRITE_PLAN_III P2) — the page a student learns
bid/ask/spread/order-book from, on the same live feeds the desk trades.

- **Picker (top):** venue (hyperliquid / binance) · symbol (from the MM market presets) ·
  window. A plain GET form — picking reloads the page; no client state.
- **Header strip (live, 2s):** last price (the L2 mid on depth venues — big, colored by the
  24h move) · 24h Δ% · 24h range · the **live top-of-book spread in bps**. Feed down ⇒ an
  explicit `FEED DOWN` + reason, never stale numbers.
- **Candle chart:** live venue klines (candles + direction-colored volume; venue-fresh, not
  the stored DB), refreshing in place every 20s. When an MM book quotes the market, dashed
  lines mark **our current bid / ask / reservation** — the spread literally straddling mid —
  and ▲/▼ markers show our recent paper fills from the tape.
- **Order book (the depth ladder):** the live Hyperliquid 20×20 book, ~1 frame/s — bids
  green below, asks red above, bar length ∝ resting size, the spread gap labelled in bps,
  and **▶ our resting quotes** marked on their levels. Dims when the stream drops. On a
  depthless venue the panel says so instead of drawing an empty ladder.
- **Our activity:** the desk's own event tape filtered to the symbol.
- **Honest footer:** the venue's own trade prints (E7) and the quote-history / micro-price
  overlays (E6) are not served yet — the page says so rather than faking them.

## 3. `/ops` — Operator console (health + desk controls)

Where you start/stop the desk and confirm it's healthy.

**Panels (live):**
- **process** — readiness verdict (`READY` / `NOT READY`) with each check (database /
  tick_loop / feed) and its detail, plus uptime. (Same logic as `/health/ready`.)
- **market-making desk** — loop `RUNNING`/`STOPPED`, book count, last-tick age, desk NAV,
  net P&L.
- **persistence** — `MM_PERSIST` on/off + a live database reachability ping.
- **telemetry / runtime** — process memory (RSS, heap used/total) and live loop counters
  (mm ticks + mean tick duration, tick overruns, event-loop lag, persist ok/err) read from
  the metrics registry, plus a link to the `/metrics` scrape. If `TELEMETRY_ENABLED` is
  off, it says so and shows memory only — it won't print zero-counters as if they were
  measured.

**Action palette:**
- **Start desk** → resumes quoting.
- **Stop desk** → halts quoting (positions are kept).
- **Flatten desk (kill switch)** → forces every MM book flat. **Confirm-gated.**

> **Scope:** these controls are the **MM desk only** (and the page says so). The stat-arb
> desk has its own controls on `/desk/statarb`; the *cross-desk* kill switch is on `/risk`.

**How acting works:** a button POSTs the existing validated control-plane endpoint; the
button flashes ok/err, and the panels reflect the new state within one tick (no
client-side optimism — what you see is the real desk).

---

## 4. `/desk/mm` — Market-making desk console

The full operating surface for the MM books.

**Controls (top):** the same Start / Stop / Flatten palette as `/ops`.

**Desk equity sparkline:** durable NAV curve (needs `MM_PERSIST`).

**Launch / reconfigure forms:**
- **Launch book** — `symbol` (e.g. `BTC`), `strategy` (default or pick), `venue`
  (binance / hyperliquid / geckoterminal), `capital USDC`, `quote $ notional`.
- **Launch preset** — pick a preset (e.g. `hl-perps`) + capital per book.
- **Re-launching an existing symbol *replaces* its book — that is how you reconfigure
  params/lots** (there's no separate edit endpoint). Bad input (unknown strategy/preset)
  comes back on the button as the engine's own error message.

**Per-book cards (live):** for each book —
- **quotes** — bid / mid / ask / reservation price / ½-spread / inventory.
- **PnL attribution** — the 4 components: **spread captured / adverse selection / fees /
  funding** + **net P&L**. This is the heart of the MM read: a book can be net-positive on
  spread but bled by adverse selection — the attribution shows you which.
- badges — `RUNNING`/`STOPPED`, the risk verdict, and `WARMING` until σ is seeded.
- footer — fills (bid/ask) · blocked quotes · max DD, and a **remove** button
  (flatten + drop the book, **confirm-gated**).

**Charts (below the cards — P1, UI_REWRITE_PLAN_III):** one collapsed drawer per book plus
the desk aggregate. Open one and you get three synced panes: **equity** (durable NAV, with
▲/▼ fill markers from the tape on a book's curve), **running drawdown vs the 2% budget**
(amber line), and the **cumulative P&L components** (realised / inv MTM / fees-contrib /
funding — the same four lines the card sums to net). Charts load on open, refresh every
60s (your zoom is kept), and the drawer list is fixed at page load — reload after
launching a book. Needs `MM_PERSIST` + Postgres; the drawer says so honestly otherwise.

**Activity tape (below):** the live business-event feed — every fill (enter/exit with
realised P&L), risk-verdict change, and launch/remove — newest on top, the engine's own
log line shown verbatim. It's **append-mode**: new events are added without rebuilding the
list, so if you scroll back into history your place is kept.

---

## 5. `/desk/statarb` — Stat-arb desk console

Mirror of `/desk/mm` for the equities/crypto stat-arb pairs.

**Controls:** Start / Stop / Flatten the stat-arb portfolio loop (confirm-gated flatten).

**Launch / reconfigure a pair:** `symbol A`, `symbol B`, `β` (hedge ratio, from
discovery), `strategy`, `venue` (binance / alpaca-equities), `capital`, `per-leg notional`.
Re-launching the same pair **replaces** it (= reconfigure).

**Per-pair cards (live):** z-score · β · regime · **position** (`LONG`/`SHORT`/`FLAT`
badge) · equity · realised · unrealised · net + return · blocked entries · bars · a
confirm-gated **remove**.

**Charts (below the cards — P1):** one drawer per live pair — the classic pairs picture:
both **legs indexed to 100** (one honest axis, no dual-axis), the **spread z-score** with
the live book's entry/exit bands (amber/dim dashed) and replay trade markers, and the
**position sign** (long green / short red). It replays the live pair's β/strategy over the
newest *stored* bars — the same path as `/api/market-data/signal-series` — so it needs a
backfilled window for the pair's venue (the drawer says so when there isn't one).

**Activity tape:** same append-mode feed, on the stat-arb event log.

**Blotter (closed trades):** the persisted closed-trade record (pair · side · z entry→exit
· P&L · closed-at), rendered on page load. **Needs Postgres** — without it the panel says
"persists with Postgres" rather than inventing rows. (Paper venue; mode-aware/live blotter
is a later refinement.)

---

## 5a. `/desk/carry` — Funding-carry desk (read-only; the 30-day P0 run)

The flagship desk's supervisory page (#93, UI_REWRITE_PLAN_II U1). The carry runner is
a **separate supervised process** (`scripts/launch-carry-30d.sh`), so this page reads
its durable checkpoints (`carry_book_state` + `mm_nav desk='carry'`) and drives nothing.

- **Liveness banner first**: checkpoint age → `LIVE` (<3min) / `STALE` (<15min) /
  `DOWN` (books open, no heartbeat — kill-switch and re-gate are INERT; the banner
  shows the relaunch command) / `IDLE` (no books). This is #92's stall made visible.
- **Stat strip**: realised-first (the judged number), funding, fees, basis MTM
  (reported not judged), maxDD vs the 0.5% budget, open/closed counts.
- **Books table**: per-book structure, gate% at entry, funding/fees/realised-first,
  basis MTM, checkpoint age. **CLOSED rows stay visible** (the LIT close is desk
  history — honesty doctrine).
- **NAV sparkline** on the `@carry` aggregate + a `<copy-cmd>` runbook palette
  (launch / status / stop / out-of-band close — the page never executes).
- **Charts (P1):** drawers for the `@carry` aggregate + every checkpointed book (CLOSED
  included — the curve is desk history): equity, drawdown vs the **0.5%** kill budget,
  and the funding-staircase vs fees components.
- DB off ⇒ an explicit `DB OFF` panel, never zeros.

The full operator doctrine (what each number means, when to act):
[CARRY_DESK_OPERATOR_MANUAL.md](CARRY_DESK_OPERATOR_MANUAL.md).

---

## 6. `/risk` — Risk console (read the risk, reduce it)

Where you see how much risk is on and pull it down.

**Headline:** worst-book drawdown vs the 2% budget · books over budget · blocked books (a
non-Allow verdict) · **net / gross exposure** (Σ inventory × mid).

**Per-book risk table:** verdict badge · max DD vs budget · signed exposure · **adverse
selection** (the live toxicity signal) · blocked-quote count · a per-book **flatten + drop**
lever.

**Verdict-transition feed:** the risk verdict changes (Allow→Deny etc.), engine messages
verbatim.

**De-risk palette:**
- **Stop MM quoting** → halt the MM loop.
- **Flatten MM desk** + **Flatten stat-arb desk** → together these are the **cross-desk
  kill switch** (both confirm-gated).

> **Honesty on this page:** **VPIN is not shown** — the risk gate currently passes
> `vpin=0`, so we surface **adverse selection** as the real toxicity signal and note VPIN
> is computed-but-unwired. Soft **per-book pause/deny + limit-lowering** has no dedicated
> endpoint yet (the gate is engine-internal), so `/risk` ships the levers that *do* exist
> (stop / flatten per desk + flatten-drop per book) and says so on the page — no button
> claims more than it does.

---

## 7. `/research` — Quant research desk (static, no execution)

The one page with **no live feed and no buttons** — by design. The desk doesn't trade from
the browser; research runs from your terminal.

- **Findings — KEEP / CUT / RESERVE** — the curated verdict cards (MM rebate-CLOB = KEEP
  live earner; micro-price + sub-second cadence = KEEP; funding carry = KEEP modest;
  options VRP = RESERVE; crypto taker stat-arb = CUT; FX-stable-as-taker = CUT; equities =
  KEEP forward-paper). Each card carries the one-line finding + the doc to read. The board
  *tracks the docs* — it doesn't compute live numbers, and it says so.
- **Runbook** — the exact terminal commands (run-the-desk, the honesty gates, MM
  capture/tune), each with a **copy** button. The UI never runs them; you paste them into
  your terminal.
- **Research docs** — the key doc paths to open in an editor.

(A live funding board / MM screener is deferred — funding has no serving endpoint, so we
show the funding *verdict* with that caveat rather than inventing rates.)

---

**The funding-differential board (#94):** between the findings and the runbook, `/research`
renders the **newest daily board artifact** (`docs/research/funding-differentials/`) —
the M2 cadence counter (n/7 boards, pre-registered before any differential leg opens),
pairs scored / harvestable, and the top differentials with a mechanical leg mapping.
Headlined "A MEASUREMENT, NOT A SIGNAL" — the counter exists to prevent trading a
one-day board. Page-load read of a committed artifact; still no execution, no SSE.

---

## 8. `/pm` — PM / house view (not built)

Greyed out in the nav. The thesis register it would project doesn't have an engine surface
yet; the page is honest about waiting on it rather than shipping a fake.

---

## 9. The shared widgets (how they behave)

| Widget | What it does | Behaviour to know |
|---|---|---|
| live region (`<desk-feed>`) | SSE-refreshed panel | **dims** when the stream drops (stale = don't trust) |
| action button (`<desk-action>`) | POSTs an existing endpoint | flashes ok/err; destructive ones (flatten, remove) ask for **confirm** first |
| input form (`<desk-form>`) | collects fields → POSTs | surfaces the engine's own `{error}` on bad input |
| equity sparkline (`<nav-spark>`) | draws the durable NAV curve | says "durable NAV off" when `MM_PERSIST` is off — never a fake flat line |
| activity tape (`<activity-tape>`) | append-mode event feed | prepends new events, **preserves your scroll** into history |
| copy command (`<copy-cmd>`) | copies a runbook command | copies to clipboard; **never executes** |

---

## 10. Honest caveats (what's not live yet)

These are **endpoint-blocked, not page-blocked** — the pages don't fake them:

- **`/pm`** — no thesis endpoints.
- **MM screener on `/research`** — still no serving endpoint (the funding-differential
  *measurement* board ships #94, read from the daily artifact; live per-venue funding
  rates remain unserved).
- **Per-book pause/deny + limit-lowering** on `/risk` — needs an engine endpoint; only
  stop/flatten/remove exist today.
- **Per-book equity sparklines** in the desk cards, a **mode-aware/live blotter**, and a
  **desk-aggregate drawdown** — refinements pending.
- **`/demo`** (the old single-page console) still runs alongside until parity is called;
  the role pages are the daily drivers.

For the engineering design behind all of this, see
[UI_ARCHITECTURE.md](UI_ARCHITECTURE.md); for the chronological build log, SESSION_HISTORY
§20–§21.
