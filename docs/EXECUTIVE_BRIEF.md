# Meridian Markets — Executive Brief

### A one-operator quant desk run by AI agents

*Prepared for principals, allocators, and quant-desk leaders evaluating a production trial. Current through 2026-06-04.*

---

## Executive summary

Meridian Markets is a working statistical-arbitrage and market-making engine, a research program that has tested and graded trading edges across six strategy families and more than eight market venues, and a paired curriculum that teaches the operator the exact mathematics the engine runs. One person built and operates it by directing a team of AI agents.

We are presenting a method, not a single strategy. AI agents widen the tradeable universe, fit and tune strategies, and submit every candidate to one fixed standard before any number is trusted: out-of-sample, corrected for multiple testing, survivorship-aware, and realistic about cost and fills. The desk grades its strategies down as readily as up, and records the failures, because it is a demonstration and an inflated backtest is worth nothing to anyone.

What that program has established so far, on real public market data:

- Crypto pair-trading is structurally untradeable net of fees. A mechanistic negative result, not a tuning failure.
- Same-sector equity pairs carry a real but ~0.06-Sharpe edge, survivorship-bound and below any deployable bar.
- Funding-rate carry on the majors is a real 3–8%/yr edge, fee-bound on short holds.
- Market-making on a maker-rebate order book is the live earner, and we have produced the first net-positive read on fills we could actually have obtained, against a real depth tape, real per-trade flow, and the venue's true −0.2 bps rebate.

The desk paper-trades on real data by mandate while it pursues the frontier where the edge grows: discovery of under-watched, decentralized markets, and a deliberate position for the expansion of stablecoin and on-chain markets. What we need now is a production environment and a trading partner to test the market-making book under real fills. The rest of this brief is the evidence that the trial is worth running, and the reasoning behind the wager that this model, given more agents, becomes a serious competitor.

---

## 1. The operating model and the wager behind it

Meridian is a modular monolith: one engine, one database, one repository. It ingests real market data, discovers tradeable relationships, backtests them, and runs strategies on a live paper loop. A crypto market-making desk is the steady, low-drawdown earner; an equities statistical-arbitrage desk is a thin, uncorrelated diversifier. The web dashboard is a read-only view over the engine, which is the product.

What is unusual is who runs it. There is one human supervisor. Behind him, specialist AI agents do the work of a quant pod, each given a written role brief and a scoped slice of the system. A Strategy Developer owns the strategy catalogue, the signal and risk libraries, and the validation gate; its job is to prove an edge survives out-of-sample, net of cost. A Market Data Researcher owns the data layer and the new-market universe; its job is discovery, decentralized venues first. Per-strategy quant agents each own one strategy on one book and commit their work the way any quant would: on a git branch, through a promotion gate, into a shared blotter.

There is no orchestration framework and no per-agent infrastructure. Coordination runs on git, one shared control plane that already runs many isolated books, and a roster file listing the active stations. Agents are separated by a brief and a scope, not by services. Every external integration sits behind a typed interface with a real and a mock implementation, selected by configuration, so a new agent's task is usually to implement an interface, register it, and leave the safe default on. A bad change is contained to one book, one branch, and a safe default rather than the whole engine.

The wager is on scale. The marginal cost of an additional agent is low, and the same model with more of them — more researchers widening the universe, more developers validating, more reviewers stress-testing the theory — compounds rather than congests, because the seams keep them from colliding. A solo operator with a dozen disciplined agents is a different proposition from a solo operator. The repository today carries 137 test suites and 911 tests, type-clean, two complete courses, and a full reproducible research record, built and maintained by one person. Set against a pod shop that spends its first year on headcount and coordination before a validated edge ships, the cost structure and iteration speed of this model, pointed at a frontier the large shops under-watch, is the competitive thesis.

---

## 2. The standard that makes the numbers mean something

Every candidate passes the same gate before any claim is made. This is the part a serious counterparty should weigh most heavily, because it is what separates a measured edge from a flattering one.

