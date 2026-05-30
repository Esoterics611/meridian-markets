# UI Rewrite Spec — from "demo desk" to a Fund Cockpit

Status: **partially shipped** (2026-05-31). Owner: next UI session.
Companion specs: [QUANT_TERMINAL_SPEC.md](./QUANT_TERMINAL_SPEC.md),
[AGENTIC_HEDGE_FUND_DESIGN.md](./AGENTIC_HEDGE_FUND_DESIGN.md).

### Shipped on the current `/demo` (2026-05-31)
A first pass already landed on the existing page, ahead of the full rewrite:
- **Launch cockpit** (`▶ Launch a station`): human picks asset class → market (leg
  A/B) → strategy → **editable params** → β (auto-filled from discovery) → capital →
  Launch. Backed by `POST /api/stat-arb/live/portfolio/launch`, which appends one
  isolated book additively (param overrides threaded registry→trader→portfolio).
- **Full-bleed 12-col layout**; run up to **12 concurrent markets**; "one of each
  strategy" spreads the catalogue across books.
- **Live books** as param cards (z, β, bands, regime, position, capital, equity,
  realised/unrealised) with **z + equity sparklines over time**.
- **Strategy catalogue** stacked, each with params + live-usage.
- **Persisted Trade history** (`GET /…/live/trades`) + NAV-venue fix (see §6).
- **Strategy Chart** (§2.3): `GET /api/market-data/signal-series` runs the chosen
  strategy over the stored window and returns per-bar z + entry/exit bands +
  trade markers; the chart plots the z-score line with ±band price-lines and ▲▼/×
  trade marks, follows the active book, and any live book focuses it with ▸. (OU
  shows z + marks; its bands are model-derived, so no band lines yet.)
- **Terminal aesthetic**: tabular-monospace data, dense low-radius grid, status
  strip with desk P&L + live UTC clock + refresh heartbeat.

Still to do for the full cockpit: the unified **Fund Overview** (§2.1) and
**Risk/kill-switch** (§2.4), the consolidated `/books` + `/fund` read-models (§5),
OU band overlay (μ ± Bertram in z-space), and SSE streaming (§4).

## 0. The reframing

The current `/demo` page (`src/stat-arb/demo/public/index.html`, ~350 lines, one
file) is a **single-book demo view**: pick a preset + strategy, backfill, click a
pair to trade, watch one live card + a chart of one spot leg. It is a *view of one
thing happening*.

What we actually need is a **management + risk console for a desk of N concurrent
books across asset classes** — the screen the one human supervisor watches while
several strategies (and, later, several agents) trade. The UI is not a toy; it is
the **supervisory surface** over the engine.

Three things the current UI does NOT do, that the rewrite must:

1. **Show everything at once.** Positions, PnL, and risk **across all markets and
   all books** in one place — not one pair at a time.
2. **Show the strategy, not the spot price.** The chart today plots leg A's raw
   candles. A quant needs to see *the signal the strategy trades*: the spread /
   z-score with entry/exit bands, β-refit points, regime shading, and the actual
   entry/exit markers — and it must adapt to the selected strategy + params.
3. **Persist what happened.** Today the blotter is in-memory only. Verified:
   `stat_arb_trades` has **0 rows**, yet the loop *does* persist on close — the
   data path is wired but **nothing reads it back**, and two bugs keep it empty
   (see §6). Restart the server and all trade history is gone from the UI.

## 1. Current surface (what to keep / replace)

Backing endpoints that already exist and stay:

| Endpoint | Use |
|---|---|
| `GET /api/market-data/presets` | asset-class market sets |
| `POST /api/market-data/backfill-preset` | pull real Binance history |
| `GET /api/market-data/universe?presetId=&hours=` | pair discovery |
| `POST /api/market-data/backtest` | backtest a pair+strategy on stored bars |
| `GET /api/market-data/candles?symbol=&hours=` | raw OHLC (keep, for the legs) |
| `GET /api/stat-arb/live/strategies` | strategy catalogue |
| `POST /api/stat-arb/live/configure` `/start` `/stop` `/tick` | single-book control |
| `GET /api/stat-arb/live/snapshot` | single-book state |
| `POST /api/stat-arb/live/portfolio` `/portfolio/{start,stop,tick}` | N-book control |
| `GET /api/stat-arb/live/portfolio` | portfolio state |

