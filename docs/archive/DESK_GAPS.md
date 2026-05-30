# Desk Gaps — what a working stat-arb operation needs that we don't have yet

Companion to [STAT_ARB_DESK_ROADMAP.md](./STAT_ARB_DESK_ROADMAP.md). The roadmap lists the *engineering sessions* still to ship. **This doc reframes that as the human work** — every role on a real desk, every recurring duty, and whether the corresponding system surface exists today.

The roadmap doc is forward-looking ("what code to write"); this doc is operations-looking ("what someone showing up to work Monday morning would not be able to do yet").

> **Reading guide.** Each section names a role, lists their daily / weekly / monthly duties, and marks each duty:
>
> - **✓ shipped** — code path exists, tested, surfaced in the dashboard or an API.
> - **◐ partial** — primitives exist but the human-facing workflow doesn't.
> - **✗ missing** — neither the code nor the workflow exists.
>
> A "✓ shipped" item in a synthetic demo still has to clear the KYB / Phase 2 / Phase 4 gates before it touches real money — see [PHASED_PLAN.md](../PHASED_PLAN.md).

---

## 1. Trader (intraday / live)

A human watching live positions, deciding whether to keep the strategy armed, when to flatten, when to override the gates. Reads the Trader desk.

| Duty | Cadence | Status | Detail / what's missing |
|---|---|---|---|
| See current pair, regime, z-score | live | ✓ | Trader card on `#trader` |
| See live β / half-life | live | ✓ | Sliding-cointegration refit panel (Session 7) |
| Watch the spread tape | live | ✓ | Last 60-bar sparkline |
| See running P&L for the session | live | ◐ | Closed-trade P&L only; **open-position MTM not computed**. Mock backtest closes everything by EOR. Real trading needs a live mark-to-market loop. |
| Manually flatten a position | live | ✗ | No "kill this position" button. The kill-switch is page-wide and client-side only. Need server endpoint + audit trail. |
| Halt new entries (kill switch) | live | ◐ | UI kill switch is client-side only; doesn't stop the server. **No persistent kill flag.** |
| Override a gate temporarily | live | ✗ | Risk gates either fire or they don't. No "trader-authorised override expires in 5 min" flow. |
| Look back at last N trades with PnL | live | ✓ | Recent Trades table on `#trader` |
| Tag a trade with a note ("news event") | live | ✗ | No annotation surface. |
| Re-arm after a circuit breaker fires | live | ✗ | Hedge has a breaker but no "armed/disarmed" toggle exposed; stat-arb gates don't have one yet. |
| Receive a paging alert when a gate trips | live | ✗ | No alert sinks wired. Roadmap Session 15. |

---

## 2. Risk officer / compliance lead

Read-only audit and enforcement. Doesn't trade; owns the *rules*.

| Duty | Cadence | Status | Detail / what's missing |
|---|---|---|---|
| See every armed circuit breaker | daily | ✓ | Risk view → Circuit Breakers card |
| Read the gate-event log | daily | ✓ | Gate Event Log card |
| Confirm append-only invariants hold | daily | ✓ | `append-only.int-spec.ts` runs in CI; Risk view ledger-proof table mirrors it |
| Configure gate thresholds | weekly | ◐ | Hard-coded in `demo.service.ts`. No admin UI; no signed-config audit trail. |
| Approve a trader override | ad-hoc | ✗ | No override-approval workflow exists. |
| Audit historical trade log | weekly | ◐ | `stat_arb_trades` exists (Session 9); **no compliance UI** reading from it; no signed query export. |
| Best-execution attestation | quarterly | ✗ | Roadmap layer 8. Needs Session 13 (exec) + post-trade analytics. |
| 3(c)(7) eligibility checks per investor | per inflow | ✗ | Phase 4 gate. Not started. |
| Regulatory reporting hooks (Form ADV, Form PF) | per filing | ✗ | Phase 4. |
| Investor disclosures snapshot ("what was on the dashboard at month-end") | monthly | ✗ | No archival of dashboard state. Investor view is live-only. |
| Sanctioned-counterparty screening | per onboarding | ✗ | Phase 4. |
| Material non-public information (MNPI) wall | continuous | ✗ | Phase 4. |

---

## 3. Researcher / quant

Discovers new strategies, validates that running strategies aren't overfit, parameter-tunes, decides when to promote a pair from research → paper → canary → live.

