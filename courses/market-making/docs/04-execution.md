# 4. Execution & queue position

!!! abstract "Where this chapter fits"
    **Feeds in from:** [§2 microstructure](02-microstructure.md) — the limit-order book, maker/taker mechanics, and tick/lot granularity from §2 are the vocabulary every section here uses without redefining; [§3 Avellaneda–Stoikov](03-avellaneda-stoikov.md) — A-S decides *what* to quote (reservation price, half-spread), this chapter decides *how* the quote actually lands on the venue, stays alive on the venue, and turns into a fill.
    **Feeds into:** [§5 risk](05-risk.md) — the execution layer is downstream of the risk layer (same wiring discipline as the stat-arb course's §4 → §5 hand-off); [§6 backtesting](06-backtesting.md) — a backtest that doesn't model queue position (§4.4–§4.5) or rate limits (§4.3, §4.9) lies by a factor of ten about fill rates.
    **Code shape:** [Appendix A — code shapes](appendix-a-code-shapes.md) for the swap-seam pattern (`IVenue`), the rate-limited scheduler skeleton, and the order-book reconstruction sketch.

A statistical arbitrageur sends a handful of orders a day; an electronic market maker sends millions. That gap of four orders of magnitude in order rate is the reason this chapter exists as its own discipline. Once you are placing thousands of orders an hour, every property of the execution path that the stat-arb course treats as an implementation detail — rate limits, queue position, cancel-replace latency, order-book reconstruction — becomes load-bearing. Get them wrong and the strategy doesn't fill, fills late, fills against information, or gets the API key banned.

The A-S layer from §3 produces a *quote* — a bid price, an ask price, a size on each side. This chapter is about everything between "the quote is decided" and "the inventory has changed because somebody hit us."

## 4.1 The order lifecycle for a market maker

Every quote update follows the same path. The path has more hops than a stat-arb entry has, because a market maker's order is *resting* on the book and the venue's behaviour towards a resting order is itself a system that has to be modelled.

```mermaid
sequenceDiagram
  autonumber
  participant S as Strategy<br/>(A-S quoter)
  participant Q as QuoteScheduler
  participant R as SOR / OrderRouter
  participant V as Venue (Binance/OKX/…)
  participant B as LocalBook<br/>(reconstructed)

  S->>Q: emit desired bid/ask (price, size)
  Q->>Q: rate-limit gate<br/>(skip if too soon)
  Q->>R: place post-only limit
  R->>V: REST POST /order (post-only=true)
  V-->>R: ack {orderId, status=NEW}
  V-->>B: book delta (your order at level L)
  Note over B: queue position p₀ = Σ sizes ahead of you on level L
  V-->>B: more book deltas as others trade<br/>(your p decays)
  S->>Q: mid moved → new desired quote
  Q->>R: cancel-replace decision (§4.3)
  alt within band
    Q->>Q: keep resting order; no cancel
  else outside band
    R->>V: REST DELETE /order/{orderId}
    V-->>R: ack {canceled}
    R->>V: REST POST /order (new price)
    V-->>R: ack {new orderId}
    Note over B: queue position resets to back-of-queue
  end
  V-->>R: WS fill event {orderId, qty, price, fee}
  R-->>S: fill notification
  S->>S: inventory += filled size<br/>recompute reservation price
```

Every arrow in that diagram is a latency hop, and every latency hop is a risk. Catalogue them:

1. **Strategy → Scheduler.** In-process. Microseconds. Free.
2. **Scheduler → Router.** In-process. Microseconds. Free.
3. **Router → Venue (REST place).** Network. **The first expensive hop.** From a non-co-located VPS in the same region as the venue (e.g. AWS Tokyo for Binance Japan endpoint), 5–15 ms round-trip. From a laptop on a residential connection, 50–300 ms. From co-location, 100 µs.
4. **Venue match-engine processing.** Inside the venue. 10 µs to 1 ms depending on venue load. You cannot influence this; you only observe its tail.
5. **Venue → Router (ack).** Same network class as 3.
6. **Venue → LocalBook (WS feed).** Separate channel, separate latency. The book-update stream is typically faster than the REST ack but not always.
7. **Mid-move detection → cancel-replace decision.** In-process — but the input to it is the WS feed (hop 6) for everyone else's orders, plus your own ack (hop 5) to know you've actually got a resting order to cancel.
8. **Router → Venue (REST cancel).** Same as 3.
9. **Router → Venue (REST place new).** Same as 3.
10. **Venue → Router (fill notification).** Pushed over WS or polled. WS is the only realistic choice for a market maker; polling adds another 100–1000 ms of latency that you cannot afford.
11. **Fill → Strategy.** In-process.

The end-to-end round-trip for a single cancel-replace under realistic non-co-located conditions is roughly 2× the network RTT plus a few milliseconds of in-process overhead. On a 30-ms RTT that is ~60 ms per quote update; on a 300-ms residential link it is ~600 ms per update. **A market making strategy whose quotes are stale by 600 ms is, by construction, picking up every information event and filling adversely** — the people on the other side of your trades have seen the mid move before you did. This is the basis for the latency budget in §4.8.

## 4.2 Post-only orders, and why a market maker uses nothing else

A *post-only* order (also called "maker-only" or "ALO — add liquidity only" on some venues) is a limit order with a hard constraint: **if the order would cross the spread at the moment it arrives at the venue, the venue rejects it instead of executing it.** It is the only order type a market maker should ever submit.

The reasoning is mechanical. A market maker's edge is the *spread* — the bid–ask difference, captured by buying at the bid and selling at the ask. The fee schedule on every major CEX is structured so that resting orders earn a *rebate* (or pay a much smaller fee) and taking orders pay a much larger *fee*. The numbers in §4.6 will make this concrete; for now, the qualitative point is that a market maker accidentally crossing the spread converts a positive-expected-value trade (capture the spread, earn the rebate) into a negative-expected-value one (pay the spread, pay the taker fee). One accidental taker fill per hundred maker fills can wipe out a day's edge.

The accidental cross happens for one of two reasons:

1. **The book moves between when you compute the quote price and when the order arrives at the venue.** You computed bid = 99.95 based on the local book; by the time the order lands, the best ask has dropped to 99.94. Your "limit buy at 99.95" is now marketable and takes the 99.94 ask.
2. **Your local book is stale or reconstructed wrong** (§4.10). You think the best ask is 100.00; it is actually 99.96. Same outcome.

Without post-only protection, both failure modes silently convert the maker fee to the taker fee. With post-only, the venue rejects the order, the strategy notices the rejection, and the quote scheduler tries again at a price one tick lower. The cost of the rejection is the round-trip latency of one REST call plus the opportunity cost of the missed level — almost always cheaper than the cost of the cross.

**Venue support.** Binance Spot supports post-only via the `timeInForce=GTX` flag (`GTX` = Good Till Crossing). Binance USDM Futures supports it via `timeInForce=GTX` or the more recent `postOnly=true` field on the `/fapi/v1/order` endpoint. OKX supports it as `ordType=post_only`. Coinbase Advanced Trade supports it as `post_only: true` on the limit-order request. Bybit, Kraken, Bitstamp, and Bitfinex all support it under various flag names. Deribit supports it. The handful of venues that don't natively support post-only (a few smaller spot venues, some perp DEXs in their first iterations) are not venues a real market maker should be deploying capital on — you have no way to enforce maker-only behaviour and your fee bill will eat the strategy.

If you find yourself wanting to deploy on a venue without post-only support, the only honest mitigation is to keep the quote pulled in by one extra tick from the touch (so it cannot be marketable even if the book moves a tick), and to model the cost of the occasional accidental cross explicitly in the backtest's cost function. Both are unsatisfying band-aids on a missing feature.

## 4.3 The cancel-replace decision

The naive market-making loop is: every time the mid moves, cancel the existing quote and replace it at the new mid ± half-spread. The naive loop dies for two reasons in §4.11 (rate-limit ban and queue-position thrash). The serious question is *under what condition do you cancel-and-replace*, and the answer is one of three policies, each appropriate to a different rate-limit / latency regime.

### Policy 1 — always cancel-replace on mid move

You re-quote on every mid update. This is the textbook A-S strategy and it is correct under exactly two conditions: (a) you are co-located with the venue and your REST cancel-replace round-trip is well under the typical inter-tick time; (b) the venue's rate limits comfortably exceed your update rate.

Outside those conditions — i.e. for everyone reading this course — Policy 1 burns rate-limit budget faster than you generate alpha. Binance Spot's default REST rate limit is 1200 weight per minute and an order place is weight 1 and a cancel is weight 1, so you have ~600 cancel-replaces per minute or one every 100 ms — *if you do nothing else*. The first time the mid ticks faster than 10 times per second (which on BTC/USDT is most of the time), Policy 1 hits the rate limit, the venue returns 429s, and after enough 429s the venue applies an IP ban for a few minutes. You stop quoting and lose money on the inventory you can't unwind. This is the failure mode in §4.11(1).

### Policy 2 — the band quoter

You re-quote only if the quote drifts outside a tolerance band around the mid. Formally: maintain a current resting bid at $b$ and ask at $a$ around the prevailing mid $m_0$ at quote-time. As the mid moves to $m_t$, do nothing until

$$
|m_t - m_0| > \tau
$$

for some band width $\tau$. The band width is calibrated to the volatility of the mid and the cost of being stale: too narrow and you re-quote constantly; too wide and you sit with a stale quote and get adversely filled. A defensible starting point is $\tau \approx \frac{1}{2} \sigma_{1s}$ where $\sigma_{1s}$ is the realised one-second standard deviation of the mid — meaning you re-quote on roughly a one-sigma move of the mid, which keeps the re-quote rate manageable but doesn't leave you exposed to drift much beyond your quoted spread.

Policy 2 is the right default for a retail-API market maker. It cuts the cancel rate by an order of magnitude versus Policy 1 and pays for it with a slightly higher adverse-selection rate. The adverse selection cost is real but bounded; the rate-limit ban is unbounded.

### Policy 3 — hierarchical / layered quoting

You maintain multiple resting orders at different levels — a tight quote near the touch, a wider quote one or two ticks back, and possibly more levels behind those. As the mid moves, you do *not* cancel-replace the tight quote; you simply let the mid pass through it, the second-level quote becomes the new tight quote, and you place a fresh order at the back of the ladder. This converts "cancel-replace on every move" into "place one new order on each significant move," which roughly halves the rate-limit consumption versus Policy 2 and — critically — preserves queue position on the existing orders.

Policy 3 is what serious production market-making systems run. The implementation cost is real (ladder bookkeeping, partial-fill accounting per level, careful inventory management when the mid sweeps multiple levels), but the rate-limit and queue-position benefits are decisive once your strategy is paying for itself.

A useful rule of thumb for which policy fits which deployment:

| Deployment | Cancel-replace round-trip | Rate-limit headroom | Use |
|---|---|---|---|
| Co-located prop, FIX | 100 µs – 1 ms | High (purpose-built) | Policy 1 (re-quote on every tick) |
| AWS in-region, REST | 5–15 ms | Moderate | Policy 2 (band quoter), tight band |
| AWS in-region, layered | 5–15 ms | Moderate | Policy 3 (layered quoting) |
| Residential / VPS abroad | 50–300 ms | Low | Policy 2 (band quoter), wide band |
| Laptop on Wi-Fi | 200–1000 ms | Low | Don't market-make. Stat-arb instead. |

## 4.4 Queue position — the variable that dominates passive fill rate

The single biggest determinant of how often a passive (maker-only) order fills is *queue position*: how many other orders, in total size, sit ahead of yours at the same price level. Backtests that ignore this overstate fill rates by an order of magnitude — usually more — and consequently overstate strategy P&L by a similar factor. This is one of the four execution failure modes in §4.11, and it is the most common.

**Why queue position matters.** When a taker hits price level $L$ on the ask side, the venue's match engine consumes orders at $L$ in *time priority* (FIFO). The first order placed at $L$ fills first; the last placed fills last. If your order joined level $L$ when the total size already resting at $L$ was $p_0$ (the *initial queue position*), then *every other order at* $L$ *placed before yours must either fill or cancel before yours starts filling.* Until that happens, your order is invisible to incoming takers.

**Formal model.** Let $p(t)$ be the size remaining ahead of your order at time $t$, with $p(0) = p_0$. The queue ahead drains for two reasons:

- **Trades ("cancellation-by-fill").** A taker arrives and consumes $\Delta s$ of the front of the queue. The portion of $\Delta s$ that lands ahead of your order reduces $p(t)$.
- **Cancellations ahead.** A trader ahead of you in the queue cancels their order. Their size leaves the queue without trading, and $p(t)$ drops by their size with no fill for you.

The *queue-drain hazard rate* $h(t) = -\frac{d p(t)}{p(t) dt}$ aggregates both. Empirically, on liquid top-of-book CEX markets, $h$ is on the order of a few percent per second; concretely, $p(t)$ halves in 5–30 seconds at the top of book on liquid pairs and much faster as the mid approaches your level.

**Cont, Stoikov, and Talreja (2010)** model this directly in their stochastic-order-book paper: they assume Poisson arrival of market orders, limit orders at each level, and cancellations at each level, and derive a closed-form expression for the probability that a limit order placed at depth $d$ executes before a price move makes it irrelevant. The qualitative result is the one any operator learns within a week: **your fill probability is a steeply decreasing function of your initial queue position $p_0$**, with the steepness modulated by the trade arrival rate and the cancellation rate on the level.

**Why cancel-replace is catastrophic for queue position.** When you cancel your order at level $L$ and replace it at the same level $L$ one millisecond later, the venue gives you a *new* order ID and places you at the *back* of the FIFO queue at $L$. The initial queue position resets from $p(t_{\text{cancel}})$ (which may have decayed close to zero) to $p_0' = $ everything currently at $L$ — likely *larger* than $p_0$ because the level has been refilled in the meantime. **Your expected time-to-fill is now the entire queue ahead of you, again.** This is why Policy 3 (layered quoting) is such a decisive win over Policy 2 for serious systems: it cancels at most one level per move, and leaves the queue-position-bearing orders in place.

A concrete example. Suppose you have a resting bid at level $L$ that has been sitting for 8 seconds, during which the queue has drained from $p_0 = 50$ units to $p(8\text{s}) = 4$ units. A taker hits the bid; the four units ahead of you fill, then you fill. Now suppose instead that the mid ticked up two seconds in, you re-quoted at the same level for some reason, and your new $p_0' = 60$ (the level filled in behind you while you weren't looking). The same taker arrives; this time 60 units in front of you fill before your order even starts to fill. The first scenario gives you a fill; the second gives you none. Same external event; different queue history; opposite P&L.

