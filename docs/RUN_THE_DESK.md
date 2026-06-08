# Run the desk (paper MM, 10h)

Two terminals. Postgres must be up on **:5433** for persistence —
`sudo docker compose up -d postgres` if it isn't, then `npm run migration:run` (once).

> **There is one run.** We keep *one* canonical config (currently the **delta-hedged Run A′**) and
> improve it — we do not maintain a menu of strategies. §1 is that run, spelled out in full. The two
> "profiles" near the bottom are **single-knob A/B toggles** off this same run (e.g. hedge off to
> measure its effect), not separate runs to choose between. Every knob, its default, and **what it
> does to the desk** is in the **Knobs reference** at the bottom.

## 1 — start the server  (terminal 1)
The canonical run: neutral `mm-glft` spread engine + the inventory governor (on by default) + the
paper perp delta hedge. Owns the terminal (Ctrl-C to stop); logs to a `run-<ts>-mm10h.log` the
"Watch it" commands glob for.

```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
TELEMETRY_ENABLED=true \
MM_PERSIST=true \
MM_FAST_REQUOTE_ENABLED=true MM_FAST_REQUOTE_MS=100 MM_CANCEL_REPLACE_LATENCY_MS=30 \
MM_FAST_SYMBOLS=BTC,ETH,SOL,DOGE,BNB,XRP,ADA,SUI \
MM_MICROPRICE_DEPTH=5 \
MM_HARD_INVENTORY_CAP=true MM_INVENTORY_SKEW_MULT=4 MM_MAX_INVENTORY_LOTS=8 \
MM_MAX_INVENTORY_NOTIONAL_FRAC=0.15 \
MM_DELTA_HEDGE=true MM_HEDGE_BAND_USD=2000 \
MM_FLOW_BIAS_LIVE=false \
MM_FLOW_SHADOW=true MM_FLOW_SHADOW_MIN_MS=1000 \
npm run start:dev 2>&1 | tee "docs/research/run-$(date +%Y%m%d-%H%M%S)-mm10h.log"
```
Wait for `Nest application successfully started`. (If it says `EADDRINUSE :3100`, an old server
is still up — free it: `kill -9 $(lsof -ti tcp:3100)`.)

## How the knobs shape the run
The desk's P&L splits into four columns (see "Watch it"): **spread captured** (+), **adverse
selection** (−, getting picked off on a stale quote), **inventory carry** (− when an open position
marks against you), and **fees/rebate** (the −0.2bps HL maker rebate is a +). Each knob group pulls
one of those levers — that's *how* it affects the run:

