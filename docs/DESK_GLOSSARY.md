# Meridian Desk — The Lever & Variable Glossary

> **What this is.** One plain-English page that defines *every knob you can turn* and
> *every number you can read* on the desk — β, θ, γ, κ, σ, z-score, VPIN, the lot, the
> spread, the skew. If you saw a symbol on the `/demo` UI or in a launch form and
> thought "what is that and which way do I turn it?", it's here.
>
> **How to read an entry.** Each lever gets three things: **what it is** (the intuition,
> not the formula), **which way it moves the desk** (turn it up → what happens), and a
> **default**. Read §1 first — the whole desk hangs off one mental picture, and once you
> hold that picture every lever stops being a mystery letter and becomes an obvious dial.
>
> Companions: [CHEATSHEET.md](CHEATSHEET.md) is *commands*; [UI_ROLE_GUIDE.md](UI_ROLE_GUIDE.md)
> is *how to use each page*; this doc is *what the words mean*. The math lives in the
> courses (`courses/market-making`, `courses/stat-arb`) — cited per entry as e.g. *AS08*.

---

## 1. The one mental model (read this first)

The desk runs two businesses. Almost every lever belongs to one of them.

**Business A — Market making (the earner).** You post a price to *buy* (your **bid**) a
little below fair value and a price to *sell* (your **ask**) a little above it. When
someone trades against you, you pocket the gap — the **spread**. You're a shopkeeper: buy
wholesale, sell retail, repeat thousands of times. Two things can kill you:

1. **You quote off a stale price and get picked off.** Someone who knows the price is
   about to move buys your cheap ask right before it jumps. That's **adverse selection** —
   the single biggest leak. The fix is to center your quotes on a *fresh, fair* price (the
   **micro-price**) and re-quote fast.
2. **You pile up a one-sided position.** Buy, buy, buy and now you're long a heap of an
   asset that's falling. That's **inventory risk**. The fix is to **skew**: when you're
   long, quietly lower both your prices so you're more likely to sell than buy, nudging
   yourself back to flat. The dial that controls how hard you skew is **γ (gamma)**.

So the MM levers all answer three questions: *Where's fair value?* (micro-price), *How
wide do I quote?* (spread: γ, κ, σ), and *How do I not drown in inventory?* (skew, caps,
hedging, kill switches).

**Business B — Stat-arb (the diversifier).** You find two things that historically move
together (say two correlated tokens), build a combined "spread" that's supposed to be
stable, and bet that when it stretches it'll snap back. The levers: **β** (how to combine
the two legs so the spread is stable), **z-score** (how stretched it is right now), and
**entry/exit-z** (how stretched before you bet, how snapped-back before you take profit).

That's the whole game. Everything below is detail on those dials.

---

## 2. Greek-letter decoder (the 60-second version)

| Symbol | Said | In *this* desk it means | Turn it UP → |
|---|---|---|---|
| **β** | beta | **Hedge ratio.** Units of leg B per unit of leg A (stat-arb), or how an alt's risk maps onto a major (MM hedge map). | Bigger offsetting leg. |
| **γ** | gamma | **Risk aversion.** How much the maker hates holding inventory. | Skews back to flat harder **and** quotes wider. |
| **κ** | kappa | **Liquidity / order-arrival decay.** How quickly fills dry up as you quote away from mid. | *Tighter* base spread (fills are close-in). |
| **σ** | sigma | **Volatility.** Typical per-bar price wiggle, as a fraction. | Wider spread + harder skew (holding is riskier). |
| **θ** | theta | **A threshold on the flow signal.** ⚠️ *Not* options time-decay here. The flow-regime gate engages/releases at θ. | Desk reacts to one-sided flow later (less twitchy). |
| **δ** | delta | **(a)** Half-spread = distance from center to each quote. **(b)** "Delta" = the book's net directional exposure the hedge cancels. | (a) Quotes sit further out. |
| **q** | — | **Inventory**, in *lots*. Your signed position (1 lot = one quote size). `q*` = the *target* inventory for a directional book. | You're carrying more position. |
| **z** | z-score | **How stretched** the stat-arb spread is, in standard deviations from its mean. | Entry waits for a bigger stretch. |