## 4.5 Estimating fill probability

The standard formulation, following CST10 and the survey treatments that build on it, models the time-to-fill as the first-passage time of a hazard process. If $h(s)$ is the instantaneous fill hazard rate at time $s$ — combining queue drain, level refresh, and trade arrival — then the probability your order fills before time $t$ is:

$$
P(\text{fill before } t) = 1 - \exp\!\left(-\int_0^t h(s)\, ds\right)
$$

The simplest tractable case is $h(s) = h$ constant, giving the exponential survival function $P(\text{no fill by } t) = e^{-ht}$ and an expected time-to-fill of $1/h$. Empirical $h$ on liquid top-of-book CEX pairs is roughly $0.05$–$0.5$ per second, depending on level depth and instrument — so expected fill times of 2 to 20 seconds for an order sitting at the touch in a liquid market. For an order placed *behind* the touch (depth $d > 0$ ticks from the best), $h$ falls off rapidly with $d$, on the order of a factor of 2–5 per tick of depth in normal conditions.

A more honest model parameterises $h$ by the queue state explicitly:

$$
h(s) = \alpha \cdot \frac{\lambda_{\text{trade}}(s)}{p(s)}
$$

where $\lambda_{\text{trade}}(s)$ is the instantaneous arrival rate of taker volume against your level and $p(s)$ is your residual queue position. The factor $\alpha \in (0,1]$ corrects for the fact that not all incoming taker volume reaches your level (some is consumed by orders ahead of you that are themselves canceled out before the taker arrives — *cancel-and-replace shuffling* changes who exactly takes the next fill). Calibrating $\alpha$ against realised vs predicted fill times is a sensible piece of the execution-research loop in §6.