| Control | What it prevents |
|---|---|
| Out-of-sample walk-forward, β re-fit per window | look-ahead: the hedge ratio is re-estimated on each training window and judged only on the next, unseen one |
| Deflated and Probabilistic Sharpe (Bailey & López de Prado) | multiple testing: scanning 80–90 pairs inflates the best Sharpe; we deflate it by the cross-trial dispersion |
| Purged k-fold with embargo (López de Prado) | leakage across adjacent folds in autocorrelated price series |
| Survivorship gate | a backtest on today's survivors is biased upward, and the bias grows with window length; a survivor-unsafe read is capped, never promoted |
| Cost model | half-spread, linear market impact (λ·notional/ADV), short-borrow carry, and funding, charged on every fill |
| Queue-aware fills | fill-on-touch is an upper bound; fills are computed FIFO against a real order-book depth tape |

Two results from this work justify the apparatus on their own.

First, position size is a risk lever, not an alpha lever. Under flat percentage fees, net edge in basis points and Sharpe are invariant to size, which we proved empirically: $25k returns +$3,916, $250k returns +$39,162, $2.5M returns +$391,616, while edge-per-trade (313 bps) and Sharpe (1.00) hold flat. Size scales variance, bounded by the impact-optimal notional N\*, which grows with the square of available depth. "Trade bigger to earn more" is false, and ruling it out closes off a common form of self-deception.

Second, costs decide thin edges, and modelling them reorders the leaderboard rather than merely shrinking it. Adding realistic half-spread and impact to a backtest reverses the ranking: the thin-leg names that look best gross of cost are the ones that die once you pay to cross the spread and move the book, while the liquid names survive. A ranking computed gross of cost is wrong in its ordering, not only its level. The cost model retired our then-best candidate, a Sharpe-3.16 basket, the day it shipped. The desk is built to reject before it is built to deploy.

---

## 3. The quantitative stack: methods, strategies, and markets

This section answers the question a quant reviewer asks first: what is actually in here. The mathematics is canonical and the implementation is named and tested. None of it is novel for its own sake; the work is in assembling it into one auditable pipeline and pointing it at the right markets.

### 3.1 Methods, as implemented

| Method | Role in the system |
|---|---|
| Engle-Granger cointegration, per-window β re-fit | pair discovery and the out-of-sample gate |
| Augmented Dickey-Fuller test | the stationarity screen on every candidate spread |
| Log-spread and rolling z-score; EWMA z-score | the entry/exit signal for the z-score and EWMA pairs strategies |
| Ornstein-Uhlenbeck fit, Bertram optimal thresholds | the OU mean-reversion strategies; thresholds set from reversion speed and level |
| Half-life of mean reversion | regime and staleness detection, to flag a decaying relationship before P&L does |
| Avellaneda-Stoikov reservation price and optimal spread | the inventory-aware quoter |
| Guéant-Lehalle-Fernández-Tapia (GLFT) | the closed-form quoter that is the desk's market-making default |
| VPIN (volume-synchronized probability of informed trading) | the risk gate that pauses quoting into toxic flow |
| Linear market impact and the impact-optimal N\* | the cost model and the position-sizing study |
| Black-Scholes with full Greeks (Δ, Γ, ν, Θ, ρ) and Bachelier | the options pricer, validated against Deribit on live data |
| Funding-carry P&L and breakeven hold | the perpetual-swap carry research |
| FIFO price-time-priority queue model | the order-book replay harness that produces queue-aware fills |
| Five-component P&L attribution | every fill decomposed into spread, adverse selection, inventory mark, fees, and funding |
| Probabilistic / Deflated Sharpe, purged k-fold, fractional Kelly | the validation and sizing discipline of §2 |

### 3.2 Strategies developed

- **Mean-reversion pairs:** `pairs-zscore`, plus a selective variant with a stiffer fee gate and a wide-band variant; `pairs-ewma` and a higher-conviction variant; `ou-bertram` with throttled and fast variants. Each runs under a `conservative` / `balanced` / `aggressive` risk profile.
- **Market-making quoters:** `mm-symmetric` (a baseline), `mm-avellaneda-stoikov`, and `mm-glft` (the default), all sharing one inventory book, risk gate, and five-component attribution.
- **Carry and volatility:** delta-neutral funding-rate carry (long spot, short perp); an FX-stable basis trade; and a delta-hedged short-straddle vol-sell against the measured variance risk premium, under a Greeks budget.

