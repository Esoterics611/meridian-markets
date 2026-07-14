# Meridian Technology Overview — from a script fleet to a shared trading plant

> 2026-07-14, written at the principal's direction. Status: **engineering plan, awaiting
> prioritization** — nothing here is built yet, and adopting it is a sequencing decision
> against the running tracks (carry 30d, the Phase-0 maker tape).
>
> The ask: our quant tools — market data, fair-value models, statistical gates, risk — should
> run as **real-time services shared by multiple trading desks**, the way quant shops run
> their infrastructure, instead of being re-embedded in every one-off script. And the UI is
> not the system: at real shops the dashboards are thin windows onto the pipes; the product
> is the pipes.

## 1. Where we are today (honest inventory)

Two runtimes coexist:

- **The NestJS monolith** (`npm run start:dev`): the stat-arb live loop, the MM desk
  (`MmPortfolioTrader` + books), the control plane (`/api/*`), telemetry (`/metrics`), the
  `/demo` console, `mm_nav` persistence, the DeskEvent tape. One process, wired by modules.
- **The script fleet** (~50 under `scripts/`): every newer desk is a *standalone foreground
  ts-node process* — `carry-desk-live.ts`, `vrp-live.ts`, `outcome-rv-live.ts`,
  `orv-calibration.ts`, `regime-book-live.ts` — plus the research CLIs (OOS gates,
  sweeps, replays, scanners) and the `launch-*.sh` supervisors (nohup + pidfile).

What's *right* about today: the §7 seam discipline (every venue behind an interface with a
mock), pure strategy/stat modules with specs, journal-first evidence culture, and the
DeskEvent tape. What's *wrong* — and what this plan fixes:

