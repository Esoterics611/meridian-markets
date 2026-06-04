# Meridian Markets — Operator's Manual

> **Who this is for:** you, running the desk. This is the **manual**, not the [cheatsheet](CHEATSHEET.md) — it explains *what each thing is, where its results live, and how to do the recurring jobs* end-to-end, so you're never guessing which of three look-alike commands to run. Read §0 once; the rest is reference.
>
> Server on **`:3100`**, Postgres on **`:5433`**. Everything is **paper-only** — no real money, no keys.

---

## 0. The three systems (read this once — it removes 90% of the confusion)

There are **three separate things**. They run independently. You almost never need to stop one to use another. Most confusion comes from mixing them up.

| | System | What it is | You interact via |
|---|---|---|---|
| **A** | **The live paper desk** | The running "company." Books quote on real data, mark P&L, and the NAV is saved every minute. You start it once and leave it running for hours/days. | `/api/market-making/*`, the `/demo` UI |
| **B** | **The research pipeline** | Offline scripts that **discover** new markets and **tune** parameters. They do **not** touch the desk. They read public data, print results, and write files. | `scripts/*.ts` (run by hand) |
| **C** | **Observability** | How you **see** System A: the dashboard, metrics, health, and the database. Read-only. | `/demo`, `/metrics`, `/health`, `psql` |

**The one-sentence model:** *System A earns the track record; System B finds what to put on System A; System C lets you watch both.*

So when you're "running a 4-hour thing," be clear which it is:
- Leaving the **desk** (A) running for 4h → that's the **track record** (the NAV curve grows).
- Running a 4h **L2 capture** (B) → that's **gathering data to tune params**. It does not trade and does not affect the desk.

---

## 1. Where every result is stored (the storage map)

The most common question: *"is it in the database?"* — Some of it. Here's the whole map.

| Result | Stored in | Survives restart? | How to view |
|---|---|---|---|
| Live book P&L + config (current state) | **Postgres** `mm_book_state` | ✅ yes (rehydrates on boot) | `/demo`, SQL |
| **Desk NAV / equity curve** (the track record) | **Postgres** `mm_nav` (append-only, 1 row/book/min) | ✅ yes | `/demo` NAV panel, `GET /api/market-making/nav`, SQL |
| Live quotes / inventory (this instant) | in-memory only | ❌ no | `GET /api/market-making/snapshot`, `/demo` |
| System metrics (uptime, equity, fills, drawdown…) | in-memory (Prometheus) | ❌ resets on restart | `GET /metrics` |
| **L2 capture tapes** | **files** `docs/research/l2-tapes/*.json` | ✅ (files) | fed into `mm-l2-tune` |
| **Tuned params** (the winners) | **you record them** → [`docs/research/TUNED_PARAMS.md`](research/TUNED_PARAMS.md) | ✅ (committed doc) | open the file |
| HL discovery scans | files `docs/research/hl-universe/*.json` | ✅ (files) | the script prints + the JSON |
| stat-arb trades / NAV | Postgres `stat_arb_trades` / `stat_arb_nav` | ✅ | `/demo`, SQL |

**Rule of thumb:** the **durable desk record (NAV + book state) is in Postgres**; the **research outputs (tapes, scans, tune results) are files**; the **live instant + metrics are in memory** (gone on restart, which is fine — the durable stuff is in Postgres).

### Peek into the database directly
```bash
# the last 12 NAV points (desk row = book_key '', else the symbol):
sudo docker exec -i meridian-markets-postgres-1 psql -U meridian_markets -d meridian_markets \
  -c "SELECT as_of, book_key, equity_units, net_pnl_units, max_drawdown_pct
        FROM mm_nav ORDER BY as_of DESC LIMIT 12;"

# the live books currently checkpointed:
sudo docker exec -i meridian-markets-postgres-1 psql -U meridian_markets -d meridian_markets \
  -c "SELECT book_key, strategy_id, gamma, kappa, status FROM mm_book_state;"
```
(`equity_units` are 6-decimal — divide by 1,000,000 for USDC. Password if prompted: `meridian_markets`.)

---

