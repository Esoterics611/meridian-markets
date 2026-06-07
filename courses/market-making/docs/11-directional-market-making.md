# 11. Directional market making — turning inventory carry into a chosen, governed bet

!!! abstract "Where this chapter fits"
    **Feeds in from:** [§9.6](09-the-fair-value-result.md#96-whats-left-standing-inventory-carry) — once the spread business is fixed by price + cadence, **inventory carry is the only loss left**, and it is the *largest, most controllable* term in the whole P&L. [§10.5](10-the-fair-value-engine.md#105-from-to-quotes-confidence-scaled-and-view-skewed) introduced the *asymmetry* knob; this chapter is what you steer it with. [§5](05-risk.md) gave the inventory-risk axioms; this chapter is the operational, hard-won version.
    **Feeds into:** the desk runbook ([§8.9](08-the-meridian-desk-stack.md#89-the-desk-runbook-scan-capture-tune-launch-forward-paper)) and the forward-paper track record that *is* the demo.
    **What this chapter is:** the most expensive lesson on the desk, told through the runs that taught it. Inventory carry is a coin flip if you leave it to chance and a position if you choose it — but **choosing wrong is how a market maker blows up**, and we have the −\$11,623-in-90-minutes receipt to prove it. This chapter is how to take the carry bet *only when the data licenses it*, sized, time-stopped, hedged, and governed. **It is as much a chapter about discipline as about a strategy.**

## 11.1 The finding that forces a directional layer

Chapter 9 left us in a strange place: the spread business is profitable once you price and re-quote it right, **and yet the desk still lost money.** The whole loss was inventory carry — the mark-to-market on the position the flow forced the book to hold. On a 6-hour harvest, the per-coin P&L *swung* ±\$4,000 from carry against a spread capture of only ±\$800. The carry term is **five times larger** than the spread term and points in whatever direction the coin happened to trend.

Sit with the implication, because it is the seed of the entire chapter:

> The biggest, most controllable lever in the whole system is **which way, and how much, inventory you carry.** Left to chance it is a coin flip — the loss in Chapter 9 was just a few coins that trended *against* the inventory the flow forced on the book. **Chosen, it is a position** — and a market maker who can choose its carry has turned its single largest risk into its single largest potential alpha.

This is not exotic. It is exactly how real dealer desks run an **"axe":** when a desk wants to build (or shed) a position, it quotes tighter and larger on that side and wider and smaller on the other. It is the bridge between **flow capture** (pure market making) and **alpha capture** (a directional bet). Done well it is a *better entry than simply buying* — you earn the spread + the rebate (+ maybe funding) **while** you build the position. A paid, or negative-cost, accumulation.

## 11.2 The mechanism — the axe, in math you already have

The beauty of this is that it changes **one term** in the Avellaneda-Stoikov reservation price you learned in [§3](03-avellaneda-stoikov.md). The neutral quoter skews its reservation toward inventory **zero**:

$$
r = \text{mid} - q\cdot\gamma\sigma^2(T-t) \qquad\text{(skew toward 0 — the neutral maker)}
$$

The directional ("axed") quoter skews toward a **target** inventory `q*` instead:

$$
q^\* = b\cdot Q_{\max}, \qquad r = \text{mid} - (q - q^\*)\cdot\gamma\sigma^2(T-t) \qquad\text{(skew toward } q^\* \text{)}
$$

where `b ∈ [−1, +1]` is the **house view** (bullish `b>0`, bearish `b<0`) and `Q_max` is the max inventory. Read what that one substitution does:

```
   neutral maker (q* = 0)          axed maker, bullish (q* = +0.4·Q_max)
   ─────────────────────────      ──────────────────────────────────────
   q below 0 → lean to BUY         q below q* → lean to BUY  (build toward target)
   q at 0    → quote symmetric     q at q*    → quote symmetric (REST here, recycle spread)
   q above 0 → lean to SELL        q above q* → lean to SELL  (trim back to target)
```

At `q = q*` the skew is zero, so the book **rests at the target**, quoting symmetrically around it and recycling the spread — exactly the accumulate-and-hold-the-view behaviour you want. Below target it leans to buy; above it leans to sell. An optional **conviction drift** `r += b·θ·σ·mid` nudges *both* quotes toward the view so you fill slightly more on the view side even at target (keep `θ` small — it is the knob that pays a touch of spread for momentum).

The result is **four aligned income streams** instead of two:

$$
\text{net} = \underbrace{\text{spread}}_{\text{maker edge}} + \underbrace{\text{rebate}}_{\text{structural floor}} + \underbrace{\text{directional carry}}_{\textbf{the new alpha}} + \underbrace{\text{funding}}_{\text{paid side}} - \underbrace{\text{adverse}}_{\text{cost}}
$$

The directional-carry term is what we used to call "luck." Here it is a deliberate, sized, stop-gated position — and the P&L attributor from [§6.9](06-backtesting.md#69-pl-decomposition) already isolates it, so we can *see* whether the view, not chance, is paying. Crucially, **`b = 0` reproduces the neutral GLFT quoter bit-for-bit** — the directional behaviour is strictly additive and switchable, the same swap-seam discipline as everywhere else.

So far this sounds like free money. It is the opposite, and the next three sections are why.

## 11.3 A bias is alpha — and unvalidated alpha is a leveraged way to lose

Here is the trap, stated as a law:

> **A blind bias is just a leveraged way to lose.** The moment you rest the book at a non-zero `q*`, you have taken a directional position. If your view is no better than a coin flip, you have simply added leverage on noise to a book that was previously market-neutral — and you will lose *faster and with more conviction* than before.

So a bias `b` is not a free knob — it is an **alpha**, and it must clear the same honesty bar as any stat-arb signal *before* it is allowed to size carry. The desk built an explicit OOS gate (`scripts/directional-bias-oos.ts`) that asks one precise question: **does the candidate signal predict the FORWARD return?** Not "is it a good carry harvest," not "does its sign persist" — does leaning the book on it *make money on the move*. The method, which you should recognise from the stat-arb course:

1. **No look-ahead.** The signal at bar `t` uses data up to `t` only (a *trailing* funding mean, a *trailing* momentum return). The label is the realised **forward** log-return `log(P_{t+h}/P_t)`.
2. **Effect size = information coefficient.** Spearman (rank) IC of `corr(signal, forward return)` is the headline (robust to fat tails).
3. **Purged k-fold + embargo**, with the embargo *widened to cover the forward horizon* so a multi-bar forward label cannot leak into a neighbouring fold — the real leakage source in a forward-return study.
4. **Deflated Sharpe.** You are testing `coins × signals × horizons` trials, so the best raw IC is selection-biased upward. Report the **Deflated Sharpe** (PSR against `E[max Sharpe]` over the full trial count, deflated by the cross-trial dispersion). **Report the deflated number, not the best raw one.**
5. **Verdict.** `VALIDATED` only with ≥30 pooled OOS observations, a *positive* OOS direction-P&L **and** Spearman IC, **and** Deflated Sharpe ≥ 0.95. Anything less is `INCONCLUSIVE` (re-test on more data) or `NOT_VALIDATED` (**stand aside — `b=0`**).

The gate as a decision — every `coin × signal × horizon` trial runs this gauntlet, and the *default exit is "stand aside":*

```
   candidate bias  b
        │
        ▼
   [ forward-return IC ]──── low / negative ───▶  NOT_VALIDATED → b = 0  (the default)
        │ positive
        ▼
   [ purged k-fold + embargo ]   (no leakage across the forward horizon)
        │
        ▼
   [ deflated Sharpe ]──── < 0.95 ───▶  INCONCLUSIVE → b = 0  (re-test on more data)
        │  ≥ 0.95   AND   ≥ 30 pooled OOS obs
        ▼
   VALIDATED → size a TILT:  |b| = clamp(4·|IC|, 0, 0.5)      (a lean, never a max bet)
```

Even when a signal validates, the position it earns is a *tilt*, not a max bet: the magnitude cap `|b| = clamp(4·|IC|, 0, 0.5)` keeps even a strong one-window read well below full inventory. **Research proposes, the book expresses, the attribution judges — no view leans the book on conviction alone.**

## 11.4 The cautionary tale, in three measured acts

This is the part the textbooks skip. We *ran* the directional maker before the gate was strict, and the data taught the lesson the hard way. Read these as a unit — they are why the discipline in [§11.6](#116-the-defensive-desk-the-fixes-that-actually-bind) and [§11.7](#117-how-to-actually-run-it-the-doctrine) is non-negotiable.

**Act 1 — a blind bias on a weak window doubled the loss (monotonically).** We applied an *arbitrary* long bias to the 8h sub-second tapes (which happened to drift only +0.3–0.6%, choppy). The net got monotonically worse with conviction:

```
   desk net vs blind long bias (8h choppy window)     loss ◄────────────
   b = 0.0  (neutral)     −$7.2k    ██████████████┤
   b = 0.5                −$12.9k   █████████████████████████┤
   b = 1.0  (max long)    −$15.1k   █████████████████████████████┤
```

The mechanism worked *perfectly* — net moved monotonically with bias, proving the book really does accumulate the position. That is exactly the point: **a working accumulation engine pointed at a non-edge is a loss amplifier.** The +0.4% drift was nowhere near enough to pay for the inventory bled through the chop. This is the design's prediction, not a bug.

**Act 2 — the one "validated" signal was a knife-edge, not an edge.** We ran the OOS gate on real Hyperliquid history (180d × 1h). The first run (**88 trials**) produced *exactly one* survivor: **BTC, funding-paid-side, 168h horizon — IC 0.133, +121.7 bp/obs, Deflated Sharpe 99% → VALIDATED, cap +0.39.** Encouraging. Then we re-ran it having added a single coin (**108 trials**) — and **BTC fell to `INCONCLUSIVE` (DSR 0.36).** Same IC, same Sharpe; the *only* thing that changed was that one more trial raised the multiple-testing bar past it.

> **A finding that flips when you test one more thing was never robust.** BTC was sitting *on* the deflated-Sharpe boundary, not above it. (The coin that "validated" in the bigger run, ARB at DSR 1.0, had fold ICs of `[−0.10, 0.40, 0.52, −0.11, 0.65]` — two negative folds, wild swings: a single 180-day downtrend that funding happened to track, i.e. leverage on one trend, not a stable predictor.)

The methodology fix this forced is worth more than the result: **pre-register the coin/signal/horizon universe before the run.** Do not expand the sweep ad hoc and keep the survivors — that is how you manufacture an edge out of multiple-testing noise. (And note: momentum, the prior favourite, was *dead* here — short-horizon ICs were *negative*, i.e. reversal. This is exactly why you validate instead of guess.)

**Act 3 — turning every book directional lost 15× more.** The decisive run. We set **all eight books directional** with a live self-gating flow bias, fast path on, fully persisted — ~89 minutes, \$8M deployed. It was the worst run on record:

```
   per-book net P&L, all-directional run (~89 min, $8M)   loss ◄──┼──► gain
                                                                  0
   SOL    −$5,286   ████████████████████████████┤        maxDD 6.5%
   BTC    −$2,486   █████████████┤
   ADA    −$2,486   █████████████┤
   SUI    −$1,579   █████████┤
   BNB    −$1,120   ██████┤
   XRP      +$147                ├▌
   DOGE     +$393                ├██
   ETH      +$794                ├████
   ─────────────────────────────────────────
   desk   −$11,623  =  −14.5 bps in ~1.5h   (vs −$788 with ONE static axe)
```

The split *is* the whole story: **unrealised −\$10,545 was the loss; realised was roughly flat (−\$1,236).** The three books that stayed near-flat **made money** (ETH/DOGE/XRP — positive realised, tiny unrealised, maxDD ≤ 1%). The five that **accumulated a large one-sided position and held it lost money** (SOL got billions of units long into a falling SOL → −\$3.7k unrealised, 6.5% drawdown). Ronnie's one-line read, which the data proves: **the spread engine is profitable; the position is where we bleed.**

## 11.5 The root cause — a 30-second alpha taking multi-minute risk

Why didn't the live self-gating bias save Act 3? Because the gate checked the *wrong horizon*. When we measured the flow signal's information coefficient against forward returns at several horizons (its markout), the pattern was unmistakable:

```
   flow-signal IC vs forward mid, by horizon  (Spearman; this run's own data)

   coin   30s     60s     5min    15min      ← signal VALID │ position HELD
   BTC   +0.19   +0.15   +0.01   −0.07              ●━━━━━━━┿━━━━━━━━━━○
   ETH   +0.17   +0.13   +0.03   +0.08              ●━━━━━━━┿━━━━━━━━━━
   XRP   +0.16   +0.16   +0.09   +0.24              ●━━━━━━━┿━━━━━━━━━━●
   SOL   +0.08   +0.04   −0.01   −0.12 ✗            ●━━━━━━━┿━━━━━━╳ flips negative
   SUI   +0.02   −0.00   −0.07   −0.15 ✗            ╳━━━━━━━┿━━━━━━╳ no skill, then anti-skill
            ▲                       ▲
       real edge here          no skill / NEGATIVE skill here
       (seconds)               (minutes — where we HELD the inventory)
```

The flow signal is a **real 30–60-second predictor** on the liquid majors — and it **decays to zero or flips negative by 5–15 minutes.** But the inventory the signal built was held for *many minutes to the whole session.* We used a **30-second alpha to take multi-minute inventory risk.** At the horizon where we actually carried the position, the signal had no skill or *negative* skill — so on the reversal coins (SOL, SUI) the book accumulated exactly the wrong way and held it into the reversal.

> **The lesson, sharpened:** a per-coin IC self-gate that checks the signal at its *own* (short) horizon will happily green-light a position you then hold *past* that horizon. **You must only deliberately hold inventory inside the window your signal is valid for.** A 30-second edge entitles you to a 30-second position, not a 90-minute bag.

## 11.6 The defensive desk — the fixes that actually bind

Act 3 produced a redesign, and the redesign's theme is **inventory-neutral defence first, directional bets second.** Four mechanisms, all built, all behind config (defaults are no-ops so nothing regresses):

**1. The inventory governor — the fix for the runaway position.** Reading the code revealed *why* SOL ran to billions of units: the bare Avellaneda-Stoikov skew is only **~2 bps at full inventory** (γσ²T with σ as a per-bar fraction is tiny) — far too weak to mean-revert — and *nothing physically stopped a book breaching its cap* (the clamp only bounded the skew math, not the fills). Two knobs fix it:

- **`inventorySkewMult`** scales the inventory-skew term *only* (not the half-spread), so the reservation actually *pulls* inventory back to flat/target instead of gently leaning.
- **`hardInventoryCap`** — at `|q| ≥ maxInventoryLots`, *parks the accumulating side at the max rail* so the book physically cannot add to the position; the other side keeps quoting to shed.

```
   without governor                with governor (cap + strong skew)
   q drifts ─────────────▶ ∞       q ──┐ pulled back hard
   (skew too weak to stop it)          └──┤ accumulating side PARKED at cap
   SOL → 6.2B units long           |q| can't exceed the rail (±overshoot ≤ 1 lot/requote)
```

**2. The adverse-selection defence (F3), now live.** This is the **width companion** to the micro-price **center** ([§9.3](09-the-fair-value-result.md#93-fix-1-quote-around-the-micro-price-not-the-mid)) — together they are the "don't get adversely selected" pair. Informed flow is *one-sided aggressor flow*, so scale the half-spread by **flow toxicity** `τ = |buy − sell| / (buy + sell)` relative to its rolling average: **tighten into calm, two-sided flow** (farm the rebate where it's safe) and **widen into a one-sided sweep** (exactly where you get picked off). The formula was already validated in the offline LOB replay; #40 ported it into the live fast engine via a shared `FlowToxicityScaler`. Note this uses the flow signal *defensively* (inventory-neutral), not as the directional bet that lost in Act 3.

**3. Price the hedge into the spread.** This is the conceptual fix Act 3 forced. Every unit you quote, you expect to **offload or hedge** — so the quoted half-spread must cover the hedge round-trip (the taker fee + half-spread on the hedge venue). A spread that does not price the hedge is **quoting at a loss on every fill.** When `|net delta|` exceeds a threshold, flatten with a taker hedge; and bake the modelled hedge cost into the quote. The measurement that says this is *the* fix, not a nice-to-have: in Act 3, desk **unrealised** was the entire loss column.

**4. The inventory time-stop (the direct kill for §11.5).** Any lot held longer than `T` (start `T ≈ 60s`, matched to the signal horizon) is offloaded at market. This is the structural enforcement of "only hold inventory inside your signal's valid window." (Built as the phase-B layer on the fast path; it needs taker plumbing, deliberately not rushed into an unattended run.)

## 11.7 How to actually run it — the doctrine

The redesign collapses into a short, binding operating doctrine. This is the chapter's takeaway if you remember nothing else:

1. **Default the desk to NEUTRAL spread-capture.** The neutral `mm-glft` substrate on the liquid keep-set is the steady-curve demo — *it works by staying flat.* All-directional is retired as a default; it is the proven loss mode (Act 3).
2. **Run the governor and F3 always.** Hard cap + strong skew + toxicity-scaled width are inventory-neutral defence — they cost nothing when calm and save you in a trend/sweep.
3. **Directional tilt only where the data licenses it:** a *pre-registered*, OOS-validated coin/signal/horizon (the §11.3 gate), sized to `|b| ≤ clamp(4·|IC|, 0.5)`, **never exceeding the desk's 2% drawdown budget.**
4. **Hold the tilt only inside the signal's valid horizon, time-stopped.** A 30-second edge → a ~60s-max, time-stopped position on BTC/ETH/XRP; *never* the reversal coins. A tilt that must be flat by 60s is not a held bag.
5. **Hedge the residual delta, and pay for it in the spread.**

**Judge a run by the right number.** Not "did the directional bet win" — by whether **unrealised P&L stays small** (inventory controlled: target `|unreal| ≤ 0.3 × |realised|`, vs Act 3's −\$10.5k unreal / −\$1.2k realised), per-book **drawdown ≤ ~1.5%** (vs SOL's 6.5%), and **no book exceeds its lot cap.** A steady, low-drawdown NAV curve from a flat spread-engine *is the demo*; the directional tilt is a small, time-stopped, validated add-on — **not** the engine.

## 11.8 Why this is worth doing at all

After three losing acts you could fairly ask why bother with the directional layer. The answer is the asymmetry it creates when done right, and it is genuinely beautiful:

- **You are paid to enter and cushioned if wrong.** Because you accumulate the position *via the maker* — earning the spread + rebate (+ funding when the held side is the paid side) on the way in — a right view pays the carry, and a *wrong* view is cushioned by everything you banked while building it. The payoff is **convex**: a cheap directional option financed by the maker edge. That is a structurally better trade than simply crossing the spread to buy.
- **It works even with no view.** When the desk simply *wants* a position (a treasury/mandate accumulation), building it via biased market making beats lifting the offer — you earn the half-spread + rebate on the way in instead of paying it. "We'll build your position and get paid to do it" is a real, low-risk product.
- **It gives the desk the one thing a bot lacks: a house view with a P&L attached to it.** The governance layer — the **Thesis Register** (a versioned, time-stamped, P&L-graded table of the desk's directional views, each gated by its own carry attribution and OOS IC) — is the research→trading→accountability bridge a real trading group has. Research proposes a thesis; the book expresses it as `q*` and the spread asymmetry; the attributor grades whether leaning on it actually paid, and *retires the ones that don't.* That loop — not any single bet — is the durable asset.

The throughline of the whole course returns here one last time: **the naive edge is an artifact and the honest edge is small.** Carry, left to chance, is noise that happens to have been negative on our windows. Carry, *chosen and governed*, is the desk's largest accountable alpha — but only because we built the machinery to tell the difference, and the willingness to publish the −\$11,623 that taught us where the line is.

!!! tip "The one line to remember"
    Inventory carry is the biggest lever you have. Left to chance it is the loss; **chosen, validated, time-stopped, and hedged** it is the alpha. Default neutral; lean only where the data licenses it, only inside your signal's valid horizon, and always price the hedge into the spread.

## 11.9 Sources

- The axed-maker design (target-inventory skew, conviction drift, the four-stream P&L, the risk controls, the phased plan) is the **Meridian desk's** `DIRECTIONAL_MM_STRATEGY.md` (2026-06-05). The dealer "axe" is standard OTC/dealer-desk practice; the **GK99** (Grinold & Kahn) alpha-blending and fundamental-law machinery underlies the bias combination.
- The OOS bias gate (forward-return IC, purged k-fold + horizon-widened embargo, deflated Sharpe ≥ 0.95, the `4·|IC|` cap) is `DIRECTIONAL_BIAS_OOS_RESULTS.md` (2026-06-07) and reuses the stat-arb course's `purged-kfold.ts` + `deflated-sharpe.ts`: the deflated Sharpe is **BLP14** (Bailey & López de Prado 2014, App. B.4) and the multiple-testing growth `√(2 ln N)` is **MLDP14**; purged k-fold + embargo is **MLDP18** (López de Prado 2018; sister course).
- The three cautionary acts are `QUANT_JOURNAL.md` entries **#33** (blind bias doubles the loss), **#35–#36** (the BTC funding knife-edge + the pre-registration fix), **#38** (the single static axe was the whole loss), and **#39** (the all-directional run; the per-book table and the markout-decay table are reproduced from it). The defensive-desk fixes are **#40** (the inventory governor + F3 live + the hedge-in-the-spread argument). Consolidated in `RESEARCH_FINDINGS.md §6` and `PNL_ACCOUNTING.md`.
- The inventory-skew and hard-cap mechanics build directly on **AS08** ([§3](03-avellaneda-stoikov.md)) and the §3.12 practical tweaks; the toxicity-scaled width is the VPIN/flow-toxicity literature **ELO12** (Easley, López de Prado & O'Hara, 2012) applied to the live spread.

Full citations in [Appendix B](appendix-b-sources.md).
