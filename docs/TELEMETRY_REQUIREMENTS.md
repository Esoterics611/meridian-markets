# Backend Telemetry — Requirements

> **Status:** requirements (not yet implemented). **Owner:** platform. **Why now:** Meridian is no longer a demo — it is a **persistent paper-trading research system** meant to run unattended for hours and days, and the precursor to an agent-run quant group. A system you cannot *observe* is a system you cannot trust to run unattended, and "honesty about the numbers" extends to operational honesty: we must be able to prove the desk is healthy, the feeds are live, the P&L is real, and a restart lost nothing. This document specifies what the backend must emit and expose.

## 1. Goals & non-goals

**Goals**
- Know, at any instant and after the fact, whether the system is **operationally healthy** (process, loops, feeds, DB) and **financially healthy** (equity, drawdown, fills, risk verdicts).
- Detect failure **before** it corrupts a multi-hour run: stale feed, WS disconnect, risk-gate kill, persistence failure, drawdown breach.
- Provide a durable, queryable **track record** (NAV / equity curve over days) — the research output itself.
- Be **low-overhead, headless, and swappable** — telemetry is a swap seam (CLAUDE.md §7), off by default, no behaviour change when disabled.

**Non-goals**
- No user analytics / PII (paper system, no users).
- No bespoke dashboard UI in-repo (export to Grafana/standard tooling instead).
- Not a replacement for the P&L ledger ([PNL_ACCOUNTING.md](PNL_ACCOUNTING.md)) — telemetry *reads* the ledger; the ledger remains the source of truth.

## 2. The four pillars

| Pillar | Requirement | Standard |
|---|---|---|
| **Metrics** | numeric time series for every signal in §4 | Prometheus exposition at `GET /metrics`; OTLP export optional |
| **Logs** | structured (JSON) records with context (book, source, trace id) | one line/event, leveled; pluggable sink |
| **Traces** | spans across an operation (tick → quote → fill → persist; feed fetch; DB txn) | OpenTelemetry; OTLP export optional |
| **Health** | liveness + readiness endpoints | `GET /health` (liveness), `GET /health/ready` (deps) |

## 3. Functional requirements

- **FR-1 — Metrics endpoint.** Expose `GET /metrics` in Prometheus text format. Counters, gauges, and histograms per §4. Label by `book`/`symbol`, `source`/`venue`, `strategy`, `asset_class` where applicable.
- **FR-2 — Operational metrics.** Process + runtime + HTTP + DB + loop health (§4.1). The tick loop must emit its **cadence** and **per-tick duration**; a tick that overruns the poll interval is a first-class signal.
- **FR-3 — Feed/data-quality metrics.** Per feed/source: poll success/failure counts, latency, **last-bar age (staleness)**, gap detection, WS connection state (HL trades), reference-source errors.
- **FR-4 — Desk/financial metrics.** Per book and desk-aggregate, sourced from the existing `snapshot()`: equity, net/realised/unrealised P&L, fees, **funding**, inventory, **max drawdown**, fills (bid/ask), queue-vs-touch (where available), blocked quotes, **risk-gate verdict** (Allow/Deny/Pause counts), NAV.
- **FR-5 — Persistence metrics.** Checkpoint count, latency, **failure count**; rehydration count on boot; store enabled/disabled. A persistence failure must be loud (it threatens restart-safety).
- **FR-6 — Structured logs.** JSON logs with `level`, `ts`, `context` (component), and structured fields (book, source, verdict, error). Replace bare-string `Logger` usage at the boundaries that matter (tick errors, feed errors, risk kills, persistence failures, lifecycle).
- **FR-7 — Traces.** Spans for: one portfolio tick (child spans per book: quote, fill-apply, persist), feed fetches, DB transactions, HTTP requests. Propagate a trace/correlation id through a tick so a fill can be traced to its bar.
- **FR-8 — Health/readiness.** `GET /health` returns liveness (process up, event loop responsive). `GET /health/ready` returns readiness: DB reachable (when `MM_PERSIST`), at least one feed reachable, last tick within N×poll-interval. Non-200 when not ready, for orchestrators.
- **FR-9 — NAV / equity-curve history.** Durable per-interval desk NAV + per-book equity snapshots to Postgres (extends the existing `stat_arb_nav` pattern to MM), queryable for the multi-day track record. This is the research deliverable, not just an ops metric.
- **FR-10 — Alerting hooks.** Emit a structured **alert event** (and a metric) on: drawdown breach (> `MM_MAX_DRAWDOWN_PCT`), stale feed (> threshold), risk-gate `Deny`/`Pause`/kill, persistence failure, WS disconnect, tick overrun. Delivery is pluggable (log/metric now; webhook/Slack later) — the requirement is that the *event exists and is uniform*.

## 4. Metric catalog (initial)

### 4.1 Operational
- `meridian_process_uptime_seconds` (gauge)
- `meridian_event_loop_lag_seconds` (gauge/histogram)
- `meridian_nodejs_*` (rss, heap, gc) — standard runtime metrics
- `meridian_http_requests_total{route,method,status}` (counter), `meridian_http_request_duration_seconds{route}` (histogram)
- `meridian_db_query_duration_seconds{op}` (histogram), `meridian_db_errors_total` (counter)
- `meridian_tick_total{loop}` (counter), `meridian_tick_duration_seconds{loop}` (histogram), `meridian_tick_overrun_total{loop}` (counter)

