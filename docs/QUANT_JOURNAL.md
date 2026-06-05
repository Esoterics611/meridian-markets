# Quant Journal — Meridian Markets stat-arb desk

> Running research log. **How to use:** read the latest dated entry first — it
> has the current state + next actions. Append, never overwrite. Method for the
> role + tooling is in [QUANT_ROLE.md](./QUANT_ROLE.md). Raw run data is in
> `docs/research/*.json`; reproduce with `scripts/quant-research.ts`.
>
> Standing caveat on every number below: these are **in-sample, multiple-tested**
> (we scan ~80–90 cointegrated pairs/class and report the top few), **gross of
> borrow/funding**, and **pre-impact** at the stated per-leg notional. Treat as
> hypotheses to validate OOS, not P&L promises.

---

## 2026-06-01 — Entry #1: position sizing truth + first cross-asset value board

**Hypotheses going in:** (a) "bigger size → smaller fee" (desk intuition); (b)
stat-arb is unprofitable after fees ("fee drag dominates", prior diagnosis).

**Method:** `scripts/quant-research.ts` — pull real Binance klines, discover
cointegrated pairs per asset-class preset, backtest the strategy catalogue ×
entry-z × **bar interval**, net of 5 bps/leg (HistoricalReplayVenue). Two windows:
**1m × 1000 (~17h)** and **15m × 1000 (~10.4 days)**, the latter re-run at a
realistic **$25k/leg** (balanced 25% of a $100k book). Raw:
`docs/research/2026-05-31-22-{18,21,28}-quant-research.json`.

### Finding 1 — position size is a RISK lever, not an alpha lever (intuition #a is FALSE)
Under flat % fees, gross P&L and fees both scale linearly with notional, so
**net edge in bps and Sharpe are size-invariant.** Proven empirically (sizing
study, GRT/NEAR): $25k → +$3,916 · $250k → +$39,162 · $2.5M → +$391,616 — exactly
×10/×100, while **edge/trade = 313 bps and Sharpe = 1.00 stay flat.** Fees are a
*percentage of notional* — a bigger trade pays a proportionally bigger fee. "Big
size, tiny fee" only holds if there's a **fixed** commission; we have none.

