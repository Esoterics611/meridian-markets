# UI User Stories — every desk action, through `/demo`

A step-by-step walkthrough of the live trading desk **as a human operating it in the
browser**. Each story is something you should be able to do *through the UI* — with
the exact steps and an honest accessibility status.

Open it with:
```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
  LIVE_AUTOSTART=false npm run start:dev      # → http://localhost:3100/demo
```

**Legend:** ✅ fully in the UI · ⚠️ works with a caveat/workaround · ❌ not in the UI yet (gap).

Panels top→bottom: **Fund overview**, **Launch a station**, **Live position**,
**Strategy signal** (chart), **Strategy catalogue**, **Live books**, **Discovered
pairs** + **Backtest**, **Trade history**. A top control strip holds Market set /
Strategy / Lookback / Backfill / Capital / Start-Stop.

---

## ⭐ The headline question: "Can I deploy several strategies and see trades?"

**Yes.** End-to-end:
1. Top strip → **Market set** = *Crypto — Large Cap* → set **Lookback** 72 → click
   **⤓ Backfill live history**. Real Binance bars load; **Discovered pairs** fills.
2. **▶ Launch a station** (panel 2): Asset class *Large Cap* → Leg A `ETH` / Leg B
   `BTC` → Strategy *Pairs — rolling z-score* → tweak params if you like → **Launch**.
3. Repeat with a different market/strategy: e.g. `SOL/AVAX` + *OU — Bertram bands*,
   `LTC/BCH` + *Pairs — EWMA*. Each appears as a card in **Live books**, trading
   concurrently on live data.
   *(Shortcut: in **Discovered pairs** set N=5, choose "one of each strategy",
   **▶ Trade top N** to launch 5 markets at once.)*
4. Watch them in **Live books** (z, position, equity, sparklines) and **Fund
   overview** (desk equity / P&L / exposure).
5. **See trades:** closed round-trips appear in **Trade history — persisted**
   (every station, survives restart). The single book's fills also show in **Live
   position → Recent fills**.

Caveat ⚠️: a trade only *closes* when the spread mean-reverts past the exit band, so
on 1-minute bars expect minutes-to-hours before round-trips land. Entries can be
near-immediate (the book warms from ~240 real klines), exits are not.

---

## A. Get market data in

**US-1 — Pick an asset class.** ✅ Top strip / Launch panel **Market set** dropdown
(Large Cap, Layer-1, DeFi, ETH ecosystem, Payments & SoV).

**US-2 — Pull real history for that class.** ✅ Set **Lookback (h)**, click **⤓
Backfill live history** → real Binance bars into `market_bars`; the desc shows bars
inserted.

**US-3 — Discover tradeable pairs.** ✅ Auto after backfill — **Discovered pairs**
lists cointegrated pairs with β, p-value, half-life, vol & trend regime chips.

**US-4 — Switch class and re-discover.** ✅ Change **Market set** → the pairs table
resets and re-discovers for the new class (Launch panel legs update too).

## B. Research before you commit

**US-5 — Backtest a pair on real history.** ✅ **Discovered pairs → backtest** on a
row → **Backtest** panel shows trades / Sharpe / total PnL / win-rate / max-DD over
the stored window.

