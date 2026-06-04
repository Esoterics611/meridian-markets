// The single source of truth for every metric the desk emits. Names, types, help
// text, and (for histograms) bucket boundaries live here ONCE so the Prometheus
// registry and every instrumentation call-site agree. The catalog is registered
// up-front (PrometheusTelemetry), so `GET /metrics` always advertises the full set
// of HELP/TYPE lines even before a metric is first observed — the operator sees
// what the system *can* report, not just what it happened to touch.
//
// All metric names are prefixed `meridian_`. Money/size values are 6-decimal
// integer units (USDC-units / asset-units) exposed as gauge floats; values stay
// well within 2^53 for any realistic desk size (≈$9B notional), so the integer is
// exact (the one place a float touches a cash number — read-only, never an account).

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricDef {
  name: string;
  type: MetricType;
  help: string;
  /** Histogram bucket upper-bounds (seconds), ascending; '+Inf' is implicit. */
  buckets?: number[];
}

/** General latency buckets (seconds) for tick / poll / persist / http / db. */
export const DURATION_BUCKETS: readonly number[] = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

// ── Metric names (import these at call-sites so a typo is a compile error) ──────
export const M = {
  // Operational (§4.1)
  uptime: 'meridian_process_uptime_seconds',
  eventLoopLag: 'meridian_event_loop_lag_seconds',
  residentMemory: 'meridian_process_resident_memory_bytes',
  heapUsed: 'meridian_nodejs_heap_used_bytes',
  heapTotal: 'meridian_nodejs_heap_total_bytes',
  httpRequests: 'meridian_http_requests_total',
  httpDuration: 'meridian_http_request_duration_seconds',
  dbDuration: 'meridian_db_query_duration_seconds',
  dbErrors: 'meridian_db_errors_total',
  tick: 'meridian_tick_total',
  tickDuration: 'meridian_tick_duration_seconds',
  tickOverrun: 'meridian_tick_overrun_total',

  // Feed / data quality (§4.2)
  feedPolls: 'meridian_feed_polls_total',
  feedPollDuration: 'meridian_feed_poll_duration_seconds',
  feedLastBarAge: 'meridian_feed_last_bar_age_seconds',

  // Desk / financial (§4.3) — pull-derived gauges, mapped from snapshot()
  bookEquity: 'meridian_book_equity_units',
  bookNetPnl: 'meridian_book_net_pnl_units',
  bookRealisedPnl: 'meridian_book_realised_pnl_units',
  bookUnrealisedPnl: 'meridian_book_unrealised_pnl_units',
  bookFees: 'meridian_book_fees_units',
  bookFunding: 'meridian_book_funding_units',
  bookInventory: 'meridian_book_inventory_units',
  bookMaxDrawdownPct: 'meridian_book_max_drawdown_pct',
  bookFills: 'meridian_book_fills',
  bookBlockedQuotes: 'meridian_book_blocked_quotes',
  bookRiskVerdict: 'meridian_book_risk_verdict',
  deskEquity: 'meridian_desk_equity_units',
  deskNetPnl: 'meridian_desk_net_pnl_units',
  deskRealisedPnl: 'meridian_desk_realised_pnl_units',
  deskUnrealisedPnl: 'meridian_desk_unrealised_pnl_units',
  deskFees: 'meridian_desk_fees_units',
  deskFunding: 'meridian_desk_funding_units',
  deskCapital: 'meridian_desk_capital_units',
  deskNav: 'meridian_desk_nav_units',
  deskBookCount: 'meridian_desk_book_count',
  deskRunning: 'meridian_desk_running',

  // Persistence (§4.4)
  persistCheckpoints: 'meridian_persist_checkpoints_total',
  persistDuration: 'meridian_persist_duration_seconds',
  persistRehydratedBooks: 'meridian_persist_rehydrated_books',

  // Alerting (FR-10) + telemetry self-observability (DC-5)
  alerts: 'meridian_alerts_total',
  telemetryErrors: 'meridian_telemetry_errors_total',
} as const;