### 3.3 Markets and asset classes studied

- **Crypto stat-arb universes:** crypto-majors, L1 smart-contract, eth-ecosystem, ai-data, gaming-meta, defi-bluechip, payments-sov, the stablecoin peg, and FX stables.
- **Equities (eight sector baskets):** banks, energy, rails, megacap-tech, payments, staples, pharma, semis — chosen for shared cash-flow drivers, with split- and dividend-adjusted history.
- **Market-making and discovery:** the stablecoin peg and an FX-via-stables book on Binance; Hyperliquid perpetual swaps (the default venue); and DEX bluechip pools on Uniswap-v3 across Ethereum and Base.
- **Reference and derivatives data:** Pyth FX benchmarks, DefiLlama pegs, Bit2C (ILS), GeckoTerminal across 100-plus chains, Hyperliquid depth/trades/funding, and Deribit options for BTC and ETH.

---

## 4. What we found

The research can be read in one table and then in depth. The pattern across all of it: the naive edge is an artifact, and the surviving edge is small and specific. Short windows manufacture crypto cointegration, survivorship manufactures equity Sharpe, fill-on-touch manufactures maker fills, and ignored funding and impact manufacture carry. Naming where each edge fails is the result that has the most value.

| Strategy family | Markets | Verdict | Why |
|---|---|---|---|
| Crypto pair-trading | majors, L1, ETH-eco, ai-data, gaming, defi | **Killed** | cointegration is a short-window artifact; it collapses to ~0 by 90–180 days |
| Stablecoin-peg pairs | USDT / USDC / FDUSD / TUSD | Watch | the one structural crypto spread, but sub-fee for a taker |
| Equity sector pairs | banks, energy, rails, staples, pharma | **Real, ~0.06 Sharpe** | structurally cointegrated, but thin and survivorship-bound |
| Funding carry | BTC / ETH / majors perps | **Real, modest** | ~3–8%/yr; hold past breakeven; the basis is the risk |
| FX-stable basis | EUR stablecoin vs FX | Route to maker | reverts reliably but sub-fee for a taker |
| Options VRP | BTC / ETH | Validated, in reserve | positive carry; our Greeks match Deribit; delta-hedged only |
| Market-making, rebate CLOB | Hyperliquid perps | **The live earner** | first net-positive read on real fills at the −0.2 bps rebate |
| Market-making, DEX AMM | Uniswap-v3 pools | Research | the wide spread is hazard pay; net-negative without a rebate |

### 4.1 Crypto pairs: the cointegration cliff

Crypto cointegration is a short-window measurement artifact. Run the same discovery test at growing horizons and the count of cointegrated pairs collapses toward zero: crypto-majors goes 41 → 13 → 0 over 30, 90, and 180 days; ai-data 18 → 4 → 0; eth-ecosystem 22 → 5 → 0. A candidate that looked tradeable in-sample went through the full out-of-sample, deflated-Sharpe gate and was killed: too few out-of-sample trades survive the multiple-testing haircut, and over 90 days the top pairs lose money out-of-sample with large train-to-test degradation. The one exception is the stablecoin peg, whose cointegration strengthens with horizon (4 → 6 → 6) because the legs are tethered to the same dollar, but whose spread is narrow enough that the taker fee consumes it. This result drove the pivot to market-making as the live earner and to equities as the diversifier.

### 4.2 Equity pairs: a real edge, measured down to size