> **The θ trap.** You asked specifically about theta. On an options desk θ is time-decay.
> **We don't trade that on the live desk.** Here every "theta" (`flowThetaEnter`,
> `flowThetaExit`, `hedgeFlowFreezeTheta`) is a *cut-off on the order-flow imbalance
> signal* — "how lopsided does flow have to get before I react." If you see θ, think
> **"trigger level," not "time decay."**

---

## 3. Market-making levers — where you set them

On `/demo` → **◆ Market making** panel, you pick a **Quoter** and the form renders one
input box per tunable param (these are the `mmp-*` fields). Those boxes are exactly the
knobs below. Server-wide defaults live in `AppConfig.marketMaking`
([app-config.interface.ts](../src/config/app-config.interface.ts)).

### 3a. Where is fair value? (the anti-pick-off knobs)

| Lever | Plain meaning | Up → | Default |
|---|---|---|---|
| **Micro-price depth** (`microPriceDepth`) | How many order-book levels per side to size-weight into "fair value." Centering on this instead of the raw mid is the **biggest adverse-selection cut** (*−21%*). It leans the center toward the heavier side of the book. | More levels averaged in (smoother, slightly slower). `0` = fall back to the stale mid. | 5 |
| **Reservation price** *(read-only concept)* | The actual center your bid/ask are built around: fair value **shifted by your inventory skew**. Long inventory pushes it *below* mid so you lean toward selling. This is the steering wheel, not a knob you type into. | — | derived |
| **Fast re-quote** (`fastRequoteMs`) | How often (ms) the book refreshes its quotes against fresh L2. Sub-second cadence is what flipped a losing book to net-positive (*−$1,020 → +$133*). | More often = fresher, but more cancel/replace churn. | 750 |

### 3b. How wide do I quote? (the spread knobs)

| Lever | Plain meaning | Up → | Default |
|---|---|---|---|
| **γ — risk aversion** (`gamma`) | How much the maker fears inventory. The master MM dial. | Skews to flat **harder** and widens the spread. Too high = you quote so wide you never fill; too low = you hoard risky inventory. *AS08.* | 0.0025 |
| **κ — arrival decay** (`kappa`) | How fast fills dry up as you back away from mid — i.e. how deep/liquid the book is. | **Tighter** base spread (liquidity is close-in, no need to reach). Lower κ → you can sit wider and still get hit. | 2 |
| **σ — volatility** (`volWindowBars`, `volFloor`) | The asset's recent wiggle, measured over `volWindowBars` and floored at `volFloor` (so a flat warmup never gives a zero spread). | Wider spread + harder skew — holding anything is riskier when the price is jumpy. | window 60 bars |
| **Half-spread floor / cap** (`minHalfSpreadBps`, `maxHalfSpreadBps`) | Hard rails (in bps of price) on how tight or wide a single quote may sit, regardless of what the model wants. Floor = venue tick / cost floor; cap = a seatbelt against a vol blow-up. | Floor up = never quote tighter than this. Cap down = never quote wider than this. | — |
| **Horizon** (`horizonBars`) | The "time left in the session" the inventory-risk term assumes. A tuning constant on the live desk, not a real clock. | Treats inventory as riskier → wider + harder skew. | — |

### 3c. How do I not drown in inventory? (the position knobs)

| Lever | Plain meaning | Up → | Default |
|---|---|---|---|
| **Max inventory — lots** (`maxInventoryLots`) | The position ceiling, counted in lots (1 lot = one quote size). At the cap the desk refuses the side that would grow the position. | Allowed to carry more before it slams the brakes. | — |
| **Max inventory — notional %** (`maxInventoryNotionalFrac`) | Same ceiling but as a *fraction of book capital at the live price* — fairer across assets (4 lots of BTC ≠ 4 lots of DOGE). `0` = use the raw lot count. | Bigger position allowed. | 0 (off) |
| **Hard inventory cap** (`hardInventoryCap`) | When at the cap, physically *park* the adding side at the rail so it can't breach — a belt over the soft skew. | on/off | off |
| **Inventory-skew multiplier** (`inventorySkewMult`) | Mean-revert inventory toward flat *harder* without widening the spread. `1` = textbook AS. | Position snaps back to flat faster. | 1 |
| **Inventory spread-skew** (`inventorySpreadSkew`) | A σ-independent lean: tighten the *shedding* side, widen the *adding* side, ∝ how full you are. Catches calm trends where the σ²-based skew is too weak. | Stronger one-sided lean against piling up. Typical 0.3–0.5. | 0 (off) |
| **Concentration soft / hard / gain** (`concSoft`, `concHard`, `concSkewGain`) | GLFT controls: past `concSoft` (% of cap) ramp the skew and shrink the adding side; past `concHard` stop quoting the adding side entirely (**reduce-only**). `concSkewGain` = how much extra skew at full ramp. | Defends against concentration sooner / harder. | off |

