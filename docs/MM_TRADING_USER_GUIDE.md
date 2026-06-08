# MM Trading — User Guide

A plain-language guide to **running the market-making desk and reading what it tells you**. It
covers the `/demo` dashboard card-by-card (every number, its sign, what "good" and "bad" look
like), the risk controls, and how to watch a run. For the exact start command and the full knob
reference, see **[RUN_THE_DESK.md](RUN_THE_DESK.md)**; for the research story behind the design, see
[QUANT_JOURNAL.md](QUANT_JOURNAL.md) and [MARKET_MAKING.md](MARKET_MAKING.md).

> **What this is.** A **paper-trading** maker desk: it posts a bid and an ask on each instrument,
> earns the spread + maker rebate on passive fills, and skews/caps its quotes to control inventory.
> Real market data, simulated fills, **no real capital**. The whole game is *honest numbers* — every
> gauge below is computed from real fills or measured flow, never faked.

---

## 1. Start a run (90 seconds)

Two terminals (Postgres must be up on :5433 — `sudo docker compose up -d postgres`):

```bash
# terminal 1 — the canonical run (full command + every knob: RUN_THE_DESK.md §1)
… bash scripts/start-desk.sh            # neutral spread + governor; add the hedge overrides for Run A′
# terminal 2 — launch the 8 books
bash scripts/launch-mm-10h.sh
```

Then open **http://localhost:3100/demo** and scroll to the **Market-Making** panel. Each instrument
gets one **book card**. The rest of this guide is how to read it.

---

## 2. The desk summary line

Above the cards:

```
8 books · net 1,240 USDC · net Δ $612,300 → $1,080 hedged · live
```

- **net … USDC** — the whole desk's net P&L right now (sum of every book's net).
- **net Δ … → … hedged** *(only when the delta hedge is on)* — **gross** directional dollar exposure
  across all books, and the **residual** after the paper perp hedge. The job of the hedge is to keep
  the second number near flat. A big gap (gross large, residual ~0) means the hedge is working.
- **live / paused** — whether the desk loop is quoting.

---

## 3. Reading a book card

Header: the **symbol**, a **risk verdict** chip (`Allow` good; `Pause`/`Deny` = not quoting), a
`warming` chip until the σ window fills, and an `✕` to flatten + remove the book. The meta line shows
the strategy family, fill counts (`12 fills (7▾/5▴)` = 7 bid-side, 5 ask-side), bars seen, and quote
age.

Then the grid. **Color = is this good for us:** green = in our favor, red = against us, neutral
(grey) = directional facts that aren't "good" or "bad" by themselves. **Hover any cell for a
tooltip.** Cells in order:

### Quote state
| Cell | Meaning | How to read it |
|---|---|---|
| **bid / ask** | our two resting quote prices | the market we're making |
| **spread** | ask − bid, in bps | wider = safer but fewer fills; tighter = more fills but more pickoff |
| **skew** | quote-center lean off the mid, in bps | how hard the quoter is leaning to shed inventory or lean on a bias. ≠0 means it's pushing the position toward flat |

### Position & risk
| Cell | Meaning | How to read it |
|---|---|---|
| **VPIN** | flow toxicity, 0–1 | informed-flow probability. Low = calm two-sided flow (farm the rebate). **High (red ≥0.7) = one-sided/informed flow — where you get picked off.** |
| **inventory** | signed position in base units | long (+) / short (−). Neutral color — a short isn't "bad" |
| **exposure** | inventory marked at the live mid ($) | your directional dollar risk right now |
| **rail** | exposure as a % of the inventory cap | **near 100% (red ≥80%) = at the governor's rail**, where it parks the heavy side and refuses to add. Sitting at the rail = the book wants to run a position the governor is refusing |

### P&L — the accounting split (these reconcile to net)
| Cell | Meaning | How to read it |
|---|---|---|
| **realised** | locked-in P&L from closed round-trips | the spread you've actually banked |
| **unrealised** | mark-to-market of OPEN inventory | **the swing column.** A big negative unrealised = you're holding a position that's underwater — this is what drove the worst historical drawdown |
| **fees / reb** | signed fees | **negative = maker rebate earned (good, green)**; positive = fee paid |
| **funding** *(perps)* | funding accrued on the position | + received / − paid |
| **net** | `realised − fees + unrealised + funding` | the bottom line for this book |
| **equity** | capital + net | green when above starting capital |

### P&L — the attribution split (diagnostics: *why* net is what it is)
These explain where net came from. They don't add to net again — they're a second view of the same
money.

| Cell | Meaning | How to read it |
|---|---|---|
| **spread P&L** | gross edge earned vs the fair mid at fill time | the raw maker edge before adverse selection eats into it |
| **adverse** | adverse-selection tax | **negative = the mid moved against our fills after we traded (we got picked off).** If adverse is eating most of spread P&L, you're being adversely selected — the core MM problem |
| **inv carry** | MTM drift on inventory we were *already* holding | the third attribution column — distinguishes "lost on the position we held" from "lost on the fills themselves" |

### Markout curve — the adverse-selection signature
| Cell | Meaning | How to read it |
|---|---|---|
| **mo 1s / mo 5s / mo 30s** | avg per-fill mid move from our side, in bps, at each horizon | the canonical MM diagnostic. **Positive = the move went our way; negative = adverse.** A curve that **sinks further negative as the horizon grows** = toxic flow (informed traders running the price after they hit us). Flat-or-up = benign flow |

