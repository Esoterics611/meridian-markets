# Trader UI Spec — surfacing the residual-risk instrumentation

> **What this is.** The implementation prompt + spec for the next UI session. The residual-risk work
> (docs/residual_mm_risk_study.md → docs/RESIDUAL_RISK_ROADMAP.md) added desk-grade diagnostics the
> UI doesn't show yet: multi-horizon **markout curves per side**, live **VPIN + F3 reaction**, the
> **hedge-quality KPI** (factor-vs-basis vol, live β/R²), the **flow-shadow capture**, and the
> durable **NAV/maxDD curve**. The study's §6 lists what pro desks run (markout dashboards, toxicity
> monitors, real-time exposure); this doc decides **what we add to the current UI, what we build as
> new tabs, and what we run off the shelf** — from the trader's seat, not the engineer's.
>
> **The trader's screen set** (each its own browser window; our UI is already one route per page, so
> every "tab" below is just a URL):
> 1. *"Am I making money and is it real?"* → `/desk/mm` (exists — small upgrades)
> 2. *"Am I getting picked off?"* → **NEW `/desk/markout`** (the study-§2 page)
> 3. *"What's running over my book right now?"* → **NEW `/desk/toxicity`** (VPIN/flow/F3 monitor)
> 4. *"What am I actually exposed to?"* → `/risk` upgrade now; becomes the WP3 portfolio view
> 5. *"How has the equity curve behaved?"* → Grafana on the existing `/metrics` (off the shelf)

---

## 1. Decision matrix (build vs add vs off-the-shelf)