### 3d. The safety gates (when to stop quoting)

| Lever | Plain meaning | Up → | Default |
|---|---|---|---|
| **Max drawdown %** (`maxDrawdownPct`) | The kill switch. If NAV falls this far below its peak, **stop quoting** (drawdown-gate → Deny). The mission is minimum drawdown, so this is sacred. | More rope before it halts. | — |
| **VPIN pause** (`vpinPauseThreshold`, `vpinPauseMs`) | **VPIN** is a 0–1 *toxicity* gauge — how one-sided/informed the recent flow is. Above the threshold, **pause** quoting for `vpinPauseMs` and let the toxic burst pass. Default 1.01 means "gauge only, never pause" until you arm it below 1. | Threshold up = more tolerant of toxic flow. | 1.01 (off) |
| **Loss-stop** (`lossStopFrac`, `lossStopCooldownMin`) | For *unhedged* books: if the paper loss on current inventory exceeds `lossStopFrac × capital`, flatten at market and stand aside for the cooldown. Caps the *loss a position can realise* (the inventory cap only limits its *size*). | Bigger loss tolerated before flattening. | 0 (off) |
| **Maker fee** (`makerFeeBps`, **signed**) | Fee per fill in bps. **Negative = a rebate = you get paid to provide liquidity** (Hyperliquid is −0.2 bps). This is structural edge, not a cost. | More positive = a fee you pay; more negative = more rebate revenue. | venue-set |

### 3e. The fancier modes (usually off by default)

| Lever | Plain meaning | Default |
|---|---|---|
| **Directional bias** (`bias` / `q*`, `fundingBiasSymbols`, `flowBiasLive`, `dirSpreadSkew`, `dirSingleSideBias`) | The **"axed" maker**: instead of resting at flat, rest at a *target* inventory `q* = bias × maxLots` — a deliberate lean long/short. Only enabled where a signal passed the OOS honesty gate (funding-carry on **BTC** today). A *blind* bias loses money — it's leverage on noise — so neutral (bias 0) is the default everywhere else. | neutral |
| **Toxicity widen** (`f3Toxicity`, `f3MinScale`, `f3MaxScale`) | Multiply the live half-spread by how toxic flow is vs its rolling average: tighten in calm (×0.5), widen into informed flow (×3.0). | off |
| **Flow-regime gate** (`regimeGate`, `flowTheta*`, `flowEwmaAlpha`, `flowPersist*`, `flowDwellMs`, `flowLambda`) | The **F4 throttle** — watches the flow-imbalance EWMA and graduates the book NORMAL → DEFENSIVE (widen + cut the toxic side) → FLATTEN-ONLY when one-sided flow *persists*. **θ_enter / θ_exit** are the engage/release thresholds (hysteresis); θ_high is the flatten escalation. `off` by default. | off |
| **Quote anti-churn** (`requoteMinBps`, `requoteDwellMs`, `requoteUrgentBps`) | Don't cancel/replace a resting quote for a *tiny* price drift — you'd lose your place in the FIFO queue. Hold through drift below `requoteMinBps` for at least `requoteDwellMs`; but always chase a real move ≥ `requoteUrgentBps`. | off |
| **Time-stop** (`timeStop`, `timeStopAgeMin`, `timeStopShiftBps`) | Bound how *long* you hold: once inventory ages past `timeStopAgeMin`, nudge the quotes toward the exit side to work it off. Helps trend-warehousing, hurts choppy flow — so it's per-run. | off |
| **Session / event gates** (`sessionGate`, `eventBlackout`) | Quote only inside a time window (e.g. equity books only during US market hours; outside is pure pick-off) / go flat around scheduled events. | off |

