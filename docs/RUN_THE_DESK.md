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
Resets + launches all 8 books as `mm-directional-glft` with the self-gating flow bias
(BTC/ETH/XRP lean once their rolling IC clears ~1–2 min in; ADA/DOGE stay neutral).

## Watch it
```bash
# live trade tape
tail -f docs/research/run-*-mm10h.log | grep --line-buffered DeskEvents

# P&L per book, worst first ($; spread vs adverse vs inventory)
curl -s localhost:3100/api/market-making/snapshot | jq -r \
 '.books|sort_by(.netPnlUnits|tonumber)|.[]|"\(.symbol)\tnet \((.netPnlUnits|tonumber)/1e6|round)\tspread \((.spreadCapturedUnits|tonumber)/1e6|round)\tadv \((.adverseSelectionUnits|tonumber)/1e6|round)\tinv \(.inventoryUnits)\t\(.lastVerdict)"'

# equity curve (persisted to mm_nav)
curl -s localhost:3100/api/market-making/nav | jq .

# desk DELTA HEDGE (when MM_DELTA_HEDGE=true): gross delta, post-hedge residual, hedge P&L, funding
curl -s localhost:3100/api/market-making/snapshot | jq '.hedge | {grossDeltaUsd, residualUsd, hedgePnlUsd, fundingUsd, perUnderlying}'
```

## Stop
`Ctrl-C` in terminal 1.  (Or `kill -9 $(lsof -ti tcp:3100)`.)

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
  bash scripts/start-desk.sh        # neutral mm-glft + notional cap + delta hedge (Run A′)
```
Then launch the books as usual (`bash scripts/launch-mm-10h.sh`). The pre-registered win is
the **post-hedge residual staying near flat** and **per-book maxDD ≤ ~1.5%** (vs #41's 17.6%) —
watch `.hedge.residualUsd` and `.hedge.hedgePnlUsd` on the snapshot. Hedge is paper-only (no real
venue); `MM_DELTA_HEDGE` unset ⇒ the unhedged baseline (the #41 run) for comparison.
Defaults live in `scripts/start-desk.sh`; full rationale in `scripts/launch-mm-10h.sh` header + `QUANT_JOURNAL` #38.
