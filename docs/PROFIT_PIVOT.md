# Profit Pivot — from passive MM (negative residual) to carry + cross-venue (positive residual)

> **Status:** PLAN / design document (2026-06-15). No code changed by this doc. It internalises the
> external MM-edge microstructure report (Journal #70) + our own ~10-run record and sets the new
> active direction. Implementation is sequenced in §6 and ships behind the usual swap-seam +
> realised-first + OOS-gate discipline (CLAUDE.md §7/§10.1).

---

## 0. The verdict that forces the pivot

Passive, voluntary, spread-capture market-making on Hyperliquid (and dYdX/Binance-class venues) is
**negative-EV by construction** for a participant with **no latency edge, no rebate-tier access, no
client flow, and a small balance sheet** — i.e. us. This is not an implementation bug. It is the
predicted equilibrium, and our own data is the proof:

- **~10 multi-hour runs (#41 → #68), every one realised-negative.** The loss is always the same two
  terms: **warehouse drift** + the **adverse-selection wedge** (our resting quote is stale by the
  time it fills).
- **BNB-solo (#69), the cleanest book isolated, sized up, hedged: ≈$0 realised (+$1 / 4 fills).** The
  best case is break-even, not profit — exactly what theory predicts when you strip every edge.

**Why (the report, condensed):** spread income exists *to pay for* adverse selection (Glosten-Milgrom).
The **residual** a market-maker is left holding is `realised_spread − adverse_selection − inventory_drift`.
Real MMs keep that residual positive only by holding one of a small set of edges. We hold **none** of them:

| Edge that flips the residual | Who has it | Us? |
|---|---|---|
| Fresher fair value via **latency/colocation** (HL validators are in AWS Tokyo; ~200ms geo gap; HL lags Binance ~100ms) | Tokyo-colocated firms w/ nodes | ❌ (we're ~200ms slow → we *are* the stale quote) |
| **Non-toxic / internalised flow** (PFOF) | Equities wholesalers (Citadel/Virtu) | ❌ (anonymous CLOB, on-average-informed flow) |
| **Balance-sheet scale** to warehouse + harvest funding | HLP, big MMs | ❌ at size, ✅ *in paper we can hold* (the one lever we DO have) |
| **Liquidation/vault franchise** (be the house) | HLP / GLP | ❌ as a quoter (only as a tail-bearing depositor) |
| **Token/airdrop subsidy** | airdrop farmers | ❌ (paper demo, no real token; HL Season 1 spent) |
| **Rebate tier** (−0.3bps, share-gated) | top-volume makers | ❌ (our −0.2bps is ~10× too small to cover adverse selection) |

We were running the **un-edged version of a game whose entire profit IS the edges.** So we stop
competing on the one axis where we're structurally short (speed-against-informed-flow), and pivot to
the edges we actually have.

---

## 1. What edge do we actually have? (the honest inventory)

**We have exactly two things the report says still pay:**

1. **Position-holding capacity.** In paper we can hold a delta-neutral position **indefinitely**, with
   no margin call and no funding-of-the-balance-sheet cost. Carry/basis trades reward *whoever can
   hold*, not whoever is fastest — a game we can actually play.
2. **A two-venue view.** We already run the **leading venue (Binance) as the global feed** *and* pull
   HL's book + both venues' funding. So we can compute a **fair value anchored to the price leader**
   and measure the **HL↔Binance basis** in real time — the raw material for both "stop being the stale
   side" and "harvest the basis/funding."

**We also have a built, audited system** (regime gate, governor, attribution/leak table, hedge,
realised-first review, the swap-seam discipline). The report's closing line is right: *the instrument
is reading true.* We don't rebuild it — we **re-point it** at carry/cross-venue, where the residual is
positive.

---

## 2. "Flip the residual" — the core concept (definition)

The **residual** is what's left after spread income: `− adverse_selection − inventory_drift`. For an
un-edged quoter it's negative — that's our whole P&L story. **Flipping it** means engineering the two
bleed terms into income instead of cost:

- **Flip the wedge (adverse selection):** it comes from quoting a **stale** fair value (HL's lagged
  book). **Anchor fair value to Binance** (the leader, ~100ms ahead) so our price already contains the
  information the counterparty has. *Honest limit:* we still can't win the cancel race, so for
  *quoting* this only shrinks the wedge — the bigger flip is to **stop quoting and act on the basis**
  (be the one who reads the leader, not the one who rests a stale quote).
- **Flip the drift (inventory):** holding a random-direction bag is a pure cost. Holding the
  **funding-positive side** is *income* — funding pays you to hold it. Bias inventory to the side the
  funding rate rewards and the warehouse term flips from cost toward carry.

**The full flip:** move the **core book from spread-capture (negative residual) to funding/basis carry
(positive residual from holding)**, using the Binance-anchored fair value as both the signal and the
center. That is the pivot in one sentence.

---

## 3. The new toolkit (proposed — specs, not code)

Each tool: *what it is · the edge it captures · existing code to reuse · the honesty gate · priority.*
Nothing here is built yet; this is the design.

### T1 — `CrossVenueFairValue` (the leading-fair-value engine) · **P1**
- **What:** a fair-value source that anchors to **Binance** (the price leader) and continuously
  measures `basis = hlMid − binanceMid` and the lead/lag. Replaces the HL-own-book micro-price as the
  truth reference.
- **Edge:** stops us computing fair value from HL's *lagged* book → shrinks the wedge; and it is the
  **signal** for T2/T4 (when HL is dislocated from the leader).
- **Reuse:** the global Binance feed (`FEED_SOURCE=binance`) + the HL L2 book we already poll;
  micro-price infra; `IPriceSource`/`IReferenceBarSource` seams.
- **Gate:** measure, don't trade, first — log `basis` + lead-lag and validate it matches the report's
  ~100ms before anything depends on it (pairs with T6).

### T2 — `FundingCarryBook` (delta-neutral funding harvest) · **P1 — the core new earner**
- **What:** long one venue's perp / short the other's (or long spot / short perp), **collect persistent
  funding**, hold past breakeven, roll. Delta-neutral ⇒ **no directional bet**; the edge is the carry.
- **Edge:** position-holding capacity (ours) + persistent one-sided funding. Journal #8 measured
  **+3–8%/yr on majors** (ETH 8.1%/yr, BTC 4.5%/yr on HL, funding persistently positive); the
  **HL↔Binance funding differential** is a second, cleaner spread.
- **Reuse:** `BinanceFundingClient`, `HyperliquidFundingClient`, `funding-carry.ts`, `staticCarry`,
  and the funding accrual **already wired into `MmBook` / `LobReplay`**. Add an `IFundingCarryStrategy`
  + `scripts/funding-carry-live.ts`.
- **Gate:** the **funding-persistence OOS gate** (the carry analogue of #5's cointegration-persistence
  test) — only harvest funding whose `posFrac` is stable OOS, not a one-window snapshot. Size to the
  **basis-variance budget** (#8: basis is the real risk, correlated across symbols, mean-reverts over
  time). Hold-past-breakeven (don't churn).

### T3 — Funding-aware inventory skew (`MM_FUNDING_SKEW`) · **P2 — flips the inventory residual**
- **What:** for any residual quoting we keep, bias the desk to **hold the funding-positive side**
  (positive funding ⇒ prefer net-short ⇒ warehouse drift offset by funding income).
- **Edge:** turns inventory carry from pure cost into a partially-funded position — the inventory half
  of "flip the residual."
- **Reuse:** the existing GLFT inventory skew (`inventorySkewMult`, the reservation skew) + the live
  funding rate already on the book snapshot.
- **Gate:** must not increase maxDD; A/B the realised inventory-carry term with/without the skew.

### T4 — `CrossVenueBasisArb` (dislocation capture, **slower-horizon**) · **P2**
- **What:** when `|hlMid − binanceMid|` exceeds fees + a margin (a **real** dislocation — vol spikes,
  listings, liquidation cascades — *not* the 100ms micro-noise), enter the basis (long cheap venue,
  short rich) and hold to convergence.
- **Edge:** the report is explicit — we lose the **sub-second** lead-lag arms race to Tokyo firms, but
  the **larger, slower dislocations** don't hinge on ~100ms and *are* accessible.
- **Reuse:** T1's basis signal + the paper venue + the existing hedge/position machinery.
- **Gate:** only fire above a fee+slippage threshold; cap holding time; measure convergence hit-rate.

### T5 — Liquidation-cascade detector → `CascadeReversion` (turn the tail into an edge) · **P3**
- **What:** detect the **JELLY pattern** (thin book + extreme one-way move + funding spike). (a) RISK:
  stand fully aside — never be the HLP-style inheritor of the toxic side. (b) OPPORTUNITY: after a
  forced-liquidation **overshoot**, be the **mean-reversion / convergence** side as the cascade exhausts.
- **Edge:** the desk's single biggest tail (liquidation cascades, per the report's JELLY case) becomes a
  controlled opportunity instead of a blow-up.
- **Gate:** strict size cap + the loss-stop; this is the most speculative tool — prove on replay first.

### T6 — Staleness-markout instrumentation (the wedge honesty gate) · **P2**
- **What:** record each fill's markout **as a function of the HL↔Binance lag at fill time** → quantify
  how much of our adverse selection is staleness vs genuine information.
- **Edge:** none directly — it's the **gate** that tells us whether T1's leading fair value actually
  reduces the wedge (so we don't re-make the MM over-claim).
- **Reuse:** `mm_fill_markout` (F0) + T1's basis series.

### T7 — `HLP-yield benchmark` (the bar to beat) · **P3**
- **What:** model depositing into HLP (the "house" return, ~15–30% APR with the JELLY left-tail) as a
  paper **benchmark**, not a strategy we operate.
- **Edge:** honesty — **if our active carry book can't beat passive HLP yield, the correct move is to
  deposit, not trade.** It sets the hurdle rate for everything above.

### T8 — Cut xyz / HIP-3 markets · **DONE (start-desk.sh)**
- HIP-3 stock/commodity perps run at **2× base fees, no rebate**, and need **expensive single-leg taker
  hedges** (BRENTOIL/PAXG) — the report's worst maker economics. Removed from the desk config; no xyz
  books, no xyz session gate, no xyz hedge legs.

---

## 4. Markets — new vs cut

**Lean in (carry/cross-venue friendly):**
- **Majors with persistent funding:** BTC, ETH (+ persistent-funding alts) — the #8 carry set.
- **The HL↔Binance funding *differential*** and **basis** on liquid pairs — the cleanest two-venue spread.
- **The operator's longer-horizon thesis fits HERE, not in perp quoting:** ILS/USDC, tokenized metals
  (PAXG/XAUT), FX crosses — these are **position-holding / basis** trades, the category the report says
  rewards balance-sheet/holding rather than speed.

**Cut:**
- **xyz / HIP-3** (2× fees) — done.
- **Naked alt pads** and **passive spread-quoting on illiquid alts** — the negative-residual game.

---

## 5. Honesty gates (so we don't repeat the MM over-claim)

1. **Funding-persistence OOS gate** — harvest only funding that *persists* OOS (stable `posFrac`),
   never a single-window read (#5/#8 discipline).
2. **Basis-variance budget** — basis is the real risk (#8): delta-neutral so no directional bet, sized
   to measured basis σ, rolled across cycles to average it.
3. **Realised-first, hold-past-breakeven** — funding is a *hold* trade (breakeven ~10–30d at
   maker/taker fees); judging it on churn would mis-read it.
4. **Beat the HLP benchmark (T7)** — the hurdle rate; below it, deposit instead of trade.
5. **STEP −1 coherence + tsc/jest** on every change (CLAUDE.md §10.1) — the discipline that the #68
   regression made binding.

---

## 6. Sequence

- **P1 (the pivot core):** T1 `CrossVenueFairValue` (measure-only first) → T2 `FundingCarryBook` with
  the persistence gate. This is the run that tests for the **first positive-residual P&L**.
- **P2:** T3 funding-aware skew · T4 cross-venue basis arb · T6 staleness instrumentation.
- **P3:** T5 cascade reversion · T7 HLP benchmark.
- Each tool: interface + mock + real (swap seam), realised-first, OOS-gated, one change per run.

---

## 7. What this pivot does and does NOT claim (honesty)

- **It does** move us from a **negative-residual** game (passive MM with no edge) to a
  **positive-but-thin** game (funding/basis carry, ~3–8%/yr gross with basis-variance risk) that
  **rewards the one edge we have — holding capacity** — and uses our two-venue view to stop being the
  stale side.
- **It does NOT** manufacture a latency, flow, scale, or subsidy edge. It **sidesteps** the need for
  them. If even funding/basis carry can't beat the HLP benchmark after honest costs, the truthful demo
  outcome is *"we conserve capital with tight DD; the accessible edge here is carry, and here is its
  honest size"* — which, per the mission (honesty is the whole game), is itself a result worth shipping.