Same-sector equities are cointegrated for a structural reason, and the cliff does not happen: cointegration counts stay flat across 180, 365, and 730 days where crypto went to zero. But the edge is thin, and the value is in how carefully we bounded it. A single near-passing pair (banks USB/PNC) showed a 92% deflated Sharpe over five years, then saw its Sharpe halve when the window grew to six years — regime-sensitive, so the gate refused it. A de-biased basket — each ticker used once so the pairs are near-independent, ranked by cointegration rather than realized Sharpe so it cannot cherry-pick, pooled across five sectors into 507 out-of-sample trades — nets +$118k over five years at a pooled Sharpe of 0.06, and shows the single pair's 0.65 was mostly selection luck. Decades of free daily history then flip the gate to PASS, but for the wrong reason: Sharpe rises monotonically with window length (0.06 → 0.09 → 0.15), the signature of survivorship, because a long backtest on today's survivors omits the 2008 and 2020 casualties. We capped the survivor-biased read and concluded that the real equities verdict is a forward paper track record with no look-ahead, not the long-window backtest.

### 4.3 Carry, basis, and volatility

Holding a perpetual swap delta-neutral harvests a real, persistently one-directional funding stream: ~3–4%/yr on Binance majors and ~8.1%/yr on ETH and ~4.5%/yr on BTC at Hyperliquid's hourly cadence, positive in 75–88% of settlements. Because funding is continuous and the round-trip fee is one-time, carry is a hold-longer trade with breakeven near fee divided by funding rate; the basis, not the fee, is the risk. A EUR stablecoin against its FX benchmark reverts fast and reliably (σ near 1.5 bps, half-life around seven minutes) but is sub-fee for a taker, so the correct response is to make the market rather than take it. The options Greeks layer (Black-Scholes plus Bachelier) was validated against Deribit on live data, with vega and theta matching to the decimal, and the variance risk premium is positive on both majors (BTC +5.9 vol points, ETH +3.7). Short vol has a measured carry, held in reserve, delta-hedged and under a Greeks budget.

### 4.4 Market-making microstructure: the deepest work, and the first real win

Market-making is the live earner, and microstructure is where fidelity changed the answer.

- **Fill-on-touch overstates fills exactly where you want to believe it.** Against a real Hyperliquid depth tape with real per-trade flow, a top-of-book quote fills about as often as fill-on-touch claimed, so the loss there is adverse selection rather than phantom fills. A quote placed 5 bps into the stack fills zero against ~21 touches, because the queue above it never clears. The overstatement lives on the wide, comfortable quotes.
- **The quoters were silently calibrated for ~$1 assets.** A textbook Avellaneda-Stoikov or GLFT implementation in price units mis-scales its variance term by about 10⁶ on a $1,900 asset; an early run printed a negative-quintillion P&L on a WETH pool. Expressing skew and half-spread as fractions of mid against a fixed $1 reference, with volatility kept a dimensionless return fraction, makes the quoter price-scale-invariant. This is the kind of defect a paper-only backtest never surfaces.
- **A market maker needs a venue at or below 0 bps maker.** At +1 bps retail maker cost the book loses; at 0 bps structural it is positive and monotone with tiny drawdown (a 24-hour stablecoin replay: net positive across all 12 buckets, maximum drawdown near 0.001% on $400k of inventory). The deploy condition is a maker rebate, which is why Hyperliquid — a −0.2 bps rebate central limit order book with free depth and harvestable funding — is the default venue.
- **On real flow, a tuned rebate book nets positive.** Per-pool tuning over a captured tape, ranked drawdown-compliant first and then by net at the venue's own fee, needs real aggressor data; on a candle-volume estimate every combination filled zero. Wiring the real Hyperliquid trades feed unblocked it: on a ~2-hour capture with real flow, queue-aware fills, and funding, fill-on-touch overstated fills threefold, and the sweep found a BTC calibration that nets +$345 over two hours on $1M at 0.53% maximum drawdown, with spread captured (+$541) exceeding adverse selection (+$434). This is the first net-positive read, across all of the DEX and CLOB work, on fills we could actually have obtained. ETH and SOL had no profitable calibration that window, so the tuner stood aside — a coin- and regime-specific edge bounded by one short window and small fill counts, with repeated captures the next step.

### 4.5 The venue map

A standing ledger scores every venue on access, data, maker economics, and fit.

