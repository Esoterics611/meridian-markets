# 10. The fair-value engine — building a "theo" and re-quoting it fast

!!! abstract "Where this chapter fits"
    **Feeds in from:** [§9](09-the-fair-value-result.md) — which proved the spread business lives or dies on the *price you quote around* and *how fast you re-set it*. [§9.3](09-the-fair-value-result.md#93-fix-1-quote-around-the-micro-price-not-the-mid) gave you the first and cheapest fair-value input (the micro-price); this chapter builds the whole estimator around it.
    **Feeds into:** [§11](11-directional-market-making.md) — the *directional* layer of this engine (the house view) is what turns inventory carry from noise into a chosen bet, and it needs the OOS gate this chapter introduces.
    **What this chapter is:** the architecture every serious electronic market maker actually runs — a single **fair-value estimate `μ` with an uncertainty `Σ`**, recomputed continuously, with quotes placed as `μ ± f(Σ)` and re-quoted on every tick. It is a **design with a measured spine**: parts are live and proven on this desk (the micro-price center, the cadence flip), parts are measured negatives (cross-venue fusion), and parts are designed-and-staged (the Kalman fusion, the technical predictor). Every claim below says which is which.

## 10.1 The one idea worth internalising before any code

Here is the sentence that reorganises how you think about market making, and it is worth reading twice:

> **A market maker's only durable edge is knowing the fair value better than the flow that hits it.** The spread and the rebate are the *toll* you collect; the *business* is being right about where the price is in the next few seconds-to-hours, and quoting around **that** number — not around a lagging mid.

Chapter 9 proved this empirically: every knob that moves the *spread* gets cancelled by selection (it moves both sides, the informed flow re-chooses), so the only lever that moves your cost is the **center** and the **cadence**. The natural conclusion is to stop treating "where do I center my quotes?" as an afterthought (`mid`, obviously) and start treating it as **the core engineering problem of the desk.**

So we build exactly one thing well, and make everything else a consequence of it:

$$
\boxed{\;\text{a real-time fair-value estimate } \mu_t \text{ and its uncertainty } \Sigma_t\;}
$$

Once you have `(μ, Σ)`, every other decision falls out as a function of those two numbers:

```
            ┌──────────────────────────────────────────────┐
   μ  ─────▶│  reservation / center  =  μ  (skewed to q*)   │
   Σ  ─────▶│  half-spread           =  f(Σ, σ, toxicity)   │  ← WIDE when unsure
   Σ  ─────▶│  quote size            =  g(Σ)                │  ← SMALL when unsure
   view ───▶│  skew + asymmetry      =  h(bias)             │  ← lean to the side you want
            └──────────────────────────────────────────────┘
```

The whole industry — Citadel Securities, Jump, HRT-style desks — runs some version of this "theo engine": one fused theoretical price, re-computed on every input tick, with quotes = `theo ± f(confidence)`. The honest gap between a naive bot and a real desk is exactly this: the bot quotes `mid ± fixed_spread`; the desk quotes `theo ± f(Σ)`, re-quoted continuously. **That gap was the entire `−$7k` in Chapter 9.**

## 10.2 Three design commitments (all forced by the data, not by taste)

Before the layers, three rules that the Chapter 9 results make non-negotiable. Keep them in mind as you read — every design choice serves one of them.

1. **Price, don't widen.** Adverse selection is a fair-value error. Fix the *price*; widening only fattens the premium on a mis-struck option ([§9.2](09-the-fair-value-result.md#92-why-widening-the-spread-does-not-fix-adverse-selection)).
2. **Confidence sets the spread.** Quote tight and big when `Σ` is small; wide and small when `Σ` is large. The spread is *earned* by certainty, not guessed by a fixed γ. This is the single change that lets `spread − adverse` go positive **without** relying on carry — you only quote tight when you actually know the price.
3. **The view bends the price at its own time scale.** A daily/weekly thesis enters as a *slow drift prior* — it cannot overrule the microstructure tick, but it tilts the resting center and the inventory you *want* to hold. Every view is time-stamped and graded by its own P&L (that is [§11](11-directional-market-making.md)).

## 10.3 The layers, ordered by frequency and information coefficient

`μ` is fused from layered inputs, added **cheapest-and-highest-IC first**. The ordering principle is the practitioner's instinct made explicit: a signal earns its place by *information coefficient* (its correlation with the forward move) per *unit of cost and latency*. The micro-price is free, sub-second, and the highest-IC thing you own — so it goes first. A news-NLP feed is expensive, slow, and noisy — so it goes last, if ever.

| Layer | Signal | Frequency | IC / status | What it contributes |
|---|---|---|---|---|
| **A — Micro-price** | book imbalance `I` → `μ_micro = mid + (s/2)·g(I)` | sub-second | **highest, free — LIVE** | the single biggest adverse cut you can make; **−21% adverse** ([§9.3](09-the-fair-value-result.md#93-fix-1-quote-around-the-micro-price-not-the-mid)) |
| **B — Cross-venue** | fold a faster reference (Binance) into `μ` | seconds | **measured ≈ 0 on HL** | a *seam*, not a default — HL self-discovers ([§9.5](09-the-fair-value-result.md#95-the-cross-venue-no-op-a-measured-negative-worth-keeping)); real on other venue pairs |
| **C — Flow drift** | order-flow imbalance `OFI` from the trades-WS | seconds–minutes | real but **short-lived** | aggressive flow is persistent over seconds → predicts near-term drift; decay it fast, down-weight when toxic |
| **D — Technical** | interpretable predictor of next-N-min return | minutes–hours | **designed, OOS-gated** | returns at lags, realized vol, OFI, funding, basis, VWAP dev — regularized-linear first, ML only under purged-CV |
| **E — Thesis drift** | the house view `b ∈ [−1,1]` | hours–weeks | **the slow prior** ([§11](11-directional-market-making.md)) | tilts the resting center + sets target inventory `q*`; OOS-validated before it sizes carry |

The arithmetic of stacking them is just successive refinement of the same number:

$$
\begin{aligned}
\mu_{\text{micro}} &= \text{mid} + \tfrac{s}{2}\,g(I) & &\text{(Layer A)}\\
\mu_{\text{x}}     &= \mu_{\text{micro}} + \beta\,(P_{\text{ref}} - P_{\text{mid}}) & &\text{(Layer B; } \beta \text{ fit per coin — may be 0)}\\
\mu_{\text{flow}}  &= \mu_{\text{x}} + \kappa_{\text{flow}}\cdot \text{OFI}\cdot \sigma_{\text{price}} & &\text{(Layer C)}\\
\mu              &= \mu_{\text{flow}} + \mu_{\text{tech}} + \lambda_{\text{thesis}}\, b\, \sigma_{\text{daily}} & &\text{(Layers D, E)}
\end{aligned}
$$

The honesty rail that makes this safe rather than a curve-fitting machine: **each layer must earn its weight with an out-of-sample information coefficient on the saved tapes before it is allowed to move a live quote.** A low-IC signal folded into the price is not "extra information" — it is *leverage on noise*, and it will lose you money with more confidence than the mid did. This is the same gate the stat-arb course applies to alphas; here it applies to fair-value inputs.

## 10.4 Fusing the layers — the Kalman filter, and why

You could combine the layers with hand-tuned weights. Don't — the weights are unstable and you will overfit them. The principled tool is a **1-D Kalman (Bayesian) filter**, and the reason it is the right tool is also the best one-line intuition for it:

> A Kalman filter **trusts each input in proportion to how noisy it currently is**, and hands you back both the best fused estimate `μ` *and* its uncertainty `Σ` — which is exactly the second number the quoter needs.

The set-up: the hidden state is the true fair value (plus a slow drift term carrying the technical + thesis layers); the observations are `{μ_micro, μ_x, the trade prints}`. The filter does the bookkeeping of "this observation is noisy right now, so move toward it only a little; that one is sharp, so move a lot." When the book is calm and inputs agree, `Σ` is small → you are confident. When inputs disagree or the book is thrashing, `Σ` blows up → you are *correctly* uncertain, and (per commitment 2) you widen and shrink size automatically.

```
   refs ──▶┐
   L2  ────┤   ┌─────────────────────────┐
   trades ─┼──▶│   KALMAN / BAYES FILTER  │──▶  μ   (fused fair value)
   funding ┘   │  trust ∝ 1/observation   │──▶  Σ   (how sure we are)
   drift ─────▶│  noise; carries drift     │
               └─────────────────────────┘
```

You do **not** need the full filter to start. v1 is a weighted blend of the layers with an **EWMA-variance proxy** for `Σ` — it captures 80% of the value and is trivially testable. The Kalman is the v2 upgrade, and its payoff is stability under noisy, asynchronous inputs (the real world, where the L2 updates at one rate and the trades at another). Build the blend, prove it on tapes, then upgrade.

## 10.5 From `(μ, Σ)` to quotes — confidence-scaled and view-skewed

This is where the two numbers become four decisions. Each line below is one decision, and the comment is the intuition:

$$
\begin{aligned}
\text{reservation } r &= \mu - (q - q^\*)\cdot \gamma\,\sigma^2 (T-t) & &\text{skew toward TARGET inventory } q^\*,\text{ not 0}\\
\text{half-spread } s &= \text{base}(\sigma)\cdot\big(1 + c_\Sigma \hat\Sigma + c_v\,\text{VPIN}\big) & &\textbf{WIDER when uncertain / toxic}\\
\text{size} &= \text{size}_0 \cdot \text{clamp}\!\big(\tfrac{1}{1+c_\Sigma\hat\Sigma}\big) & &\textbf{SMALLER when uncertain}\\
\text{asymmetry} &: \; s_{\text{near}} = s(1-a|b|),\;\; s_{\text{far}} = s(1+a|b|) & &\text{better price on the thesis side}
\end{aligned}
$$

The middle two lines are the heart of the upgrade and deserve a picture. **Confidence is the spread.** When the filter is sure (`Σ` small) you lean in: tight quotes, big size — you know the price, so quote it aggressively and collect. When the filter is unsure (`Σ` large) you pull back: wide quotes, small size — you might be wrong, so don't write a cheap option on a price you can't see.

```
   Σ small  (you KNOW the price)        Σ large  (you DON'T)
   ─────────────────────────────       ─────────────────────────────
        bid ███┤μ┤███ ask  (tight)         bid █┤   μ   ┤█ ask  (wide)
        size:  ████████  (big)             size:  ██     (small)
   → harvest the spread you can see    → don't get picked off blind
```

This is the **principled replacement for a fixed γ/κ guess** — and it is precisely the lever that makes `spread − adverse` positive on its own merits, *without leaning on carry*. A fixed-spread quoter charges the same premium whether it knows the price or not; a confidence-scaled quoter only quotes tight when it has actually earned the right to.

The fourth line, asymmetry, is the bridge to Chapter 11: a bullish thesis (`b > 0`) rests the book long (`q* > 0`) and shows a *better* (tighter, larger) bid — so you **accumulate the position you want at better-than-mid prices while still earning the spread.** That is the dealer "axe," and it is the topic of the next chapter.

A crucial implementation note that keeps all of this honest and reversible: this entire engine fits the **existing `IQuoter` seam unchanged.** The quoter becomes a pure function of an extended `QuoteContext` carrying `(μ, Σ, q*, b)`, computed by the fair-value engine the runtime owns. Set `b = 0`, `μ = mid`, `Σ = const` and it **reproduces today's neutral quoter bit-for-bit.** Nothing regresses; the new behaviour is strictly additive and individually switchable.

## 10.6 The re-quote loop — event-driven, with a latency rail

The best `μ` in the world is worthless if you re-set your quotes around it every 18 seconds. Chapter 9 proved cadence is the dominant lever; this section is how you actually run it without lying to yourself.

**Event-driven, not polled.** Subscribe to the venue's L2 and trades WebSocket (and any reference venue's depth WS), reconstruct the book on *every* update, and recompute `μ` and re-quote on every tick — not on a 10-second timer. At millisecond steps, "re-quote on every tick" *is* millisecond re-quoting, and the markout horizon (your measured adverse) shrinks to the re-quote interval, collapsing toward the true, much-smaller number ([§9.4](09-the-fair-value-result.md#94-fix-2-re-quote-in-milliseconds-cadence-is-the-dominant-lever)).

**The latency rail — the anti-free-lunch.** The temptation in a backtest is to assume your new quote is live the instant you decide to re-quote. That is a fantasy that manufactures profit. Real cancel-and-replace takes time: you decide, the cancel travels to the venue, the new order travels back, and during that window your *old* quote is still exposed. So the model carries an explicit cancel/replace **latency** — on this desk, a 100ms re-quote interval against a 30ms cancel/replace latency (the internally-consistent colocated-maker assumption; 100 > 30 leaves a ~70ms live window per quote).

```
   t=0ms          decide to re-quote (μ moved)
   t=0–30ms       OLD quote still live  ◀── you can be picked off HERE (the rail charges this)
   t=30ms         new quote acknowledged
   t=30–100ms     new quote live, fresh center
   t=100ms        next re-quote cycle
```

> **Honest caveat (binding):** real venues *rate-limit* order actions, so a 100ms re-quote is a clean **paper upper bound**, not a sustainable live claim on a public venue. On real big venues this is exactly where colocation and hardware earn their keep — the latency game is what justifies the infra spend. State the assumption; never quote the paper number as if it were a production SLA.

## 10.7 The build plan — strictly incremental, measurable each step

The engine is built in phases, each provable on tapes you already own *before* a dollar of (paper) risk. This is both the roadmap and an honest status board:

| Phase | Build | Proven by | Status on this desk |
|---|---|---|---|
| **F1** | Micro-price center + extended `QuoteContext(μ,Σ)` | does `spread − adverse` rise on the liquid coins? | ✅ **−21% adverse; live** |
| **F2** | Cross-venue lead–lag (Layer B) | the lead's OOS IC; further adverse cut | ✅ **measured no-op (β≈0); kept as seam** |
| **F3** | Flow drift + confidence-scaled spread/size; Kalman v1 | tight-when-certain flips coins net-positive *without carry* | ◐ inconclusive at 18s → **proven once cadence went sub-second** |
| **—** | **Cadence: event-driven WS, ms re-quote, latency rail** | the markout collapse; the spread-edge flip | ✅ **THE PROOF: −\$1,020 → +\$133** ([§9.4](09-the-fair-value-result.md#94-fix-2-re-quote-in-milliseconds-cadence-is-the-dominant-lever)) |
| **F4** | Thesis Register + directional skew + per-thesis carry attribution | leaning long raises carry monotonically; invalidation flattens | ◐ quoter + OOS gate **built**; see [§11](11-directional-market-making.md) |
| **F5** | Technical predictor under purged-CV; Kalman v2; full live event loop | OOS IC gates; forward paper with all layers | ○ designed |

**The honesty rails, binding on every phase** (this is what separates an engine from a curve-fit): each signal earns its weight with an OOS IC before it touches a live quote; interpretable models before ML; paper-only; `b=0`/`μ=mid` reproduces today's quoter bit-for-bit; the drawdown budget (2% desk) caps any directional size. The motto: **we are pricing better, not betting bigger.**

!!! tip "The one line to remember"
    Build **one** number well — a fair value `μ` and how sure you are of it, `Σ` — and make every quote a function of those two: center on `μ`, widen and shrink with `Σ`, lean with the view. A bot quotes `mid ± fixed`; a desk quotes `theo ± f(confidence)`. The whole chapter is that sentence.

## 10.8 Sources

- The fair-value-as-the-edge thesis, the layer stack, the Kalman fusion, the confidence-scaled quoting, and the build phases are the design in the **Meridian desk's** `FAIR_VALUE_AND_THESIS_DESIGN.md` (2026-06-05), itself grounded in dealer / HFT-MM practice.
- **Layer A** is **Stoikov (2018)**, the micro-price ([§2.1](02-microstructure.md#21-the-limit-order-book), [§9.8](09-the-fair-value-result.md#98-sources)). **Layer B** (cross-venue price transfer) is the index-arb / lead–lag tradition; the desk's measured β≈0 is `QUANT_JOURNAL.md #30`. **Layer C** (order-flow imbalance predicting drift) is **CKS14** (Cont, Kukanov & Stoikov, 2014 — order-flow imbalance as a linear predictor of short-horizon price change). **Confidence-scaled quoting** generalises the **AS08**/**GLFT13** half-spread by replacing the fixed γ with a filter variance.
- **Alpha blending** (`α = vol·IC·score`, decorrelated, risk-weighted) is **GK99** (Grinold & Kahn, 1999) — the same fundamental-law machinery the stat-arb course cites.
- The cadence result and the latency-rail assumption are `QUANT_JOURNAL.md #31–#32` and `#34` (the 100ms/30ms decision), consolidated in `RESEARCH_FINDINGS.md §6`.

Full citations in [Appendix B](appendix-b-sources.md).