### 3f. The delta hedge (earn the spread, drop the bet)

| Lever | Plain meaning | Default |
|---|---|---|
| **Delta hedge** (`deltaHedge`) | Hold a paper perp leg that **cancels each book's net directional exposure** ("delta"), so the desk keeps the market-making spread edge but sheds the up/down bet. | off |
| **Hedge band** (`hedgeBandUsd`, `hedgeBandMap`) | Only rebalance the hedge when leftover |delta| exceeds this many USD — stops you churning the hedge on every tick. | — |
| **Hedge β-map** (`hedgeBetaMap`) | Maps each book's symbol to `{ underlying, beta }` so a basket of alts is hedged by *one* major perp leg (β = how much major per unit alt). Empty = each book self-hedges 1:1. | self |
| **Hedge costs** (`hedgeTakerBps`, `hedgeHalfSpreadBps`, `hedgeCostSpreadMult`) | The honest price of hedging: taker fee + half-spread crossed per rebalance, and how much of that round-trip you pre-charge into the maker spread. | — |

### 3g. Taking sides — the regime directional book

A separate book (not the market-maker) that **takes an outright position** — long or short — when a *validated* view is strong, and sits **flat** the rest of the time. It is the desk's "take sides" strategy: conservative by construction, managed inside the same engine (same accounting, same honesty gate, same event tape), only ever betting on a *statistically obvious* signal. Spec: [REGIME_DIRECTIONAL_BOOK.md](REGIME_DIRECTIONAL_BOOK.md).

| Term | Plain meaning | Default |
|---|---|---|
| **Regime** | Which "weather" a market is in right now — is funding persistently paying one side, is the cross-venue basis calm or blown out, is volatility quiet or spiking. A *regime change* is the weather flipping (the BNB carry going from paying to costing, Journal #72). | — |
| **Consensus bias** | The "take sides only when signals agree" gate: we lean the book **only when several independent, individually-OOS-validated signals (funding + trend + flow) point the same way**. Any disagreement → stand flat. This is what makes the bet *obvious* rather than a hunch. | ≥2 agree |
| **Conviction sizing** | How big the position is scales with **how strong + how trustworthy** the signal is: weak or barely-validated view → tiny (or zero) position; strong, high-IC view → bigger (still capped). Low conviction collapses to flat. | bias × base |
| **Directional stop** | The risk-averse backstop: if the position loses more than a set % of its notional (default ~2%), **flatten immediately** — a wrong view is cut, never ridden. It fires *before* any slow signal-decay exit. | 2% |
| **Decay-to-flat** | A view that fades below the exit band, flips sign, or loses its validation is **exited to flat** — you don't hold a position the signal no longer supports. (Hysteresis: it holds through the in-between band so it doesn't churn.) | — |
| **Stand-aside** | The regime monitor says "not now" (basis blowout, vol spike, stale feed) → **no new entry, flatten what's open**. The single switch that turns a regime *change* into a defensive action. | — |

---

## 4. Stat-arb levers — the pairs desk

On `/demo` → **▶ Launch a station** and the **Strategy signal** panel. Defaults live in
`AppConfig.live`; strategy params in
[bollinger-pairs-strategy.ts](../src/stat-arb/strategies/bollinger-pairs-strategy.ts).