## 2. Start & stop the desk (System A)

### Start it (the canonical run)
This is the **one** way to start the desk for a real session — paper data, persistence on, NAV cron on:
```bash
cd ~/code/meridian-markets
MM_PERSIST=true \
MM_NAV_INTERVAL_MS=60000 \
TELEMETRY_ENABLED=true \
FEED_SOURCE=binance \
EXECUTION_MODE=paper \
MOCK_TRADING_ENABLED=false \
npm run start:dev
```
What each flag does:
- `MM_PERSIST=true` — save books + NAV to Postgres (the track record; survives restart). **Needs Postgres up + migrations run** (§7).
- `MM_NAV_INTERVAL_MS=60000` — write a NAV point every 60s.
- `TELEMETRY_ENABLED=true` — turn on `/metrics` + `/health` (System C). Optional but recommended.
- `FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false` — real market data, simulated fills, no real orders.

Leave this terminal running. (To run it **detached** so closing the terminal doesn't kill it, prefix with `nohup … &` and redirect to a log, same pattern as the capture in §5.)

### Restart it safely
Just `Ctrl-C` and start it again with the **same** command. Because `MM_PERSIST=true`:
- your books come back automatically (rehydrated from `mm_book_state`) — **but paused**; run `start` to resume:
  ```bash
  curl -XPOST localhost:3100/api/market-making/start
  ```
- the NAV curve continues where it left off (it's all in `mm_nav`).

### Stop / pause / flatten
```bash
curl -XPOST localhost:3100/api/market-making/stop      # pause quoting, keep the books
curl -XPOST localhost:3100/api/market-making/flatten   # close all inventory to flat, keep the books
```

---

## 3. Add a book to the desk (System A)

A "book" = one quoter on one instrument with its own capital + isolated P&L. **Re-launching the same symbol replaces it.**

```bash
# default params (engine defaults γ=0.0025, κ=2):
curl -XPOST localhost:3100/api/market-making/launch -H 'content-type: application/json' \
  -d '{"symbol":"BTC","strategyId":"mm-glft","quoteNotionalUsd":50000,"capitalUsdc":100000}'

# TUNED params (this is "run with the tuned params, not defaults"):
curl -XPOST localhost:3100/api/market-making/launch -H 'content-type: application/json' \
  -d '{"symbol":"BTC","strategyId":"mm-glft","params":{"gamma":0.0005,"kappa":1},"quoteNotionalUsd":50000,"capitalUsdc":100000}'

# a whole preset, each symbol as its own book:
curl -XPOST localhost:3100/api/market-making/launch-preset -H 'content-type: application/json' \
  -d '{"presetId":"hl-perps","strategyId":"mm-glft","quoteNotionalUsd":50000}'

# remove one book (flatten + soft-close):
curl -XPOST localhost:3100/api/market-making/remove -H 'content-type: application/json' -d '{"symbol":"BTC"}'
```

**The floor caveat (important):** `params` only carries **γ and κ**. The third tuned knob, the **spread floor** (`MM_MIN_HALF_SPREAD_BPS`, e.g. 5 bps), is **server config, not per-book** — to use it you set it in `.env` and restart the desk:
```bash
# in .env:  MM_MIN_HALF_SPREAD_BPS=5   then restart (§2). Applies to newly-launched books.
```
Presets: `hl-perps` (BTC/ETH/SOL), `hl-discovery` (XRP/DOGE/ASTER/BNB — the scan's calm non-majors), `stablecoin-peg`, `crypto-majors-mm`, `dex-eth-bluechip`, `fx-via-stables`. List them: `curl localhost:3100/api/market-making/markets`.

---

## 4. View results & live stats (System C)

### The dashboard — start here
Open **http://localhost:3100/demo** → **Market Making** tab. It shows, refreshing live:
- **Maker books** — each book's quotes, inventory, fills, net P&L, and an in-session equity sparkline.
- **Desk NAV — durable track record** — the equity curve read from `mm_nav` (pick 6h / 24h / 72h / 7d). *This is the one that survives restart.* If it says "no NAV points yet," give it 60s, or it means `MM_PERSIST` is off.

### Numbers via the API (no UI)
```bash
curl -s localhost:3100/api/market-making/snapshot          | python3 -m json.tool   # live desk + books
curl -s 'localhost:3100/api/market-making/nav?hours=24'    | python3 -m json.tool   # the durable curve
curl -s 'localhost:3100/api/market-making/nav?hours=24&book=BTC' | python3 -m json.tool
```
(`python3 -m json.tool` pretty-prints — no `jq` needed. If you want `jq`: `sudo apt install -y jq`.)

### System health & metrics (needs `TELEMETRY_ENABLED=true`)
```bash
curl -s localhost:3100/metrics | grep meridian_desk      # desk equity / NAV / pnl / drawdown gauges
curl -i localhost:3100/health/ready                       # 200 ready / 503 not (DB, tick freshness, feed)
```

### Watch it update live (every 5s, no jq)
```bash
watch -n 5 "curl -s localhost:3100/api/market-making/snapshot | python3 -m json.tool"
```

---

## 5. The research pipeline — capture → tune → reuse (System B)

This is the 4-hour job. It finds the **tuned params** by replaying real order-book flow. **It does not trade and does not need the desk.** Four steps, in order.

### Step 1 — (optional) discover which coins to capture
```bash
HLD_INTERVAL=1m HLD_SHORTLIST=30 \
  npx ts-node -r tsconfig-paths/register scripts/hl-universe-discovery.ts
```
Reads the bottom line "Suggested next L2-capture symbols". (Full write-up: [research/hl-universe/RUNBOOK.md](research/hl-universe/RUNBOOK.md).)

### Step 2 — capture a real L2 tape for several hours (the long run)
Run it **detached** and **exactly once** (a second copy corrupts both — see §8). `DURATION_MIN` is in minutes (240 = 4h):
```bash
cd ~/code/meridian-markets
mkdir -p docs/research/l2-tapes
TAPE=docs/research/l2-tapes/hl-discovery-$(date +%Y%m%d)

MM_L2_COINS=XRP,DOGE,ASTER,BNB,BTC,ETH,SOL \
MM_L2_POLL_S=30 \
MM_L2_DURATION_MIN=240 \
MM_L2_QUOTE_USD=50000 \
MM_L2_SAVE_TAPE=$TAPE \
nohup npx ts-node -r tsconfig-paths/register scripts/mm-l2-session.ts \
  > docs/research/l2-tapes/capture-$(date +%Y%m%d).log 2>&1 &

echo "capture PID $! — watch it with:  tail -f docs/research/l2-tapes/capture-$(date +%Y%m%d).log"
```
- It polls the live HL book every 30s + the real trades WebSocket, runs for `DURATION_MIN`, then **saves one tape file per coin** (`…-XRP.json`, …). **Tapes are written only at the END** — let it finish (don't kill it early, or you lose the tape).
- BTC/ETH/SOL are in the list as **controls** (the known calm majors).
- Confirm only one is running: `ps aux | grep mm-l2-session | grep -v grep` → **one** line.

### Step 3 — tune (only AFTER the capture finishes)
This replays the saved tape over a γ/κ/floor grid and prints the best, drawdown-compliant combo per coin at the −0.2 bps HL rebate. **The `$(date)` must match the capture day** (the tape filename date):
```bash
MM_TUNE_TAPE_PREFIX=docs/research/l2-tapes/hl-discovery-$(date +%Y%m%d) \
MM_TUNE_COINS=XRP,DOGE,ASTER,BNB,BTC,ETH,SOL \
  npx ts-node -r tsconfig-paths/register scripts/mm-l2-tune.ts
```
If it says *"tape not found"* → the capture (Step 2) hasn't finished, or the date/prefix doesn't match the saved files (`ls docs/research/l2-tapes/`).

### Step 4 — record the winners, then reuse them
1. **Write the printed winners into [`docs/research/TUNED_PARAMS.md`](research/TUNED_PARAMS.md)** (the tuner doesn't auto-save). That file *is* your "use these in future sessions" store.
2. **Use them**, two ways:
   - **Per book, now:** relaunch with `params` (§3) — `{"gamma":<γ>,"kappa":<κ>}` — and set the floor in `.env` if it differs.
   - **Desk-wide, next session:** set the defaults in `.env` so every future book uses them:
     ```bash
     # .env
     MM_GAMMA=0.0005
     MM_KAPPA=1
     MM_MIN_HALF_SPREAD_BPS=5
     ```
   then start the desk (§2) and launch books normally.

**Honesty:** one tape is n=1. Re-capture on another day/regime before trusting a row live (noted in TUNED_PARAMS.md).

---

## 6. Discover new markets to make markets in (System B)

```bash
npx ts-node -r tsconfig-paths/register scripts/hl-universe-discovery.ts
```
Scans all ~230 HL perps, ranks the **calmest liquid** ones (lowest inventory risk), and suggests a capture shortlist. Reads as net-negative at a fixed spread on *every* perp — that's expected and honest (the real edge is rebate + queue, which only the L2 tune in §5 resolves). The standout non-majors became the **`hl-discovery`** preset. Full method: [research/hl-universe/RUNBOOK.md](research/hl-universe/RUNBOOK.md).

---

## 7. First-time setup & hygiene

### One-time setup
```bash
cd ~/code/meridian-markets
npm install
echo 5784 | sudo -S docker compose up -d postgres     # Postgres 16 on :5433 (sudo pw 5784)
cp .env.example .env                                   # then edit if needed
DATABASE_URL='postgresql://meridian_markets:meridian_markets@localhost:5433/meridian_markets' \
  npm run migration:run                                # creates mm_nav, mm_book_state, … (idempotent)
```

### Git hygiene — what's committed vs ignored
You'll generate lots of run files. They're **already git-ignored**, so don't worry when you see them:
- **Ignored** (yours, not committed): `docs/research/l2-tapes/` (tapes + capture logs), `docs/research/hl-universe/discovery-*.json` (scan reruns), `.env`, `*.log`.
- **Committed** (the shared record): code, docs, this manual, `TUNED_PARAMS.md`, one reference discovery artifact.
- If `git status` ever looks noisy, it's fine — the run artifacts are ignored. **Never commit `.env` or tapes.**

---

## 8. Troubleshooting — the things that will trip you up

| Symptom | Cause | Fix |
|---|---|---|
| A new book shows `mid $1.00`, `bars 0`, `warming` | No live bar yet (warming) — **not broken** | wait ≤1 poll, or `curl -XPOST localhost:3100/api/market-making/tick` |
| `/demo` NAV says "no NAV points yet" | `MM_PERSIST` off, or <60s elapsed | start with `MM_PERSIST=true` (§2); wait a minute |
| `/api/market-making/nav` returns `{enabled:false}` | persistence off / no Postgres | Postgres up + migrations run + `MM_PERSIST=true` |
| Two captures interleaving in the log | started `mm-l2-session` twice | `kill <one PID>`; keep exactly one (`ps aux | grep mm-l2-session`) |
| `mm-l2-tune` says "tape not found" | capture not finished, or wrong date/prefix | let Step 2 finish; `ls docs/research/l2-tapes/`; match the date |
| `jq: not found` | jq not installed | use `python3 -m json.tool`, or `sudo apt install -y jq` |
| Few or zero fills on BTC/ETH/SOL | honest — tight GLFT spread on liquid majors | expected; try tuned params (§3) or a calmer/wider regime |
| `npm run start:dev` exits 144 | only happens in the AI sandbox | on **your** machine it runs fine |

---

### See also
- [CHEATSHEET.md](CHEATSHEET.md) — the terse command list (this manual is the explained version).
- [research/hl-universe/RUNBOOK.md](research/hl-universe/RUNBOOK.md) — the discovery → capture → tune pipeline in depth.
- [research/TUNED_PARAMS.md](research/TUNED_PARAMS.md) — the winners' book.
- [PNL_ACCOUNTING.md](PNL_ACCOUNTING.md) · [TELEMETRY_REQUIREMENTS.md](TELEMETRY_REQUIREMENTS.md) · [ROADMAP.md](ROADMAP.md).
