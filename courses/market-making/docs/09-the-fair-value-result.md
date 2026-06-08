# 9. The decisive result — market making is a fair-value problem, not a spread-width problem

!!! abstract "Where this chapter fits"
    **Feeds in from:** [§1.3](01-introduction.md#13-the-three-components-of-the-bid-ask-spread) (the three-component spread decomposition — this chapter is what happens when you *measure* the adverse-selection component on a real tape), [§2.9](02-microstructure.md#29-what-this-implies-for-quoting) (the imbalance signal), [§3](03-avellaneda-stoikov.md) (the quoter whose *center* we are about to move off the mid), and [§8](08-the-meridian-desk-stack.md) (the queue-aware harness and real L2/flow tapes that produced every number below).
    **Feeds into:** [§10](10-the-fair-value-engine.md) (the full fair-value "theo" engine this chapter motivates) and [§11](11-directional-market-making.md) (inventory carry — the *only* loss left standing once the spread edge is fixed).
    **What this chapter is:** the single most important empirical finding on this desk, stated plainly and shown with the numbers that forced it. Chapters 1–8 teach the textbook quoter and the honest plumbing to measure it. This chapter is what the measurement *said* — and it is not what the textbook predicts. **Read it as the hinge of the course:** everything before is "how to quote"; everything after is "how to quote *the right price, fast enough*."

## 9.1 The question, asked honestly: can the spread alone make money?

Chapter 1 framed the maker's gross revenue as *spread × round-trip fills* and named adverse selection as the cost that "separates a viable quoter from a subsidy." Chapter 8 built the machinery — real Hyperliquid L2 depth, real per-trade aggressor flow, FIFO queue-aware fills, a four-component P&L attribution — to *measure* that cost instead of assuming it away. So we ran the obvious experiment: harvest a multi-hour L2 tape across the liquid universe, replay the neutral GLFT/Avellaneda-Stoikov quoter, and decompose the result.

The decomposition the attributor reports is exactly the §1.3 decomposition, made into an equation you can add up:

$$
\text{structural P\&L} \;=\; \underbrace{\text{spread captured}}_{\text{the maker edge}} \;-\; \underbrace{\text{adverse selection}}_{\text{the §1.3 cost}} \;+\; \underbrace{\text{inventory carry}}_{\text{mark-to-market on forced position}}
$$

The first two terms are the *spread business* — the part the whole course is about. The third is the mark-to-market on whatever position the flow forced you to hold. We asked the cleanest possible question first: **ignore carry for a moment — is `spread − adverse` positive?** If the spread business itself is positive, market making works and carry is just risk to be managed. If it is negative, no amount of inventory management saves you, because the core activity loses money on every fill.

The answer, on a 6-hour / 20-perp Hyperliquid L2 harvest with inventory clamped, was unambiguous and bad:

> **`spread − adverse ≤ 0` on 14 of the 20 coins at the default spread.** Adverse selection ate the entire half-spread. The naive maker has *no clean spread edge.*

```
spread − adverse, neutral quoter, 18s re-quote     loss ◄──┼──► gain
representative liquid perps                                 0
  (each bar one coin; 14 of 20 sat at or below zero)
  coin A   ████████████████████████┤                    most negative
  coin B   ███████████████████┤
  coin C   ██████████┤
  coin D   ████┤
  coin E      ┤█                                          a thin minority positive
  coin F      ┤███
```

And the part that surprised even the people who expected a hard number: the **entire** desk P&L — including the per-coin swings of ±\$4,000 against a spread capture of only ±\$800 on a \$20M book — was **inventory carry**, the mark on the position the flow forced the book to hold. The spread business was flat-to-negative; the noise was all carry (more on that in [§9.6](#96-whats-left-standing-inventory-carry) and [§11](11-directional-market-making.md)).

This is the result that reorganises the course. If you stop here you will conclude market making is unviable. The rest of the chapter is why that conclusion is wrong — and what *actually* fixes it.

## 9.2 Why widening the spread does **not** fix adverse selection

The textbook reflex, and the one every newcomer reaches for, is: *adverse selection is eating my spread, so make the spread wider.* It does not work, and understanding **why** is the conceptual core of this chapter.

Recall the §1.2 framing: **every resting quote is a free option you have written to the market.** An informed taker exercises it by trading against the side that is about to be right. Now look at where the option's *strike* sits. You centred your quotes on the **mid** — and the mid is **stale**: it is the midpoint of the last book you saw, not the fair value *right now*. When real flow is about to move the price up, the book is already leaning (more size bid than offered) milliseconds before the mid prints higher. An informed taker lifts your ask — which you set relative to a mid that is **too low** — and you are immediately marked down.

Widening the spread moves *both* quotes away from that stale center symmetrically. The informed flow still picks the side it wants; you have simply handed it a slightly worse fill while quoting so wide you collect almost nothing from the uninformed flow that pays the rent. You have not repriced the option — you have only fattened the premium on a contract whose **strike is in the wrong place.**

> **The decisive reframing:** adverse selection is a **fair-value error**, not a spread-width error. You are picked off because your *center* is wrong, not because your *spread* is thin. Every knob that moves the spread (γ, κ, the half-spread floor) is cancelled by selection — it moves both sides and the informed flow re-chooses. The **one** lever that moves `adverse` is the **price you quote around**.

This is why a γ/κ sweep ([§8.6](08-the-meridian-desk-stack.md#86-per-pool-γκ-tuning)) can rank calibrations by drawdown but can never tune a losing spread business into a winning one: it is searching the wrong axis. The axis that matters is **the center** (this chapter and [§10](10-the-fair-value-engine.md)) and **how often you re-set it** ([§9.4](#94-fix-2-re-quote-in-milliseconds-cadence-is-the-dominant-lever)).

## 9.3 Fix 1 — quote around the micro-price, not the mid

If the disease is a stale center, the cure is a better center. The order book *already tells you which way the next tick leans*, for free, every time it updates: it is leaning toward whichever side has more resting size. Define top-of-book **imbalance**

$$
I \;=\; \frac{Q_{\text{bid}} - Q_{\text{ask}}}{Q_{\text{bid}} + Q_{\text{ask}}} \;\in\; [-1, +1]
$$

and the **micro-price** (Stoikov, 2018 — the size-weighted fair value first introduced in [§2.1](02-microstructure.md#21-the-limit-order-book)) shifts the mid toward the *heavier* side, because the heavier side is where price is about to go:

$$
\mu_{\text{micro}} \;=\; \text{mid} \;+\; \frac{\text{spread}}{2}\,\cdot\, g(I), \qquad g(0)=0,\; g(\pm 1)=\pm 1
$$

Start with `g(I) = I` (Stoikov's first-order linear form); refine `g` empirically from the tapes later. The intuition in one picture:

```
book is BID-heavy  (I > 0)  → next tick likely UP   → micro-price sits ABOVE mid

        bid size                 ask size
        ████████████  85   |   30  ████
                    bid ── mid ── ask
                            │   ▲
                            │   └─ μ_micro  (pulled toward the heavy/bid side)
                            └───── mid (stale: ignores the lean)
```

You centre your quotes on `μ_micro`, not the mid. Now when the book leans bid and price is about to rise, your ask is already set relative to a *higher* center — the informed taker who lifts it pays closer to the move, and your mark-down shrinks.

The measured effect on this desk (the "F1" build, replayed on the saved tapes): **micro-price quoting cut realised adverse selection by ≈21% desk-wide.** Real, consistent across the liquid coins, and — critically — it adds the *same* roughly +\$42 of `spread − adverse` whether the re-quote cadence is 18s or sub-second (see the table in [§9.4](#94-fix-2-re-quote-in-milliseconds-cadence-is-the-dominant-lever)). It is the right direction. It is **not, by itself, enough** — a 21% cut on a cost that exceeds 100% of the spread still leaves you negative. The micro-price needs a partner, and the partner turned out to be the bigger lever.

## 9.4 Fix 2 — re-quote in milliseconds (cadence is the dominant lever)

Here is the finding that surprised us, and the one Ronnie called before the data did. We built three fair-value upgrades and measured each on the 18-second-poll tapes:

| Upgrade | What it does | Result at 18s cadence |
|---|---|---|
| **F1 — micro-price center** | quote around `μ_micro`, not mid ([§9.3](#93-fix-1-quote-around-the-micro-price-not-the-mid)) | **−21% adverse — the one clear win** |
| **F2 — cross-venue fusion** | fold the faster Binance price into the center | **no-op** (β ≈ 0, lag 0; see [§9.5](#95-the-cross-venue-no-op-a-measured-negative-worth-keeping)) |
| **F3 — confidence-scaled spread** | tighten on calm flow, widen on toxic flow | **inconclusive / slightly negative** — toxicity too noisy to time at 18s |

Read naively that is one win and two failures. Read correctly it is **one root cause with three symptoms: the 18-second poll cadence is far too coarse for the phenomena that beat adverse selection.**

- Adverse selection happens in **milliseconds** — you get picked off the instant your quote goes stale.
- The cross-venue lead–lag (F2) lives **below ~1 second**; at an 18s poll it is invisible *and* inactionable.
- Flow toxicity (F3) must be read **tick-by-tick**; an 18s bucket averages the signal into noise.
- And the killer: the sim's **markout adverse is measured over the re-quote interval.** At an 18s interval you are charged 18 seconds of stale-quote risk on every fill. A book that re-quotes every few **milliseconds** carries almost none of that risk — so **the true adverse is far smaller than the 18s sim shows.**

That last point is worth restating, because it is the whole game:

> **Measured adverse ≈ the price move over your re-quote interval.** Shrink the interval and the measured *and the true* adverse selection collapse toward zero. Cadence is not a tuning detail; it *is* the adverse-selection lever.

**Make it concrete.** Picture a single fill on a coin that, when you *are* picked off, drifts against your new position at roughly 0.5 bps per second of staleness (a calm-but-real number). The spread you earn on that fill is fixed by your half-spread — say 3 bps. Now the only variable is *how long your quote sat stale before you re-set it*:

```
  half-spread earned per fill .......... 3.0 bps   (fixed by your quote)
  adverse paid per fill = 0.5 bps/s × staleness window:
     re-quote every 18 s    →  up to ~9.0 bps   ✗  adverse ≫ spread  → you bleed
     re-quote every 1 s     →       ~0.5 bps     ✓  spread > adverse  → you earn
     re-quote every 100 ms  →      ~0.05 bps     ✓  adverse is rounding error
```

The spread per fill is a constant; the adverse per fill is **proportional to staleness.** There is therefore a *crossover cadence* below which `spread > adverse` and the business turns profitable — and the only thing that moves you across it is how fast you cancel-and-replace. That is the entire mechanism behind the table below: nothing about the *quoter* changed between the two columns, only how often it re-set its quotes.

So we ran the proof: an **8-hour, sub-second** capture (5 coins, BTC/ETH/SOL/BNB/DOGE, **46,788 steps per coin** at ≈0.6s) and re-ran the identical quoters. The spread edge **flipped sign.**

| `spread − adverse`, desk total | 18s poll | **sub-second re-quote** |
|---|--:|--:|
| **MID** quoter (center = mid) | **−\$1,020** | **+\$133** ✅ |
| **MICRO** quoter (center = micro-price) | −\$801 | **+\$174** ✅ |

```
spread − adverse  (desk total, USD)            loss ◄──┼──► profit
                                                       0
  MID   @ 18s poll        −$1,020   ███████████████████┤
  MICRO @ 18s poll          −$801        ██████████████┤
  MID   @ sub-second        +$133                      ├█
  MICRO @ sub-second        +$174                      ├██
                                              a 7× swing, from deeply
                                              negative to positive
```

A **7× swing** from deeply negative to positive, driven almost entirely by cadence. And it was not one lucky coin carrying the desk — `spread − adverse` went positive on **all five**:

```
   spread − adverse at sub-second cadence, per coin ($)     all five POSITIVE ──▶
   BTC    +25   ██▌
   DOGE   +24   ██▍
   BNB    +28   ██▊
   SOL   +107   ██████████▋
   ETH   +130   █████████████
```

On ETH and DOGE the adverse term itself went *negative* — i.e. fills landed on the *favourable* side. ETH (+\$165) and DOGE (+\$190–278) were net-positive at low drawdown. The micro-price (F1) added its consistent +\$42 on top (+133 → +174), exactly as it had at 18s.

**The decisive lesson of the whole course, in one line:** the spread edge is real once you **price it right (micro-price) and re-quote it fast (sub-second).** DEX/CLOB market making is a genuine business — but the edge is **fair-value prediction + speed**, not spread width.

## 9.5 The cross-venue no-op (a measured negative worth keeping)

The seductive idea on a DEX like Hyperliquid: it's "slower" than Binance, so quote HL around the *faster* Binance price and harvest the lead. We built it (F2) and **measured** it instead of assuming it — and the honest result is a clean **no-op**:

- Cross-correlation of HL vs Binance returns: peak at **lag 0**, correlation **0.97**, fitted lead coefficient **β ≈ 0**. Hyperliquid **price-discovers on its own**; it is a *lead* venue on its native coins, not a Binance follower.
- Re-checked at sub-second cadence: still sync, still β ≈ 0. (Peak correlation falls to ~0.6 only because Binance 1s klines cannot resolve sub-second HL moves — a *true* sub-second cross-venue test would need Binance WS depth — but the conclusion holds at our data resolution: **do not bolt on the lead venue you assumed leads.**)

This is exactly the kind of result the course's honesty doctrine exists to publish. The design ([§10.3](10-the-fair-value-engine.md#103-the-layers-ordered-by-frequency-and-information-coefficient), Layer B) keeps the cross-venue term *as a seam* — because on a different venue pair the lead is real — but it is wired to be **adopted only where the cross-correlation measurably says so, per coin.** β ≈ 0 is a valid, expected outcome, and saying so out loud saved the desk from quoting around a phantom signal.

## 9.6 What's left standing: inventory carry

After both fixes, the **spread business is profitable** — and yet the desk *net* on that same 8h run was still **−\$6.7k to −\$7.5k.** All of it was **inventory carry**: the mark-to-market on the positions the flow forced the book to hold on the coins that **trended** over the window (SOL −\$1.8k, BNB −\$2.3k, BTC −\$1.2k). The 2-lot inventory clamp bounded it, but a one-sided 8-hour drift still bleeds a held book.

This cleanly separates the two businesses inside a market maker:

```
  market-maker P&L
  ├── SPREAD business   = spread − adverse   →  FIXED (positive) by §9.3 + §9.4
  └── CARRY business    = mark on forced inventory  →  the remaining loss
                                                       (a coin flip if left to chance)
```

The spread business is now solved in *principle* (price + cadence) and is the subject of [§10](10-the-fair-value-engine.md) — the full fair-value engine that makes the center even better and lets *confidence* set the spread. The carry business — the dominant, most-controllable P&L term — is the subject of [§11](11-directional-market-making.md): left to chance it is noise; **chosen** (and OOS-validated, and governed) it becomes the desk's largest accountable alpha. The same lever that loses you the most money when ignored makes the most when steered.

## 9.7 The honest caveats (binding — read before quoting these numbers)

The discipline of this course is to name the limits of every result, and this is the most consequential result in it.

1. **One 8-hour window, one regime.** The *qualitative* flip (−\$1,020 → +\$133, a 7× swing; cadence as the dominant lever) is robust and reproduces the direction of F1 at both cadences. The *exact* +\$133 is **not gospel.** A distribution needs many captures across regimes — the desk's open work.
2. **88% of sub-second steps used a flow *estimate*.** At ≈0.6s, real per-trade WS prints are sparse per interval, so most steps fell back to the candle-volume / tick-rule estimate. **Depth (L2) is always real**; aggressor *flow* is mostly estimated. A clean read needs dense, event-driven WS flow — the true-millisecond milestone ([§10.6](10-the-fair-value-engine.md#106-the-re-quote-loop-event-driven-with-a-latency-rail)).
3. **Queue-aware fills are a lower bound.** At fine cadence you "touch" the tape constantly (141,991 touch-fills) but reach the front of the FIFO queue rarely (3,350 queue-fills — a 42× gap). `queueFills` is the honest lower bound on fill count; the spread numbers above are computed on it.

None of these reverses the finding. They scope it: **the direction is proven, the magnitude is provisional, and the next honest step is breadth, not a bigger claim.**

!!! tip "The one line to remember"
    You are not picked off because your spread is too **thin** — you are picked off because your **center is stale** and you **re-quote too slowly.** Price it right (micro-price), re-quote it fast (sub-second), and the spread edge is real. Everything in [§10](10-the-fair-value-engine.md) is "price it better"; everything about cadence is "re-quote it faster."

## 9.8 Sources

- The micro-price (book-imbalance-adjusted fair value) is **Stoikov (2018)**, "The micro-price: a high-frequency estimator of future prices" (the size-weighted form is in [§2.1](02-microstructure.md#21-the-limit-order-book)). The linear first-order form `g(I)=I` is the natural starting point; the empirical `g` is estimable directly from a captured tape.
- The spread decomposition this chapter measures is the §1.3 lineage — **S78** (Stoll 1978), **GM85** (Glosten & Milgrom 1985); the adverse-selection-as-markout operationalisation is **H91** (Hasbrouck 1991) and the flow-toxicity literature **ELO12** (Easley, López de Prado & O'Hara 2012). The book-imbalance signal behind the micro-price is **CKS14** (Cont, Kukanov & Stoikov 2014).
- The Avellaneda-Stoikov quoter whose center we move is **AS08** ([§3](03-avellaneda-stoikov.md)); the GLFT closed form is **GLFT13** ([§3.8](03-avellaneda-stoikov.md#38-the-guéant-lehalle-fernandez-tapia-2013-extension)).
- Every empirical number in this chapter is from the **Meridian desk research log** — `QUANT_JOURNAL.md` entries **#27** (the 6h harvest; carry dominates), **#28** (spread can't make money alone; which coins to cut), **#29** (F1 micro-price, −21% adverse), **#30** (F2 cross-venue no-op), **#31** (the unifying cadence finding), **#32** (THE PROOF: the sub-second flip) — consolidated in `RESEARCH_FINDINGS.md §6` and designed in `FAIR_VALUE_AND_THESIS_DESIGN.md`. The harness that produced them is [§8.5](08-the-meridian-desk-stack.md#85-queue-aware-fills-stop-trusting-fill-on-touch).

Full citations in [Appendix B](appendix-b-sources.md).
