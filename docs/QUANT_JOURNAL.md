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

## 2026-06-05 — Entry #33 (build): the directional/axed MM quoter — mechanism works; it's a BET that needs a validated view

Built `DirectionalGlftQuoter` (`mm-directional-glft` in the registry) per [DIRECTIONAL_MM_STRATEGY.md](DIRECTIONAL_MM_STRATEGY.md): GLFT that rests at a **target inventory q*=bias·maxLots** instead of 0, so where the desk holds a house view it accumulates the position via the maker (earning spread+rebate while building it — the dealer "axe"). Optional conviction drift nudges the center toward the view. **bias=0 reproduces neutral GLFT bit-for-bit**; F1 `referenceMicros` + F3 `spreadScale` honoured. 8 unit specs (skew toward target, rest-at-target, accumulate long/short, conviction drift, registry). 155 suites / 1037 tests.

**Honest demo on the 8h fine tapes (which drifted +0.3–0.6%, choppy):** an arbitrary **long bias LOST** — desk net −$7.2k (bias 0) → −$12.9k (0.5) → −$15.1k (1.0). The mechanism is verified (net moves monotonically with bias — it really accumulates the position), but **blind bias on a weak/choppy window doubles the loss**: aggressive one-sided accumulation fills on the toxic side (s−adv fell +174→+103) and the held long bleeds through the chop, and the small net drift (+0.4%) is nowhere near enough to pay for it. **This is the result the design predicted, not a failure:** the directional MM is a *bet*, and an **unvalidated bias is leverage on noise**. The quoter is the engine; the **bias SIGNAL** (`IBiasSource` — daily momentum / weekly funding-regime / long-term house view, each OOS-gated for forward-return IC before it sizes carry) is the piece that decides *whether/when/how much* to lean, and it's the next build. **Takeaway:** carry is real and large (Entry #32), and we now have the tool to *choose* its sign — but only a validated view earns the right to use it. No bias goes live on conviction alone.

## 2026-06-07 — Entry #34 (session: the profit-run prep + THE DIRECTIONAL DECISION)

Built the machinery to make the next run profitable, and made the directional call.

**Shipped (all on master, tested):**
- **Funding ingest** (`FundingRefreshCron`) — the perp carry rate now refreshes through the run instead of freezing at launch (the 5th P&L line stays honest; also the `FundingBiasSource` input).
- **F1 micro-price center, LIVE** — the live book now centers quotes on the order-book micro-price (was: stale closed-bar mid). The biggest single adverse-selection cut, brought from replay into the live loop. `MM_MICROPRICE_DEPTH=5`.
- **`IBiasSource`** (Null/Funding/Manual/Composite) — the directional view is now a per-tick, **OOS-gated** input (`effectiveBias` zeroes any unvalidated reading), wired into `DirectionalGlftQuoter` (ctx.bias overrides the static param) + the book. Systematic default + house-view override capped by the data.
- **C2 fast path** — the queue-aware `L2LiveFillEngine` + sub-second `L2PollDriver` (real HL L2 + trades-WS), wired into the live loop with the no-double-count coexistence guard and the cancel/replace **latency rail** (no free-lunch fills). `MM_FAST_REQUOTE_ENABLED` (default off).
- **#1 OOS gate** (`scripts/directional-bias-oos.ts` + `forward-return-ic.ts`) — purged-k-fold + deflated-Sharpe; VALIDATED only at DSR≥0.95. Built + unit-proven on synthetic fixtures.

**THE DIRECTIONAL DECISION — first run is NEUTRAL (b=0), all asset classes.** Ronnie has no market view and delegated the call to me, from the data. The data verdict: **there is none yet** — the sandbox has no network, so the OOS sweep produced **no real per-coin numbers**. Per the gate, a signal that has not shown OOS forward-return prediction sizes **zero** carry — and Entry #33 already proved a blind bias on a weak window *doubles* the loss (−$7.2k→−$15.1k). So riding a view now is exactly the mistake the whole design guards against. **Decision: the first run validates the cadence/fair-value fix NEUTRAL; the directional bias stays OFF until a signal clears the gate on real data.**

By asset class (priors, NOT decisions — hypotheses the sweep will test): **momentum on the majors (BTC/ETH/SOL, daily/weekly)** is the likelier validator; **funding-as-direction is likely weak** (carry-sign persistence ≠ directional prediction). The unlock: operator runs the sweep on a networked host → any VALIDATED row (sign + cap |b|=clamp(4·|IC|,0,0.5)) is set via `ManualBiasSource` for a *later* directional run.

## 2026-06-07 — Entry #35 (the directional verdict, on REAL data): BTC funding-paid-side is the ONE validated tilt

Ronnie ran `scripts/directional-bias-oos.ts` on real HL history (180d×1h, BTC/ETH/SOL/BNB/XRP + AVAX/LINK/ARB; 88 trials, σ_SR 0.068). **Exactly one trial cleared the deflated-Sharpe gate (DSR≥95%): BTC · funding-paid-side · 168h horizon — IC 0.133, hit 54%, +121.7bp/obs, DSR 99% → VALIDATED, cap +0.39.** Everything else INCONCLUSIVE/NOT_VALIDATED.

**Decision (mine, delegated): BTC gets the funding-paid-side bias (|b|≤0.39, weekly carry-regime tilt); every other coin + momentum stays NEUTRAL.** Momentum is dead here — short-horizon ICs are *negative* (reversal), so my earlier "momentum on majors" prior was wrong; this is exactly why we validate instead of guess. The BTC validation is corroborated by a coherent sub-threshold positive funding pattern across majors (BTC 72h DSR 84%, ETH 168h 67%), so it's a signal, not a lone fluke — but a modest one (one survivor of 88).

**Encoded:** `MM_FUNDING_BIAS_SYMBOLS=BTC` / `MM_FUNDING_BIAS_MAX=0.39` (factory defaults). The module attaches a validated `FundingBiasSource` only to a `mm-directional-glft` book on a validated coin — `effectiveBias()` zeroes anything unvalidated, so it's honest by construction. The funding tilt is a WEEKLY-horizon bet and runs on the bar-path directional book (it doesn't need C2's sub-second cadence — that's a separate adverse-selection concern, run neutral). Re-run the sweep periodically; regimes shift.

## 2026-06-07 — Entry #36 (the re-run that demoted BTC + the 10h run plan): the validation was a knife-edge, not an edge

Re-ran the #1 OOS sweep on real HL history (`docs/research/2026-06-07-13-48-...json`), this time **9 coins / 108 trials** (added DOGE; σ_SR 0.081, expectedMaxSharpe 0.208). The verdict **moved**, and that movement is the finding:

- **BTC · funding · 168h** — the coin currently encoded into the live config — fell to **INCONCLUSIVE (DSR 0.36)**. Same IC (~0.10–0.13, Sharpe 0.203) as the #35 run where it was VALIDATED at DSR 99%; the only thing that changed is that adding one coin raised the multiple-testing bar past its Sharpe. **A finding that flips when you test one more thing was never robust** — BTC was sitting on the deflated-Sharpe boundary, not above it.
- **ARB · funding · 72h & 168h** now "validate" at **DSR 1.0** (IC 0.24 / 0.35) — but its fold ICs are `[-0.10, 0.40, 0.52, -0.11, 0.65]`: two *negative* folds, wild swings. That's a **single 180-day alt downtrend** that funding tracked, i.e. leverage on one trend, not a stable predictor (BTC's folds are unstable too: `[-0.50, 0.27, -0.03, 0.37, 0.17]`). This is exactly the "funding-as-direction on a trending coin" trap Entry #33 warned doubles the loss off-trend.
- **Pooled (perClass), nothing validates:** every `funding-paid-side` class verdict is INCONCLUSIVE (majors pooled IC ~0.02–0.07, alts ~0.05–0.07); every momentum class is NOT_VALIDATED (short-horizon ICs negative = reversal, confirming #35).

**So "only BTC gave good direction data" was the wrong read.** Funding-paid-side is a real-but-weak, roughly-uniform effect across coins; *which* coin clears the gate is an artifact of trial count + the specific window. **There is no robust per-coin directional edge here yet.** Methodology fix for next time: **pre-register the coin/signal/horizon universe**, then run — don't expand the sweep ad hoc and keep the survivors.

**Sub-hour run post-mortem (why Ronnie "couldn't tell if direction was working"):** (1) the tilt is a **168h / weekly** bet — invisible in <1h *or* in 10h; the P&L seen was spread/inventory noise. (2) the bias attaches only to a `mm-directional-glft` book on a listed symbol — a default `mm-glft` book never engages it. (3) `MM_PERSIST` defaults **false** and fills have **no DB table** (log + ring buffer only), so the run wasn't recorded — this is the "trades not in the DB" gap.

**The 10h run (decided with Ronnie): liquid substrate NEUTRAL + a BTC AXE, fast path on, fully persisted.** Books: `mm-glft` on DOGE,BNB,ETH,SOL,XRP,ADA,SUI (the #28 KEEP substrate — the steady-curve / spread-engine demo) + `mm-directional-glft` on BTC (forward bias data only — *not* a verdict, since #36 demoted it). Run with `MM_PERSIST=true MM_FAST_REQUOTE_ENABLED=true MM_FAST_SYMBOLS=BTC,ETH,SOL,DOGE,BNB,XRP,ADA,SUI`, tee the server log (fills), `mm_nav` curve in Postgres. Launch helper: `scripts/launch-mm-10h.sh`. **How we judge it:** the *spread engine* wins if the substrate holds a steady, low-drawdown NAV curve over 10h (that's the demo's core claim); the BTC bias is forward-data collection toward a multi-day track, since its horizon can't be judged in one session. Migrations applied, tsc clean, 47 bias/directional specs green going in.

**Cadence + the two-layer "bias on every market" decision (Ronnie pushed, correctly).** Separating the two things both called "bias" resolves the apparent contradiction "we lose without it, so put it on everything": **Layer 1 — fast fair value / theo (micro-price + flow imbalance), on EVERY book, refreshed each re-quote.** This is a short-horizon *directional* forecast (Stoikov: micro-price predicts the next mid move), it is the thing that stops adverse selection ("losing every time"), and it's validated by **markout** (F1 cut adverse −21%; sub-second cadence flipped spread-vs-adverse +). It's already wired to all books via `referenceMicros` (module 253/290 → `MmBook` 379–399). **Layer 2 — slow alpha / the funding "axe" (weekly), ONLY where OOS-validated (BTC), risk-capped, monitored for IC decay.** You do NOT spray Layer 2 on all markets — that's the unvalidated-bias-doubles-the-loss result (#33, −$7.2k→−$15.1k). That's how real desks run it: a microsecond theo everywhere (≈all of "don't lose") + a small validated alpha lean on top where they have a view. **Cadence set to 100ms re-quote with 30ms cancel/replace latency** (the internally consistent colocated-maker assumption; 100>30 leaves a ~70ms live window). Honest caveat: real HL rate-limits order actions, so 100ms is a clean paper upper bound, not a sustainable live claim. **Next build (the genuine fast directional BET, not just defense):** a flow-imbalance bias source blended via `CompositeBiasSource`, markout/forward-IC gated at a minutes horizon, run **shadow / measure-only** during the 10h to capture its validation data — enabled live next run only if it clears the gate.

## 2026-06-07 — Entry #37 (built): the shadow flow-imbalance bias — a fast directional input on EVERY market, measured before it's trusted

Built the "fast direction on all markets" piece the right way (Ronnie pushed; #36 framed it). The fast directional input is the **L2 book-imbalance signal** (`bookImbalanceFromL2`: top-N (ΣbidSz−ΣaskSz)/(Σ) ∈ [−1,1] — book pressure leads the next mid move, the same imbalance the micro-price weights), exposed as a `FlowImbalanceBiasSource` (bid-heavy ⇒ long). It runs on EVERY fast book — but as a **SHADOW**: the engine reads it into a *separate* `shadowBiasSource` field that is **recorded but never fed to the quoter** (`validated:false` ⇒ `effectiveBias`=0, and structurally it never touches `ctx.bias`), so it has **zero P&L impact by construction**. Each throttled (≥1s) snapshot appends one line to a durable JSONL (`JsonlFlowShadowRecorder`, append-immediately — the persistence gap that lost the last session does NOT apply). The offline gate `scripts/flow-bias-markout.ts` joins each obs to its forward return over 60/300/900s and reports Spearman IC + hit — the markout discipline, applied live. **Only if a horizon's IC is positive AND stable across coins does the flow source earn `validated:true` and start sizing carry next run.** This is the honest version of "bias on all markets": collect the evidence on all of them now, trust it only where it proves out (the #33 lesson — an unvalidated bias is leverage on noise). Wired behind `MM_FLOW_SHADOW` (off by default; ON for the 10h run). tsc clean; **+12 specs** (imbalance math, flow-source sign/cap/shadow-zeroing, durable JSONL + noop). Gate smoke-tested on a synthetic capture with built-in structure: reads **IC 0.77 @5s decaying to ~0 @15s** — it discriminates correctly.

## 2026-06-07 — Entry #38 (the regime response, built): dynamic self-validating bias + asymmetric/single-sided spread — a real MM

The live run made the gap concrete. Desk −$788/$8M (−1bp), but **ex-BTC the desk was +$311** (ETH +$397, BNB +$67, …); **BTC alone −$1,100**, of which **−$1,207 was the inventory mark on a ~9-BTC SHORT** the static funding axe held while BTC rose ~0.2%. The spread engine works; the **static directional bet was the whole loss** — exactly #33, live and cap-bounded. "How didn't we catch it": the only thing steering BTC was the *weekly* funding axe (built not to chase a regime), and the fast detector (flow imbalance) was in shadow. Ronnie's call, correct: **the bias must update like quotes do** — continuously, with its own validity re-checked. That's how a systematic desk runs (continuous alpha + live-IC decay monitoring).

Built the two halves of the regime response:
- **`RollingIcFlowBiasSource` (`4bc9699`, `MM_FLOW_BIAS_LIVE`):** the live directional view. Value updates every tick off book imbalance; **validity re-checked every horizon against its own trailing forward-return IC** — sizes carry only while predictive, **per coin**. Reversal coins auto-disable (never flips sign live). Backed by the run's own shadow data: flow IC **+0.22 @30s on BTC (hit 60%)**, real-but-decaying ETH/XRP, **reversal on ADA/DOGE** → the per-coin self-gate is exactly right.
- **Asymmetric skew + single-siding (`e235b5c`, `MM_DIR_SPREAD_SKEW`/`MM_DIR_SINGLE_SIDE_BIAS`):** on a live view the quoter **tightens the accumulation side + widens the offload side**, and goes **single-sided** (parks the offload side at the max rail) while still building toward target. Turns a caught regime into captured edge instead of a held bleed. Off by default; `bias=0` reproduces neutral GLFT bit-for-bit.

Both behind flags, tsc clean, full MM suite green (+ the quote-pair gains optional per-side half-spreads, every other quoter unchanged). **Re-run config (Ronnie stopping + restarting the desk): ALL books `mm-directional-glft` + `MM_FLOW_BIAS_LIVE=true`** — the desk self-gates per coin (BTC/ETH/XRP lean + skew; ADA/DOGE quote neutral automatically). Runbook updated (`scripts/launch-mm-10h.sh`). **What a real MM still lacks (named for next):** a proper change-point detector (CUSUM on signed flow), fast realized-vol → instant spread widening, real-time markout→spread feedback, live VPIN on the fast path, delta hedging, laddered multi-level quotes. Pushed up to `4bc9699` as PR #15; this entry's two commits + the re-run runbook are the follow-up.

## 2026-06-07 — Entry #39 (the all-directional run, MEASURED): the spread engine is fine — a 30-second alpha taking multi-minute inventory risk is the loss

Ran the Entry #38 config live — **all 8 books `mm-directional-glft`, `MM_FLOW_BIAS_LIVE=true`, fast re-quote on, `MM_FLOW_SHADOW` capturing** — `~17:39–19:08` (~89 min), $8M deployed (8 × $1M), HL. Persisted to `mm_nav`; flow shadow `docs/research/flow-shadow-2026-06-07T17-39-18-716Z.jsonl` (35,916 obs). **It was the worst run yet, and the post-mortem is unambiguous.**

**The numbers (final `mm_nav`, real books only):**

| book | net $ | realised | unreal | fees | maxDD% |
|---|--:|--:|--:|--:|--:|
| ETH | **+794** | +672 | +85 | −37 | 0.99 |
| DOGE | **+393** | +361 | +25 | −7 | 0.20 |
| XRP | **+147** | +323 | −194 | −18 | 0.36 |
| BNB | −1,120 | −6 | −1,121 | −6 | 1.37 |
| SUI | −1,579 | +12 | −1,601 | −10 | 1.97 |
| ADA | −2,486 | −316 | −2,176 | −6 | 3.13 |
| BTC | −2,486 | −672 | −1,857 | −43 | 3.40 |
| SOL | −5,286 | −1,611 | −3,706 | −31 | **6.47** |
| **desk** | **−11,623** | **−1,236** | **−10,545** | **−158** | — |

**−$11,623 / $8M = −14.5 bps in ~1.5h** (vs #38's −$788/$8M with the *single* static axe). Turning every book directional made the loss **~15×** bigger. The split is the whole story: **unrealised −$10,545 is the loss** — open inventory marked underwater. Realised is roughly flat-to-slightly-negative (−$1,236, dragged by SOL/BTC offloading bad inventory).

**The pattern, stated plainly:** the **3 books that stayed near-flat made money** (ETH/DOGE/XRP — positive realised, tiny unreal, maxDD ≤1%). The **5 books that accumulated a large one-sided position and held it lost money** (SOL got 6.2B-unit long into a −SOL move → −$3.7k unreal, 6.5% DD; ADA, SUI, BNB the same shape). **Ronnie's read is exactly right and the data proves it: the spread engine is profitable; the position is where we bleed.**

**Why the self-gating bias didn't save it — the actual root cause (markout on this run's own shadow, `scripts/flow-bias-markout.ts`, Spearman IC of signal vs forward mid):**

| coin | 30s | 60s | 300s | 900s |
|---|--:|--:|--:|--:|
| BTC | **0.188** | 0.147 | 0.01 | −0.07 |
| ETH | **0.172** | 0.131 | 0.03 | 0.08 |
| XRP | **0.164** | 0.161 | 0.09 | **0.237** |
| SOL | 0.075 | 0.035 | −0.01 | **−0.116** |
| SUI | 0.020 | −0.004 | −0.07 | **−0.145** |
| DOGE | 0.067 | 0.056 | 0.118 | 0.016 |
| ADA | 0.034 | 0.065 | 0.084 | 0.016 |
| BNB | 0.064 | 0.056 | 0.00 | 0.090 |

The flow signal is a **real 30–60s predictor** on the liquid majors (BTC/ETH/XRP) — and **decays to zero or flips negative by 5–15 min** (SOL −0.12, SUI −0.15 @900s). **But the inventory the signal builds was held for many minutes / the whole session.** So we used a **30-second alpha to take multi-minute inventory risk** — at the horizon where we actually carried the position, the signal had **no skill or negative skill**. The per-coin IC self-gate can't catch this: it checks IC at the signal's *own* (short) horizon, where it's positive, not at the *hold* horizon, where it bleeds. This is the #33 lesson again ("bias on everything = leverage on noise"), now quantified at 15×.

**This run answers Ronnie's question — yes to both, and here's the order:** in the real world you (1) **hedge the residual delta** and (2) **only deliberately hold inventory inside the horizon your signal is valid**. And yes — **the hedge cost goes into the spread**: every unit you quote, you expect to offload/hedge, so the quoted half-spread must cover the hedge round-trip (taker fee + half-spread on the hedge venue). A spread that doesn't price the hedge is quoting at a loss. That's pillar 2 (`3fd72fb`), and this run is the measurement that says it's *the* fix, not a nice-to-have.

### Lessons → redesign (the next-run plan)

1. **Default the desk back to NEUTRAL spread-capture, not all-directional.** `mm-glft` substrate (the #28 KEEP set) is the steady-curve demo — it works *by staying flat*. All-directional is retired as a default; it's the proven loss mode.
2. **Inventory governor (the missing piece — build before next run):**
   - **Hard inventory cap per book** (|q| ≤ q_max), enforced at the quoter, no exceptions.
   - **Inventory time-stop:** any lot held > `T` (start `T≈60s`, matched to the signal horizon) is offloaded at market. This is the direct kill for the 30s-alpha/multi-minute-hold mismatch that caused this run's loss.
   - **Stronger reservation-price skew:** quotes must actively push inventory back to zero (Avellaneda-Stoikov), not just lean — SOL/ADA/SUI ran because skew was too weak to flatten in a trend.
3. **Hedge leg (pillar 2):** when |net delta| > threshold, flatten with a taker hedge on the perp; **add the modeled hedge cost to the quoted half-spread** so the spread pays for it. Measure: does desk unrealised stop being the loss column?
4. **Directional lean ONLY on BTC/ETH/XRP, only inside ~60s, time-stopped.** Never SOL/SUI (reversal coins this window). A tilt that must be flat by 60s is not a held bag.
5. **Pre-register coin/horizon universe before the run** (the #36 methodology fix) — no expanding the sweep and keeping survivors.

**Judge the next run by:** desk **unrealised stays small** (inventory controlled) and the substrate holds a steady low-DD NAV curve — that, plus ETH/DOGE/XRP-style positive realised, *is* the demo. The directional tilt is a small, time-stopped add-on, not the engine.

**Caveat (honesty gate):** one ~89-min window, 8 coins; the qualitative finding (spread positive when flat, inventory carry is the loss, signal horizon ≪ hold horizon) is robust and matches #38/#33; the exact bps aren't gospel. No code changed this entry — analysis + plan only.

## 2026-06-08 — Entry #40 (built): the defensive desk — inventory governor + adverse-selection (F3) spread, wired LIVE for the next paper run

Acted on #39. Two **inventory-neutral defensive** layers, both behind config (defaults are no-ops, every existing spec preserved), tsc clean, **53 MM suites / 276 tests green**.

**1. The inventory governor (`983f9c0`) — the fix for the runaway position that WAS the #39 loss.** Diagnosis sharpened on reading the code: the bare A-S skew is **~2 bps at full inventory** (γσ²T with σ a per-bar fraction is tiny) — it never mean-reverted; and *nothing* stopped a book breaching its cap (the clamp only bounded the skew math, not the actual fills), so SOL ran a 6.2B-unit long. Two knobs on `GlftQuoter` + `DirectionalGlftQuoter`:
- `inventorySkewMult` — scales the inventory-skew term ONLY (not the half-spread), so the reservation actually pulls inventory back to flat/target.
- `hardInventoryCap` — at |inventory| ≥ maxInventoryLots, PARKS the accumulating side at the max rail so the book physically cannot add to the position; the other side keeps quoting to shed.
Wired registry → config (`MM_INVENTORY_SKEW_MULT`, `MM_HARD_INVENTORY_CAP`) → both module build sites (launch + rehydration — also fixed a latent drop of the desk-wide skew defaults on restart). +5 quoter specs.

**2. The adverse-selection defence — F3, ported backtest→live (Ronnie: "avoid informed orders like the big boys… and if it's in the backtest but not live, fix it").** This is the core MM problem: informed traders hit your quote right before price runs, and informed flow is ONE-SIDED aggressor flow. The offline LOB replay already scaled the spread by **trade-flow toxicity τ = |buy−sell|/(buy+sell) relative to its rolling average** (TIGHTEN into calm two-sided flow = farm the rebate; WIDEN into a sweep = where you get picked off) — but it was **dormant in live**: the fast engine computed the imbalance every tick yet never set `ctx.spreadScale`, so the live desk quoted the same width into calm flow and into a toxic sweep. Extracted the validated formula into a shared `FlowToxicityScaler` (microstructure/), pointed BOTH the backtest and the live `L2LiveFillEngine` at it (lob-replay specs still green = behaviour preserved), behind `MM_F3_TOXICITY`. This is the WIDTH companion to the micro-price CENTER (F1, already live) — together they're the "don't get adversely selected" pair, and they use the flow signal *defensively* (inventory-neutral) instead of as the directional bet that lost in #39.

**Review that mattered:** confirmed the fast L2 path reprices off the quoter's FINAL per-side prices (`l2-live-fill-engine` 281–282), so the hard cap + skew genuinely bind on the real run path, not just in unit tests. Honest limits: the hard cap is "park at the max rail," re-checked every 100ms re-quote ⇒ overshoot ≤ ~1 lot between requotes (not a zero-size stop — that, plus the inventory **time-stop** and the **desk-level delta hedge**, is phase B and needs taker plumbing on the fast path, deliberately NOT rushed in before an unattended run).

**Next run (pre-registered, `docs/NEXT_RUN_PREREG.md`; runbook `scripts/launch-mm-10h.sh`):** ALL books NEUTRAL `mm-glft` + governor + F3, $8M, fast path, `MM_FLOW_SHADOW` still capturing (free directional data for phase-B). **Judge by:** desk **unrealised stops being the loss column** (|unreal| ≤ ~0.3×|realised|, vs #39's −$10.5k unreal / −$1.2k realised), per-book **maxDD ≤ ~1.5%** (vs SOL 6.5%), and **no book exceeds 4 lots**. Directional returns in the run AFTER, with the time-stop + hedge, only on the pre-registered BTC/ETH/XRP at a ~60s horizon.

## 2026-06-08 — Entry #41 (the governed run, MEASURED): the governor fixed the *unrealised* axis it targeted — and only that one; bounding lots ≠ bounding drawdown

Run A as pre-registered (`docs/NEXT_RUN_PREREG.md`): ALL 8 books NEUTRAL `mm-glft` + the inventory governor (`MM_HARD_INVENTORY_CAP=true`, `MM_INVENTORY_SKEW_MULT=10`, `MM_MAX_INVENTORY_LOTS=4`) + F3 toxicity, $8M, HL, 100ms re-quote, micro-price center, directional OFF. Live read at ~10h (terminal-stable; `run-20260608-0048-mm-governed.log`, snapshot via `/api/market-making/snapshot`).

**Verdict vs the three pre-registered metrics:**
| Metric (pre-registered) | Result | |
|---|---|---|
| 1. Desk \|unrealised\| ≤ ~0.3× \|realised\| | realised **−$9,952**, unrealised **+$1,464** → **0.15×** | ✅ PASS |
| 2. Per-book maxDD ≤ ~1.5% | only DOGE (1.37%). SUI **17.6%**, BTC **10.3%**, SOL 7.4%, ETH 6.8%, ADA 3.7%, XRP 2.4%, BNB 2.2% | ❌ FAIL hard |
| 3. No book inventory > 4 lots | governor flattening (7/8 books realised < 0); cap holds at snapshot | ✅ holding |

**Desk net ≈ −$8,225 on $8M (−0.10%).** Per-book net: BTC −5.1k, SUI −3.0k, ADA −2.0k, SOL −1.9k, DOGE +0.1k, XRP +0.8k, BNB +0.8k, ETH +2.3k. Fees only **−$262** total (the −0.2bps rebate is doing its job — costs are NOT the leak). Funding 0.

**What the run actually says:**
1. **The governor fixed the axis it targeted, and only that one.** #39's loss was a hidden unrealised bag (−$10.5k unreal / −$1.2k realised); metric 1 PASSED — the bag is gone (unreal +$1.5k, small). But it got there by *flattening at a loss* — the bleed moved into **realised** (−$9,952), it did not stop. The governor crystallised the loss sooner; it did not bound the drawdown (metric 2 failed badly). We treated the symptom.
2. **A fixed lot-cap is wrong across a 100×-price universe.** `maxInventoryLots=4` is the SAME for BTC ($100k/coin) and DOGE/ADA/SUI (≈$0.x). Even though `quoteSizeUnits` is notional-÷-price at launch, the cap is re-checked against a static lot count while price drifts, and fixed-size books aren't normalised at all. BTC drew **10.3%** on "4 lots" with only **40 fills** (it barely quoted, parked a position, ate the move). The cap must be **notional/σ-normalised** (fraction of book capital at the live price), not lot-count — the same σ-scale-invariance lesson we applied to *quoting* (S31) but never to the *inventory cap*. **→ fixed this entry (B-fix below).**
3. **8 neutral crypto books = one short-gamma beta bet, not 8 edges.** BTC/SOL/SUI/ETH all drew down in the same window. Per-book inventory caps do nothing about the desk's **net delta** — that's the dominant, still-unhedged risk. The desk-level net-delta hedge, flagged for Run B, is actually Run A's missing piece and is now the #1 build item.
4. **Spread edge is real but ≈ adverse selection — net ~flat.** Every book captured positive spread (ETH +683, SUI +527, SOL +140, BTC +116); adverse selection roughly ate it (ETH adv −1138 > its spread). Re-confirms #28–#33: micro-price + fast cadence make spread-capture honestly positive, but on its own it's a coin-flip after adverse selection. The rebate (fees −$262) is the only structural plus; the leak is inventory/direction.
5. **ETH's +$2.3k is NOT a win** — realised **−$3.6k** masked by a lucky unrealised long **+$5.7k** into an up-move (531 fills). The honest desk number is **realised −$9,952**, not net −$8,225. Any post-mortem must mark-to-realised or strip transient unrealised, or we fool ourselves — which defeats the demo. **→ post-mortem tooling must headline realised.**
6. **F3 was invisible.** 0 widen-events in the log, adverse-selection still ≈ spread. We shipped it "validated offline, newly wired live" — live, it needs instrumentation (widen-event count, adverse-Δ vs #39 baseline) before we can claim it fired. Honesty rail: don't credit a defence we can't measure.

**The fix shipped this entry (B-fix — the notional inventory cap):** `MM_MAX_INVENTORY_NOTIONAL_FRAC` caps inventory by **notional as a fraction of book capital**, evaluated against the live mid each tick — `effMaxLots = min(maxInventoryLots, frac·capitalUnits·1e6 / (midMicros·lotUnits))` (reuses the `quoteUnitsForNotional` unit convention). Threaded config → registry build-ctx (`capitalUnits` + frac) → `GlftQuoter` + `DirectionalGlftQuoter`; the effective cap drives both the skew clamp and the hard-cap park. Default 0 = off (legacy no-op, every existing spec preserved). This directly fixes the BTC-cap-too-loose failure.

**Forward plan (fix the risk model before any directional carry — Run B stays parked):**
- **D1 (done, this entry):** notional/σ-normalised inventory cap.
- **D2 (next build, #1 risk item):** desk-level **net-delta hedge** — the only thing that bounds correlated drawdown. Needs the taker leg on the fast path (the plumbing #40 deliberately deferred).
- **D3:** instrument F3 + the governor — widen-event / flatten-event counts + per-book "realised-from-forced-flatten" on the tape/snapshot, so the next run is judged on whether the defences *fired*, not just the outcome.
- **D4:** mark-to-realised in the post-mortem jq/template — headline realised, flag unrealised as transient.
- **D5:** re-pre-register **Run A′** (governor + notional cap + hedge); require per-book maxDD ≤ ~1.5% BEFORE any directional run.

**Standing rule respected:** this is fixing the risk model, NOT adding coins/signals to chase a number.

## 2026-06-08 — Entry #42 (built + measured): the delta hedge EXECUTES (paper perp), and the gamma overlay is regime-dependent — long gamma clears only when realised > implied

Follow-through on #41's plan. Two things, both shipped/measured this session.

**1. The delta hedge now executes (not just a model).** `DeskHedgeController` (`src/market-making/hedge/`) holds the perp position per hedge underlying, fills the banded `computeHedge` orders as **taker on a `PaperVenue`** fed by the live book mids, accrues funding (a short hedge EARNS on positive rate), and marks hedge P&L. Wired into `MmPortfolioTrader.tick()` behind `MM_DELTA_HEDGE` (empty betaMap ⇒ each book self-hedges per-symbol); the snapshot carries desk gross-delta / post-hedge residual / hedge-P&L. Default off ⇒ trader unchanged. **Honest connectivity (HEDGING_MODEL.md §3b):** there is NO real futures/options order placement — the paper perp hedge reuses `PaperVenue` + the HL feed; real-money is parked. Hedge-funding from the live HL rate is the one remaining follow-up (v1 hedges delta). tsc clean; 291 MM/config tests + 15 hedge tests.

**2. The gamma overlay — measured on live data, the verdict is REGIME-DEPENDENT.** MM is structurally short gamma; the overlay (buy gamma) offsets it but pays implied vol, so the whole call is **realised vol vs implied vol**. `gamma-overlay.ts` (the ½Γ(σr²−σi²)T identity ⇒ recover fraction `1 − iv²/rv²`) + `scripts/gamma-overlay-backtest.ts` (HL BTC 1m realised vs Deribit nearest-expiry ATM `mark_iv`). Live read 2026-06-08, BTC ~$63.4k, implied sticky ~58.8%:

| window | realised vol | implied | verdict |
|---|---|---|---|
| 6h | 55.5% | 58.8% | overpriced ⇒ insurance only |
| 12h | 83.3% | 58.6% | clears (recovers ~51% of bleed) |
| 48h | 61.5% | 58.8% | marginally clears |
| 1 week | 76.2% | 58.8% | clears |

**Read:** in the current elevated-vol regime BTC realises MORE than options price ⇒ long gamma clears its premium and would recover ~half of a short-gamma bleed; in the calm 6h pocket it flips to net-negative (the VRP). So the overlay is a **regime tool, not an always-on engine** — buy gamma when realised>implied+cost (the MM's worst windows, good anti-correlation), eat the bleed otherwise. **Honest caveats:** one underlying (BTC), ATM nearest-expiry IV as the proxy, a representative bleed input (#41 adverse total ~$2,345), horizon mismatch (12h realised vs ~1–2d expiry). The signal is the rv-vs-iv comparison, measured per-window — not a static "options are a winner."

**Follow-through (same session — the distribution + the wires):**
- **DISTRIBUTION (the verdict that matters), 30d × 117 windows (24h, step 6h) vs current implied ~58.5%:** realised vol p25/median/p75/max = **25% / 33% / 45% / 119%**; long gamma clears in **only 16/117 = 13.7%** of windows; an always-on overlay would have **lost ~$9,846** on a $2,345/window bleed. So as a *standing* overlay long gamma is **net-NEGATIVE — the VRP wins 86% of the time** — it is strictly **insurance / a vol-timing bet**, not free money. It pays only in the upper-13% tail of realised vol (today's 12h read sits in that tail at 63.9% — the exception, not the rule). This *refutes* the naive "gamma is the MM winner": you earn by being SHORT gamma (spread+rebate); buying gamma is tail insurance you pay the VRP for.
- **Cash-gamma now CALIBRATED from the bleed** (`calibrateCashGamma` G = 2·bleed/(σ_r²·T)) instead of a guessed notional: the 12h read implies G ≈ **$8.4M cash-gamma ⇒ ~$419 bled per 1% move** — and `variancePnlUsd(G,…)` reconciles exactly with the overlay recovery (tested).
- **Hedge-funding WIRED from the live HL rate:** `MmBookSnapshot.fundingRatePerHour` exposed; the trader passes a per-underlying funding map into `rebalance`, so the perp hedge accrues real funding (short hedge earns when positive) — the §1 hedge is now delta + funding.
- **Next:** a paper options leg only behind a *predictive* rv>iv signal (the 13.7% base rate says blind long-gamma loses); use the overlay as a drawdown cap, not a return engine.

## 2026-06-08 — Entry #43 (diagnosed + fixed): the desk's P&L was inventory drift, not spread — the governor was built but shipped default-OFF, and the card hid it

Started from a UI question — *"where does net P&L come from? these numbers don't add up"* — looking at a live 8-book HL desk (net +$6,556 on $8M). They genuinely didn't add up, and chasing why surfaced the real problem.

**1. The card was lying by omission.** The MM-desk card (`src/ui/render/mm-desk-view.ts`) showed four P&L lines — spread / adverse / fees / funding — above net P&L, but those four are **not** the terms of net. Net is `realised − fees + unrealised(MTM at mid) + funding` (`mm-book.ts:523` → `inventory-book.ts:130`); spread/adverse are a separate **per-fill mark-out attribution** with NO inventory-carry line. So on BTC the visible lines summed to ≈+$484 while net was −$3,572 — the missing ≈−$4,055 was the **mark-to-market on the open −13.8 BTC short**, shown nowhere. Worse, the `fees` line rendered the raw accumulator (a rebate read −$X) opposite to its contribution to net and to the Activity tape's `fmtMoney(-feeUnits)`. **Fix:** the card now has a **cash grid that literally sums to net** — realised / inv MTM / fees(contribution sign) / funding / **net** — with spread/adverse demoted below as a dashed, dimmed **"mark-out · diagnostic · ≠ net"** block. Rendered-and-reconciled in a smoke test.

**2. The number the card hid is the actual finding: the desk's net P&L was ~95% inventory drift, not market-making.** Once you can see inv MTM, every book's net is dominated by it — SUI's +$5,790 net was +$5,554 directional gain on a −261k short (price fell) and only ~$236 of earned spread−adverse−fees; SOL's −$1,225 was a −$2,492 MTM loss on a −8.4k short masking +$1,267 of real making. The books had run to enormous one-sided inventories (ADA −1.65M, DOGE +1.26M, BTC at ~88% of book notional, BTC maxDD 10.7%). This is exactly the #39/#41 failure mode — *"a 30-second alpha taking multi-minute inventory risk is the loss"* — still live.

**3. Root cause: the inventory governor from #39/#41 was built but shipped at its legacy no-op default.** `app-config.factory.ts` had `inventorySkewMult=1` (bare A-S skew ≈2bps at full inventory — #39 proved it can't mean-revert in a trend), `hardInventoryCap=false` (the deterministic backstop OFF), `maxInventoryNotionalFrac=0` (notional cap OFF ⇒ a fixed 8-lot cap = wildly different risk across a 100×-price universe). Comment literally read *"Defaults reproduce legacy (no-op)."* The live desk never set the env overrides, so nothing bounded inventory. **Fix:** flipped the defaults ON — `MM_HARD_INVENTORY_CAP` true, `MM_MAX_INVENTORY_NOTIONAL_FRAC` 0.25 (no book holds >¼ of its capital in inventory, risk-uniform across coins), `MM_INVENTORY_SKEW_MULT` 4. The two caps are **deterministic bounds, not tuning**; skewMult=4 is a **starting value pending a γ/κ/skew sweep** (#39 only established that 1 is too weak). tsc clean; card + glft-governor + config suites green; the quoter already had hard-cap/notional/skew mechanics tested in `glft-quoter.spec.ts`.

**Honest caveats / next:** these are *engineering* fixes verified by tests + a render check — **not yet a measured paper run**. The proof is a forward run with the governor on: net P&L should become **spread-driven** (the inv-MTM line small and mean-reverting) and per-book maxDD should drop well under the 10.7% BTC saw. skewMult wants the sweep; and the desk needs a restart/relaunch to pick up the new defaults (running books keep their old config). This pairs with the #42 delta hedge — caps bound the *position*, the hedge bounds the *delta variance* of whatever position remains.

## 2026-06-09 — Entry #44 (measured 10h-launch run): DD control WORKS, the hedge is INERT, and the real disease is default-sprawl + a zombie legacy path

The first forward run with #43's governor defaults ON (`MM_HARD_INVENTORY_CAP=true`, `MM_MAX_INVENTORY_NOTIONAL_FRAC=0.25`, `MM_INVENTORY_SKEW_MULT` high) **and** #42's `MM_DELTA_HEDGE=true`. 8 neutral `mm-glft` books on Hyperliquid, $1M each ($8M desk), all on the 100ms fast path. Launched `00:56`, recorded book NAV through `05:18` (~4.4h; the loop logged to 08:18). Authoritative numbers pulled from the live DB (`mm_nav` latest row per book + the `book_key=''` desk-aggregate row), NOT the log.

**Per-book final (NAV, $):**

| book | net | realised | unreal | fees | maxDD% | fills |
|---|---|---|---|---|---|---|
| SUI | **+1,489** | −189 | +1,665 | −14 | 1.35 | 143 |
| BNB | **+290** | −365 | +650 | −5 | 0.84 | 295 |
| DOGE | −31 | **+285** | −323 | −8 | 0.53 | 103 |
| ADA | −199 | −308 | +106 | −4 | 0.62 | 525 |
| SOL | −366 | −64 | −368 | −65 | 0.87 | 193 |
| XRP | −617 | −773 | +145 | −11 | 1.02 | 145 |
| ETH | −774 | −1,099 | +183 | −142 | 1.15 | 603 |
| BTC | −954 | −748 | −325 | −120 | 1.42 | 231 |
| **DESK** | **−1,161** | **−3,260** | **+1,731** | **−368** | **1.42** | 2,238 |

**Desk net −$1,161 on $8M = −0.0145%.** Funding 0.

**Verdict 1 — DD CONTROL WORKS (the win, pre-registered gate PASSES).** Every book's maxDD landed in **0.53%–1.42%**, all under the #41 pre-registration bar of ~1.5%. Compare #41: SUI 17.6%, BTC 10.3%. The notional/σ-normalised inventory cap + hard-cap park + stronger skew (shipped #43, defaults flipped ON) **bounded the position risk across the 100×-price universe**. Metric 2 — the one that failed hard in #41 — now passes cleanly. The drawdown is genuinely controlled.

**Verdict 2 — but the desk still loses, and the honest number is realised −$3,260, not net −$1,161.** Realised is **negative on 7 of 8 books** (only DOGE +$285 realised). The two green "winners" — SUI +$1,489 and BNB +$290 — are **transient unrealised longs into an up-move** (SUI realised −$189 / unreal +$1,665; BNB −$365 / +$650), the exact #41-learning-#5 trap: mark-to-realised and they're red. The +$1,731 desk unrealised will mean-revert. So DD control bought a **small, bounded loss**, not a profit — spread capture ≈ adverse selection again, and the −0.2bps rebate did not even net positive (fees −$368, dominated by the two most-active books ETH/BTC, i.e. those books paid more in crossing/half-spread on the hedge-free fast path than the rebate returned). **The governor solved the blow-up, not the edge.**

**Verdict 3 — the HEDGE IS INERT. Four independent root causes, all confirmed:**
1. **There are TWO hedge subsystems and the one that ran all night is a zombie.** `src/hedge/` (`HedgeService` + `HedgeMonitorCron` + `hedge-circuit-breaker` + the `hedge_positions` table) is a **pre-MM, DB-backed perp-short hedge** imported globally in `app.module.ts`. Its 60s cron fired **425 times and logged 425 identical** `markAll: skipping mock-pos-4 — venue has no such position (ledger/venue drift)` warnings — it was iterating **stale 2026-05-28 test fixtures** (418 rows in `hedge_positions`, most never closed) that the mock venue no longer has. It does **nothing** for the MM desk; it is pure log-noise + scope. This is the `[HedgeService]` you see in the log — and it is NOT the MM hedge.
2. **The real MM hedge (#42 `DeskHedgeController`) is unobservable — in-memory only, never persisted.** It holds perp positions in a `this.pos` Map and writes to **no table and no event**. After the run there is **zero durable record** of gross delta, residual, hedge P&L, or a single hedge fill. For a demo whose entire premise is *honesty about the numbers*, an **unauditable hedge is indistinguishable from no hedge** — which is exactly why it reads as "not working."
3. **Its config is degenerate: `betaMap: {}` (hard-coded at `market-making.module.ts:390`) ⇒ every book self-hedges per-symbol.** That just re-flattens the *same* inventory the governor already bounds — it does **nothing** about the #41 disease (8 neutral books = ONE correlated crypto-β bet). The correct target is a **β-map of the alts onto BTC/ETH** so a single major-perp leg neutralises the *basket* net delta. As shipped, the hedge is redundant with the governor and leaves the actual correlated-β risk fully on.
4. **Cadence mismatch.** The rebalance runs inside `tick()` (the slow bar timer, `pollIntervalMs`), which explicitly **filters out fast-path books** — but all 8 books trade on the 100ms fast path (`routeL2Snapshot`). So the hedge reads *stale* deltas at a slow cadence and, with the governor keeping per-symbol inventory small and a $2,000 dead-band, mostly **no-ops**.

**The real disease (Ronnie's read, confirmed): default-sprawl + dead paths are now causing bugs and confusing analysis.** This run is the symptom of a system that has accumulated too much optionality: the governor that shipped *default-OFF* and silently no-op'd for a whole prior run (#43); a hedge whose default `betaMap` is the degenerate `{}`; a `MM_DELTA_HEDGE` that turns on an unobservable in-memory leg; and a **second, legacy hedge stack still wired into boot** doing nothing but erroring. Every one of these is a switch or a path that *looks* live and isn't. The engine is testable and clever, but the **configuration surface and the legacy carry are working against us** — the #1 fix is not a new feature, it's **tightening the system to one honest path.**

### Dev requirements (lessons → tickets)

- **DR-0 (P0, META — tighten the system).** Treat config-sprawl and dead paths as the primary defect class. Audit every `MM_*` default in `app-config.factory.ts`: a default must be either the *honest production value* or *explicitly, loudly off* — no more "default reproduces legacy no-op" that silently disables a risk control (#43) or ships a degenerate hedge (this entry). Inventory every legacy module still wired into `app.module` and decide keep/quarantine/delete with a written reason.
- **DR-1 (P0).** **One hedge system.** Retire/quarantine the legacy `src/hedge/` stack: remove `HedgeModule` from `app.module.ts` (or hard-gate its cron OFF behind a default-false flag) and purge the stale `hedge_positions` fixtures. Kills the 425-warning spam and the scope Ronnie flagged. The MM `DeskHedgeController` is the *only* hedge.
- **DR-2 (P0).** **Make the MM hedge durable + auditable.** Persist `HedgeSnapshot` each tick (new `mm_hedge` table or columns on `mm_nav`: grossDeltaUsd, residualUsd, hedgePnlUsd, hedgeCostUsd, fundingUsd, per-underlying units) and emit hedge open/rebalance on the `DeskEvent` tape. Until the hedge is in the same ledger as the books, we cannot say it works.
- **DR-3 (P0).** **Hedge the desk β, not the symbol.** Replace `betaMap: {}` with a real, OOS-estimated β-map (alts→BTC/ETH) behind `MM_HEDGE_BETA_MAP`; default it to the *measured* map, not empty. One major-perp leg should neutralise the basket — the #41 "8 books = 1 β bet."
- **DR-4 (P1).** **Run the hedge on the fast path.** Move the rebalance off `tick()` onto `routeL2Snapshot` (or a dedicated sub-second hedge cadence) so it tracks the inventory that actually changes at 100ms instead of lagging it.
- **DR-5 (P1).** **Persist the spread / adverse / inventory-carry attribution to `mm_nav`** (today only realised/unreal/fees survive shutdown; the #43 card shows the split live but it dies with the process). A post-mortem can't locate the realised leak without it.
- **DR-6 (P1).** **Scorecard headlines realised.** Tooling must lead with realised P&L and flag unrealised as transient — SUI/BNB "wins" were unrealised longs (the recurring #41-#5 trap). See the run-review skill below.
- **DR-7 (P2).** **The edge is still missing even with DD bounded.** Spread ≈ adverse on 7/8 books, rebate net-negative. The path to positive is the adverse-selection defence (confirm F3 toxicity actually *fires* — still uninstrumented) and the *validated* directional lean (parked), **not more coins**. Re-register **Run A′** requiring **desk realised ≥ 0** (not just maxDD ≤ 1.5%) before any directional run.

### How this run was reviewed (the data map — so we never snoop blind again)

Authoritative P&L is the **DB, not the log**. The 27MB run log is ~99% TypeORM query echo + the legacy-hedge warning; reading it end-to-end is the trap.
- **Final P&L:** `mm_nav`, latest row per `book_key` (real books = symbols; `book_key=''` is the desk aggregate; `it-nav-*` rows are int-test fixtures — exclude). Columns: net/realised/unrealised/fees/funding/maxDD.
- **DD control:** `max_drawdown_pct` per book from the same query (books relaunch clean ⇒ per-run).
- **Hedge state:** `hedge_positions` is the **legacy** table only — newest real row predates the run ⇒ the MM hedge opened nothing *there*; the MM hedge state is in-memory and currently **unrecoverable** (→ DR-2).
- **Fills / activity:** `grep '[DeskEvents]' | grep ' ▸ ' | count by symbol`.
- **Hedge health:** `grep -c 'markAll: skipping'` (425 = the zombie firing every cycle).
- Codified as the `mm-run-review` skill.

## 2026-06-09 — Entry #44b (consolidation executed): one hedge, auditable + folded into NAV, β-targetable; + the e2e workflow doc

Acted on #44's dev requirements in one focused pass (commits on `feat/mm-desk-diagnostics-and-guide`):
- **DR-1 — one hedge system.** Deleted the legacy `src/hedge/` stack (the retired Lira-Bridge FX/exposure hedge: `HedgeService`/`HedgeMonitorCron`/`hedge-circuit-breaker`/`hedge_positions`) — it was wired only in `app.module` yet ran a 60s cron that logged 425 identical stale-fixture drift warnings every run. Unwired + removed the dead `hedge:` AppConfig block. The MM `DeskHedgeController` is now the only hedge. `hedge_positions` is a dormant orphan table (migrations kept as immutable history).
- **DR-3 / DR-0 — real, explicit hedge target.** `betaMap:{}` was hard-coded; now `MM_HEDGE_BETA_MAP` (`SYMBOL:UNDERLYING:BETA` triples) folds alts onto a major perp, parsed by a unit-tested pure helper, with the effective target **logged at boot** (never hidden again). Empty default = an *explicit, documented* self-hedge-per-symbol, not a buried no-op. Honest caveat in-code: the cross-asset βs want an OOS fit before they're trusted.
- **DR-2 — auditable hedge.** The hedge P&L (mtm + funding − cost) is now **folded into the desk net/unrealised/equity** as an OPEN position (it was reported alongside but never in the net ⇒ a working hedge was invisible in `mm_nav` + the gauge), and every rebalance emits a **`hedge` DeskEvent** on the same tape as fills. Post-run the hedge is now grep-able in the run log + reflected in the durable NAV.
- **DR-4 — deliberately NOT executed.** Moving the hedge off the slow bar timer onto the fast path is architectural and ties to the "how do top desks hedge" question — flagged for discussion, not rushed.

**Plus the e2e map: [docs/MM_DESK_E2E_WORKFLOW.md](MM_DESK_E2E_WORKFLOW.md)** — traces quote → fill → P&L → roll-up (fill → `InventoryBook` → `MmBook` → desk → hedge) with `file:line`, names every model and where its numbers are written/logged, and a **ghost-code audit**. The audit surfaced the next consolidation question (Ronnie's): there are **two fill paths** — the fast L2 queue-aware path (the only honest one) and the legacy bar/candle path (fiction at the top of book, but load-bearing for non-L2 venues + tests). Clean coexistence (no double-fill), but a convergence candidate: make fast/L2 the path we trust and gate live MM on having an L2 tape. Open questions Q1–Q5 + the stale-repo backlog are in the doc.

**Tests:** tsc clean; the hedge/trader/events/config suites green (+ a new `parse-beta-map` spec, + a desk-net-folds-hedge invariant). The lone red suite — `telemetry.module.spec` — is a **pre-existing test-isolation flake** (fails identically on the pre-session commit 382641a); deferred to a stale-repo review, not touched.

## 2026-06-09 — Entry #44c (fast-only convergence): one live fill path, funding fixed, docs/run updated

Acted on Q1 of the e2e doc (Ronnie: "converge the fill paths to fast-only"). The MM book had two fill paths — the fast L2 queue-aware engine and the legacy bar/candle simulator — and the legacy one can't resolve top-of-book turnover (S33), so its fills are fiction.

- **Funding gap found + fixed first.** Mapping the code surfaced that the fast path **never accrued funding** (`fastSnapshot` hard-coded `fundingUnits:'0'`) — that's why funding was $0 across the #44 run (all 8 books were fast). Extracted the inter-interval bookkeeping into a shared `accrueInterval()` (funding + carry + cursor) called by BOTH paths; `fastSnapshot` now folds funding into net/equity like the bar path. The rest of the fast-path attribution (spread/adverse/carry/markout/maxDD) was already engine-computed — funding was the only real gap. *(My first read mis-stated this as a broad attribution gap; the engine already does it.)*
- **Fast-only live.** `useFast = (venue exposes an L2 feed)` — dropped the `MM_FAST_REQUOTE_ENABLED` opt-in + `MM_FAST_SYMBOLS` allowlist gating (the same silent-default trap as #43). A live launch on a **non-L2 venue is refused** with a clear error (allowed only under nodeEnv `test`, where specs drive the bar simulator). The L2 poll driver wires whenever an L2 source exists. Removed the dead `fastRequoteEnabled` config flag. **Product call (Ronnie): no live MM on a non-L2 venue** (Binance-spot / DEX) until it has an L2 tape — the DEX frontier is paused for *live* MM.
- **Docs/run refreshed:** `scripts/start-desk.sh` + `launch-mm-10h.sh` (dropped the dead flag, governor-on note), `docs/RUN_THE_DESK.md` (fast-only callout, knob table), `README.md` (added the MM-desk run section + honest research read: DD bounded, edge still open), and the e2e doc Q1 marked done.

tsc clean; 312 mm+config + 403 mm+ui suites green. The pre-existing `telemetry.module.spec` flake is still the only red (deferred, untouched). **Next:** the OOS β fit for the hedge map + DR-4 (hedge on the fast path), then chase the edge (adverse-selection defence + validated lean).

## 2026-06-09 — Entry #45 (built: the four "make money" pillars wired end-to-end + the training loop)

Acted on the #44 plan + Ronnie's standing demand that the NEXT run actually make money and that
*nothing* ships silently off. One focused session on `feat/mm-desk-diagnostics-and-guide` (commits
7abc48d → d9aada1). The thesis: a neutral MM desk makes money iff **(1) positions are hedged, (2) the
hedge cost is paid for by the spread, (3) adverse flow is defended, (4) we don't fight bad exposure** —
and every one of those must be ON, visible, and measurable.

**1. DR-4 — the hedge runs on the fast cadence.** It rebalanced inside `tick()` (the 15s bar timer)
while every live book trades on the 100ms L2 path ⇒ it read stale deltas and mostly no-op'd (#44 root
cause 4). Added an `afterCycle` hook to `L2PollDriver` (fires once per poll cycle, after every book's
snapshot is routed, awaited so the no-pile-up guard serialises it) wired to a new
`MmPortfolioTrader.hedgeTick()`. The bar tick drives the hedge only when no fast driver exists (offline
tests) ⇒ never double-hedged; `hedgeTick()` is re-entrancy-guarded (it places real paper orders).

**2. DR-3 — F3 is instrumented.** The toxicity defence was invisible (#44: 0 widen-events, no way to
tell it fired). The L2 engine now tracks widen/tighten step counts + mean/max/last spread-scale,
surfaced as `metrics().toxicity` (undefined when the scaler is off ⇒ reads honestly), on
`MmBookSnapshot.toxicity`, and logged each NAV interval as a grep-able `F3 toxicity:` line.

**3. The money link — hedge cost priced INTO the maker spread.** A hedge you don't pay for is a sure
bleed: every passive fill is neutralised with a perp taker, so the maker half-spread must earn ≥ that.
Added `ctx.hedgeCostBps` — an additive half-spread premium applied to both sides in `buildQuotePair`
(the one chokepoint every quoter funnels through ⇒ no quoter touched), wired from the engine as
`(hedgeTaker + hedgeHalfSpread) · MM_HEDGE_COST_SPREAD_MULT` when the hedge is on. The mult (default
0.5) is the fill-rate-vs-cost lever — a neutral book offsets most flow before it becomes hedged delta,
so charging the full per-fill round-trip over-widens and starves fills.

**4. Priority #2 — OOS hedge β-map.** `scripts/hedge-beta-fit.ts` (DB-free, public HL REST) OLS-fits
each alt's log-returns on BTC/ETH and maps it to the better-tracking major. Measured 2026-06-09
(30d×1h, R² 0.5–0.8): **SOL/DOGE/XRP/ADA/SUI→ETH, BNB→BTC** ⇒
`MM_HEDGE_BETA_MAP="SOL:ETH:1.01,DOGE:ETH:0.97,BNB:BTC:0.95,XRP:ETH:0.86,ADA:ETH:1.03,SUI:ETH:1.30"`,
baked as the start-desk default — the hedge now neutralises the basket with ~2 major legs (the #41 "8
books = 1 β bet"), not 8 self-hedges.

**5. No more silent-off (DR-0) + the UI shows it.** `scripts/start-desk.sh` now bakes ALL four pillars
ON (it IS the canonical Run A′). The `/demo` MM-desk view gained a **delta-hedge panel** (gross Δ,
residual + % neutralised, hedge P&L folded into desk net, funding, cost, per-leg) and **per-book F3
diagnostics** — a working hedge/defence is finally visible (the colour-semantics + dead-stuff UI pass
is the next session). Run A′ re-registered with a **realised-first gate** (desk realised ≥ 0, not just
bounded DD) + hedge-live + F3-fired checks before any directional Run B.

**6. The training loop (binding intent).** `docs/RUN_TRAINING_LOOP.md`: every run trains the next —
artifacts = the dataset, realised P&L = the reward, params (β-map, cost mult, F3 scales, bias gate) =
the weights, OOS gate + pre-registration = anti-overfit. Per-artifact fitter→param map + the path to
automating it (`learn-from-run.ts` → a gated trainer loop). Honest caveat: the market is
non-stationary ⇒ last run's optimum is a *prior*, re-fit every run, move in small pre-registered steps.

**Tests:** tsc clean; 1243 pass (the lone red is the pre-existing `telemetry.module.spec` isolation
flake, untouched). **NOT yet measured** — this is engineering verified by tests; the proof is the
forward Run A′ (hand-run: `bash scripts/start-desk.sh` + `launch-mm-10h.sh`, then the `mm-run-review`
skill). **Next:** run it; review realised-first; if realised < 0, the leak is adverse selection (tune
F3 scales / γκ / the β-map via the training loop) — NOT more coins. Plus the deferred UI review.

### #45a hotfix (same day, from the first live look) — the hedge marked a flickering price at $0
Ronnie opened the live `/demo` and the desk read **+$194M P&L on $8M** — the hedge P&L was garbage.
Reproduced + fixed: on the 100ms cadence, when a book goes un-warm/mid-relaunch its symbol drops out of
the desk price map (`deskDeltas` skips mid≤0). With the cross-asset β-map the hedge underlying (ETH) then
had no live price, so `DeskHedgeController` (a) marked its OPEN perp at **0** → phantom P&L, and (b) saw
its current hedge as **$0** → re-traded every tick. Fix: `resolveMarks()` falls back to the **last-known
mark** per underlying, used for funding/current-hedge/fill/P&L alike. Probe: flicker case orders=26 /
hedgePnl=−$9,752 → orders=1 / −$2 (= the stable case). Regression test added. **A desk already running
must be restarted (stop-desk + relaunch) to clear the bad in-memory hedge state** — persisted mm_nav rows
are historical. This is exactly why the UI-visibility work mattered: the bug was invisible until the hedge
was on the card.

## 2026-06-09 — Entry #46 (JOB A: MM-desk UI colour semantics made honest + dead-field audit)

The #45 next-session ask: the `/demo` desk pages must use intuitive colour — **green = working FOR us,
red = against us** — the way a pro MM terminal does, and show only real/active fields. Audited every
`signClass(...)`/colour call site across the MM-backed pages (`/desk/mm`, `/exec`, `/risk`); stat-arb
desk left untouched (not in active development).

**The colour dialect (now documented at the top of `format.ts`, the one place the dialect is decided):**
- **green (.pos)** — money FOR the desk: realised/MTM gains, funding received, a maker **rebate**
  (revenue), net profit. The rebate case is the subtle one: fees are coloured by their **contribution**
  to net (`−feesUnits`), so a cost reads red and a −0.2bps HL rebate reads **green** (already wired #43 —
  confirmed correct).
- **red (.neg)** — money AGAINST the desk: losses, costs paid, funding paid, **adverse selection**
  (`adverseSelectionUnits` is a signed one-bar markout — negative = picked off → red; a *favorable*
  markout is genuinely good → green, which is honest), a drawdown **over budget**.
- **amber (.warn, new class)** — caution / the **gate intervening**, NOT a loss: blocked quotes, a
  non-Allow risk verdict, WARMING. Eyes-here, but we didn't lose money.
- **neutral (.flat/.dim/plain)** — **direction & exposure**, where a sign isn't good/bad: inventory,
  net delta, gross Δ / residual, quotes (bid/mid/ask/reservation/½-spread), counts. Never `signClass`.

**Fixes applied (the three genuine bugs the audit found):**
1. **`/risk` net & per-book exposure** was `signClass` → a net-**short** read **red** ("bad") and a
   net-long read green. Exposure sign is a *direction*, not goodness → now **neutral** (sign still shown
   in the number). This is the same inventory-sign trap the MM card already avoids.
2. **`/risk` blocked quotes / blocked-books** were **red** (loss colour). A blocked quote is the risk
   gate doing its job → recoloured **amber** (caution). Kept "books over budget" red (a real breach).
3. **`/desk/mm` card maxDD** was un-coloured dim text; it's always-bad → now **red once it breaches the
   shared `DRAWDOWN_BUDGET_PCT` (2%)**, dim within — matching how `/exec` + `/risk` already flag it.

**Verified already-correct (no change):** the per-book cash grid still literally sums to net (#43
invariant, untouched); the hedge panel's hedge-P&L is labelled "folded into desk net" so it isn't
double-shown as separate; hedge P&L / funding (green=received) / cost (negated → red) and gross Δ /
residual (neutral) were all coloured right by #45. **F3 toxicity** stays **dim** — it's the adverse
defence *firing* (a diagnostic), not money for/against us.

**Dead-field audit:** the render layer (mm/exec/risk) shows **no** dead/legacy/never-populated field —
the snapshot carries bar-path-only (`seededBars`/`lastBarAt`/`barsSeen`) + unused (`vpin`/`vpinBuckets`/
`inventoryNotionalCapUnits`/`markout`/`fundingRatePerHour`) fields, but **none are rendered** on the MM
pages (`/risk` even refuses to print a fake VPIN — shows live adverse instead). Nothing to remove on the
pages; pruning the unused *snapshot* fields is an engine-side tidy, deferred (out of UI scope). One stale
comment noted: `inventoryNotionalCapUnits`' doc claims "the UI shows exposure as a % of this rail" — the
UI does not; a 1-line engine-comment fix left for the repo-wide audit pass.

**Tests:** tsc clean; `jest src/ui` 94/94 green (+ new maxDD-reddens-over-budget and exposure-neutral /
blocked-amber assertions). **JOB B (run + review Run A′) is hand-run by Ronnie** — the sandbox can't run
the dev server; smoke step: `bash scripts/start-desk.sh` → `http://localhost:3100/desk/mm` (+ `/risk`).

### #46a (same day, live look #2) — stop-desk now flattens the HEDGE too, so the desk lands on a true 000
Ronnie restarted and still saw a garbage P&L (~$666M). Root cause was **process hygiene, not the fix**:
`ps` showed **three** desk servers alive — two from **Jun 8, before the #45a hedge fix** — none bound to
:3100 anymore, but the browser had been served by a stale pre-fix process still holding the poisoned
in-memory hedge position. Killed all stale `nest start --watch` / `dist/src/main` processes (the +$666M
died with them; the hedge is in-memory, not persisted).

But the diagnosis exposed a **real gap** Ronnie asked to close: the **stop-desk ritual must take the desk
to a visible 000 by itself**, no process restart. Today `closeAll()` (what `scripts/stop-desk.sh` POSTs)
looped `removeBook` per book (each taped, step-by-step ✓) but **never reset the hedge** — so
`hedger.snapshot()` kept marking the still-held perp legs against the last-known price and the UI's hedge
panel showed the phantom P&L until the process was killed (exactly the #45a trap, just surfaced via the
panel instead of the net). Fix: **`DeskHedgeController.reset()`** (clears `pos` + `lastOrders` +
`lastMark` → snapshot reads 0 gross/residual/P&L, perUnderlying empty) called from `closeAll()` after the
books are dropped, emitting a `delta hedge flattened — N perp leg(s) closed, desk flat` lifecycle event.
Now stop-desk tapes each book close, then the hedge flatten, and the summary + hedge panel both read a
true **$0.00 / flat** — no restart needed. (`flatten` endpoint unchanged — it keeps books and the live
loop unwinds the hedge over the next ticks; only `closeAll` needs the explicit reset since it stops.)

**Tests:** tsc clean; `desk-hedge-controller` (reset → flat 000) + `mm-portfolio-trader` (closeAll resets
hedge, tapes it, snapshot flat) green — `jest src/market-making/{hedge,live,events}` 93/93. **Operator
note:** if a desk shows a ghost P&L, the cause is almost always a **stale duplicate server** — `ps aux |
grep nest` should show exactly ONE; kill extras, then `bash scripts/stop-desk.sh` lands it on 000.

## 2026-06-09 — Entry #47 (the rehydrate trap: restarted books fell back to slow bar quoting → the bleed)
**Symptom.** A ~73-min governed run (8 HL books, $1M each, delta hedge ON) bled **−$80.3k realised** (DB
`mm_nav`, ~100% realised — locked in, not a mark), maxDD scaling with each coin's vol (XRP/BTC/ETH worst,
ADA least). Fees were tiny (−$8…−$68/book) ⇒ NOT a cost problem. Per-book attribution from the log
persistence blobs (`realised = spreadCaptured + invCarry + funding`; `adverse` is the diagnostic markout):
**`spreadCaptured` deeply NEGATIVE on every book** (−$3.9k…−$14.8k) — the textbook signature of **getting
picked off** (the mark moves against each fill by more than the half-spread earned).

**Root cause (the real find).** The book the operator was running had been **rehydrated from persistence**
(`boot: "rehydrated 8 mm book(s)"`). The fast-path machinery — F1 micro-price center + sub-second re-quote,
F3 toxicity widening, and the hedge-cost-in-spread premium — was wired **only in `makeBook` (the fresh
launch path)**. `rebuildBook` (the restart path) built a plain `MmBook` with **no `fastEngine`** ⇒
`isFastPath()` = `!!cfg.fastEngine` = **false** ⇒ the book ran on the **15s bar tick** off a ~1/min candle
mid. So a 15s-stale quote sat in front of 100ms flow — **all of #27–#44 silently evaporated on every desk
restart/reopen.** This is why "I thought everything was microsecond" and "this was supposed to be fixed":
the fixes were real, but only on the launch path; the two construction paths had drifted.

**Hedge churn (secondary, ~$4k).** 133 hedge orders, **$14.7M perp notional round-tripped** (20 BTC `open`s
+ 20 `flip`s = flattening then re-opening, not converging). Cause: `deskDeltas()` skipped any book whose
mid flickered to 0 for a cycle (`midMicros <= 0n continue`), so that underlying's net delta vanished, the
hedge unwound a correct leg, then re-opened it next cycle. #45a's flicker fix only stabilised the hedge's
*own* valuation (`DeskHedgeController.resolveMarks`), not the *book-side* dropout upstream of it.

**The honest verdict (said plainly to the operator).** The hedge was **~5% of the loss, not the cause**. A
perfect, free, instant delta hedge still leaves the ~$80k — it's a **fair-value/edge problem**, not a
directional-delta problem. A hedge converts directional *variance* into a steadier line; it cannot
manufacture edge from a negative-edge quoter.

**Fixes shipped (this entry).**
1. **Unified book wiring** — extracted `resolveBiasSources()` + `buildFastEngine()` helpers in
   `market-making.module.ts`; **both** `makeBook` and `rebuildBook` now call them, so a rehydrated L2 book
   is byte-identical to a freshly launched one (fast engine + bias axes + F3 + hedge-cost-in-spread). This
   is the primary fix — books are back on the 100ms micro-price re-quote path after a restart.
2. **Hedge-cost-in-spread now actually fires** — `hedgeCostBps = (taker+halfspread)·mult` (= (2.5+1)·0.5 =
   **1.75bps** premium when the hedge is on) lives in the fast engine and was already unit-tested
   (`quote-pair.ts:119`); fix #1 means rehydrated books finally get it.
3. **Hedge-churn fix** — `MmPortfolioTrader.deskDeltas()` keeps a `lastBookMark` per symbol and values a
   flickered book's delta at its last-known mark instead of dropping it, so the hedge stops round-tripping
   across price flickers (only a never-warmed book is skipped).

**Tests:** tsc clean; `jest src/market-making/{live,hedge,quote}` 121/121 green. **Operator rule (now in
the `mm-run-review` skill):** after every run, read **edge first** (is `spreadCaptured` negative? = picked
off), and check the desk loop log line — if it says `quoting every 15000ms` AND there's no fast-path
activity, the books rehydrated onto the slow path. A genuinely fast desk re-quotes sub-second.

## 2026-06-09 — Entry #48 (the frontier moved: pick-off fixed → σ-independent inventory lean)
**First clean read on the fixed (fast-path) desk** (8 books, $8M, ~42 min): `spreadCaptured` flipped to
**POSITIVE on all 8 books** (BTC +191, ETH +133, SOL +77, …) vs −$4k…−$15k each pre-fix — **the #47
micro-price/fast re-quote fix killed the pick-off.** The delta hedge also works now: gross delta
**$382,619 → residual $586** (99.85% neutralised), churn down to 61 orders/$2.5M (from 133/$14.7M). Desk
net −$1,627 — but it's **realised −$618, unrealised −$1,055** (open marks, partly revert). The new #1 loss
is **inventory carry / cross-hedge basis**: 7/8 books ran NET SHORT into a rising tape (passive LP
accumulates against the trend), and the hedge flattens the *beta-weighted* delta but not the alt/major
**basis**, so the alt inventory marks against us.

**Root cause of the inventory build:** the GLFT reservation skew is ∝ γ·σ²·q — in a **calm-but-trending**
tape (low realised vol, steady drift) it nearly vanishes (≈2bps at full inventory at the σ-floor), so the
book has no real lean to shed one-sided inventory. `inventorySkewMult` only scales that already-tiny term.

**Fix shipped:** `MM_INVENTORY_SPREAD_SKEW` (default **0.4**) — a σ-INDEPENDENT graduated asymmetric
half-spread skew driven by inventory utilisation u=q/cap: tighten the shedding side (more exits) + widen
the adding side (fewer entries), proportional to how full the book is, ramping to the hard cap. Wired
interface→factory→registry→**both** makeBook and rebuildBook (#47 discipline). tsc clean; jest
src/market-making+config 331/331 (+5 shed-skew specs). **Operator note:** don't edit code under a live
`nest --watch` desk you're measuring — each save hot-reloads (restart → re-rehydrate → hedge reset →
books come up stopped). Stop, change, then start a clean run. **NEXT:** clean Run A′ on the full fixed
build; if inventory/basis still bleeds, the levers are MM_INVENTORY_SPREAD_SKEW↑, tighter notional cap,
and a dynamic/per-name hedge — see the deep-research prompt drafted this session.

## 2026-06-10 — Entry #49 (Run A′ read at ~2h20m: pick-off stays fixed; the loss now lives OUTSIDE the markout windows)
**The run** (still in flight; read at 13:47Z): 8 fast-path GLFT books, $8M, hyperliquid, hedge ON,
F3 toxicity ON, directional OFF, shed-skew 0.4 (the #48 fix), markout horizons left at the
**default 1s/5s/30s** (WP2a's 300s capability shipped but `MM_MARKOUT_HORIZONS_MS` unset).
Window 11:26→13:47Z (~2h20m), 979 fills. Log is clean now (TypeORM echo off, ddf89e4) — the
persistence-blob attribution scrape in the mm-run-review skill is **dead**; the live
`/api/market-making/snapshot` is the new (better) source.

**Scorecard (realised-first, DB mm_nav).** Desk realised **−$3,359**, net −$3,024 (+$92 unreal),
fees −$238 — −4bps of capital in 2.3h. maxDD: desk **1.65%** (SOL 1.65, BTC 1.36, SUI 1.37, XRP 1.41,
ETH 1.28; ADA 0.65, BNB 0.34, DOGE 0.29) — marginally over the ~1.5% bar, not a blowout.
Books: SOL −1,349 / BTC −1,246 / ETH −944 / SUI −745 / DOGE −18 realised; ADA **+732**, BNB +148,
XRP +126. Flattery check: ADA net +1,264 is +$530 unreal; BNB net +366 is +$220 unreal. Reverse trap:
**XRP realised +126 but −$967 open mark** — and XRP is the desk's worst hedge (r² 0.51, βcfg 0.86 vs
live 0.62, **77% basis share**): that open mark is the (1−ρ²) basis bleed of study §0, live.

**Edge (the #47/#48 fix HOLDS over hours).** `spreadCaptured` **positive on all 8 books** ($2,154 desk)
— first multi-hour confirmation. But adverse ($2,869) > spread on 6/8: windowed fill-edge ≈ **−$715**.
Markout (1s) negative on every book (−0.2…−4.5bps). The discriminator is the *curve shape*:
**ETH** −0.23bps@1s → **+0.7@5s → +1.7@30s** on 327 fills (flow mean-reverts past 1s — real edge);
**DOGE/ADA/BNB/XRP decay monotonically** to −3…−7bps@30s (slow pick-off); BTC adverse at all horizons
(−2.7→−4.5). Exactly the study-§2.1 read — and it argues for the 60s/300s horizons next run.

**THE find — attribution no longer explains the P&L.** Windowed components sum to ≈ **+$2.7k**
(spread 2,154 − adverse 2,869 + carry +3,617 + funding ~0 − fees 244) vs actual desk net **−$3.2k**:
a **~$5.9k unattributed gap**. Cause (by construction, `pnl-attribution.ts` + fast-engine wiring):
spread/adverse/carry are only marked over the 1–30s window after each fill; **drift on warehoused
inventory between/outside those windows lands in no component** — and that is where the desk now loses.
Signature: ETH filled **270 bids vs 57 asks** (one-sided accumulation into a falling tape), shed-skew
crystallises the round trip minutes later, outside every markout window. The #48 shed-skew (0.4) did
not stop the build → study problems **#2 (trending inventory) + #1 (basis)** are confirmed as the
frontier; the pick-off war is won.

**Hedge (separated, per #44 discipline).** (a) Book bleed −$3,359 = the dominant term. (b) Hedge:
gross delta $92.5k → residual $384 (99.6%); hedge P&L ≈ +$120–270 *after* **$3,524 cumulative cost**
on **313 orders / $11.5M churned** — the leg paid for itself this window (short into the falling tape)
but the churn *rate* matches #48 (no improvement): ETH leg converged (227 increase/reduce, 16 flips),
**BTC leg churns** (23 flips vs 1 open — net delta hovers near zero and the leg keeps crossing flat).
Study **#2 (inventory-dependent dead-band)** is the named fix. (c) **Hedge-quality KPI (WP1, study §0)
delivers its first live verdict:** desk pnlVol $1,591/h vs basisVol $813/h (~26% of desk variance);
per-book basisShare XRP **77%**, ADA 52%, SUI 41%, DOGE 31% — delta residual ~0 while half the alt
books' P&L vol is unhedgeable basis. The KPI works; it priced the XRP trap before the mark showed it.

**F3 toxicity (WP2a) discriminated correctly:** VPIN BTC 0.68 / ETH 0.74 → avgScale 1.19/1.22 (widened);
quiet books (BNB/ADA/DOGE vpin ~0) tightened to ~0.75–0.80. The defence fires on the right books.

**Study-§1 ranked list — status after this run:** #5 (markout horizons + VPIN→F3) **shipped & validated**
(extend horizons to 60s/300s next run); #1 (portfolio netting before hedge) partially exists (8 books →
2 perp legs) — basis shares say it's the next build (WP3); #2 (dead-band → internalize/externalize)
supported by the BTC-leg churn; #3 (drift term in quote center) supported by ETH's 270/57 one-sided
fills — directional was deliberately OFF; #4 (basis-scaled spread/caps) now has live priors
(XRP 77% / ADA 52% / SUI 41%).

**Trader UI gap (vs TRADER_UI_SPEC.md):** the decisive diagnostics of this run — markout curve shapes,
per-side split, basis shares — are on the snapshot but rendered **nowhere**; `/desk/mm` shows
attribution + F3 counters only. This run is the case for building `/desk/markout` + `/desk/toxicity`.

**Ops note:** mm-run-review skill needs updating — log-based attribution scrape is dead (no TypeORM
echo); use `GET /api/market-making/snapshot` (attribution, markout, markoutBySide, vpin, toxicity,
hedge.quality) while the desk is up.

## 2026-06-10 — Entry #50 (Run A″ read; MASTER PLAN I → session chain; the Sweet-16 book swap ships)
**Run A″ read (mid-flight, ~19:20Z; 8 GLFT books, $8M, hedge ON, F3 ON, directional OFF,
markout horizons 1s/5s/30s/60s/300s LIVE; restarts 14:25/17:43/18:08 with MM_PERSIST continuity).**
1. **DD bar: PASS** — per-book maxDD 0.03–1.33% (SOL 1.33, SUI 1.22, BTC 0.91…BNB 0.03), all under
   the ~1.5% bar (A′ was 1.65%).
2. **Desk realised +$477** (net −$443, fees −$187) — first ~breakeven-to-green realised window after
   A′'s −$3,359/2.3h. SOL +752 / ADA +494 carry; XRP −326 / ETH −286 / BTC −203 bleed. Flattery:
   SUI net −356 is −350 unreal; desk unreal −$1,104 vs books-sum −$66 ⇒ **~−$1.0k sits on hedge legs**.
3. **Edge:** spreadCaptured + on 7/8 (Σ +$1,657) ≈ adverse (Σ $1,641) — windowed fill-edge ≈ $0, the
   pick-off war stays won. **The 60s/300s horizons confirm #49**: markout@300s XRP −16.7bps /
   SOL −12.3 / BTC −9.3 monotone through 60s (h* ≥ 300s); DOGE/BNB revert by 300s; **ETH flat ≈0**.
4. **Hedge = the #1 measured leak:** 263 orders / $9.1M churned / ~$2.7k cost (5.7× realised!);
   BTC leg 31 flips (cross-flat churn); gross $12.8k → residual $1.7k. **Regression:** hedge-quality
   betaLive/r² = 0 on all 5 ETH-underlying books (worked in A′) — suspect the persist-restore path.
5. **Attribution still doesn't sum** (components ≈ +$2.7k vs net −$443) — #49's warehouse-drift gap.

**MASTER PLAN I evaluated → docs/MASTER_PLAN_SESSIONS.md** (the living session chain). Verdicts:
hedge-cost work + attribution-that-sums outrank the plan's default order (our leaks say so);
D1 cross-venue FV stays demoted to a 60–300s re-test (#27–33 measured the 1s no-op); fee-tier/HYPE/
builder-codes/Tokyo-node PARKED (paper mission) with stale-quote pricing as the node's substitute;
9 session prompts (S1 attribution+leak-table → S2 hedge → S3 long-horizon AS → S4 regime → S5
funding lean → S6 book-scoring → S7 simulator microstructure → S8 shadow rig → S9 multi-venue).
Each session ends by reviewing/rewriting the remaining prompts and printing the next one.

**The Sweet-16 swap (docs/BOOK_SELECTION_ANALYSIS.md priors × live API verification) — SHIPPED:**
desk goes 8 → 16 books next run: **8 HIP-3 RWAs** (xyz:GOLD/SILVER/XYZ100/SP500/CL/BRENTOIL/NVDA/
TSLA — live 24h vol $24M–$1.0B; trade.xyz dex) + **8 main-dex** (HYPE FARTCOIN kPEPE PURR SUI SOL
ADA DOGE). **BTC/ETH/XRP/BNB dropped as books** (BTC/ETH stay as hedge legs; launch script removes
them explicitly — MM_PERSIST would silently rehydrate them). Engineering: `hlCoin()` exact-case HL
coin keys — HIP-3 "xyz:" prefix AND k-coins (kPEPE was unreachable under toUpperCase: live HTTP 500
→ fixed, verified); beta-map right-anchored parse + **beta 0 = explicit don't-hedge** (HIP-3 books
have no crypto factor — governor-capped, not hedged); **HIP3_FEE** maker +0.15bps/taker 0.9bps —
NO rebate assumed on HIP-3 until verified per deployer (paper-honesty rule: never pay yourself an
unverified rebate); `scripts/smoke-sweet16.ts` — **all 16 books verified reachable through the
engine's own client** (spreads: xyz:CL 0.11bps … PURR 44bps); $500k×16 = the same $8M desk.
**Owned gaps:** per-dex funding unwired (xyz funding=0), HYPE/FARTCOIN/kPEPE/PURR betas unfitted
(beta 0), HIP-3 fees are estimates (S6 verifies), RWA closed-hours gap risk unmodeled (S4/S8).
tsc clean; touched suites green (49 tests across 7 suites).