| Duty | Cadence | Status | Detail / what's missing |
|---|---|---|---|
| Walk-forward a strategy on out-of-sample data | per change | ✓ | Session 12 — `/api/stat-arb/research/walk-forward` |
| Parameter-sweep a strategy | per change | ✓ | Session 12 — `/api/stat-arb/research/sweep` |
| Monte Carlo a P&L distribution | per change | ✓ | Session 12 — `/api/stat-arb/research/monte-carlo` |
| Assert no look-ahead bias in callbacks | per change | ✓ | Session 12 — `wrapWithLookAheadGuard` |
| Run the above against **real historical data** | always | ◐ | Replay engine + ingest seam ship (Session 11) but **no ingest job populates `market_bars` from a real source**. Right now research runs on the synthetic feed. |
| Pair discovery across a universe | weekly | ✗ | Roadmap Session 16. |
| Cluster pairs by correlation to avoid duplicates | weekly | ✗ | Roadmap Session 16. |
| Detect signal decay on a live pair | weekly | ✗ | Roadmap Session 16. |
| Notebook / iterative exploration workflow | ad-hoc | ✗ | No Jupyter-style fixtures. Roadmap layer 7. |
| Backtest against multi-venue order book depth | per change | ✗ | Roadmap Session 13 — needs depth in `market_bars`. |
| Compare strategies on identical bar series (A/B) | per change | ✗ | No multi-strategy fixture runner. Roadmap Session 10. |
| Track "promotion" history per pair (`discovery → paper → canary → live`) | per change | ✗ | Roadmap cross-cutting backlog. |

---

## 4. Portfolio manager / multi-strategy allocator

Decides how much capital each strategy gets. Doesn't trade; owns the *capital budget*.

| Duty | Cadence | Status | Detail / what's missing |
|---|---|---|---|
| See per-strategy P&L attribution | daily | ✗ | Only one strategy today (pairs). |
| Allocate capital across N strategies | weekly | ✗ | Roadmap Session 10 — BudgetAllocator. |
| Rebalance when a strategy's Sharpe decays | weekly | ✗ | Roadmap Session 10 + Session 16. |
| Set a risk budget per strategy | weekly | ✗ | Roadmap Session 10. |
| Approve adding a new strategy to live | ad-hoc | ✗ | No promotion ladder yet. |
| Veto a strategy mid-day (kill that strategy only) | live | ✗ | Roadmap Session 10 — depends on registry. |
| Funding-rate / carry strategy (basis-arb cousin) | live | ✗ | Roadmap Session 10. |
| Cross-strategy correlation check | daily | ◐ | `CorrelationCapGate` exists (Session 8) but it caps per-pair, not per-strategy. |

---

## 5. Investor relations / LP-facing

Sends reporting to investors, fields questions, prepares quarterly letters.

| Duty | Cadence | Status | Detail / what's missing |
|---|---|---|---|
| Show NAV time series | daily | ◐ | `stat_arb_nav` table exists + NAV cron writes once/UTC-day (Session 9); **dashboard reads cumulative P&L curve, not the persisted NAV.** Need a `GET /api/stat-arb/nav?from=&to=` endpoint reading the table. |
| Show Sharpe / Calmar / DD | daily | ✓ | Investor view |
| Show per-LP P&L (fee-class differentiated) | monthly | ✗ | No LP entity model. Roadmap Session 17 (Phase 2 gated). |
| High-water-mark per-LP for perf fees | monthly | ✗ | Roadmap Session 17. |
| Management-fee accrual | monthly | ✗ | Roadmap Session 17. |
| Tax-lot tracking (FIFO/LIFO/HIFO) | annually | ✗ | Roadmap Session 17. |
| 3(c)(7) qualified-purchaser test | per onboarding | ✗ | Phase 4. |
| Quarterly investor letter (auto-render) | quarterly | ✗ | No template / data-binding. Roadmap Session 15 has a daily report but not quarterly. |
| Drawdown alert email | per breach | ✗ | Roadmap Session 15. |
| Account statement generation | monthly | ✗ | Phase 4. |

---

## 6. Operations / SRE

Keeps the desk running. Owns the *system*.