The single-book vs portfolio split is an artifact. The new UI treats **everything
as books** (a single armed pair is just a 1-book portfolio) and reads one unified
feed (§5).

## 2. Screens

### 2.1 Fund Overview (home — the supervisor screen)
The "1 person watching everything" lands here. All cross-book, cross-asset-class.

- **Header KPIs:** total equity, total capital deployed vs dry powder, realised
  PnL, unrealised PnL, # books running, # open positions, fund-wide max drawdown
  vs gate.
- **Equity / NAV curve:** fund-wide, from `stat_arb_nav` + live mark-to-market.
- **Exposure by asset class:** bar/donut from the books' presets (Large Cap, L1,
  DeFi, ETH-beta, Cross-Asset).
- **Risk banner:** drawdown vs gate per book and fund-wide; blocked-entry count;
  **stale-feed warnings** (last-bar age per book > threshold); kill-switch state.
- **Alerts feed:** newest first — gate trips, stale feeds, drawdown breaches, a
  book stopping. This is what an Ops/Monitor agent writes to (see agentic spec).

### 2.2 Books & Positions (the cross-market blotter)
One row per active book. Sortable; filter by asset class / strategy / state.

Columns: `book id · asset class · pair · strategy · β · z · regime · position
(LONG/SHORT/FLAT) · capital · equity · realised · unrealised · bars seen ·
last-bar age · gate status`.

Row actions: **focus** (opens Strategy Chart §2.3), **stop**, **flatten**.
Backed by the unified `GET /api/stat-arb/books` (§5).

### 2.3 Strategy Chart (the headline ask)
Not a spot chart. For the focused book, render **what the strategy trades**, and
**adapt to the strategy family + params**:

- **pairs-zscore / pairs-ewma (cointegration §2):** the z-score series with
  ±entryZ / ±exitZ band lines, β-refit markers (vertical ticks where the sliding
  cointegration refit fired), and **trade markers** (▲ entry / ▼ exit colored by
  side) at the bars where the loop opened/closed. A second pane shows the two legs
  **normalized to the spread** (price A vs β·price B).
- **ou-bertram / ou-bertram-fast (OU §3):** the spread with the fitted **μ** line
  and the **Bertram entry/exit bands** (a/m), θ shown as a readout, shaded "stand
  aside" regions where θ≤0.

All series come from one new endpoint, `GET /api/stat-arb/signal-series?...`
(§5), which runs the *same strategy code* over the stored/replayed bars and
returns, per bar: `{ ts, priceA, priceB, spread, z, mu, bandHi, bandLo,
position, betaRefit?, trade? }`. Params (entryZ/exitZ/window) come from the
strategy's catalogue defaults, surfaced and (Phase 2) editable.

### 2.4 Risk
Per-book and fund-wide: drawdown gauge vs gate ceiling, exposure caps, correlation
cap, venue cap (the `src/stat-arb/risk/*` engine already computes these in the
backtest path; wire its live equivalents). Controls: **kill switch** (stop all),
**flatten book**, **gate override log**. These are the §6/P2 hardening items.

### 2.5 Trade Blotter (persistent)
Reads `stat_arb_trades` via a new `GET /api/stat-arb/trades` — survives restart.
This is the literal answer to "where can I see the trades." Columns: time, book,
pair, strategy, side, entry/exit z, notional, fees, pnl. CSV export.

### 2.6 Research / Backtest (keep)
The existing discovery table + backtest panel, moved to a tab. Add: "sweep all
strategies on this pair" (the quant-session step 4) and a "promote to live" button
that runs the validate-before-arm gate (§ agentic spec) then arms a book.

## 3. Information architecture