**The operational consequence.** If your strategy assumes $h$ in backtest that is calibrated from "your order would have filled whenever a trade prints at your level", you overstate $h$ by a factor of $1/\alpha \cdot p_0 / \bar{p}$ — easily an order of magnitude. The fill rate in the backtest is then 10× the real fill rate, the inventory turnover in the backtest is 10× real, and the modelled P&L is 10× real. This is the §4.11(3) failure mode; it is responsible for more dead strategies than any other single issue in market making.

## 4.6 Maker rebates vs taker fees

The fee schedule is the *direct* P&L lever for a market maker — every fill is either a rebate received or a fee paid, and the differential between them is what makes maker-only quoting structurally profitable in expectation. Concrete numbers, as of late 2025:

| Venue (top-tier / VIP) | Maker | Taker |
|---|---|---|
| Binance Spot, default | 0.1% (10 bps) | 0.1% (10 bps) |
| Binance Spot, VIP 9 + BNB | -0.005% (–0.5 bps) | 0.022% (2.2 bps) |
| Binance USDM Futures, VIP 0 | 0.02% (2 bps) | 0.05% (5 bps) |
| Binance USDM Futures, VIP 9 | -0.005% (–0.5 bps) | 0.017% (1.7 bps) |
| OKX Spot, VIP 8 | -0.005% (–0.5 bps) | 0.015% (1.5 bps) |
| Coinbase Advanced, base | 0.4% (40 bps) | 0.6% (60 bps) |
| Coinbase Advanced, top tier | 0% | 0.05% (5 bps) |
| Hyperliquid, high-volume MM | -0.002% (–0.2 bps) | 0.045% (4.5 bps) |