| Duty | Cadence | Status | Detail / what's missing |
|---|---|---|---|
| Migration runs against fresh prod DB | on deploy | ✓ | `npm run migration:run` is the canonical path |
| Append-only invariants asserted in CI | per CI run | ✓ | `append-only.int-spec.ts` |
| Service health endpoint | live | ✗ | No `/healthz` or `/readyz` exposed yet. |
| Latency p50/p95/p99 per endpoint | live | ✗ | Roadmap cross-cutting backlog + Session 15. |
| Data-gap detection on ingest | live | ◐ | `gap-detector.ts` ships (Session 11); **no ingest cron runs it**. |
| Real-bar ingest cron | live | ✗ | `MockBarIngest` exists; **no scheduled job that pulls bars and writes to `market_bars`**. Roadmap Session 11 stretch. |
| Reconciliation cron (internal book vs venue book) | live | ✗ | Roadmap Session 14. |
| Alert sinks (Slack / PagerDuty / email) | live | ✗ | Roadmap Session 15. |
| Daily desk report (auto-rendered) | daily | ✗ | Roadmap Session 15. |
| Key-rotation runbook | quarterly | ✗ | Roadmap Session 18 + cross-cutting backlog. |
| Vendor Chart.js (drop the CDN) | once | ✗ | Cross-cutting backlog. |
| Backup / point-in-time-restore strategy | continuous | ✗ | Not addressed in repo. |
| Disaster recovery runbook | per incident | ✗ | Not addressed. |
| Secret rotation for `MERIDIAN_CLIENT_KEY` | quarterly | ✗ | Vault swap point exists (`ISecretProvider`); runbook doesn't. |

---

## 7. Execution trader (when real venues land)

Only relevant post-KYB. Owns the *route* from intent to filled child order.

| Duty | Cadence | Status | Detail / what's missing |
|---|---|---|---|
| Pick the best venue for a parent order | live | ✗ | Roadmap Session 13 — `order-router.ts`. |
| Slice via TWAP / VWAP / POV / iceberg | live | ✗ | Roadmap Session 13. |
| Model slippage and attribute it post-trade | live | ✗ | Roadmap Session 13. |
| Cancel + replace a working child order | live | ✗ | Roadmap Session 13. |
| Confirm fill quality vs expectation | live | ✗ | Roadmap Session 13. |
| Paper-trade mode for shake-out before live | live | ✗ | Roadmap Session 14. |
| Canary rollout (X% paper, 1-X% real) | live | ✗ | Roadmap Session 14. |
| Live-mode boot assertion (refuse without KYB) | startup | ✗ | Roadmap Session 18. |
| Real-time fill audit | live | ✗ | Roadmap Session 13 + 14. |

---

## 8. Engineering / dev workflow

Internal-facing: what we as builders can't do well yet.

| Duty | Cadence | Status | Detail / what's missing |
|---|---|---|---|
| Type-check on save | live | ✓ | `tsc --noEmit` passes |
| Run unit specs | live | ✓ | `npx jest --silent` — 279+ green |
| Run integration specs against Postgres | live | ◐ | They skip cleanly when DB is unreachable, but **the hedge sequence-perm bug never gets caught locally** unless DB is up. |
| Deterministic backtest CI gate | per commit | ✗ | Cross-cutting backlog item: spec that runs the backtest twice and asserts byte-identical `BacktestResult`. |
| End-to-end smoke against the live API | per commit | ✗ | No `/healthz` to even start with. |
| Frontend automated regression | per commit | ✗ | The HTML is hand-written, no test rig. |
| Vendor the Chart.js CDN dependency | once | ✗ | Cross-cutting backlog. |
| Course / dashboard cross-link audit | quarterly | ✗ | Cross-cutting backlog. |
| `process.env` linting (only `app-config.factory.ts` allowed) | per commit | ✗ | Convention, no lint rule. |
| Migration dry-run against staging before prod | per migration | ✗ | No staging environment defined. |

---

## 9. Headline gaps — the punch list

If you only want the five things missing to go from *Phase-3-demo* to *Phase-4-ready-for-customer-capital*, they are:

1. **Real-bar ingest cron.** Right now `MockBarIngest` is the only path that populates `market_bars`. Without a cron that pulls real history (post-KYB / via a public-feed adapter), the research desk runs against synthetic data forever. Sessions 11 (shipped) + a small follow-on job.

2. **Live mark-to-market loop for open positions.** Today's P&L is closed-trade only. Roadmap Session 14 (paper-trading) drags this in.

3. **Persistent kill switch + server-side flat-everything.** The current UI kill is client-only. A trader hitting it has no way to actually stop the cron'd backtest, and there's no audit trail. Small surface: `POST /api/stat-arb/kill` writing to a `kill_state` row + reading it in every cron tick.

4. **Live alert sinks.** Roadmap Session 15. Slack webhook for "DD breach > 4%", "venue cap tripped 3× in 5 min", "data gap > 10 min".

5. **Per-LP NAV + fee accrual.** The single biggest *post-Phase-2* engineering block. Roadmap Session 17. Gated on legal-formation closing — but until the fund document exists, there's no fee schedule to accrue against.

Everything else (multi-strategy, exec router, paper-trading, universe discovery, fees, real venues) is sequenced in the roadmap and gates on either KYB or Phase 2 legal formation — engineering ready, business not.
