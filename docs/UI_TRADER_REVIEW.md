# UI Trader Review — the desk through a practitioner's eyes

*2026-07-16, requested by Ronnie mid-P3 ("optimize the UI layout — top priority") off a
live screenshot of `/markets` on SOL·hyperliquid. Seat taken for the review: an intraday
market-maker/operator who lives on this screen for hours — the person the Teaching
Terminal is training students to become. Method: drove every page on real Hyperliquid
data and judged each against how the standard tools (a Binance/Bybit terminal, a DOM
ladder) earn their screen space. Verdict format: **P0 = fixed in this pass**, P1 = next
session, P2 = later. This doc is the standing checklist — strike items as they ship.*

---

## 1. `/markets` — the market terminal

### P0 — fixed in this pass (commit follows this doc)

1. **The depth ladder read as a stacked tower — asks above bids, 40 rows tall.**
   No trader reads depth vertically stacked: you can't see the bid and ask at the same
   depth rank without scanning ~350px of screen, and the whole panel ran ~700px tall.
   **Fixed: the classic side-by-side DOM** — bids left ‖ asks right, prices on the
   *inner* edges (so the spread is the middle gutter your eye already rests on), size
   bars growing *outward*, sizes on the outer edges. Height halved (top 14 of 20
   levels/side by default, `rows=` attribute to taste).
2. **Duplicate price labels — `76.08` printed six times in a row.** The ladder
   formatted prices at 2dp while SOL ticks finer, so *distinct levels collapsed into
   identical labels* — worse than unreadable, actively misleading (it looked like one
   fat level). **Fixed: tick-aware precision** — each frame derives its decimals from
   the actual level spacing, so every level prints distinctly (`76.083` / `76.084`),
   and the spread readout uses the same precision.
3. **Volume axis printed `80000.00`.** Two decimals on volume is noise pretending to
   be information. **Fixed:** the volume pane now uses the chart library's volume
   format (K/M compaction).
4. **Sub-dollar assets would get 2dp candles** (a $0.004 token would render as a flat
   line at `0.00`). **Fixed:** the price axis precision is now server-decided from the
   instrument's scale (2dp ≥ $100 … 6dp under 1¢).
5. **The grid starved the ladder** (280px minimum — too narrow for two columns) while
   the chart carried dead right-margin. **Fixed:** rebalanced to ~62/38 with a 380px
   ladder floor.

### P1 — next (cheap, high value)

- **Cumulative totals.** A ladder without a running "total to here" column makes you
  do the sweep-size arithmetic in your head ("how much would a 500-SOL market sell eat
  through?"). Add a per-side cumulative column (or bar-under-bar), the single most
  useful missing number on the page.
- **Depth imbalance readout.** Σbid-size vs Σask-size over the visible window, as one
  small ratio chip in the ladder header — the fastest "which way is the book leaning"
  read, and it teaches exactly what the micro-price formalizes.
- **Click a ladder price → copy it.** The natural workflow is "see a level → quote
  there". Full prefill-into-the-launch-form is cross-page state; v1 = click copies the
  price (the `<copy-cmd>` idiom), so the operator pastes into `/desk/mm`'s form.
- **Interval picker decoupled from window.** Today `24h` forces 5m candles. A trader
  wants "24h of 1m" sometimes; expose interval as its own select (server still clamps
  bar counts honestly).
- **Crosshair OHLC readout.** The tooltip shows close-style values; a proper
  O/H/L/C+vol line in the legend on hover is the standard read.
- **24h volume in the strip.** last/Δ/range/spread is right; volume completes it.
- **Market prints tape (E7).** The page honestly says the venue's trade tape isn't
  served; it remains the biggest missing *market* element (our fills ≠ the market's
  prints). Needs the HL trades-WS surfaced through an endpoint.

### P2 — later

- Mid-anchored auto-recenter + "pause on hover" on the ladder (once prints/cum arrive).
- A compact watchlist strip (the presets' symbols with last/Δ sparklines) above the
  picker — terminal-style market switching without the form round-trip.
- Keyboard: `/` focuses the symbol picker; `[`/`]` cycle symbols.

---

## 2. `/desk/mm` — the MM console

- **Good:** the attribution grid is the page's soul (spread/adverse/warehouse/fees/
  funding sum to net — no other retail-visible tool shows this per book); WARMING and
  verdict badges are honest; the launch-replaces-book rule is stated where you act.
- **P1 — card scan order.** With 25+ books the cards are a wall: the eye wants
  *sorted by |net P&L|* (or worst-first by drawdown) with a one-line-per-book compact
  mode. A `sort=` query (server-side, no JS state) would do it.
- **P1 — the drawers should say which book is worth opening.** The chart drawer list
  is flat; a tiny inline sparkline or net-P&L number on each summary row would tell
  the operator *which* drawer matters before opening any.
- **P2 —** per-card quote-history mini-chart once the E6 ring exists; bid/ask depth at
  our quote's level (from E1) inside the card.

## 3. `/desk/statarb` — the pairs console

- **Good:** z/β/regime per card; the new pair chart (legs + z + bands + position) is
  exactly the mental picture; the replay-vs-live caveat is stated.
- **P1 —** the card should show *distance to entry* ("z 1.4 / needs 2.0") — the number
  a pairs trader actually watches — not just the current z.
- **P2 —** blotter: cumulative P&L per pair footer; link each closed trade to its spot
  on the pair chart.

## 4. `/desk/carry` — the carry desk

- **Good:** liveness banner first (the #92 lesson), realised-first framing, CLOSED
  rows kept. This page's honesty is its feature — don't "improve" it away.
- **P1 —** annualized realised yield per book (realised-first ÷ capital ÷ age) next to
  the gate % — the carry trader's actual scoreboard ("am I earning the rate I gated on?").

## 5. `/exec` + `/risk`

- **Good:** two honest curves, not one synthetic; the drawdown-vs-budget framing; the
  kill switches are where the risk eyes already are.
- **P1 (`/risk`) —** the table should sort worst-first by default (drawdown, then
  adverse) — a risk page that makes you *find* the problem book has failed its one job.
- **P2 (`/exec`) —** a "since yesterday" delta column per book; the executive question
  is almost always "what changed?".

## 6. Cross-cutting

- **Density is right; navigation is now the cost.** Ten nav entries and growing — group
  the desk pages under one `desk ▾` cluster visually (still plain links) before P4 adds
  `/plant` + `/fleet`.
- **The 2s SSE dim-on-drop is the best honesty feature on the desk** — keep it on every
  new live element (the ladder got it).
- **Latency honesty:** every live panel should say its cadence (the ladder and charts
  do; the strip should note "2s").
- **No fake liquidity anywhere** — the empty/degraded states are consistently honest.
  This is rarer than it sounds in trading UIs; protect it in review.

---

*Fixed-in-this-pass items shipped with specs where testable (tick-aware precision is
canvas-side; the axis hints are spec'd in `chart-spec.spec.ts`). P1 items are sized for
single sessions and none require new engine state except the prints tape (E7) and the
E6 quote ring, both already tracked in UI_REWRITE_PLAN_III §7.*