### 4.2 Feed / data quality
- `meridian_feed_polls_total{source,result}` (counter), `meridian_feed_poll_duration_seconds{source}` (histogram)
- `meridian_feed_last_bar_age_seconds{source,symbol}` (gauge) — the staleness signal
- `meridian_feed_gaps_total{source,symbol}` (counter)
- `meridian_ws_connected{source}` (gauge 0/1), `meridian_ws_reconnects_total{source}` (counter)

### 4.3 Desk / financial (from `snapshot()`)
- `meridian_book_equity_units{book,source,strategy}` (gauge)
- `meridian_book_net_pnl_units{book}` / `_realised_` / `_unrealised_` / `_fees_` / `_funding_` (gauges)
- `meridian_book_inventory_units{book}` (gauge), `meridian_book_max_drawdown_pct{book}` (gauge)
- `meridian_book_fills_total{book,side}` (counter), `meridian_book_blocked_quotes_total{book}` (counter)
- `meridian_book_risk_verdict_total{book,verdict}` (counter)
- `meridian_desk_equity_units` / `meridian_desk_net_pnl_units` / `meridian_desk_funding_units` (gauges)
- `meridian_desk_nav_units` (gauge, also persisted per §FR-9)

### 4.4 Persistence
- `meridian_persist_checkpoints_total{result}` (counter), `meridian_persist_duration_seconds` (histogram)
- `meridian_persist_rehydrated_books` (gauge, set on boot)

## 5. Design constraints (how, not just what)

- **DC-1 — A swap seam.** Define an `ITelemetry` (or `IMetrics` + structured logger + tracer) interface with a **no-op default** and a Prometheus/OpenTelemetry implementation, selected by config (`TELEMETRY_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`). With telemetry off, zero behaviour change and near-zero overhead — same discipline as every other integration (CLAUDE.md §7). Tests run with the no-op.
- **DC-2 — `process.env` only in the config factory.** Telemetry config is read in `app-config.factory.ts` (CLAUDE.md §6), injected everywhere else.
- **DC-3 — Read the ledger, don't duplicate it.** Financial metrics are derived from the existing `snapshot()` / `InventoryBook`, never a parallel accounting path. One source of truth.
- **DC-4 — Bounded cardinality.** Labels are `book`/`source`/`strategy`/`verdict` — bounded sets. No unbounded labels (no per-order, no timestamps-as-labels).
- **DC-5 — Low overhead, non-blocking.** Metric updates are O(1) in-memory; export is pull (`/metrics`) or batched OTLP. Telemetry never blocks or fails a tick — an emit error is swallowed and counted.
- **DC-6 — Headless + restart-safe.** Works with no UI. Counters reset on restart (acceptable); durable state (NAV, equity history) lives in Postgres and survives, consistent with restart-safe books.

## 6. Non-functional requirements

- **NFR-1** — `/metrics` scrape responds in < 50 ms under normal load.
- **NFR-2** — Telemetry overhead < 2% of tick CPU budget when enabled.
- **NFR-3** — No secrets or keys in logs/metrics/traces.
- **NFR-4** — All existing tests pass with telemetry off (default); the telemetry layer ships with its own unit tests (no-op + Prometheus formatting + a metric-from-snapshot mapping spec).

## 7. Suggested implementation phases

1. **P1 — Metrics + health.** `ITelemetry` seam + Prometheus registry, `/metrics`, `/health` + `/health/ready`, operational + feed + desk metrics (§4.1/4.2/4.3) mapped from `snapshot()` and the tick loop. Config-gated.
2. **P2 — Structured logs.** Swap the boundary `Logger` calls for a structured (JSON) logger with context; keep the NestJS Logger interface so call sites barely change.
3. **P3 — Durable NAV / equity-curve history.** `mm_nav` (or shared) table + a cron writing desk NAV + per-book equity per interval; query endpoint for the track record (ties into the persistence work).
4. **P4 — Traces + alerting.** OpenTelemetry spans (tick/feed/DB/HTTP) with OTLP export; uniform alert events + a pluggable delivery sink.

## 8. Acceptance criteria

- `GET /metrics` exposes every §4 metric with correct types/labels; a Prometheus scrape + a starter Grafana dashboard show desk equity, drawdown, fills, feed staleness, and tick health.
- `GET /health/ready` flips to non-200 when the DB is down (under `MM_PERSIST`) or the feed has been stale beyond threshold.
- A killed feed, a risk-gate `Pause`, and a forced persistence error each produce a structured log **and** a metric/alert event.
- Desk NAV is queryable over a multi-day run and matches the ledger's equity to the unit.
- With `TELEMETRY_ENABLED=false`, the full suite passes and there is no measurable overhead.

---

See also: [ROADMAP.md](ROADMAP.md) (where this sits), [PNL_ACCOUNTING.md](PNL_ACCOUNTING.md) (the financial source of truth telemetry reads), [HEADLESS_OPERATIONS.md](HEADLESS_OPERATIONS.md) (the unattended-run posture this supports).