1. **Every live script embeds its own plant.** `vrp-live` and `orv-calibration` each build
   their own Deribit smile cache; `carry-desk-live` and the MM loop each poll HL; every
   script owns its own journal writer, summary loop, and error/backoff logic. N processes ×
   M venues of duplicated connectivity, and the venue **rate-limit budget is owned by
   nobody** (three scripts polling HL overnight in #96 shared one IP's limits by luck).
2. **Risk is per-book, not per-desk.** Each script enforces its own caps; **no process can
   see aggregate exposure** across MM + carry + VRP + binaries, so a desk-level drawdown
   stop, beta budget, or kill switch has no place to live. This is the biggest gap — risk
   management is the desk's stated foundation, and today it has no spine.
3. **Fair values are computed N times.** The Deribit RND, microprice, realized-vol
   estimators — recomputed per script, with per-script staleness bugs (#96's RV-window
   artifact was exactly a per-script estimator that a shared, spec'd service would have
   caught once, for everyone).
4. **P&L accounting is per-script.** Each live script keeps its own paper book; there is no
   single fills ledger or desk-wide NAV except `mm_nav` (MM + carry only).

## 2. How quant shops actually run infra (the reference shape)

The canonical trading-plant architecture — kdb+ tickerplant shops, LMAX/Aeron event-sourced
engines, prop shops and market makers converge on the same shape:

| Shop component | What it does | Meridian equivalent (target) |
|---|---|---|
| **Feed handlers → tickerplant** | One process per venue normalizes ticks onto a sequenced, logged bus; *the log is the source of truth*, everything downstream is replayable | `md-plant` service + tape capture |
| **Analytics/pricing plant** | Vol surfaces, fair values computed **once**, published as derived streams | `pricing` service |
| **Pre-trade risk gateway** | Every order passes one chokepoint (the 15c3-5 pattern); limits + kill switch live *outside* strategy code | `risk` service |
| **OMS / execution gateways** | One order API per venue; strategies never speak to venues | `oms-paper` service |
| **Strategy engines** | Small processes: subscribe to data, ask risk, send orders, emit events. A desk = a process, not a codebase | desk engines |
| **Journals / event store** | Append-only; state is reconstructed by replay; research reads the *same* files prod wrote | DeskEvent tape, generalized |
| **Research cluster** | Same schemas as prod (research–production parity); backtests replay prod tapes | the replay/stat CLIs |
| **Monitoring** | Grafana/terminals/blotters — *views on streams*, never in the trade path | `/demo`, `/metrics`, `/exec` |

Two properties matter more than any technology choice:

- **The hot path is pipes, not request/response.** Strategies don't call REST APIs per tick;
  they consume sequenced streams and fail closed when the stream goes quiet. UIs subscribe
  to the same streams read-only.
- **Everything replays.** The bus is captured to append-only logs; a backtest, a post-mortem,
  and the live desk read the same schema. (Our `orv-calibration` tape → `orv-maker-replay`
  pair is already exactly this pattern — this plan makes it the norm.)

## 3. Target architecture

```
                        ┌────────────────────────────── one repo, one build, one DB ─┐
  venues                │                                                            │
  HL / Binance /        │  ┌───────────┐   md.* streams    ┌────────────┐            │
  Deribit / Gecko  ───▶ │  │ md-plant  │ ─────────────────▶│  pricing   │            │
  / Alpaca              │  │ (feeds,   │                   │ (RND, μ-px,│            │
                        │  │  budget,  │──┐                │  EWMA RV,  │            │
                        │  │  tapes)   │  │                │  smiles)   │            │
                        │  └───────────┘  │                └─────┬──────┘            │
                        │                 │ md.*                 │ px.*              │
                        │                 ▼                      ▼                   │
                        │        ┌─────────────────────────────────────┐  risk.*     │
                        │        │            desk engines             │◀──────────┐ │
                        │        │  desk-mm · desk-carry · desk-vrp ·  │           │ │
                        │        │  desk-binaries (one process each)   │  pos.*    │ │
                        │        └───────┬─────────────────────────────┘─────────▶ │ │
                        │                │ orders (req/reply)          ┌───────────┴┐│
                        │                ▼                             │    risk    ││
                        │        ┌────────────┐  fills.* / nav.*       │ (limits,   ││
                        │        │  oms-paper │ ─────────────────────▶ │ agg expo,  ││
                        │        │ (fill sims,│                        │ kill,      ││
                        │        │  ledger)   │                        │ hedge tgt) ││
                        │        └────────────┘                        └────────────┘│
                        │                │                                           │
                        │   all topics   ▼                                           │
                        │        ┌────────────┐      ┌─────────────────────────────┐ │
                        │        │  journal   │ ───▶ │ views: /demo /exec /metrics │ │
                        │        │ (JSONL tape│      │ (read-only bus/journal      │ │
                        │        │  + mm_nav) │      │  consumers — NOT the system)│ │
                        │        └────────────┘      └─────────────────────────────┘ │
                        └────────────────────────────────────────────────────────────┘
   offline, same schemas:  research CLIs (OOS/survivorship/deflated-Sharpe/purged-kfold,
                           maker replay, Brier calibration, TCA) replay the tapes — libraries
                           and scheduled jobs, deliberately NOT daemons.
```

### 3.1 Service catalog

**`md-plant` — the market-data service.** Owns ALL venue connectivity: HL (WS trades/funding
+ REST books/meta), Binance public, Deribit chains, GeckoTerminal, Alpaca. Publishes
normalized, sequenced streams — `md.book.<venue>.<sym>`, `md.trades.*`, `md.funding.*`,
`md.candles.*`, `md.chain.deribit.<ccy>` — and stamps every message with venue-ts + plant-ts
(the `hlDataAgeMs` staleness discipline, everywhere). Owns the per-venue **rate budget** and
backoff in exactly one place, plus the #92/#93 symbol-collision guard at ingestion. Captures
every topic to daily-rotating JSONL tapes (the `orv-calibration` collector generalized — that
script becomes a *subscriber*, or retires).

**`pricing` — the shared fair-value service.** Stateless transforms of md streams into
`px.*` streams: smile-interpolated RND digitals (`implied-digital.ts` — computed once for
every listed binary, not once per script), microprice/cross-venue fair value (#27–#33), EWMA
realized vol (shipping the #96 fix as *the* desk-wide estimator, spec'd once), funding-rate
forecasts. Every desk quotes off the same marks; a pricing bug is fixed in one process.

**`risk` — the spine (the piece we most lack).** Consumes `pos.*` heartbeats every desk must
publish (positions, collateral, realized/unrealized) and `fills.*` from the OMS; maintains
the **aggregate exposure book** across all desks; publishes `risk.verdict.<desk>`
(Allow/Deny/Pause — `CompositeRiskGate` generalized), desk-level drawdown stops, collateral
budgets, the aggregate beta-hedge target (`RegimeBetaHedge` as a service, fed by
`BookBeta[]` from all desks, not just carry), and the **kill switch**. Order flow is checked
against it pre-trade (below). **Fail-closed protocol:** a desk that loses the risk heartbeat
stops *opening* within one timeout (closing/reducing stays allowed); a desk that loses md
goes quote-off. Risk being a separate process means a strategy crash cannot take risk down —
and vice versa.

**`oms-paper` — the execution service.** One order API (place/cancel/replace, request-reply)
in front of the honest fill simulators (fees, impact, borrow, queue-aware where we have
depth). Every fill lands on one `fills.*` stream and one ledger; NAV persistence generalizes
`mm_nav` to every desk (one new migration, same Postgres, same single migration sequence).
Pre-trade, the OMS checks the current `risk.verdict` for the desk — the 15c3-5 chokepoint.
The §7 venue seam lives HERE: `PaperVenue` today; a real venue adapter would slot behind the
same API without touching a single desk (still parked, per the mission).

**Desk engines — one process per desk.** `desk-mm`, `desk-carry`, `desk-vrp`,
`desk-binaries` (when the Phase-0 gate passes). Strategy logic ONLY: subscribe md/px, obey
`risk.*`, send orders to the OMS, emit DeskEvents. No venue I/O, no fee math, no private
ledgers. A new desk = a new small process against existing streams — this is what "shared by
multiple trading desks" buys.

**`journal` — the event store.** Every bus topic is capturable; DeskEvents, fills, verdicts,
and gate decisions are *always* captured (append-only JSONL + the existing ring buffer for
UIs; Postgres rows where durability matters). Replay of the journal reconstructs any
incident — the #96 overnight post-mortem workflow, institutionalized.

**The research plane — deliberately NOT services.** The statistical arsenal (OOS
walk-forward, survivorship gate, deflated Sharpe/PSR, purged k-fold, `maker-sim`,
`calibration-score`, TCA scoring, sweeps) stays **pure libraries + CLIs** reading the same
tape schemas, run by operator or cron. Real shops keep the research cluster off the hot path
for good reason: batch tools as daemons add failure modes and zero edge. What research *does*
get from this plan: one tape store with versioned schemas (`schemaVersion` on every record),
so every tool reads every desk's data — research–production parity by construction.

**Views.** `/demo`, `/exec`, `/research`, `/metrics` remain — re-pointed at journal/bus
consumers. UIs read the system; they are never in the trade path. (The NestJS app keeps the
HTTP control plane: launch/stop books, flip risk toggles — commands that *write to the bus*.)

### 3.2 The transport (and the §6 question, addressed in writing)

**CLAUDE.md §6 is binding: no microservices.** This plan does not re-litigate it — it
*complies*. What §6 forbids (for the stated correctness reasons) is **repo/DB
fragmentation**: polyrepo, database-per-service, split migration sequences, cross-repo
shared types, network contracts between codebases. What this plan proposes is a **modular
monolith with a multi-process runtime**: ONE repo, ONE build, ONE Postgres with ONE ordered
migration history, shared types via imports — and N supervised OS processes started from
this codebase, talking over a local bus. Processes are an *ops* decision (isolation, restart
independence, core pinning); microservices are an *organizational/data* decision. We take
the first and refuse the second. The treasury ledger's SERIALIZABLE invariants keep exactly
one writer service, unchanged (it's dormant anyway, §5).

**Bus seam, house-style:** `IBus` interface (publish/subscribe/request), THREE impls:

- `InProcBus` — an in-process emitter. Default. **The entire "plant" can run inside one
  process** — which is how unit/integration tests run (offline, no broker, no change to
  §10 discipline), and how a laptop dev session runs today.
- `NatsBus` — NATS core (a single small broker binary added to docker-compose next to
  Postgres). Subjects map 1:1 to topics; request-reply for orders and risk checks. Chosen
  over Kafka (ops burden we don't need at one-box scale), Redis (weaker req/reply), and
  ZeroMQ (no broker = N² wiring). JetStream persistence is NOT used — durability stays in
  OUR tape files and Postgres, so replay tooling has one format.
- `MockBus` — scripted, for specs.

Same wiring, one config knob (`BUS=inproc|nats`), so **single-process mode and
multi-process mode are the same code** — the strongest possible guarantee that the split
never forks behavior.

**Message discipline:** every message is `{topic, seq, tsVenue?, tsPlant, schemaVersion,
payload}`; per-topic monotonic seq from a **single writer per topic** (bus law #1); gap or
heartbeat loss ⇒ consumer treats the stream as stale ⇒ safe state (quote-off / stop
opening). Books publish snapshot every N deltas so late joiners sync. Backpressure: md
topics drop-oldest (a stale book is garbage anyway); `fills.*`, `risk.*`, `orders` are
never dropped (and are req/reply or journaled).

### 3.3 Ops model

- **Supervision:** `scripts/deskctl.sh` v0 — start/stop/status/restart per service, pidfiles
  + logs (converges the four `launch-*.sh` into one; systemd units are the obvious v1 on a
  dedicated box). Operator-run, foreground-friendly, per the house no-background-tasks rule.
- **Health:** every service exposes the existing `/health`+`/metrics` pattern on its own
  port; one Prometheus scrape config; the `/exec` view shows the process table.
- **Drills as acceptance tests** (see §4): kill -9 the risk service → desks stop opening
  within a heartbeat; kill md-plant → desks quote-off; kill a desk → restart resumes from
  journal + OMS ledger and *reconciles* (the #47 rehydrate lesson, now a protocol).

## 4. Migration plan (phased; each phase pre-registers its acceptance test and keeps the desk running)

**Phase A — the bus seam + extract the plant.** Build `IBus`/`InProcBus`/`NatsBus`;
`md-plant` takes over HL/Binance/Deribit connectivity + tape capture; desks consume via
adapters implementing the *existing* interfaces (`IL2BookSource`, `IBarFeed`,
`IBinaryMarketSource`, smile source) — **zero strategy-code changes**.
*Acceptance:* `carry-desk-live` + `orv-calibration` run against the plant for a session and
produce journals equivalent to the direct-API baseline; venue API calls collapse to 1× per
feed (measured); tests still run offline on `InProcBus`.

**Phase B — pricing + risk services.** `pricing` publishes RND/microprice/EWMA-RV streams
(ships the #96 VRP estimator fix once, spec'd); `risk` v0 aggregates `pos.*` heartbeats,
enforces desk caps + kill switch, publishes verdicts; desks obey fail-closed.
*Acceptance:* two desks demonstrably consume ONE smile stream (call-count evidence); a
kill-switch flip halts all entries in <1 poll cycle; a risk-process kill -9 drill stops
desk opens within the timeout — all three journaled.

**Phase C — the paper OMS + one ledger.** Order API + fill sims move behind `oms-paper`;
`mm_nav` generalizes to per-desk NAV (one migration); desks route orders through risk-checked
req/reply.
*Acceptance:* replay parity — a recorded session re-run through the OMS reproduces the
in-book accounting to the cent; one `fills.*` tape covers every desk; TCA (the #96 ≤2bps/leg
bar) computes from the central ledger, not per-script logs.

**Phase D — ops + views.** `deskctl`, per-service metrics, runbook; UIs re-pointed at
journal/bus; full-desk restart drill (kill everything, resume, reconcile).
*Acceptance:* the drill, journaled, with zero manual fixes.

Sizing honestly: A ≈ 2–3 sessions, B ≈ 2–3, C ≈ 2–4, D ≈ 1–2 — call it **8–12 sessions of
infra work**, which competes directly with PROFIT_PIVOT_II rule R-B (*no session ships
infra-only while zero books are accruing*). The compatible sequencing: phases ride alongside
the already-running operator tracks (the carry 30d run and the Phase-0 maker tape accrue
regardless), and each phase's acceptance run IS a live desk session, not dead time.

## 5. What we are explicitly NOT building

- **No Kafka, no Kubernetes, no polyrepo, no DB-per-service, no gRPC/proto ceremony** — one
  box, one broker binary, JSON messages, our own tape format. Scale problems we don't have
  don't get solutions.
- **No real-money infrastructure** — the OMS venue seam stays paper; `canary`/`live` remain
  parked engineering switches (mission, §1).
- **No research daemons** — the stat tools stay CLIs/libraries; scheduling is cron/operator.
- **No UI-first work** — views get re-pointed, not rebuilt (UI_REWRITE_PLAN_II continues
  independently as the thin layer it already is).

## 6. Decision needed from the principal

1. **Adopt the target architecture?** (This doc becomes the standing reference; MASTER_PLAN
   gets the pointer.)
2. **Sequencing:** interleave Phase A now (it directly de-risks the three concurrent
   operator runs sharing one IP's rate limits), or hold all phases until the carry 30d run
   and the maker Phase-0/1 chain are further along?
3. **NATS as the broker** (one more docker-compose service next to Postgres) vs staying
   `InProcBus`-only until Phase B forces the issue.

---
*Grounding: repo state at commit `9fe8083` (50-script fleet, module tree per §1);
QUANT_JOURNAL #70 (edge doctrine), #92/#93 (collision guard), #96 (overnight trial: the
per-script estimator artifact, the TCA miss, three scripts on one rate budget), #97 (the
tape→replay pattern this plan generalizes); CLAUDE.md §6 (binding monolith decision,
complied with as written), §7 (swap seams), §10.1 (regression discipline).*