| Venue | Kind | Maker | Role in the findings |
|---|---|---|---|
| Hyperliquid | Perp-DEX (CLOB) | rebate −0.2 bps | default MM venue; queue-aware fills; real trade flow; hourly funding |
| Binance | CEX | ~1 / 5 bps | data spine; stablecoin-peg stat-arb; 8-hour funding |
| GeckoTerminal | DEX (AMM, 100+ chains) | LP fee, pool-dependent | the discovery frontier; wider spread, higher hazard |
| Alpaca | Equities (paper) | commission-free | equities live and the OOS gate |
| Yahoo daily | Equities | — | decades of free adjusted daily history, survivorship-caveated |
| Pyth / DefiLlama / Bit2C | FX / peg / ILS reference | — | FX scan, peg readout, cross-source basis |

Every figure above is reproducible from public, no-key data.

---

## 5. Theory that stays current

The system is anchored in published theory rather than folklore. The same mathematics the engine runs is documented in two complete working courses, one on statistical arbitrage and one on market making, each chapter built to a fixed shape: what a method is, the minimum math to implement it with every symbol named, where it works and where it breaks, the exact code in the engine, and a sourced citation for every claim. The market-making course closes with a chapter that is the operating manual for the live engine, tying each step of the desk runbook — scan, capture a real depth tape, tune, launch a paper book, run it forward — to the file and command that implements it. Anyone, including a reviewer, can read the theory and then run the procedure with no gap between the two.

This matters for two reasons. The desk is not a black box: every model is named, sourced, taught, and auditable, and the operator is educated by the same artifact that documents the system. And the curriculum is itself produced by the agents — the theory is continuously researched, reviewed against peer-reviewed sources, and rewritten into training material, so the body of knowledge that grounds the strategies corrects itself as the desk runs. That is the same scaling lever as the trading work: more agents reading, checking, and teaching the theory make the whole system sharper, not merely larger.

---

## 6. How the desk is driven: terminal and screen

The engine is headless and control-plane-first, so every action is an HTTP endpoint and the desk is driven equally from a terminal or a browser, by a human or an agent. The dual surface is what makes the agentic model practical: agents script the terminal, the human supervises the screen, and both read the same state.

It runs in one of three postures, set by configuration rather than any business gate: a deterministic offline mode for tests, the paper mode the demonstration lives in (real market data, simulated fills, no API key), and a parked real-venue mode behind an explicit arm switch. Paper-trading live data is one command.

```
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
  npm run start:dev          # serves http://localhost:3100/demo
```

The terminal is the `mq` workstation. A quant's terminal does four things — research, backtest, deploy, monitor — and the commands map to each.

```
npm run mq -- discover crypto-majors --hours 72   # cointegrated pairs
npm run mq -- sweep ETH BTC --hours 72            # rank strategies by Sharpe
npm run mq -- arm ETH BTC --strategy ou-bertram --capital 100000
npm run mq -- status                              # z-score, regime, P&L
```

Every command emits JSON so an agent can parse it. Around the CLI sits a library of headless research scripts — the cointegration-cliff thesis test, the out-of-sample gate, the funding- and vol-carry studies, the market-making capture-and-tune pipeline — each runnable against real public APIs with no server. The terminal is where research happens and where agents work: deterministic, scriptable, version-controlled.

The screen is the `/demo` console, a read-only view over the same snapshot the CLI reads, for one human supervising one fund. The operator pulls real history for an asset class, watches cointegrated pairs appear with their β, p-value, half-life, and regime, launches one or several books from a row, and monitors them as cards: z-score, β, entry and exit bands, position, equity, feed-staleness chips, and sparklines on a four-second poll. A fund overview aggregates equity, P&L, drawdown, and exposure by class; a strategy-signal chart shows the bands and the trade markers; a persisted trade history spans every book and survives restart; a single scan sweeps every asset class at once, ranked net of fees, with risk controls one click away. The known gaps are documented in the console's own user-stories file. A full command cheatsheet and a step-by-step operator guide ship with the repository, so a reviewer can drive the same research, backtest, and deploy loop end to end. The loop in practice: an agent wires a venue or validates an edge in the terminal and commits it, it appears on the supervisor's screen, and the human watches the aggregate while the agents work the books.