| Lever | Plain meaning | Up → | Typical |
|---|---|---|---|
| **β — hedge ratio** (`beta`, the `lx-beta` box) | How many units of leg B to short per unit of leg A so the *combined* spread is stationary (mean-reverting). β 1.5 = short 1.5 ETH per 1 BTC. Auto-filled from the cointegration fit (Engle-Granger); the UI shows where it came from. | A heavier short leg. Wrong β → the "spread" isn't stable and the edge is fake. | from fit |
| **z-score** *(read-out)* | How many standard deviations today's spread sits from its rolling mean. The whole entry/exit signal is "is z big?" | — | — |
| **Entry-z** (`entryZ`) | Enter once |z| ≥ this — the spread is stretched enough to bet on a snap-back. | Waits for a *bigger* stretch → fewer, higher-conviction trades. | 2.0 |
| **Exit-z** (`exitZ`) | Take profit once |z| falls back to this — the spread has reverted. | Holds longer for fuller reversion (more risk it re-stretches). | 0.5 |
| **Lookback** (`zLookback`, the "Lookback (h)" box; `lambda`) | The rolling window (or EWMA decay) used to compute the mean & σ the z-score is measured against. | Smoother, slower-adapting mean. | — |
| **Half-life** *(read-out)* | How many bars the spread takes to revert *halfway* to its mean — the **speed of the edge**. Short = fast, tradeable; long = sluggish, fragile. | — | — |
| **p-value** *(read-out, `pValue`)* | The cointegration test's significance — the odds the pair's stability is a *coincidence*. Low p = genuinely cointegrated. `pValueGate` blocks entries when the live fit drifts above it. | — | < 0.05 good |
| **σ spread** *(read-out)* | Standard deviation of the spread — sets the z-score scale and the edge-per-trade in bps. | — | — |
| **Lots / leg** (`notionalUnits`) | Per-leg trade size in USDC (6-dec units). The "sizes every trade" box at the top sets the desk-wide default. | Bigger bet per trade. | — |
| **Max drawdown %** (`maxDrawdownPct`) | Same role as the MM kill switch — block new entries past this NAV drop. | More rope. | — |

---

## 5. The numbers you *read* (not set)

These appear in the attribution panels and the books table. They're how you tell whether
the desk is actually working — and the desk's entire reason to exist is that these stay
**honest**.

| Readout | What it tells you |
|---|---|
| **P&L attribution — 4 buckets** ([pnl-attribution.ts](../src/market-making/backtest/pnl-attribution.ts)) | The most important readout on the desk. Net P&L is split into: **(1) Spread captured** — gross earned vs fair mid at fill; **(2) Adverse selection** (+ = a loss) — how far the mid moved *against* you right after the fill; **(3) Inventory carry** — mark-to-market drift on what you were *already* holding; **(4) Fees** (− = rebate revenue). Two books can show the same net while one earns clean spread and the other earns spread and bleeds it all back to adverse selection — a worse business. Always read the split, never just the net. |
| **NAV / navRatio** | Equity. `navRatio = NAV ÷ peak NAV`: 1.0 = at the high-water mark, below 1 = in drawdown. The drawdown gate fires off this. |
| **Max drawdown (maxDD)** | Worst peak-to-trough equity drop over the run. **The mission metric** — minimise it; a low-drawdown, steady curve *is* the demo. |
| **Sharpe** | Return per unit of risk (volatility). Higher = smoother earner. |
| **Deflated Sharpe / PSR** | Sharpe *discounted for how many strategies we tried*. If you test 1,000 random ideas, the luckiest looks great by accident; deflated-Sharpe / PSR strip that luck out so a number you trust survives. This is the survivorship/honesty gate. |
| **VPIN** | Live 0–1 flow-toxicity gauge (see §3d). A rising VPIN = you're more likely being picked off right now. |
| **Risk verdict** (Allow / Pause / Deny) | The composite gate's live call: **Allow** = quote; **Pause** = hold resting quotes, place none, for N ms (toxic burst); **Deny** = pull quotes / flatten (cap breach, drawdown kill, manual kill). |

---

## 6. "I see X on the screen — where do I look?"

- **A Greek letter (β θ γ κ σ δ q z)** → §2, then the detailed entry in §3/§4.
- **A box in the ◆ Market-making launch form** → §3 (it's an `mmp-*` field = a quoter param).
- **A box in the ▶ Launch-a-station form** → §4 (stat-arb).
- **A number in a results / attribution panel** → §5 (you read it, you don't set it).
- **An env var in `.env` / a run command** (`MM_REGIME_GATE`, `MICRO_PRICE_DEPTH`, …) →
  it's the same lever as its `AppConfig.marketMaking` field here; the mapping is in
  [app-config.factory.ts](../src/config/app-config.factory.ts).

If a term you saw isn't here, it's worth adding — tell me the word and I'll slot it in.
This page is meant to be the thing you reach for *first* when the system feels like it's
getting away from you.
