# 7. From paper to production

!!! abstract "Where this chapter fits"
    **Feeds in from:** [§6 backtesting](06-backtesting.md) — every metric and acceptance band here is operationalising §6's discipline against live data instead of historical replay. The calibration loop in [§6.4](06-backtesting.md#64-calibrating-the-fee-slippage-model-the-audit-loop) is what [§7.1](#71-the-shadow-phase-running-live-without-spending-money) and [§7.2](#72-the-minimum-capital-phase-making-sure-the-friction-is-right) close around.
    **Feeds into:** [PHASED_PLAN.md §Phase 4](../../../PHASED_PLAN.md) — the audited-NAV artifacts in [§7.7](#77-what-audited-nav-actually-means-the-artifacts-the-fund-administrator-wants) are the precondition for opening any fund product to outside LPs. The 12-month-without-restatement clock starts at the first day [§7.3](#73-the-capital-ramp-curve-concrete-dollar-amounts)'s min-capital phase produces a reconciled NAV.
    **Reads cleanly on its own:** if you're vetting whether to invest engineering time in this whole programme, [§1](01-introduction.md) and §7 together give the cost-benefit picture without needing the math in between.

## 7.1 The shadow phase — running live without spending money

Shadow mode is the operational analogue of [§6](06-backtesting.md)'s purged k-fold cross-validation: the strategy runs against real, live, current market data, but **execution is disabled**. Every order the strategy would have placed is logged with the bar's mid, top-of-book spread, the side and size of the would-be order, and a synthetic fill price derived from your Level-2 slippage model ([§4.4](04-execution.md#44-the-cost-model-is-what-makes-the-backtest-honest)). Nothing leaves the process.

Shadow mode answers two questions the backtest can't:

1. **Does the live data feed behave the way the historical replay did?** Realised bar-close timestamps may have a few-second jitter on the WebSocket vs the cleanly-aligned historical bars. Outage handling differs. The number of bars per day may not match the backtest's expectation (one missing bar can shift a multi-bar signal).
2. **Does the strategy's *frequency of trading* match the backtest's?** A strategy that the backtest says trades 12 times per day but in shadow trades 4 times per day has either a regime mismatch (current month doesn't look like the backtest window) or a bug (a condition that's harder to satisfy in live than in replay).

Shadow runs for a **minimum of 10 trading days** before any progression. Less than that and you can't distinguish a quiet week from a real divergence.

**The shadow-vs-backtest acceptance test** is the gate to the next phase:

| Metric | Acceptance band |
|---|---|
| Trades per day | within ±30% of the backtest's expected frequency |
| Realised slippage (model vs synthetic fill price) | within ±50% of the backtest's modelled slippage |
| Number of signal-trigger events that did NOT result in a "would-be order" (e.g. risk-rejected, venue-down) | logged and reviewed; <10% of trigger events |
| P&L of the would-be orders, evaluated at synthetic fills | within ±2σ of the backtest's daily P&L distribution over the same window |

If the strategy fails any band, it goes back to the backtest. Either the backtest is wrong (recalibrate the slippage model — [§6.4](06-backtesting.md#64-calibrating-the-fee-slippage-model-the-audit-loop)) or the strategy has bugs that didn't show up in deterministic replay.

## 7.2 The minimum-capital phase — making sure the friction is right

When shadow passes, deploy with the **smallest capital that lets you measure fill quality honestly**. For a stat-arb pair trading on a top-tier CEX with a maker rebate of -1 bp and taker fee of +5 bp, the minimum useful capital is whatever produces an order size large enough that you're not at the bottom of the venue's fee tier and where realised slippage is large enough vs measurement noise to be meaningful — typically **$50,000–$100,000 per strategy.**

**Not** scaled-down backtest sizing. The temptation is to size the live position by `live_capital / backtest_capital × backtest_size`, which preserves the strategy's risk profile but makes the live trade so small that fee impact and slippage are dominated by noise. The right size for the *measurement* phase is "small enough to limit total loss to <0.5% of NAV in any single bad week, large enough that your average fill is one or two ticks worse than top-of-book."

This phase typically runs **2 weeks** before any size increase. The acceptance test:

| Metric | Acceptance band |
|---|---|
| Average realised slippage (live fills vs shadow model's synthetic fills) | within ±20% |
| P&L per trade | within ±1σ of shadow's would-be P&L per trade |
| Failure rate of execution (order cancelled, network blip, partial fill needing reconciliation) | <2% of placed orders |
| Venue health events (degraded WebSocket, latency spike >500ms, manual intervention) | logged; root-causable; <1 per week sustained |

If the live phase diverges from shadow by more than the bands above, you've found a difference between the synthetic fill model and the actual fill behaviour. Recalibrate the model first; do not increase size to "average through" the discrepancy.

## 7.3 The capital-ramp curve — concrete dollar amounts

Once minimum-capital live matches shadow within tolerance, ramping is mechanical. Each step requires the previous step to have run cleanly for the stated duration. **Anti-pattern: scaling because the strategy is making money in the current week.** Strategies make money during regime-favourable weeks regardless of edge. The ramp is gated on *fidelity of fills*, not on P&L.

| Step | Capital per strategy | Min. duration at level | Gating metric |
|---|---|---|---|
| Shadow | $0 | 10 trading days | §7.1 acceptance bands |
| Min-capital live | $50,000 – $100,000 | 10 trading days | §7.2 acceptance bands |
| Step 1 | $250,000 | 10 trading days | Slippage band still ±20%; daily-NAV reconciliation passes 100% |
| Step 2 | $500,000 | 10 trading days | Same + venue-cap utilisation <80% of [§5.3](05-risk.md#53-per-venue-caps) cap |
| Step 3 | $1,000,000 | 20 trading days | Same + portfolio-level drawdown gate has not tripped |
| Full allocation | per strategy budget (typically $2M–$5M in Meridian Markets' Phase 3 envelope of $5M–$10M total) | indefinite | Continuous monitoring per [§7.5](#75-operations-the-daily-checklist) / [§7.6](#76-operations-the-weekly-checklist) |

The curve is *roughly* doubling each step. Faster ramps fail; slower ramps work in expectation but cost opportunity. The pace above is the empirical middle.

**Backing off is mandatory.** If at any step the acceptance bands fail, the strategy goes back to the previous step's capital level for another 10 days. After two consecutive backs-off the strategy is paused entirely and re-vetted in shadow. **Anti-pattern: holding at the failing capital level "to see if it recovers."** Either the strategy works or it doesn't; persistence at a level that's failing acceptance is how single-strategy losses become books-wide losses.

## 7.4 The Phase-2 gate — what blocks all of the above

Per [PHASED_PLAN.md](../../../PHASED_PLAN.md) cross-phase dependency #1: **no live execution before Phase 2 legal formation closes.** Even with own capital, even on a single strategy, execution stays off until:

1. The Meridian Markets entity is formed and bank-account / venue accounts are in the entity's name (not a personal name).
2. Opinion letters confirm own-capital trading is unregulated in the team's relevant jurisdictions.
3. Venue KYB closes for at least one production venue (the choice of *which* venue is part of Phase 2's scope).

Shadow mode (§7.1) is fine to run pre-formation — there's no execution and no entity-level commitment. Flipping minimum-capital execution on requires all three Phase-2 items closed. **Engineering does not flip the `MOCK_TRADING_ENABLED` flag without written confirmation from the legal track.**

## 7.5 Operations: the daily checklist

To be read top-to-bottom at the start of every trading day. The operator's literal first hour of work. Each item is a discrete check with a discrete outcome.

- [ ] **Overnight P&L review.** Read yesterday's strategy P&L vs the previous 30-day distribution. Flag any day outside ±2σ.
- [ ] **Circuit-breaker state.** For each strategy, confirm no gate is tripped (drawdown, venue health, data staleness, cointegration decay, funding spike — full list at [§5.5](05-risk.md#55-circuit-breakers)). Any tripped gate that hasn't been resolved by the operator gets escalated *before* market open.
- [ ] **Venue health overnight.** For each connected venue, review the WebSocket uptime overnight, any disconnect/reconnect events, any latency spikes >500ms. Flag any venue with <99% uptime overnight.
- [ ] **Funding rate review (perp venues).** Read the overnight funding rate prints. Flag any >50bps as a sizing input even if it didn't trip the [§5.5](05-risk.md#55-circuit-breakers) funding-spike gate.
- [ ] **Position reconciliation.** Compare the local `prop_positions` table against `fetchPosition()` on each venue. Any drift is investigated immediately — not after market open.
- [ ] **Cointegration re-test.** For each active pair, confirm the rolling p-value re-test from [§2.9](02-cointegration.md#29-spread-staleness-diagnostics-knowing-when-a-cointegrated-pair-has-broken) passed yesterday. Any pair with p > 0.05 for 1 day gets sized down 50%; for 2 days gets closed.
- [ ] **OU parameter check.** For each OU strategy, confirm $\theta$ from yesterday's re-fit is within ±25% of the rolling median (per [§3.6](03-ou-process.md#36-reading-the-ou-fit-diagnostics-in-practice)). Flag any drift outside that band.
- [ ] **NAV reconciliation.** Confirm the prior day's NAV calc matches the venue statements. Any drift > $50 is investigated.
- [ ] **Strategy on/off state.** Confirm the set of "running" strategies matches the operator's expectation. No surprise additions, no silent shutdowns.
- [ ] **Capital allocation per strategy.** Confirm each strategy's notional is below its [§5.3](05-risk.md#53-per-venue-caps) cap. Any utilisation > 80% gets flagged for the weekly review.
- [ ] **Manual override log.** Review yesterday's `manual_overrides` table entries. Any human intervention is reviewed and signed off.
- [ ] **Sign off.** Operator initials and timestamps the checklist in the daily-ops log.

Estimated time: **20–30 minutes** when everything is clean; **2–4 hours** when an item flags. The point of the checklist is that nothing is missed; the time variance is normal.

## 7.6 Operations: the weekly checklist

To be read every Monday morning. Slower-moving items than the daily checklist.

- [ ] **Universe re-screening.** Re-run the [§2.8 funnel](02-cointegration.md#28-universe-construction-from-infinite-candidate-pairs-to-a-tractable-book) (liquidity floor → sector bucketing → correlation pre-filter → cointegration test → half-life filter → capacity check). Identify pairs that have entered or exited the tradable set since last week.
- [ ] **Strategy attribution review.** For each strategy, compute the rolling 30-day Sharpe and compare to the backtest's expectation. Any strategy with realised Sharpe < 50% of backtest's gets flagged for review.
- [ ] **Cross-strategy correlation matrix.** Compute the 30-day Pearson correlation of daily P&L across strategies. The portfolio-level VaR assumes a correlation structure ([§5.4](05-risk.md#54-portfolio-level-var-drawdown-gate)); if realised correlations have drifted >0.2 from the assumption, recompute VaR with the new structure.
- [ ] **Capacity utilisation.** For each strategy, plot the realised position size vs the [§5.3](05-risk.md#53-per-venue-caps) per-venue cap over the last week. Identify strategies pressed against caps — they may be ready to scale (per [§7.3](#73-the-capital-ramp-curve-concrete-dollar-amounts)) or they may indicate a sizing inefficiency.
- [ ] **Fee & rebate accrual.** Sum the week's maker rebates and taker fees per venue. Compare to the backtest model's prediction. Material divergence is recalibrated immediately (per [§6.4](06-backtesting.md#64-calibrating-the-fee-slippage-model-the-audit-loop)).
- [ ] **Open-orders sweep.** Review any limit orders that have been resting >24 hours. Most should be cancelled; resting orders accumulate stale-data risk.
- [ ] **Disaster-recovery dry-run.** Once per month inside the weekly checklist: run the kill-switch ([§5.6](05-risk.md#56-the-kill-switch)) in a non-production environment to verify it cancels all orders and flattens all positions correctly. Update the runbook if anything has changed.
- [ ] **NAV provider reconciliation.** Confirm the fund administrator's NAV calc agrees with the internal calc within the contracted tolerance. Material divergence is escalated to the fund administrator the same day.

## 7.7 What "audited NAV" actually means — the artifacts the fund administrator wants

[PHASED_PLAN.md §Phase 3](../../../PHASED_PLAN.md) commits to "audited daily NAV from day one." That commitment is what makes the engineering / accounting interface concrete. A fund administrator runs the NAV calc independently of the manager and is the source of truth for what investors see; for Meridian Markets' Phase 3 the choice is among three credible providers, profiled below from their public service descriptions.

**NAV Fund Services** (a.k.a. NAV Consulting — [navconsulting.net](https://www.navconsulting.net/hedge-fund-administration)). Privately-owned, founded 1991, ranked #1 in an independent survey of global hedge-fund COOs. 2,550+ clients, $450B+ AUA. Daily reporting typically delivered **by 6:30 AM ET of the next business day**. Offers daily, weekly, monthly, quarterly, annual, or subperiod NAV. Three-way trade & position reconciliation is automated. Portfolio valuation uses third-party independent pricing feeds (not the manager's marks). 99% client retention rate. 24/7 client support. **Fit for Meridian Markets:** strong on emerging-manager fit and on the daily reporting cadence that PHASED_PLAN.md's audited-track-record gate requires. Privately-owned means decisions made without quarterly-earnings pressure.

**SS&C GlobeOp** ([ssctech.com/industry/hedge-fund](https://www.ssctech.com/industry/hedge-fund)). The 800-lb gorilla of fund administration. The NAV production process is published in detail at [globeopindex.com/methodology](https://www.sscglobeopindex.com/methodology.jsp): three reporting passes per month (**flash estimate on the 9th business day**, **interim on the 9th business day of the second month**, **final on the 9th business day of the third month**), an independent price verification process leading to final NAV, and a SOC 1 examination annually under SSAE No. 16 / ISAE 3402. **Fit for Meridian Markets:** strongest on institutional credibility — an LP that recognises SS&C GlobeOp's name needs no further explanation. The trade-off is the institutional cadence (monthly final NAV) being slower than NAV Consulting's daily; the *daily* portion of the audited-NAV requirement may need a separate arrangement.

**Sudrania Fund Services** ([sudrania.com](https://www.sudrania.com/) — also operates as Formidium). Chicago-based; specifically positioned for crypto strategies. Launched "Seamless Crypto" in 2020 as a full-scale fund administration platform purpose-built for digital assets: 120+ API connections across exchanges and custodians, ability to produce fund accounting in cryptocurrencies as base currency, trade accounting capable of high-frequency strategies, automated waterfall calculations, VaR reporting, portfolio analytics. AIMA sponsoring partner; integrated with BlockFills and other crypto-native counterparties. **Fit for Meridian Markets:** the *most aligned* of the three with crypto-native stat arb. Less institutional weight than SS&C but the technical fit is materially better for a book that lives across CEX, perp DEX, and on-chain venues.

**Decision posture** (not yet a decision, but the criteria are clear):

| Criterion | NAV Consulting | SS&C GlobeOp | Sudrania |
|---|---|---|---|
| Daily NAV cadence | ✅ Next-business-day 6:30 AM ET | ⚠ Monthly final (flash/interim available) | ✅ Daily, crypto-native |
| Independent pricing | ✅ Third-party feeds | ✅ Independent verification + SOC 1 | ✅ 120+ API connections |
| Crypto / digital-asset fit | ⚠ Generalist | ⚠ Generalist | ✅ Purpose-built |
| Institutional brand recognition (for LPs) | ✅ Top-3 emerging-manager admin | ✅ Strongest in the industry | ⚠ Specialist; less name-brand |
| Cost (rough) | $$ | $$$ | $$ |

For Phase 3 own-capital, **Sudrania** is the strongest technical match. For Phase 4 (when LPs are involved), **NAV Consulting** or **SS&C GlobeOp** become more attractive purely on LP-due-diligence grounds. A defensible posture is to start with Sudrania for the engineering integration and revisit at the Phase-4 gate.

**Operational artifacts the fund administrator needs from the engineering side**, regardless of which provider is chosen:

1. **Daily position file** — every open position at UTC close, in a defined format (Sudrania ingests via API; NAV Consulting and SS&C accept SFTP file drops). Includes venue, symbol, side, notional, entry price, current mark, accrued funding (for perps), and the venue's reported position to enable three-way reconciliation.
2. **Daily cash file** — venue balances and any on-/off-ramp movements during the day, with the source of truth being the venue's API balance call, not the local DB.
3. **Daily trade file** — every fill from the prior day, with timestamp, venue, side, size, fill price, and fee. The append-only ledger (`prop_movements`) is the upstream source.
4. **Independent price marks** — for any asset where the venue's mark might be disputed (e.g. illiquid altcoins on a single venue), provide a secondary mark from an aggregator (Kaiko, CoinGecko, etc.) for the administrator to use in their verification step.
5. **Manual-override log** — every operator intervention (manual close, kill-switch invocation, parameter change) with timestamp, operator ID, and justification. The fund administrator's SOC-1-equivalent review will sample these.

**The Phase-4 unlock requires 12 months of these artifacts produced without material restatement.** A single restated daily NAV — i.e. a NAV that the fund administrator agreed to and later had to revise — resets the 12-month clock. The engineering posture is therefore conservatism: when in doubt about a mark, use the more conservative value; when in doubt about a fill, do not record it until reconciled. **Speed of reporting matters less than not having to restate.**

## 7.8 Citations

- The interface-and-mock-default pattern is internal to this codebase (see [CLAUDE.md §6–§7](../../../CLAUDE.md)).
- **NAV Fund Services** public service description: [navconsulting.net/hedge-fund-administration](https://www.navconsulting.net/hedge-fund-administration), accessed 2026-05-26.
- **SS&C GlobeOp** NAV methodology: [sscglobeopindex.com/methodology](https://www.sscglobeopindex.com/methodology.jsp); hedge-fund services: [ssctech.com/industry/hedge-fund](https://www.ssctech.com/industry/hedge-fund), accessed 2026-05-26.
- **Sudrania Fund Services / Formidium** Seamless Crypto: [sudrania.com/seamlesscrypto](https://sudrania.com/seamlesscrypto/), accessed 2026-05-26.
- **PHASED_PLAN.md §Phase 3** — the cross-phase dependency that gates Phase 4 on a 12-month audited NAV track record. Internal repo doc.
- SOC 1 reporting framework: AICPA SSAE No. 18 (which superseded SSAE No. 16). Public reference: [aicpa.org](https://www.aicpa.org/) for the current statement of standards.

Open practitioner references on shadow-phase and capital-ramp practice are scarce — most operational write-ups are internal to the desks that ran them. The capital-ramp curve in §7.3 is informed by the Open Quant Project newsletter, Robert Carver's blog (`qoppac.blogspot.com`), and the unpublished operational lore that propagates through prime-broker introductory decks. None of these is canonical Tier-A; the framing in §7.3 is the conservative middle of practitioner ranges.
