# Quant Terminal Spec — the `mq` workstation

Status: **proposed** (2026-05-31). Owner: next tooling session.
Companion: [UI_REWRITE_SPEC.md](./UI_REWRITE_SPEC.md),
[AGENTIC_HEDGE_FUND_DESIGN.md](./AGENTIC_HEDGE_FUND_DESIGN.md).

## 0. What a "quant trading app" is here

The engine is already **headless and control-plane-first** — the live controller's
own header says *"Designed to be driven from a terminal (curl / a TUI) — the web
dashboard is just one consumer of GET /snapshot."* So the terminal app is not a new
system; it is a **thin, ergonomic CLI over the HTTP control plane + the existing
`scripts/quant-session.ts` runbook**, plus an optional live TUI monitor.

A real quant's terminal does four things: **research** (find/measure a tradeable
relationship), **backtest** (does the strategy make money on history), **deploy**
(arm it on live data), **monitor** (watch the book + risk). `mq` maps 1:1 to those.

Two deliverables:
- **`mq` CLI** — scriptable, one command per desk action. (P0)
- **`mq watch` TUI** — a full-screen live monitor for headless operation. (P1)

## 1. `mq` CLI

A `bin/mq.ts` run via ts-node (same toolchain as `scripts/`), or a small
commander-based binary. Talks to `http://localhost:3100` by default
(`MQ_HOST` overrides). Every command takes `--json` for machine output (so an
agent can parse it) and prints a human table otherwise.

### Research
```
mq presets                         # asset-class market sets  (GET /presets)
mq strategies                      # the catalogue            (GET /live/strategies)
mq backfill <preset> --hours 72    # pull real Binance history (POST /backfill-preset)
mq discover <preset> --hours 72    # cointegrated pairs table  (GET /universe)
```

### Backtest
```
mq backtest <A> <B> --strategy ou-bertram --hours 72   # one strategy (POST /backtest)
mq sweep <A> <B> --hours 72                            # ALL strategies, ranked
```
`sweep` is the quant-session step 4/5 packaged: run every catalogue strategy on the
pair, print a ranked table (trades / pnl / sharpe / winrate), name the winner.

### Deploy (live paper)
```
mq arm <A> <B> --strategy ou-bertram --capital 100000  # POST /live/configure + /start
mq stop                                                # POST /live/stop
mq tick                                                # POST /live/tick (single-step)
mq flatten                                             # close open position (new endpoint)
```
Multi-currency book:
```
mq book add <A> <B> [<A2> <B2> …] --strategy … --capital …   # POST /live/portfolio
mq book start | stop
```

### Monitor
```
mq status            # single-book snapshot   (GET /live/snapshot)
mq book              # portfolio snapshot      (GET /live/portfolio)
mq trades            # persisted blotter       (GET /trades — new endpoint)
mq fund              # fund aggregate          (GET /fund — new endpoint)
mq watch             # live TUI (see §2)
```

### Full runbook
```
mq session --preset crypto-majors --hours 24
```
Wraps `scripts/quant-session.ts`: catalogue → backfill → discover → backtest-all →
drive each strategy through the real `LivePaperTrader` over replayed real bars →
report round-trips → arm the winner. This is the **proof the loop enters trades**.

## 2. `mq watch` TUI (P1)

A full-screen terminal monitor (Ink/blessed, or plain ANSI repaint on the 4s poll)
that mirrors the Fund Overview for headless operation — "what a quant app looks
like" in a terminal:

```
 MERIDIAN DESK · paper · feed binance.spot.1m            equity 100,420  ▲+0.42%
 ───────────────────────────────────────────────────────────────────────────────
 BOOK            STR          z      reg     pos    equity     real    unreal  age
 ETH/BTC         pairs-zscore  2.13  CALM   SHORT  33,610    +120     −38     11s
 SOL/AVAX        ou-bertram   −0.40  CALM   FLAT   33,400      +0      +0       9s
 LTC/BCH         pairs-ewma    1.02  HIVOL  LONG   33,410     +30     +18     12s
 ───────────────────────────────────────────────────────────────────────────────
 ALERTS  · none      RISK · dd 0.4% / 10% gate   blocked 0   stale 0
 [a]rm  [s]top  [f]latten  [k]ill  [q]uit
```

Polls `GET /api/stat-arb/books` + `/fund` + `/alerts`. Read-only first; the
hotkeys (arm/stop/flatten/kill) are P2 and call the same endpoints as the CLI.

## 3. Prerequisites & run notes (put in `--help`)

- **Postgres on :5433 + migrations** (research/backtest read `market_bars`; deploy
  persists `stat_arb_trades`). `echo 5784 | sudo -S docker compose up -d postgres`.
- **Server in paper mode** must be running for live/deploy/monitor commands:
  ```
  FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
    LIVE_AUTOSTART=false npm run start:dev
  ```
- `backfill` / `discover` / `backtest` / `sweep` / `session` work against stored
  bars and the Binance public REST — no key, no account, all paper.
- `mq session` can also run **without** the server (it boots its own Nest context),
  exactly like `scripts/quant-session.ts` does today.

## 4. Implementation notes

- Single file `bin/mq.ts`; a `request(path, method, body)` helper; one function per
  command; commander or a tiny hand-rolled arg parser. ~300 lines.
- Tables via a 3-line column formatter (no heavy dep); `--json` short-circuits to
  `JSON.stringify`.
- Add an npm script: `"mq": "ts-node -r tsconfig-paths/register bin/mq.ts"` →
  `npm run mq -- discover crypto-majors --hours 72`. Optionally a shell shim so it's
  just `mq …`.
- The CLI is the **agent-facing interface** too: a quant agent (see agentic spec)
  drives the desk with `mq … --json` instead of curl, which keeps its actions
  auditable and identical to what a human types.

## 5. Phasing
- **P0:** `mq` with presets/strategies/backfill/discover/backtest/sweep/arm/stop/
  status/book/session + `--json`. Pure wrapper over today's endpoints + the new
  `/trades`.
- **P1:** `mq watch` read-only TUI; `mq fund`/`mq trades` once those endpoints land.
- **P2:** TUI hotkeys (arm/stop/flatten/kill); `mq validate` (the promote gate).
</content>