- **Fair value & cadence → kills adverse selection** (`MM_MICROPRICE_DEPTH`, `MM_FAST_REQUOTE_MS`,
  `MM_CANCEL_REPLACE_LATENCY_MS`). The micro-price centers the quote on book imbalance instead of a
  stale mid; the sub-second re-quote refreshes it before flow runs you over. Tighter (lower ms /
  higher depth) ⇒ **less adverse selection**, at the cost of more order churn (and, in real life,
  rate limits — paper doesn't model those, so 100ms is an *upper-bound* claim). This block is the
  single biggest P&L lever: it flipped spread-vs-adverse from −$1,020 to +$133 (QUANT_JOURNAL
  #27–#33).
- **Inventory governor → caps inventory carry** (`MM_HARD_INVENTORY_CAP`, `MM_INVENTORY_SKEW_MULT`,
  `MM_MAX_INVENTORY_LOTS`, `MM_MAX_INVENTORY_NOTIONAL_FRAC`). The hard + notional caps are
  *deterministic bounds* — the book physically cannot accumulate past them (this is what stopped the
  #41 runaway: −1.65M ADA, BTC at 88% of book notional). The skew mult makes the quotes actively
  lean toward flat. Tighter caps / higher skew ⇒ **less inventory carry and lower drawdown**, but
  you forgo some fills at the rail and give up a little spread to the skew.
- **Delta hedge → removes directional variance** (`MM_DELTA_HEDGE`, `MM_HEDGE_BAND_USD`). A paper
  perp leg offsets each book's *net* delta, so the desk keeps the MM edge (spread + rebate − adverse)
  without the directional swing that was the entire #41 loss. Narrower band ⇒ **residual held closer
  to flat**, but more hedge rebalances ⇒ more taker fees + funding paid. **This is the one change
  that distinguishes the canonical run from the unhedged baseline.**
- **Directional bias → adds a chosen bet** (`MM_FLOW_BIAS_LIVE` and the `MM_DIR_*` knobs). OFF in the
  canonical run: a blind directional lean loses (leverage on noise), and Run A′ must stay neutral so
  the hedge's effect is measurable. `MM_FLOW_SHADOW` records the signal at **zero P&L** so the
  validation set keeps growing for when a *validated* lean returns — it changes data, not behavior.
- **Plumbing → enables measurement, not edge** (`FEED_SOURCE`/`EXECUTION_MODE`/`MOCK_TRADING_ENABLED`
  = real paper trading; `MM_PERSIST` = restart-safe books + the durable NAV/drawdown curve;
  `TELEMETRY_ENABLED` = `/metrics`). These don't move P&L; they make the run real and the result
  observable. `MM_PERSIST=true` is what makes the per-book maxDD metric exist at all.

## 2 — launch the books  (terminal 2)
```bash
bash scripts/launch-mm-10h.sh
```
Resets + launches all 8 books as neutral `mm-glft` at **$1M capital / $100k quote** each. Override:
`MM_BOOK_CAPITAL_USDC=… MM_BOOK_NOTIONAL_USD=… MM_BOOK_STRATEGY=… bash scripts/launch-mm-10h.sh`.

## Watch it
```bash
# full live log — boot, fills, risk verdicts, everything (newest logfile)
tail -f "$(ls -t docs/research/run-*-mm10h.log | head -1)"

# just the trade tape (enter/exit + realised P&L)
tail -f "$(ls -t docs/research/run-*-mm10h.log | head -1)" | grep --line-buffered DeskEvents

# P&L per book, worst first — the four columns the knobs move:
#   net = spread + adverse + inventory + fees;  inv = open inventory units
curl -s localhost:3100/api/market-making/snapshot | jq -r \
 '.books|sort_by(.netPnlUnits|tonumber)|.[]|"\(.symbol)\tnet \((.netPnlUnits|tonumber)/1e6|round)\tspread \((.spreadCapturedUnits|tonumber)/1e6|round)\tadv \((.adverseSelectionUnits|tonumber)/1e6|round)\tinv \(.inventoryUnits)\t\(.lastVerdict)"'

# equity curve (persisted to mm_nav)
curl -s localhost:3100/api/market-making/nav | jq .

# per-book maxDD — the pre-registered win metric (needs MM_PERSIST + Postgres)
curl -s 'localhost:3100/api/market-making/nav?hours=24&book=BTC' | jq '.[-1].maxDrawdownPct'

# delta hedge: gross delta, post-hedge residual, hedge P&L, funding
curl -s localhost:3100/api/market-making/snapshot | jq '.hedge | {grossDeltaUsd, residualUsd, hedgePnlUsd, fundingUsd, perUnderlying}'
```

**The win condition:** post-hedge residual stays near flat (`.hedge.residualUsd`,
`.hedge.hedgePnlUsd`) **and** per-book maxDD ≤ ~1.5% (vs #41's 17.6%), with `adv` (adverse
selection) not eating the `spread` column.

## Stop  (close positions FIRST, or the next start rehydrates them)
With `MM_PERSIST=true` the desk checkpoints live inventory every tick and rehydrates all open books
on boot — so a bare `Ctrl-C` leaves stale positions that reappear in the UI next start. Close the
desk first:
```bash
bash scripts/stop-desk.sh            # flatten + soft-close every book (durable; survives kill -9)
```
Then `Ctrl-C` terminal 1 (or `kill -9 $(lsof -ti tcp:3100)`). The next start comes up clean.

## Analyze after the run
```bash
# score the flow signal's forward-return IC from the shadow capture
npx ts-node -r tsconfig-paths/register scripts/flow-bias-markout.ts \
  docs/research/flow-shadow-<ts>.jsonl 30,60,300,900
```

## Run profiles — the one run, plus two A/B toggles
We run and improve **the canonical config (§1)**. The others below exist only to *measure* one
change against it — change exactly one thing, compare, fold the answer back into the one run.

| Profile | How it differs from §1 | Why you'd run it |
|---|---|---|
| **Canonical (Run A′)** | — (the §1 command as-is) | the run. Neutral spread + governor + delta hedge. |
| Unhedged baseline | **drop** `MM_DELTA_HEDGE`/`MM_HEDGE_BAND_USD` | measures what the hedge is worth — this is the #41 directional-variance baseline. |
| Wrapper shorthand | `bash scripts/start-desk.sh` = §1 fair-value block **but** flow-bias ON + **no** hedge | quick neutral-spread start; **not** the canonical run. To make it canonical: `MM_DELTA_HEDGE=true MM_HEDGE_BAND_USD=2000 MM_MAX_INVENTORY_NOTIONAL_FRAC=0.15 MM_FLOW_BIAS_LIVE=false bash scripts/start-desk.sh` |

---

## Knobs reference (every override: default → effect)
All read once in `src/config/app-config.factory.ts`. Set any on the §1 command; booleans are
`true`/`false`. **bold** = set explicitly in the canonical run. "Effect" = what moves when you turn
it **up / on**.

### Mode — required for a real paper run (plumbing, no P&L effect)
| Env | Default | Effect |
|---|---|---|
| **`FEED_SOURCE`** | `mock` | `binance` = real market data; `mock` = synthetic/offline. |
| **`EXECUTION_MODE`** | `mock` | `paper` = PaperVenue, real prices + simulated fills. |
| **`MOCK_TRADING_ENABLED`** | `true` | `false` for a real paper run. |
| **`TELEMETRY_ENABLED`** | `false` | exposes Prometheus `/metrics` + `/health`. |

### Persistence — needs Postgres :5433 (enables the drawdown metric)
| Env | Default | Effect |
|---|---|---|
| **`MM_PERSIST`** | `false` | books survive restart **and** the `mm_nav` equity/maxDD curve gets recorded. Off ⇒ no DD metric. |
| `MM_FLATTEN_ON_SHUTDOWN` | `false` | flatten on clean shutdown. |
| `MM_NAV_INTERVAL_MS` | `60000` | NAV sample spacing; lower = finer curve, more rows. |

### Fair value + cadence — the adverse-selection lever
| Env | Default | Effect (turn up / on) |
|---|---|---|
| **`MM_MICROPRICE_DEPTH`** | `5` | center quotes on N L2 levels of imbalance ⇒ **less adverse selection**; `0` = stale mid (worst). |
| **`MM_FAST_REQUOTE_ENABLED`** | `false` | turns on the sub-second re-quote loop. |
| **`MM_FAST_REQUOTE_MS`** | `750` | **lower** = fresher fair value, less pickoff, more order churn (Run A′ `100`). |
| **`MM_CANCEL_REPLACE_LATENCY_MS`** | `100` | modeled quote-move latency; **lower** = more optimistic fills (Run A′ `30`). |
| **`MM_FAST_SYMBOLS`** | `BTC,ETH,SOL` | which books get the fast path. |

### Inventory governor — the inventory-carry lever (on by default; #39/#41/#43)
| Env | Default | Effect (turn up / on) |
|---|---|---|
| **`MM_HARD_INVENTORY_CAP`** | `true` | book *physically* parks the heavy side at the rail at \|q\|≥cap ⇒ no runaway inventory. |
| **`MM_INVENTORY_SKEW_MULT`** | `4` | **higher** = quotes lean harder toward flat ⇒ less carry, slightly less spread. |
| **`MM_MAX_INVENTORY_LOTS`** | `8` | lot-count bound; **lower** = tighter inventory, fewer fills. |
| **`MM_MAX_INVENTORY_NOTIONAL_FRAC`** | `0.25` | cap \|inventory\| at this fraction of capital at live mid ⇒ same *risk* across a 100×-price universe (Run A′ `0.15`); `0` = off. |

### Delta hedge — the directional-variance lever (defines the canonical run)
| Env | Default | Effect (turn up / on) |
|---|---|---|
| **`MM_DELTA_HEDGE`** | `false` | paper perp leg offsets net delta ⇒ **removes directional variance** (the #41 loss). |
| **`MM_HEDGE_BAND_USD`** | `2000` | **lower** = residual held tighter to flat, more rebalances ⇒ more hedge cost. |
| `MM_HEDGE_TAKER_BPS` | `2.5` | modeled taker cost per hedge fill. |
| `MM_HEDGE_HALF_SPREAD_BPS` | `1` | modeled half-spread on the hedge leg. |

### Directional / flow bias — a chosen bet (OFF in the canonical run)
| Env | Default | Effect (turn up / on) |
|---|---|---|
| **`MM_FLOW_BIAS_LIVE`** | `false` | quote a live directional skew = a bet; **adds variance**. Canonical run keeps it `false` (the wrapper defaults it `true`). |
| `MM_FLOW_BIAS_HORIZON_MS` | `60000` | forward horizon the bias is validated against. |
| `MM_FLOW_BIAS_MIN_IC` | `0.05` | min signal IC before it acts. |
| `MM_DIR_SPREAD_SKEW` | `0.5` | skew strength when live. |
| `MM_DIR_SINGLE_SIDE_BIAS` | `0.6` | single-sided lean cap; `0` = skew only. |

### Flow shadow — measurement only (no behavior change)
| Env | Default | Effect (turn up / on) |
|---|---|---|
| **`MM_FLOW_SHADOW`** | `false` | record the fast signal to `docs/research/flow-shadow-<ts>.jsonl` at **zero P&L**. |
| **`MM_FLOW_SHADOW_MIN_MS`** | `1000` | min sample spacing; lower = more samples. |

### Per-book launch — terminal 2 (`launch-mm-10h.sh`)
| Env | Default | Effect |
|---|---|---|
| `MM_BOOK_CAPITAL_USDC` | `1000000` | capital per book ($1M = desk scale). |
| `MM_BOOK_NOTIONAL_USD` | `100000` | quote notional per side; sets the lot size the caps bound. |
| `MM_BOOK_STRATEGY` | `mm-glft` | quoter strategy id. |
| `MM_BOOK_SOURCE` | `hyperliquid` | L2 / reference venue. |
| `MM_HOST` | `http://localhost:3100` | server to launch against. |

### Other tunables (rarely touched)
`MM_GAMMA` (0.0025, risk aversion → wider base spread), `MM_KAPPA` (2, order-arrival decay),
`MM_MIN/MAX_HALF_SPREAD_BPS` (1 / 200, clamps), `MM_MAKER_FEE_BPS` (−0.2 HL rebate),
`MM_MAX_DRAWDOWN_PCT` (10, risk-gate trip), `MM_F3_TOXICITY` (false; widens into one-sided sweeps),
`MM_F3_MIN/MAX_SCALE` (0.5 / 3.0), `MM_FUNDING_BIAS_SYMBOLS` (BTC), `MM_FUNDING_REFRESH_MS` (600000).
Full list + comments in `app-config.factory.ts`.

Defaults live in `scripts/start-desk.sh`; full rationale in `scripts/launch-mm-10h.sh` header +
`QUANT_JOURNAL` #38/#41/#43.
