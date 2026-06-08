# Run the desk (paper MM, 10h)

Two terminals. Postgres must be up on **:5433** for persistence —
`sudo docker compose up -d postgres` if it isn't, then `npm run migration:run` (once).

## 1 — start the server  (terminal 1)
```bash
bash scripts/start-desk.sh
```
Owns the terminal; logs to `docs/research/run-<ts>-mm10h.log`. Wait for:
`Nest application successfully started`. (If it says `EADDRINUSE :3100`, an old
server is still up — free it: `kill -9 $(lsof -ti tcp:3100)`.)

## 2 — launch the books  (terminal 2)
```bash
bash scripts/launch-mm-10h.sh
```
Resets + launches all 8 books as **neutral `mm-glft`** + the inventory governor (Journal #39:
the directional lean is OFF this run; `MM_FLOW_SHADOW` still records the signal at zero P&L).

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

## Stop  (close positions FIRST, or the next start rehydrates them)
With `MM_PERSIST=true` the desk checkpoints live inventory every tick and rehydrates all
open books on boot — so a bare `Ctrl-C` leaves stale positions that reappear in the UI next
start. Close the desk first:
```bash
bash scripts/stop-desk.sh            # flatten + soft-close every book (durable; survives kill -9)
```
Then `Ctrl-C` terminal 1 (or `kill -9 $(lsof -ti tcp:3100)`). The next start comes up clean.

## Analyze after the run
```bash
# score the flow signal's forward-return IC from the shadow capture
npx ts-node -r tsconfig-paths/register scripts/flow-bias-markout.ts \
  docs/research/flow-shadow-<ts>.jsonl 60,300,900
```

## Knobs (override on the start command)
```bash
MM_DIR_SINGLE_SIDE_BIAS=0 bash scripts/start-desk.sh   # skew only, never single-sided (more conservative)
MM_FLOW_BIAS_LIVE=false   bash scripts/start-desk.sh   # neutral spread-engine run (no directional bias)
MM_FAST_REQUOTE_MS=250    bash scripts/start-desk.sh   # slower cadence
```

## The delta-hedged run (HEDGING_MODEL.md — isolate the MM edge from directional variance)
The #41 loss was net delta, not spread. To run the desk with the paper perp delta hedge on
(each book's net delta offset on a PaperVenue perp leg fed by the live HL mid):
```bash
MM_DELTA_HEDGE=true MM_HEDGE_BAND_USD=2000 MM_MAX_INVENTORY_NOTIONAL_FRAC=0.15 \
MM_FLOW_BIAS_LIVE=false \
  bash scripts/start-desk.sh        # neutral mm-glft + notional cap + delta hedge (Run A′)
```
`MM_FLOW_BIAS_LIVE=false` is required: `start-desk.sh` defaults the flow-bias skew ON, and Run A′
must be **neutral** to isolate the hedge. Then launch the books as usual
(`bash scripts/launch-mm-10h.sh`). The pre-registered win is the **post-hedge residual staying
near flat** and **per-book maxDD ≤ ~1.5%** (vs #41's 17.6%) — watch `.hedge.residualUsd` +
`.hedge.hedgePnlUsd` on the snapshot and the per-book `maxDrawdownPct` (commands above). Hedge is
paper-only (no real venue); `MM_DELTA_HEDGE` unset ⇒ the unhedged baseline (the #41 run) for comparison.

Quick mechanism sanity-check (verified 2026-06-08, ~1-min boot): with stale books carrying a
~$614k gross desk delta, the banded hedge drove **post-hedge residual to ~$1,078 (0% of gross)**
in one rebalance — the linear hedge neutralises the directional bet as designed. The multi-hour
maxDD verdict still needs the full run.
Defaults live in `scripts/start-desk.sh`; full rationale in `scripts/launch-mm-10h.sh` header + `QUANT_JOURNAL` #38.