What *does* cap size is **market impact** (∝ N²). For GRT/NEAR (15m ADV ≈ $22.7k/
bar), the impact-optimal per-leg notional is **N\* ≈ $89k** (net after impact ≈
$6,960); beyond it, impact eats more than half the marginal edge. So a $100k book
is roughly the right scale *for this liquid pair* — thinner legs cap far lower
(at 1m, ARB/OP's N\* was ~$133). **Surfaced in the UI:** Research → ⚖ Position
sizing & fee economics, and `POST /api/market-data/sizing-study`.

### Finding 2 — bar interval is the biggest free profitability lever (intuition #b is conditionally FALSE)
Same strategy, same pairs, only the bar changes:
- **1m (~17h):** best config +$11.6 (eth pairs-ewma), edge/trade ~19 bps; most
  classes 0 trades (fee gate stands aside) or net-negative; OU bled (−$143…−$213).
- **15m (~10d):** the board flips positive. Slower bars grow σ-per-trade while the
  ~20 bps round-trip fee is fixed, so **edge/trade clears the floor with margin**
  (65–79 bps on the good classes). The prior "fee drag dominates" diagnosis was a
  **1m artifact** — it does not generalise to 15m.

### Finding 3 — where the value is (15m, $25k/leg, net of fees, ~10 days)
| Class | Strategy | eZ | trades | net $ | edge/trade | Sharpe | win% | pairs +ve |
|---|---|---|---|---|---|---|---|---|
| **eth-ecosystem** | pairs-zscore | 2.5 | 16 | **+2,614** | 65 bps | **3.16** | 83% | **4/4** |
| eth-ecosystem | pairs-zscore | 2.0 | 23 | +2,537 | 44 bps | 1.71 | 88% | 4/4 |
| eth-ecosystem | ou-bertram | · | 23 | +1,563 | 27 bps | 1.62 | 79% | 4/4 |
| ai-data | pairs-zscore(-wide) | 2.0 | 23 | +4,549 | 79 bps | 0.37 | 70% | 3/4 |
| gaming-meta | pairs-zscore | 2.5 | 20 | +1,551 | 31 bps | 0.33 | 65% | 4/4 |
| l1-smart-contract | pairs-zscore-wide | 2.5 | 18 | +1,573 | 35 bps | 0.65 | 76% | 3/4 |
| **crypto-majors** | (everything) | — | — | ≈0 / negative | <3 bps | ~0 | ~50% | — |

- **Consistency winner = eth-ecosystem z-score @ eZ 2.5** (ARB/STRK, IMX/STRK,
  ARB/OP, ARB/IMX): Sharpe 3.16, **every pair positive**, 83% win. This is the
  "nice consistent profits over days" candidate.
- **ai-data** makes the most dollars but is lumpier (Sharpe 0.37) — fewer, fatter,
  higher-variance reversions.
- **crypto-majors does NOT pair-trade profitably** after fees at any interval/
  entry tested — the legs are too co-integrated-but-tight (low σ-spread). Stop
  hunting there.

### Finding 4 — the new strategies (shipped this session) validated
- `pairs-zscore-selective` / `pairs-zscore-wide` (wider band + stiffer fee gate):
  match baseline on clean classes (the gate doesn't bind at eZ2.5), and **add real
  value on noisy classes** — e.g. gaming-meta @ eZ1.5: selective **+$1,294 vs
  baseline +$608** (the 2× fee gate skipped the sub-fee entries). Confirmed: the
  fee gate is alpha on noisy universes.
- `ou-bertram-throttled` (price the *true* 20 bps, not 8 bps): **mixed** — cut the
  bleed on crypto-majors (−816 → −186) and payments, but **hurt** l1 and ai (it
  also skips good trades). Verdict: pricing cost higher is not a uniform fix; OU
  needs a **time-stop** instead (queued). Kept in the catalogue, not a default.

**Decisions:**
- SHIP (catalogue): `pairs-zscore-selective`, `pairs-zscore-wide`,
  `pairs-ewma-conviction`, `ou-bertram-throttled` — all live-capable, deployable
  from the UI/scan.
- DEPLOY CANDIDATE for a consistent book: **eth-ecosystem z-score @ eZ 2.5**, and a
  diversified basket of the 4/4-positive configs above, vol-targeted. **Blocked
  on OOS validation** before treating the Sharpe as real.
- KILL: crypto-majors pair-trading; `ou-bertram-fast` (overtrades, deep losses at
  both intervals); EWMA at eZ1.5 on most classes (net-negative).

**Next actions (top of the backlog):**
1. **OOS / walk-forward on real history** for the eth-ecosystem eZ2.5 basket —
   plumb `ReplayEngine` into `/api/stat-arb/research/*` (today it's synthetic) +
   add a train/test split to the harness. *Gate before any "it's profitable" claim.*
2. **Risk-parity allocator**: auto-launch the fee-clearing pairs sized ∝ 1/σ_spread
   for a smooth daily curve (breadth > size).
3. **Maker execution** for stat-arb entries (reuse MM infra) — would cut the ~20 bps
   floor toward zero and re-open crypto-majors + 1m.
4. **Time-stopped OU** (`maxHoldBars`) — the right fix for OU overtrading.
5. **Data hygiene**: `defi-bluechip` + `stablecoin-peg` presets collapse to 0
   aligned bars (sparse/late-listed tickers); fix the harness/`alignMany` to drop
   the offenders, then re-scan those classes.

---

## 2026-06-01 — Entry #2: slippage shipped (P0.1) — and it flips the ranking

**Change:** `HistoricalReplayVenue` now models **half-spread + linear market
impact** (λ·notional/ADV), charged on every fill (BUY pays up, SELL receives
less), defaulting off for back-compat. The harness value board + `/api/market-
data/backtest` now run **net of fees + 2 bps half-spread + 10 bps impact/
participation**. Re-ran 15m/$25k/leg: `docs/research/2026-05-31-22-43-*.json`.

**The result is a sharp, honest reversal — liquidity decides what survives:**

| Class | Strategy | eZ | Pre-slippage net | **Post-slippage net** | edge/trade | Sharpe | +ve |
|---|---|---|---|---|---|---|---|
| **ai-data** | pairs-zscore | 2.0 | +$4,549 | **+$4,460** | 71 bps | 0.35 | 3/4 |
| ai-data | pairs-zscore | 2.5 | +$1,691 | +$3,074 | 68 bps | 0.37 | 3/4 |
| **eth-ecosystem** | pairs-zscore | 2.5 | +$2,614 (Sh 3.16!) | **≈ −$270 / marginal** | — | — | — |
| (most other configs) | — | — | small + | **negative / sub-fee** | — | — | — |

- **eth-ecosystem — the Entry-#1 "consistency winner" — was largely a frictionless
  artifact.** Its legs (ARB/STRK/IMX/OP) are thin; at $25k/leg the impact term
  (notional/ADV) is large and eats the edge. *Sharpe 3.16 → gone once you pay to
  cross + move the book.* This is the single most important lesson of the session:
  **a backtest without slippage overstates exactly the thin-leg pairs that look
  best, and they're the ones that don't survive size.**
- **ai-data survives** (GRT/WLD/RENDER/NEAR are more liquid → smaller impact). It's
  now the top class by net $ — but Sharpe is only ~0.35 (lumpy), so "nice
  consistent profits over days" is **not yet proven post-cost**. Honest state:
  there is net edge after realistic costs on the liquid alt-dispersion classes,
  but not yet a clean high-Sharpe book.

**Decisions:**
- The value board is now the honest one; treat Entry-#1's eth-ecosystem numbers as
  superseded. **New deploy candidate: ai-data z-score @ eZ2–2.5**, sized to its
  impact-optimal lots (run the sizing study per pair; thin legs cap hard).
- Liquidity (ADV) is now a first-class screen: prefer classes whose legs absorb
  $25k+/leg without large impact. Add an **ADV/impact column to the scanner**.
- Still **blocked on OOS** (Entry-#1 next-action #1) before any "profitable" claim.

**What this proves about the roadmap:** P0.1 (slippage) was correctly the top
gate — it changed the answer, not just the precision. Next gate: **real-history
OOS + deflated-Sharpe**, then **maker execution** (which would cut the spread/
impact this entry just showed is decisive).

---

## 2026-06-01 — Entry #3: walk-forward on REAL history shipped (P0.2)

**Change:** the walk-forward harness now runs on **real Binance history with a
true train/test split** — `POST /api/market-data/walk-forward` (+ a "Walk-forward
(real OOS — active pair)" button in Research). Until now the research tools ran on
the *synthetic* feed (shape, not numbers). Two things make it honest:

1. **β is re-fit on each TRAIN window only** (Engle-Granger on the train slice),
   then applied **out-of-sample on the next TEST window** — no peeking forward.
   The catalogue tuning (entryZ/exitZ/zLookback) stays frozen.
2. Every fill is **net of fee + half-spread + market impact** (the P0.1 cost
   model), priced **per slice** — the replay venue sees only the slice it fills.

The headline is the **avg TEST Sharpe** + **share of positive test windows**; the
report also surfaces **`sharpeDegradation` = avg train Sharpe − avg test Sharpe**
(the in-sample optimism we were flying blind to) and **β per window** so β drift /
sign-flips (a sign the "spread" isn't stable) are visible at a glance.

**Mechanics that mattered:** the harness's `venueFactory` had to become
slice-aware — a single replay venue over the full series mis-prices every window
past the first (it maps each fill's bar index *within the slice* to a price). And
`strategyFactory` now receives the train slice so β-on-train is structural, not a
caller convention. Backward compatible: the synthetic endpoint's no-arg factories
still type-check.

**Status of the deploy candidates:** Entry #2 left **ai-data z-score @ eZ2–2.5**
as the post-slippage survivor but flagged it "**blocked on OOS**." That gate now
exists. Next run logs the real walk-forward numbers for that basket here — until
then, treat its in-sample Sharpe as an upper bound, as before. *Verified this
session via the controller/harness unit tests (the real `walkForward` +
`HistoricalReplayVenue` + Engle-Granger run end-to-end; only the bar source is
faked); the live numbers come from running it against Binance on the desk.*

**Next actions (top of the backlog):**
1. **Run the real walk-forward on the ai-data eZ2–2.5 basket** and record
   avg-test-Sharpe / positive-window-share / degradation here. *This is the
   "is it actually profitable OOS?" answer the whole P0 frontier was gating.*
2. **Multiple-testing correction (P0.3):** deflated Sharpe + purged k-fold — we
   scan ~80–90 pairs/class and the walk-forward still judges a *pre-selected*
   pair, so discount the headline Sharpe for selection.
3. **Borrow/funding on the short leg (P0.4):** a per-bar carry cost on the short
   notional — still missing, still optimistic for the short side.
4. **Maker execution** — the lever that would cut the spread/impact Entry #2
   showed is decisive (re-opens crypto-majors + 1m).

---

## 2026-06-01 — Entry #4: the gate's verdict + the multiple-testing haircut (P0.3/P0.5) — candidate KILLED

**Shipped (P0.3 + P0.5):** the OOS gate now (a) **deflates the Sharpe for
selection bias** — `deflatedSharpe`/PSR over the # of pairs scanned (Bailey &
López de Prado), (b) offers **purged k-fold** CV (interior folds, purge+embargo)
as an alternative to sequential walk-forward, and (c) reports **regime coverage**
(days/bars/splits) + a survivorship caveat. All in `POST /api/market-data/walk-
forward` (`cv`, `trials`, `folds` params) and the two Research "real OOS" buttons.

**Closed the flag — ran the gate on the standing candidate.** `scripts/oos-
candidates.ts` (DB-free, live Binance) pulled **30 days × 15m** of the ai-data
universe (2,880 aligned bars/symbol), discovered **19 cointegrated pairs**, and
walk-forwarded each (25 windows, β re-fit/window, net of fee+spread+impact, $100k/
leg). Verdict on **every** pair: **INSUFFICIENT** — none clears the bar.

| pair | eZ | OOS trades | pooled OOS Sharpe | pos-win | OOS PnL | PSR | DSR (÷19 trials) | verdict |
|---|---|---|---|---|---|---|---|---|
| AR/TAO | 2.5 | 6 | 0.78 | 0% | +$4.2k | 95% | 95%* | INSUFFICIENT |
| WLD/RENDER | 2.5 | 8 | 0.55 | 0% | +$5.7k | 97% | **0%** | INSUFFICIENT |
| AR/TAO | 2.0 | 16 | 0.36 | 4% | +$6.2k | 91% | **68%** | INSUFFICIENT |
| GRT/TAO | 2.5 | 6 | 0.40 | 0% | +$2.2k | 85% | 85%* | INSUFFICIENT |
| (the other 14) | — | 3–18 | mostly **negative** | 0–8% | mostly **−** | ≤46% | ~0% | INSUFFICIENT |

\* PSR/DSR look high only because expectedMaxSharpe collapses to 0 when there's no
across-window Sharpe dispersion (≤6 trades) — the **n<20 gate** is what's binding.

**The finding (this is the headline):** **the "ai-data z-score @ eZ2–2.5" deploy
candidate does NOT survive OOS.** Three independent reasons, each fatal:
1. **Too few OOS trades.** At 15m × entryZ≥2, reversions are rare — 30 days yields
   only **3–18** out-of-sample trades per pair. You cannot trust a Sharpe on that.
2. **The selection haircut bites.** WLD/RENDER's 0.55 pooled Sharpe (PSR 97%!) is
   exactly the kind of number that looks tradeable until you remember it's the
   best of **19** scanned pairs — **DSR 0%**. Deflation is the difference between
   "97% confident" and "indistinguishable from luck."
3. **Entry #2 was a 10-day artifact.** Over 30 days the top cointegrated ai-data
   pairs are TAO/THETA, AR/TAO, AR/THETA — **not** the GRT/WLD/RENDER/NEAR set
   Entry #2 named. The candidate pairs aren't even stable across window length.

**Decision (desk doctrine — conserve equity, don't trade on noise):**
- **KILL the ai-data z-score deploy candidate.** No book goes live on it. Entry
  #1/#2's ai-data numbers are superseded — they were in-sample / 10-day / pre-
  haircut. Nothing on the desk currently clears the OOS gate.
- **This is a "need more data" outcome, not a "no edge" one.** The binding
  constraint is OOS *trade count*. To actually judge a 15m reversion you need
  enough OOS trades → **6–12 months of history** (P0.5 is now the live blocker),
  and/or **baskets** that pool trades across many pairs, and/or **higher trade
  frequency** (lower interval / maker fills to beat the fee floor).

**What the P0 frontier proved (P0.1→P0.3+P0.5 working together):** costs + real
OOS + a multiple-testing haircut + a coverage check turned an apparent +Sharpe
in-sample edge into an honest, documented **"not validated — insufficient data."**
That is the whole point of the gate, and it just earned its keep.

**Next actions:**
1. **More history (P0.5):** backfill **6–12 months** of 15m (the loader paginates;
   `historicalKlines` already handles it) and re-run the gate — the *only* way to
   get a trustworthy OOS trade count at this interval.
2. **Baskets over single pairs:** a vol-targeted basket of the fee-clearing pairs
   pools OOS trades → enough n to actually deflate honestly (and breadth > size,
   per doctrine).
3. **Maker execution / lower interval** to lift trade frequency without paying the
   ~20 bps taker floor.
4. (Deferred) **P0.4 borrow/funding** on the short leg.

---

## 2026-06-01 — Entry #5: the cointegration cliff is universal — ai-data KILLED, stablecoin-peg is the only structural spread

**Setup.** Entry #4 left ai-data "INSUFFICIENT — need 6–12 months of 15m." The
research scripts reach Binance directly from this desk (DB-free, no server), so I
went and got the history and settled it — then asked whether the failure is
ai-data-specific or universal.

### Step 1 — settle ai-data on real long history (`scripts/oos-candidates.ts`)
Terminal (one run per horizon):
```
OOS_PRESET=ai-data OOS_DAYS=30  OOS_INTERVAL=15m OOS_ENTRY=2.0,2.5 npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
OOS_PRESET=ai-data OOS_DAYS=90  OOS_INTERVAL=15m OOS_ENTRY=2.0,2.5 npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
OOS_PRESET=ai-data OOS_DAYS=180 OOS_INTERVAL=15m OOS_ENTRY=2.0,2.5 npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
OOS_PRESET=ai-data OOS_DAYS=365 OOS_INTERVAL=15m OOS_ENTRY=2.0,2.5 npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
```
UI: Research → backtest/scan an ai-data pair (sets the active pair) → **↻ Walk-forward (real OOS)**.

| horizon | cointegrated pairs | OOS verdict |
|---|---|---|
| 30d  | 19 | INSUFFICIENT — 3–18 OOS trades/pair (Entry #4) |
| **90d**  | 4  | **all NOISE** — pooled OOS Sharpe −0.5…−1.6, OOS PnL −$36k…−$128k @ $100k/leg, in-sample optimism (degradation) **1.8–24 Sharpe**, DSR 0% |
| 180d | 0  | no stable cointegration |
| 365d | 0  | no stable cointegration |

The 90d row is the verdict: with **enough OOS trades to actually judge (24–53/pair)**,
every pair *loses money out-of-sample* and the train→test degradation is enormous —
textbook overfit. **ai-data z-score pair-trading is KILLED.** Entry #4 read it as
"blocked on data"; the data now exists and **rejects** it. Supersedes the ai-data
numbers in Entries #1/#2/#4.

### Step 2 — is the failure universal? (`scripts/cointegration-stability.ts`, new + durable)
Runs the *same* discovery gate (p<0.6, maxHalfLife 240 bars) across every preset ×
{30,90,180}d and persists the map.
Terminal:
```
STAB_HORIZONS=30,90,180 STAB_INTERVAL=15m npx ts-node -r tsconfig-paths/register scripts/cointegration-stability.ts
# → docs/research/2026-06-01-14-09-cointegration-stability.json
```
UI: no button yet — **handoff item**: wire a "cointegration-persistence" column into ⊹ Scan.

| class | 30d | 90d | 180d |
|---|---|---|---|
| crypto-majors | 41 | 13 | **0** |
| ai-data | 18 | 4 | **0** |
| l1-smart-contract | 38 | 18 | **0** |
| eth-ecosystem | 22 | 5 | **0** |
| gaming-meta | 22 | 4 | 1 |
| defi-bluechip | 53 | 13 | 1 |
| payments-sov | 14 | 2 | **0** |
| fx-stables | 0 | 0 | 0 *(only 2 symbols align — data-hygiene)* |
| **stablecoin-peg** | **4** | **6** | **6** |

**Headline (desk-wide):** for *every directional-crypto class*, the cointegrated-pair
count collapses toward 0 as the window grows 30→180d. The scanner's short-window
"cointegrated pairs" are **systematically spurious** — 30-day cointegration is a
measurement artifact across the whole universe, not an ai-data quirk. This is *why*
Entry #1's high in-sample Sharpes evaporated OOS: we were ranking the best of ~80–90
short-window flukes per class.

**The one exception is structural:** **stablecoin-peg holds 4→6→6** — the only class
whose cointegration *strengthens* with horizon, because stablecoins are tethered to
the same \$1 peg (the spread mean-reverts by construction, not coincidence). It is the
only genuinely-cointegrated class on the desk.

**The catch (doctrine — flag the unmodelled cost):** stablecoin σ-spread is tiny, so
the edge per trade is a few bps — the ~20 bps **taker** round-trip floor eats it whole.
Gating stablecoin-peg through the *taker* OOS harness (5+2+10 bps) would correctly show
it unprofitable *as a taker strategy*. Its real home is **maker execution** (capture the
spread, don't pay it) — exactly why the desk already built the MM module (S19:
`src/market-making/`, `scripts/smoke-mm-stablecoin.ts`, the `stablecoin-peg` preset).

### Decisions
- **DEPLOY: nothing as a taker pair-trade.** Conserve equity. This is the doctrine's
  "nothing clears the bar" outcome — now *proven across 9 classes*, not assumed.
- **KILL: ai-data z-score**, and by the cliff, do **not** deploy taker pair-trades on
  any short-window-discovered directional-crypto pair.
- **LEAD: stablecoin-peg as a maker/MM book** — the only structural spread. Evaluate it
  through the MM backtest with *maker* economics, not the taker harness.
  Runnable today: `npx ts-node -r tsconfig-paths/register scripts/smoke-mm-stablecoin.ts`
  + /demo **Market-Making** tab.
- **METHODOLOGY FIX:** require multi-horizon cointegration *persistence* (cointegrate at
  90d **and** 180d) before a pair is a deploy candidate. `cointegration-stability.ts`
  *is* that filter — wire it into ⊹ Scan so short-window artifacts never reach a trade
  button.

### Next actions
1. **Evaluate stablecoin-peg as MM (maker), not pairs (taker).** Run `smoke-mm-stablecoin.ts`;
   build a maker-economics OOS gate for the MM book (queue-position fill model scaffolded
   in S19). This is the live lead — the only structurally-honest edge found.
2. **Wire the persistence filter into the scanner** — a pair must cointegrate at ≥2
   horizons to surface as a candidate. Kills the short-window-artifact pipeline at source.
3. **fx-stables data hygiene** — only 2 symbols align, can't form a pair universe; fix the
   preset/alignment before it's scannable.
4. **If pursuing directional crypto at all:** the cliff says taker z-score pairs won't
   work — the only paths are (a) maker execution to beat the fee floor, or (b) a
   fundamentally different signal (cross-sectional baskets, funding-carry), **not** more
   z-score/entry-Z tuning. Stop hunting taker pairs in these classes.

---

## 2026-06-01 — Entry #6: the pivot — MM is the live earner; stat-arb library gets a total rewrite (S23)

**Decision (Ronnie/Yoda): stop trying to rescue taker stat-arb; invest everything in
market-making, and rewrite the strategy library to span FX / rates / options & swaps
(Greeks).** Entries #4–#5 paid for this: cointegration is a cliff, fee drag dominates,
the gate kills every survivor. The one structural spread (stablecoin-peg) only pays as a
**maker**. So this session proves MM as the live earner and writes the rewrite brief.

### A. MM running for hours — `scripts/mm-paper-session.ts` (new, DB-free, real Binance)
Drives the **same live `MmBook` + registry** the control plane runs; two modes (replay
real history now / live-poll for hours on your box). Honest **fee sweep**: the report
derives net at −1bps (VIP maker rebate), **0bps (structural = spread − adverse)**, and
+1bps (retail maker cost) from the book's P&L components. Conservation is judged on the
**structural** equity curve, never on the rebate.

**Headline — 24h replay, GLFT on FDUSD/USDC/TUSD, $50k/quote, $400k max inv/book, $3M desk:**

| Fee assumption | Desk net / 24h | % of $3M |
|---|---|---|
| **0 bps — structural (real edge)** | **+$1,361** | +0.045% |
| −1 bps — VIP maker rebate | +$4,844 | +0.161% |
| +1 bps — retail maker cost | **−$2,121** | −0.071% |

- **Stable:** structural net rose monotonically across **all 12 two-hour buckets (12/12 ≥ 0)** — not one lucky bar.
- **Equity conserved:** desk **max drawdown 0.0011%** at $50k lots / $400k max inventory. Large lots, ~zero DD — because a peg's MtM swing on $400k is tiny, bounded by the inventory cap + nav stop.
- **FDUSD carries it** (673 of 697 fills); USDC/TUSD are too tightly pegged to fill much.

### B. The honest catch (the deploy condition)
The structural edge (spread − adverse) is **real and positive but thin**; the clear
profit comes from the **maker rebate**. **At a +1bps retail maker cost the book loses.**
So: **DEPLOY only on a maker venue at ≤ 0 bps** (a rebate tier, or zero-fee maker). And
fills are **fill-on-touch — an upper bound**, not a promise (queue-aware LOB replay is
the honest next correction; it needs an L2 tape we don't ingest yet). This is the
conservation-first read: a clean spread-capture book on a structurally-tethered
instrument, profitable *if and only if* the execution economics are maker-favourable.

### C. The strategy-library rewrite — brief written (next deliverable)
[STRATEGY_LIBRARY_REWRITE.md](./STRATEGY_LIBRARY_REWRITE.md) + the Strategy Developer hat
([desk/ROLE_strategy_developer.md](../desk/ROLE_strategy_developer.md)) now carry the
binding next deliverable: generalise `IStrategy` (2-leg `BarContext` → N-leg,
instrument-typed `MarketContext`), add a pricing/**Greeks** layer (`IOptionPricer` mock+
real, BS + Bachelier, Deribit IV), a **Greeks-budget risk gate**, and carry/funding in
the cost model — all behind the **unchanged validation gate**. Ranked strategy menu
(funding-carry → FX basis → options vol-sell → term/rate carry). **Build funding-rate
carry first** (Binance funding is public — no new venue).

### Decisions
- **DEPLOY (paper, live now):** stablecoin-peg **MM**, GLFT, **scale toward $50k+/quote** —
  it conserves equity and prints a stable structural edge. **Go-live gate: a ≤0 bps maker
  venue** + queue-aware fills before real money.
- **A/B next:** the same quoter on the `fx-via-stables` (EUR) book.
- **STRATEGY DEV next session:** execute the rewrite; funding-rate carry first; run it
  through the real-history OOS gate before any deploy.
- **RESEARCHER next:** wire Binance funding history (unblocks carry) and Deribit IV
  (unblocks the Greeks families).

### Reproduce
```bash
# 24h replay (deterministic, runs anywhere):
MM_SESSION_HOURS=24 npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts
# live, for hours, on your own machine:
MM_SESSION_MODE=live MM_SESSION_HOURS=8 npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts
```

---

## 2026-06-01 — Entry #7: equities pivot, Phase 1 — Alpaca adapters shipped; thesis test wired (S24)

**Why this, alongside the MM pivot (#6).** #5 found the cliff is *universal* for
directional crypto — short-window cointegration is a measurement artifact that collapses
30→180d. MM (#6) is the answer for stablecoins. **Equities are the answer for stat-arb**:
same-sector names (KO/PEP, the rails near-duopoly, banks) are cointegrated for a
*structural* reason — shared cash-flow drivers — so the spread should mean-revert by
construction, not coincidence. That is the exact property crypto lacked. This entry is
**infrastructure, not a finding** — the build that lets us run the desk's OOS gate on
equities. The verdict comes next, when the gate runs on real Alpaca history.

**The cost-structure read (why equities *can* clear the bar crypto couldn't).** Crypto
died on the ~20 bps round-trip taker fee. Equities invert it: **commission ≈ 0** (Alpaca
commission-free), **large-cap spread ~1–2 bps**, **impact benign** (huge ADV → big N\*).
The swing cost becomes **short-borrow on the short leg** — ~0.25–0.5%/yr easy-to-borrow,
10–100%+/yr (and recall risk) for hard-to-borrow names. So borrow is the cost that decides
equities, and it's name-specific — which is why P0.4 (deferred for crypto) shipped *here*.

**Shipped (offline-verified, 118 suites / 792 tests):**
- `src/stat-arb/feed/alpaca/` — `AlpacaDataClient` (auth'd Market-Data v2, `adjustment=all`
  split/div-adjusted, `next_page_token` pagination, interval→Alpaca-timeframe map),
  `AlpacaBarFeed` + `AlpacaPriceSource` (RTH-aware), `AlpacaPaperVenue` (real Alpaca
  **paper** order API; whole-share `qty` so the short leg is actually shortable;
  commission-free ⇒ fees=0). Injected HTTP throughout → unit-tested with canned responses.
- `FEED_SOURCE=alpaca` config + factory wiring (feed/price/venue/warmup); Binance default.
- **8 `EQUITY_PRESETS`** (banks, energy, rails, megacap-tech, payments, staples, pharma,
  semis), kept *separate* from `MARKET_PRESETS` so the Binance scanner never sees a ticker.
- **P0.4 short-borrow carry** in `HistoricalReplayVenue` — `borrowBpsPerYear` × hold-duration
  on the short leg, charged on the covering fill into `feesUnits` (default 0 = back-compat).
- `scripts/cointegration-stability.ts STAB_SOURCE=alpaca` — the **thesis test**, one command.

**The thesis test (hand-off — needs an Alpaca paper key):**
```bash
# .env: ALPACA_KEY_ID=…  ALPACA_SECRET=…
STAB_SOURCE=alpaca STAB_INTERVAL=15m STAB_HORIZONS=30,90,180 \
  STAB_PRESETS=equity-banks,equity-megacap-tech \
  npx ts-node -r tsconfig-paths/register scripts/cointegration-stability.ts
```
**Decision gate (record results here as the next dated note):** if the equity baskets
*hold* cointegration across ≥2 horizons (90d **and** 180d) — unlike crypto's collapse to 0
— the structural thesis is confirmed and the desk has its first genuinely-cointegrated
directional universe → proceed to the OOS gate (`oos-candidates.ts` pointed at Alpaca),
net of fee+spread+impact+**borrow**, n≥20 OOS trades, DSR≥0.95. If they collapse too, then
equities are no different and we say so — the gate's whole point is to reject, not flatter.

**Next:** (1) run the thesis test above and record the persistence table; (2) if it holds,
backfill 6–12 months and run the OOS gate with the borrow leg on; (3) wire equity presets
into ⊹ Scan + the OOS buttons in `/demo`; (4) earnings-blackout filter; IBKR for real
borrow rates (Phase 2/3 of [EQUITIES_STATARB_PLAN.md](EQUITIES_STATARB_PLAN.md)).

---

## 2026-06-02 — Entry #8: rewrite #1 — funding-rate carry, first real number (the first non-stat-arb edge)

Executing the strategy-library rewrite ([STRATEGY_LIBRARY_REWRITE.md](STRATEGY_LIBRARY_REWRITE.md)) #2
— **delta-neutral funding-rate carry** (long spot + short perp, harvest funding). Built first
because Binance USDⓈ-M funding is **public, no new venue**. New self-contained module (doesn't
touch the parallel S24 stat-arb work): `src/market-data/funding/` — `IFundingRateSource` +
`BinanceFundingClient` (public `/fapi/v1/fundingRate` + `premiumIndex`, injected HTTP) +
`funding-carry.ts` (pure P&L: funding − fees ± basis). Harness: `scripts/funding-carry-research.ts`.

### Finding — funding on majors is a real +3–4%/yr carry, fee-bound on short holds
30d real history, $100k/leg, 30bps round-trip taker (spot 10 + perp 5 per side):

| Perp | carry %/yr | posFrac | breakeven | net if held 1yr | verdict |
|---|---|---|---|---|---|
| ETH | **4.00%** | 0.83 | ~27d | +3.70%/yr | **CANDIDATE** |
| DOGE | 3.51% | 0.73 | ~31d | +3.21%/yr | CANDIDATE |
| BTC | 3.36% | 0.77 | ~33d | +3.06%/yr | CANDIDATE |
| BNB | 4.02% | 0.63 | ~27d | +3.72%/yr | WATCH (funding less one-sided) |
| XRP / SOL | 0.66% / 0.55% | ~0.5 | 166d / 199d | ~0.3%/yr | WATCH (too low) |

### The load-bearing insight (and an honesty correction I made mid-build)
- **Funding is a continuous stream; the round-trip fee is a ONE-TIME cost.** So carry is a
  **hold-longer** trade: breakeven ≈ fee ÷ funding-rate (~30d at taker fees); held past it, net
  → the carry yield. Annualising the one-time fee over a 30d window (my first cut) **overstated**
  it and falsely flagged everything "no-edge". Fixed: judge on carry yield vs a 1yr-amortised fee.
- **Basis is the real risk, not the fee.** Delta-neutral, the only price P&L is the perp-spot
  basis change. This window it ran **−0.5% to −1.2% across the whole basket** (correlated — a
  broad ~9% selloff where spot fell faster than perp), swamping the +0.27%/30d funding earned. It
  is **path/entry-timing dependent and mean-reverts over time, but is correlated across symbols in
  one window** — so it diversifies across *time/entries*, not across symbols. A single static 30d
  entry is dominated by basis variance; the funding edge only shows through over many cycles.
- **Same shape as the MM result (Entry #6):** a real but thin edge that the **execution cost
  decides**. Taker fees ⇒ ~30d breakeven; **maker entry (reuse `src/market-making/`) cuts 30→~10bps
  and breakeven ~3×**.

### Decisions
- **DEPLOY CANDIDATE:** ETH/BTC/DOGE funding carry, **as a HELD carry past the ~30d breakeven**, or
  with maker entry. Not a churn trade. Size ≤ N\* on thinner legs; basket across symbols + roll
  through cycles to average the basis.
- **WAIT / forward-test first:** does the funding *persistence* (posFrac) hold out-of-sample? That
  is the carry's analogue of the cointegration-persistence test — the next gate to build.
- **NEED-DATA (Researcher):** longer funding history (6–12mo) to forward-test persistence; later
  Deribit IV for the options/Greeks families (rewrite #4).

### Reproduce
```bash
npx ts-node -r tsconfig-paths/register scripts/funding-carry-research.ts
FC_DAYS=60 FC_SYMBOLS=BTC,ETH,SOL npx ts-node -r tsconfig-paths/register scripts/funding-carry-research.ts
```

## 2026-06-02 — Entry #9: equities thesis run + OOS gate on real Alpaca history (the S24 hand-off, closed)

The live thesis run promised in Entry #7 — finally run with a real Alpaca paper key (S25 wired
`STAB_SOURCE=alpaca` / `OOS_SOURCE=alpaca`; this entry is the data). Daily bars, split/div-adjusted
(`adjustment=all`), free IEX feed.

### Finding 1 — the cointegration cliff does NOT happen in equities
`cointegration-stability.ts STAB_SOURCE=alpaca STAB_INTERVAL=1d`, horizons 180/365/730 days:

| basket | p<0.6 count @180/365/730d | p<0.05 count @180/365/730d |
|---|---|---|
| equity-banks | 34 / 36 / 36 | 1 / 1 / 4 |
| equity-energy | 28 / 28 / 28 | 1 / 0 / 1 |
| equity-rails | 10 / 10 / 10 (all pairs) | 1 / 1 / 1 |
| equity-megacap-tech | 15 / 15 / 14 | 1 / 0 / 1 |
| equity-staples | 15 / 15 / 15 (all pairs) | 0 / 0 / 1 |
| equity-semis | 21 / 21 / 19 | 2 / 3 / 0 |

At the loose cutoff the count is **flat across horizons** — the opposite of crypto (Entry #5: 19→4→0
as the window grew). The thesis holds: same-sector equity cointegration is **structural, not a
short-window artifact.** *But* at tradeable significance (p<0.05, limited by the coarse ADF p-value
that only resolves {0.005, 0.025, 0.075, 0.5}) only a handful of pairs are strongly cointegrated, and
the specific pairs aren't all stable across horizons. Persistence ≠ a deep tradeable universe.

### Finding 2 — the OOS gate finds NEAR-passing candidates, but none cleanly PASS
`oos-candidates.ts OOS_SOURCE=alpaca`, daily, walk-forward (β re-fit per train window), net of
0bps fee + 1bps half-spread + impact + 50bps/yr borrow:

| basket / pair | window | OOS trades | pooled Sharpe | posWin | OOS P&L | PSR | DSR | verdict |
|---|---|---|---|---|---|---|---|---|
| banks **USB/PNC** @z2.0 | 5yr (1252 bars) | 41 | **0.65** | **100%** | **+$66.8k** | 100% | **92%** | INCONCLUSIVE (just under 95) |
| staples **PG/CL** @z2.5 | 5yr | 17 | 0.88 | 56% | +$24.1k | 99% | **96%** | **INSUFFICIENT** (n<20) |
| banks GS/MS @z2.0 | 5yr | 35 | 0.31 | 67% | +$28.0k | 95% | 21% | INCONCLUSIVE |
| rails CP/CNI @z2.0 | 5yr | 32 | 0.09 | 78% | +$6.3k | 69% | 17% | NOISE |
| banks USB/PNC @z2.0 | ~6yr (1466 bars) | 43 | **0.30** | 82% | +$38.9k | 98% | 32% | INCONCLUSIVE |

**The headline:** USB/PNC clears every component *except the bar itself* on the 5yr window —
DSR 92%, 41 trades, 100% positive windows, +$66.8k net. **But extend the window to ~6yr and the
Sharpe halves (0.65→0.30, DSR 92→32).** The strong result was partly regime-dependent; the gate
correctly refuses to certify it. PG/CL is the mirror image — DSR 96% (would pass) but only 17 OOS
trades. **No equity pair clears DSR≥0.95 AND n≥20 on a full multi-year window.**

### Contrast with crypto (the point of the pivot)
Crypto (Entry #4/#5): the gate **killed every survivor outright** (cointegration evaporated; the few
candidates went INSUFFICIENT/NOISE). Equities: the gate produces **borderline, near-passing
candidates** (DSR 92%, DSR-96%-but-n<20). That is a categorically better starting point — the edge
is *there*, it's just thin and trade-count-starved, not absent. This is the first time the desk has
had a stat-arb candidate within reach of the gate.

### The binding constraint is data, exactly as predicted (course §10.6)
Daily-bar reversion (half-life ~15–35 trading days) ⇒ ~5–6 round trips/yr/pair ⇒ **n≥20 needs years
of history**. And the free **IEX feed caps at ~2016** (asking 3650 days returned only 1466 bars), so
"more history" hits a vendor wall — pre-2016 daily needs SIP (paid) or another source. The two paths
to a clean PASS: (a) **basket-pooling** the OOS trades of independent same-sector pairs to lift n;
(b) **β-weighted sizing** (course §10.3 — the engine sizes equal-dollar today) to cut the residual
factor variance and raise the per-trade Sharpe.

### Param/harness bugs found + fixed while running this (the "is it professional" pass)
1. Scripts didn't load `.env` → keys ignored. Added `dotenv/config` preload.
2. My earlier doc horizons (30/90/180d on **daily** bars) were too few bars for the gate. Corrected
   to 180/365/730d.
3. **Zero-trades trap:** the walk-forward test slice runs the strategy fresh, so the first `zLookback`
   bars warm up and don't trade; with the registry default zLookback=60 and TEST<60 you get **0 OOS
   trades** (the first banks run). Added `OOS_ZLOOKBACK` (use ~20 on daily) + a `TEST≤zLookback`
   warning.
4. **Deflated-Sharpe mis-calibration:** the script fed σ_SR from *one pair's per-window* Sharpe
   dispersion (very noisy) → eMax 2–5 → every DSR pinned at 0. Fixed to the **cross-pair** Sharpe
   dispersion (deflated-sharpe.ts's intended input): σ_SR≈0.22, eMax≈0.46 — and USB/PNC's true
   DSR surfaced at 92%, not 0.
5. OOS runs now write a `docs/research/*.json` artifact like the other scripts.

### Decisions
- **No equities deploy.** No pair clears the gate on a full window; USB/PNC's 5yr edge is regime-
  sensitive. Honest "not yet," not "never."
- **WATCH-LIST:** USB/PNC and PG/CL — re-gate once trade count is lifted.
- **NEED-DATA (Researcher, P0.5):** longer daily history beyond the IEX 2016 cap (SIP or alt vendor)
  + a point-in-time universe (survivorship). This is now the binding item for equities.
- **BUILD next:** basket-pooled OOS (lift n across independent pairs) and β-weighted sizing
  (raise per-trade Sharpe) — the two levers that could turn USB/PNC's 92% into a PASS.

### Reproduce
```bash
# thesis / cliff test (daily, multi-horizon)
STAB_SOURCE=alpaca STAB_INTERVAL=1d STAB_HORIZONS=180,365,730 STAB_MIN_BARS=120 \
  npx ts-node -r tsconfig-paths/register scripts/cointegration-stability.ts
# OOS gate (daily, warmup-aware params)
OOS_SOURCE=alpaca OOS_PRESET=equity-banks OOS_DAYS=1825 OOS_INTERVAL=1d \
  OOS_TRAIN=120 OOS_TEST=120 OOS_ZLOOKBACK=20 OOS_ENTRY=2.0,2.5 \
  npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
```

## 2026-06-02 — Entry #10: basket-pooled OOS — the de-biased equities verdict (real but ~0.06 Sharpe)

Built the lever Entry #9 flagged: pool the OOS trades of an **edge-disjoint** set of pairs (each
ticker used ≤ once → no shared leg → far closer to independent) into one stream, gate the pooled
stream. `OOS_BASKET=true`; `OOS_PRESET` takes a comma-list to pool **across sectors** (different
cash-flow factors ⇒ genuinely more independent). Two reasons this is the right test: (1) it lifts
the OOS trade count past the n≥20 floor that killed single daily pairs; (2) the matching ranks by
**cointegration, not realized Sharpe**, so it is **selection-unbiased** — it *cannot* cherry-pick
the lucky USB/PNC.

### Finding — the equities sector-pairs edge is REAL but tiny, and does not certify
| basket | pairs | OOS trades | pooled Sharpe | pos-trade | OOS P&L | PSR | verdict |
|---|---|---|---|---|---|---|---|
| banks only | 4 disjoint | 135 | 0.12 | 69% | +$51.1k | 89% | INCONCLUSIVE |
| **5 sectors** (banks+energy+rails+staples+pharma) | **15 disjoint** | **507** | **0.06** | 61% | **+$118.4k** | **90%** | INCONCLUSIVE |

- **Trade-count problem: solved.** 507 pooled OOS trades — no more `INSUFFICIENT`.
- **Selection bias: removed — and it mattered.** The single best pair (USB/PNC) showed Sharpe 0.65
  / DSR 92% (Entry #9); the *de-biased* disjoint basket shows **0.06** pooled. The 0.65 was mostly
  the max-of-31 selection artifact. The honest sector-pairs edge is ~0.06 Sharpe/trade.
- **Sign is positive, magnitude is not certifiable.** +$118.4k over 5yr across 15 × $100k/leg books,
  PSR 90% (the pooled Sharpe is ~90% likely > 0) — but **below the 95% bar**. Real, not deployable.

### The stats subtlety I fixed mid-build (matters for the verdict)
The disjoint basket is a **pre-specified, selection-unbiased portfolio**, so the per-pair
selection-bias deflation (E[max] over the 93-pair pool) does **not** apply to it — deflating the
basket by eMax-over-93 wrongly pinned its DSR at 0. Corrected: the basket is judged on **PSR vs 0**
(trials=1 ⇒ eMax=0). That lifts the honest read from "DSR 0%" to "PSR 90%." **Caveat:** PSR assumes
iid trades; residual cross-pair correlation (shared market beta) makes the *effective* n < 507, so
90% is a mild overstatement — the true significance is somewhat below 90%, i.e. comfortably under the
bar either way.

### Decisions
- **Equities verdict (final for now): real edge, not deployable.** A selection-unbiased, 507-trade,
  cross-sector basket nets +$118k/5yr at PSR ~90% — positive but under the 95% bar at Sharpe 0.06.
  Categorically better than crypto (Entry #5: edge gone, not just thin), but not a deploy.
- **The two remaining levers** (could lift 0.06 → certifiable): **β-weighted sizing** (course §10.3 —
  the engine sizes equal-dollar, leaving residual factor variance that depresses per-trade Sharpe) and
  **more history** (IEX caps ~2016 → SIP/alt vendor; P0.5). Borrow-aware pair selection (drop hard-to-
  borrow names before pooling) is a third.

### Addendum — β-weighted sizing built + A/B'd: correct, but MARGINAL here (negative result)
Built `betaWeightedSizing` in `PairsStrategy` (scale the B leg to |β|·n, lock the entry β for the exit
leg, clamp |β|∈[0.25,4]; default off; `OOS_BETA_WEIGHTED=true` / registry `betaWeighted`). A/B on the
same 5-sector / 15-pair / 507-trade basket: equal-\$ → **Sharpe 0.06, PSR 90%, +\$118.4k**; β-weighted
→ **Sharpe 0.06, PSR 91%, +\$119.6k**. Essentially unchanged. **Why:** the edge-disjoint same-sector
pairs already sit near **β≈1**, so |β|·n ≈ n and there was little residual N(β−1)·r_B to remove — exactly
the regime where course §10.3 says equal-dollar is a good approximation. So β-weighting is the *correct*
construction but **does not rescue the edge** — it rules out "we were just sizing wrong." The thin 0.06
is the real edge; the binding lever is **data** (more history), not sizing. β-weighting will matter only
for a wide-β universe (cross-sub-industry pairs), which we don't trade.

### Reproduce
```bash
# cross-sector edge-disjoint basket pool
OOS_SOURCE=alpaca OOS_BASKET=true \
  OOS_PRESET=equity-banks,equity-energy,equity-rails,equity-staples,equity-pharma \
  OOS_DAYS=1825 OOS_INTERVAL=1d OOS_TRAIN=120 OOS_TEST=120 OOS_ZLOOKBACK=20 \
  npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
```

---

## 2026-06-02 — Entry #11: rewrite #3 — FX-stable basis is real but sub-fee (→ route to the maker book)

Rewrite #3 (STRATEGY_LIBRARY_REWRITE.md): cross-source **FX-stable basis** — the EUR on Binance
(EUR/USDT, an EUR-stablecoin) vs Pyth's FX benchmark EUR/USD. `basis = ln(EURUSDT) − ln(EURUSD)`
is the stablecoin's deviation from FX fair value; trade it as a single-leg mean-reversion on
EUR/USDT. Reuses the **IReferenceBarSource seam** (Pyth, already wired) + the signal libs
(`logSpread`/`rollingZScore`/`ouFit`). New harness: `scripts/fx-basis-research.ts` (DB-free).

### Finding — the basis reverts fast and reliably, but it's sub-fee for a taker
1000×1m aligned bars (intersection drops weekend FX gaps), EUR:EURUSD:

| metric | value | read |
|---|---|---|
| σ basis | **1.56 bps** | the EUR-stable tracks EUR/USD within ~1.5bps — arbitrage keeps it pegged |
| half-life | **7 bars (~7 min)** | fast, clean mean reversion |
| \|z\|>2 | 8.0% of bars | frequent small deviations |
| reversion backtest (z2/0.5) | 38 trades, **−21.2 bps/trade, 0% win** | **sub-fee** |

The reversion is genuine (σ tiny, half-life short, frequent), but at 1.5bps σ the captured move is
~2–3 bps and the **20bps taker round trip eats it whole** — the exact fee-floor wall as crypto
stat-arb and the stablecoin peg (Entry #5/#6).

### Decision
- **DEPLOY: nothing as a taker basis trade.** Conserve equity.
- **LEAD: the same as the peg — route it to a MAKER book.** Quoting the EUR-stable turns the basis
  into a maker spread (capture, don't pay) instead of a 20bps taker round trip. The MM module
  (`src/market-making/`) already runs the `fx-via-stables` (EUR) preset — A/B the GLFT quoter there.
- **EXTENSION (need-data):** a true **triangular** arb — Bit2C BTC/ILS vs Binance BTC/USDT × Pyth
  USD/ILS (3 venues, 3 sources, all wired) — is the version with a wider basis; separate harness.

### Reproduce
```bash
npx ts-node -r tsconfig-paths/register scripts/fx-basis-research.ts
FXB_PAIRS=EUR:EURUSD FXB_ENTRY_Z=2 FXB_EXIT_Z=0.5 npx ts-node -r tsconfig-paths/register scripts/fx-basis-research.ts
```

---

## 2026-06-02 — Entry #12: rewrite #4 — the Greeks layer + options vol-selling (VRP is real, and our BS matches Deribit)

Rewrite #4 (STRATEGY_LIBRARY_REWRITE.md §3.3): the **pricing/Greeks layer** + the first options
strategy. New self-contained `src/derivatives/`:
- `greeks/option-pricer.interface.ts` — `IOptionPricer` seam (+ `MockOptionPricer` safe default).
- `greeks/black-scholes.ts` — pure Black-Scholes price + full Δ/Γ/ν/Θ/ρ; unit-tested to the Hull
  textbook value (call=10.4506 @ S=K=100,T=1,σ=.2,r=.05) + put-call parity.
- `deribit/deribit-client.ts` — public Deribit v2 chain (mark IV + venue Greeks), no key.
- `scripts/vol-carry-research.ts` — the VRP harness.

### Finding 1 — the Greeks layer is CORRECT (validated against Deribit on live data)
Pricing the real ATM call at Deribit's own mark IV, our BS Greeks vs Deribit's:

| | our ν/1% | deribit ν | our Θ/day | deribit Θ | our Δ | deribit Δ |
|---|---|---|---|---|---|---|
| BTC-26JUN26-70000-C | 71.7 | **71.7** | −55.2 | **−55.2** | 0.534 | 0.544 |
| ETH-26JUN26-2000-C | 2.0 | **2.0** | −2.0 | **−2.0** | 0.578 | 0.496 |

**Vega and theta match to the decimal** — the core vol-sensitivity Greeks a vol book runs on are
right. Delta agrees for BTC; the ETH gap is the **spot-vs-forward moneyness convention** (Deribit
deltas off the future, we price off spot index) — a known nuance, not a bug; a Black-76/forward
variant is the refinement (noted). For a delta-hedged book, delta is hedged out anyway; ν/Θ are
what price the edge.

### Finding 2 — the variance risk premium is positive on both majors (short vol has carry now)
~24d ATM, real Deribit IV vs Binance trailing RV (1h):

| ccy | IV | RV | **VRP** | IV/RV | short-straddle Θ income |
|---|---|---|---|---|---|
| BTC | 37.1% | 31.2% | **+5.9 vol pts** | 1.19 | +$110/day/contract |
| ETH | 46.5% | 42.8% | **+3.7 vol pts** | 1.09 | +$4/day/contract |

Implied is richer than realised — the classic premium sellers earn for carrying gap/jump risk.

### Decision
- **CANDIDATE: delta-hedged short ATM straddle on BTC (VRP ~6pts) / ETH (~4pts)** — positive
  expected carry *right now*. **Deploy ONLY** delta-hedged, **under a Greeks budget** (net vega/gamma
  caps — the §3.5 gate, next to build), small, never naked: theta is the income, gamma is the risk,
  one jump can erase weeks of premium. This is a *risk-managed* carry, not free money.
- **NEED (next):** (1) a **VRP time series** (one snapshot ≠ an edge — is IV>RV persistent? the
  options analogue of the cointegration-/funding-persistence test); (2) the **Greeks-budget gate**
  as a real class (`CompositeGreeksGate`, mirrors the MM `CompositeRiskGate`); (3) skew/term, fees,
  hedge-cost in the P&L.

### Reproduce
```bash
npx ts-node -r tsconfig-paths/register scripts/vol-carry-research.ts
VOL_CCYS=BTC,ETH VOL_TENOR_DAYS=30 npx ts-node -r tsconfig-paths/register scripts/vol-carry-research.ts
```

## 2026-06-02 — Entry #13: the more-history lever — Yahoo daily (decades) flips the gate, but survivorship inflates it

The binding equities blocker (Entry #9/#10) was **data, not method**: Alpaca caps at ~2016 (both
iex AND sip — paying for sip adds tape, not years), so daily OOS trade counts couldn't clear n≥20 and
the de-biased basket sat at Sharpe 0.06 / PSR 90%. Built the lever: a free, no-key, **split+dividend-
adjusted** long-history daily source — `YahooDailyClient` (chart v8, `adjclose`, injected HTTP, daily-
only). Wired `STAB_SOURCE=yahoo` / `OOS_SOURCE=yahoo` (equity cost model via a new `IS_EQUITY`). JPM
carries 11,646 daily bars back to 1980.

### Finding — the gate flips to PASS with more history, BUT the Sharpe rises with window length (the tell)
5-sector edge-disjoint basket (banks+energy+rails+staples+pharma), daily, net of all costs:

| window | source | disjoint pairs | OOS trades | pooled Sharpe | OOS P&L | PSR | gate |
|---|---|---|---|---|---|---|---|
| ~5yr | Alpaca IEX | 15 | 507 | 0.06 | +$118k | 90% | INCONCLUSIVE |
| ~10yr | Yahoo | 13 | 887 | 0.09 | +$336k | 99% | PASS |
| ~24yr | Yahoo | 12 | 1867 | 0.15 | +$1.16M | 100% | PASS |

- **Trade-count problem: solved.** 887–1867 trades; the edge is now statistically distinguishable
  from zero (PSR 98–100%). That's a real step up from INCONCLUSIVE — the edge IS positive.
- **But the per-trade Sharpe RISES monotonically with window length (0.06→0.09→0.15)** — the signature
  of **survivorship + crisis inflation**, not a stable edge. A 24yr backtest on *today's* banks
  silently drops the 2008 casualties (Wachovia/Bear/Lehman/Countrywide); the survivors' spreads
  mean-reverted, the dead ones didn't. The longer the window, the more survivor-only crisis
  mean-reversion (2008, 2020) it loads. So the long-window result is an **upper bound**, not truth.
- **PSR "PASS" ≠ deployable.** (a) PSR with n~1000+ flags even a thin 0.09 Sharpe as "significant";
  (b) it assumes iid trades — a market-wide dislocation correlates the spreads, so effective n ≪ n;
  (c) survivorship inflates the level. A 0.09–0.15 per-trade Sharpe book has frequent drawdowns — it
  is NOT a "no-drawdown / always-profit" system, and saying so would be a curve-fit lie.

### Decisions
- **Equities verdict (updated): a real, positive, but THIN and survivorship-inflated edge.** More
  history moved it from "can't tell" to "positive but small (~0.09 honest-window Sharpe), not clearly
  deployable." Not a deploy; not a money printer.
- **The binding blocker is now SURVIVORSHIP** (point-in-time universe incl. delisted/merged names) —
  the only way to know if even the 0.09 is real or a survivor artifact. Free delisted-equity history
  is hard (CRSP is paid); this is the P0.5 frontier and the honest gate to deploy.
- **Data-quality caveat:** Yahoo ticker reuse (e.g. TFC = Truist post-2019 may carry BB&T history)
  and survivorship both mean Yahoo long-history is a research/upper-bound source, not a clean gate.
- β-weighting (Entry #10 addendum) remains marginal here (β≈1 pairs).

### Reproduce
```bash
OOS_SOURCE=yahoo OOS_BASKET=true \
  OOS_PRESET=equity-banks,equity-energy,equity-rails,equity-staples,equity-pharma \
  OOS_DAYS=9000 OOS_INTERVAL=1d OOS_TRAIN=120 OOS_TEST=120 OOS_ZLOOKBACK=20 \
  npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
```

## 2026-06-03 — Entry #14: the survivorship decision (free no-data path) + the mission reframe to a paper-trading demo

Two decisions this session, one a direct consequence of the other.

### Decision 1 — chose the FREE, no-data path for survivorship (over paid Sharadar/CRSP)
Entry #13 left the binding equities blocker as **survivorship**: more history flips the OOS gate to
PASS, but the pooled Sharpe rises monotonically with window length (0.06 → 0.09 → 0.15 over 5 → 24yr)
— the tell of a survivor-only universe silently dropping the 2008/2020 casualties whose spreads never
mean-reverted. The scoped fix ([SURVIVORSHIP_DATA_OPTIONS.md](./SURVIVORSHIP_DATA_OPTIONS.md)) offered
a paid Phase-1 (Sharadar SEP, ~$30/mo, entity-keyed, delisted-inclusive) vs a free non-data path.
**Picked the free path** — and the *reason* is decision 2: we don't need to prove the historical edge
to the dollar, we need to (a) not *show* an inflated number and (b) let forward paper-trading be the
real verdict.

**Encoded the lesson into tooling** (so the long-window number can't be quietly re-trusted):
- `src/stat-arb/research/survivorship-gate.ts` — `assessSurvivorship(windowDays, safeDays=1825)`
  judges whether a window is short enough that **survivor set ≈ live set** (~5yr: long enough for a
  real OOS trade count, short enough to exclude the crisis bankruptcies that do the bulk of the
  inflating; the few recent exits like PXD/MRO '24 were acquisitions that settled near a price, not
  spread-blowing failures). `applySurvivorshipGate` **downgrades a PASS/INCONCLUSIVE on a
  survivor-UNSAFE equity window to `UPPER-BOUND`** — no PSR/DSR, however high, certifies a
  paper-promote when the level is survivorship-inflated. A "no" (NOISE/INSUFFICIENT) is left as-is
  (survivorship only ever flatters). Unit-tested (11 cases).
- `scripts/oos-candidates.ts` wires it in: equity runs print a `✓/⚠ survivorship` banner, cap the
  verdict past `OOS_SURVIVOR_SAFE_DAYS`, and record a `survivorship` block in the JSON artifact.
  Crypto is exempt (its binding issue is cointegration decay, Entry #5, not equity survivorship).
- **The real equities verdict is now forward paper-trading** — run the survivor-safe survivors on the
  live Alpaca paper loop and accrue a zero-survivorship, zero-look-ahead forward track record. If the
  forward Sharpe holds the survivor-safe read (~0.06+) it earns its diversifier slot in the demo; if
  it decays to 0 it was an artifact. (Hand-off: needs an Alpaca key — Yahoo is daily-only, no live feed.)

### Decision 2 — mission reframe: this is a PAPER-TRADING DEMONSTRATION, not a road to real capital
Ronnie set the scope explicitly: **paper-trading only for the foreseeable future.** The deliverable is
a **demonstration of multiple strategies, each manned by a quant AI agent, that minimize drawdown and
show steady, conserved returns over hours and days** of live paper trading. Both engines serve it —
**crypto MM (the steady, low-drawdown earner)** and **equities stat-arb (a thin, uncorrelated
diversifier)** — and **the magic is in discovery of new markets: DEX / decentralized / anonymous
venues on the market-making side.** This is not a pivot in the code; it's a pivot in the *bar*:

- **The bar is no longer "deployable with real capital" — it's "honest, steady, low-drawdown paper
  equity over hours/days."** That's why the survivorship gate matters even though we'll never deploy:
  a demo that shows an inflated 0.15 Sharpe is worthless; an honest 0.06 that holds forward is the
  product. The OOS/survivorship/cost gates are now *demo-honesty* discipline, not deploy gates.
- **DEX is the right frontier for *this* engine specifically:** the MM book's binding condition is a
  **≤0 bps maker venue** (Entry #6/#23 — at +1bps retail maker cost it loses); DEX fee/reward
  structures (LP fees to the maker, maker rebates) are exactly that regime, and under-watched venues
  carry structurally wider spreads. Discovery compounds through the `IReferenceBarSource` seam with no
  new services (GeckoTerminal first → on-chain AMM/CLOB).
- **P1 ("before real capital") is PARKED** — real-venue adapter, reconciliation, arming: out of scope.

Reframed across CLAUDE.md §1 (binding mission), README, PRODUCTION_READINESS (P1 ⏸ PARKED),
EQUITIES_STATARB_PLAN, MARKET_MAKING (new Frontier — DEX/decentralized section), SURVIVORSHIP_DATA_OPTIONS,
AGENTIC_HEDGE_FUND_DESIGN, QUANT_ROLE. Tests: 125 suites / 841 tests (+1 suite / +11 = the gate spec).

### Reproduce
```bash
# the gate now caps a survivor-unsafe long window to UPPER-BOUND, and reports the survivor-safe read:
npx jest src/stat-arb/research/survivorship-gate.spec.ts
# survivor-safe (≤5yr) equity OOS read — the honest paper number (verdict NOT capped):
OOS_SOURCE=yahoo OOS_BASKET=true OOS_DAYS=1825 OOS_INTERVAL=1d OOS_TRAIN=120 OOS_TEST=120 OOS_ZLOOKBACK=20 \
  OOS_PRESET=equity-banks,equity-energy,equity-rails,equity-staples,equity-pharma \
  npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
# the 24yr run still computes, but its PASS is now reported as UPPER-BOUND (survivor-inflated):
OOS_SOURCE=yahoo OOS_BASKET=true OOS_DAYS=9000 OOS_INTERVAL=1d OOS_TRAIN=120 OOS_TEST=120 OOS_ZLOOKBACK=20 \
  OOS_PRESET=equity-banks,equity-energy,equity-rails,equity-staples,equity-pharma \
  npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
```

## 2026-06-03 — Entry #15: the discovery frontier, step 1 — a GeckoTerminal DEX source behind `IReferenceBarSource`

**Why this, now.** Entry #14 set the mission: a paper-trading demo whose *growth* lever is **discovery of
new markets to make markets in — especially DEX / decentralized venues** (CLAUDE.md §1, MARKET_MAKING.md
"Frontier — DEX/decentralized"). The MM book's binding deploy condition is a **≤0 bps maker venue** (Entry
#6/#23 — at +1 bps retail maker cost it loses); DEX fee/reward structures (LP fees accrue *to* the maker)
are exactly that regime, and under-watched pools carry structurally wider spreads. So the highest-leverage
move isn't tuning a quoter — it's **widening the universe**. This entry is the first source.

**What shipped (pure swap-seam addition — no architecture change, CLAUDE.md §7):**
- `src/market-data/reference/geckoterminal-client.ts` — `GeckoTerminalClient implements IReferenceBarSource`
  (free, no-key DEX OHLCV across 100+ chains). `klines()` → `GET /networks/{net}/pools/{pool}/ohlcv/
  {timeframe}?aggregate&limit&currency=usd`; `geckoTimeframe()` maps a kline interval to GT's
  `{minute|hour|day, aggregate∈allowed}`; `parseGeckoTerminalOhlcv()` turns the newest-first `ohlcv_list`
  into **chronological ascending** `Bar[]`. Injected `httpGet` (offline tests) + a `poolMap` of **real,
  live-verified** Uniswap-v3 addresses (a raw `'net/0x…'` symbol passes through unmapped, mirroring Pyth's
  raw-shim acceptance). 8 unit tests.
- Registered in `buildReferenceSources` (→ the `ReferenceSourceRegistry`, the `/api/market-data/reference`
  readout, and `makeScannerLoader`'s per-source routing) + config (`GECKOTERMINAL_BASE_URL`,
  `app.feed.geckoTerminalBaseUrl`, both module callers). New scanner preset **`dex-eth-bluechip`**
  (`source:'geckoterminal'`, assetClass `DEX`): WETH/USDC + WETH/USDT (≈ ETH/USD across fee tiers —
  cross-pool microstructure), WBTC/WETH (≈ BTC/USD with `currency=usd`), USDC/USDT (DEX stable peg).

**Live-verified end-to-end** (real API, default pool map, 1h × 24): WETHUSDC 24 bars ascending, lastClose
≈ $1854.94; WBTCWETH ≈ $66,507 (BTC/USD); USDCUSDT ≈ 0.984; Base cbBTC/USDC ≈ $66,523 — two chains
(eth + base) in the universe already. **126 suites / 849 tests** (+1 suite / +8), tsc clean.

**Honest scope — what this is and is NOT:**
- It IS the **data adapter + scan-universe registration**. "Discovery compounds": every source wired
  through `IReferenceBarSource` is now permanently scannable and (once fed) tradeable.
- It is **NOT yet a live MM book quoting a DEX pool.** `MmBook`/`MmPortfolioTrader` are Binance-fed;
  pointing one at a reference feed means mirroring S20's `ReferenceBarFeed`/`ReferencePriceSource` for the
  MM side and registering pools as `mm-market-presets`. **That is the next step** (MARKET_MAKING.md Frontier).
- **DEX prints are noisier** (MEV, sandwiching, thin pools, gas) → adverse selection and the fill model are
  *less* favourable than a clean CEX tape. Wider spread is **compensation for those hazards, not free
  money**; the survivorship/cost/honest-number discipline applies here too. The bar-fill is still
  fill-on-touch (an upper bound). The paper demo will show whether the net is steady and low-drawdown.

**Next actions:**
1. **MM-on-DEX-feed** — the `ReferenceBarFeed` analogue for the MM side so a `dex-*` preset launches a live
   paper `MmBook` quoting real DEX prints. The actual point of the frontier.
2. **Run the scanner across `dex-eth-bluechip`** and journal what cointegrates (expect WETH/USDC vs
   WETH/USDT cross-tier; BTC/USD vs ETH/USD as a crypto pair) — net of the wider DEX spread.
3. **Widen pools/chains** — add long-tail / lower-cap pools (the under-watched = wider-spread thesis) and
   more chains (Arbitrum, Solana via GT) once the live MM-DEX path proves out.

### Reproduce
```bash
# offline unit tests for the new source:
npx jest src/market-data/reference/geckoterminal-client.spec.ts
# the registry/config wiring is exercised by reference-bar-loader.spec.ts; with a GeckoTerminal-reachable
# network the dex-eth-bluechip preset is live in the scanner universe + the /api/market-data/reference readout.
```

## 2026-06-03 — Entry #16: the discovery frontier, step 2 — MM books quote DEX pools on the live paper loop

**The point of the frontier, delivered.** Entry #15 wired the DEX *data* (GeckoTerminal behind
`IReferenceBarSource`). This entry makes a DEX pool a **first-class live paper market-making book** — the
actual frontier (CLAUDE.md §1, MARKET_MAKING.md): the MM engine can now post bid/ask on an under-watched
on-chain venue, the same way it quotes a Binance pair.

**The seam (no new architecture — `MmBook` was already feed-agnostic):** `MmBook` takes an injected
`nextBar`/`warmupCloses`, so the only thing that decides *where the prints come from* is the book factory.
- **`MmBookSpec.source` + `MmMarketPreset.source`** (optional) — the MM twin of the stat-arb
  `PortfolioPair.source` (S20).
- **`market-making.module.ts`** builds a `ReferenceSourceRegistry` (`buildReferenceSources`, incl.
  GeckoTerminal) and, in `makeBook`, **routes a `source` book through a `ReferenceBarFeed`** (+ a
  source-backed `warmupCloses`) instead of `BinancePublicBarFeed`. A no-`source` book is unchanged.
- **`MmScreener` is now source-aware** (`MmBarLoader(symbol, source?)`, preset carries `source`): a
  reference-source preset routes to the registry, Binance presets to the public client — so the "where
  should we quote" board can rank DEX pools without firing 404s at Binance.
- **`MmController`** threads `source` through `launch` (body) and `launch-preset` (`preset.source`).
- New MM preset **`dex-eth-bluechip`** (`source:'geckoterminal'`): WETH/USDC, WETH/USDT, WBTC/WETH, USDC/USDT.

**Live-verified end-to-end** (real GeckoTerminal API → `ReferenceBarFeed` → `MmBook` → fills → 4-component
P&L), replaying ~200 real hourly DEX bars at $100/quote on a $1M book, **fee = 0 bps**:
| Book | fills (b/a) | spread captured | adverse selection | net | maxDD |
|---|---|---|---|---|---|
| WETH/USDC, symmetric 8 bps | 129 (65/64) | +$20,636 | **−$24,204** | **−$45,206** | 5.19% |
| USDC/USDT, GLFT (DEX peg) | 84 (42/42) | −$98 | +$101 | **−$101** | 0.01% |

**Honest read — what the numbers say (and don't):**
- The path *works*: real DEX prints → resting quotes → balanced passive fills → honest 4-component
  attribution. That is the deliverable. **Net P&L is honestly negative**, and that's the lesson, not a
  failure of wiring:
- WETH/USDC: a naive **fixed-spread** quoter on a **volatile, trending** asset gets **adversely selected**
  (it buys before drops / sells before rises) — −$24k adverse > +$21k spread. Inventory-aware quoting +
  a vol-suited instrument is the fix, not a wider fixed spread. (GLFT on WETH stood at its 200 bps cap and
  took **0 fills** — correctly refusing to quote tight into that vol.)
- USDC/USDT (the low-vol **stable peg** — the natural MM home): near-flat, maxDD **0.01%** at $1M, but
  still slightly negative at **fill-on-touch with no rebate**. This is exactly Journal #23's structural
  finding: the book needs a **≤0 bps maker venue** (a DEX where LP fees accrue to the maker is the
  candidate) and queue-aware fills to net positive. Fill-on-touch is an **upper bound**, so the true net
  is *worse* than shown here, not better.

**Next actions:**
1. **Per-pool param tuning + the rebate** — run the GLFT/AS book on the DEX **stable** pools with the
   maker-rebate fee model and per-pool `gamma/kappa`, the only regime with a structural shot at positive.
2. **A DEX MM paper session** — extend `scripts/mm-paper-session.ts` with a `source` knob so the hours-long
   equity-curve + fee-sweep harness runs a `dex-*` preset (today it's Binance-only).
3. **Wider, longer-tail pools** — the under-watched = wider-spread thesis only pays where the spread
   exceeds adverse selection; screen for it (the source-aware `MmScreener` now can).

### Reproduce
```bash
npx jest src/market-making                 # the MM suite incl. the source-routing tests
# live (needs a running engine + GeckoTerminal reachable): launch the DEX preset as one book per pool
curl -XPOST localhost:3100/api/market-making/launch-preset \
  -H 'content-type: application/json' \
  -d '{"presetId":"dex-eth-bluechip","strategyId":"mm-glft","capitalUsdcPerBook":50000}'
curl localhost:3100/api/market-making/snapshot   # quotes / inventory / spread / adverse / net per book
```

## 2026-06-03 — Entry #17: DEX MM paper session (the `MM_SESSION_SOURCE` knob) + two sizing/calibration bugs it surfaced

**Shipped:** `scripts/mm-paper-session.ts` — the hours-long equity-curve + fee-sweep harness — gained a
**`MM_SESSION_SOURCE`** knob (Entry #16 next-action #2). Set `MM_SESSION_SOURCE=geckoterminal
MM_SESSION_INTERVAL=1h` and the SAME `MmBook` + registry run on a DEX preset off a `ReferenceBarFeed`
(replay or live), interval-aware reporting, with the structural / −1bps-rebate / +1bps-cost fee sweep
unchanged. Binance remains the default (no behaviour change). tsc clean; suite unchanged (853 — script-only).

**Running it for real surfaced two genuine bugs — the honest part of the entry:**

1. **Lot sizing was in raw asset *units*, not notional.** `QUOTE_UNITS = 50,000` ≈ $50k *only because
   stablecoins are ≈$1*. On WETH (~$1,900) that's a **$95M** lot; on the WBTC pool (~$77k) it's $3.8B —
   the first run printed **−$18 *trillion***. Fixed: **`MM_SESSION_QUOTE_USD`** (default $50k for a source)
   sizes each book by **dollar notional ÷ the asset's first price**; the inventory cap scales with it.
   This was a latent bug for *any* non-$1 asset (incl. the Binance `crypto-majors-mm` preset), now correct.
2. **The QUOTER itself is calibrated for ~$1 assets** (deeper, NOT yet fixed). Even with correct notional,
   WETH/WBTC still blow up while the USDC/USDT peg is sane. The tell: fill-rate **0.526 (peg) vs 0.003
   (WETH)** + huge *negative* spread-captured. GLFT's half-spread/skew use σ in **absolute price units**,
   so σ² on a $1,900 asset is ~10⁶× the $1 case and the quote math mis-scales. The series are **clean**
   (no outliers: WETH $1855–2416, WBTC $66k–82k), so this is calibration, not data. **Next step:
   normalize σ to a return fraction in the quoters** (`src/market-making/quote/*`) so γ/σ are price-scale-
   invariant — then high-priced pools become quotable.

**The one valid DEX read today — the stable peg (USDC/USDT, GeckoTerminal, 720h hourly, $50k notional,
GLFT):** 72 fills, spread −$34.5k / adverse +$36.2k → **structural −$36.2k, maxDD 3.7%** on $1M. Net-
NEGATIVE even with the −1bps rebate. Honest reading: the **on-chain** USDC/USDT pool wobbles ~$0.98–1.01
(±1.6%) — far wider than a CEX stablecoin — so the book is adversely selected at fill-on-touch. The
under-watched-venue *spread* is real, but here adverse > spread. Consistent with Entry #16/#23: needs
queue-aware fills + a true ≤0bps maker structure + per-pool tuning before it's a positive book.

**Net:** the DEX path is now exercisable end-to-end in the long-horizon harness; the demo's honest DEX
verdict is *not yet a positive book*, and the two bugs above (one fixed, one scoped) are why.

**Next actions:** (1) σ-normalization in the quoters (unblocks high-priced pools); (2) per-pool γ/κ tuning
on the DEX stable pools + the maker-rebate fee model; (3) queue-aware fills (the `SimpleQueueModel` exists,
needs an L2 tape); (4) screen long-tail pools for spread > adverse (the source-aware `MmScreener` can now).

## 2026-06-03 — Entry #18: σ-normalization — the quoters are now price-scale-invariant (Entry #17 bug #2 fixed)

**The fix (step 1 of the Hyperliquid recommended order).** The AS/GLFT quoters computed
`sigmaPrice = ctx.volatility · mid` (micros) and then `γ · sigmaPrice² · T` for both the inventory
skew and the half-spread — so those terms scaled as **price²**. On a $1,900 asset the skew sent the
reservation to a nonsense price (the −$18T DEX run, Entry #17). Root cause: squaring a *micros* price.

`src/market-making/quote/avellaneda-stoikov.ts` (`asReservationMicros` / `asHalfSpreadMicros`, now shared
by **both** AS and GLFT — GLFT no longer inlines its own copy) is rewritten to compute skew + spread as
**fractions of mid** off a fixed **$1 reference scale** (`REF_MICROS`), with σ kept as a **return
fraction**, then applied to the live mid. Consequences:
- **Price-scale-invariant:** a given (γ, κ, σ_rel, q-lots) yields the *same bps* spread + skew at $1 or
  $1,900 (new unit tests assert this on both quoters).
- **Identical at mid=$1** by construction (the reference scale IS $1) → all 11 prior quote specs pass
  unchanged; the documented stablecoin MM results (Entry #23) are unaffected.
- **Skew bounded** to ±`MAX_SKEW_FRAC` (0.5) so a high-vol asset can never push the quote negative.

**Validated end-to-end** — the DEX paper session (720h hourly, GLFT, $50k notional) that printed −$18T
now prints sane, conserved numbers:

| book | fills | fillRate | structural | maxDD |
|---|---|---|---|---|
| USDC/USDT | 72 | 0.53 | −$36.8k | 3.76% |
| WETH/USDC | 24 | **0.033** (was 0.003 — quoter no longer stands absurdly wide) | −$7.0k | 0.77% |
| WBTC/WETH | 58 | **0.081** | −$2.6k | 0.31% |
| **Desk ($3M)** | 154 | — | **−$46.4k (−1.55%)** | **1.56% → drawdown PASS** |

**Honest read:** the blow-up is gone and **drawdown is conserved (1.56% < 2%)**, but the book is **still
net-negative** at fill-on-touch without per-pool tuning or a real rebate — exactly the remaining work.
**855 tests** (+2 scale-invariance specs), tsc clean.

**Next (the recommended order continues):** (2) `HyperliquidClient` behind `IReferenceBarSource` (candles)
+ an `hl-perps` MM preset — HL is the maker-rebate **CLOB** the book actually needs ([DATA_SOURCES.md](./DATA_SOURCES.md));
(3) L2 ingest from HL `l2Book` → `SimpleQueueModel`/`LobReplayHarness` → queue-aware (honest) fills;
(4) per-pool γ/κ tuning + the maker-rebate fee model on the low-vol stable pools.

## 2026-06-03 — Entry #19: Hyperliquid wired (step 2) — the maker-rebate perp CLOB is now scannable + quotable

**Shipped (step 2 of the recommended order).** `HyperliquidClient` (`src/market-data/reference/
hyperliquid-client.ts`, unit-tested) behind `IReferenceBarSource` — HL's public `info` endpoint is a
**POST** (`candleSnapshot`), so `RefHttpPost`/`defaultRefHttpPost` were added to the reference interface
(injected, offline-testable; reusable for dYdX next). `parseHyperliquidCandles` turns the string-OHLCV /
ms-timestamp payload into ascending `Bar[]`; `hyperliquidInterval` maps kline strings to HL's set.
Registered in `buildReferenceSources` (→ registry/readout/scanner-routing) + config
(`HYPERLIQUID_BASE_URL`, all callers, `.env.example`). New **`hl-perps`** scanner preset
(BTC/ETH/SOL/BNB/ARB/OP/AVAX/LTC — cross-sectional perps) **and** MM preset (BTC/ETH/SOL).

**Why HL over the AMM-DEX path (the eval, DATA_SOURCES.md):** it's a real maker-**rebate CLOB**
(−0.2bps) — the ≤0bps-maker order-book venue the AS/GLFT book was built for and needs to net positive —
plus an L2 tape (next step) that fixes the fill-on-touch upper bound. AMM pools gave discovery breadth
but no post-limit-earn-spread primitive.

**Validated end-to-end** (real HL API → `ReferenceBarFeed` → `MmBook`, 240h hourly, GLFT, $50k notional):
real prints BTC $67,181 / ETH $1,875 / SOL $75; all three perp books quote + fill sanely (σ-normalization
holds at these price levels) → desk **structural −$17.9k (−0.60%), maxDD 0.63% → drawdown PASS**. Still
net-negative (SOL the worst, −$14k: GLFT fill-on-touch is adversely selected on a volatile perp) — the
honest remaining work is per-pool γ/κ tuning + the L2 queue model. **859 tests** (+4 HL specs). HL → WIRED.

**Next:** (3) **L2 ingest** from HL `l2Book` (20×20, no-key) → feed `SimpleQueueModel`/`LobReplayHarness`
so fills are queue-aware, not fill-on-touch — the single biggest backtest-honesty upgrade; then (4)
per-pool γ/κ tuning + the maker-rebate fee model. **Caveat for the live control plane:** an HL book
launched via `/api/market-making/launch` still uses the fixed `MM_QUOTE_SIZE_UNITS` (raw units), which
over-sizes a $67k-priced perp — the control-plane needs the same notional sizing the session harness has
(`MM_SESSION_QUOTE_USD`). Tracked.

## 2026-06-03 — Entry #20: HL L2 ingest → queue-aware fills (step 3) — fills stop being fill-on-touch

**Shipped (step 3 of the recommended order — the single biggest backtest-fidelity upgrade).** Fills in
the MM backtest are no longer assumed-on-touch; they are computed FIFO against a **real Hyperliquid L2
depth tape**. Three pieces, all behind the existing swap seams:

1. **L2 ingest.** `HyperliquidClient.l2Snapshot(coin)` + `parseHyperliquidL2` — HL's no-key `l2Book` POST
   (`{coin,time,levels:[bids desc, asks asc]}`, 20×20, `{px,sz,n}` strings → micros/units). Behind a new
   `IL2BookSource` capability on the reference interface, with a neutral `L2Snapshot`/`L2Level` type kept
   a **structural copy** of microstructure's `OrderBook` so market-data never imports market-making
   (CLAUDE.md §6). Live-verified the payload shape against the real endpoint before parsing.
2. **`LobReplayHarness`** (`src/market-making/backtest/lob-replay.ts`) — the driver the `SimpleQueueModel`
   was always waiting for (course A.10). Walks an L2 tape, drives the **unchanged** `IQuoter` registry,
   maintains FIFO **price-time-priority** queue position (everything resting at our price *and better* is
   ahead of us — cumulative, `l2-tape.ts`), fills only once that queue is consumed by aggressive flow,
   and attributes every fill through the **unchanged** `PnlAttributor` into the `InventoryBook`. It reports
   the headline number: **`queueFills` vs `touchFills`** — how much fill-on-touch overstated.
3. **`scripts/mm-l2-session.ts`** — polls the live HL `l2Book` to build a real tape (REAL time-varying
   depth + the touch gate read off the candle's REAL traded high/low; the one estimate is per-interval
   aggressive *volume*, from the 1m candle pro-rated + split by the mid tick — stated honestly), runs the
   harness, and prints queue-aware fills + the structural/rebate/cost fee sweep + drawdown.

**The result (live-verified, both regimes reproduce on real HL data):** the fill-vs-touch gap is entirely
about **where you quote relative to real depth** — exactly what fill-on-touch ignores:

| Quote placement | touchFills | queueFills | ratio | read |
|---|---|---|---|---|
| Tight (inside the spread, ahead≈0) | 18 | 18 | 1.00 | top-of-book turns over fast → fill ≈ touch; the cost is **adverse selection**, not phantom fills |
| Wide (5bps into real depth) | 21 | **0** | **0.00** | the cumulative book above us never clears in the interval → fill-on-touch overstated **∞×** |

**Honest finding:** at our data granularity (1m OHLCV + depth) a *top-of-book* maker quote fills about as
often as fill-on-touch said — so the bar-model fill counts in #16/#19 were **not** badly overstated there,
and the book's loss really is **adverse selection** (spread < adverse on trending perps), not missed-fill
fantasy. The overstatement is dramatic the moment you quote into the stack (the sweep has to consume every
better level first). The unit tests pin both ends deterministically (front-of-queue ratio 1.0; below-best
with depth above → 0 until the cumulative queue clears). The truth for a real book sits between, and the
harness now *computes* it instead of assuming it.

**Verdict on the maker-rebate CLOB:** still not a clean "nets positive" — but for the first time the
structural net is judged on fills we could actually have gotten, against the −0.2bps HL rebate. A real read
needs a long session: `MM_L2_POLL_S=60 MM_L2_DURATION_MIN=120 MM_L2_COINS=BTC,ETH,SOL npx ts-node -r
tsconfig-paths/register scripts/mm-l2-session.ts` (hand-off — the dev box can't run a 2h foreground loop).

**129 suites / 869 tests** (+10: 3 HL L2 parser specs, 2 l2-tape/adapter specs, 5 harness specs), tsc clean.
HL L2 → ingested in [DATA_SOURCES.md](./DATA_SOURCES.md).

**Next:** (4) per-pool γ/κ tuning + the maker-rebate fee model on the HL/DEX books, now that fills are
honest; and **notional sizing in the live control plane** (`/api/market-making/launch` still uses fixed
`MM_QUOTE_SIZE_UNITS`, over-sizing high-priced perps — the session harness already sizes by $ notional).
Still-open fidelity: sub-minute flow (HL `trades`/WS) would replace the candle-volume estimate with real
per-trade aggressor data; funding-rate ingest for the carry leg.

## 2026-06-03 — Entry #21: per-pool γ/κ tuning on queue-aware fills + the venue maker-rebate fee model (step 4)

**Shipped (step 4 of the recommended order — unblocked by S33's honest fills).** You can only tune a
quoter honestly once you stop assuming every touched quote fills, so γ/κ tuning had to wait for the L2
queue model. Five pieces:

1. **Venue fee model** (`backtest/venue-fees.ts`) — `venueFeeFor(sourceId)` is the single source of truth
   for each venue's maker/taker bps: HL **maker −0.2bps rebate** / taker 2.5; Binance 1/5; GeckoTerminal
   **AMM LP-fee** (pool-dependent 1/5/30/100bps, a *cost*, no rebate); unknown → 0bps structural-only.
   Running an HL book at Binance's fee (or vice-versa) quietly flips the verdict — now it can't.
2. **γ/κ sweep** (`backtest/gamma-kappa-sweep.ts`) — `sweepGammaKappa` runs the **queue-aware
   LobReplayHarness** over a fixed tape for every (γ × κ × half-spread-floor) combo and ranks them
   drawdown-compliant-first, then by maker-net P&L at the venue's real fee. Crucially it **rebuilds the
   quoter per combo**: GlftQuoter/AS bake γ,κ from build params and ignore `ctx`, so varying the harness
   context would be inert — the sweep injects a registry-backed `buildQuoter`.
3. **L2 tape persistence** (`backtest/l2-tape-io.ts`) — `serializeTape`/`parseTape` (exact bigint↔string
   round-trip, versioned) so a live capture (the expensive part) becomes a reusable fixture: capture once,
   sweep many over the SAME flow — an apples-to-apples A/B, not noise between live windows.
4. **`scripts/mm-l2-tune.ts`** — loads saved tapes, sweeps γ/κ per coin at the venue fee, prints a ranked
   table + the winning calibration per coin. `mm-l2-session.ts` gained `MM_L2_SAVE_TAPE` to produce them.
5. **Notional sizing in the live control plane** — `/api/market-making/launch[-preset]` now accept
   `quoteNotionalUsd`; the (now async) book factory probes the live price and sizes `quoteSizeUnits =
   notional ÷ price` (`live/notional-sizing.ts`), so a $66k perp is no longer over-sized ~66,000× by the
   fixed unit default — the same lever the session/tuning harnesses already had. Default preserves the old
   fixed-unit behaviour.

**Verified.** Unit tests pin the logic deterministically: the sweep **differentiates + ranks** (a wider
floor that captures more spread wins; a DD-breaching combo is demoted below compliant ones), the fee model,
the tape round-trip, and the notional math ($50k of a $66k perp → 0.76 units, not 50,000). The full
**capture→save→load→sweep→rank→winner** path ran end-to-end on **real HL data** (10-step BTC/ETH tapes).

**Honest read from the live smoke:** at 5s-pro-rated volume on BTC/ETH top-of-book, *every* combo filled
**0** — the cumulative price-time-priority queue (S33) plus thin per-interval flow means a maker quote
below the sub-bps market spread never clears. That's the genuine microstructure, not a bug: a real per-pool
tuning verdict needs a **60s-poll, multi-hour capture** (`MM_L2_POLL_S=60 MM_L2_DURATION_MIN=120
MM_L2_SAVE_TAPE=… scripts/mm-l2-session.ts`, then `mm-l2-tune.ts`) — the hand-off. The tuning *machinery*
is proven; the *answer* is one long capture away.

**133 suites / 882 tests** (+13: venue-fees, gamma-kappa-sweep, l2-tape-io, notional-sizing), tsc clean.

**Next:** run the long capture + sweep to get the per-pool γ/κ winners (and whether HL's −0.2bps rebate
makes any calibration net positive on queue-aware fills); HL `trades`/WS to replace the candle-volume
estimate with real aggressor data; funding ingest for the carry leg; then the forward paper track record.

## 2026-06-03 — Entry #22: Hyperliquid is now the desk's default MM venue (+ per-book real venue fees)

**Decision (S35).** HL is the best MM *venue* — the only WIRED maker-**rebate** CLOB (−0.2bps), with L2 +
funding + 230 perps, no-key — so it's now the desk's **default MM venue**: `marketMaking.defaultSource` /
`MM_SOURCE` = 'hyperliquid', `MM_SYMBOL` = BTC, `MM_STRATEGY_ID` = mm-glft. A bare `/api/market-making/
launch` (no `source`) quotes HL. **Not the global feed:** `FEED_SOURCE` stays Binance — HL is perps-only,
a per-book reference source, not the engine spine (stat-arb needs Binance/Alpaca).

**The honest wiring that came with it:** every MM book is now priced at its OWN venue's real maker fee via
`venueFeeFor(srcId)` (S34) — HL −0.2bps rebate, Binance **+1bps base-tier**, DEX LP-fee — instead of a
desk-wide −1bps assumption. So the live P&L is honest per venue. (Side effect: the Binance stablecoin demo
now uses the +1bps base-tier maker *cost*, not the optimistic −1bps VIP rebate — more honest, changes its
result.) The 3 Binance MM presets pin `source:'binance'` so the HL default doesn't capture them.

**Still unproven:** whether HL's −0.2bps rebate makes any calibration net positive on queue-aware fills —
that's the long-capture + γ/κ-sweep verdict (next session). Venue decisions are managed in
`app-config.factory.ts` + `mm-market-presets.ts`; the analysis ledger is [DATA_SOURCES.md](./DATA_SOURCES.md).
133 suites / 883 tests, tsc clean.

**Next:** (1) long capture + sweep for the rebate-net verdict; (2) **HL funding ingest** (hourly funding;
`IFundingRateSource` on `HyperliquidClient` + period-aware `staticCarry` + `FC_SOURCE=hyperliquid`) — harvest
carry on the venue we already make markets on; (3) HL `trades`/WS for real aggressor data; (4) forward paper track.

## 2026-06-04 — Entry #23: the rebate-net verdict — first NET-POSITIVE honest-fill read (real WS flow + per-pool tuning)

**The question, finally answered (directionally).** Entries #20/#21 left the maker-rebate-CLOB thesis on a
cliff: the queue-aware harness was honest, but the only long capture ran on a **candle-volume estimate** of
aggressive flow, and every tuned (γ×κ×floor) combo filled **0** — so "does HL's −0.2bps rebate net positive
on honest fills" was unanswerable from that data. This session wired the **real HL trades WebSocket**
(per-trade taker flow, signed by aggressor side) + **funding accrual**, then ran the real thing: a
**111-step, 60s-poll, ~2h capture on BTC/ETH/SOL** with **100% real WS aggressor flow** (332/333 steps),
saved to `docs/research/l2-tapes/wsflow1-*` and swept with `mm-l2-tune.ts`. Artifact:
[docs/research/2026-06-04-mm-l2-wsflow1-verdict.json](research/2026-06-04-mm-l2-wsflow1-verdict.json).

**Finding 1 — real flow produces real (few) fills; fill-on-touch overstates 3×.** At the default γ=0.0025/κ=2
the desk logged **queueFills 3 vs touchFills 9 (ratio 0.33)** — fill-on-touch overstated fills by 3×. This is
the honest middle the harness was built to find: not 0 (the candle-estimate artifact), not 9 (the
fill-on-touch upper bound). Desk structural −$1,135 on $3M (−0.038%), **maxDD 0.22% → drawdown PASS**, profit
FAIL. The loss is small-sample inventory mark on a handful of unhedged fills, not a structural bleed.

**Finding 2 — a tuned BTC calibration is NET-POSITIVE on honest fills.** The 48-combo sweep, ranked
drawdown-compliant-first then maker-net at −0.2bps, found **BTC γ=0.0005 / κ=1 / 5bps floor → makerNet
+$345.08** (structural +$340.17), queueFills 5 (ratio 0.455), **maxDD 0.526%**. The tight-γ + wide-floor quote
captures **more spread (+$541) than it pays in adverse selection (+$434)** — the first time, across all the
DEX/HL work (Entries #16/#17/#19/#20/#21), that a calibration clears positive on fills we could actually have
gotten, at the rebate. **The maker-rebate-CLOB thesis is, for the first time, confirmed in the positive — on
BTC, on this window.**

**Finding 3 — ETH/SOL: stand aside (no profitable calibration this window).** For ETH and SOL every *filling*
combo in the grid was net-negative (adverse selection ≥ spread on the trending window), so the ranker
correctly returned a **0-fill combo** as the "winner" (0 P&L + 0 DD beats every losing quoting combo). The
honest read: on this 2h window the desk should **quote BTC and sit out ETH/SOL** — a coin-specific, regime-
specific edge, not a desk-wide one.

**Honest caveats (binding).** Single ~2h window, one regime, **tiny fill counts (0–5/coin)** ⇒ the per-pool
P&L is high-variance inventory mark on a few fills — **directional, not a deployable number**. Re-capture
across many sessions/regimes before trusting the BTC calibration live. (`mm-l2-tune.ts` also still prints a
generic "candle-estimate" caveat; for the wsflow1 tapes the flow is REAL WS — the tape format doesn't tag the
source, noted in the artifact.)

**Decision.** The frontier's central question moves from *"can a rebate book ever net positive on honest
fills?"* (now: **yes, BTC, +$345/2h/$1M, DD 0.53%**) to *"is it stable across regimes, and on which coins?"*
The next step is **repeated captures** (a scheduled multi-session sweep) to turn one directional read into a
distribution — exactly the kind of unattended multi-hour run the restart-safe-books + telemetry work (this
session) exists to support. Full machinery: capture (real WS flow + funding) → tune (per-pool, venue-fee-
aware, drawdown-first) → honest verdict, all on data we could have traded.

**Tests:** 137 suites / 911 tests (the trades-WS, funding full-stack, and restart-safe-books work this
session), tsc clean. See [RESEARCH_FINDINGS.md](RESEARCH_FINDINGS.md) §6 + [ROADMAP.md](ROADMAP.md).

## 2026-06-04 — Entry #24: HL universe MM discovery — scanning all 230 perps for new markets to make markets in

**The question.** We only ever quoted the BTC/ETH/SOL `hl-perps` preset, but HL lists **230 perps** and the
mission's growth frontier is *market discovery* (CLAUDE.md §1). Which HL perp should the desk make markets in?
Built a DB-free, server-free scan (`scripts/hl-universe-discovery.ts` + the pure, unit-tested
`src/market-making/screen/hl-universe-discovery.ts`): ONE `metaAndAssetCtxs` call → the whole universe + per-
coin funding + daily $ volume; shortlist by volume; per-coin HL klines → the SAME honest `scoreMmSuitability`
the live screener uses (spread + rebate − adverse, fillability-weighted). Artifact:
[docs/research/hl-universe/discovery-2026-06-04T13-26-25-849Z.json](research/hl-universe/discovery-2026-06-04T13-26-25-849Z.json);
multi-hour follow-up runbook: [docs/research/hl-universe/RUNBOOK.md](research/hl-universe/RUNBOOK.md).

**Finding 1 — a fixed-spread OHLCV scan nets NEGATIVE across every HL perp, and that's the honest, expected
result.** At a fixed 1bps half-spread on 1m bars, the *least-bad* perp (ETH, σ 11.6bps) still nets −9.2bps/RT;
the worst (WLD, σ 51bps) −49bps/RT. **QUOTABLE 0 / 230.** Why: the proxy charges full per-bar σ as adverse
selection (`2·0.5·σ_bar`) against a fixed tiny spread — but the live GLFT book quotes a **σ-proportional**
spread (σ-normalized since Entry #18). So a fixed-spread scan double-penalizes vol and structurally can't
certify MM profitability. This **corroborates** Entry #23: the maker edge is the rebate + queue position at a
σ-proportional spread — a fill/flow question only the L2 queue-aware harness resolves, never OHLCV.

**Finding 2 — the actionable output is the σ-ranked liquid shortlist (lowest inventory risk), and it surfaces
real non-major discoveries.** Ranked by 1m σ among liquid perps (≥$5M/day): **XRP 11.6bps**, DOGE 12.1, ASTER
12.1, BNB 13.0 — non-majors sitting at **major-grade calm** (ETH 11.6, BTC 11.7, SOL 13.4). **XRP is the
standout**: as calm as ETH, $96M/day, and funding **−19% APR** (longs are paid ⇒ a maker forced *short* earns
carry). These four are now the `hl-discovery` MM preset — the next L2-capture targets beyond BTC/ETH/SOL.

**Honest caveats (binding).** The shortlist ranks **inventory risk only** — *not* profitability. n=1 snapshot,
one regime; funding is reported, never scored (it only helps when its sign aligns with the involuntary
inventory). The verdict on these perps is the **L2 capture → γ/κ tune** pipeline (Entry #23 machinery) — the
multi-hour run in RUNBOOK.md, not this scan.

**Decision.** Discovery delivered a vetted, liquidity-filtered shortlist (XRP/DOGE/ASTER/BNB) and a launchable
paper preset; the honest next step is a multi-hour L2 capture on it + the BTC/ETH/SOL controls, then the
queue-aware tune — turning "230 perps" into "capture these, tune, and quote the winners."

**Tests:** 147 suites / 976 tests (+ the `hl-universe-discovery` pure module/spec + the `hl-discovery` preset),
tsc clean. See [RESEARCH_FINDINGS.md](RESEARCH_FINDINGS.md) §6/§7 + [ROADMAP.md](ROADMAP.md).

## 2026-06-04 — Entry #25: first BROAD high-fidelity L2 capture kicked off (20 perps, 6h) — verdict pending

Entry #23 gave the first net-positive honest-fill MM read, but on **one coin, one ~2h window (n=1)**; Entry #24's discovery scan produced the liquid shortlist. This entry marks the **first broad capture** toward a distribution: a **20-perp** (top HL perps by daily volume — BTC/HYPE/ETH/ZEC/SOL/NEAR/WLD/XRP/LIT/TON/ENA/XPL/VVV/ONDO/BNB/SUI/ADA/DOGE/PUMP/ASTER), **6-hour**, **10s-poll** L2 session with **100% real WS aggressor flow + funding + 10-min tape checkpointing** (`scripts/capture-hl-l2.sh`). The wide-grid tune (`scripts/tune-hl-l2.sh`: γ∈{0.0001…0.05}, κ∈{0.5…5}, floor∈{1…12}bps — deliberately brackets the Entry #23 boundary winner) is the **next session's first action**: it turns "BTC +$345/2h/$1M" into a per-coin, drawdown-compliant maker-net board across 20 markets. **No numbers yet** — the run is in flight; winners get recorded in [TUNED_PARAMS.md](research/TUNED_PARAMS.md) + a future Entry #26.

**Tooling milestone.** Capture + tune are now **one-command operator scripts** (no line-wrap footguns), with **mid-run tape checkpointing** (a crash never loses the run) and an [Operator's Manual](OPERATIONS_MANUAL.md) covering the three systems + the storage map. The research pipeline is now reproducible by the operator unattended. **Tests:** 147 suites / 976 tests, tsc clean. *(The L2-tune harvest is now slated for **Entry #27** — this evening's gap-closing session took #26 for funding-carry discovery first; the 6h capture finishes ~00:14 and is the next session's Priority 0.)*

## 2026-06-04 — Entry #26: HL funding-carry universe discovery — which perp pays persistent, harvestable funding

**Context.** "Cross-venue funding capture (long spot / short HL perp)" sat on the roadmap as a deferred diversifier; the per-basket carry P&L was already built (`scripts/funding-carry-research.ts` + `staticCarry`), but only over a **fixed symbol list**. This entry adds the **universe-scan discovery layer** — the carry analogue of Entry #24's MM universe scan — that ranks the **whole HL perp universe** by *persistent, harvestable* funding. New pure module + script + 7-spec triple (`src/market-data/funding/funding-carry-discovery.ts` + `scripts/hl-funding-discovery.ts`), [doc](FUNDING_CARRY_DISCOVERY.md).

**The model (honest by construction).** `net = funding harvested − one-time round-trip fee`; basis P&L **excluded** (delta-neutral ⇒ direction washes out, residual is mean-zero entry noise). The edge is the **continuous** funding stream; the 4-fill round trip is a **one-time** cost — so a perp is **harvestable** only when it clears **all four** gates: `|annualised funding| ≥ 8%` (material), `stableFraction = max(posFrac,1−posFrac) ≥ 0.70` (you can't harvest a sign that flips), `breakevenDays ≤ 20` (funding repays the round trip fast), and `dayNtlVlm ≥ $5M` (you can leg in). Each coin reports its `direction`: `SHORT_PERP` (harvest + funding: long spot/short perp) or `LONG_PERP` (harvest − funding).

**Real read — 14d, top-50 by volume, HL public API** (`docs/research/hl-funding/discovery-2026-06-04T18-05-48-312Z.json`):

| symbol | dir | annFund%/yr | stable | breakeven | vol$M | harvest |
|---|---|---|---|---|---|---|
| XMR | short perp | +35.7 | 0.97 | 1.4d | 13 | ✅ |
| TRUMP | long perp | −23.8 | 0.79 | 2.1d | 6 | ✅ |
| PURR | short perp | +23.8 | 0.89 | 2.1d | 7 | ✅ |
| BCH | long perp | −21.1 | 0.81 | 2.4d | 11 | ✅ |
| VVV / ZRO | short perp | ~+17 | 0.79 / 0.96 | 3.0d | 33 / 11 | ✅ |
| NEAR / GRASS / HYPE | short perp | +13–14 | 0.88–1.00 | ~3.8d | 230 / 6 / 2191 | ✅ |
| ETH / BTC | short perp | +7.8 / ~+8 | 0.88–0.97 | ~6d | 1799 / 7206 | · (just under the 8% gate this window) |

**23 of 49 scored perps harvestable.** The board cleanly separates the persistent payers (XMR, the meme/alt shorts) from the coin-flip funders (ADA/JTO/TON `stable ≈ 0.55–0.66` → rejected) and surfaces both directions (BCH/TRUMP pay **shorts**, so you harvest them **long the perp**).

**Honesty caveats (binding).** Funding-only; a 14-day window is **one regime**, not a forward track — re-run across regimes to build a distribution (the funding analogue of the γ/κ-distribution plan). `annNet%` over a short window is dominated by the one-time fee in the annualisation, so `breakeven` + `harvestableFundingPct` are the cleaner persistence signals (a +8% coin with a 6d breakeven is a real carry held past a week, even where `annNet%` reads slightly negative on a 14d window). The board is a **watchlist**, not a fill forecast: the deployable form (long Binance spot / short HL perp) and its real slippage/basis are the **live** verdict. **Corroborates** RESEARCH_FINDINGS' "funding carry real but modest (~3–8%/yr) on majors" — and shows the *fat* carry lives in the **non-major** perps.

**Tests:** 153 suites / 1019 tests (+ the `funding-carry-discovery` module/spec), tsc clean. See [FUNDING_CARRY_DISCOVERY.md](FUNDING_CARRY_DISCOVERY.md) + [ROADMAP.md](ROADMAP.md).

## 2026-06-05 — Entry #27: the 6h L2 harvest — MM has ~no clean spread edge; **inventory carry is the whole game** (→ a new directional strategy)

The 20-perp / 6h / 10s real-WS L2 capture (Entry #25) finished (1168 polls, ~5.8h, finished 2026-06-04 00:14, 45% real WS aggressor flow). Two reads off the same tapes: the **single default-config replay** (the unbiased read) and the **γ/κ/floor sweep** (100 combos/coin — the in-sample optimum). Artifacts: `docs/research/l2-tapes/replay-20260604-default-config.txt`, `tune-20260604-0052.txt`, board in [TUNED_PARAMS.md](research/TUNED_PARAMS.md).

**Read 1 — default config (unbiased): the desk LOSES.** Desk structural **−$7,355.97 / $20M (−3.7bps)**, rebate-net −$7,312, maxDD 0.72% (PASS) but net>0 **FAIL**. The loss is concentrated in a few high-σ, low-fill coins that **trended against forced inventory**: NEAR −$4,637 (4 fills), LIT −$3,371 (15), ZEC −$3,267 (17), HYPE −$2,586 (6), TON −$2,268 (49), XPL −$1,837 (18).

**The decomposition is the headline.** `structural = spread_captured − adverse_selection + inventory_carry` ([pnl-attribution.ts](../src/market-making/backtest/pnl-attribution.ts); adverse is +=loss). Computing `spread − adverse` per coin at the default spread:
- **spread − adverse ≤ 0 on 14 of 20 coins.** Adverse selection eats the **entire** half-spread. At naive params the maker has **no clean spread edge** — informed/aggressive flow fills us right before the move.
- the *whole* per-coin P&L is then **inventory carry** — the mark-to-market on the position the flow forced us to hold — swinging from **−$4,755 (NEAR) to +$3,815 (WLD, on 1 fill)**. That is **~5× the spread term** and is **directional luck** over a single window, not a maker edge. The −$7.4k desk loss is "we happened to be carrying the wrong inventory on the coins that moved."

**Read 2 — the γ/κ sweep: every coin "wins," and that's the trap.** Picking the best of 100 combos/coin flips all 20 positive (desk ≈ +$90k in-sample). But it is a textbook **overfit / multiple-testing** artifact: the eye-watering nets correlate with the **highest drawdowns and/or tiniest fill counts** — ZEC +$22,411 (maxDD 1.58%, 17 fills), WLD +$22,334 (1.80%, **1 fill**), ENA +$14,758 (1.69%), VVV +$11,120 (0.65%, 71). The optimizer simply found the (γ,κ,floor) that **best rode this window's drift** — i.e. it maximised inventory-carry luck. Tell: **every** winner chose **κ=0.5 (lowest)** + near-lowest γ ⇒ the widest spreads + strongest inventory skew. Read that as the data shouting *the default spread is too tight*. The sweep board is an **upper bound**, not a forecast.

**The defensible signal (TIER A): MM edge is real but THIN, and lives in the liquid, low-σ coins.** Filtering for positive net **AND** low maxDD **AND** enough fills to be statistically real **AND** ideally spread−adverse>0: **BNB** (184 fills, maxDD 0.075%, spread−adverse **positive (+$9)** even at default — the model citizen), **DOGE** (303 fills, DD 0.027%), **ETH** (192, 0.098%), **SOL** (130, 0.092%), **XRP** (117, 0.121%), **ADA** (105, 0.105%), **SUI** (96, 0.090%). These are where fills recycle fast, adverse selection is controllable, and a *modestly wider* spread can push spread−adverse positive. The thin/volatile coins (NEAR/ZEC/LIT/HYPE/WLD/XPL/VVV) are **TIER C** — you either lose (tight spread) or win by luck (overfit). **Asset-class predictor: rank by σ (lower better) × fill-frequency/liquidity (higher better); the steady-income quadrant is low-σ + deep-book majors/large-caps.** Trim toward that quadrant across regimes → a short, durable list.

**Answers to the operator's questions (recorded for the file):**
- *What are the losses?* **Adverse selection** (fills right before the adverse move) **+ inventory carry** (held position marks against us when the coin trends). Mechanically: aggressive sellers hit our bid → we're long → price drops → carry bleeds. *(Initial fix hypothesis was "σ-proportional WIDER spreads + tighter inventory." **CORRECTED in Entry #28**: a clamped+widened test showed widening **alone does NOT** flip spread−adverse positive — adverse is a **fair-value** problem (stale-mid selection effect), not a width problem. Real fixes: **microprice/fast-requote** machinery + **intentional carry** + **cut the toxic coins**. Tighter inventory does still kill the carry variance.)*
- *What does an MM watch to make money?* σ (sets spread), the **microprice/fair value** (quote off it, update fast — stale quotes are the #1 adverse-selection source), order-flow imbalance + queue position (fill prob + adverse direction), **inventory** (skew + size), toxicity/VPIN (when to widen/pause), funding (carry on inventory), fees/rebate (the structural floor). Perps have no option greeks; the analogues are σ (vega-like), microprice tracking (delta), inventory skew (the position greek), short-gamma awareness (lose on big moves).

**THE KEY INSIGHT (Ronnie, 2026-06-05) — turn the dominant term into alpha.** If inventory carry is ~5× the spread term and is the thing that actually moves the needle, then on coins the desk has a **directional house view** on, **take the carry on purpose**: bias the maker to rest at a non-zero **target inventory** `q* = bias·Q_max` (skew the AS/GLFT reservation toward `q*` instead of 0). You then earn **spread + rebate + chosen directional carry (+ funding when aligned)** — and because you *accumulate at better-than-mid prices*, a wrong view is cushioned by the maker edge (a convex, maker-financed directional option). This is the real-dealer **"axe"**. Full requirement + math + the bias-signal seam (daily momentum / weekly funding-regime / long-term fundamental, blended) + 5 other ways to monetise a committed bias: **[DIRECTIONAL_MM_STRATEGY.md](DIRECTIONAL_MM_STRATEGY.md)**. It synthesises directly with Entry #26 (funding-carry tells us which side is *paid* to hold). The `PnlAttributor` already measures the inventory-carry line, so the strategy's alpha is observable from day one.

**Next (the operator's 8h re-run + the path).** Capture **8h on the TIER-A 10** (DOGE,BNB,ETH,SOL,XRP,ADA,SUI,ENA,PUMP,ONDO) at wider spreads + tighter inventory, re-tune with a **wider, inventory-clamped grid**, and compare — the test of whether a wider-spread/tight-inventory maker is **steadily** (not luckily) positive. Then build the directional-MM quoter + sweep (P1–P2 of the strategy doc). The honest goal stands: a short list of low-σ liquid coins where spread−adverse>0 at a defensible spread + low drawdown — *then* scale venues. **Verdict: neutral taker-tight MM is not a business; wider-spread maker on liquid coins is marginal-but-real; the edge that scales is intentional, validated directional carry layered on the maker.** No deployment on one window — the 8h re-run + multi-regime distribution is the gate.

## 2026-06-05 — Entry #28 (BRIEF): can the spread alone make money? No — and which coins to cut

**Question (Ronnie):** can we tweak the spread to make money, "pricing in" adverse selection? Is DEX/HL MM a losing business *purely on spread*? **Critically tested it** — re-ran the 6h tapes with **inventory CLAMPED to 2 lots** (so net ≈ spread − adverse + rebate, carry minimised) across a **wide spread ladder** (floor 2→20bps). Artifact: `docs/research/l2-tapes/tune-20260604-clamped-wide.txt`.

**Result — spread − adverse is NEGATIVE at every width, on every liquid coin:**

| coin | spread | adverse | spread−adv | | coin | spread | adverse | spread−adv |
|---|---|---|---|---|---|---|---|---|
| BNB | +40 | +53 | **−13** | | ADA | +15 | +32 | **−17** |
| DOGE | +13 | +46 | **−34** | | SUI | +85 | +595 | **−510** |
| SOL | +323 | +1274 | **−951** | | ETH | +33 | +123 | **−90** |
| XRP | +33 | +67 | **−34** | | BTC | +101 | +112 | **−12** |

(NEAR shows spread−adv +24 — but on **1 fill**; noise, and NEAR is otherwise the most toxic coin.) **Every positive NET in the whole study is inventory carry, never spread.**

**Why widening the spread does NOT fix it (the key quant point).** Adverse selection is a **fair-value problem, not a width problem**. You get picked off because your quote is centred on a *stale mid* and is on the wrong side of where price is *going*. Widening the spread changes *which* fills you get — you trade benign flow for the toxic crossings that only happen on a real move (the **selection effect**) — so adverse rises with the spread and `spread − adverse` barely moves. Proof in the data: **BNB at floor 1bps had adverse +$1.39 (benign flow); widened to floor 2bps adverse jumped to +$53** — wider made it *worse*. So "don't chase fills, quote wider" does **not**, by itself, make money on this tape.

**So is HL/DEX MM a losing business?** On the **naive** maker this sim models — quote a symmetric spread off the **mid**, hold to a markout, 10s re-quote — **yes, you lose to adverse selection at any spread.** Real professional MMs are **not** doing that; they win three ways the current sim doesn't model: (1) quote off the **microprice** (size-weighted fair value that *predicts* the next tick) not the mid; (2) **cancel/replace in milliseconds** so a stale quote never gets picked off (our full-markout adverse is an *upper bound* — it assumes you never re-quote); (3) **rebate at scale** — thousands of tiny fills, adverse engineered to ≈0, living on the −0.2bps. The sim is honestly telling us: **without the microprice + speed machinery, passive spread MM has no edge.** That machinery is a *code* investment, not a parameter — it's the real unlock.

**Two real paths to edge (both honest):** **(A)** reduce adverse at the source — build a **microprice fair-value quoter + markout-aware re-quoting + flow-imbalance skew** (the next code milestone; it should flip `spread − adverse` positive on the liquid coins, which is the whole game). **(B)** stop fighting carry and make it **intentional** — the directional/axed maker ([DIRECTIONAL_MM_STRATEGY.md](DIRECTIONAL_MM_STRATEGY.md)), since carry is the only reliably large term. Likely **both**: microprice for the steady spread floor, directional carry for the alpha.

**Cut the junk now (conservative, defensible after 1 run).** You can't crown a *winner* from one window, but you can rule out coins that are **structurally untradeable** by *disqualifying* characteristics (illiquidity + drawdown, not edge):

> **Exclusion rule:** drop a coin if (fills < ~30 / 6h) **OR** (default-config maxDD > 0.40%) **OR** (default net < −$1,500). All three are liquidity/risk disqualifiers, regime-robust.

| CUT (toxic / junk) | fills/6h | maxDD | default net | why |
|---|---|---|---|---|
| **NEAR** | 4 | 0.65% | −$4,637 | thinnest, worst loss |
| **HYPE** | 6 | 0.72% | −$2,586 | highest DD, 6 fills |
| **WLD** | 1 | 0.46% | +$3,995* | 1 fill = pure noise (*carry) |
| **LIT** | 15 | 0.69% | −$3,371 | thin + high DD |
| **ZEC** | 17 | 0.53% | −$3,267 | high-σ $515 coin; spread−adv −352 even at 20bps |
| **XPL** | 18 | 0.30% | −$1,837 | optimizer chose "stand aside" |
| **TON** | 49 | 0.33% | −$2,268 | negative, mediocre |
| **VVV** | 71 | 0.14% | +$2,126* | all carry (spread−adv −230); *carry-trap |

**KEEP (clean substrate — liquid, low-σ, fills recycle, low DD):** DOGE (303 fills, DD 0.027%), BNB (184, 0.075% — the only default spread−adv≈+), ETH (192, 0.098%), SOL (130, 0.092%), XRP (117, 0.122%), ADA (105, 0.105%), SUI (96, 0.090%). Carry-watch but liquid: ENA (130, 0.080%), ONDO (65), PUMP (48). Benchmark: BTC (21 fills — control only). These are the coins to carry the **microprice** + **directional** work on, and the 8h re-run.

**Verdict:** naive passive spread MM is **not** a business on HL at this fidelity — adverse selection wins at every width. The edge is **fair-value prediction (microprice + speed)** and/or **intentional carry**; the cheap immediate win is **coin selection** (cut the 8 above) + **inventory discipline**. The 8h re-run + the microprice quoter are the next two moves.

## 2026-06-05 — Design note: the next focus is the FAIR-VALUE ENGINE (price, don't widen)

Following #28 (spread can't beat adverse at any width — it's a fair-value problem), the next sessions' headline is the **theo engine**: quote around a real-time fused fair value `μ` + its uncertainty `Σ`, not the stale mid. Full design (grounded in Stoikov micro-price, HFT theo engines, dealer "axe", the CIO/house-view process, Grinold-Kahn alpha blending, Kalman fusion): **[FAIR_VALUE_AND_THESIS_DESIGN.md](FAIR_VALUE_AND_THESIS_DESIGN.md)**. Layers, cheapest-highest-IC first: **A micro-price** (book imbalance) → **B Binance→HL lead-lag** (our structural edge — a faster/deeper lead venue we already pull; *do this first*) → **C flow drift + confidence-scaled spread/size** (Kalman) → **D technical predictor** (OOS-gated) → **E directional thesis drift**. The view enters via a **Thesis Register** (the house view made durable + machine-usable + P&L-graded — research→quotes→accountability), feeding the directional-MM target inventory + spread asymmetry. Each signal earns its weight by OOS IC before it moves a live quote. **F1 = microprice quoter, F2 = Binance lead-lag** — both replayable on the 20 saved tapes, both the direct test of whether `spread − adverse` flips positive. This is the real unlock; the γ/κ tuning was rearranging deck chairs on the wrong price.

## 2026-06-05 — Entry #29 (F1 built): micro-price quoting cuts adverse selection ~21% — real, partial, the right direction

Built **F1** of the fair-value engine ([FAIR_VALUE_AND_THESIS_DESIGN.md](FAIR_VALUE_AND_THESIS_DESIGN.md)): an optional `referenceMicros` (the quote center / "theo") on `QuoteContext` that GLFT/AS straddle *instead of the raw mid*, fed by the book-imbalance micro-price (`MicroPriceCalculator`) the `LobReplayHarness` computes per step (`microDepth` config). **Attribution stays scored vs the plain mid**, so it honestly measures whether quoting around the micro-price reduces adverse selection. `referenceMicros=undefined` reproduces the mid-quoter bit-for-bit (swap-seam default; 153 suites/1021 tests green). Compare tool: `scripts/mm-microprice-compare.ts`.

**Result — 6h keep-coin tapes, fixed γ=0.0025 κ=0.5 maxLots=2, mid vs micro (depth 5):**

| floor | desk spread−adverse MID | MICRO | Δ |
|---|---|---|---|
| 5bps | −$1,020 | **−$801** | **+$219 (+21%)** ✅ |
| 8bps | −$654 | −$557 | +$97 ✅ |
| 1–2bps | −$474 / −602 | −607 / −616 | −133 / −14 (no help at tight floors) |

**Read (honest):** the micro-price **reduces the adverse-selection bleed where adverse is worst** (wider floors, where you fill on real moves) — +21% at 5bps, 7/11 coins improved. It does **not** help at the tightest floors (1–2bps), where you're rebate-farming benign touch flow and the micro-shift just moves you off those benign fills (the tight-floor MID is the least-negative naive config, −$474 — the BNB rebate-farming regime). And it does **not** flip the spread edge positive on its own — spread−adverse stays negative desk-wide at every floor. So F1 is a **real, measurable, partial** fix — exactly as the layered design predicted: micro-price is Layer A; the bigger lever is **F2 (Binance→HL lead-lag)** — a faster/deeper fair value we uniquely already pull — plus **confidence-scaled spread/size** (F3). Two honesty caveats: it's one window (the 8h run gives a second), and the micro-shift drops some coins to 0 fills at wide floors (XRP/SUI) — a fast-requote/confidence refinement for F3. **Verdict: the theo direction is confirmed by data — keep building the stack; F2 next.**

## 2026-06-05 — NEXT-SESSION HAND-OFF (do not lose): finish F2 + F3, then a NEW 8h proof run

If this session runs out: the plan is locked. **Complete the fair-value stack and prove it measurably beats the baseline.**
1. **F2 — CROSS-VENUE fair-value fusion** (the biggest loss-minimiser; in progress). **IMPORTANT (Ronnie): HL is ITSELF a lead/price-discovery venue, not just a Binance follower** — so do NOT assume Binance leads. **MEASURE who leads, per coin** (Binance may lead majors via its deeper book; HL may lead its native/dominant coins; some are contemporaneous), then fuse `μ = micro + β·(P_binance − P_hl_mid)` with **β fit per coin from the data — and β≈0 is a valid, expected outcome** (HL self-sufficient ⇒ the cross-venue term adds noise, skip it). Backtestable on the EXISTING 6h tapes — Binance **1s klines are available** for the window (15:14–21:14Z 2026-06-04) via `BinancePublicClient.historicalKlines(sym,'1s',start,end)`; align to HL steps by ts, compute the **two-sided** lead-lag cross-correlation (each venue's returns vs the other at ± lags → who leads, by how much, β, stability), then replay mid / micro / micro+fused and report adverse reduction **per coin** (adopt the cross-venue term only where it measurably helps). Wire `leadMicros[]`+`leadBeta` into `LobReplayHarness` (default off ⇒ unchanged) + **augment the capture to record the Binance mid per step** so future tapes + the live path carry both venues.
2. **F3 — confidence-scaled spread/size** (Kalman v1): spread + size = f(fair-value uncertainty Σ, σ, VPIN) — quote tight+big only when certain. This is the lever expected to finally flip `spread − adverse` POSITIVE on the liquid coins.
3. **THEN re-run a NEW 8h capture** on the keep coins WITH the full stack (micro + lead + confidence) and **compare to the 6h/8h baselines** — the honest, measurable proof that the theo engine improves the model (the quant's job: show the number moved). Record as Journal #30.

Commits: F2a (math+wiring), F2b (measurement+backtest), F2c (capture records Binance), F3 (confidence-scaled) — **separate commits, ONE PR** (with F1). Honesty rails hold: each layer earns its weight by reducing adverse on the tapes before live; `referenceMicros=undefined`/no-lead reproduces today's quoter bit-for-bit. See [FAIR_VALUE_AND_THESIS_DESIGN.md](FAIR_VALUE_AND_THESIS_DESIGN.md) + Entry #29 (F1: micro-price −21% adverse, real+partial).

## 2026-06-05 — Entry #30 (F2 verdict): HL self-discovers — cross-venue fusion is a NO-OP at our cadence (Ronnie was right)

Built **F2** (cross-venue fair-value fusion) the honest way — *measure* who leads, don't assume — and the data delivered a clean negative result. Per coin, fetched Binance 1s klines over the 6h tape window, aligned the most recent fully-closed Binance price to each HL step (no lookahead), measured the two-sided lead-lag cross-correlation + the error-correction β, then replayed mid / micro / micro+fused (`scripts/mm-leadlag.ts`, harness `leadMicros[]`+`leadBeta`).

| coin | leads | lag | peak corr | β | s−adv micro→fused | net micro→fused |
|---|---|---|---|---|---|---|
| BTC | **sync** | 0 | 0.982 | +0.004 | −340 → −334 | −1092 → −1161 |
| ETH | sync | 0 | 0.982 | +0.005 | −72 → −72 | flat |
| SOL | sync | 0 | 0.970 | −0.011 | −267 → −323 | worse |
| BNB | sync | 0 | 0.974 | −0.017 | −4.2 → −4.8 | flat |
| DOGE/XRP/ADA/SUI | sync | 0 | 0.92–0.97 | ≈0 (−0.00…−0.055) | ≈flat / mixed | mixed |

**Verdict: HL is a price-discovery venue in its own right (Ronnie, 2026-06-05) — confirmed by data.** At the 18s decision cadence the book operates at, HL and Binance are **contemporaneous** (corr ~0.97) and HL shows **no error-correction toward Binance** (β≈0). The cross-venue term adds **nothing** (desk s−adv micro −683 → fused −800, slightly WORSE — the tiny βs are noise-fitting the perp-vs-spot basis). **Decision: skip the cross-venue fusion at our frequency; HL's own micro-price (F1) IS the fair value.** The machinery is built + tested (`cross-venue.ts`, 7 specs) and stays available behind the seam (β=0 default ⇒ off), but we do **not** adopt it and we do **not** augment the capture to record Binance (F2c cancelled — building plumbing for a confirmed no-op is the opposite of the doctrine).

**Honest caveat (the one nuance):** the lead-lag was measured at **18s granularity** (the tape's poll cadence). A genuine CEX↔DEX lead almost certainly exists at the **millisecond–second** scale — but it's (a) invisible at 18s and (b) **un-exploitable by a 10–18s-polling book anyway** (capturing it is a latency game, a different project). So for *this* desk, at *this* speed, the finding stands: **don't chase Binance; HL self-prices.** The lever that remains is **F3 — confidence-scaled spread/size** (quote tight+big only when the HL micro-price uncertainty Σ is small), which is where the spread−adverse flip should come from. F2 spent its budget proving a no-op so we don't carry dead weight — exactly what the gates are for.

## 2026-06-05 — Entry #31 (F3 + the unifying finding): cadence is the binding constraint → go millisecond

Built **F3** (confidence-scaled spread): the half-spread scales with current flow toxicity vs its rolling average — TIGHTEN on calm/benign flow (the BNB rebate-farming regime), WIDEN on toxic one-sided flow. New `spreadScale` on `QuoteContext` (GLFT+AS apply it after the rails, 1-micro hard min; undefined⇒unchanged), driven by the harness from `|aggBuy−aggSell|/(aggBuy+aggSell)` (`f3Toxicity` config). Unit-tested; 154 suites/1029 tests green.

**Result — micro vs micro+F3, 6h keep tapes:** desk spread−adverse **−$801 → −$1,252 (WORSE)**; net rose (+2213→+2685) but that's carry noise, not edge. F3 helped 6/11 coins on s−adv (BNB/DOGE/ENA/ONDO/PUMP/XRP) and hurt 5 (ETH/SOL/ADA/SUI/BTC). **Verdict: F3 v1 does NOT improve the spread edge at 18s** — the single-step toxicity signal is too noisy to time at this cadence. Kept behind the seam (off by default) for finer-cadence use.

**THE UNIFYING FINDING (and why Ronnie's millisecond instinct is right).** Across the whole fair-value stack on the 6h tapes:
- **F1 micro-price: confirmed −21% adverse** (real, the only clear win).
- **F2 cross-venue: no-op** — at 18s, HL/Binance are synced (corr 0.97, β≈0); HL self-discovers.
- **F3 confidence-scaled: inconclusive/slightly negative** — toxicity too noisy to time at 18s.
The pattern is not three failures — it's **one root cause: our 18s poll cadence is far too coarse for the levers that actually beat adverse selection.** Adverse selection is a *sub-second* phenomenon (you get picked off in milliseconds), so: (a) the CEX↔DEX lead-lag lives below ~1s and is invisible/inactionable at 18s (F2); (b) flow toxicity must be timed tick-by-tick, not over 18s buckets (F3); (c) the markout adverse in the sim is an 18s window — a real book re-quoting every few ms holds far less stale-quote risk, so **the true adverse is much smaller than our 18s sim shows.** This is precisely why real MMs run microsecond loops.

**→ NEXT MILESTONE (Ronnie, 2026-06-05): MILLISECOND cadence.** Move from 10–18s REST polling to **event-driven WS capture** — HL `l2Book` + trades WS, Binance depth + trade WS — reconstruct the book on every update, timestamp to the ms, and replay/quote on **every tick**. Then re-run the whole stack: F1/F2/F3 should come alive (the lead-lag becomes visible AND exploitable; toxicity becomes timeable; markout adverse collapses toward the true, much-smaller number). Prove it measurably on a ms tape (a few minutes is thousands of ticks), log + journal, then **scale on hardware/colocation when we move to big venues** — the latency game is exactly what justifies the infra spend. Plan + the honest mechanism in [FAIR_VALUE_AND_THESIS_DESIGN.md](FAIR_VALUE_AND_THESIS_DESIGN.md). The 18s tapes did their job: they proved the fair-value *direction* (F1) and that *cadence* — not parameters — is now the wall.

## 2026-06-05 — Entry #32 (THE PROOF): sub-second cadence FLIPS the spread edge positive — carry is now the only loss

Harvested the **8h sub-second** run (`hl-fine-20260605`, 5 coins BTC/ETH/SOL/BNB/DOGE, **46,788 steps/coin** at ~0.6s, F1 micro depth 5 + F3 + γ0.0025/κ0.5/floor5/maxLots2). Tools: `mm-microprice-compare`, `mm-leadlag`.

**THE HEADLINE — cadence flipped the spread edge from losing to winning:**

| metric (desk `spread − adverse`) | 18s run | **sub-second run** |
|---|---|---|
| MID quoter | **−$1,020** | **+$133** ✅ |
| MICRO quoter | −$801 | **+$174** ✅ |

A **7× swing** from deeply negative to positive. **Cadence is the dominant lever** — at ~0.6s you re-quote fast enough that stale-quote pick-offs collapse, so adverse selection no longer eats the spread. The micro-price (F1) adds a **consistent further +$42** (+133→+174), exactly as at 18s. Per coin, `spread − adverse` is now **positive on all 5** (BTC +25, ETH +130, SOL +107, BNB +28, DOGE +24); on ETH/DOGE the adverse term went **negative (a gain)** — fills land on the favourable side. **ETH (+$165) and DOGE (+$190/$278) are net-positive at low DD.** Ronnie's millisecond instinct is vindicated with a hard number.

**What's still losing: inventory carry, not the spread.** Desk net is still **−$6.7k to −$7.5k** — but now *entirely* from carry on the coins that **trended** over the 8h (SOL −$1.8k, BNB −$2.3k, BTC −$1.2k; the 2-lot clamp bounds it but a one-sided 8h drift still bleeds a held book). The **spread business is now profitable; the directional exposure is the leak** → exactly the case the **directional/axed MM** converts from leak to chosen alpha (building it next).

**F2 re-checked at sub-second: still a no-op.** Lead-lag is **sync (lag 0), β≈0** on all coins; HL self-prices even here. (Peak corr fell 0.97→~0.6 because Binance 1s klines can't resolve sub-second HL moves — a *true* sub-second cross-venue test needs Binance **WS depth**, §6b. The conclusion stands at our data resolution: don't bolt on Binance.)

**Honesty caveats (binding):** (1) **88% of steps used the candle-volume flow ESTIMATE** — at ~0.6s the WS prints are sparse per interval, so most steps fall back to the tick-rule estimate; the *qualitative* flip (−1020→+133, a 7× swing) is robust, but the *exact* +$133 isn't gospel — a clean read needs dense **WS-event flow** (§6b, the true-ms milestone). Depth is always real L2. (2) queue-aware fills 3,350 vs touch 141,991 (42× overstatement) — at fine cadence you "touch" constantly but rarely reach the queue front; queueFills is the honest lower bound. (3) one 8h window, one regime. **Verdict: the fair-value direction (F1) + the cadence (Ronnie) together make the SPREAD edge real and positive. The remaining loss is carry — the next build (directional MM) is precisely aimed at it.**
