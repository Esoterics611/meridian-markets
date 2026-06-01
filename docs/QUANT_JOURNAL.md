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
