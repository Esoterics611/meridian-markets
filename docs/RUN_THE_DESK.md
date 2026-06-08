# Run the desk (paper MM, 10h)

Two terminals. Postgres must be up on **:5433** for persistence —
`sudo docker compose up -d postgres` if it isn't, then `npm run migration:run` (once).

> **The command you want is the full env-var block in §1.** `bash scripts/start-desk.sh` is only
> a shorthand for the *neutral-spread baseline* — it bakes in the fair-value/cadence/persistence
> knobs but **not** the delta hedge. The last run (the **delta-hedged Run A′**) is §1 below; copy it
> whole. Every knob and its default is in the **Knobs reference** table at the bottom.

## 1 — start the server  (terminal 1)
This is the exact **delta-hedged Run A′** (HEDGING_MODEL.md): neutral `mm-glft` spread engine +
the inventory governor (now on by default) + the paper perp delta hedge. Owns the terminal
(Ctrl-C to stop); logs to a `run-<ts>-mm10h.log` the "Watch it" commands glob for.

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

**Why each block** (full table at the bottom):
- `FEED_SOURCE … MOCK_TRADING_ENABLED=false` — real Binance data + PaperVenue (real paper trading).
- `MM_PERSIST=true` — restart-safe books + the durable `mm_nav` equity curve (**needs Postgres**).
- `MM_FAST_REQUOTE_* / MM_MICROPRICE_DEPTH=5` — the fair-value fix (F1 micro-price center + sub-second
  re-quote). This is what flipped spread-vs-adverse positive (QUANT_JOURNAL #27–#33).
- `MM_HARD_INVENTORY_CAP / SKEW_MULT / MAX_INVENTORY_LOTS / NOTIONAL_FRAC` — the inventory governor.
  Hard cap + notional cap are deterministic bounds; `NOTIONAL_FRAC=0.15` tightens the #41 default
  (0.25) so no book holds >15% of capital in inventory.
- `MM_DELTA_HEDGE=true MM_HEDGE_BAND_USD=2000` — the paper perp leg that offsets each book's net
  delta (the #41 loss was net delta, not spread). **This is what makes it Run A′ vs the baseline.**
- `MM_FLOW_BIAS_LIVE=false` — **required**: Run A′ must be *neutral* to isolate the hedge. (The
  wrapper defaults this ON.)
- `MM_FLOW_SHADOW=true` — records the directional signal at **zero P&L** so the validation set keeps
  growing for when the time-stopped lean comes back.

### Shorthand (neutral baseline, no hedge)
`bash scripts/start-desk.sh` runs the same fair-value/cadence/persistence block **but with the
flow-bias skew ON and no delta hedge** — i.e. *not* Run A′. To get Run A′ from the wrapper, pass the
two overrides it doesn't bake in:
```bash
MM_DELTA_HEDGE=true MM_HEDGE_BAND_USD=2000 MM_MAX_INVENTORY_NOTIONAL_FRAC=0.15 \
MM_FLOW_BIAS_LIVE=false \
  bash scripts/start-desk.sh
```

## 2 — launch the books  (terminal 2)
```bash
bash scripts/launch-mm-10h.sh
```
Resets + launches all 8 books as neutral `mm-glft` at **$1M capital / $100k quote** each. Override
any of those: `MM_BOOK_CAPITAL_USDC=… MM_BOOK_NOTIONAL_USD=… MM_BOOK_STRATEGY=… bash scripts/launch-mm-10h.sh`.

## Watch it
```bash
# full live log — boot, fills, risk verdicts, everything (newest logfile)
tail -f "$(ls -t docs/research/run-*-mm10h.log | head -1)"

# just the trade tape (enter/exit + realised P&L)
tail -f "$(ls -t docs/research/run-*-mm10h.log | head -1)" | grep --line-buffered DeskEvents

# P&L per book, worst first ($; spread vs adverse vs inventory)
curl -s localhost:3100/api/market-making/snapshot | jq -r \
 '.books|sort_by(.netPnlUnits|tonumber)|.[]|"\(.symbol)\tnet \((.netPnlUnits|tonumber)/1e6|round)\tspread \((.spreadCapturedUnits|tonumber)/1e6|round)\tadv \((.adverseSelectionUnits|tonumber)/1e6|round)\tinv \(.inventoryUnits)\t\(.lastVerdict)"'

# equity curve (persisted to mm_nav)
curl -s localhost:3100/api/market-making/nav | jq .

# per-book maxDD — the pre-registered Run A′ metric (needs MM_PERSIST + Postgres)
curl -s 'localhost:3100/api/market-making/nav?hours=24&book=BTC' | jq '.[-1].maxDrawdownPct'

# desk DELTA HEDGE (when MM_DELTA_HEDGE=true): gross delta, post-hedge residual, hedge P&L, funding
curl -s localhost:3100/api/market-making/snapshot | jq '.hedge | {grossDeltaUsd, residualUsd, hedgePnlUsd, fundingUsd, perUnderlying}'
```

**Run A′ pre-registered win:** post-hedge residual stays near flat (`.hedge.residualUsd`,
`.hedge.hedgePnlUsd`) **and** per-book maxDD ≤ ~1.5% (vs #41's 17.6%). Hedge is paper-only (no real
venue). Drop `MM_DELTA_HEDGE` to get the unhedged #41 baseline for comparison.

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

---

## Knobs reference (every override, with code default)
All read once in `src/config/app-config.factory.ts`. Set any on the start command (§1); booleans are
`true`/`false`. **bold** = set explicitly in the Run A′ command above.

### Mode (required for a paper run)
| Env | Default | Meaning |
|---|---|---|
| **`FEED_SOURCE`** | `mock` | `binance` = real public market data; `mock` = synthetic. |
| **`EXECUTION_MODE`** | `mock` | `paper` = PaperVenue (real prices, simulated fills). |
| **`MOCK_TRADING_ENABLED`** | `true` | set `false` for a real paper run. |
| **`TELEMETRY_ENABLED`** | `false` | Prometheus `/metrics` + `/health`. |

### Persistence (needs Postgres :5433)
| Env | Default | Meaning |
|---|---|---|
| **`MM_PERSIST`** | `false` | restart-safe books + durable `mm_nav` curve. |
| `MM_FLATTEN_ON_SHUTDOWN` | `false` | flatten on clean shutdown (see stop-desk.sh). |
| `MM_NAV_INTERVAL_MS` | `60000` | NAV sample cadence. |

### Fair value + cadence (F1 — the spread-edge fix)
| Env | Default | Meaning |
|---|---|---|
| **`MM_MICROPRICE_DEPTH`** | `5` | quote center off N L2 levels; `0` = plain mid. |
| **`MM_FAST_REQUOTE_ENABLED`** | `false` | sub-second re-quote loop. |
| **`MM_FAST_REQUOTE_MS`** | `750` | re-quote interval (Run A′ uses `100`). |
| **`MM_CANCEL_REPLACE_LATENCY_MS`** | `100` | modeled cancel/replace latency (Run A′ `30`). |
| **`MM_FAST_SYMBOLS`** | `BTC,ETH,SOL` | which books get the fast path. |

### Inventory governor (Journal #39/#41/#43 — now ON by default)
| Env | Default | Meaning |
|---|---|---|
| **`MM_HARD_INVENTORY_CAP`** | `true` | park the accumulating side at the rail at \|q\|≥cap. |
| **`MM_INVENTORY_SKEW_MULT`** | `4` | scale the A-S skew so reservation mean-reverts to flat. |
| **`MM_MAX_INVENTORY_LOTS`** | `8` | lot-count inventory bound. |
| **`MM_MAX_INVENTORY_NOTIONAL_FRAC`** | `0.25` | cap \|inventory\| at this fraction of book capital at live mid (Run A′ `0.15`); `0` = off. |

### Delta hedge (HEDGING_MODEL.md — what makes it Run A′)
| Env | Default | Meaning |
|---|---|---|
| **`MM_DELTA_HEDGE`** | `false` | paper perp leg offsetting net delta. |
| **`MM_HEDGE_BAND_USD`** | `2000` | rebalance band — hedge only when \|residual\| exceeds it. |
| `MM_HEDGE_TAKER_BPS` | `2.5` | modeled taker cost on the hedge leg. |
| `MM_HEDGE_HALF_SPREAD_BPS` | `1` | modeled half-spread on the hedge leg. |

### Directional / flow bias (OFF for Run A′)
| Env | Default | Meaning |
|---|---|---|
| **`MM_FLOW_BIAS_LIVE`** | `false` | quote a live directional skew. **Must be `false` for Run A′** (the wrapper defaults it `true`). |
| `MM_FLOW_BIAS_HORIZON_MS` | `60000` | forward horizon the bias is validated against. |
| `MM_FLOW_BIAS_MIN_IC` | `0.05` | min signal IC to act on. |
| `MM_DIR_SPREAD_SKEW` | `0.5` | skew strength when live. |
| `MM_DIR_SINGLE_SIDE_BIAS` | `0.6` | single-sided lean cap; `0` = skew only. |

### Flow shadow (measure-only, zero P&L)
| Env | Default | Meaning |
|---|---|---|
| **`MM_FLOW_SHADOW`** | `false` | record the fast signal to `docs/research/flow-shadow-<ts>.jsonl`. |
| **`MM_FLOW_SHADOW_MIN_MS`** | `1000` | min sample spacing. |

### Per-book launch (terminal 2, on `launch-mm-10h.sh`)
| Env | Default | Meaning |
|---|---|---|
| `MM_BOOK_CAPITAL_USDC` | `1000000` | capital per book ($1M = desk scale). |
| `MM_BOOK_NOTIONAL_USD` | `100000` | quote notional per side. |
| `MM_BOOK_STRATEGY` | `mm-glft` | quoter strategy id. |
| `MM_BOOK_SOURCE` | `hyperliquid` | L2/reference venue. |
| `MM_HOST` | `http://localhost:3100` | server to launch against. |

### Other tunables (rarely touched)
`MM_GAMMA` (0.0025), `MM_KAPPA` (2), `MM_MIN_HALF_SPREAD_BPS` (1), `MM_MAX_HALF_SPREAD_BPS` (200),
`MM_MAKER_FEE_BPS` (−0.2, the HL rebate), `MM_MAX_DRAWDOWN_PCT` (10), `MM_F3_TOXICITY` (false),
`MM_F3_MIN_SCALE` (0.5), `MM_F3_MAX_SCALE` (3.0), `MM_FUNDING_BIAS_SYMBOLS` (BTC),
`MM_FUNDING_REFRESH_MS` (600000). Full list + comments in `app-config.factory.ts`.

Defaults live in `scripts/start-desk.sh`; full rationale in `scripts/launch-mm-10h.sh` header +
`QUANT_JOURNAL` #38/#41/#43.
