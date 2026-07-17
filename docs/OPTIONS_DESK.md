# The Long-Horizon Options Desk (LHO) — strategy plan + training program

> **Status: ADOPTED as the design (2026-07-17). No runs this session — this is the desk
> blueprint + the training program.** It extends [PROFIT_PIVOT_II.md](PROFIT_PIVOT_II.md):
> M3 (the VRP satellite) grows from one daily-straddle book into a full **long-horizon
> options desk** — the third desk next to carry (M1/M2) and the probability desk.
> The training program is **[courses/options-desk/](../courses/options-desk/)** — chapter
> map in §7. Paper-only, per the mission (CLAUDE.md §1).

---

## 0. The verdict up front

The desk already owns the three hard things an options desk needs and has been sitting on
them: a **Black-Scholes/Greeks engine validated line-by-line against Deribit** (#12), a
**measured, distribution-validated variance risk premium** (BTC +5.9 vol pts, ETH +3.7;
short-vol won **86.3% of 117 rolling 24h windows**, #42), and a **live Deribit chain
client** (`src/derivatives/deribit/`). What it lacks is exactly what the carry review
(PROFIT_PIVOT_II R6) said: **books**. The E6 `VrpBook` is the v0 — one gated daily
straddle. This plan turns the seam into a desk.

The desk's identity is **not** market-making and **not** short-horizon trading. It is
**long-horizon options investing**: holding periods of **weeks to months**, positions
chosen so that the *structure* — not reaction speed — carries the risk discipline. Three
franchise lines:

1. **Income** — get paid the variance/skew premium with defined or collateral-bounded
   risk (the wheel, delta-hedged strangle ladder).
2. **Insurance** — buy the drawdown bound the mission demands, and account for its cost
   honestly (collars, the tail budget).
3. **Efficiency** — free capital with synthetics and hand it to the carry desk (the
   cross-desk trade nobody else can do).

Every book below has entry/exit **rules**, a Greeks budget, a collateral rule, and a
pre-registered metric. The binding doctrine from the ORV lesson (#96) applies desk-wide:
**calibration before capital** — every book runs scored-paper (signals + would-be fills
logged and scored per cycle) before it sizes past token capital.

---

## 1. Why options for the long horizon (what we already know, not theory)

- **The VRP is our own measurement, not a paper citation.** #12: BTC ATM IV 37.1 vs RV
  31.2 = +5.9 vol pts; ETH +3.7; short-straddle Θ ≈ $110/day/contract. #42: across 117
  rolling 24h windows over 30 days, long gamma cleared its premium in only 13.7% —
  the short-vol side won 86.3%. That result was filed as "gamma insurance is expensive";
  its positive content — **sellers of optionality get paid persistently** — was never
  given a desk. This plan is that desk.
- **The gate discipline already works at this horizon.** #96: the VRP gate sat out all
  night when iv−rv ran −2…−15 pts. Doctrine #5 (no edge → no position) transfers
  unchanged; what changes is cadence (daily decisions, not per-tick).
- **Structures replace speed.** At MM horizon the risk control is re-quoting in
  milliseconds. At months, the risk control is *chosen at entry*: a credit spread's max
  loss is fixed the moment it's filled; a collared core cannot breach its floor. This is
  "conserve equity first" implemented in the instrument itself — ideal for a desk whose
  product is a low-drawdown paper curve.
- **Long-horizon options are latency-insensitive**, which means the maker-execution
  service (E2) is the natural entry path, same as carry: rest inside the quoted option
  spread, escalate on timeout, measure implementation shortfall in **vol points**.

**Honest constraints, stated up front:** Deribit BTC/ETH options are **inverse
(coin-settled)** — premium and P&L accrue in coin; the paper books convert at mark and
must state it (the v0 `VrpBook` precedent). Long-dated wings are **thin** — 10Δ 180d
quotes can be 2–5 vol pts wide; the cost model charges **half the observed quoted spread
at that strike/tenor from our own chain snapshots**, never a flat fee assumption. And at
a monthly cycle, "≥20 OOS trades" = 20 months — the standard gate is unusable, so §4
defines the slow-strategy gate that replaces it.

---

## 2. The strategy catalogue (the books, O1–O7)

Sleeve sizes are fractions of the LHO desk NAV (itself a sleeve of desk capital via the
E7 allocator, §3). All shorts are **fully collateralized** — no portfolio-margin
assumption anywhere (the R9a lesson): a short put is cash-secured, a short call is
covered by inventory, a strangle is sized to its stress loss.

### O1 — The Wheel (cash-secured puts → covered calls) — BTC, ETH
*The income workhorse: VRP harvesting with an inventory-acceptance mechanism.*

- **Entry:** sell a **30d ~25Δ put**, cash-secured, when BOTH: (a) the VRP gate is open
  at tenor — IV(30d, 25Δput) − EWMA-RV ≥ **3 vol pts** — and (b) 25Δ put skew ≥ its
  rolling 90d median (you only sell puts when the smile pays you for it).
- **Management:** buy back at **50% of max profit** or roll at **7 DTE**, whichever
  first. Assigned (paper-settled ITM) → inventory flips long coin at strike → sell
  **30d ~25Δ calls** against it (same gate, call wing) until called away. Never sell a
  call below net acquisition cost minus collected premium (no locked-in loss).
- **Size:** contracts = ⌊sleeveCash / strike⌋; sleeve cap 30% of LHO NAV.
- **Risk:** the left tail is *owning coin at the strike in a crash* — bounded because
  it's cash-secured (max loss = strike − 0, the same as spot ownership) and by the sleeve
  cap; the desk stress test (§3) sizes it.
- **Pre-registered metric:** cycle premium-capture ≥ 55% of collected premium retained
  across ≥ 12 scored cycles, and assignment episodes recover to net-positive within 2
  covered-call cycles at the 25th percentile.

### O2 — The Collared Core — BTC
*The mission rendered as a structure: a long core that cannot breach its floor.*

- **Structure:** long 1 BTC-equivalent core; **buy 90d 10Δ put** (rolled at 30 DTE);
  **finance by selling 30d 25Δ calls** (rolled monthly, same no-locked-loss rule as O1).
- **The point:** max peak-to-trough of the structure is **bounded by the put floor by
  construction**. This is the demo's showcase curve — the drawdown bound is provable at
  entry, not hoped for.
- **Pre-registered metric:** realised max DD ≤ the put-floor bound (a construction check
  — any breach is a book bug); net carry cost of the collar reported as an explicit line
  (expected: −2 to −6%/yr on the core — the honest price of the floor; the AQR
  literature and our own smile both say the put wing is the expensive one).
- **Size:** 20% of LHO NAV.

### O3 — The VRP Ladder (delta-hedged short strangles, 7d/14d/30d) — BTC, ETH
*E6 grown up: the daily straddle becomes a tenor ladder with a vega budget.*

- **Entry per rung:** sell a **20Δ strangle** at tenor T when IV(T) − EWMA-RV ≥
  threshold(T): 3 pts (7d), 4 pts (14d), 5 pts (30d) — longer tenor demands more premium
  because the hedge-error variance grows with T. Strangles, not straddles, past 1d:
  less gamma near ATM, same vega story.
- **Hedge:** band delta-hedge with the paper perp (the existing E6 machinery,
  `hedgeBandFrac` per rung); hedge fees charged at taker.
- **Risk:** per-rung hard loss stop (the E6 `maxLossBudgetUsd` pattern) + a **ladder vega
  budget**: |net vega| ≤ 0.4% of LHO NAV per vol point. The #42 fat tail (the 13.7% of
  windows) is bounded by budget, never by forecast.
- **Blocked on:** the **EWMA RV fix** (#96 — the 04:00 window artifact; already the
  NEXT-SESSION item 3). The ladder inherits the fixed estimator; it does not ship before it.
- **Pre-registered metric:** premium capture net of hedge costs > 0 in ≥ 60% of scored
  cycles per rung; a rung that fails 2 consecutive scored months is cut.
- **Size:** 20% of LHO NAV (this is the M3 "≤20% satellite" mandate, unchanged).

### O4 — Term-Structure Carry (calendars) — BTC
*Sell the rich front, own the cheap back — the futures-carry trade in vol space.*

- **Signal:** z-score of the **7d/30d ATM IV ratio** against its own rolling
  distribution from our surface tape (§5, O-0). Enter short front-straddle / long
  back-straddle (vega-ratioed ≈ √(T_back/T_front) so net vega ≈ 0) when z ≥ +2;
  unwind at z ≤ 0 or front expiry.
- **The R7 lesson applies verbatim:** the trigger comes from the **measured
  distribution**, not an a-priori number — which is why this book is blocked on ≥ 30
  days of surface tape before its threshold is even set.
- **Pre-registered metric:** distribution first (does the 7d/30d ratio mean-revert with
  σ > cost?), trade second. If the measured spread is sub-cost, the honest verdict is
  "calendar carry is not accessible at our cost" — filed, not forced.
- **Size:** 10% of LHO NAV, defined vega, both legs same underlying.

### O5 — Skew Harvest (credit verticals on the rich wing) — BTC, ETH
*The smile mean-reverts at the extremes; trade it defined-risk only.*

- **Signal:** 25Δ risk-reversal (put IV − call IV) z-score on the 90d rolling surface
  tape. |z| ≥ 2 → sell a **credit vertical on the rich wing** (puts rich: sell 25Δ put /
  buy 10Δ put; calls rich: mirror). Not naked risk-reversals — **max loss is fixed at
  entry** (width − credit), which is what makes this book long-horizon-safe.
- **Exit:** 50% of credit or z back through 0.5; hold through expiry allowed (defined
  risk means expiry is not an emergency).
- **Pre-registered metric:** same as O4 — distribution measured first from the tape;
  win-rate × credit vs loss-rate × (width − credit) positive over ≥ 15 scored signals.
- **Size:** 10% of LHO NAV in max-loss terms (sum of width − credit ≤ sleeve).

### O6 — The Tail Budget (convexity overlay) — desk-wide
*Not an earner. The insurance line that lets O1/O3 size up and caps the desk's crash P&L.*

- **Structure:** permanent ladder of **90–180d 10Δ puts**, budgeted at **1.0%/yr of LHO
  NAV** (a pre-registered *cost cap*, spent evenly; never a P&L target).
- **Monetization rule (mechanical, no discretion):** when a put marks ≥ **4× cost**, sell
  it and re-strike at 10Δ same-tenor (roll down/out). Proceeds return to the sleeve.
- **Honesty rule:** reported as an explicit insurance-cost line on the tear-sheet every
  cycle — the demo must show what the floor costs, not bury it. Expected steady-state:
  −1%/yr drag, large positive prints only in crashes.
- **Interaction:** the §3 stress test credits O6's convexity, which is exactly what
  permits the O1/O3 short-vol sleeves at their caps. Remove O6 → their caps halve.

### O7 — The Synthetic Core (capital efficiency) — BTC
*Deep-ITM long calls replace delta-one core; the freed cash earns funding carry at M1.*

- **Structure:** replace the delta-one core with **90d+ 80Δ calls** (LEAPS-style stock
  replacement). Capital freed ≈ (1 − optionPrice/spot) ≈ 70–80% of core notional →
  routed to the **M1 funding-carry desk** through the E7 allocator.
- **The measured question:** is (embedded financing cost of the call + roll cost +
  tracking error) < (funding carry earned on freed cash)? Both sides come from our own
  books — this is the one strategy only a multi-desk shop can even evaluate.
- **Pre-registered metric:** 90d tracking error vs delta-one core ≤ 1.5% AND net
  (carry earned − synthetic cost) > 0, measured over 2 roll cycles scored-paper.
- **Size:** up to 20% of LHO NAV as the synthetic; freed cash counted in M1's sleeve.

---

## 3. The portfolio layer (what makes it a desk, not seven scripts)

- **Greeks budget (desk-level, hard):** |net vega| ≤ 0.5% NAV per vol point; net gamma
  bounded below (short-gamma cap, credited for O6's long wings); net theta reported
  (it's the earnings engine, not a limit); net delta ≤ 5% NAV (the perp hedge + O2/O7
  cores net out). Checked at every mark; a breach pauses new entries desk-wide
  (the `CompositeRiskGate` pattern).
- **Stress-as-sizing (the P11 pattern, extended):** the sizing arbiter for every sleeve
  is the scenario grid **{spot −30%, −15%, +15%, +30%} × {IV ×2, ×1.5, ×0.75}** marked
  through the validated pricer. Rule: worst-cell desk loss ≤ **2% of desk NAV**. Sleeve
  caps in §2 are *initial* values; the stress grid is the binding one.
- **Collateral model:** every book fully collateralized as stated in §2; sleeve cash is
  segregated per book in the paper ledger. No netting benefit is assumed between books
  (conservative by construction; portfolio-margin realism is a parked refinement).
- **The allocator:** LHO becomes the **fourth sleeve of E7** (core carry / M2 / VRP-now-LHO
  / sleeves), initial fixed weight ≤ 20% of desk capital — M3's mandate carries over to
  the whole desk until the scored-paper record earns more.
- **Persistence + tape:** same spine as everything else — `mm_nav` namespace
  `desk='options'`, DeskEvents for every entry/roll/assignment/monetization, tear-sheet
  per book, watchdog + alerts. No new infra concepts.

---

## 4. The slow-strategy validation gate (replaces DSR/20-trades at this horizon)

The stat-arb gate (DSR ≥ 0.95, ≥ 20 OOS trades) is arithmetic nonsense at monthly
cycles — 20 independent trades = ~2 years. The LHO gate, pre-registered per book:

1. **Distribution before trigger (R7).** Any threshold (skew z, calendar z, VRP pts) is
   set from ≥ 30 days of our own surface tape, never a priori.
2. **Scored-paper before capital (the ORV doctrine, #96).** Every book logs signal,
   would-be fill (at half observed spread), and cycle outcome — **premium-capture
   accounting**: retained/collected per cycle for income books; realised-vs-bound checks
   for structure books. Token capital only after the book's pre-registered scored-cycle
   metric (§2) passes.
3. **Block-bootstrap the tail.** For short-vol sleeves: resample our own IV/RV history
   in weekly blocks (the #42 window method, extended to tenor) → the loss distribution
   the loss-stops and the stress grid are checked against. The claim "the stop bounds
   the tail" must be shown on resampled paths, not asserted.
4. **Structural bounds verified as construction checks.** Defined-risk books (O2, O5)
   have provable max loss; the gate asserts the *book code* enforces it (a spec, §10.1-2)
   — a breach in paper is a bug, not a drawdown.
5. **The benchmark hurdle (T7's sibling):** the LHO curve is rendered next to (a) spot
   BTC buy-and-hold and (b) the T7 HLP curve. If collared-core + income doesn't beat
   spot risk-adjusted (return/maxDD), the honest demo says so.

---

## 5. The build map (almost all assembly — the E-chain, extended)

| # | Item | What it is | Reuses |
|---|---|---|---|
| **O-E1** | **Surface tape** (`iv-surface-collector`) | hourly ATM IV per tenor {7,14,30,90d} + 25Δ/10Δ wing IVs + quoted spreads + EWMA-RV, via md-plant (Deribit vertical exists, #98) | `DeribitClient.optionChain`, md-plant topics, tape persistence |
| **O-E2** | **EWMA-RV estimator + spec** | the #96 fix; shared by every gate here | `vrp-live.ts` RV path |
| **O-E3** | **`OptionPosition` / `MultiLegBook`** | one position model for all seven books: legs, collateral, marks through `IOptionPricer`, assignment/settlement, DeskEvents | `VrpBook` (generalize), `InventoryBook` avg-cost pattern |
| **O-E4** | **Scored-paper harness** | the calibration-before-capital logger + premium-capture scorer (the `orv-calibration.ts` pattern pointed at options cycles) | `calibration-score.ts`, maker-sim fill logic for spread-aware would-be fills |
| **O-E5** | **Stress grid sizing** | the §3 scenario grid as a pure module consulted by every entry | P11 stress harness, `blackScholes` |
| **O-E6** | **Books O1–O7** | thin strategy classes over O-E3, in dependency order (§6) | everything above |
| **O-E7** | **Desk runner + launcher** | `options-desk-live.ts` + supervised launcher, `desk='options'` nav namespace | `carry-desk-live.ts` shape, launch-*.sh pattern |

**Explicitly NOT building:** an American/exotics pricer (Deribit BTC/ETH options are
European — BS is correct); a vol-surface *model* (SVI etc. — we trade quoted points, we
don't interpolate exotic strikes); intraday options MM (different desk, killed context);
equity options (no wired data source — a researcher item if ever).

---

## 6. Phases (each with a pre-registered metric; no phase starts before its blocker)

- **Phase O-0 — the tape (no capital).** O-E1 + O-E2 + specs. **Metric: ≥ 14 days of
  continuous surface tape** (≥ 30 for the z-score books). This phase gates everything;
  it is also the only phase that can start today.
- **Phase O-1 — the ladder (E6 grown up).** O-E3 + O-E5 + O3 scored-paper. **Metric:
  ≥ 60% positive scored cycles per rung over 14 cycles** → token capital.
- **Phase O-2 — income + the floor.** O1 + O2 launched at token size, O6 overlay on.
  **Metric: O1 capture ≥ 55%; O2 DD-bound construction check clean; O6 cost within
  budget.** This trio is the demo's showcase: income + a provable floor.
- **Phase O-3 — relative value.** O4 + O5, thresholds from the ≥ 30d tape. **Metric:
  measured distributions clear costs before any trade; then per-book §2 metrics.**
- **Phase O-4 — efficiency + the allocator.** O7 + LHO as the E7 fourth sleeve.
  **Metric: O7's net (carry − synthetic cost) > 0 over 2 scored roll cycles.**

Operating rules carry over from PROFIT_PIVOT_II §4: winners get the hours; a failed
pre-registered metric halts its chain; no infra-only sessions while zero books accrue —
**the carry desk's 30d run and the M2 board remain the desk's first accrual priority;
LHO Phase O-0 is a background collector, not a competitor for run-time.**

---

## 7. The training program — `courses/options-desk/`

Third course, same charter as the other two (flat voice, citation discipline, no equity
curves as proof). "Long-Horizon Options — A Working Course": every chapter = what it is
/ math sketch / when it works & breaks / code shape / sources.

| Ch | Title | The desk book it trains |
|---|---|---|
| 0 | Charter & sources | — |
| 1 | What long-horizon options investing actually is | the desk mandate |
| 2 | The pricing engine — BS, Greeks, put-call parity, inverse options | O-E3, the validated engine |
| 3 | The variance risk premium — the structural edge | O3 gate; #12/#42 as the worked example |
| 4 | Selling puts & the wheel | O1 |
| 5 | Collars — buying the drawdown bound | O2 |
| 6 | Delta-hedged short vol — hedging error, bands, the ladder | O3 |
| 7 | The term structure — calendars & rolldown | O4 |
| 8 | Skew — the smile as a tradable object | O5 |
| 9 | Tail hedging — the honest cost of insurance | O6 |
| 10 | Capital efficiency — synthetics & stock replacement | O7 |
| 11 | Portfolio construction — Greeks budgets & stress-as-sizing | §3 |
| 12 | Validating slow strategies — the gate problem | §4 |
| 13 | The Meridian options desk — the build map | §5/§6 |
| A/B | Code shapes / source notebook | — |

Served same-origin at `/courses/options-desk/…` via the D2 allow-list (wired this
session); site build is the operator's Netlify flow, same as the other two.

---

## 8. Honest caveats

- **Every number in §2 that isn't cited to a journal entry is a design prior**, not a
  measurement — thresholds get re-set from the O-0 tape (that's the point of Phase O-0).
- **The #42 result is 30 days of 24h windows** — strong for a desk measurement, thin for
  a strategy at 30d tenor. The ladder's longer rungs lean on the bootstrap (§4.3) and on
  scored-paper time, which cannot be compressed.
- **Coin-settlement:** paper books convert at mark; a violent move makes the coin-vs-USD
  accounting gap material. State it on the tear-sheet like the v0 VrpBook does.
- **Thin wings are the real cost.** If O-0's quoted-spread tape shows 10Δ 90d wings at
  4+ vol pts wide, O2/O6 economics degrade materially — that finding would be *reported,
  and the books resized or shelved*, not overridden.
- **This desk earns slowly by design.** Its contribution to the demo is the *shape* of
  the curve (floors, bounded tails, steady theta), not headline return. If the scored
  record says the premium net of costs is smaller than #12 measured, the demo says that.
