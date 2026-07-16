# UI Rewrite Plan III — The Teaching Terminal

*2026-07-16. Successor to [UI_REWRITE_PLAN_II.md](UI_REWRITE_PLAN_II.md) (U1–U3 carry/fund
views — shipped #93/#94). Written plan-first (Ronnie's brief, 2026-07-16) so any session can
build it mechanically. Doctrine from [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) is kept —
thin read-only views over the engine, server-rendered partials + SSE + vanilla Web
Components, no SPA, no fabricated numbers, honest empty states — with **one amendment**
(§3, the chart primitive), argued in writing per the house rule.*

> **Status (2026-07-16):** D1–D5 all decided per the recommendations (Ronnie, same day).
> **P1 SHIPPED** the same session — vendored lightweight-charts v5.2.0 behind the one
> `<mkt-chart>` component, the normalized **ChartSpec** contract (`src/ui/render/chart-spec.ts`,
> pure spec builders + 13 unit cases, palette validated by the dataviz six-checks script),
> chart endpoints `GET /desk/mm/chart[?book=]`, `GET /desk/carry/chart[?book=]`,
> `GET /desk/statarb/chart?pair=` + chart-drawer sections on `/desk/mm`, `/desk/carry`,
> `/desk/statarb`, and `/exec`'s sparklines grown into the two full desk charts. Verified
> against the live app + the real 57k-row `mm_nav` history (SOL book: 3 panels/180 points;
> honest offs curl-checked). **Recorded deviations from §5.2:** (a) drawers live in a
> per-page *charts section* OUTSIDE the SSE region, not inside the live cards — a 2s tick
> swap would destroy an open chart (same law as `<nav-spark>`); (b) `/exec` embeds reuse
> the two desk ChartSpec endpoints rather than adding its own; (c) the MM book drawer's
> mid-vs-quotes panel waits on E6 exactly as §7 lists — P1 ships equity/drawdown/components
> + tape fill markers. ~~**Next: P2** (`/markets` + E1/E5).~~
>
> **P2 SHIPPED** (same session): **`/markets`** — the live market terminal. E1 built as
> `GET /api/market-data/l2` + SSE `…/l2/stream` (~1 frame/s off `HyperliquidClient.l2Snapshot`,
> our resting quotes merged server-side) feeding the new hand-rolled **`<depth-ladder>`**
> canvas component; the candle chart is `GET /markets/chart` (candlestick + direction-colored
> volume pane via `buildMarketChartSpec`, **live venue klines** — no stored-bar dependency —
> with our-quote price lines + tape fill markers); the header strip streams over
> `GET /markets/stream` (last/Δ24h/range + the live L2 spread). Controller declared in
> MarketMakingModule (market-data must stay MM-free — the L2 type's own rule; registry added
> as an injectable provider, `MM_BINANCE_CLIENT` moved to `mm-tokens.ts`). **E5 resolved
> without a new endpoint** (recorded deviation): the strip SSE is the live price element and
> the chart self-refreshes in place every 20s (zoom kept) — a dedicated tick stream added
> value only past bar cadence, which would be dishonest anyway. E6 (quote history /
> micro-price overlay) and E7 (venue prints) remain endpoint-blocked and the page says so.
> Live-verified: real HL 20×20 frames (best bid 64,173 × 41.86 BTC), 289 real candles,
> honest offs for depthless venues. ~~**Next: P3** (the teaching layer).~~
>
> **P3 SHIPPED** (same session, after the trader-review interlude — see
> [UI_TRADER_REVIEW.md](UI_TRADER_REVIEW.md), whose P0s shipped first as their own
> commit): the **explain registry** (`src/ui/render/explain-registry.ts`, ~27 entries
> curated from DESK_GLOSSARY, spec-enforced "read more" links against the tracked
> course markdown) + **`<explain-tip>`** ⓘ drawer (`GET /learn/explain/:id`) on the
> mm/statarb/markets vocabulary; **learn mode** as a pure-presentation toggle (server
> always renders the `learn-only` captions, a topbar button + `?learn=1` flips one CSS
> class — learn-off is pixel-identical by construction); **`<desk-tour>`** guided tours
> on `/desk/mm`, `/markets`, `/risk` (server-defined steps, missing targets skipped);
> the **`/learn` hub** (course cards, the learning-path map, tours, the on-site
> glossary); **`/courses/*` same-origin** (D2 — allow-listed static serve with a
> traversal guard and an honest "not built" page; the site dirs stay gitignored); and
> **[TEACHING_SURFACE.md](TEACHING_SURFACE.md)**, the stable-URL contract for mendy-hq.
> Live-verified end-to-end; one live bug found + spec-locked (the slashless/slashed
> course-root redirect loop). **Next: P4** (`/plant` + `/fleet`).

---

## 0. The brief, restated as a mission

The UI has served two consumers: the **operator** (run the desk) and the **executive**
(is the desk green). Ronnie's brief adds a third, and makes it primary: the **student**.
The sister repo **mendy-hq** (Builder Academy — a Claude-Code-native apprenticeship,
38 sessions from "what's a terminal" to running honest research) uses this repo as its
textbook and laboratory. Its Phase 1 teaches *price/bid/ask/spread/order book*; Phase 3
is literally called *Read the Desk* — eight sessions spent inside our pages and courses.

So the target is: **a real trading-terminal UI on top of the engine, whose primary
purpose is teaching** — the thing a student sees should look like the screens
professionals stare at (charts, depth, tape, blotter), and every number on it should be
able to *explain itself* on demand. The brief's five asks:

1. **Charts + live market data on screen** — today the only chart anywhere is the
   `<nav-spark>` sparkline. No candles, no market view, no depth. (Ronnie, verbatim:
   *"the current ui lacks charts and live market data — along with our statistical
   calculations."*)
2. **Our statistical calculations, visible** — z-score, β, σ, micro-price vs mid, the
   RND fair value, funding accrual, Brier calibration — all computed, none plotted.
3. **The new script fleet, visible** — `md-plant`, `orv-calibration`, `outcome-rv-live`,
   `vrp-live`, `carry-desk-live`, the regime track: separate processes whose only
   surfaces are log files, artifacts, and `psql`. (The #92 stall was exactly this gap;
   `/desk/carry` fixed it for one runner — generalize it.)
4. **The infra investment, visible and self-explaining** — the trading plant (IBus,
   NATS, md-plant topics, tapes) shipped #98 and has no surface. The UI should show
   what's up, and explain *what these things are* in a UX-acceptable way.
5. **The educational docs, woven in** — two full mkdocs courses
   (`courses/market-making` 00–11 + appendices, `courses/stat-arb` 00–10), the
   [DESK_GLOSSARY.md](DESK_GLOSSARY.md), and mendy-hq's CURRICULUM anchors that already
   point at our URLs. The wrapper should be *visually enticing* — a reason to explore.

**One sentence:** turn the supervisory surface into a **teaching terminal** — the same
honest engine, now with the market on screen, the math on screen, the plant on screen,
and a curriculum-aware explain layer over all of it.

---

## 1. Inventory — what we build on (and the honest gaps)

### Already serving chart-ready series (no engine work needed)

| Endpoint | Series | Chart it becomes |
|---|---|---|
| `GET /api/market-data/candles?symbol&venue&hours` | OHLC bars, any venue incl. hyperliquid | the **market candle chart** |
| `GET /api/market-data/signal-series?symbolA&symbolB&venue&beta&strategyId` | two legs + spread + **z-score** | the **stat-arb strategy chart** (z + entry bands + position shading) |
| `GET /api/market-making/nav?hours&book` | durable equity curve, per book / `@carry` | desk + per-book **equity chart** (already sparklined; grows to a full chart) |
| `GET /api/market-making/events?since=` | fills w/ realised P&L, verdicts, lifecycle | **fill markers** on the candle chart |
| `GET /api/market-making/snapshot` | per-book bid/ask/mid/reservation/σ/inventory | **our-quotes overlay** on the candle chart |
| `GET /api/carry/state` | funding/fees/realised per book | the **carry accrual chart** |
| `GET /api/regime/snapshot` | regime state + gates | regime strip on the strategy chart |
| `GET /api/market-data/bars`, `/universe`, `/presets` | discovery series | `/markets` pickers |

### Endpoint-blocked (engine work in §7 — no page fakes these)

- **L2 depth is not served.** `HyperliquidClient` holds 20×20 L2 (`IL2BookSource`) and
  the plant publishes `md.book.hip4.*`, but no HTTP/SSE surface exists. → E1.
- **The plant has no bridge.** Topics (`md.mids.hyperliquid`, `md.outcome.meta.*`,
  `md.book.hip4.*`, `md.chain.deribit.*`), seq/age health, and tape stats are only on
  NATS. → E2.
- **Calibration artifacts aren't served.** `orv-calibration` writes
  `docs/research/orv-maker/tapes/` (fair@1s + depth-5 tapes + the #96 Brier scorer);
  read-only serving follows the funding-board precedent (#94). → E3.
- **No market prints tape** (venue trades). The HL trades-WS exists in the client but
  isn't served; deferred, not faked. → E7.
- **VPIN stays unshown** until the gate stops passing `vpin=0` (unchanged honesty rule).

---

## 2. Who the pages are for (three modes, one surface)

Not three UIs — one UI with a **mode dial**:

- **Operate** (default) — exactly today's dense terminal idiom. Zero regression: every
  existing page keeps working unchanged.
- **Learn** (`?learn=1`, sticky via localStorage, toggle in the top bar) — the same
  pages grow captions, "what am I looking at" strips, and visible `<explain-tip>`
  affordances. The student sees the *same real numbers* the operator sees — teaching
  with mock data would betray the house ethos.
- **Present** (`/wall`) — a projector/classroom wall board: big type, rotating panels,
  no controls. For demos and for mendy-hq sessions taught off a shared screen.

---

## 3. The one doctrine amendment: a chart primitive (Decision D1)

The doctrine deliberately deferred libraries "to the page that needs them" (Alpine
precedent). Charts are now that page. Options, argued:

- **(a) Hand-roll everything on canvas/SVG** (the `<nav-spark>` route). Honest fit with
  the stack, but a real candle chart needs crosshair, time axis, zoom/pan, series
  overlays, resize — weeks of undifferentiated widget code that will be worse than the
  standard tool. This is wheel-reinvention, not thin-client discipline.
- **(b) Vendor TradingView `lightweight-charts`** — the industry-standard OSS chart for
  exactly this job: a **single static file** (~45KB gz), zero dependencies, no build
  step, Apache-2.0 (requires the TradingView attribution notice — render it in the
  chart footer). It draws candles/lines/areas/histograms with crosshair + time axis and
  nothing else — it is a *renderer*, not a framework.
- **(c) A bigger charting framework** (ECharts, Plotly, Highcharts) — rejected:
  megabytes, framework-shaped, fights the stack.

**Recommendation: (b), fenced.** Vendored at `src/ui/public/vendor/lightweight-charts.js`
(pinned version, committed — no CDN), wrapped in **one** Web Component `<mkt-chart>` so
pages never touch the library API directly. The fence, binding: the library renders
**engine-served series verbatim** — no client-side business math, ever. Transforming
`{t,o,h,l,c}` JSON into pixels is presentation, same as `<nav-spark>`; computing a
z-score in the browser would be a violation. Two chart needs stay **hand-rolled**
because they're simple and the library doesn't do them: the **depth ladder** (canvas
bars) and the existing sparkline.

*(If Ronnie prefers zero third-party code on principle, the fallback is (a) scoped to:
line/area charts hand-rolled first, candles later — Phase 1 still ships, thinner.)*

---

## 4. Route map v3

| URL | Role / purpose | Status |
|---|---|---|
| `/markets` | **the market terminal** — candles + depth + our quotes/fills overlays, any tracked symbol/venue | **new, P2** |
| `/desk/mm`, `/desk/statarb`, `/desk/carry` | gain **chart drawers** per card (strategy math on screen) | extend, P1 |
| `/plant` | **the trading plant** — live topology, topic health, tape stats, self-explaining | **new, P4** |
| `/fleet` | **the runner fleet** — liveness + last-artifact + runbook for every out-of-process script | **new, P4** |
| `/desk/probability` | ORV + VRP: RND fair vs HIP-4 book, Brier calibration scorecard | **new, P5** |
| `/learn` | **the academy hub** — curriculum map → live pages + course chapters + tours | **new, P3** |
| `/courses/market-making/*`, `/courses/stat-arb/*` | the built mkdocs sites served same-origin | **new, P3** (D2) |
| `/wall` | the classroom wall board (big type, rotating, read-only) | **new, P6** |
| `/` | landing v2: launcher → **trading floor** (live desk tiles + market strip + Learn entry) | extend, P6 |
| existing `/exec /ops /risk /research /desk/markout /desk/toxicity` | unchanged; gain `<explain-tip>` coverage only | P3 |

---

## 5. Page specs

### 5.1 `/markets` — the market terminal (the centerpiece)

The page a student recognizes from every trading floor photo, and the page mendy-hq
Session 10 ("bid, ask, spread") and Session 22 ("what market making actually is") teach
from. Layout (12-col grid, terminal-dark):

1. **Header strip:** symbol/venue picker (from `/api/market-data/universe` + `/presets`),
   last price big + delta-flash, 24h range, feed-age dot (green <2s stale-dims — reuse
   the `<desk-feed>` dim idiom).
2. **Candle chart** (`<mkt-chart>`, ~60% width): `GET /api/market-data/candles`,
   live-refreshed via a per-symbol SSE tick (E5). **Overlay toggles** — each one is a
   lesson:
   - **our quotes** — bid/ask/reservation lines from the MM snapshot (if a book quotes
     this symbol): the student *sees* the spread being quoted around fair value;
   - **our fills** — ▲/▼ markers from `/events` with realised P&L in the tooltip;
   - **micro-price vs mid** — the F1 finding drawn live (the crown-jewel lesson from
     [FAIR_VALUE_AND_THESIS_DESIGN.md](FAIR_VALUE_AND_THESIS_DESIGN.md): quote off the
     stale mid and you get picked off).
3. **Depth ladder** (`<depth-ladder>`, canvas, ~25% width): the HL 20×20 book (E1) as
   horizontal bars, bids green-down / asks red-up, spread gap highlighted, **our resting
   quotes marked** on their levels. This is the single most teachable widget in the
   whole plan — Session 10's "there isn't one price" made visceral.
4. **Tape column:** our business-event tape for this symbol (existing `<activity-tape>`
   filtered); venue prints tape deferred until E7 — the panel says so.

*Learn mode adds:* a caption strip per panel ("this green wall is people willing to
buy — the top of it is the **best bid**") and an `<explain-tip>` on every term.

### 5.2 Strategy charts in the desk pages (the statistical calculations, on screen)

Per-card **chart drawer** (a `<details>`-style expand under each book/pair card — no new
routes, no layout upheaval):

- **`/desk/statarb` pair card →** the classic pairs chart, from `signal-series`:
  panel 1 both legs normalized; panel 2 the spread + **z-score** with entry/exit bands
  drawn at the strategy's live thresholds and **position shading** (long/short spans).
  The chart Sessions 18/26 build toward — our live desk drawing the same picture the
  student built in their toy.
- **`/desk/mm` book card →** panel 1 mid vs our bid/ask over time (spread visible as a
  band); panel 2 **inventory** steps + the 4-component attribution as a cumulative
  stacked area (spread captured / adverse / fees / funding — from `mm_nav` columns).
  The "green = unrealised warehouse trap" lesson (#64) becomes a picture.
- **`/desk/carry` book row →** funding accrued vs fees vs realised-first over time
  (`mm_nav @carry:SYM`): the student sees carry *accrue* — a strategy where the chart
  is a staircase, not a squiggle.
- **`/exec` →** the two `<nav-spark>`s upgrade to full `<mkt-chart>` equity curves with
  drawdown shading vs budget.

Data honesty: every drawer series comes from an existing endpoint or E-item; drawers
render "needs MM_PERSIST/Postgres" states exactly like today's panels.

### 5.3 `/plant` — the trading plant, self-explaining

The infra page. Layout:

1. **Topology map** (`<plant-map>`: server-rendered SVG, nodes + wires; SSE swaps
   only class names for health — no client graph lib): *feeds* (Binance REST,
   Hyperliquid WS, Deribit) → **md-plant** → *NATS topics* (`md.mids.hyperliquid`,
   `md.outcome.meta.*`, `md.book.hip4.*`, `md.chain.deribit.*`) → *consumers*
   (orv-calibration `OCAL_SOURCE=bus`, future engine feeds). Node color = liveness
   (topic age / seq gaps from E2). The #98 architecture, drawn.
2. **Topic health table:** topic · last seq · msgs/min · age · schema version · tape
   size today. Gap detected ⇒ red row (the "consumer goes safe" contract, visible).
3. **Tap viewer:** pick a topic → a rate-limited, sampled SSE view of live messages
   (pretty-printed JSON, max ~2/s — a *window*, not a firehose). Read-only by
   construction; the student watches real market data flow through real infra.
4. **Explain drawers per node** (the "UX-acceptable explanation" ask): click any node →
   side drawer: *what it is* (2–3 sentences: "NATS is the desk's message bus — a post
   office for market data…"), *why we built it* (one line from
   [TECHNOLOGY_OVERVIEW.md](TECHNOLOGY_OVERVIEW.md) §2 — how real quant shops run a
   tickerplant), *where the code lives* (`src/bus/`, `scripts/md-plant.ts`). Content
   from the explain registry (§6), curated not generated.

Honest states: `BUS=inproc` or NATS down ⇒ the page says "plant not connected — the
desk runs fine without it; start it with `scripts/md-plant.ts`" + `<copy-cmd>`. Never
a fake green map.

### 5.4 `/fleet` — the runner fleet

Generalizes the `/desk/carry` liveness pattern (the #92 lesson) to **every**
out-of-process script. A server-side **runner registry** (curated const, like
`LAUNCHER_ENTRIES`): id, what it is (one line), how liveness is measured, artifact
locations, runbook commands. Per runner a row: **LIVE / STALE / DOWN / IDLE** badge
(per-runner `classify*Liveness` pure functions — the carry one is the template) ·
last-heartbeat age · last artifact (name, age, one-line summary) · `<copy-cmd>`
launch/status/stop.

| Runner | Liveness source (durable, no PID lies) |
|---|---|
| `carry-desk-live` | `carry_book_state.updated_at` (shipped — reuse) |
| `md-plant` | newest topic age via E2 (or DOWN with "bus unreachable") |
| `orv-calibration` | newest file mtime in `docs/research/orv-maker/tapes/` |
| `outcome-rv-live` / `vrp-live` | their checkpoint/artifact traces (per-runner adapter) |
| regime track (`launch-regime-track.sh`) | its checkpoint table / artifact |

The page teaches the ops lesson directly: *a professional desk knows what's running
without ssh-ing anywhere* — and it retires "grep the log + psql" as our own daily habit.

### 5.5 `/desk/probability` — the ORV/VRP desk (the honesty doctrine on display)

Reads: plant topics via E2 (live HIP-4 binaries + Deribit chain) and OCAL artifacts via
E3. Panels:

1. **Live fair-value board:** per tracked binary — strike, expiry countdown, HIP-4
   bid/mid/ask vs the **smile-adjusted RND fair**, the edge vs the pre-registered 3c
   gate, "would trade / correctly does nothing" verdict. (The founding read —
   quoted 0.153/0.180 vs fair 0.1334 — as a living panel.)
2. **Calibration scorecard:** the #96 Brier scorer — our fair vs the market-mid
   baseline, resolved-market count, the **calibration-before-capital** banner stating
   trading is parked until the scorer says the RND beats the crowd. A reliability
   curve (predicted p vs realized frequency) once ≥~30 resolutions exist; an honest
   "n too small" state before that.
3. **Maker-replay results:** the pre-registered gate + queue-conservative replay
   numbers from `orv-maker-replay` artifacts, labelled replay-not-live.

*Teaching value:* this page is Phase 2 of the mendy-hq arc (pre-register → run → read
the truth) happening on a real desk in real time. Nothing else we could build shows the
honesty reflex better.

### 5.6 `/learn` — the academy hub

The wrapper page for the educational assets. **No cross-repo coupling** (§0/§6): the
map below is a curated const *in this repo*; mendy-hq keeps pointing at us, never the
reverse. Panels:

1. **Two course cards** — market-making (00–11 + appendices) and stat-arb (00–10),
   chapter lists, reading time, "open" links (same-origin per D2).
2. **The curriculum map** — mendy-hq's anchors, mirrored (and now *load-bearing*, so we
   keep them stable — see the contract below):

   | Learning stop | Live surface | Course anchor |
   |---|---|---|
   | a price is live | `/markets` header strip | — |
   | bid/ask/spread/book | `/markets` depth ladder | mm-course 02 |
   | what a market maker does | `/desk/mm` + tour | mm-course 01–02 |
   | fair value & adverse selection | `/markets` micro-price overlay | mm-course 09–10 |
   | pairs, cointegration, z | `/desk/statarb` chart drawer | stat-arb 02–03 |
   | a killed strategy is a finding | `/research` CUT cards | stat-arb 06 |
   | risk = bounded loss | `/risk` + tour | mm-course 05 |
   | carry (paid to hold) | `/desk/carry` accrual chart | FUNDING_CARRY_TRADE.md |
   | pre-register, then run | `/desk/probability` scorecard | PROBABILITY_DESK.md |
   | real infra | `/plant` map | TECHNOLOGY_OVERVIEW.md |

3. **Tours** — launch buttons for the per-page `<desk-tour>`s (§6).
4. **The glossary** — rendered from the explain registry, linked per term.

**The teaching-surface contract (new, small, binding):** a short doc
(`docs/TEACHING_SURFACE.md`) listing the URLs + element ids mendy-hq prompt seeds may
rely on (`/desk/mm`, `/markets#depth`, `/learn`, course chapter URLs…). CURRICULUM.md
already tells tutors to re-check anchors before a session; this doc is the other half —
*we* don't break them silently.

### 5.7 `/courses/*` — serve the built mkdocs sites (Decision D2)

`courses/*/site/` are already built, self-contained static sites. A
`CoursesController` (allow-listed static serving, same pattern as
`ui-asset.controller.ts`) mounts them at `/courses/market-making/` and
`/courses/stat-arb/`. One origin ⇒ the desk links into chapters and chapters can link
back to live pages ("see this live: /desk/mm") without caring where the desk runs.
Netlify stays for public sharing; same-origin is for the desk + classroom.

### 5.8 `/wall` — the classroom board (Decision D3)

Read-only, huge type, auto-rotating panels (~20s): desk NAV + curve → `/markets` chart
+ depth for the flagship symbol → the activity tape → the fleet strip. No controls, no
drill-down; `?panels=` query picks the rotation. Built almost entirely from components
that exist by P6 — it's an assembly, not an engineering effort. This is the screen a
mendy-hq session throws on the TV.

### 5.9 Landing v2 — from launcher to trading floor

Keep the role cards (they're the honest nav), add above them: a **market strip** (3–5
tracked symbols, last price + delta-flash + inline sparkline) and **live desk tiles**
(MM / carry / stat-arb: NAV + tiny curve + LIVE badge, from existing snapshots). First
impression becomes "this thing is alive" instead of a static index. The `Learn` entry
gets a distinct visual treatment — it's the front door for the student.

---

## 6. The explain layer (cross-cutting — how the UI "relates and explains")

The UX-acceptable shape, decided: **progressive disclosure**. Nothing lectures by
default; everything can explain itself on demand.

1. **The explain registry** — `src/ui/render/explain-registry.ts`: a typed const map
   `metricId → { term, oneLiner, moreHref }`. Content **curated from
   [DESK_GLOSSARY.md](DESK_GLOSSARY.md)** (the intuition-first entries already written
   for exactly this) + course-chapter links. One source of truth; a spec asserts every
   registered id resolves and every `moreHref` exists.
2. **`<explain-tip id="…">`** — a Web Component rendering a subtle ⓘ (dotted-underline
   term in learn mode). Click → a right-side drawer, server-rendered from the registry:
   term, the plain-English *what it is* + *which way it moves the desk* (the glossary's
   own format), and "read more →" into the course. Esc/click-out closes. No tooltips-on
   -hover-only (touch-hostile), no modal walls.
3. **Learn mode** — the top-bar toggle (`?learn=1` + localStorage). On: panel captions
   render (server-side conditional — same partials, one flag), explain affordances
   become visible, each page shows a one-paragraph "what am I looking at" strip at top.
   Off: today's UI, pixel-identical.
4. **`<desk-tour>`** — a per-page guided tour (vanilla WC, ~100 lines): steps defined
   server-side as `[{selector, text}]`, rendered as a spotlight + next/prev. Launched
   from `/learn` or `?tour=1`. First three tours: `/desk/mm`, `/markets`, `/risk` — the
   mendy-hq Session 21/22/27 walkthroughs, scripted once, reused every session.
5. **Stable ids** — every panel and headline metric gets a stable `id` attribute so
   tours, tips, and mendy-hq prompt seeds can deep-link (`/desk/mm#attribution-BTC`).
   Listed in TEACHING_SURFACE.md.

---

## 7. Engine surface needed (all read-only; each page degrades honestly without it)

| # | Surface | Source of truth | Notes |
|---|---|---|---|
| E1 | `GET /api/market-data/l2?venue&symbol` + SSE `…/l2/stream` | `HyperliquidClient` L2 20×20 (`IL2BookSource`) | powers `<depth-ladder>`; throttle SSE to ~2 fps — a teaching ladder, not an HFT feed |
| E2 | `PlantBridgeModule`: `GET /api/plant/status`, `/topics`, SSE `/tap?topic=` | NATS subscribe `md.>` when `BUS=nats` (read-only consumer; seq/age bookkeeping per topic) | plant down ⇒ `{connected:false}`, page honest; sampled tap, hard rate cap |
| E3 | `GET /api/prediction/calibration` (+ `/fair` if the live runner is up) | newest OCAL artifacts in `docs/research/orv-maker/tapes/` (funding-board precedent #94) | read newest committed artifact; no live fabrication |
| E4 | `GET /api/fleet/status` | the runner registry + per-runner liveness adapters (§5.4) | carry adapter exists; others are small pure functions + a stat/mtime or query |
| E5 | per-symbol live tick for charts: SSE `GET /api/market-data/ticks?symbol&venue` | the engine's own feed / plant mids | last-bar refresh for `<mkt-chart>`; bar cadence honesty note stays |
| E6 | quotes-overlay series: extend `snapshot` or a tiny `GET /api/market-making/quotes?symbol` history ring | `MmBook` (bid/ask/reservation already snapshotted) | ring buffer in memory (e.g. last 2h @1s), clearly labelled non-durable |
| E7 | venue prints tape (market trades) | HL trades-WS (client exists) | **deferred** — panel says so until built |

Everything else in this plan runs on endpoints that exist today (§1).

---

## 8. Component kit additions

| Component | Kind | Notes |
|---|---|---|
| `<mkt-chart>` | WC wrapping vendored lightweight-charts (D1) | candles/line/area/histogram + markers + bands; fetches an engine series URL, renders verbatim; TradingView attribution in footer |
| `<depth-ladder>` | WC, hand-rolled canvas | 20×20 bars, spread gap, our-quote markers; consumes E1 SSE |
| `<live-stat>` | WC | big number + delta flash on change (green/red tick) — header strips, `/wall`, landing tiles |
| `<explain-tip>` + drawer | WC + server partial | §6; registry-driven |
| `<desk-tour>` | WC | §6; server-defined steps |
| `<plant-map>` | server SVG partial + tiny WC | SSE swaps node health classes only |
| `<tape-view>` | WC | the `/plant` sampled topic tap |

All obey the standing rules: no business math client-side, honest empty/error states,
each is one file in `src/ui/public/`, each server partial is a pure spec'd render fn.

---

## 9. Design language — "visually enticing" without becoming a toy

The terminal-dark identity **is** the brand (it reads as a real desk — that's the
enticement); we polish it rather than replace it:

- **Type scale discipline:** one mono family, 3 sizes + a display size for `/wall` and
  headline stats. Numbers use tabular figures (no jitter on update).
- **Color discipline** (dataviz rules): near-black background, one brand accent
  (Meridian teal) for chrome/links/selection; **red/green reserved exclusively for
  signed P&L and bid/ask semantics**; a sequential single-hue ramp for depth bar
  intensity; risk states amber/red. No decorative rainbow.
- **Motion = information only:** delta-flash on a changed stat, the stale-dim (exists),
  a subtle pulse on LIVE badges. CSS-only, no animation library. Everything else still.
- **Honest gray:** empty/degraded states get a deliberate style (muted panel + the
  reason + the `<copy-cmd>` fix) so honesty looks designed, not broken.
- **Density toggle stays dense by default;** learn mode is what adds air (captions),
  keeping the operator view uncompromised.
- Run the `dataviz` design pass on the chart palette before P1 ships (per-series colors,
  band opacities, dark-theme contrast).

---

## 10. Phasing (each phase: `tsc --noEmit` clean, render-fn specs, touched-area jest,
UI-QA trace per the session rule, journal entry)

| Phase | Ships | Acceptance |
|---|---|---|
| **P1 — the math on screen** | D1 decided + `<mkt-chart>`; chart drawers on `/desk/statarb` (legs+spread+z+bands+shading), `/desk/mm` (mid/quotes + inventory + attribution area), `/desk/carry` (accrual), `/exec` full equity curves. Uses only existing endpoints. | open a pair card → the z-chart matches the card's number; kill Postgres → drawers degrade honestly; all specs green |
| **P2 — the market terminal** | E1 + E5 (+E6); `/markets` page: candles + overlays + `<depth-ladder>` + header strip. | watch a live HL book tick in the ladder; toggle our-quotes overlay while a book runs and see the spread straddle mid; feed drop ⇒ dim |
| **P3 — the teaching layer** | explain registry + `<explain-tip>` + learn mode + `<desk-tour>` (mm/markets/risk) + `/learn` hub + `/courses/*` same-origin (D2) + TEACHING_SURFACE.md. | learn=off is pixel-identical; every registered id resolves (spec); a tour runs end-to-end on `/desk/mm`; course chapter opens same-origin |
| **P4 — the plant on screen** | E2 + E4; `/plant` (map + topic health + tap + node explainers) + `/fleet`. | with md-plant up: topics green, tap shows live mids; kill it: map goes red honestly; `/fleet` shows carry LIVE + orv artifact age |
| **P5 — the probability desk** | E3; `/desk/probability` (fair board + Brier scorecard + replay reads). | scorecard matches the #96 artifact numbers; "n too small" state before enough resolutions; calibration-before-capital banner present |
| **P6 — the showcase** | `/wall` + landing v2 + the design polish pass. | wall rotates on a TV for 10 min without interaction; landing tiles tick |

Order rationale: P1 is the highest value-per-effort (Ronnie's stated gap, zero engine
work) and forces D1 immediately; P2 needs one endpoint; P3 is pure UI + content and
unblocks mendy-hq Phase-1/3 sessions; P4/P5 need the new bridges; P6 assembles.

---

## 11. Decisions for Ronnie (blocking starts marked)

- **D1 (blocks P1):** vendored `lightweight-charts` wrapped in `<mkt-chart>` —
  recommended — vs hand-rolled-only charts.
- **D2 (P3):** serve built courses same-origin at `/courses/*` (recommended; Netlify
  remains for public).
- **D3 (P6):** `/wall` in scope now, or park until a real classroom need.
- **D4 (naming):** `/plant` vs `/infra`; `/learn` vs `/academy`. (Plan assumes
  `/plant` + `/learn`.)
- **D5:** `/learn` copy stays generic ("the Academy") — mendy-hq is referenced by its
  stable-URL contract, never by runtime coupling (repo self-containment holds).

## 12. Non-goals (unchanged doctrine, restated)

No SPA/build pipeline; no client-side business math; no fabricated numbers or mock data
in live views; no embedded shell; no write path to out-of-process runners from the UI;
no cross-repo imports (mendy-hq points at us via TEACHING_SURFACE.md, full stop); VPIN
stays unshown until wired; real-money surfaces stay parked (mission is paper-only).
