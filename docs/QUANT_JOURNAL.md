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