| Need (study §6) | Decision | Why |
|---|---|---|
| Markout / TCA dashboard | **BUILD `/desk/markout`** | The data is already computed in-process (`markout`, `markoutBySide` on every book snapshot) — rendering it is a view, not a project. QuestDB (the study's suggestion) is not in our stack; adding a DB to draw 8 small curves is over-engineering. |
| Toxicity monitor (VisualHFT-style) | **BUILD `/desk/toxicity`** | VisualHFT is a Windows-WPF .NET app needing custom data adapters — wiring it to our feed costs more than rendering our own VPIN/imbalance/F3 series, and we already emit every input it would show. Use VisualHFT only as the *layout reference*. |
| Equity curve / process health over time | **OFF THE SHELF: Grafana + Prometheus** | `TELEMETRY_ENABLED=true` already serves `/metrics`; mm_nav already persists the equity curve. Time-series charting is exactly what Grafana is for — don't rebuild it. Setup steps in §5. |
| Real-time exposure / "Greeks" | **ADD to `/risk` now; rebuild as the WP3 portfolio view later** | Study §6 says desks build this in-house and our §5 portfolio layer *is* that system — but WP3 isn't built yet. Today: surface what exists (hedge legs, inventory notionals, caps, basis σ). When WP3 lands (inventory vector q, live Σ, factor delta), this page becomes its home. |
| Honest-fill backtester (hftbacktest) | **NOT a UI item** | Offline research cross-check for our queue-aware simulator; listed in §5 as an optional research utility. No tab. |
| Quoter reference (Hummingbot) | **NOT a UI item** | Sanity-check reference for GLFT/AS math only. |

---

## 2. NEW `/desk/markout` — "am I getting picked off?" (study §2.1)

**Trader's question:** at what horizon does my fill go bad, on which side, on which book — and is the
defence (F3) actually reacting?

**Layout (server-rendered like `/desk/mm`, SSE-refreshed live region):**
- **Desk header strip:** total fills today, desk-average markout at 1s/60s/300s (the three that tell
  the story: instant / the carry horizon / the saturation read), each colored by sign (green ≥ 0 —
  the move went our way; red < 0 — picked off).
- **Per-book markout cards** (8 books): a compact horizontal bar/sparkline per horizon
  (1s→5s→30s→60s→300s) — **the shape is the diagnostic**: a curve sinking with horizon = informed
  flow; flat after 1s = micro-price is doing its job. Render three rows per book:
  `all` / `buy fills` / `sell fills` (from `markoutBySide`) with fill counts. **Asymmetry between
  buy/sell rows = one-sided informed flow** — flag it (amber) when |buy−sell| at 60s exceeds, say,
  2bps with ≥30 fills/side.
- **F3 reaction line per book:** widen/tighten counts + current scale (already in `b.toxicity`) —
  placed HERE (not just on the P&L card) so cause (toxic flow) and effect (defence fired) and outcome
  (markout curve) read on one screen.
- **Data:** all from `GET /api/market-making/snapshot` — `books[].markout`, `books[].markoutBySide`,
  `books[].toxicity`, `books[].fills/bidFills/askFills`. No new engine work.
- **Honest-numbers note on the page:** "avg per-fill markout; counts < ~30/side are noise — wait."

## 3. NEW `/desk/toxicity` — "what's running over my book right now?"

**Trader's question:** is current flow informed/one-sided, per book — and should I trust the gauge?

**Layout:**
- **Per-book gauge row:** VPIN (0–1, with bucket count — grey the gauge until `vpinBuckets` clears
  the EMA window, the "is it warmed" honesty rule), current F3 scale (×0.5–×3), book imbalance and
  trade-flow imbalance (signed bars, −1→+1).
- **Recent-history strip per book** (last ~15min, client-side ring buffer fed by the SSE tick, the
  `pushHist` pattern /demo already uses): VPIN line + F3-scale line overlaid — the trader SEES the
  defence tracking (or not tracking) toxicity. This is the VisualHFT-equivalent view.
- **Verdict chips:** the book's current RiskGate verdict (Allow/Pause/Deny) with the component that
  fired — the desk's traffic lights, one glance.
- **Data:** `books[].vpin`, `vpinBuckets`, `toxicity.lastScale`, `lastVerdict` (all live today);
  imbalances come on the flow-shadow obs — if not on the snapshot, add `bookImbalance` +
  `tradeFlowImbalance` to the book snapshot (engine already computes both every tick; ~5-line add).
- **Validation footnote:** until `scripts/toxicity-validation.ts` crowns a winner on a WP2 tape
  (vpin vs rolling imbalance — the per-tick covariate already measured useless, roadmap 1c), label
  the gauges "monitoring, not yet validated as predictive". Honesty on the glass.

## 4. UPGRADES to existing pages

**`/desk/mm` (small, this session):**
- Hedge panel already shows `basis σ + % unhedgeable` and the per-book β row (WP1). Add the
  **bucketMs** to the label ("60s buckets") so the horizon is explicit.
- Book cards: add the **60s markout per side** as two small cells (`mo60 b / mo60 a`) — the one
  number from the markout page worth having next to the P&L. Link the card header to
  `/desk/markout` (deep-dive is one click).

**`/risk` (the exposure stopgap until WP3):**
- Add an **exposure block**: per book signed inventory **notional at live mid** (not units — traders
  think in $), % of its cap used (bar), the hedge leg per underlying (net Δ → residual), and the WP1
  desk numbers (factor σ vs basis σ — "what the hedge covers vs what it can't").
- When WP3 lands: inventory vector q, live Σ heat-map, net factor delta, stressed-Σ cap utilization —
  this page is reserved as the portfolio layer's home; design the block layout to extend, not move.

**`/` (landing):** add the two new pages to the launcher grid with one-line descriptions.

## 5. Off-the-shelf, run-it-yourself (no code)

**Grafana + Prometheus on the live desk (recommended, ~10min):**
```bash
# 1. Prometheus scrape config (save as ~/prometheus.yml)
#    scrape_configs:
#      - job_name: meridian
#        scrape_interval: 15s
#        static_configs: [{ targets: ['host.docker.internal:3100'] }]
# 2. Run both (desk already serves /metrics with TELEMETRY_ENABLED=true):
sudo docker run -d --name prom --add-host=host.docker.internal:host-gateway \
  -p 9090:9090 -v ~/prometheus.yml:/etc/prometheus/prometheus.yml prom/prometheus
sudo docker run -d --name grafana -p 3000:3000 grafana/grafana
# 3. Grafana (localhost:3000, admin/admin) → add Prometheus data source http://host.docker.internal:9090
#    → dashboard panels on the meridian_* metrics (equity, event-loop lag, uptime).
```
Worth it for: long-window equity/health charts with zoom — the thing server-rendered pages are bad at.
Not a replacement for the tabs above (markout/toxicity semantics live in our snapshot, not /metrics).

**hftbacktest (optional research utility, not UI):** `pip install hftbacktest` — use its BTCUSDT
order-book-imbalance tutorial to cross-check our queue-aware fill engine's numbers on one captured
day (study §6). One-off comparison, document the delta in the journal.

**VisualHFT / QuestDB:** skip (reasons in §1). Revisit QuestDB only if per-fill capture volume ever
outgrows JSONL + jq.

---

## 6. Implementation notes (for the session that builds this)

- Pattern: copy `mm-desk.controller.ts` + `mm-desk-view.ts` (controller reads
  `MmPortfolioTrader.snapshot()`, view renders, SSE region refreshes; specs in the same shape).
  Honest color semantics are binding (905b838): green = for-us, red = against-us, amber = caution,
  dim = diagnostic/neutral.
- Sparklines: `components.ts` already has `navSparkPanel` — reuse for markout bars / VPIN strips.
- Every new number on the glass must name its horizon and its sample count (the anti-fooling rule —
  same discipline as basisShare hiding until samples > 0).
- Tests: each view gets a spec (render with data / render while priming / honest-color assertions),
  controller specs in the existing shape. UI QA rule applies (trace API → page before closing).

## 7. THE PROMPT (paste for the UI session)

> Build the trader-UI extension per docs/TRADER_UI_SPEC.md: (1) new `/desk/markout` page — per-book
> multi-horizon markout curves split by side with F3 reaction + fill counts, from
> `books[].markout/markoutBySide/toxicity` (spec §2); (2) new `/desk/toxicity` page — VPIN gauges
> (greyed until warmed), F3 scale, signed imbalances with a 15-min client-side history strip
> (spec §3; add bookImbalance/tradeFlowImbalance to the book snapshot if missing — engine computes
> both); (3) `/desk/mm` upgrades: bucketMs label on the hedge panel, per-side 60s markout cells on
> book cards, header links (spec §4); (4) `/risk` exposure block: per-book $ notional vs cap,
> hedge legs, desk factor-vs-basis σ (spec §4); (5) landing-page links. Server-rendered + SSE in
> the existing controller/view/spec pattern; honest colors; every number shows horizon + sample
> count. Verify with tsc + jest foreground; UI-wire QA + session log per the standing rules; commit
> on the branch. Do NOT start Grafana/Prometheus yourself — hand §5's commands to Ronnie.