### Risk outcome
| Cell | Meaning | How to read it |
|---|---|---|
| **maxDD** | peak-to-trough drawdown, % | **the metric the whole desk minimises.** Red ≥5%. The mission is steady, low-drawdown curves |

Below the grid: an **equity-over-time sparkline** (green/red by sign).

---

## 4. The mental model: four columns

Every book's **net** decomposes into four economic levers. Knowing which one is moving tells you what
to do:

```
net  =  spread captured            (+ the edge you earn quoting)
      − adverse selection          (− the tax when you're picked off)        → fix: micro-price + faster re-quote
      − inventory carry             (− MTM on the position you hold)          → fix: tighter governor / hedge
      + fees/rebate                 (+ the −0.2bps HL maker rebate)
      + funding                     (± perp funding on the position)
```

- **Spread positive, adverse small, inventory small → the desk is working.** This is the goal.
- **Adverse eating spread (markout curve sinking)** → you're quoting off a stale price or too slowly.
  The fix is the fair-value/cadence knobs (micro-price depth, faster re-quote) — see RUN_THE_DESK.
- **Inventory carry is the loss, rail near 100%** → the book is accumulating a one-sided position and
  marking against you. The fix is the inventory governor (tighter caps / skew) and/or the delta hedge.
- **VPIN spiking** → informed flow is in the book; expect adverse to rise. The desk can pause quoting
  here (see §5).

---

## 5. Risk controls

- **Verdict chip** (`Allow` / `Pause` / `Deny`) — the risk gate's current call. `Pause` = standing
  down briefly (toxicity or adverse burst); `Deny` = a hard stop (drawdown or inventory breach). The
  `blocked` chip counts quotes the gate suppressed.
- **The inventory governor** (on by default) — a **hard, deterministic** cap: at the rail the book
  *physically cannot* add to the heavy side, and the quotes actively skew toward flat. The `rail`
  cell shows how close you are. This is a bound, not a tuning knob.
- **VPIN pause** — the toxicity gauge is live, but the **pause is off by default** (gauge-only). To
  arm it, start with `MM_VPIN_PAUSE_THRESHOLD=0.8` (or lower) — the desk then pauses quoting whenever
  VPIN crosses that, on the bar path.
- **Drawdown kill** — quoting denies entirely if NAV falls more than `MM_MAX_DRAWDOWN_PCT` (default
  10%) below its peak.

> **Honest gap (as of 2026-06-08):** the risk *gate* (VPIN pause, adverse pause, inventory/drawdown
> deny) currently runs on the **bar path**. The live HL desk runs **fast-path** books, which surface
> every gauge (VPIN, markout, rail) but don't yet *enforce* the gate's pause — wiring the gate into
> the fast L2 loop is the next step. The deterministic inventory governor *does* apply on both paths.

---

## 6. Watching a run without the UI

```bash
# the trade tape (enter/exit + realised P&L), live
tail -f "$(ls -t docs/research/run-*-mm10h.log | head -1)" | grep --line-buffered DeskEvents

# P&L per book, worst first — net / spread / adverse / inventory / verdict
curl -s localhost:3100/api/market-making/snapshot | jq -r \
 '.books|sort_by(.netPnlUnits|tonumber)|.[]|"\(.symbol)\tnet \((.netPnlUnits|tonumber)/1e6|round)\tadv \((.adverseSelectionUnits|tonumber)/1e6|round)\tvpin \(.vpin)\tinv \(.inventoryUnits)\t\(.lastVerdict)"'

# the markout curve for one book
curl -s localhost:3100/api/market-making/snapshot | jq '.books[]|select(.symbol=="BTC")|{vpin, markout}'

# durable equity / drawdown curve (needs MM_PERSIST + Postgres)
curl -s 'localhost:3100/api/market-making/nav?hours=24&book=BTC' | jq '.[-1].maxDrawdownPct'
```

---

## 7. Stopping cleanly

With `MM_PERSIST=true` the desk rehydrates open books on restart, so **close positions first** or
they reappear next start:

```bash
bash scripts/stop-desk.sh        # flatten + soft-close every book (durable)
```
Then `Ctrl-C` terminal 1. Full ritual + the knob reference: **[RUN_THE_DESK.md](RUN_THE_DESK.md)**.

---

## 8. Quick "what do I do?" reference

| You see… | It means… | Do… |
|---|---|---|
| spread P&L green, adverse small, net green | the edge is real and clean | nothing — this is the goal |
| markout curve sinking (1s→30s more negative) | toxic flow / stale pricing | tighten fair value: lower `MM_FAST_REQUOTE_MS`, raise `MM_MICROPRICE_DEPTH` |
| unrealised deeply red, rail ~100% | one-sided inventory marking against you | tighten the governor (`MM_MAX_INVENTORY_NOTIONAL_FRAC` down) and/or turn on `MM_DELTA_HEDGE` |
| VPIN red (≥0.7) and adverse rising | informed flow in the book | arm `MM_VPIN_PAUSE_THRESHOLD` < 1, or widen with `MM_F3_TOXICITY=true` |
| maxDD climbing past a few % | drawdown building — the thing we minimise | reduce size (`MM_BOOK_NOTIONAL_USD`), tighten caps, hedge |
| verdict `Pause`/`Deny`, many `blocked` | the gate is protecting the book | let it; investigate which limit (VPIN / adverse / drawdown / inventory) |

The one rule the desk is built around: **conserve equity first; the spread edge only counts if
adverse selection and inventory don't give it back.**