The pattern: at default retail tiers, maker and taker fees are similar — maker-only quoting is barely better than taking. At higher tiers, maker becomes a *rebate* (negative fee) and taker stays positive. **The economic model of professional market making requires reaching the rebate tier** on your venue, which means a non-trivial volume commitment. A market maker doing $10M/day on Binance USDM is at VIP 1–2; serious MM operations live at VIP 6+ where the rebate is real.

**Net spread captured per round-trip.** A round-trip for a market maker is: place bid, get filled, place ask, get filled. (Or the symmetric version on the other side: place ask, get filled, place bid, get filled.) The realised P&L from one round-trip is:

$$
\text{net} = \underbrace{(p_{\text{ask}} - p_{\text{bid}})}_{\text{quoted spread}} - \underbrace{2 \cdot f_{\text{maker}}}_{\text{maker fee on each leg}}
$$

where $f_{\text{maker}}$ is *signed* — positive if you pay a fee, negative if you earn a rebate. For a top-tier VIP earning $-0.5$ bps maker, the second term is $2 \cdot (-0.5) = -1$ bp, i.e. the fees *add* 1 bp to your gross spread captured. For a default retail tier paying $+10$ bps maker, the second term is $+20$ bps subtracted from your spread — meaning your quoted spread has to exceed 20 bps just to break even on fees, which on BTC/USDT is many times the natural spread and means there's no business to do.

This is why retail market making on default-tier accounts is structurally unprofitable on the liquid CEX pairs everyone wants to quote: the realised spread is smaller than the fee cost of capturing it. You either fight your way up the VIP ladder or you find less competitive instruments where the spread is wide enough to cover the retail fee.

## 4.7 The venue abstraction

Same swap-seam pattern the rest of the codebase uses (and the rationale documented in [Appendix A](appendix-a-code-shapes.md)): an interface, a deterministic mock (`PaperVenue`) that is the default, and one or more real implementations (`BinanceVenue`, `OkxVenue`, …) that are dormant until configuration flips. This keeps every unit test and every paper-trading run independent of network and of venue state.

