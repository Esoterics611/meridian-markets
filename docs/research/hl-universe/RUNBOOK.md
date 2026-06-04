# Hyperliquid discovery → L2 verdict — multi-hour runbook

> Self-contained steps to run the HL market-discovery pipeline for several hours on your own box. The discovery **scan** is a one-shot snapshot; the multi-hour work is the **L2 capture** it hands off to (the honest fill/queue verdict the OHLCV scan cannot give). Everything here is DB-free, server-free, paper-only, and hits HL's public `info` endpoint (no key).

## What the scan found (2026-06-04, full 230-perp HL universe)

At a fixed 1bps half-spread the OHLCV proxy nets **negative across every perp** — expected, because it charges full-σ adverse selection against a tiny fixed spread while the live book quotes a **σ-proportional** spread. So the deliverable isn't "quotable yes/no"; it's the **σ-ranked liquid shortlist** to point the L2 capture at:

| Rank by 1m-σ | Perp | σ (bps) | $vol/day | funding APR | note |
|---|---|---|---|---|---|
| calmest non-major | **XRP** | 11.6 | $96M | **−19%** | as calm as ETH; −funding ⇒ a forced-short maker *earns* carry |
| | **DOGE** | 12.1 | $22M | ≈0% | |
| | **ASTER** | 12.1 | $18M | +8% | |
| | **BNB** | 13.0 | $27M | +2% | |
| (majors, controls) | ETH / BTC / SOL | 11.6 / 11.7 / 13.4 | huge | varies | |

These four non-majors are the `hl-discovery` MM preset. **Honest caveat:** ranked by inventory risk only — *not* a profitability verdict. Capture L2 + tune before sizing.

---

## Prereqs (once)

```bash
cd ~/code/meridian-markets
git pull                      # get the discovery script + hl-discovery preset
# network reachability to HL (should print a JSON blob):
curl -s -XPOST https://api.hyperliquid.xyz/info -H 'content-type: application/json' \
  -d '{"type":"metaAndAssetCtxs"}' | head -c 200; echo
```

No Postgres, no server needed for the capture/tune pipeline (Track 1). Track 2 (paper books + durable NAV) needs the server + Postgres.

---

## Track 1 — the multi-hour L2 capture → γ/κ verdict (the main run)

### Step 1 — (optional) refresh the discovery shortlist

```bash
HLD_INTERVAL=1m HLD_BARS=240 HLD_SHORTLIST=30 \
  npx ts-node -r tsconfig-paths/register scripts/hl-universe-discovery.ts
```
Reads the "Suggested next L2-capture symbols" line at the bottom; writes a JSON artifact to `docs/research/hl-universe/`.

### Step 2 — capture a real L2 tape for several hours (THE multi-hour step)

`scripts/mm-l2-session.ts` polls HL's live `l2Book` (20×20 depth) + the real trades WebSocket on a cadence, builds a per-coin tape, and saves it. Run it **detached** so it survives closing the terminal. Pick a duration in **minutes** (`MM_L2_DURATION_MIN`) — e.g. 240 = 4 hours, 360 = 6 hours.

```bash
mkdir -p docs/research/l2-tapes
TAPE=docs/research/l2-tapes/hl-discovery-$(date +%Y%m%d)

MM_L2_COINS=XRP,DOGE,ASTER,BNB,BTC,ETH,SOL \
MM_L2_POLL_S=30 \
MM_L2_DURATION_MIN=240 \
MM_L2_QUOTE_USD=50000 \
MM_L2_TRADES_WS=true \
MM_L2_SAVE_TAPE=$TAPE \
nohup npx ts-node -r tsconfig-paths/register scripts/mm-l2-session.ts \
  > docs/research/l2-tapes/capture-$(date +%Y%m%d).log 2>&1 &

echo "capture PID $! — tailing the log (Ctrl-C just stops the tail, not the capture):"
tail -f docs/research/l2-tapes/capture-$(date +%Y%m%d).log
```

- BTC/ETH/SOL are included as **controls** (the calm-liquid majors) so the discoveries are judged against the known book.
- `MM_L2_POLL_S=30` over 240 min ≈ **480 tape steps/coin** — a solid tape. Finer polls (10–15s) give a denser tape but more HTTP.
- It runs for `MM_L2_DURATION_MIN`, prints a live LobReplayHarness report, then **saves one file per coin**: `docs/research/l2-tapes/hl-discovery-YYYYMMDD-<COIN>.json`.
- Detached options: `nohup … &` (above), or `tmux new -s capture` / `screen` then run without `nohup` so you can re-attach. Check it's alive later: `ps aux | grep mm-l2-session`. Stop early: `kill <PID>` (tapes are saved only at the end, so let it finish, or capture in shorter blocks).

### Step 3 — γ/κ-tune over the saved tape (offline, fast, deterministic)

Capture-once, sweep-many: this replays the SAME real flow over a γ/κ/floor grid and reports the drawdown-compliant winner per coin at the HL maker rebate.

```bash
MM_TUNE_TAPE_PREFIX=docs/research/l2-tapes/hl-discovery-$(date +%Y%m%d) \
MM_TUNE_COINS=XRP,DOGE,ASTER,BNB,BTC,ETH,SOL \
  npx ts-node -r tsconfig-paths/register scripts/mm-l2-tune.ts
```

The winner per coin is the `(γ, κ, floor)` with the highest **queue-aware maker-net P&L** that stays under the 2% drawdown cap. **That** is the honest verdict: which discovery perps actually make money as a maker, and at what params.

### Step 4 — act on the verdict

- A discovery perp whose tuned maker-net P&L is **positive and drawdown-compliant** is a real new market → launch a paper book with its tuned params and let the durable NAV track it (Track 2).
- One that's negative even tuned → honest "no", drop it. The desk doctrine is conserve-first / scan-and-wait.

---

## Track 2 — paper-trade the discoveries alongside your live books (optional, parallel)

If the server is already up in paper mode with persistence (`MM_PERSIST=true`, the durable-NAV run), launch the discovery preset as paper books and watch the equity curve:

```bash
# launch all four discoveries as their own HL paper books:
curl -XPOST localhost:3100/api/market-making/launch-preset \
  -H 'content-type: application/json' \
  -d '{"presetId":"hl-discovery","strategyId":"mm-glft","quoteNotionalUsd":50000}'

# watch the durable NAV curve (per book):
curl -s 'localhost:3100/api/market-making/nav?hours=6&book=XRP' | python3 -m json.tool
```

This is forward paper, not the queue-aware verdict — useful for a live-flavour read, but Track 1 (L2 tune) is the honest profitability test.

---

## What to look for / honesty notes

- **Capture health:** the log should show steady polls and non-zero trade-WS aggressor volume. A coin with a near-empty tape (illiquid window) → ignore its tune result.
- **The number that matters** is Step 3's queue-aware maker-net under the drawdown cap, *at the −0.2bps HL rebate* — not the OHLCV scan score (which only ranks inventory risk).
- **Funding** is reported, never added to the edge: it only helps a perp when its sign aligns with the inventory the flow forces on the book (XRP's −19% APR helps a book that ends up *short*).
- Re-run the discovery scan on a different day/regime before trusting the shortlist — one snapshot is n=1.