export const METRIC_CATALOG: readonly MetricDef[] = [
  // Operational
  { name: M.uptime, type: 'gauge', help: 'Process uptime in seconds.' },
  { name: M.eventLoopLag, type: 'gauge', help: 'Event-loop lag (scheduling delay) in seconds.' },
  { name: M.residentMemory, type: 'gauge', help: 'Resident set size in bytes.' },
  { name: M.heapUsed, type: 'gauge', help: 'V8 heap used in bytes.' },
  { name: M.heapTotal, type: 'gauge', help: 'V8 heap total in bytes.' },
  { name: M.httpRequests, type: 'counter', help: 'HTTP requests handled, by route/method/status.' },
  { name: M.httpDuration, type: 'histogram', help: 'HTTP request duration in seconds.', buckets: [...DURATION_BUCKETS] },
  { name: M.dbDuration, type: 'histogram', help: 'Database operation duration in seconds.', buckets: [...DURATION_BUCKETS] },
  { name: M.dbErrors, type: 'counter', help: 'Database operation errors.' },
  { name: M.tick, type: 'counter', help: 'Portfolio tick iterations, by loop.' },
  { name: M.tickDuration, type: 'histogram', help: 'Portfolio tick duration in seconds, by loop.', buckets: [...DURATION_BUCKETS] },
  { name: M.tickOverrun, type: 'counter', help: 'Ticks whose duration exceeded the poll interval, by loop.' },

  // Feed / data quality
  { name: M.feedPolls, type: 'counter', help: 'Feed polls, by source and result (ok|error).' },
  { name: M.feedPollDuration, type: 'histogram', help: 'Feed poll duration in seconds, by source.', buckets: [...DURATION_BUCKETS] },
  { name: M.feedLastBarAge, type: 'gauge', help: 'Age of the most recent bar in seconds, by source/symbol (the staleness signal).' },

  // Desk / financial (from snapshot())
  { name: M.bookEquity, type: 'gauge', help: 'Per-book equity in USDC-units (capital + P&L + funding).' },
  { name: M.bookNetPnl, type: 'gauge', help: 'Per-book net P&L in USDC-units.' },
  { name: M.bookRealisedPnl, type: 'gauge', help: 'Per-book realised P&L in USDC-units.' },
  { name: M.bookUnrealisedPnl, type: 'gauge', help: 'Per-book unrealised P&L in USDC-units.' },
  { name: M.bookFees, type: 'gauge', help: 'Per-book fees in USDC-units (signed; negative = rebate earned).' },
  { name: M.bookFunding, type: 'gauge', help: 'Per-book funding in USDC-units (+ received / − paid).' },
  { name: M.bookInventory, type: 'gauge', help: 'Per-book signed inventory in asset-units.' },
  { name: M.bookMaxDrawdownPct, type: 'gauge', help: 'Per-book max drawdown in percent.' },
  { name: M.bookFills, type: 'gauge', help: 'Per-book cumulative fills, by side (pull-derived gauge).' },
  { name: M.bookBlockedQuotes, type: 'gauge', help: 'Per-book cumulative quotes blocked by the risk gate (pull-derived gauge).' },
  { name: M.bookRiskVerdict, type: 'gauge', help: 'Per-book current risk-gate verdict, 1 for the active verdict (state gauge).' },
  { name: M.deskEquity, type: 'gauge', help: 'Desk-aggregate equity in USDC-units.' },
  { name: M.deskNetPnl, type: 'gauge', help: 'Desk-aggregate net P&L in USDC-units.' },
  { name: M.deskRealisedPnl, type: 'gauge', help: 'Desk-aggregate realised P&L in USDC-units.' },
  { name: M.deskUnrealisedPnl, type: 'gauge', help: 'Desk-aggregate unrealised P&L in USDC-units.' },
  { name: M.deskFees, type: 'gauge', help: 'Desk-aggregate fees in USDC-units.' },
  { name: M.deskFunding, type: 'gauge', help: 'Desk-aggregate funding in USDC-units.' },
  { name: M.deskCapital, type: 'gauge', help: 'Desk-aggregate capital anchor in USDC-units.' },
  { name: M.deskNav, type: 'gauge', help: 'Desk net asset value in USDC-units (= desk equity).' },
  { name: M.deskBookCount, type: 'gauge', help: 'Number of live MM books.' },
  { name: M.deskRunning, type: 'gauge', help: 'Desk loop running (1) or stopped (0).' },

  // Persistence
  { name: M.persistCheckpoints, type: 'counter', help: 'Persistence checkpoints, by result (ok|error).' },
  { name: M.persistDuration, type: 'histogram', help: 'Persistence checkpoint duration in seconds.', buckets: [...DURATION_BUCKETS] },
  { name: M.persistRehydratedBooks, type: 'gauge', help: 'Number of MM books rehydrated from persistence on boot.' },

  // Alerting + self-observability
  { name: M.alerts, type: 'counter', help: 'Alert events emitted, by kind and severity.' },
  { name: M.telemetryErrors, type: 'counter', help: 'Telemetry emit errors that were swallowed (never fail a tick).' },
];