---

## 7. The frontier: where the edge grows

The research points to one strategic conclusion. The edge does not grow by tuning a known strategy on a crowded venue; it grows by discovering new markets to make. Three forces align on the same frontier.

Market-making's binding condition is a maker venue at or below 0 bps, and decentralized venues are that regime: perpetual order books with maker rebates, and AMM pools where the LP fee accrues to the maker. Under-watched pools also carry structurally wider spreads. Discovery compounds at near-zero marginal infrastructure cost, because every venue sits behind one interface, so each source the researcher wires is permanently in the scan universe and tradeable on the live loop. And the desk is positioned for the stablecoin and on-chain expansion specifically: the one structurally cointegrated crypto relationship we found is the stablecoin peg, and the one venue class where market-making nets positive is the decentralized maker-rebate book. As pegged, tethered, and under-watched markets multiply, the universe the desk's methods fit grows with them.

The concrete path from here: capture longer real order-book sessions and sweep per-pool calibrations to turn the single net-positive read into a distribution across coins and regimes; add the queued perpetual order books (dYdX v4, Drift, Bybit, OKX) for cross-venue basis and funding dispersion; bring funding fully into the carry book and the volatility book under its Greeks budget; generalize the pairs engine to Johansen N-leg baskets; and accrue forward paper track records on the survivor-safe equities basket and the funding carry alongside the market-making book. Each of these is an agent's task behind an existing seam, which is the point: the frontier widens at the speed of adding agents, not the speed of adding systems.

---

## 8. Why this is competitive

The individual results are deliberately modest, and stating them plainly is the strongest thing the desk can do. No single edge here is a money printer: the equity basket is thin, the crypto pairs are dead, the carry is real but small, and the market-making win is one window on one coin. A desk that can show you, with proof, where its strategies do not work is a better counterparty than one that shows a clean curve and hides the dozens behind it.

What is uncommon is the combination. A tested engine with real feeds, a live paper loop, queue-aware fills against real depth, and five-component P&L attribution, not a notebook. A validation standard that rejects its own operator's best ideas, with the null results on the record. An operating model that gives one person the parallel throughput and codebase-wide memory of a team, kept safe by interface seams and version control. A frontier with room, reachable at near-zero marginal cost as the universe expands. And a curriculum that makes every model auditable and stays current through the same agents that run the desk. Applied at the cost structure of a one-operator agentic desk, against markets the large shops under-watch, that combination is a position worth testing under real fills — and one that, with more agents, scales.

---

## 9. The ask

We paper-trade on real data by mandate, accruing forward track records with no look-ahead. The market-making book has reached the limit of what paper can prove: fill-on-touch is an upper bound, and even queue-aware replay on a captured tape is a model. We need a production environment and a trading partner — a shop, desk, or allocator willing to run the validated market-making book live and small on real fills at a maker-rebate venue, instrument the result, and feed it back into the gate.

A trial would run the tuned Hyperliquid book live and compare realized fills to the queue-aware prediction; run the survivor-safe equities basket and the funding-carry book forward in paper alongside it; and use the desk's own gate — out-of-sample, deflated, survivorship-aware, cost- and queue-realistic — as the shared acceptance standard. Until that partner exists we keep doing what the demonstration is built to do: discover new decentralized markets, keep the numbers accurate, and show steady, low-drawdown equity over hours and days. Everything in this brief is reproducible from the repository with public, no-key data, and we would welcome the chance to walk a reviewer through it, terminal and screen, live.

---

*Reproducibility: every figure is reproducible from the Meridian Markets repository using public APIs (Binance, Hyperliquid, GeckoTerminal, Alpaca paper, Yahoo). The chronological research log with per-run numbers and raw artifacts is the Quant Journal; the consolidated findings are in the Research Findings document; the venue rubric is the Data Sources ledger; the P&L accounting that underlies every number is the P&L Accounting reference.*
