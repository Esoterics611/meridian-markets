# 8. The Meridian desk stack — Hyperliquid, queue-aware fills, and per-pool tuning

!!! abstract "Where this chapter fits"
    **Feeds in from:** [§3 Avellaneda-Stoikov](03-avellaneda-stoikov.md) (the quoter whose σ we re-scale in [§8.3](#83-price-scale-invariance-make-the-quoter-agnostic-to-the-assets-price)), [§4 execution](04-execution.md) (the maker-rebate economics [§8.2](#82-the-default-venue-hyperliquid) and [§8.4](#84-venue-aware-fees-judge-each-book-at-its-own-venue) make concrete), and [§6 backtesting](06-backtesting.md) — the queue-position model [§6.3](06-backtesting.md#63-the-queue-position-model) promised is finally *driven by a real L2 tape* in [§8.5](#85-queue-aware-fills-stop-trusting-fill-on-touch).
    **Feeds into:** [§7 production](07-production.md) — the runbook in [§8.9](#89-the-desk-runbook-scan--capture--tune--launch--forward-paper) is the operational loop that produces the shadow-mode and min-capital numbers §7's ramp gates on.
    **What this chapter is:** the rest of the course is venue-neutral theory. This chapter is the **desk procedure** — the specific tools, knobs, and order-of-operations a quoter on *this* desk uses to take a market from "interesting" to a live paper book with honest P&L. Everything here is a thin operational layer over the math you already have; nothing here changes the math.
    **Read alone if:** you already know the theory and just need the operating manual. [§8.9](#89-the-desk-runbook-scan--capture--tune--launch--forward-paper) is the one-page version; the sections above it are the *why* behind each step.

## 8.1 Why this chapter exists

The first seven chapters teach a quoter that works on paper. Running it against *real* venues surfaced three gaps between the textbook and the desk — none of them in the math, all of them in the plumbing the math sits inside:

1. **The quoter silently assumed a ~$1 asset.** Avellaneda-Stoikov's spread and skew are written in price units. Code them literally and a $1,900 asset mis-scales the variance term by ~$10^6$ — the quote goes nonsensical (we once printed a *negative-quintillion* P&L on a WETH pool). The fix is to make the quoter **price-scale-invariant** ([§8.3](#83-price-scale-invariance-make-the-quoter-agnostic-to-the-assets-price)).
2. **One desk-wide fee assumption is dishonest.** A book on a maker-rebate CLOB and a book on a 30bps AMM pool have opposite economics. Judging both at a flat −1bps flatters the second and slanders the first. Each book must be priced at **its own venue's real maker fee** ([§8.4](#84-venue-aware-fees-judge-each-book-at-its-own-venue)).
3. **Fill-on-touch is a guess, not a fill.** [§6.2.1](06-backtesting.md#621-trade-tape-backtest-sanity-check-only) said it: assuming you fill whenever the tape trades through your price is the *upper bound*, not the truth. The desk now fills FIFO against a **real L2 depth tape** ([§8.5](#85-queue-aware-fills-stop-trusting-fill-on-touch)).

Each fix is small. Together they are the difference between a backtest that lies in your favour and one you can hand to the §7 ramp.

## 8.2 The default venue: Hyperliquid

The desk's **default market-making venue is Hyperliquid (HL)** — set in config (`marketMaking.defaultSource = 'hyperliquid'`, env `MM_SOURCE`), so a bare `POST /api/market-making/launch` quotes HL BTC with the GLFT quoter. Three properties, in priority order, are why:

- **It is a maker-*rebate* CLOB.** HL pays a passive maker **−0.2 bps** and charges a taker 2.5 bps. §4 spent a chapter on why rebate venues are the natural home for an inventory-aware quoter: the rebate is a floor under your edge, and a real central limit order book gives you genuine queue position (unlike an AMM, where there is no queue to hold). This is the **≤0bps-maker venue** the whole book has been pointing at — the one calibration where the spread you earn isn't immediately eaten by your own maker fee.
- **It publishes a real L2 book (20×20) over a no-key public endpoint.** That is the raw material for queue-aware fills ([§8.5](#85-queue-aware-fills-stop-trusting-fill-on-touch)). Most venues make you pay or authenticate for depth; HL gives it away.
- **It is perps, so it carries funding.** Funding is a carry leg the cost model can eventually price (still open — [§8.10](#810-what-is-still-honest-but-unfinished)). For now it is a reason the book is *not* delta-neutral by construction; watch inventory the same way §5 says.

**The adapter.** `HyperliquidClient` (`src/market-data/reference/hyperliquid-client.ts`) sits behind the same `IReferenceBarSource` seam every other data source does. HL's `info` endpoint is a **POST** (`candleSnapshot` for OHLCV, `l2Book` for depth), so the reference interface grew a `RefHttpPost` capability and an `IL2BookSource`; `parseHyperliquidCandles` and `parseHyperliquidL2` turn HL's string-OHLCV / `{px,sz,n}` payloads into the engine's neutral `Bar[]` and `L2Snapshot`. You do not call these directly — you select the source.

!!! note "Procedure — launch a book on HL"
    ```bash
    # default source is already hyperliquid; symbol/strategy overridable
    curl -XPOST localhost:3100/api/market-making/launch \
      -d '{"symbol":"ETH","strategyId":"mm-glft","quoteNotionalUsd":50000}'
    # or a named preset:
    curl -XPOST localhost:3100/api/market-making/launch-preset \
      -d '{"preset":"hl-perps","quoteNotionalUsd":50000}'
    ```
    `FEED_SOURCE` (the stat-arb spine) stays Binance — **HL is a per-book source, not the global feed**. The three Binance stablecoin MM presets pin `source:'binance'` so the HL default doesn't capture them.

## 8.3 Price-scale invariance: make the quoter agnostic to the asset's price

The bug: AS reservation price and half-spread are written in absolute price, and a naive port squares a micros-denominated price inside the variance term. On a $1 stablecoin you never notice; on a $1,900 perp the σ² term is off by ~$1,900^2$.

The fix lives in `asReservationMicros` / `asHalfSpreadMicros` (`src/market-making/quote/avellaneda-stoikov.ts`), now shared by **both** the AS and GLFT quoters. Two rules:

- **σ is kept a *return fraction*, not a price.** Volatility enters as a fraction of mid, so it is dimensionless.
- **Skew and half-spread are computed as fractions of mid against a fixed $1 reference scale**, then applied to the live mid.

The payoff: a given $(\gamma, \kappa, \sigma, q)$ produces the **same bps spread and skew at $1 or $1,900**. Two scale-invariance specs pin this; all eleven pre-existing quote specs still pass unchanged (at mid = $1 the new code is identical to the old by construction). Skew is clamped to ±0.5 (`MAX_SKEW_FRAC`) so a high-vol asset can never push a quote price negative.

!!! warning "What the trader must check"
    When you move a quoter onto a new asset, **σ must be supplied as a return fraction** (e.g. `0.02` for 2% per bar), never as an absolute price move. A quoter fed an absolute σ on a high-priced asset will quote far too wide and fill nothing — the failure is silent, the symptom is `fillRate ≈ 0`.

## 8.4 Venue-aware fees: judge each book at its own venue

`venueFeeFor(sourceId)` (`src/market-making/backtest/venue-fees.ts`) is the single source of truth for venue economics. Maker bps are **signed**: a negative number is a rebate (revenue), a positive number is a cost you must earn back on both legs before you are flat.

| Venue (`source`) | Maker | Taker | Note |
|---|---:|---:|---|
| `hyperliquid` | **−0.2 bps** | 2.5 bps | maker-rebate perp CLOB — the default |
| `binance` | +1 bps | +5 bps | spot base tier (VIP/BNB tiers lower; a VIP maker can reach a rebate — model via override) |
| `geckoterminal` | +5 bps | +5 bps | AMM LP fee, **pool-dependent** (1 / 5 / 30 / 100 bps); 5 = stable tier; no rebate exists on an AMM |
| *(unknown)* | 0 bps | 5 bps | structural-only default |

A passive (post-only) book only ever fills on the maker side, so **`makerBps` is the column that drives the fee charge** in the replay; `takerBps` is reserved for the flatten/hedge legs and for an honest worst-case read. The honest side-effect of wiring this: the Binance stablecoin demo now reports against the +1bps base-tier *cost*, not a flattering desk-wide rebate. That is the point — the number got less pretty and more true.

## 8.5 Queue-aware fills: stop trusting fill-on-touch

This is the single biggest fidelity upgrade in the stack, and it is the §6.3 queue model finally wired to real data. Fills are now computed **FIFO against a real Hyperliquid L2 depth tape** instead of assumed-on-touch. Three pieces:

1. **L2 ingest.** `HyperliquidClient.l2Snapshot` + `parseHyperliquidL2` pull HL's no-key `l2Book` (20×20) into a neutral `L2Snapshot`/`L2Level` type — kept a *structural copy* of microstructure's `OrderBook` so the market-data layer never imports market-making (the modular-monolith boundary holds).
2. **The replay harness.** `LobReplayHarness` (`src/market-making/backtest/lob-replay.ts`) walks an L2 tape, drives the **unchanged** `IQuoter` registry, and maintains FIFO **price-time-priority** queue position: cumulative resting size *at your price and better* is ahead of you (`l2-tape.ts`), and you fill only once aggressive flow consumes that queue. P&L is attributed through the **unchanged** `PnlAttributor` into the `InventoryBook` (the §6 four-component decomposition, untouched).
3. **The headline metric.** The harness reports **`queueFills` vs `touchFills`** — how badly fill-on-touch overstated. That ratio is the honesty check.

!!! note "Procedure — capture a tape and replay"
    ```bash
    # poll the live HL l2Book to build a REAL time-varying depth tape, then replay
    MM_L2_POLL_S=60 MM_L2_DURATION_MIN=120 MM_L2_SAVE_TAPE=tapes/eth.json \
      npx ts-node -r tsconfig-paths/register scripts/mm-l2-session.ts
    ```
    `mm-l2-session.ts` builds the tape from real depth, gates touches off real traded extremes, and — since the aggressor feed below — fills the queue with **real per-trade flow** from the HL trades WebSocket (the candle-volume estimate is kept only as a warmup fallback). The fee sweep prints structural / rebate / cost columns and the drawdown.

### 8.5.1 The aggressor feed: real taker flow, not a candle estimate

The L2 book tells you the *queue ahead of you*; it does not tell you the *aggressive flow that consumes it*. The queue-aware harness needs both. Originally the session estimated per-interval aggressive volume from the matching candle's volume, signed by the mid tick — and [§8.10](#810-what-is-still-honest-but-unfinished) flagged that as the binding approximation: a candle volume cannot resolve the top-of-book turnover that actually fills a passive maker, which is why every tuned combo filled 0.

That estimate is now replaced by **real per-trade prints**. Hyperliquid publishes trades only over a WebSocket (not the request/response `info` POST that serves candles and depth), so the reference interface grew a third transport seam — `RefWsFactory` / `MinimalWs`, injected exactly like `RefHttpPost` so the parse-and-accumulate logic is offline-testable against canned frames — and a third capability, `ITradeStreamSource`:

- `HyperliquidClient.openTradeStream(symbols)` derives `wss://…/ws` from the REST base and returns a live `HyperliquidTradeStream` (`src/market-data/reference/hyperliquid-trades.ts`). It subscribes to `trades` for each coin and folds every print into a per-coin accumulator, signing it by HL's taker `side` (`B` = aggressive buy that lifted the ask, `A` = aggressive sell that hit the bid).
- The session **drains** the accumulator once per L2 poll: `drain(coin)` returns the `AggressorFlow` since the last drain (taker buy/sell units, print count, **and the real traded high/low** over the interval — a sharper touch gate than the 1-minute candle) and resets the counters. A poll that saw real prints uses them; a poll that saw none (typically WS warmup) falls back to the candle estimate, and the report states the real-vs-estimate split honestly.

The transport is injected, so the parser (`parseHyperliquidTrades`) and the accumulator are unit-tested offline with a fake socket; live, a short session already shows ~75% of steps fed by real flow within the first minute. **This closes the last approximation in the queue-aware pipeline** — fills are now driven by real depth *and* real aggressor flow.

!!! note "Procedure — the aggressor feed is on by default"
    `mm-l2-session.ts` opens the trades stream automatically (`MM_L2_TRADES_WS=true`). Set `MM_L2_TRADES_WS=false` only in an environment with no WebSocket egress, to force the legacy candle estimate. Nothing else changes — the saved tape now simply carries real taker volume, so `mm-l2-tune.ts` sweeps over honest flow with no change.

!!! quote "The honest finding so far"
    At 1-minute OHLCV+depth granularity, a **top-of-book** quote (inside the spread, queue-ahead ≈ 0) fills about as often as fill-on-touch claimed — the ratio is ~1.0 because the top of book turns over fast. So the earlier fill counts were *not* badly overstated there; the loss was **adverse selection**, not phantom fills. The overstatement is dramatic only when you quote **into the stack** (e.g. 5 bps deep): there the cumulative book above you never clears, and queue-aware fills drop to **0** against ~21 touches. Lesson: fill-on-touch lies most exactly where you most want to believe it — on the wide, "safe" quotes.

## 8.6 Per-pool γ/κ tuning

A quoter's $\gamma$ (inventory aversion) and $\kappa$ (arrival decay) are not universal constants — the right pair depends on the pool's volatility, depth, and flow. `sweepGammaKappa` (`src/market-making/backtest/gamma-kappa-sweep.ts`) runs the **queue-aware** `LobReplayHarness` over a *fixed* tape for every $(\gamma \times \kappa \times \text{half-spread-floor})$ combo and ranks the results.

Two things make this honest:

- **It sweeps over the same captured tape**, so every combo is judged on identical flow — `l2-tape-io.ts` round-trips a tape to disk (exact bigint↔string, versioned) so you capture once and sweep many.
- **It rebuilds the quoter per combo.** GLFT and AS *bake* $\gamma,\kappa$ into the quoter at build time and ignore `ctx`, so the sweep must construct a fresh quoter for each combo via an injected `buildQuoter` — a sweep that only changed a context field would silently compare one calibration against itself.

`rankSweep` orders results **drawdown-compliant-first, then by maker-net at the venue's own fee** ([§8.4](#84-venue-aware-fees-judge-each-book-at-its-own-venue)). A combo that earns more gross but breaches the drawdown limit is demoted below a tighter, compliant one — risk discipline wins ties, as §5 demands.

!!! note "Procedure — sweep saved tapes for the winning calibration"
    ```bash
    npx ts-node -r tsconfig-paths/register scripts/mm-l2-tune.ts   # loads tapes/, sweeps, prints per-coin winner
    ```
    Output per coin: the winning $(\gamma, \kappa, \text{floor})$, its `queueFills`/`touchFills`, maker-net at the venue fee, and whether it stayed inside the drawdown band.

## 8.7 Notional sizing: quote in dollars, not units

A naive "8-lot" cap means 8 *units* — fine for a $1 stablecoin, catastrophic for a $66k perp (you'd quote $528k of BTC per lot). `quoteUnitsForNotional(notionalUsd, price, fallbackUnits)` (`src/market-making/live/notional-sizing.ts`) turns a **dollar** quote size into asset units at the live price: `units = round(notionalUsd / price × 1e6)`. The live control plane (`/api/market-making/launch[-preset]`) now accepts `quoteNotionalUsd` and the book factory probes the live price to size each quote; omit it and the old fixed-unit behaviour is preserved. The session and tuning harnesses already used this lever (`MM_SESSION_QUOTE_USD`); the live plane now matches.

!!! warning
    Always launch a non-stablecoin book with `quoteNotionalUsd`, never a raw unit cap. A unit cap on a high-priced perp over-sizes the book by a factor of its price.

## 8.8 The discovery frontier: DEX as a scan-and-quote source

The desk's growth edge is **market discovery** — new, especially decentralized, markets to make. `GeckoTerminalClient` (`src/market-data/reference/geckoterminal-client.ts`) pulls real DEX OHLCV across 100+ chains behind the same `IReferenceBarSource` seam, and a DEX pool is a **first-class live paper MM book** (`source:'geckoterminal'`, e.g. the `dex-eth-bluechip` preset: WETH/USDC, WETH/USDT, WBTC/WETH, USDC/USDT across eth + base). The same `ReferenceBarFeed` routing that makes HL quotable makes a Uniswap-v3 pool quotable.

!!! danger "DEX honesty caveats — read before quoting a pool"
    - **The wide DEX spread is hazard compensation, not free money.** MEV, sandwiching, and thin pools mean the extra spread is paying for real adverse selection. Treat it as the §2 adverse-selection component, widened — not as edge.
    - **An AMM has no maker rebate and a pool-dependent LP-fee *cost* (1/5/30/100 bps).** A 30bps pool must clear a far higher bar than HL's −0.2bps rebate. This is why HL, not a DEX, is the *default* venue — the DEX is the frontier to *explore*, not the place to put size first.
    - **Survivorship, cost, and fill-on-touch discipline all still apply.** Live reads on DEX pools to date are net-negative at honest fills — the path works and the P&L is honestly attributed; the loss is the lesson.

## 8.9 The desk runbook: scan → capture → tune → launch → forward paper

The end-to-end loop a quoter runs on this desk. Each step maps to a chapter; this is the order.

1. **Scan** for candidate markets across sources (`/api/market-making/screen`, source-aware). Rank by spread-vs-volatility, not spread alone.
2. **Capture a real L2 tape** on the candidate (`mm-l2-session.ts` with `MM_L2_SAVE_TAPE`). A short poll is a smoke test; a multi-hour 60s-poll is the real read.
3. **Tune** $\gamma,\kappa$ over the saved tape (`mm-l2-tune.ts`). Take the drawdown-compliant winner at the venue's own fee — **not** the highest-gross combo.
4. **Sanity-check the fee math.** Confirm `venueFeeFor(source)` is the venue you think it is, and that the net column uses `makerBps`, not a flat assumption.
5. **Launch a live paper book** with `quoteNotionalUsd` (never a unit cap) and the tuned calibration. Watch `fillRate`, inventory, and the four-component P&L per §5/§6.
6. **Run it forward for hours/days.** The deliverable is a **steady, low-drawdown equity curve on live paper data** — that, not a long-window backtest, is the verdict. Feed the shadow-mode fill rate back into §7's ramp gates.

The non-negotiable from §6.1 still binds: backtest → tape-capture/queue-aware replay → forward paper, in that order. The queue-aware harness ([§8.5](#85-queue-aware-fills-stop-trusting-fill-on-touch)) is what makes the middle step honest enough to trust.

## 8.10 What is still honest-but-unfinished

The discipline of this course is to name the gaps. As of this writing:

- **The per-pool *verdict* is still 0-fill on candle-estimated flow — now confirmed at 60s polls, not just inferred.** The tuning *machinery* is proven (unit tests pin the differentiation, ranking, fee model, and tape round-trip), and we ran it for real: a **37-step, 60-second-poll capture across HL BTC/ETH/SOL** swept through all 48 $(\gamma\times\kappa\times\text{floor})$ combos per coin and every one filled **0** (`queueFills = 0`, so maker-net `+0.00`, drawdown `0.000%`). That sharpens the diagnosis — the earlier 5-second-prorated 0-fill was not a prorating artifact; the binding limit is that **candle-derived aggressive volume cannot resolve the top-of-book turnover that actually fills a passive maker**, so the cumulative queue never clears in simulation. The sweep correctly applied HL's −0.2bps maker fee, so the question it was built to answer — does the rebate make *any* calibration net-positive on honest fills — **could not be answered from candle-volume tapes at all**. That is why the aggressor feed in the next bullet was the real unblock; the open item now is to **re-capture a long session with real flow and re-sweep**, not to re-run the candle estimate.
- **Aggressor flow is now real (✓ wired) — the remaining work is to run the long capture on it.** The candle-volume estimate has been replaced by the HL trades WebSocket: `HyperliquidClient.openTradeStream` feeds real per-trade taker flow (and real traded extremes) into the tape ([§8.5.1](#851-the-aggressor-feed-real-taker-flow-not-a-candle-estimate)), on by default in `mm-l2-session.ts`. This closes the last approximation in the queue-aware pipeline. What's left is operational, not architectural: run a multi-hour 60s-poll capture so the tape carries enough *real* aggressive flow to clear a queue, then re-run `mm-l2-tune.ts` — that, finally, is the honest per-pool verdict on whether HL's −0.2bps rebate nets positive.
- **Funding carry — now sourced, priced, AND accrued on held inventory (✓); the live *paper* book is the last mile.** HL perps pay/charge funding hourly, and that flow accrues on whatever inventory the MM book holds. Three pieces landed: (1) `HyperliquidFundingClient` (`IFundingRateSource` over the HL `info` POST — hourly `fundingHistory` + `metaAndAssetCtxs`) and `staticCarry` generalised to a venue `periodsPerYear` (HL = 8760), with `scripts/funding-carry-research.ts FC_SOURCE=hyperliquid` pricing the stream (15-day read: ETH ≈ 8.1%/yr, BTC ≈ 4.5%/yr, funding persistently positive); (2) the **queue-aware harness now accrues funding as a 5th P&L line** — `LobReplayConfig.fundingRatePerHour` accrues −(signed inventory notional)·rate·Δt each step, folded into both the equity/drawdown mark and the net, default-off for back-compat; (3) `mm-l2-session.ts` reads the live hourly rate per coin at startup and reports `structural + funding` and a funding-inclusive conservation verdict. So the session equity curve now includes carry, not just spread − adverse − fees. **The last mile is the live *paper* `MmBook`** (`/api/market-making`), which still books only trading P&L — wiring the same accrual there makes the forward paper track record's curve funding-complete.

None of these is a reason not to run the stack — they are the difference between "this works on honest depth *and* honest flow" (where we are) and "we know the per-pool number cold" (where the long capture takes us).