```typescript
// execution/venue.interface.ts
export const VENUE = Symbol('VENUE');

export interface PlaceOrderRequest {
  symbol: string;             // 'BTCUSDT'
  side: 'buy' | 'sell';
  sizeUnits: bigint;          // base asset, integer units (6-dp)
  limitPriceMicros: bigint;   // quote per base, integer micros
  postOnly: true;             // market makers only ever post-only (§4.2)
  clientOrderId: string;      // idempotency key
}

export interface AmendOrderRequest {
  clientOrderId: string;
  newLimitPriceMicros?: bigint;
  newSizeUnits?: bigint;
}

export interface OrderAck {
  venueOrderId: string;
  clientOrderId: string;
  status: 'NEW' | 'REJECTED_POST_ONLY' | 'REJECTED_RATE_LIMIT' | 'REJECTED_OTHER';
}

export interface FillEvent {
  venueOrderId: string;
  clientOrderId: string;
  filledSizeUnits: bigint;
  fillPriceMicros: bigint;
  feeUnits: bigint;            // signed: negative if rebate
  isMaker: boolean;
  timestampMs: number;
}

export interface IVenue {
  readonly venueId: string;

  placeOrder(req: PlaceOrderRequest): Promise<OrderAck>;
  cancelOrder(clientOrderId: string): Promise<void>;
  amendOrder(req: AmendOrderRequest): Promise<OrderAck>;

  // Push channel; implementation is venue-specific (WS for Binance, etc.).
  onFill(handler: (ev: FillEvent) => void): void;
  onBookUpdate(handler: (delta: BookDelta) => void): void;
}
```