**US-6 — Compare strategies on a pair.** ⚠️ Pick a different **Strategy** in the top
strip, click **backtest** again. One at a time (no side-by-side sweep table in the
UI — that's the `mq sweep` CLI / `quant-session.ts`).

**US-7 — See the strategy's signal, not the price.** ✅ **Strategy signal** panel
plots the **z-score of the spread** with ±entry/exit **bands** and ▲▼/× **trade
markers** over the recent window. This is "what the strategy trades."

**US-8 — Read a specific book's signal.** ✅ Click **▸** on any **Live books** card →
the signal chart focuses that book's pair+strategy.

**US-9 — Fall back to the raw price chart.** ✅ Strategy signal panel → **price**
toggle shows leg-A candles; **z-score + bands** toggles back.

## C. Launch strategies — the cockpit

**US-10 — Launch one strategy on one market.** ✅ **Launch a station**: class → leg
A/B → strategy → **Launch**. Starts an isolated paper book.

**US-11 — Edit a strategy's params before launching.** ✅ The **Strategy params** row
renders editable inputs from the catalogue defaults (entry/exit z, z-lookback, EWMA
λ, OU window, tx-cost) — change them, then Launch.

**US-12 — Use the discovery-fitted hedge ratio.** ✅ **β** auto-fills from discovery
when the pair was found cointegrated (note shows p-value/half-life); editable.

**US-13 — Set the capital for a station.** ✅ **Capital (USDC)** in the Launch panel;
each station gets its own pool.

**US-14 — Deploy several strategies at once.** ✅ Launch repeatedly — books accumulate
in **Live books** (additive; existing books untouched).

**US-15 — Bulk-launch the top N markets.** ✅ **Discovered pairs**: set **N** (1–12) →
**▶ Trade top N** launches the top N pairs as a portfolio.

**US-16 — Run one of every strategy at once.** ✅ Discovered pairs → mix = **one of
each strategy** → **▶ Trade top N** spreads the catalogue across the books.

**US-17 — Re-launch a market with new params.** ✅ Launch the same pair again with
changed params/β — it replaces that station in place.

**US-18 — Quick-trade a single pair (legacy path).** ✅ **Discovered pairs → trade**
arms the single **Live position** book (separate from the launched stations).

## D. Monitor the desk

**US-19 — See desk-wide equity & P&L.** ✅ **Fund overview**: equity, capital, net /
realised / unrealised P&L across the single book + all stations.

**US-20 — Track desk equity over time.** ✅ Fund overview **equity sparkline**;
header **P&L** badge updates live.

**US-21 — See exposure by asset class.** ✅ Fund overview **exposure** chips (each
book mapped to its preset class, % of equity).

**US-22 — Count books & open positions.** ✅ Fund overview **Books** / **Open pos**.

**US-23 — Watch every live book's variables.** ✅ **Live books** cards: z, β, bands,
regime, position, capital, equity, realised/unrealised, bars seen.

**US-24 — Watch a book's z & equity over time.** ✅ Each card has **z** and **equity**
sparklines updating on the 4s poll.

**US-25 — See which strategy each book runs.** ✅ Card header + **Strategy catalogue**
shows live-usage ("N live · pairs") per strategy.

**US-26 — Browse all available strategies + params.** ✅ **Strategy catalogue** stacks
every working strategy with family, course ref, risk profile and frozen params.

**US-27 — Know the feed/venue and that it's live.** ✅ Header badges: **feed**,
**venue**, **live/paused**, plus a live **UTC clock** and a refresh **heartbeat**.

**US-28 — Confirm data is fresh per book.** ✅ Each card shows **last bar Xs**; a
**STALE** chip appears if a running book's last bar is >180s old.

**US-29 — Auto-refresh without reloading.** ✅ All panels poll every 4s.

## E. See the trades

**US-30 — See the persisted trade ledger.** ✅ **Trade history — persisted** lists
closed round-trips (time, pair, side, entry/exit z, PnL) from `stat_arb_trades` —
spans every book, survives restart.

**US-31 — See the active single book's recent fills.** ✅ **Live position → Recent
fills** (in-memory, single book).

**US-32 — Verify a station actually traded.** ⚠️ Per-station fills aren't itemised on
the book card; read them in **Trade history** (filter by pair visually) — a
per-book trade drill-down is a planned add.

**US-33 — Watch realised P&L accrue per book.** ✅ Each **Live books** card shows
**Realised** updating as round-trips close.

## F. Risk & control

**US-34 — See desk drawdown.** ✅ Fund overview **Drawdown** (vs peak equity, live).

**US-35 — Get alerted to stale feeds.** ✅ Fund overview **alerts**: `STALE FEED ·
pair · Ns` when a running book stops getting bars.

**US-36 — Get alerted to risk-gate trips.** ✅ Alerts show `RISK GATE · pair · N
blocked` when the drawdown gate rejects entries; the card shows an **N blocked** chip.

**US-37 — Get alerted to a drawdown breach.** ✅ Alerts show `DRAWDOWN · desk N%`
past 5%.

**US-38 — Halt everything instantly.** ✅ Fund overview **■ HALT ALL** stops the
single book and every station (`POST /…/live/kill`).

**US-39 — Stop the whole portfolio.** ✅ **Live books → ⏸ Stop all**.

**US-40 — Start/stop/step the single book; set its capital.** ✅ Top strip **▶ Start /
⏸ Stop**, **Set capital**; single-step is the `…/live/tick` endpoint.

## G. Not in the UI yet (honest gaps)

**US-41 — Flatten (force-close) an open position.** ❌ Kill/Stop halt *new* entries
but leave open positions open; there is no "close this position now" button yet
(needs a backend `flatten` + strategy-state reset). *Top priority gap.*

**US-42 — Stop / remove a single station** (not all). ❌ Only "Stop all" / "HALT
ALL"; you can't pause or drop one book from the UI. (Re-launching replaces it.)

**US-43 — Change a running station's capital/params in place.** ⚠️ Only by
re-launching the same pair (which restarts its book).

**US-44 — Per-book risk gauge (drawdown vs gate bar).** ⚠️ Surfaced as alerts/chips,
not a per-book gauge.

**US-45 — NAV history curve from `stat_arb_nav`.** ⚠️ Shown as a client-side equity
sparkline, not the persisted daily NAV series.

**US-46 — Research tools (walk-forward, parameter sweep, Monte-Carlo).** ❌ Endpoints
exist (`/api/stat-arb/research/*`) but aren't surfaced in `/demo`.

**US-47 — Funding-carry & cross-sectional basket strategies.** ❌ Not launchable —
the live loop is 2-leg only, so these are catalogued `liveCapable:false` and don't
appear in the launch menu.

**US-48 — OU band overlay on the signal chart.** ⚠️ OU books show the z line + trade
marks but no band lines (its bands are model-derived μ ± Bertram, not a flat z).

**US-49 — Treasury/yield module.** ❌ Separate concern (`/api/treasury/*`); not part
of the trading desk UI by design.

**US-50 — Stream updates (no 4s poll jitter).** ⚠️ Polling today; an SSE/WebSocket
push is the planned upgrade.

---

### Coverage summary
Setup, research, launching (single + multi + params), monitoring, trades, and
desk-level risk/alerts/kill are all reachable in the UI (US-1–40). The notable
missing *controls* are **flatten** and **per-station stop** (US-41, US-42); the rest
of §G is depth (research tools, NAV curve, streaming) tracked in
[UI_REWRITE_SPEC.md](./UI_REWRITE_SPEC.md).
</content>