```
┌ Fund Overview ┬ Books & Positions ┬ Strategy Chart ┬ Risk ┬ Blotter ┬ Research ┐
│  KPIs + NAV   │  cross-book table  │  signal+bands  │ caps │ stat_   │ discover │
│  curve +      │  (filter by class/ │  + trade marks │ kill │ arb_    │ + sweep  │
│  exposure +   │   strategy/state)  │  per strategy  │ flat │ trades  │ + promote│
│  alerts       │                    │                │      │         │          │
└───────────────┴────────────────────┴────────────────┴──────┴─────────┴──────────┘
```

Asset-class switching is **not** a single dropdown anymore: you can have books open
across several classes simultaneously (the portfolio trader already isolates N
books). The preset picker becomes "add a book / add a class's top pairs."

## 4. Real-time

Keep the 4s poll for v1 (it already works). Note the documented gap: the feed is
REST-poll, not WebSocket — a `GET /stream` SSE or WS endpoint pushing snapshot
deltas is Phase 2 and removes the poll jitter.

## 5. New endpoints (the rewrite's backend contract)

| Method · Path | Returns |
|---|---|
| `GET /api/stat-arb/fund` | fund aggregate: equity, capital, realised, unrealised, dd, #books, #positions, exposure-by-class, NAV curve |
| `GET /api/stat-arb/books` | unified per-book rows (single + portfolio merged) |
| `GET /api/stat-arb/signal-series?book=…&strategy=…&hours=…` | per-bar `{ts,priceA,priceB,spread,z,mu,bandHi,bandLo,position,betaRefit?,trade?}` |
| `GET /api/stat-arb/trades?venue=paper&limit=` | persisted closed trades (blotter) |
| `POST /api/stat-arb/live/flatten` (+ `?book=`) | close open position(s) |
| `POST /api/stat-arb/kill` / `POST /api/stat-arb/resume` | desk-wide kill switch |
| `GET /api/stat-arb/alerts` | recent alerts (stale feed, gate trip, dd breach) |

`books`, `fund`, and `signal-series` are pure read-models over existing state +
`StatArbRepository`; `signal-series` reuses the strategy classes and the replay
path already used by `POST /backtest`.

## 6. Must-fix wiring (blocks "see my trades"), do these first

These are tiny and unblock everything above:

1. ✅ **DONE (2026-05-31).** Persisted blotter is now readable:
   `GET /api/stat-arb/live/trades?venue=&limit=` returns `stat_arb_trades`, and
   the current `/demo` page shows a "Trade history — persisted" panel. (The
   eventual unified `GET /api/stat-arb/trades` in §5 supersedes the `live/` path.)
2. **The headless runbook never persists.** `scripts/quant-session.ts` builds
   `LivePaperTrader` **without** the repo argument, so its round-trips are printed
   but never written. Pass the repo — but first give it a deterministic clock
   keyed off the bar timestamp, else the tight replay loop collides on the
   `(venue, openedAt:closedAt)` idempotency key and drops trades. (Still open.)
3. ✅ **DONE (2026-05-31).** `nav.cron.ts` now derives its venue from
   `EXECUTION_MODE` (`paper`→`'paper'`), so fund NAV reflects paper trades instead
   of always reading the empty `'mock'` venue.

## 7. Non-goals
- No business / KYB / investor-disclosure theater (already removed — keep it out).
- The UI stays a **thin read/replay over the engine**. No trading logic in the
  browser. Every panel reads a live engine endpoint backed by real Binance data.
- No charting framework churn: keep Lightweight Charts; add series, not a rewrite
  of the chart layer.

## 8. Phasing
- **P0 (unblocks supervision):** §6 fixes + `/trades` + `/books` + `/fund`; Fund
  Overview + Books table + persistent Blotter.
- **P1 (the headline):** Strategy Chart (`/signal-series`) with bands + trade
  markers, per strategy family.
- **P2 (control + hardening):** flatten / kill switch / alerts / Risk tab; SSE
  stream replacing the poll.
</content>
</invoke>