The `PaperVenue` simulates fills against a real or synthetic book, charges modelled fees, enforces post-only by rejecting orders that would cross, and is what every backtest and paper-trade run uses. The `BinanceVenue` (and equivalents) wraps the venue REST + WS APIs and is dormant until `EXECUTION_MODE=live` + `LIVE_TRADING_ARMED=true` (the engineering arm switch documented in the project root's `CLAUDE.md` §1 and §7).

```typescript
// execution/paper-venue.ts
@Injectable()
export class PaperVenue implements IVenue {
  readonly venueId = 'paper';
  private readonly book: ILocalBook;
  private readonly fillHandlers: Array<(ev: FillEvent) => void> = [];

  async placeOrder(req: PlaceOrderRequest): Promise<OrderAck> {
    if (this.wouldCross(req)) {
      return { venueOrderId: '', clientOrderId: req.clientOrderId, status: 'REJECTED_POST_ONLY' };
    }
    const venueOrderId = this.book.addResting(req);
    return { venueOrderId, clientOrderId: req.clientOrderId, status: 'NEW' };
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    this.book.cancelByClientOrderId(clientOrderId);
  }

  async amendOrder(req: AmendOrderRequest): Promise<OrderAck> {
    // Amend on Binance is cancel-then-place under the hood; mirror that here
    // so the backtest's queue-position reset matches live behaviour (§4.4).
    await this.cancelOrder(req.clientOrderId);
    const placed = this.book.peekResting(req.clientOrderId);
    return this.placeOrder({ ...placed, ...req });
  }

  onFill(handler: (ev: FillEvent) => void): void {
    this.fillHandlers.push(handler);
  }
  // ...
}
```

```typescript
// execution/binance-venue.ts (dormant until configured)
@Injectable()
export class BinanceVenue implements IVenue {
  readonly venueId = 'binance';
  async placeOrder(req: PlaceOrderRequest): Promise<OrderAck> {
    if (!this.armed) throw new VenueNotArmedError('binance');
    const body = {
      symbol: req.symbol,
      side: req.side.toUpperCase(),
      type: 'LIMIT',
      timeInForce: 'GTX',          // post-only — §4.2
      quantity: this.formatSize(req.sizeUnits),
      price: this.formatPrice(req.limitPriceMicros),
      newClientOrderId: req.clientOrderId,
    };
    const res = await this.signedPost('/api/v3/order', body);
    return this.parseAck(res);
  }
  // cancelOrder, amendOrder, onFill (WS user-data stream), onBookUpdate (WS book stream)
}
```

The point of keeping `amendOrder` on the interface even though it is implemented as cancel-then-place on every venue I know of is to make the **queue-position cost of amend visible at the API boundary** — the strategy and scheduler treat amend as a cancel-replace for the purposes of queue-position accounting, which is the honest model.

## 4.8 Latency budget

A complete latency budget for one *quote update* (mid moves → new quote resting on book) under a few realistic deployments:

| Hop | Co-located prop (µs) | AWS in-region (ms) | VPS abroad (ms) | Laptop residential (ms) |
|---|---:|---:|---:|---:|
| Strategy → Scheduler | 1 | 0.01 | 0.01 | 0.05 |
| Scheduler decision (band check) | 1 | 0.01 | 0.01 | 0.05 |
| Router → Venue (cancel) | 5 | 3 | 30 | 80 |
| Venue match-engine (cancel) | 5 | 0.5 | 0.5 | 0.5 |
| Venue ack (cancel) | 5 | 3 | 30 | 80 |
| Router → Venue (place) | 5 | 3 | 30 | 80 |
| Venue match-engine (place) | 10 | 0.5 | 0.5 | 0.5 |
| Venue ack (place) | 5 | 3 | 30 | 80 |
| **Total per update** | **~40 µs** | **~13 ms** | **~120 ms** | **~320 ms** |

A few load-bearing observations:

- **The latency is dominated by the network hops to and from the venue**, not by any compute. Optimising the strategy's compute path from 1 ms to 100 µs buys you nothing if the network hop is 30 ms. Optimising the network — closer region, persistent HTTP/2 connection, WS for cancels where the venue supports it — is the only thing that matters until co-location.
- **A 320-ms update budget means the mid has moved during your update.** At 5 mid-ticks per second (BTC during a calm session), the mid moves ~1.5 ticks during the round-trip. Your "new" quote arrives at the venue already stale by ~1.5 ticks. You compensate by either (a) quoting wider so a 1.5-tick stale quote is still safe, or (b) accepting more adverse selection.
- **If you cannot compete on latency, compete on quote intelligence.** This is the operational consequence of the budget. A retail-API market maker quoting BTC/USDT against co-located props will lose every adverse-selection race. The only viable strategy is to (a) quote wider than the props so you don't fight them for fill at the touch, (b) hold inventory longer (which the A-S framework formalises through the inventory-aversion term in §3), and (c) **quote only when your information is fresh** — pull the quote when you can't tell whether your view is current. This is the same logic as the "passive entries on stat-arb" reasoning in the sister course: when speed is not your edge, patience is.

## 4.9 Quote scheduling

The scheduler's job is to convert a stream of *desired quotes* from the A-S layer into an actual stream of REST calls to the venue, subject to the rate-limit and band-quoter constraints from §4.3. It exists for three reasons.

**Reason 1: rate limits.** Every venue has a hard cap on order-placement and order-cancellation requests per unit time. Binance Spot: 50 orders / 10s and 1200 weight / minute. OKX: 60 orders / 2s per instrument. Coinbase Advanced: 30 orders / second per portfolio. Exceeding these returns 429s, then short bans, then long bans. The scheduler must deterministically refuse to emit a request that would breach the limit, even if the strategy is screaming for one.

**Reason 2: jitter cost.** Re-quoting every microstructure tick creates a high-frequency stream of cancel-replaces that costs rate-limit budget and queue position without proportional alpha. The marginal value of re-quoting at the 10th tick after a 1 bp mid move is essentially zero; you're far better off batching that into one re-quote at the 1 bp band crossing. The band quoter (Policy 2 from §4.3) lives inside the scheduler.

**Reason 3: marginal value of update.** Some updates are higher-value than others. A mid move that crosses your inventory-skew band (i.e. you're now significantly long or short and want to lean your quotes) is a high-value update. A mid move within your dead-band that doesn't change your reservation price is a near-zero-value update. The scheduler can score updates and preferentially emit the high-value ones when rate budget is tight.

A minimal scheduler signs four contracts: rate limiting, band quoting, value-aware prioritisation, and idempotent re-issue on transient failure. Skeleton in §4.12.

## 4.10 Order-book reconstruction

The venue does not give you "the order book." It gives you a stream of *book updates* — incremental deltas (add level, remove level, change size at level) and occasionally full snapshots. To know your queue position at level $L$ you must locally reconstruct the book by replaying every delta in order from a snapshot. **The reconstructed book is your only source of truth for queue position**, and any drift between your reconstruction and the venue's actual book translates directly into the §4.11(4) failure mode.

The mechanics, in three steps:

1. **Subscribe to the book-update stream** (Binance: `<symbol>@depth` WS), buffering deltas.
2. **Fetch a snapshot** (`GET /depth?symbol=...&limit=1000`).
3. **Replay buffered deltas** with `update_id > snapshot.lastUpdateId`, then continue applying live deltas as they arrive.

The snapshot+stream pattern is standard across venues and well-documented in the Binance API docs and the Coinbase Advanced Trade docs. The subtlety is **sequence-number gap detection**: every delta carries a sequence number, and a missed delta (network drop, WS reconnect) means your reconstruction has silently diverged from the venue's book. The fix is to detect the gap by comparing the incoming delta's `previousUpdateId` against the last applied delta's `updateId`; on mismatch, *throw away the local book, fetch a fresh snapshot, and resync*. Continuing to operate on a desynced book is the §4.11(4) failure mode, and the symptom is "the quotes are weirdly bad even though the strategy looks healthy."

The canonical reference implementation in the Python world is **`nautilus_trader`'s `OrderBook`** (in `nautilus_trader.model.orderbook`), which handles snapshot reconciliation, sequence-gap detection, and L2/L3 reconstruction with explicit FIFO queue tracking per level. For TypeScript there is no equally canonical library; the implementation pattern is straightforward but the *discipline around resync on every gap* is where production-ready code differs from a prototype.

```typescript
// execution/local-book.ts (sketch)
export class LocalBook {
  private bids = new SortedMap<bigint, LevelState>();   // price -> level
  private asks = new SortedMap<bigint, LevelState>();
  private lastAppliedUpdateId = 0n;

  applyDelta(delta: BookDelta): void {
    if (delta.previousUpdateId !== this.lastAppliedUpdateId) {
      throw new BookGapError(this.lastAppliedUpdateId, delta.previousUpdateId);
    }
    this.lastAppliedUpdateId = delta.updateId;
    for (const change of delta.changes) {
      const side = change.side === 'buy' ? this.bids : this.asks;
      if (change.sizeUnits === 0n) side.delete(change.priceMicros);
      else side.set(change.priceMicros, { sizeUnits: change.sizeUnits, fifoQueue: this.queueAt(change) });
    }
  }

  queuePositionAhead(clientOrderId: string): bigint {
    // Sum sizes ahead of our order on its level, by FIFO timestamp.
    // ...
  }
}
```

For backtesting purposes, the `PaperVenue` from §4.7 owns its own `LocalBook` that it controls deterministically; the live path's `LocalBook` is fed from the WS stream and is the one that has to handle gaps and resyncs.

## 4.11 The four failure modes of execution

Every dead market-making strategy died from one of these. Print them on a card.

### 1. Quote updates faster than the venue rate limit → bans

You followed Policy 1 (re-quote on every tick) on a residential connection. The mid ticks at 20 Hz; your scheduler emits 40 REST calls per second (cancel + place). You blow through Binance Spot's 50 orders / 10 s after one second of operation; the venue starts returning 429s; after 30 seconds of 429s you get a 5-minute IP ban; you stop quoting; your inventory drifts; you lose money on the unwind. **Fix: a real rate limiter in the scheduler that *refuses to emit* requests beyond the cap, plus Policy 2 or Policy 3 from §4.3.**

### 2. Quote updates slower than mid-price moves → adverse fills

Symmetric failure. Your scheduler is too conservative (band too wide; rate limit too aggressively self-throttled); the mid moves significantly past your bid before you re-quote; an informed taker hits your stale bid; you've just bought above the new mid. Every time this happens you've taken a small loss against an informed counterparty — and over a session the cumulative cost dominates the strategy. **Fix: tune the band width against realised mid volatility (§4.3 Policy 2); use Policy 3 layered quoting so you have several lines of defence; and pull quotes during high-information events (news, large trades on related instruments — §5 on risk).**

### 3. Backtest ignores queue → fill rates wrong by 10×

Your backtest assumes "your order fills whenever a trade prints at your level." The real fill rate is much lower because you sit behind a queue you never modelled. The backtest shows 200 fills/hour at high P&L per fill; live shows 20 fills/hour at similar per-fill P&L. **Strategy that looked profitable is not.** Fix: model queue position explicitly in the backtest (§4.4–§4.5); use the order-book reconstruction approach from §4.10 to know where in the queue your order would have been; calibrate the queue-drain hazard against realised fills from a small live run.

### 4. Order-book reconstruction drifts → stale quotes against the real book

You miss a WS delta during a reconnect and don't notice. The reconstructed book diverges from the real book. Your scheduler computes a "post-only" quote that is actually marketable against the real book. The venue rejects it (best case) or fills it as taker (worst case if you forgot to set post-only on that path). Symptoms are inexplicable rejections or inexplicable taker fills that "shouldn't have happened." **Fix: strict sequence-number gap detection (§4.10); on any gap, throw the local book away, fetch a snapshot, resync from scratch; never silently continue.**

## 4.12 Code shape — a `QuoteScheduler` skeleton

The scheduler glues the A-S quoter from §3 to the `IVenue` from §4.7. Roughly 80 lines, no error handling shown:

```typescript
// execution/quote-scheduler.ts
import { IVenue, PlaceOrderRequest } from './venue.interface';

export interface DesiredQuote {
  symbol: string;
  bidPriceMicros: bigint;
  askPriceMicros: bigint;
  bidSizeUnits: bigint;
  askSizeUnits: bigint;
}

export interface SchedulerConfig {
  bandTicksBid: number;        // re-quote if bid drifts > this many ticks (Policy 2)
  bandTicksAsk: number;
  tickSizeMicros: bigint;
  maxOrdersPer10s: number;     // venue rate limit (e.g. 50 for Binance Spot)
  minReplaceIntervalMs: number; // cooldown between cancel-replaces per side
}

interface RestingOrder {
  clientOrderId: string;
  side: 'buy' | 'sell';
  priceMicros: bigint;
  sizeUnits: bigint;
  placedAtMs: number;
}

export class QuoteScheduler {
  private bid: RestingOrder | null = null;
  private ask: RestingOrder | null = null;
  private requestTimestampsMs: number[] = [];
  private lastBidReplaceMs = 0;
  private lastAskReplaceMs = 0;
  private seq = 0;

  constructor(
    private readonly venue: IVenue,
    private readonly cfg: SchedulerConfig,
  ) {
    this.venue.onFill(ev => this.onFill(ev));
  }

  async onDesiredQuote(desired: DesiredQuote, nowMs: number): Promise<void> {
    await this.maybeReplaceSide('buy', desired.bidPriceMicros, desired.bidSizeUnits, desired.symbol, nowMs);
    await this.maybeReplaceSide('sell', desired.askPriceMicros, desired.askSizeUnits, desired.symbol, nowMs);
  }

  private async maybeReplaceSide(
    side: 'buy' | 'sell',
    desiredPriceMicros: bigint,
    desiredSizeUnits: bigint,
    symbol: string,
    nowMs: number,
  ): Promise<void> {
    const resting = side === 'buy' ? this.bid : this.ask;
    const bandTicks = side === 'buy' ? this.cfg.bandTicksBid : this.cfg.bandTicksAsk;
    const lastReplaceMs = side === 'buy' ? this.lastBidReplaceMs : this.lastAskReplaceMs;

    // Cooldown gate
    if (nowMs - lastReplaceMs < this.cfg.minReplaceIntervalMs) return;

    // Band gate (Policy 2 — §4.3)
    if (resting) {
      const driftTicks = absBig(resting.priceMicros - desiredPriceMicros) / this.cfg.tickSizeMicros;
      if (driftTicks < BigInt(bandTicks)) return;  // within band, keep order (queue position preserved)
    }

    // Rate-limit gate
    if (!this.rateBudgetAvailable(nowMs, resting ? 2 : 1)) return; // cancel+place = 2

    if (resting) {
      await this.venue.cancelOrder(resting.clientOrderId);
      this.recordRequest(nowMs);
    }
    const req: PlaceOrderRequest = {
      symbol,
      side,
      sizeUnits: desiredSizeUnits,
      limitPriceMicros: desiredPriceMicros,
      postOnly: true,                    // §4.2 — every order
      clientOrderId: `qs-${++this.seq}-${nowMs}`,
    };
    const ack = await this.venue.placeOrder(req);
    this.recordRequest(nowMs);

    if (ack.status === 'NEW') {
      const ro: RestingOrder = { clientOrderId: req.clientOrderId, side, priceMicros: desiredPriceMicros, sizeUnits: desiredSizeUnits, placedAtMs: nowMs };
      if (side === 'buy') { this.bid = ro; this.lastBidReplaceMs = nowMs; }
      else                { this.ask = ro; this.lastAskReplaceMs = nowMs; }
    }
    // REJECTED_POST_ONLY: book moved, retry next tick with new desired
    // REJECTED_RATE_LIMIT: scheduler under-counted; widen the safety margin
  }

  private rateBudgetAvailable(nowMs: number, weight: number): boolean {
    const cutoff = nowMs - 10_000;
    this.requestTimestampsMs = this.requestTimestampsMs.filter(t => t > cutoff);
    return this.requestTimestampsMs.length + weight <= this.cfg.maxOrdersPer10s;
  }

  private recordRequest(nowMs: number): void { this.requestTimestampsMs.push(nowMs); }

  private onFill(ev: { clientOrderId: string; filledSizeUnits: bigint }): void {
    if (this.bid && ev.clientOrderId === this.bid.clientOrderId) this.bid = null;
    if (this.ask && ev.clientOrderId === this.ask.clientOrderId) this.ask = null;
  }
}

function absBig(x: bigint): bigint { return x < 0n ? -x : x; }
```

The eighty-line skeleton above is enough to run a real market-making loop on `PaperVenue` against a live Binance book and produce a deterministic backtest of fills, ack rates, and rate-limit consumption. The next steps to make it production-ready, in order: explicit handling of `REJECTED_POST_ONLY` (retry one tick safer or skip), reconnection logic for the WS fill stream, persistence of resting-order state to survive process restart (the §4.8 idempotency story from the stat-arb course's execution chapter), and migration from Policy 2 to Policy 3 (layered quoting) once the simple version is observably healthy.

## Sources

- **CST10** — Cont, R., Stoikov, S., & Talreja, R. (2010). *A Stochastic Model for Order Book Dynamics.* Operations Research 58(3), 549–563. The foundational stochastic-LOB model. Closed-form fill-probability results as a function of depth and queue position; the formal grounding for §4.4 and §4.5.
- **AS08** — Avellaneda, M., & Stoikov, S. (2008). *High-frequency trading in a limit order book.* Quantitative Finance 8(3), 217–224. The quoter from §3; this chapter is what sits between AS08's reservation price and the venue. Section 3 of the paper covers the order-arrival model that underpins the hazard rate in §4.5.
- **Binance Spot API documentation** (Tier B, exchange-published). Endpoint reference for `POST /api/v3/order`, `DELETE /api/v3/order`, `GET /api/v3/depth`, the WS book-depth stream, and the rate-limit weight schedule cited in §4.3 and §4.9. <https://developers.binance.com/docs/binance-spot-api-docs>
- **Coinbase Advanced Trade API documentation** (Tier B, exchange-published). Endpoint reference for the limit-order `post_only` flag and the L2 book WS channel pattern from §4.10. <https://docs.cloud.coinbase.com/advanced-trade/docs/welcome>
- **OKX, Bybit, Hyperliquid** — exchange documentation, Tier B, for the post-only flag names and rate-limit numbers in §4.2 and §4.6.
- **`nautilus_trader`** — open-source HFT framework, MIT-licensed. The `OrderBook` class is the reference implementation for the §4.10 reconstruction pattern. <https://github.com/nautechsystems/nautilus_trader>
- **Harris, L. (2003).** *Trading and Exchanges: Market Microstructure for Practitioners.* Oxford University Press. Same canonical practitioner reference cited in the stat-arb course; the queue-position and FIFO-priority discussion in §4.4 is the modern application of Harris's mechanical description of time-priority matching.
- **Almgren, R., & Chriss, N. (2001).** *Optimal execution of portfolio transactions.* Journal of Risk 3, 5–40. Cited here for the latency-vs-spread trade-off framing in §4.8: the same intuition that makes patient execution cheap for stat-arb makes patient (wide-spread, slow-replace) market making the only viable posture when you can't compete on latency.
