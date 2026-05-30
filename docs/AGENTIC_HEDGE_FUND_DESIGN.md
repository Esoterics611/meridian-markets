# Agentic Hedge Fund — a minimal working design

Status: **proposed** (2026-05-31). Deliberately lean — "something working," not a
framework. Companion: [UI_REWRITE_SPEC.md](./UI_REWRITE_SPEC.md),
[QUANT_TERMINAL_SPEC.md](./QUANT_TERMINAL_SPEC.md).

## 0. The shape of the thing

One human supervisor (you) watches one screen (the Fund Overview UI). Behind it,
several **trading stations** run concurrently — each a strategy on an asset-class
book, each *owned* by an agent (a Claude session) that fits it, trades it, and
**commits its work like any quant**. The agents don't get their own apps or
services; they share **one engine, one DB, one repo** (the modular monolith,
CLAUDE.md §6) and are separated by **books** (already isolated by the portfolio
trader) and **git branches**.

The whole design is three cheap pieces: a **role brief**, a **roster manifest**,
and **git + the existing control plane** as the coordination substrate. No new
orchestration framework.

## 1. Roles (all the same kind of agent, differentiated by a brief + scope)

### Quant / Strategy Owner — the core agent
Owns **one strategy on one book** (e.g. "OU on the L1 basket"). Lifecycle, which is
the single agent the user described (fix → make it work → with risk → trading):

1. **Fix / improve** the strategy in code (`src/stat-arb/strategies/*`, tuning,
   signal) until it backtests well: `mq sweep`, `mq backtest`.
2. **Validate** against the promotion gate (§3). Risk *is* part of this agent until
   the gate passes — not a separate person yet.
3. **Arm** its book in paper (`mq arm` / `mq book add`) and **babysit** it.
4. **Commit** its work on branch `quant/<station-id>`, open a PR. "Committing like a
   quant" = literally this.

### Risk Officer — a gate, optionally a second agent
v1: the **promotion gate is a checklist + `mq validate`** the quant must pass before
arming. v2: a separate reviewer agent that can **veto an arm, trip the kill switch,
or flatten** a book breaching limits. The user's "then it's another agent which
includes risk" = promote this gate to its own session once the desk is busy.

### Ops / Monitor — the "values are stale" watcher
A recurring agent (a `/loop` or cron running `mq watch --check`) that flags: stale
feed (last-bar age over threshold), a stuck loop, a drawdown breach, paper-vs-real
divergence. It **writes alerts** the human sees on the Fund Overview — it does not
trade. This is the cheapest, highest-value second agent.

### Supervisor — you
Don't run a dashboard per agent. All stations write to the shared engine state; you
watch the **aggregate** (Fund Overview + Books + Risk). One throat to choke.

## 2. Coordination substrate (the "something working")

- **One repo / one engine / one DB.** Agents get **books**, not services. The
  `LivePortfolioTrader` already runs N isolated books on one control plane — that is
  the multi-agent execution layer; agents just own different books in it.
- **Git as the coordination ledger.** Each station = branch `quant/<station-id>`;
  the quant commits strategy + tuning there and PRs to `master`; you (or a reviewer
  agent) merge. Branches are disposable, commits are forever (CLAUDE.md §0).
- **A roster manifest** — `desk/roster.yaml`: the list of active stations the
  supervisor UI + tooling read.
  ```yaml
  stations:
    - id: l1-ou
      owner: quant-agent-a          # which session/agent owns it
      assetClass: l1-smart-contract
      pairs: [[SOL, AVAX]]
      strategy: ou-bertram
      capitalUsdc: 33000
      status: paper                 # draft | validated | paper | stopped
    - id: majors-zscore
      owner: quant-agent-b
      assetClass: crypto-majors
      pairs: [[ETH, BTC]]
      strategy: pairs-zscore
      capitalUsdc: 33000
      status: paper
  ```
- **The control plane is shared.** Agents arm/stop their book via `mq` / HTTP; the
  engine persists every closed trade to `stat_arb_trades` under one venue, so the
  human sees all of it in one blotter.

## 3. The promotion gate (`mq validate`)

A station may not go `paper` until it passes — this is where "risk" enters:

- backtest on real history: Sharpe ≥ threshold, max-DD ≤ gate, ≥ N trades,
  positive net of fees;
- walk-forward / out-of-sample not catastrophically worse than in-sample
  (`src/stat-arb/research/walk-forward.ts` exists);
- a risk profile assigned (`conservative|balanced|aggressive`) with a drawdown gate;
- the pair still cointegrates in the recent window (`mq discover` p-value sane).

`mq validate <station>` runs these and prints PASS/FAIL per check. Green → the
quant flips `status: paper` and arms.

## 4. How agents are actually launched (v1, manual, not overbuilt)

- You open a Claude session per station with the **station brief** (`desk/STATION_BRIEF.md`)
  + that station's `roster.yaml` entry as its scope. It works the lifecycle (§1),
  commits on its branch, arms its book.
- The Ops/Monitor agent is a single long-running `/loop` session.
- **No bespoke orchestrator.** The "fitting a strategy, committing, trading,
  monitoring" loop the user described is: *brief → branch → validate → arm → watch →
  PR*. Git + roster + `mq` are the entire glue.
- Later (only if it earns its keep): a launcher script that spawns a session per
  `roster.yaml` entry. Not now.

## 5. What to build first (so it's working, not a title)

1. **Make trades visible + persistent** — the UI/`/trades` endpoint + NAV-venue fix
   (UI spec §6). Without this the supervisor can't supervise. *(Being wired now.)*
2. **`mq arm/stop/book/status/trades`** (terminal spec P0) — the agent + human
   action interface.
3. **`desk/STATION_BRIEF.md` + `desk/roster.yaml`** — the role brief + manifest.
4. **`mq validate`** — the promotion gate.
5. Run **2–3 stations** across different asset classes (start them as separate
   sessions, each owning one book) → they accumulate paper PnL into the shared DB →
   you watch the Fund Overview. That is the agentic hedge fund, minimally real.

## 6. Non-goals
- No per-agent microservices / DBs (CLAUDE.md §6 is binding).
- No real money: every station is `EXECUTION_MODE=paper`. Going live is the separate
  `LIVE_TRADING_ARMED` engineering decision, taken by the human, outside this design.
- No grand framework. If a piece isn't earning paper PnL or helping you supervise,
  it doesn't get built.
</content>
