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

> **Fast-only (Journal #44).** The queue-aware **L2 fill path is now the default** for any
> L2-capable venue (Hyperliquid) — there is no `MM_FAST_REQUOTE_ENABLED` flag any more, and a
> book launched on a **non-L2 venue is refused** (bar/candle fills are offline-test only). The
> **inventory governor caps + skew are default-ON** (#43), and funding now accrues on the fast
> path too — so the minimal command below is much shorter than older runs'.

**Easiest: `bash scripts/start-desk.sh`** now bakes in the full canonical Run A′ — all four
"make money" pillars ON (hedge + hedge-cost-in-spread + F3 + the OOS β-map), nothing silently off
(Journal #44 DR-0). The explicit equivalent, if you'd rather see every knob:

```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
TELEMETRY_ENABLED=true \
MM_PERSIST=true \
MM_FAST_REQUOTE_MS=100 MM_CANCEL_REPLACE_LATENCY_MS=30 \
MM_FAST_SYMBOLS=BTC,ETH,SOL,DOGE,BNB,XRP,ADA,SUI \
MM_MICROPRICE_DEPTH=5 \
MM_MAX_INVENTORY_NOTIONAL_FRAC=0.15 \
MM_F3_TOXICITY=true \
MM_DELTA_HEDGE=true MM_HEDGE_BAND_USD=2000 MM_HEDGE_COST_SPREAD_MULT=0.5 \
MM_HEDGE_BETA_MAP="SOL:ETH:1.01,DOGE:ETH:0.97,BNB:BTC:0.95,XRP:ETH:0.86,ADA:ETH:1.03,SUI:ETH:1.30" \
MM_FLOW_BIAS_LIVE=false \
MM_FLOW_SHADOW=true MM_FLOW_SHADOW_MIN_MS=1000 \
npm run start:dev 2>&1 | tee "docs/research/run-$(date +%Y%m%d-%H%M%S)-mm10h.log"
```
Wait for `Nest application successfully started`. (If it says `EADDRINUSE :3100`, an old server
is still up — free it: `kill -9 $(lsof -ti tcp:3100)`.) Confirm in the boot log: `desk delta hedge
ON — … target: …` (the β-map) and, once flow comes in, `F3 toxicity:` lines.

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
- **Delta hedge → removes directional variance** (`MM_DELTA_HEDGE`, `MM_HEDGE_BAND_USD`,
  `MM_HEDGE_BETA_MAP`). A paper perp leg offsets the desk's *net* β-weighted delta, so the desk keeps
  the MM edge (spread + rebate − adverse) without the directional swing that was the entire #41 loss.
  It runs on the **fast L2 cadence** now (DR-4 — it tracks the 100ms inventory, not the 15s bar), is
  **folded into desk NAV + on the tape** (DR-2 — a working hedge is finally visible), and the β-map
  hedges the basket with ~2 major legs (ETH/BTC) instead of 8 self-hedges (the #41 "8 books = 1 β
  bet"). Narrower band ⇒ residual held closer to flat, more rebalances ⇒ more taker cost.
- **Hedge cost in spread → keeps hedging from being a sure bleed** (`MM_HEDGE_COST_SPREAD_MULT`). Every
  fill we make is neutralised with a perp taker, so the maker half-spread is widened by that round-trip
  cost — a fill must earn ≥ what it costs to hedge it. `0.5` (default) charges half the per-fill cost (a
  neutral book offsets most flow before it becomes hedged delta); raise toward `1.0` to be stricter,
  **lower it if the wider spread starves the fill rate** (the central cost-vs-fills lever).
- **F3 toxicity → cuts adverse selection from informed flow** (`MM_F3_TOXICITY`, `MM_F3_MIN/MAX_SCALE`).
  Scales the half-spread by trade-flow toxicity vs its rolling average — TIGHTEN into calm two-sided
  flow (farm the rebate), WIDEN into a one-sided sweep (informed flow = where you get picked off). It is
  **instrumented** now (DR-3): `grep 'F3 toxicity'` in the log shows widen/tighten counts so you can
  confirm it actually fired — don't credit a defence you can't measure (Journal #44).
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

# delta hedge: gross delta, post-hedge residual, hedge P&L, funding (folded into desk net)
curl -s localhost:3100/api/market-making/snapshot | jq '.hedge | {grossDeltaUsd, residualUsd, hedgePnlUsd, fundingUsd, perUnderlying}'

# F3 adverse-selection defence — did it fire? (widen/tighten counts per book, logged each NAV tick)
grep 'F3 toxicity' "$(ls -t docs/research/run-*-mm10h.log | head -1)" | tail -3
```

**The win condition (Run A′, pre-registered — `docs/NEXT_RUN_PREREG.md`):** realised-first.
1. **desk REALISED P&L ≥ 0** (the new bar — #44 had bounded DD but bled −$3.26k realised; mark to
   realised, don't count transient unrealised longs);
2. per-book maxDD ≤ ~1.5% (vs #41's 17.6%);
3. the hedge is non-trivially live — `.hedge.hedgePnlUsd` ≠ 0, residual < gross (DR-4);
4. F3 fired — `grep 'F3 toxicity'` shows widen-events > 0 in a toxic window (DR-3).
All four ⇒ gate to Run B (the validated directional lean). If realised < 0, fix adverse / the hedge
map — do **not** add coins.

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
| **Canonical (Run A′)** | `bash scripts/start-desk.sh` (now bakes in §1 exactly: governor + hedge + hedge-cost-in-spread + F3 + β-map) | the run. Neutral spread, directional variance hedged, hedge paid for, adverse defended. |
| Unhedged baseline | `MM_DELTA_HEDGE=false bash scripts/start-desk.sh` | measures what the hedge is worth — the #41 directional-variance baseline. |
| F3 off | `MM_F3_TOXICITY=false bash scripts/start-desk.sh` | measures the adverse-selection defence's contribution. |
| Self-hedge | `MM_HEDGE_BETA_MAP="" bash scripts/start-desk.sh` | hedge each book on its own perp (8 legs) instead of the basket β-map — A/B the capital efficiency. |

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
| **`MM_FAST_REQUOTE_MS`** | `750` | **lower** = fresher fair value, less pickoff, more order churn (Run A′ `100`). |
| **`MM_CANCEL_REPLACE_LATENCY_MS`** | `100` | modeled quote-move latency; **lower** = more optimistic fills (Run A′ `30`). |
| **`MM_FAST_SYMBOLS`** | `BTC,ETH,SOL` | which books get the real **trades-WS aggressor flow** (for VPIN/toxicity). The fast L2 fill path itself is now the default for *all* L2 books — this list just scopes the WS feed. |

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
| **`MM_DELTA_HEDGE`** | `false` (start-desk: **`true`**) | paper perp leg offsets net delta on the **fast cadence** (DR-4) ⇒ **removes directional variance** (the #41 loss); folded into desk NAV + tape (DR-2). |
| **`MM_HEDGE_BAND_USD`** | `2000` | **lower** = residual held tighter to flat, more rebalances ⇒ more hedge cost. |
| **`MM_HEDGE_BETA_MAP`** | self-hedge (start-desk: the **OOS β-map**) | `SYM:UNDERLYING:β` triples fold alts onto a major perp ⇒ hedge the basket with ~2 legs. Re-fit with `scripts/hedge-beta-fit.ts`. |
| **`MM_HEDGE_COST_SPREAD_MULT`** | `0.5` | fraction of the hedge round-trip priced into the maker spread ⇒ each fill earns ≥ its hedge cost. **Lower if fills starve**, raise to be stricter; `0` = don't charge. |
| `MM_HEDGE_TAKER_BPS` | `2.5` | modeled taker cost per hedge fill (also the spread-premium basis). |
| `MM_HEDGE_HALF_SPREAD_BPS` | `1` | modeled half-spread on the hedge leg (also the spread-premium basis). |

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
`MM_MAX_DRAWDOWN_PCT` (10, risk-gate trip), **`MM_F3_TOXICITY`** (start-desk: `true`; widens into
one-sided sweeps, **instrumented** — `grep 'F3 toxicity'`), `MM_F3_MIN/MAX_SCALE` (0.5 / 3.0),
`MM_FUNDING_BIAS_SYMBOLS` (BTC), `MM_FUNDING_REFRESH_MS` (600000).
Full list + comments in `app-config.factory.ts`.

Defaults live in `scripts/start-desk.sh`; full rationale in `scripts/launch-mm-10h.sh` header +
`QUANT_JOURNAL` #38/#41/#43.
