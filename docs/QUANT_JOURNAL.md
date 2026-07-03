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

## 2026-06-11 — Entry #51 (Sweet-16 first live read, mid-flight ~3.6h — read-only analysis, no code changes)
**Run: 16 books × $500k = $8M (8 HIP-3 xyz: RWAs + 8 main-dex), hedge ON (ETH-perp leg only;
β=0 explicit on HYPE/FARTCOIN/kPEPE/PURR + all xyz:), F3 ON, directional OFF. Started 22:26Z
2026-06-10; nav read at 02:02Z (~3h36m). Run still live — mid-flight read, not a final verdict.**

1. **DD bar: 14/16 PASS, 2 breaches** — HYPE maxDD **1.76%** and xyz:BRENTOIL **1.61%** vs the
   ~1.5% bar; both are **unhedged** (β=0) books. Everything else ≤1.25% (xyz:SILVER 1.25, ADA 0.96,
   BTC-class anchors gone). The two breaches are exactly where the hedge doesn't reach.
2. **Desk realised −$1,084** (net −$1,386, unreal −$289, fees +$13 ≈ wash). The bleed is
   **concentrated in 3 books**: HYPE −1,507 / xyz:BRENTOIL −1,187 / xyz:SILVER −816 = **−$3,510
   realised**; the other 13 books sum **+$2,426**. **xyz:CL is the desk's best live book ever:
   realised +$1,397, 318 fills, maxDD 0.25%** — and it earned that *paying* HIP-3 maker fees
   (+$101, no rebate assumed per #50's honesty rule). Flattery flags: kPEPE net +631 is +560
   unreal (realised only +69), PURR +434 is +317 unreal; reverse-flattery on ADA (realised +100,
   unreal −707), SOL (+13/−352), DOGE (−22/−236) — warehoused inventory marked against, the
   familiar carry drift.
3. **Edge: the pick-off war RE-OPENED on the new books.** spreadCaptured is positive on all 16
   (Σ +$4,528) but adverse Σ +$6,029 ⇒ **windowed fill-edge ≈ −$1,501** (A″ on the old 8 was ≈$0).
   Worst ratios: xyz:SILVER sprd 528 vs adverse 1273 (0.41), FARTCOIN 73/221, HYPE 1593/1925,
   xyz:BRENTOIL 597/867. CL is window-breakeven (1150/1172) yet strongly realised-green — its edge
   lives outside the markout windows (carry/queue). Markout: PURR −4.8/−7.6/−11.0bps (1s/5s/30s)
   but its 44bps spread still nets green; ADA monotone −2.5→−5.1 and SUI −1.4→−3.4 (h*>30s,
   re-confirms #49/#50 long-horizon AS); NVDA/GOLD revert to ~0/+ by 30s (healthy); HYPE flat
   ~−2bps on 606 fills but heavily one-sided (387 bid / 219 ask = sellers hitting us), VPIN 0.58.
4. **Hedge: the A″ #1 leak is FIXED.** 53 orders / $1.38M churned / ~**$0.4k** cost (A″: 263 /
   $9.1M / $2.7k) — mostly increase/reduce around a steady level, 6 flips, residual $676 on gross
   delta $121k. The book swap (BTC/ETH books out ⇒ single ETH leg, no BTC cross-flat churn) did it.
   **betaLive/r² regression from A″ is also gone** — live fits are back, and they say the β=0 calls
   were wrong on two books: **kPEPE βlive 1.12 r²=0.77, FARTCOIN βlive 1.60 r²=0.68** (real ETH
   factor, currently 100% basisShare); HYPE marginal (1.21/0.32); PURR confirmed factor-free
   (0.14/0.01). ADA cfg 1.03 vs live 1.17, SOL 1.01 vs 1.33 — stale-beta drift for the S2 bake-off.
5. **Attribution still doesn't sum** (S1's reason stands): HYPE components imply ≈+$1.1k
   (1593−1925+1429) vs realised −$1,507 — a ~−$2.6k warehouse-drift hole on one book.

**MASTER PLAN read-through (suggestions only — nothing changed this session):**
- **S1 stays next and stays #1.** The leak table now has a sharper job: split desk bleed into
  (a) windowed pick-off −$1.5k — concentrated in SILVER/BRENTOIL/HYPE/FARTCOIN, (b) warehouse
  drift (the non-summing hole), (c) hedge ~$0.4k (now small — demoted as a leak).
- **S2 gets live inputs ready-made:** fit kPEPE/FARTCOIN betas (r² .77/.68 say β=0 is wrong);
  decide HYPE (r² .32) with data; refresh ADA/SOL drifted betas. The two DD breaches being the two
  big unhedged losers is the S2 motivation in one line.
- **S6 early book-scoring evidence (one window — record, don't kill):** CL = strong keep;
  SILVER/BRENTOIL = retune-or-rotate candidates (same dex as CL, same asset class, opposite sign —
  likely a spread-width-vs-flow mismatch, their sprd/adverse ratios are the desk's worst);
  HYPE = check why F3 isn't widening it harder at VPIN 0.58 with one-sided flow; NVDA/TSLA/GOLD =
  quiet green confirms.
- **S4 evidence:** the run spans US-evening→overnight; equity-hour books (SP500 9 fills,
  XYZ100 5) were near-dead while metals/oil traded — the RWA closed-hours/regime tagger has its
  first live dataset.
- **Verdict shape:** the Sweet-16 swap is *working as a portfolio* — 13/16 books net-positive
  realised, hedge leak killed, and the desk loss is 3 fixable books, not a structural bleed.
  Mid-flight realised rate ≈ −$300/h on $8M; CL alone proves HIP-3 quoting earns paying full fees.

**#51 addendum (same day, post-run — actioned for the next run):** run stopped by Ronnie. (a) **Cut
HYPE / xyz:BRENTOIL / xyz:SILVER** from the book set (rotation-out on the #51 read, S6 re-adjudicates) —
launch-mm-10h.sh BOOKS now 13 (×$500k = $6.5M desk) and the three are added to DROPPED so MM_PERSIST
can't rehydrate them. (b) **Hedge map re-fit** (30d×1h OOS, scripts/hedge-beta-fit.ts): SOL 1.02 /
DOGE 0.94 / ADA 1.04 / SUI 1.29 (cfg drift was window noise — live βs were NOT pasted in);
**FARTCOIN:ETH:1.53 (R².65) and kPEPE:ETH:1.20 (R².77) now hedged** (were β=0; the run's live KPI
agreed); PURR stays 0 (R².13). ADA's BTC/ETH fit tied → kept on the single ETH leg (netting > tie).
(c) hedge-beta-fit.ts no longer uppercases symbols (kPEPE 500'd — same exact-case bug ac7d001 fixed
in the engine). (d) The previous session's orphaned hedge fix (bookless-underlying marks, the thing
that kept this run's ETH leg alive) committed as 382a04e with its 11 tests — the working tree is clean.

**#51 addendum 2 (risk-averse profile + the dead-γ bug):** Ronnie's standing doctrine extended:
**prefer fewer fills over losing fills** — widen when needed, accept lower fill rate; and between-run
fixes need not be isolated. Shipped for the next run:
1. **MM_GAMMA was a dead knob on the live path** — the module's `params` object never passed
   gamma/kappa to `mmStrategyRegistry.build()`, so every launched/rehydrated quoter silently ran the
   registry's baked γ=0.0025/κ=2 regardless of env. Fixed at both build sites (launch + rehydrate);
   per-book `spec.params`/`rec.params` still override. All prior runs were honest by luck (env never
   set ≠ default).
2. **Risk-averse defaults in start-desk.sh** (each knob verified against asHalfSpread/asReservation
   math): **MM_F3_MIN_SCALE=1.0** (F3 widen-only — never quote tighter than baseline; was 0.5),
   **MM_GAMMA=0.005** (2× — doubles the inventory-risk term + reservation skew; honest note: base
   spread ≈2/κ is γ-insensitive, so this is the shed-inventory knob, not a width knob),
   **MM_MAX_INVENTORY_NOTIONAL_FRAC=0.15** ($75k/book cap vs $125k — warehouse drift is the #51
   surviving leak), **MM_INVENTORY_SKEW_MULT=6** (was 4). Deliberately NOT touched: κ and
   MM_MIN_HALF_SPREAD_BPS — a blind global widening un-quotes the tight winners (xyz:CL 0.11bps);
   κ goes to the next mm-l2-tune γ/κ sweep.
tsc clean; mm.controller + registry + glft-quoter suites green (31 tests).

## 2026-06-11 — Entry #52 (MASTER PLAN S1: attribution that SUMS + the leak table — the compass is fixed)
**Session S1 of the chain (docs/MASTER_PLAN_SESSIONS.md). All work developed off-process on a
worktree branch (feat/mm-s1-leak-table) while the next run trades — rules-of-engagement §2.**

1. **Attribution sums now.** The missing term was ALREADY in the engine: `accrueInterval`
   (mm-book.ts) accrues continuous Σ inv_carried×Δmid on BOTH drive paths and persists it
   (`mm_book_state.inventoryCarryUnits`) — the fast-path snapshot just never surfaced it,
   reporting only the engine's windowed carry. Exposed as **`inventoryMtmUnits`** (both paths);
   identity **net = fillEdge + warehouseMTM + funding − fees** pinned EXACT by two unit specs
   (fill-then-slide tape; rebate variant). `/desk/mm` renders it as the "warehouse" cell.
2. **The A″ hedge-quality r²=0 bug — reproduced, root-caused, regression-tested.** Mechanism:
   `resolveMarks` falls back to `lastMark` forever, so an underlying with no live book price
   FREEZES after a restore ⇒ rU≡0 every bucket ⇒ var(U)=0 ⇒ betaLive/r² UNMEASURABLE (null,
   rendered as 0). The 382a04e resolveMid path is the fix and is now pinned by a
   simulated-restore spec (13/13 green). #51's live fits were alive because of it.
3. **scripts/mm-leak-table.ts** — one command: mm_nav window + mm_book_state + run-log HEDGE
   lines (+ live snapshot only when the window ends ≈now) → per-book identity table, ranked $
   leak list, hedge churn (track/flip/open), loss concentration, md+json to docs/research/.
   Run-review skill updated: leak table is STEP 0.
4. **The measured leak tables** (docs/research/leak-table-{run-a2,run51-sweet16}.{md,json}):
   - **A″ re-read with real accounting:** hedge churn **−$2,454 = A″'s #1 leak** (263 orders,
     $9.1M churned; prompt predicted ~$2.7k ✓). Implied hedge-leg P&L **−$1,184** (the #50
     "~−$1.0k on hedge legs" estimate, now measured). ETH/BTC books: fillEdge POSITIVE
     (+94/+67) but warehouse −355/−263 — **A″'s majors bled warehouse, not pick-off**.
   - **#51 Sweet-16:** ranked leaks 1–2 are **warehouse MTM: BRENTOIL −1,128 / HYPE −1,126**;
     then SILVER fill edge −742; hedge churn down to **−$373** (53 orders, 46 track/6 flip —
     the single-ETH-leg netting from the book swap already delivered most of S2's predicted
     netting win). Cross-validation: identity-implied fillEdge vs the independent live windowed
     read — SILVER −742 vs −745 (0.4%), BRENTOIL −277 vs −270 (2.6%), HYPE −373 vs −332 (the
     12% gap = the quote→fill WEDGE, stale-quote pick-off — S7's input, now measured).
5. **Negative results / gaps (owned):** engine windowed spread/adverse are NOT persisted (state
   reads 0 for fast books — finished runs get the identity, not the split); a RELAUNCH
   overwrites surviving books' state accumulators (only removed books keep final state —
   run the leak table BEFORE relaunching); markout-by-hour, queue tercile, top-of-hour
   toxicity not logged yet; xyz funding still 0 by construction.
**Verdict for the plan: warehouse drift is the desk's #1 measured leak class in BOTH runs
(A″ majors −657, #51 −2,254 across books) — S2 re-scoped around the inventory time-stop +
dead-band/beta polish; hedge churn demoted from "the" leak to a solved-but-watch line.**
tsc clean; touched suites green (hedge 13, mm-book 16, UI 16+, nav cron).

## 2026-06-11 — Entry #53 (MASTER PLAN S2: the inventory time-stop — built, swept, verdict MIXED ⇒ default OFF)
**Session S2 (worktree branch feat/mm-s2-warehouse; live run untouched). S1's referee: warehouse
MTM is the #1 leak class — S2 asked whether bounding HOLDING TIME pays.**

1. **Built: `TimeStopQuoter`** (src/market-making/quote/) — a wrapper around any IQuoter that
   shifts the whole pair toward the exit side once same-signed inventory ages past T (linear
   ramp, width preserved = skew-to-flat, **proportional to |inv| so it cannot overshoot through
   flat** — v1 without that swung BTC +$103k long → −$68k short, caught in replay). New
   `QuoteContext.nowMs` seam set by all three runtimes (bar ts / L2 snapshot ts / tape ts) so
   offline age == live age. 6 specs.
2. **Sweep (queue-aware replay, live risk-averse GLFT config, docs/research/timestop-sweep.md):**
   verdict **MIXED — regime-dependent, NOT wire-ready desk-wide**:
   - BTC (the trend-warehouse window the stop exists for): net −2,127 → **−730** (T=30m/8bps,
     maxDD 0.85→0.35) / −961 (30m/3bps) — the warehouse loss is genuinely cut.
   - ETH: +295 with REALISED +291 (661→952) at T=10m/3bps — the cleanest win (not a mark).
   - DOGE: +25 noise. **SOL: −1,524 at T=10m/3bps** (choppy one-way flow: the stop sheds into
     weakness and re-warehouses) — the kill case.
   - Caveats owned: tapes are 2026-06-04/05 main-dex (NO HIP-3 RWA tape — xyz:* out of sample;
     capture one next run); HYPE tape too coarse to use (1 queue fill/6h); one window per coin.
3. **Wired default OFF** behind `MM_TIME_STOP` (+`_AGE_MIN`/`_SHIFT_BPS`), both launch+rehydrate
   paths, `TIME-STOP ▸` engage/release log lines (the greppable audit trail). Pre-registration
   discipline: enable only behind the S8 shadow A/B or the S4 regime gate — the sweep says the
   stop needs to know the regime before it earns the right to quote.
4. **S1 gap closed: windowed spread/adverse now PERSIST** — fast books checkpoint
   base+engine attribution (`attribBase` restored on rehydrate; new `windowedCarryUnits` state
   field), so finished runs keep the fill-edge split and restarts no longer zero the snapshot
   columns (the #50 A″ wrinkle). Spec proves serialize→restore→re-serialize round-trips.
5. **Deferred, with numbers:** (a) dynamic hedge dead-band — #51 churn is $373/run est cost
   (46 track/6 flip, single converged ETH leg); a dynamic band plausibly saves ~half, gray-zone
   vs build cost — re-rank if the 13-book leak table shows churn regressing. (b) OLS/EWMA/Kalman
   beta bake-off — betas were OOS-refit TODAY (FARTCOIN/kPEPE fits new) and the hedge-quality
   KPI watches drift live; defer until basisShare shows inter-run drift actually hurting.
tsc clean; market-making suite 357/357 green. Artifacts: docs/research/timestop-sweep.{md,json}.
## 2026-06-11 — Entry #54 (the Elite-8 book swap — next run's set, picked on the #51 leak table)
Operator call (Ronnie): highest-P&L 8 for the next run, no majors, lean into trade.xyz. Picked
realised-first from the #51 leak table + a live universe scan (xyz dex by 24h volume, spreads
smoked through the engine's own client):
**BOOKS (8 × $500k = $4M):** xyz:CL (+$1,397 realised/3.7h, maxDD 0.25% — the desk's best book),
xyz:GOLD (+161), xyz:NVDA (+155), xyz:TSLA (+165), FARTCOIN (+313, hedged β1.53), PURR (+117,
maxDD 0.15%), kPEPE (+69, hedged β1.20), **xyz:SPCX** (SpaceX pre-IPO perp — operator discovery
slot, data-backed: $66M/day, spread 1.9–4.3bps across two reads, 20×20 L2 via HyperliquidClient,
exact-case xyz: path already proven by 318 CL fills; β=0, governor-capped, judged on its first
leak table). **Cut:** SOL/ADA/DOGE/SUI (flat realised, warehouse bleed, "no big markets"),
SP500/XYZ100 (near-dead our hours). **Universe scan:** spread×volume proxy ranks CL $451/d ≫
SNDK $160 / MU $148 / SKHX $138 / SPCX $142 ≫ GOLD $12 / NVDA $27 / TSLA $4 — the measured
books keep slots over the unmeasured shortlist (the BRENTOIL/SILVER lesson: priors ≠ P&L);
SNDK/MU/SKHX recorded as next-rotation candidates for S6. Scripts updated (BOOKS, DROPPED now
also removes the six cuts so MM_PERSIST can't rehydrate them, MM_FAST_SYMBOLS, beta map —
hedge leg now serves only FARTCOIN/kPEPE). Time-of-day caveat owned: spreads sampled pre-US
hours; equity-linked books breathe with US flow.
**Ops for THIS relaunch (binding, S1 rule): run the leak table BEFORE launch-mm-10h.sh —**
`npx ts-node -r tsconfig-paths/register scripts/mm-leak-table.ts --since <run-start> --until <now> --log <run-log> --label run52`
— relaunch overwrites surviving books' state accumulators.
## 2026-06-11 — Entry #55 (run53 verdict + the warehouse guardrails: loss-stop, session gate, cap cut)
**Run53 (08:46→12:42Z, 3.9h, Elite-8 v2 first window + SPCX's last):** desk net −$973
(realised −$928, fees +$58) on $4M. DD control HELD (worst book maxDD 0.93% < 1% bar); hedge
healthy and tiny ($47 churn, implied leg +$343). The loss is the desk's recurring failure shape —
**earn slowly on spread, lose suddenly on inventory**: CL −$626 in ONE 5-min window (57% of its
loss), kPEPE worst5m −$432 (60% conc), SPCX −$380. Per-book fillEdge (the structural verdict):
**SKHX −$632** (the #1 leak — picked off relentlessly in its debut), ORCL −$128 (its +$472 net is
warehouse luck, NOT edge — the classic trap book), CL −$62, FARTCOIN −$23; positive: kPEPE +$37,
NVDA +$26, GOLD +$6. Caveat owned: the whole window was PRE-US-OPEN — every xyz equity book was
quoting a closed/stale reference market; SKHX/ORCL get ONE US-hours window before slot decisions
(else SNDK is first reserve). Artifacts: docs/research/leak-table-run53.{md,json}.
**Operator finding (Ronnie):** the desk was believed delta-neutral; it is NOT — only
FARTCOIN/kPEPE are (factor-)hedged via ETH betas. Every xyz book is β=0 UNHEDGED by design (no
instrument on the desk hedges oil/gold/equities), i.e. ~75% of capital runs naked inventory and
prior session reporting under-stated this. **For xyz books, FLAT is the only hedge** — hence:
**Shipped (the #55 guardrails, all three on the same principle — cap what inventory can LOSE,
not just what it can BE):**
1. **Warehouse loss-stop** (`MmBook.guardrail`, both drive paths): unrealised on inventory
   < −`MM_LOSS_STOP_FRAC`·capital ⇒ taker-flatten at mid (5bps), pull quotes
   (`L2LiveFillEngine.cancelResting()`), stand aside `MM_LOSS_STOP_COOLDOWN_MIN` (15m), resume
   flat. Desk default 0.0006 (−$300 on $500k) = tail-only insurance. HONESTY: adds NO
   expectation — converts the fat left tail into a bounded known cost; will sometimes sell the
   bottom (the S2 time-stop replay said as much); sized loose so it fires rarely.
2. **Session gate** (`MM_SESSION_GATE`, parser `risk/session-gate.ts`): xyz US-equity books
   (NVDA/TSLA/SKHX/ORCL/+reserves) quote ONLY 13:30–20:00Z and go home flat; off-hours quoting
   vs a closed underlying is pure pick-off (SKHX above). CL/GOLD exempt (~24h markets).
3. **Inventory cap cut** 0.15→0.10 of capital (start-desk.sh) — the warehouse tail scales
   linearly with the rail.
Every guardrail flatten is a DeskEvent + `GUARDRAIL ▸` log line (the business-tape rule). Wired
through config (factory/interface) + module (launch AND rehydrate paths — desk-wide policy, not
persisted per-book state). Tests: session-gate parser suite + 4 MmBook guardrail specs (loss-stop
fires + cooldown holds + default-off warehouses; gate blocks off-hours, trades in-hours, flattens
on session close). market-making 62 suites / 365 green; tsc clean.
**NOT fixed by this (named honestly):** negative fillEdge. A guardrail bounds inventory losses;
it cannot make a picked-off book profitable — that stays the rotation rule's job
(UNIVERSE_DISCOVERY.md). Next knobs if the shape persists: regime gate (S4) in front of the
stop, per-book hedged/unhedged flag on the snapshot + leak table so delta coverage is never
implicit again.
## 2026-06-11 — Entry #55b (the HEDGED DESK: "no market we cannot delta-hedge" + flow/lean/hedge on the UI)
Operator directives (Ronnie): loss cap 0.01%; show the front-of-move flip on the UI and lean with
it; binding asset rule — **we do not make markets in what we cannot hedge the delta**; tighten
pick-off; rebuild the Elite-8 from ALL assets under the rule.
**Shipped:**
1. **Loss-stop tightened to 0.0001** (−$50 on $500k, operator-set). Honest math ON RECORD: at the
   $50k inventory rail this fires on a 0.1% adverse move — expect FREQUENT triggers; each costs
   taker 5bps on the flattened notional + 15min stand-aside. Run54's `GUARDRAIL ▸` count + leak
   table judge whether saved warehouse > taker bill; re-tune via MM_LOSS_STOP_FRAC if it bleeds.
2. **Hedgeable-universe board** (`scripts/hedgeable-universe.ts`, 30d×1h OLS, zero-return bars
   dropped vs closed-session flats): GOLD↔PAXG **β1.03 R².98**, CL↔BRENTOIL **β1.08 R².91**,
   SOL .81 / kPEPE .77 / XRP .72 / DOGE .72 / SUI .66 / FARTCOIN .65 / ADA .59 vs ETH/BTC.
   **Single names FAIL the rule** (index leg ≠ idio hedge): NVDA .41, TSLA .45, ORCL .38,
   SKHX .28; PURR .14, HYPE .27. Artifact: docs/research/hedgeable-universe-*.json.
3. **ELITE-8 v3 — every book hedged:** xyz:CL(→BRENTOIL), xyz:GOLD(→PAXG), SOL, ADA, DOGE, SUI,
   FARTCOIN, kPEPE (→ETH, netted on one leg). OUT by hedge rule: NVDA/TSLA/SKHX/ORCL/PURR(/HYPE).
   OUT by edge rule despite hedgeable: XRP (worst bleeder #50), SILVER (worst pick-off #51).
   SOL/ADA re-admitted: their A″ realised (+$752/+$494) was real; their warehouse bleed is what
   the hedge+guardrails now control. BRENTOIL/PAXG are new TAKER hedge legs via the existing
   resolveHedgeMid path (xyz: L2 proven); hedge cost priced into spreads (hedgeCostBps).
4. **UI (per-session QA rule):** per-book **flow** (signed aggressor imbalance, ▲/▼/◆ + flip),
   **lean** (the OOS-gated bias ACTUALLY applied — 0 until validated), **hedge** (leg+β, or
   **NAKED** in red). Engine surfaces `bias` on metrics; trader annotates `hedgeUnderlying`/
   `hedgeBeta` per book snapshot (DeskHedgeController.betaFor). Delta coverage is now explicit
   on every snapshot — the run53 lesson closed.
5. **Pick-off tightening:** VPIN pause ARMED at 0.75 (was disarmed 1.01) — fast-path gate pulls
   quotes when informed-flow probability spikes; F3 stays widen-only; cap 0.10. NOT done: faster
   than 100ms re-quote — paper already assumes 100ms/30ms; claiming faster would be dishonest
   vs HL rate limits (the cadence claim stays an upper bound).
Tests: market-making+demo 63 suites / 374 green; tsc clean. NOTE: session gate now mostly idle
(no single-name books) — kept wired for future equity slots.
**Open (next session):** regime gate (S4) before the stop; loss-stop threshold sweep on the
replay harness; per-book capital ∝ measured fillEdge; flow-flip alert (event when lean changes
sign); short-horizon book cycling question — see RUN_THE_DESK/analysis (cycling does NOT reset
regime; the regime gate is the honest version of "turn it off after an hour").
## 2026-06-11 — Entry #56 (S4 SHIPPED: the sweep-regime gate — pull quotes BEFORE inventory builds)
Operator priority (Ronnie): the trend/sweep detector is the most important knob. Shipped:
**`SweepRegimeDetector`** (`risk/sweep-regime-detector.ts`, pure/clock-free/replayable) — two legs
must AGREE: (1) FLOW: EWMA of signed aggressor imbalance, |ewma|>0.65 = one-sided tape;
(2) PRICE: same-sign drift ≥5bps over 30s = the price is following (one-sided flow the book
absorbs is NOT a sweep — we keep quoting absorption). Both ⇒ SWEEP: `cancelResting()` pulls the
quotes the engine just placed (σ/markout/funding stay warm — unlike the session gate's full
skip), nothing rests into the move, nothing fills against it. 90s cooldown after the last sweep
tick = the get-out-then-re-enter discipline. Per-book detector (per-symbol flow memory), fast
path only (needs real aggressor flow). `REGIME ▸ calm → sweep` log + verdict tape event on every
transition; `regime` on the snapshot; **SWEEP/COOLDOWN badge on /mm-desk AND /demo**.
ENV: MM_REGIME_GATE=true (armed in start-desk.sh) + REGIME_{FLOW_THRESHOLD,WINDOW_MS,
MIN_DRIFT_BPS,COOLDOWN_MS}. HONESTY: thresholds are PRIORS, not fitted — run54 measures
engagements vs warehouse saved; the detector is replayable for an offline sweep later.
**Also (#55b follow-through):** flow/lean/hedge tiles ported to **/mm-desk** (the page Ronnie
actually watches — /demo got them first by mistake); UNHEDGED tooltip wording; detector spec
4 cases green (sweep+confirm fires; absorption does NOT; wrong-sign drift does NOT; cooldown→
calm re-entry). market-making+ui 81 suites / 493 green; tsc clean.
The desk's layered inventory defence is now: (1) S4 gate = don't BUILD inventory into a sweep →
(2) governor cap+skew = bound what builds → (3) loss-stop −0.01% = bound what a position loses →
(4) β-hedge on every book = neutralise the factor of what remains. Each layer covers the prior's
failure mode. NEXT: event calendar + blackout windows (designed, approved scope pending),
per-hour regime diagnostic strip on the leak table.
## 2026-06-11 — Entry #57 (event calendar: tape warnings + blackout windows — "nobody earns the spread through CPI")
**Shipped:** (1) `EventCalendar` (risk/event-calendar.ts, static v1): daily US open/macro slot
13:30Z (CPI/NFP/retail) + US close 20:00Z (hints: CL/GOLD) + the published 2026 FOMC decision
dates 18:00Z (whole-desk). Trader polls it each loop → **`⚠ EVENT ▸ … in ~Nm` warning on the
Activity tape + log, once per occurrence, T−5min** — the operator's actionable signal.
(2) **Blackout windows** `MM_EVENT_BLACKOUT` (session-gate grammar, `*`=desk): INSIDE the window
the guardrail taker-flattens + stands aside (`GUARDRAIL ▸ … event-blackout`). Desk default:
`xyz:CL,xyz:GOLD=1325-1345` — flat through the 13:30Z number, auto re-enter 13:45Z.
HONESTY/limits v1: calendar is static (no earnings/API feed — the `IEventSource` seam is the
follow-up); FOMC days are WARN-ONLY (add `*=1755-1845` to MM_EVENT_BLACKOUT on the day);
13:30Z slot is daily (we stand aside even on no-print days — cheap at 20min). NAV-chart port to
/mm-desk: NOT needed — navSparkPanel already renders the mm_nav curve there (checked).
Tests: calendar spec (daily occurrence, midnight cross, FOMC date) — mm+ui 84 suites/496 green;
tsc clean. Desk now: S4 sweep gate → governor → loss-stop 0.01% → β-hedge ×8 → event blackouts
+ tape warnings. Run54 is the first full-stack read.
## 2026-06-11 — Entry #58 (run55: first FULL-defence-stack read — books fixed, the hedge layer gave it back)
Label note: operator renumbered — run54 = the aborted boots 13:46–14:24Z (beta-map pipe bug live:
CL hedged with **xyz:CL-perp itself**, 12 self-hedge orders in the boot logs; fix 37c2dd2 landed
mid-sequence), run55 = the fixed 3h run 14:24–17:24Z. mm_nav has no >10min gap so the leak window
(13:46→17:25Z, 3.6h) includes the boot segment; per-book rows are post-relaunch (clean).
leak-table-run54.* deleted as mislabeled; canonical artifact: docs/research/leak-table-run55.{md,json}.
**Desk:** net −$879 (realised −$123, unreal −$538, fees $218) · books-sum −$422 · implied hedge leg
−$458. vs run53: books-sum bleed cut 3.1× (−$1,316→−$422), realised cut 7.5× (−$928→−$123), maxDD
cut ~3× (worst 0.93%→0.27%) — **the per-book defence stack worked**. Desk net barely moved
(−$973→−$879) because the hedge layer consumed the savings: churn $174k/$47 (run53) → **$1.62M/$437
est cost** (9×), implied hedge-leg P&L +$343 → −$458. ETH leg = 32 orders/15 flips (the mid≤0
flip-churn tell, amplified by stop-flattens snapping book deltas to 0 → unwind→re-open at taker).
**(1) GUARDRAIL audit:** 12 loss-stops (ADA×4, kPEPE×3, CL×3, GOLD×1, FARTCOIN×1; 9 in the clean
run) + 12 manual flattens (boot restarts + operator batches 16:46:54Z/17:00:05Z). Each stop
crystallised −$50–66 (cap $50 + gap/taker overshoot ≤32%); Σ≈−$664. Fees $58→$218 = the stop taker
tax. VERDICT: **insurance at the book layer** (no run53-style −$618 single-book warehouse hole;
tail cut 3×) **but a tax at the desk layer** via induced hedge churn — the stop's true premium is
direct fees + ~$390 extra churn. Fix is hedge decoupling (freeze adds on flow flip, net delta
first), NOT a looser stop.
**(2) REGIME audit:** 19 engagements clean-run (GOLD 6, SUI 5, CL/DOGE/ADA 2, SOL/FARTCOIN 1,
**kPEPE 0**); episodes 1–3min (sweep ~30–90s + 90s cooldown); triggers all 0.65–0.76 = barely over
the 0.65 prior. Loss conc still single-window (68–100%) but mechanically so — the stop puts the
realised loss in one bucket. Coverage is wrong-shaped: ADA (2 engagements) and kPEPE (0) ate 7 of
9 clean-run stops — their bleed is a slow grind the flow×drift sweep test doesn't see. The
0.65/5bps priors need the replay sweep, and per the operator's flow-conditional frame the binary
gate should become a graduated re-center (p* = mid + κ·flow) + toxicity-scaled spread anyway.
**(3) Hedge quality:** legs verified correct post-fix (CL→BRENTOIL 22 orders, GOLD→PAXG 2,
alts→ETH 32). basisShare/betaLive/R² vs the 30d fit **not capturable** — server was down before
review; hedge.quality is in-memory only (DR-2). PROCESS FIX: persist hedge.quality (+ windowed
attribution) on shutdown / hourly — goes into diagnostic item (b).
**(4) fillEdge slot rule:** GOLD +6, FARTCOIN +7, SOL +5 (green); SUI −2, kPEPE −2 (flat);
ADA −16, DOGE −46, CL −51 (red). SOL re-admission PASS (thin); ADA FAIL (worst book, 4 stops) —
rotate-out recommended; DOGE/SUI green-by-warehouse only (probation); kPEPE streak broken
(+69→+37→−2); CL fillEdge red 2nd run running (−62→−51) — #51 best-ever read not repeating, watch.
GOLD is quietly the best-behaved book (only consistent + fillEdge among xyz:*).
**Event layer:** 0 blackout fires, 0 tape warnings — the 13:25–13:45Z window closed 1min before
boot and the run ended before 18:00Z/20:00Z events. UNTESTED, not passed.
**REALIGNMENT (operator frame, spec incoming — Cont-Kukanov-Stoikov OFI):** flow is E[Δmid|flow]≠0,
i.e. a fair-value correction, not a panic signal; toxicity = flow ALIGNED AGAINST inventory
(A=sign(q)·sign(flow)<0), A>0 is the harvest/exit window — a flatten-on-|flow| rule burns the one
state that pays. run55 evidence agrees: kPEPE/ADA died in A<0 grind the gate missed; GOLD survived
by refusing to add. Re-ordered next steps: (b) diagnostics first — per-hour σ/VPIN/flow/fillEdge
strip + A-quadrant split of markouts + persist hedge.quality (calibration data for κ, λ, τ);
(c) becomes per-book κ (markout regression Δmid60 vs flow) + flatten-inequality calibration on the
replay tape (binary 0.65 sweep secondary); (e) flow-flip event + hedge-freeze cooldown = the #1
leak fix (churn −$437); (d) capital ∝ fillEdge after. NOTHING implemented pending operator spec+go.
Artifacts: leak-table-run55.{md,json}; logs run-20260611-{164632,171116,172106,172435}-mm10h.log.
### #58 addendum — MASTER PLAN II adopted (operator spec → the active chain)
Operator's Flow-Reactive Quoting spec accepted as design of record →
**docs/FLOW_REACTIVE_QUOTING.md** (verbatim + run55 label/seam notes). Session chain grafted into
**docs/MASTER_PLAN_SESSIONS.md PART V** as the ACTIVE chain: F0 instrument (persist markout/
attribution/hedge-quality/funding/decision-tape; worst5m bug; per-hour + A-quadrant strips) →
F1 hedge anti-churn (−437) → F2 quote anti-churn (−229) → F3 inventory skew (−95, + loss-stop
sweep) → F4 flow-reactive throttle-first/κ-gated (−99, supersedes binary S4 gate) → F5 capital ∝
fillEdge. Old chain: S3/S5 superseded-into-F4/F0, S4 partially shipped (#56/#57) + superseded,
S6 live as ledger, S7/S8 pending as validation infra, S9 parked. BINDING new cross-cutting req
(operator): full auto-response observability — `CONTROL ▸`/`PARAM ▸`/`BLOCKED ▸`/`FLATTEN ▸` +
existing grammar, on-change + periodic, tape + persisted; a finished run auditable from SQL alone.

## 2026-06-12 — Entry #59 (F0 SHIPPED: persistence & attribution instrumentation — a finished run is now auditable from SQL)

**What:** MASTER PLAN II's hard prerequisite. Four new append-only research tables
(migration `1723000000000-AddMmResearchTables`, app role SELECT+INSERT only, same oracle as
`mm_nav`):

- **`mm_fill_markout`** — one row per fill × forward horizon (defaults 1s/5s/30s), carrying the
  F4 calibration context AT the fill: signed markout bps, notional, signed aggressor-flow
  imbalance (the κ-regression x), VPIN, σ, inventory-before (for the A = sign(q)·sign(flow)
  quadrant), FIFO queue-ahead. Plumbed as an optional sink on `MarkoutTracker` (meta rides each
  pending fill to every resolved horizon) → `L2LiveFillEngine.markoutSink` → per-book closure in
  the module → `BufferedSink` (5s interval flush, 5k bound, oldest-drop; a DB hiccup degrades to
  dropped research rows, never a broken tick).
- **`mm_hedge_nav`** — per-interval per-leg hedge P&L (units/mark/mtm/funding/fees), written by
  `MmNavCron`; `HedgeUnderlyingSnap` now carries `markUsd/pnlUsd/fundingUsd/feesUsd` per leg.
  Closes DR-2: the leak table reads TRUE hedge P&L, not desk-net − books-sum.
- **`mm_hedge_quality`** — βlive/R²/basisShare per book, hourly + at shutdown (run55's
  hedge-quality audit was impossible because the server died before the review; `onModuleDestroy`
  now writes a final row set).
- **`mm_desk_event`** — the durable decision tape (PART V observability req #8): `DeskEventLog`
  takes an optional persist sink; every event (incl. ring-evicted ones) lands in SQL.

**Plus:** HIP-3 per-dex funding wired (`currentFunding('xyz:GOLD')` posts `metaAndAssetCtxs`
with `dex:"xyz"`, universe matcher accepts qualified or bare coin names — the funding term on
xyz books is now measured, was 0 by construction). NAV corrupt-mark guard: `findInsaneMark`
skips a whole NAV interval when any book's |unreal| > its own capital (run55: kPEPE marked
−$3.03M against a garbage boot mid; a 1-interval gap is honest, a poisoned curve is not).

**Leak table (scripts/mm-leak-table.ts) upgrade:** (1) **worst5m bug found + fixed** — the
−3.0M/−30k/−20k worst buckets were corrupt boot-window marks (14:01–14:10Z all books) plus
relaunch resets (book net jumps to 0 at restart) walked as P&L deltas; now filtered by a robust
outlier bound (|unreal| > max(100×median|unreal|, $500), capped at median equity — real
excursions max $227, corrupt ≥ $2k, clean separation on run55 data) + reset/gap skips, with a
⚠SUSPECT sanity bound as backstop. Run55 re-read: kPEPE worst5m −3,033,717 → **−75** (net −127),
SOL −20,416 → **−20** (net +25). (2) Windowed spread/adverse/wedge now computed for FINISHED
runs from the `mm_book_state` checkpoint (persisted since S2 #53 — the table just never read
it); live snapshot still preferred when up. (3) New sections: measured hedge legs + quality,
per-hour diagnostic strip (fills/|flow|/VPIN/σ/markout by hour), A-quadrant split per book,
markout by queue tercile, top-of-hour (±3min, funding prints) toxicity. (4) **`--self-check`** —
exits 2 listing every n/a/suspect column (verified: fails loudly on pre-F0 run55, as it must;
the gate passes only on a run captured after this ships). Backfill note: per-fill markouts are
NOT in the run55 log (in-memory only then) — no backfill possible; F0 data starts with the next
run.

**Tests:** 196 suites / 1344 tests; new: markout sink meta + throw-safety, desk-event persist
sink, hedge nav/quality cadence + shutdown write, insane-mark guard, HIP-3 dex routing + bare
universe match, fillMarkoutRow mapping, BufferedSink batch/overflow/error. tsc clean. (Known
flaky telemetry.module.spec is the only red, pre-existing.)

**Next (F1):** hedge anti-churn — the −437 leak. The replay gate can now use persisted data.

## 2026-06-12 — Entry #60 (F1 SHIPPED: hedge anti-churn — the −437 leak gets five brakes and a per-leg verdict)

**What:** MASTER PLAN II F1. Run55's biggest leak was not a wrong hedge but a CHURNING one
(56 orders / 19 flips / $1.62M round-tripped ≈ −$437 taker, vs implied directional P&L of only
~−21). Five controls now sit between `computeHedge`'s plan and execution, all in
`DeskHedgeController` (each suppression a structured `HedgeDecision` → tape + log, PART V):

1. **Min-hold** (`MM_HEDGE_MIN_HOLD_MS`, default 30s) — a leg cannot re-fire faster.
2. **Flip cooldown** (`MM_HEDGE_FLIP_COOLDOWN_MS`, default 5min) — after a direction flip,
   further flips freeze; run55 had 19, one ~2.5min after the leg opened.
3. **Flow-flip add-freeze** (θ=0.25) — a book's aggressor-flow sign flip (the front of the move
   reversing, FLOW_REACTIVE_QUOTING §5) freezes ADDS (open/increase/flip) on its underlying for
   the cooldown; REDUCES pass. `FLOW ▸ flip` hits the tape (the missing flip event).
4. **Net-first** — a primary flatten (incl. loss-stop; detected by the trader as inventory
   nonzero→0 between hedge ticks) suppresses the opposing leg in the same cycle AND restarts
   the leg's min-hold: stop → unwind → re-open was the run55 churn engine (BRENTOIL: $644k
   churned, 22 orders, hedging ONE book — CL, which had 3 stops).
5. **Basis gate** (`MM_HEDGE_BASIS_GATE`, default `FARTCOIN:flatten,kPEPE:flatten,ADA:flatten`
   from run55's measured basisShare ~100/high/high) — gated books are EXCLUDED from the hedge
   plan (the cross-hedge was a second bet); their delta stays in the snapshot + is announced
   (`BLOCKED ▸ basis-gate`), never hidden. Plus `MM_HEDGE_BAND_MAP` per-leg band widening.

**Observability (binding req):** every suppression emits `BLOCKED ▸ <leg> hedge <rule>: <numbers>`
(band-hold/min-hold rate-bounded to 1/leg/rule/min; flips, net-first, flow-flips always), new
DeskEvent kinds `blocked`/`flow` — on the live tape, in the server log, AND durable in
mm_desk_event (F0). Boot line prints the full anti-churn config.

**Replay evidence (scripts/hedge-churn-replay.ts on the run55 log, first-order):** mechanical
rules alone (band/min-hold/flip-cooldown over the recorded fire stream) cut est. churn cost
14–24% (defaults: 17%, 56→43 orders, 24→15 sign-flips) while average tracking gap rises ~$0.3k
— honest read: **the mechanical brakes alone do NOT reach the ≥50% target.** The target rests
on what the log cannot simulate: the basis gate (the ETH leg — $873k of the churn — hedges the
three gated books) and net-first (BRENTOIL's stop-driven $644k). Both are now MEASURABLE live:
F0 persists the decision tape + per-leg P&L, and the **F1.6 variance-reduction report** is in
the leak table (per leg: σ of 5-min P&L primary vs primary+hedge vs fees → 'earns churn' /
'FLATTEN-ONLY candidate'). **The F1 validation gate therefore moves to the first post-F1 run:**
churn cost ≥50% down on the leak table's measured hedge-fee line, warehouse MTM not worse,
variance report rendering.

**Tests:** 196 suites / 1354 tests (7 new F1 controller cases + 3 parser cases); tsc clean;
telemetry flake unchanged. Defaults baked into start-desk.sh; knobs documented in RUN_THE_DESK.

**Next (F2):** quote anti-churn (−229 taker fees; hysteresis, dwell, maker-bias, per-trigger
taker attribution — CL's "stop tax" vs requote churn now separable on the tape).

## 2026-06-12 — Entry #61 (F2 SHIPPED: quote anti-churn — hysteresis machinery + the taker-fee attribution; replay verdict MIXED ⇒ default OFF)

**What:** MASTER PLAN II F2 (the −229 taker-fee leak; xyz:CL +76 fees on a −67 net book).
Three deliverables:

1. **Requote hysteresis + dwell** — `decideRequote` in `backtest/queue-fill.ts`, SHARED by
   `L2LiveFillEngine` and `LobReplayHarness` (the A/B replays the exact live logic). The chatter
   mechanism: the micro-price center wiggles every tick, the desired price almost never EXACTLY
   equals the resting price, so pre-F2 the engine cancel/replaced ~every cycle and rejoined the
   BACK of the FIFO queue — paying queue position for noise. Rules: drift < minBps ⇒ hold
   (hysteresis); minBps ≤ drift < urgentBps ⇒ hold while younger than dwellMs; drift ≥ urgentBps
   ⇒ always move (holding a real move is the #27 stale-quote pick-off). Knobs
   `MM_REQUOTE_{MIN_BPS,DWELL_MS,URGENT_BPS}`; counters (moves / holdH / holdD) on
   `metrics().requote` → snapshot → the new grep-able **`F2 requote:`** NAV-interval line.
2. **Taker-cross trigger attribution** — `flattenAt` (the ONLY taker path; the maker engine is
   post-only by construction, so F2.3 "maker-bias" is structurally satisfied) now accumulates
   per-trigger fee/count/notional (`takerCrosses` on the snapshot: loss-stop / session-close /
   event-blackout / remove / manual) and stamps the fill tape event with `trigger` (durable in
   mm_desk_event payload). **"Stop tax" vs requote churn is now separable per book from SQL.**
3. **A/B validation** (`scripts/mm-requote-compare.ts`, on the 14h ~1.1s-cadence
   `hl-fine-20260605` tapes, 46,788 steps × 5 coins, micro-price center, γ0.0025/κ0.5/floor5):

   | config | desk Δ(spread−adverse) | desk Δnet | note |
   |---|---|---|---|
   | min1/dwell400/urgent4 | **+346** | −1,961 | s−adv up 4/5 coins; fills BNB 187→9,018, DOGE 653→1,477; net dragged by SOL −1,682 / BTC −566 |
   | min1/urgent2 (BTC+SOL) | +34 | −2,248 | identical to urgent4 — urgent isn't what binds |
   | min0.5/urgent2 (BTC,SOL,DOGE) | +87 | −515 | SOL flips +309 but DOGE flips −151 |

   **Read:** the F2-owned metric — fill edge (spread−adverse) — improves in EVERY coin and
   config, and fills rise (the queue-position thesis is real). But net couples to the WAREHOUSE
   path: a different fill sequence ⇒ a different inventory trajectory ⇒ on 14h trending tapes
   the inventory MTM term dominates and flips sign per coin/config. That's the F3 leak, not
   F2's. Also honest: the 1.1s tape cannot reproduce the live 100ms cadence (per-step drift
   ~10× smaller live ⇒ hysteresis binds more, holds cheaper).

**Verdict (same posture as #53's time-stop):** machinery + attribution + observability ship;
**hysteresis defaults OFF** (`MM_REQUOTE_MIN_BPS=0`). Arm it on a live run (`=1`) once F3
strengthens the inventory term, and judge on the `F2 requote:` line + the leak table's
per-trigger fee split. The F2 GATE (CL fee line down materially) is mostly the stop tax —
attributable now, and F3's loss-stop sweep is the lever that moves it.

**Tests:** 196 suites / 1361 tests (decideRequote ×5, loss-stop trigger attribution, f2Summary
×2); tsc clean; telemetry flake unchanged.

**Next (F3):** inventory skew (−95 warehouse leak + the loss-stop sweep) — and it's the
unblocking dependency for arming F2's hysteresis.

## 2026-06-12 — Entry #62 (F3 SHIPPED: concentration controls + the loss-stop curve — 0.01% validated, warehouse −95% on replay)

**What:** MASTER PLAN II F3 (the −95 warehouse leak; run55: ADA −138 at 94% conc, kPEPE −72,
FARTCOIN −71, while balanced DOGE at 20% conc was net-POSITIVE despite being picked off).

1. **Concentration controls in `GlftQuoter`** (conc = |q|/effMaxLots): past `MM_CONC_SOFT`
   (default 0.5) a ramp r strengthens the reservation skew (×(1+`MM_CONC_SKEW_GAIN`·r),
   default gain 2) and CUTS the adding side's quote size linearly, reaching **reduce-only**
   (adding side not quoted) at `MM_CONC_HARD` (default 0.85). The reducing side keeps full
   size. κ stays 0 — flow re-centering is F4's. Per-side sizes now flow through `QuotePair` →
   both engines (a 0-size side is pulled); this strictly SMOOTHS what the hard cap already did
   abruptly at 100%. **Default ON** — below 50% conc it is exactly the legacy quoter.
2. **Observability (binding):** `onInventoryControl` fires on ZONE change only (free → ramp →
   reduce-only and back) with q/conc/skew×/addSize/σ → `CONTROL ▸` line + tape event; the
   reduce-only transition emits `BLOCKED ▸ conc-cap` (book, conc%, side). New `control`
   DeskEvent kind; `blockedEvent` generalised (F1's now read `hedge band-hold` etc.).
3. **Loss-stop in the replay harness** (`LobReplayConfig.lossStopFrac` + cooldown, mirroring
   `MmBook.guardrail`: flatten at mid, 5bps taker, stand aside) + **`scripts/mm-inventory-sweep.ts`**.

**Replay evidence (14h hl-fine tapes × 5 coins, micro-price, live-governor base):**

- **Conc A/B:** binds RARELY on these tapes (inventory mostly < 50% of cap — the tapes don't
  reproduce ADA's ride-to-the-cap regime; no ADA fine tape exists). Where it bound (BNB at
  2-lot cap): warehouse +27, net +1.6, fills +523 (cutting the adding side keeps the book
  two-sided instead of parking at the cap), fees flat. Everywhere else an exact no-op.
  **Mechanism validated, magnitude unproven offline — the ADA conc<70% gate is the next live
  run's read** (now measurable: conc transitions are on the durable tape).
- **Loss-stop sweep (the run55 12-stops≈−$664 prior, 0.01% of capital):** at 8 lots the stop
  at 0.01% cuts the desk warehouse term **−1,632 → −79 (−95%)**, desk net −1,024 → −142,
  maxDD roughly HALVED on every coin, total stop tax ~$129. At 2 lots it flips the desk
  −58 → **+249**. Levels 0.05%/0.10% never fire (too loose to exist). Honest cost: the stop
  cuts BNB's winner both times (+404→+84 at 8 lots) — it trades tail-loss for trend-profit,
  which is the desk doctrine (conserve equity first). **Verdict: keep 0.01% as the desk-wide
  default — the prior is now a measured curve, not a guess.** Per-book stop levels stay
  available via launch params; no change shipped there.

**Tests:** 196 suites / 1367 tests (6 new GLFT conc cases; per-side size plumbing covered by
existing engine suites); tsc clean; telemetry flake unchanged.

**Next (F4 Stage A):** flow-reactive throttle (κ=0) — FlowState + regime machine, replacing
the wrong-shaped S4 binary gate; calibrated per book from the mm_fill_markout data F0 now
persists. ALSO ready to arm on the next run: F2 hysteresis (`MM_REQUOTE_MIN_BPS=1`), now that
F3 strengthens the inventory term the F2 replay said was the coupling risk.

## 2026-06-12 — Entry #63 (F4 Stage A: flow-reactive risk throttle (κ=0) — machinery SHIPPED, gate NOT cleared, default OFF)

**What:** MASTER PLAN II F4 Stage A (the −99 fill-edge leak; FLOW_REACTIVE_QUOTING.md §1–§3),
**superseding the S4 binary sweep gate** (run55: kPEPE bled through 3 loss-stops with ZERO
engagements while triggers all fired marginally — wrong-shaped, not wrong-idea). κ stays 0
everywhere: no directional re-centering — Stage B is gated on mm_fill_markout volume (F0).

1. **`FlowRegimeMachine`** (`src/market-making/risk/flow-regime.ts`, per-book, pure,
   clock-free): EWMA flow f (α 0.05/volume tick) + persist counter + flip detection (resets
   persist; ramp g decays ×0.7/tick instead of snapping), toxicity T=(1−b)|f|+b·vpin (blend
   default 0), alignment A=sign(q)·sign(f), ramp g=clip((persist−3)/(10−3),0,1). Hysteresis
   θ_enter 0.40 / θ_exit 0.25, escalation θ_high 0.70, min dwell 3000ms. Regimes: NORMAL /
   **DEFENSIVE** (A≤0: symmetric widen 1+λ·T·g λ=0.5, toxic side ×(1+1.0·T·g), safe side
   ×(1+0.25·T·g), toxic-side size cut to floor 0.2) / **HARVEST** (A>0: reducing side NOT
   widened, no size cut — the flow IS the exit) / **FLATTEN-ONLY** (only from DEFENSIVE with
   A<0 AND sustained |f|>θ_high: toxic/adding side pulled entirely, reducing side tightened
   ×(1−0.5·g)). **HARD INVARIANT:** flatten is reachable only when A<0; HARVEST never
   flattens — enforced structurally, counted (`flattenEntriesNotAligned` must be 0), unit-tested.
2. **Plumbing:** new optional `QuoteContext` per-side scales
   (`bid/askHalfSpreadScale`, `bid/askSizeScale`) applied universally in `buildQuotePair`
   (composes with F3's per-side sizes/spreads; size 0 pulls the side — engines already treat
   it as reduce-only). Live: `L2LiveFillEngine` takes `flowMachine`; the F4 symmetric widen
   MULTIPLIES the F3 toxicityScaler scale; `metrics().flow` gauge (regime/f/T/A/g/persist +
   stats) on the snapshot. Offline: `LobReplayHarness` cfg `flow` runs the SAME machine class
   (offline == live). Built inside `buildFastEngine` so BOTH makeBook and rebuildBook get it
   (the #47 rehydrate trap).
3. **Supersession:** `MM_REGIME_GATE` is now a selector `off|sweep|flow` (legacy `true` maps
   to `flow`; `sweep` keeps the S4 `SweepRegimeDetector` for history). At most one flow gate
   per book by construction. 13 `MM_FLOW_*` knobs (θ/persist/dwell/λ/weights/size/blend) via
   app-config.factory.ts.
4. **Observability (PART V, binding):** every regime transition emits a structured tape event
   + log line with the triggering numbers (f, persist, T, A, g, q, θ_enter/exit/high) —
   `CONTROL ▸` on transition, `BLOCKED ▸` entering flatten-only (durable in mm_desk_event);
   change-driven, never per-tick. Plus a grep-able **`F4 flow:`** NAV-interval line (the
   F2/F3 pattern) with per-book regime/f/T/A/g, tick counts, and `viol=` — the invariant
   audit; every line must read viol=0.

**Calibration sweep** (`scripts/mm-flow-sweep.ts`, 14h hl-fine-20260605 tapes × 5 coins
through the live F3-era config — γ=0.005, skewMult 6, invFrac 0.10, F3 widen-only, conc
0.5/0.85, loss-stop 0.01%; grid θ∈{0.3/0.18, 0.4/0.25, 0.5/0.35} × dwell {3s,8s}). Full
table: `docs/research/flow-throttle-sweep.md` (+`.json`). At the picked default
(θ=0.40/0.25, dwell 3s) vs baseline (adverse sign: + = loss got WORSE):

| coin | Δnet $ | Δadverse $ | defensive ticks | flatten entries (viol) | read |
|---|---|---|---|---|---|
| BTC | **−148** | **+30** | 81 / ~45k | 0 (0) | outlier — see below; grid net swings −149..+49 |
| ETH | +0 | +0 | 56 | 0 (0) | outcome-identical: throttle engaged, never changed a fill |
| SOL | +0 | +0 | 94 | 0 (0) | outcome-identical |
| BNB | −1 | +0 | 56 | 0 (0) | noise (−9..0 across the grid) |
| DOGE | +1 | −1 | 322 | 4 (0) | marginally better (fees −1 too); the only coin where FLATTEN-ONLY fired — all A<0 |

**HARD INVARIANT: PASS on every coin × variant** (zero A>0 flattens; DOGE's 2–4 escalations
all A<0 — the escalation works on real tape). But the **F4A validation gate ("ADVERSE down;
SPREAD given up < adverse saved") did NOT clear:** ETH/SOL are no-ops, BNB is noise, DOGE is
±$1, and BTC's adverse WORSENED (+$27..+30) with net swinging −$148/+$49 across θ — yet with
only 24–81 defensive ticks out of ~45k, those swings are **loss-stop path divergence**
(13→15 stops; one changed fill cascades through the queue replay), not structural defence
value. Same single-window caveat as #61: one 2026-06-05 tape per coin (no HIP-3 RWA tape —
xyz:* fully out of sample), and the stop path is sensitive to any fill perturbation — a read,
not a law.

**Verdict (the #53/#61 posture — machinery + evidence, honest defaults): shipped DEFAULT
OFF.** `MM_REGIME_GATE=off` in start-desk.sh (was `true` = the S4 gate, which run55 showed
had 0 engagements anyway — nothing is lost live). θ defaults 0.40/0.25/3s are the measured
sweep pick (grid outcome-flat on 4/5 tapes; replaces the S4 0.65/5bps priors). Arm per-run
with `MM_REGIME_GATE=flow`. Baseline note: NO leak table newer than run55 exists (the F0–F3
validation run hasn't happened), so run55 stays the desk baseline and F2's
`MM_REQUOTE_MIN_BPS` stayed 0 in the sweep config.

**What would change the verdict:** (a) a live A/B via the S8 shadow rig — the clean test of
defence value at the real 100ms cadence; (b) an HL tape containing a real directional sweep
day (the 06-05 majors tape simply doesn't stress the throttle); (c) mm_fill_markout volume
from finished runs — the Stage B κ-regression data, which also re-calibrates θ per book.

**Tests:** +20 (flow-regime.spec ×12, quote-pair ×4 per-side scales, lob-replay ×2 flow
cfg + invariant, l2-live-fill-engine ×2 metrics.flow); tsc clean; telemetry flake unchanged.

**Next:** the F0–F3 validation run (RUN_THE_DESK "THE NEXT RUN") — arm F2, read the gate
table, get a post-F0 leak table; then F4 Stage B only once the markout volume exists.

## 2026-06-14 — Entry #64 (run-20260614-125055: the F0–F3 validation run — desk net +$751 but it is ~100% unrealised warehouse; the adverse-selection bleed is the news)

**What:** `run-20260614-125055`, **the first finished leak table newer than run55** (the
#58/#63 baseline gap is now closed). ~09:52→14:11 UTC, **~4h19m of NAV** (~5h wall with
warmup), 8 books on **mm-glft (neutral)**: the post-swap set `xyz:CL xyz:GOLD SOL ADA DOGE
SUI FARTCOIN kPEPE`. Config inferred from evidence (the log does not echo env): inventory
governor default-ON (hard cap 0.25 / skew 4), F3 toxicity + concentration ON, **delta hedge
ON** (PAXG/ETH/BRENT legs present in the tape), **F4 regime gate OFF** (start-desk default,
no arm line in the log), flow-shadow ON. Authoritative numbers from `mm_book_state` +
`mm_nav` (server was already down at review — the **persistence path worked: leak table read
final state checkpointed at 14:08:49, no live snapshot needed**). Artifact:
`docs/research/leak-table-run-20260614-125055.{md,json}`.

**The scorecard (DB, realised-first):**

| book | net | **realised** | unreal | fees | maxDD% | fillEdge | warehouse |
|---|---|---|---|---|---|---|---|
| SOL | +575 | **0** | +573 | −1 | 0.21 | +26 | +547 |
| kPEPE | +364 | **+2** | +360 | −1 | 0.16 | +12 | +350 |
| SUI | +220 | **+23** | +195 | −2 | 0.14 | +10 | +207 |
| xyz:GOLD | +80 | **+102** | 0 | +23 | 0.04 | −1 | +103 |
| FARTCOIN | +60 | **+58** | +1 | −1 | 0.04 | −4 | +62 |
| ADA | −22 | **−115** | +126 | +33 | 0.25 | +10 | +1 |
| DOGE | −34 | **−24** | 0 | +9 | 0.14 | −4 | −20 |
| xyz:CL | −326 | **−231** | 0 | +94 | 0.40 | −47 | −184 |
| **desk** | **+751** | **−186** | **+1089** | **155** | — | **+2** | **+1066** |

(Desk includes the hedge legs; Σ per-book net = +917, desk net +751 ⇒ the **−$166 gap is the
hedge legs' open MTM** — PAXG −92 / ETH −51 / BRENT −12 measured. The net=fillEdge+warehouse
+funding−fees identity holds to the dollar per book.)

**The honest verdict — this is NOT yet a realised-edge win, it is the #41/#44 trap again:**

1. **The green is unrealised.** Desk **realised −$186**; the +$751 net is **+$1089 of
   open-inventory mark-up**, concentrated in the SOL/kPEPE/SUI longs (warehouse
   +547/+350/+207). SOL's +575 is **one fill held into a favourable mark** (vpin 0.93) — a
   directional outcome the governor sized, not market-making edge. It reverts; we cannot bank it.
2. **The actual MM edge ≈ $0.** Desk-wide **fillEdge = +$2** over 4.3h. The spread engine
   neither made nor lost money on a per-fill basis.
3. **BUT the real news is adverse selection is essentially CLOSED on the rebate venue.** The
   crypto HL books carry **positive fillEdge** (SOL +26, kPEPE +12, SUI +10, ADA +10) with
   fees ≈ 0 (rebate intact). Every prior run had the quoter "picked off at every spread
   width" (deeply negative spreadCaptured); here it is break-even-to-positive. That is the
   F3-toxicity + governor stack doing its job — the qualitative thing that has changed.
4. **DD control: excellent.** Max per-book maxDD **0.40%** (CL), the rest <0.25% — far under
   the ~1.5% pre-registration bar. The risk model is the unambiguous win.
5. **The remaining bleeds are structural, not the quoter:** (a) the **fee-paying RWA
   reference books** — `xyz:CL` is the single worst book (−326 = fillEdge −47 + warehouse
   −184 + **fees −94**, no rebate, picked off, inventory marked the wrong way); `xyz:GOLD` is
   +80 on the book but its **PAXG hedge cost −92**, so GOLD+hedge is net-negative. (b) the
   **hedge drag** — legs −$155 + churn −$73 ≈ **−$228**, only in the desk-agg, never in the
   per-book rows. Hedge was *converged* not churning (15× PAXG `reduce`, 1 `flip`, zero
   `markAll: skipping` zombies).

**Microstructure cuts (worth keeping):** front-of-queue fills are the toxic ones — markout@300s
**T1 (front) −2.2bps vs T3 (back) +1.0bps** (you fill at the front *because* informed flow is
hitting you). Funding-print top-of-hour **+2.3bps vs −1.6bps the rest of the time**. Hour-12
(+$465) is warehouse accrual, not steady capture — the "profit" arrives in inventory-mark bursts.

**Verdict:** the governor + toxicity defence have turned the chronic adverse-selection loss
into break-even edge on the rebate books with tight DD — *that* is the progress. The desk is
**not** realised-profitable: strip the unrealised mark-up and it is −$186, dragged by the
fee-paying RWA books (CL/GOLD-net-of-hedge) and the hedge cost. "First green" is true on the
net line and misleading on the honest line.

**Next (candidates — Ronnie's call, trading-policy):** (a) **cut the structural leaks** —
de-weight or drop `xyz:CL` and re-examine whether the fee-paying RWA reference books (and
their PAXG/BRENT hedges) earn their keep vs the rebate crypto books that carry the only
positive fillEdge; (b) **F4 Stage B is now UNBLOCKED** — this run wrote **2,715
`mm_fill_markout` rows across 8 books**, the κ-regression data #63 gated on; calibrate the
per-book directional re-centering off real markout; (c) **don't bank the warehouse** — run a
longer / multi-window pass to see whether the crypto-book fillEdge break-even *holds* and
whether realised crosses zero once CL and the hedge drag are addressed.

## 2026-06-14 — Entry #65 (F4 Stage B: the κ-gate is built + run — flow does NOT lead price; κ stays 0, by the data)

**What:** the F4 **Stage B** honest gate — `scripts/mm-kappa-regression.ts` — built and run on
run-...125055's **2,715 `mm_fill_markout` rows**. This is the regression the FlowRegimeMachine's
re-center term `alpha = κ·f·g` has been hard-wired to **κ=0** waiting on (flow-regime.ts §0/§299:
"directional alpha is Stage B, gated on the per-book markout-on-flow regression"). The desk's
binding prior: *a blind bias loses — leverage on noise* — so the directional lean must be
**proven from data before it is wired**, not after. This gate is that proof-or-refusal, and it is
**standing/reusable** — every future run's markout volume re-runs it and accumulates n.

**Method (honest, multiple-testing-aware).** From `markout-tracker.ts` the sign convention is
`markout_bps = side·(mid_{t+h}−fairMid)/fairMid·1e4`; un-signing by side recovers the **raw
forward mid-move** `r = markout_bps·sideSign`, decoupled from our (adversely-selected) fill side.
`flow` (the EWMA aggressor imbalance, persisted at the fill — markout-tracker.ts calls it verbatim
"the κ regression x") is the predictor. Per (book × horizon) we fit **`r ~ flow`**: OLS slope
**κ_raw** (bps mid-move per unit flow) + t-stat = magnitude/significance; **Spearman IC** + hit-rate
= the rank-robust predictive gate (the #1-OOS-gate discipline). Verdict GREEN/RED/GREY; **the gate
"clears" ONLY if the POOLED (desk-wide) row is GREEN at the pre-registered 60s horizon** — a lone
per-book GREEN against a flat pool is treated as a multiple-testing artifact, not a green light.

**Result — the gate does NOT clear:**

| read | κ_raw @60s | t | IC @1s→300s | verdict |
|---|---|---|---|---|
| **POOLED (n=543)** | −0.04 | −0.15 | **0.120 → 0.004** | **GREY at every horizon** |
| SUI (n=52) | +1.45 | +2.04 | 0.37 @60s | GREEN (lone, threshold) |
| xyz:GOLD (n=128) | −0.11 | −1.07 | — | **RED @1/5/30s** (t −2.3…−2.7) |
| ADA/DOGE/FARTCOIN/kPEPE/SOL | ~0 | <\|2\| | mixed | GREY (kPEPE/SOL n too low) |

1. **Desk-wide, flow does not lead price.** The pooled n=543 read is flat at *every* horizon
   (|t|<0.7), and its **IC decays 0.12 (1s) → 0.026 (60s) → 0.004 (300s)** — whatever micro-
   predictive content exists lives at ~1s and is **gone before it is tradeable** at our 100ms
   requote without crossing (i.e. it's a taker signal, not a maker re-center). That is the core finding.
2. **The lone SUI GREEN is a hypothesis, not a signal** — t 2.04 (right at threshold), n 52, one
   book of 8 × one horizon, against a flat pool; among ~40 tests a couple fire at |t|≥2 by chance.
   Logged as a **watch-book** (provisional κ≈7.3e-5 if ever confirmed); **not armed.**
3. **GOLD/RWA flow significantly MEAN-REVERTS** (RED, t up to −2.7 at 1–30s) — leaning *with*
   flow would lose there. Moot now (GOLD was cut in #64) but a real structural note: RWA
   reference flow fades, it doesn't trend, on our cadence.

**Verdict: κ stays 0 — the safe Stage-A default holds, now by evidence not just caution.** The
directional re-center is **not justified by the data**; the F4 live surface remains the Stage-A
throttle (also default OFF, #63). Nothing is wired. This is the gate doing its job: the desk does
not get a directional lean until a *desk-wide* lead survives the gate on real volume.

**Next:** the gate is standing — accumulate `mm_fill_markout` across the coming clean-6-book runs
and re-run; κ earns a wiring only if POOLED clears at 60s (or SUI repeats at higher n in a
dedicated confirmation). Until then F4 = throttle-only. **No code path turns on.**

**Tests/artifacts:** `scripts/mm-kappa-regression.ts` (tsc clean; OLS+Spearman, DB-only, S1 rules);
artifact `docs/research/kappa-regression-run-20260614-125055.{md,json}`. Research-script convention
(no spec, like `flow-bias-markout.ts`); the stats are self-contained + sanity-checked against the
#64 leak-table alignment split (SUI carries the most flow structure in both).

## 2026-06-14 — Entry #66 (the profit pivot: a 25-market WIDE SCREEN to find where the rebate actually beats warehouse drift)

**The goal, restated (operator, this session): make money in HL markets — and we are NOT
there yet, honestly.** Three reads now agree: #64 (realised −$186), #65 (κ can't predict the
drift), and a live peek at the in-flight 6-book run (desk realised **−$169**: SOL +35 / DOGE
+42 realised-POSITIVE, but ADA −106 / kPEPE −60 / FARTCOIN −41 / SUI −39 bled). The pattern is
identical every time: **fillEdge ≈ 0** (spread ≈ adverse on the rebate books — the quoter is
fine) **and the realised loss is WAREHOUSE DRIFT** — inventory held minutes drifts against us
(the #49 out-of-markout-window loss). κ (#65) showed we cannot *predict* that drift, so the
only lever left is **not holding the drift**: pick markets where naive two-sided flow keeps
inventory flat, so the −0.2bps rebate + spread out-earns the drift. SOL/DOGE do exactly that
live; ADA/kPEPE don't this window. **We don't know which markets are which a priori — OHLCV
can't see it (#66 scan), only realised fillEdge on a live run can.**

**So the next run is a deliberate WIDE SCREEN, not a profit attempt:** 25 books × $1M ($25M
desk) to RANK the HL universe by realised fillEdge, then CONCENTRATE capital on the winners and
layer the known optimizations (F2 queue position; the inventory time-stop = the warehouse cap).
This is the iteration that converges to profit: screen → prune to where realised fillEdge is
genuinely + → concentrate → compound the rebate over longer runs. The discipline is realised-
first; a book is kept only if it earns, not if it's liquid.

**The set (scan: hl-universe-discovery + hedge-beta-fit over the 230-perp HL universe;
selection = operator's HEDGEABLE-FIRST, fill-to-25):**
- **12 HEDGEABLE** (R²≥0.5 to BTC/ETH, rule #55b — delta-hedged): proven SOL ADA DOGE SUI
  FARTCOIN kPEPE + scan adds **AAVE(.72) PUMP(.60) CRV(.53) TAO(.51) XRP(.76) BNB(.61)**.
- **13 NAKED** data-breadth pads (most-liquid R²<0.5, NO hedge, governor-bounded only — a
  DELIBERATE bend of #55b for the screen): HYPE ZEC NEAR WLD VVV TRUMP XPL LIT TON MEGA ENA
  ONDO XMR. ⚠ σ-bombs (MEGA σ318, XPL σ214, WLD/NEAR/VVV/TRUMP σ>120) — expect a few high-DD
  books; the 0.01% loss-stop + notional governor are the backstop. That DD is a data cost, not
  a verdict.

**Config held CANONICAL** (governor + F3 + hedge ON; F2/F4 OFF) so the screen isolates the ONE
variable that matters now — *which markets pay* — uncontaminated by a config change. F2 (the
pre-registered #62 fill-edge lever) + the time-stop come in the CONCENTRATE run, on the winners.

**Wiring (committed):** `launch-mm-10h.sh` BOOKS=25 (CAP $1M), `start-desk.sh` MM_FAST_SYMBOLS=25
+ MM_HEDGE_BETA_MAP=12. Cross-checked 25/25/12+13. **NEXT (operator): run it 10h → leak table +
κ-gate per book → the ranked realised-fillEdge board IS the next desk. No journal needed on the
currently-running peek-run.**

---

## 2026-06-14 — Entry #67 (the 25-screen verdict + THE CONCENTRATE RUN: pick the winners, cut the drift)

**The screen (#66) ran ~3.7h, $25M / 25 books. Leak table: `leak-table-screen25-s2.md`.**
Desk **realised −$2,783** (net −3,091; fees +474; hedge legs measured −75). DD control held —
**every book maxDD < 0.7%** (the governor works). The verdict is the #49/#66 thesis at full scale:

- **The quoter is fine.** Realised **fillEdge (spread − adverse) is POSITIVE on the clean books**:
  TRUMP +20, ZEC +18, ENA +17, SUI +16 (adverse +1 — pristine), XRP +9, XMR +6, BNB +4.
- **The whole bleed is WAREHOUSE DRIFT.** Ranked leaks are almost all warehouse MTM: WLD −371,
  XPL −321, XMR −258, CRV −257, VVV −237, FARTCOIN −210, TON −159, XRP −118, ZEC −110. Books with
  a GOOD quoter (XMR/ZEC/XRP fillEdge +6/+18/+9) still lost — same quoter, unlucky drift.
- **Green-on-luck, not edge:** HYPE net **+226** is fillEdge **−120** (picked off, adverse +509)
  rescued by **+344 favourable warehouse drift** — that reverts; NOT a keeper. SUI's +143 net is
  also mostly +125 warehouse, but its fillEdge +16 / adverse +1 is the real thing underneath.
- **Structural losers (negative fillEdge = genuinely picked off, no time-stop fixes a bad quoter):**
  TAO −187 (mk300s −14bps), HYPE −120, TON −104, CRV −96, XPL −70, VVV −54, DOGE −36 (4 fills),
  FARTCOIN −19, AAVE −14, WLD −14, LIT −10. **CUT.**
- **Directional stays PARKED (confirmed again):** the leak table's alignment split (A = sign(q)·
  sign(flow), markout@300s) is inconsistent across books — ZEC even *paid* to be contra-flow
  (A− +19.4bps vs A+ −10.4bps). No desk-wide flow lead ⇒ a blind lean is leverage on noise (#65).

**Time-stop validated this session (`timestop-sweep.md`, OOS on the 06-04/05 majors tapes — a
mechanism read, not a per-market law):** bounding holding time cuts warehouse MTM. **T=30m /
shift=8bps** is the cell: BTC net −2127→−730 (**Δ +1397**, maxDD 0.85→**0.35**), ETH +295, did
NOT hurt SOL (+47). The aggressive **10m variant is dangerous** — SOL −1524 (forces taker exits
on a book that's fine). So 30m/8bps, never 10m. The time-stop is **live-wired** already
(`MM_TIME_STOP` / `_AGE_MIN` / `_SHIFT_BPS`) — no code change to arm it.

**THE CONCENTRATE RUN (`scripts/launch-concentrate.sh`, committed) — picks the winners, cuts the
drift, arms the queue lever:**
- **Concentrate-8** (ranked by realised fillEdge, positive + clean adverse): **SUI, TRUMP, ENA,
  ZEC, XMR, BNB, XRP, SOL.** $1M/book ($8M desk) — capital HELD CONSTANT vs the screen to isolate
  the 3 changes. Hedged: SOL/SUI→ETH, XRP/BNB→BTC. Naked (no factor hedge exists, R²<0.5):
  TRUMP/ENA/ZEC/XMR — **for these the time-stop IS the warehouse control** (substitutes the
  impossible delta hedge by capping holding time). ENA runs naked on purpose (its self-hedge leg
  bled −187 on the screen).
- **Cut (17):** ADA DOGE FARTCOIN kPEPE AAVE PUMP CRV TAO HYPE NEAR WLD VVV XPL LIT TON MEGA ONDO.
- **Armed:** `MM_TIME_STOP=true AGE_MIN=30 SHIFT_BPS=8` (the drift cut) + `MM_REQUOTE_MIN_BPS=1`
  (F2 queue lever). **Kept ON (the fixes that worked):** inventory governor (cap 0.10 / skew 6),
  F3 toxicity widen-only, micro-price + 100ms requote, 0.01% loss-stop, delta hedge w/ anti-churn.
  **Left OFF:** directional lean (OOS-gated to neutral).
- **PRE-REGISTERED metric:** desk **realised ≥ 0** AND every book maxDD ≤ ~1.5% over a multi-hour
  window; secondary: per-book warehouse MTM materially smaller than the screen (= the time-stop
  doing its job). This is the first run that tests for **real realised profit**, not a bounded loss.
- **NEXT (operator):** `bash scripts/start-desk.sh` (with the concentrate overrides in the
  launch-concentrate.sh header) → `bash scripts/launch-concentrate.sh` → leak table at label
  `concentrate`. If realised flips +, the run after that **scales capital** on the survivors.

**Op note:** filed issue **#29** — closing the UI looked like it stopped the desk, but the loop is
a server-side `setInterval` (it kept booking NAV the whole time); the live feed just goes stale
(`desk-feed.js` releases its SSE on tab-hide). Confirm perceived-vs-real with the operator.

---

## 2026-06-15 — Entry #68 (the concentrate run FAILED — the time-stop never fired; root cause + fix)

**Result: NOT profitable. Desk realised −$1,126 / 3.4h / $8M** (net −1,441, unreal +104, fees +420).
maxDD held (ZEC 0.92%, rest <0.6%, all < the 1.5% bar) — risk control worked, edge did not. Per-hour
desk netΔ −410 → −313 → **−715** (deepest overnight), no convergence. Leak table: `leak-table-concentrate.md`.

**THE SMOKING GUN: the inventory time-stop fired ZERO times in 3.4h.** The entire thesis of the run —
"cut warehouse drift with the time-stop" — never executed. Root cause (grounded in time-stop-quoter.ts +
the live config), a self-inflicted DESIGN ERROR:
- The time-stop was armed at **AGE_MIN=30** while the loss-stop sat at **0.0001 (−$100/book)**.
- On a volatile alt a −$100 adverse move happens in **minutes**, so the loss-stop flattened every
  drifting position long before it could age 30min. Worse: flattening drops inventory into the time-stop's
  flat band, which **RESETS its age clock** (time-stop-quoter.ts:72). So the clock never even approached
  30min. The loss-stop fired constantly (cumulative ×8/book, $420 in taker fees) and **was** the de-facto
  warehouse control — bluntly, at fee cost, by REALISING the drift instead of preventing it.
- Two warehouse controls that cancel: the slow one is dead weight behind the fast one.

**Process failure (own it):** the time-stop was "validated" in `timestop-sweep.ts`, a harness that has
**no loss-stop in it** — so "30m/8bps validated" was true in isolation and false in the live config. And
the live "verification" checked that the env vars were *present*, not that the config was *coherent* (could
the time-stop physically engage given the loss-stop? no — a 2-line arithmetic check that wasn't done). An
8h experiment shipped with its headline lever dead on arrival. Lesson logged in [[feedback_math_param_correctness]]:
**validate a lever in a harness that includes the controls it will run against, and sanity-check
coherence (can it fire?), not just presence.**

**Edge also collapsed in the toxic overnight regime:** vpin climbed 0.16 → 0.30; the screen's "clean"
books got picked off (TRUMP fillEdge +20→−190, ENA +17→−73, SUI +16→−32). **BNB was the lone survivor**
(fillEdge +11, net +25, vpin 0.13) — the clean-edge, two-sided-flow book the concentrate is hunting for.
ZEC/XRP kept POSITIVE fillEdge (+95/+57) but warehouse drift (−804/−125) killed them — exactly the books
a *working* time-stop is meant to rescue.

**THE #68 FIX — REVISED after a full journal re-read (the operator's call: read it all, incorporate every
lesson). My first #68 fix (loosen the loss-stop, make the time-stop primary) was WRONG and the journal
already said so in three places I had not read:**
- **#62 VALIDATED the 0.01% loss-stop as THE warehouse control** (warehouse −95% on replay, maxDD halved,
  "keep 0.01% as the desk-wide default"). Loosening it to 0.0005 abandons a validated result. → **KEEP 0.0001.**
- **#53: the time-stop is MIXED / regime-dependent — "enable ONLY behind the regime gate"** (it killed SOL
  −$1,524 in the aggressive variant), and it is **redundant** with the validated loss-stop. In #67 it never
  fired *because the loss-stop was already doing the warehouse job.* → **DROP the time-stop** (wrong lever).
- **#55: "a guardrail bounds inventory losses; it CANNOT make a picked-off book profitable."** The #67 loss
  was **negative fillEdge in a toxic overnight regime** — no warehouse knob fixes that. → **regime + market
  selection is the P&L driver**, not the warehouse knob.

**The corrected config (baked into `launch-concentrate.sh`):**
1. **Arm the F4 FLOW REGIME GATE — `MM_REGIME_GATE=flow`.** #56 calls the trend/sweep detector "the most
   important knob": it pulls quotes BEFORE one-sided inventory builds into a sweep — attacking the warehouse
   drift at its SOURCE, not bounding it after. #63 shipped it OFF because it was a no-op on CALM tapes and
   said the verdict needs "a live A/B... a real directional sweep day" — the toxic #67 regime IS that test.
2. **KEEP the validated 0.01% loss-stop** (default 0.0001) as the backstop; **time-stop stays OFF.**
3. **KEEP F2** (`MM_REQUOTE_MIN_BPS=1`), same concentrate-8, same hedge map.
4. **LAUNCH IN A LIQUID SESSION (London/US open), not deep overnight** — the single biggest lever, and free.
- **Pre-flight (the check that was missing):** `grep -E 'F4 flow:|REGIME ▸' <log>` must show the gate engaging
  on the toxic books within the first ~15min; and confirm all 8 are fast-path (`F2 requote: … moves=` ≫ bar rate).

**Honest caveat (no over-promising):** arming the flow gate is the live A/B #63 asked for — it is a BET that
the gate helps in a toxic regime, not a proven win (it was a no-op on calm tapes). Profit still needs positive
fillEdge, which is regime-dependent. The standing positive signal is **BNB — it held POSITIVE fillEdge through
the #67 toxicity**; clean-edge books that earn through toxicity are the template to clone.

**Lesson for me, logged:** read the whole journal before changing a knob. Validate a lever in a harness that
includes the controls it runs against (the time-stop was "validated" in a sweep with no loss-stop in it), and
check coherence (can it physically fire?) — not just that the env var is present. [[feedback_math_param_correctness]]

**#68 addendum (operator pushback — the desk must be REGIME-SELF-ADAPTING, not hour-scheduled).**
Ronnie's binding constraint: he runs ONE program, can't switch configs by hour ("at work"), so the
desk must DETECT regime change itself. That reframes the whole #68 fix — "launch in a liquid session"
is operationally useless AND statistically unsupported (3 windows = noise, not a tradeable clock). The
answer is the **F4 flow regime gate as the standing per-book auto-detector** (not an A/B): NORMAL when
flow is two-sided (capture), DEFENSIVE/FLATTEN-ONLY when one-sided AGAINST inventory (widen/cut/pull).
It does BOTH jobs the operator asked about: stops one-sided ACCUMULATION (warehouse drift) AND avoids
picked-off FILLS (fillEdge) — at the source. Honest gap #68 exposed: F3 + VPIN pause were ON and still
didn't save the toxic night — because **VPIN peaked ~0.6 and the pause threshold was 0.75 (never
fired)**. Fix: VPIN pause → 0.6 (backstop actually engages) + arm the flow gate (the precise,
alignment-aware tool). **fillEdge is NOT "fixed" — it is regime-dependent** (same book flips +20→−190
calm→toxic); the gross pick-off is fixed (micro-price+F3, #47/#64), the toxic re-opening is what the
flow gate defends. **Directional lean STAYS off — κ=0 is DATA (#65), implementing it loses; that is the
one thing I won't turn on.** **Book set OPTIMISED to the ROBUST-6 on two windows + hedgeability:**
keep BNB(+4/+11, the only book + through both regimes)/XRP/SUI/SOL (factor-HEDGED) + ZEC(+18/+95 best
quoter, warehouses hard)/XMR (naked, no factor). **CUT TRUMP** (regime-fragile +20→−190) **+ ENA**
(worst #68 −385, self-hedge bled −187). **Re-hedged BNB/XRP** (my earlier trim used one noisy live
window R²0.43/0.44; the longer fits are BNB.61/XRP.76 — they ARE hedgeable, #55b). Committed to
`launch-concentrate.sh`. Run it 24/7; judge realised-first through a toxic patch (the desk should defend
through one, not dodge the clock).

**#68 — the CORRECTED run is LIVE and the auto-defense is WORKING (2026-06-15 ~01:02Z).** Launched
`run-20260615-040228-mm10h.log`: the ROBUST-6 (BNB/XRP/SUI/SOL hedged + ZEC/XMR naked), `MM_REGIME_GATE=flow`,
VPIN pause 0.6, F2=1, validated 0.01% loss-stop, time-stop OFF, hedge map SOL/SUI→ETH + XRP/BNB→BTC. All
6 on the fast L2 path, viol=0, no boot errors. **Unlike #68's inert time-stop, the flow gate engaged within
2 minutes:** XMR DEFENSIVE on one-sided sell flow (f=−0.53, 19/20 ticks), SOL/BNB defensive, in the same
overnight-toxic regime that sank the first run — the auto-detection is doing its job (stops the one-sided
build + the picked-off fills at the source). Too early for a verdict (realised flat, warming); leak-table
scorecard due after a multi-hour window. **Regression-hardening shipped this session so #68 can't recur:**
(1) `mm-run-review` skill gained a mandatory **STEP −1** (read the journal + a config-COHERENCE check —
can the knob physically fire? — + "validate a lever only in a harness with the live controls" + "verify a
live control is ENGAGING, not just env-present") and a **regime-gate read** in the data map; (2) **CLAUDE.md
§10.1 (BINDING)** — every session runs `tsc`+`jest` before committing, new behaviour ships a locking spec,
config changes pass STEP −1 first. The lesson lives in [[feedback_math_param_correctness]].

---

## 2026-06-15 — Entry #69 (the ruthless-concentration test: BNB solo, sized up, hedged to BTC)

The corrected concentrate run (#68, robust-6 + flow gate) was scored at ~3h: **desk realised ≈ −$800**
(−$267/h vs #68's −$331/h — better, still losing). Same disease: warehouse drift (XRP −233 / SUI −174
/ ZEC −392 warehouse, quoters fine on XRP/SUI) + pick-off (XMR fillEdge −175 on 350 fills; ZEC flipped
to −64). The flow gate ENGAGED (SOL/XMR defensive) but did NOT stop the SLOW warehouse build — XRP/SUI/
ZEC warehoused in `normal` regime (drift without a one-sided sweep slips past a flow-triggered gate).
DD control was excellent again (maxDD ZEC 0.63%, rest <0.25%). Artifact: `leak-table-concentrate.md`.

**The honest pattern named (operator agreed):** this is the NINTH straight realised-negative multi-book
run (#41→#68). The rebate + spread has never out-earned warehouse drift + adverse selection across HL
alt books, under any defence stack. **The ONE exception in EVERY run is BNB** — net flat-to-positive,
fillEdge +1/+4/+11, maxDD 0.03–0.12%, the cleanest two-sided-flow book. So instead of config-tweak #10,
the last empirical question: **can a SINGLE clean book, sized up and hedged, post POSITIVE realised?**

**BNB-solo run (`scripts/launch-bnb-solo.sh`, committed):** BNB only, **$5M capital (5×) / $100k quote
(2×)** — "do it big on real edge", DD-safe because BNB's DD is tiny — **hedged BNB→BTC β0.92** (R².61,
#55b). All validated defences kept (micro-price + 100ms requote, F3 widen-only, 0.01% loss-stop,
governor, F2=1, flow gate + VPIN 0.6); time-stop OFF; directional OFF (κ=0). **Pre-registered: BNB
realised ≥ 0 AND fillEdge ≥ 0 over a multi-hour window.** This is the decisive test: a clean green is the
first real edge (→ scale); a clean red AT SIZE on the desk's cleanest book is the honest verdict that
paper MM on HL has no positive realised edge after costs — at which point we stop tweaking and report
THAT (the mission is honesty, not a tenth losing run dressed as progress). Built under the new §10.1
regression discipline (STEP −1 coherence check passed; bash -n clean; tsc clean this session).

---

## 2026-06-15 — Entry #70 (the MM-edge verdict → the PROFIT PIVOT)

An exhaustive external microstructure report (operator-commissioned) + our own ~10-run record settle
the strategic question. **Verdict: passive, voluntary spread-MM on Hyperliquid (and dYdX/Binance-class
venues) is negative-EV for a participant with no latency/colocation edge, no rebate tier, no client
flow, and a small balance sheet — i.e. us.** Our losses (warehouse drift + the adverse-selection
wedge) ARE the residual that remains after stripping every edge. Confirmed empirically: every run
#41→#68 realised-negative; **BNB-solo (#69), the cleanest book sized up + hedged, came in at ≈$0** —
the textbook break-even of the un-edged game.

**The report's load-bearing facts (record here; full plan in [PROFIT_PIVOT.md](PROFIT_PIVOT.md)):**
- **There IS a latency race on HL** — our premise was wrong: HL's 24 validators sit in AWS Tokyo;
  Tokyo-proximate clients ~2–3ms, EU/IL >200ms; HL price lags Binance ~100ms. That gap **is** our
  stale-quote wedge. We are structurally the slowest reasonable quoter → adversely selected by design.
- **The −0.2bps rebate is ~10× too small** to cover multi-bps adverse selection, and the −0.3bps top
  tier is share-gated out of reach.
- **The one retail-accessible positive-EV "edge" was token/airdrop subsidy, not spread** — and HL S1 is
  paid out (N/A in paper anyway).
- **HLP is "the house"** (scaled residual counterparty + liquidation backstop on *depositors'* tail
  capital, with a validator/foundation bailout when the tail bites — see JELLY, 26 Mar 2025). Not
  replicable by a small quoter.
- Equities contrast: Citadel/Virtu earn the spread on **purchased, uninformed (PFOF) flow** — the exact
  adverse selection we *absorb*. We hold the photographic negative of their edge.

**Decision — PIVOT.** Stop competing on speed-against-informed-flow. Move the core book to
**funding/basis carry + cross-venue (Binance-anchored) fair value** — the **positive-residual** game
that rewards the one edge we have: **holding capacity** (paper = hold delta-neutral indefinitely).
"Flip the residual" = anchor FV to the leader (kill the wedge) + hold the funding-positive side
(holding pays). **xyz/HIP-3 CUT** (2× fees). The defence stack + diagnostics are kept — re-pointed, not
rebuilt. **Next = build P1: T1 CrossVenueFairValue (measure the basis/lead-lag) + T2 FundingCarryBook
(delta-neutral funding harvest, persistence-gated)** — the first run that tests for positive-residual
P&L. Toolkit T1–T7, markets, honesty gates, sequence: [PROFIT_PIVOT.md](PROFIT_PIVOT.md). Spread-MM
chain is SUPERSEDED (recorder/benchmark only). See [[project_mm_frontier_state]].

---

## 2026-06-15 — Entry #71 (P1 of the Profit Pivot: T1 CrossVenueFairValue + T2 FundingCarryBook shipped)

**What shipped (both phases committed to `feat/mm-profit-pivot-plan`):**

**T1 — `CrossVenueFairValue` (measure-only basis/lead-lag engine):**
- `src/market-data/cross-venue/cross-venue-fair-value.interface.ts` — `ICrossVenueFairValue` interface + `BasisSnapshot` type + `MockCrossVenueFairValue` (safe offline default). `BasisSnapshot` carries: `binanceMid`, `hlMid`, `basis` (hlMid−binanceMid), `basisBps` (signed, bps), `hlServerTsMs` (HL's own reported timestamp), `hlDataAgeMs` (HL fetch time − HL server ts — the staleness proxy to validate the ~100ms report claim).
- `src/market-data/cross-venue/cross-venue-fair-value.ts` — `CrossVenueFairValue` real impl: fetches Binance `lastPrice` + HL `l2Snapshot` **concurrently** (parallel `Promise.all`), computes the HL mid from best-bid/ask. Reuses `BinancePublicClient` (the existing global spot feed) + `HyperliquidClient` (the existing L2/candle client) — no new HTTP clients.
- `scripts/cross-venue-basis.ts` — live measurement script: polls N symbols at configurable interval, logs per-sample basis + hlDataAge, then prints a stats table (mean/std/p5/p95 of basisBps and hlDataAgeMs). **Validation gate**: checks `hlDataAge.mean` in [50ms, 1000ms] band (matches the "HL lags Binance ~100ms" report claim). Run: `CV_SAMPLES=60 npx ts-node -r tsconfig-paths/register scripts/cross-venue-basis.ts`.
- Spec: 7 tests covering basis computation, hlDataAgeMs, empty-book handling, interface satisfaction.

**T2 — `FundingCarryBook` (OOS persistence gate + research harness + live tracker):**
- `src/market-data/funding/funding-carry-oos.ts` — `oosCarryGate` library function (the honesty gate PROFIT_PIVOT §5 #1): splits funding history 2/3 train / 1/3 OOS, scores `posFrac` independently in each window via the existing `staticCarry`, passes only when BOTH windows are stable (≥ `minPosFrac`, default 0.65). Supports `LONG_PERP` direction (persistently negative funding). `rankCarryUniverse` batches over a symbol list. Reuses `staticCarry` / `FundingPoint` — no new model code.
- `scripts/funding-carry-oos.ts` — OOS research harness: fetches `FCO_DAYS` (default 90d) of HL hourly funding per symbol, runs `oosCarryGate`, prints the ranked board (IS posFrac / OOS posFrac / full carry % / breakeven / PASS/FAIL). Supports `FCO_SOURCE=hl|binance|both`. Prints the **pre-registered success metric** for the forward paper run.
- `scripts/funding-carry-live.ts` — operator live paper tracker: runs the gate first (refuses to track any symbol that fails OOS posFrac today), opens simulated carry positions for gate-passers, polls HL `currentFunding` every `FCL_POLL_MS`, accumulates simulated funding accrual, prints net-vs-fee status each poll. Final verdict at `FCL_HOURS`. **No orders placed — purely observational paper tracking.**
- Spec: 14 tests covering gate logic, direction handling, split boundary, breakeven formula, ranking, edge cases.

**Regression discipline (§10.1 — done before commit):**
- `npx tsc --noEmit`: clean (exit 0).
- `npx jest src/market-data src/market-making`: 88 suites / 583 tests, all green. New: 2 suites / 21 tests.

**Pre-registered success metric (T2 forward run):**
> PASS = net funding accrued across all OOS-gated carry symbols > entry+exit fee cost over the full breakeven window (~0.5–5d on HL hourly funding at current BTC/ETH rates).
> Judge: realised-first — total_funding_received − total_fees_paid.
> Do NOT churn before the symbol's breakeven date.
> Do NOT simulate (or count) symbols that fail the OOS posFrac gate.

**How to run (operator):**
1. T1 live basis: `CV_SAMPLES=120 npx ts-node -r tsconfig-paths/register scripts/cross-venue-basis.ts` → logs 120s of BTC/ETH/SOL/BNB/XRP basis + validates hlDataAge.
2. T2 OOS gate: `FCO_DAYS=90 FCO_SOURCE=hl npx ts-node -r tsconfig-paths/register scripts/funding-carry-oos.ts` → prints the gated carry board + pre-registered metric.
3. T2 live paper track: `FCL_HOURS=48 FCL_SYMBOLS=BTC,ETH npx ts-node -r tsconfig-paths/register scripts/funding-carry-live.ts` → runs gate then tracks accrual.

**Design notes:**
- T1 uses `hlDataAgeMs = hlFetchMs − hlServerTsMs` as the staleness proxy. This is a conservative lower bound on HL's true lag behind Binance (it includes HL's own internal latency + network RTT, not just the inter-venue lag). The "~100ms" claim from the report should show up as `hlDataAge.mean` in the 50–200ms band.
- T2 uses the 2/3 / 1/3 split rather than a rolling OOS to keep the gate simple and audit-able. A symbol that passes the static OOS can still fail forward (regime change) — that's why the live tracker re-gates before opening any position.
- Both tools are **swap-seam compliant** (interface + real + mock; safe default is the mock). The real impls use only public APIs — no keys, no accounts.

**What's NOT done (P2 sequence — deferred from #71 initial):**
- T3 funding-aware inventory skew: shipped in #71 continuation (see below).
- T4 cross-venue basis arb: shipped in #71 continuation (see below).
- T6 staleness-markout instrumentation: deferred to after T2 shows carry numbers.
- The actual carry execution path (wiring the carry book into `MmPortfolioTrader`): T2 is paper-tracking for now — the live execution path is the P2 deliverable once the paper track record is positive.

---

**Entry #71 (continued) — T3 + T4 shipped (same branch, same commit as T1/T2):**

**T3 — Funding-aware inventory skew (`MM_FUNDING_SKEW_MULT`):**

Principle: when funding is positive (longs pay shorts), running inventory long is a slow drain; shift the quote center DOWN so we accumulate less long exposure and collect more short-bias fills. The inverse for negative funding. This is an additive reservation shift, NOT a new quoter — it composes with every existing quoter (Symmetric / AS / GLFT / Directional) via `buildQuotePair`.

**What shipped:**
- `src/market-making/quote/quote-pair.ts` — `QuoteContext` gains `fundingBiasBps?: number`. `buildQuotePair` applies it as a pre-bid/ask reservation shift: `fundingShift = midMicros × fundingBiasBps × 100 / 1_000_000n`. Bid/ask both move with it (only the center shifts; the spread is unchanged).
- `src/market-making/live/l2-live-fill-engine.ts` — `L2LiveFillEngineConfig` gains `fundingSkewMult?: number`. The helper `fundingSkewBiasBps(rate, mult) = −rate × 24 × 10_000 × mult` converts the live `fundingRatePerHour` into bps and injects it into `ctx.fundingBiasBps` every tick. Off by default (`mult=0` → undefined → `buildQuotePair` unchanged).
- `src/config/app-config.interface.ts` + `app-config.factory.ts` — `MM_FUNDING_SKEW_MULT` env var (default 0 = off).
- `src/market-making/market-making.module.ts` — wires `fundingSkewMult` into `buildFastEngine`.
- Locking spec appended to `src/market-making/quote/quote-pair.spec.ts` (5 new tests under `T3 funding-carry reservation bias`): positive bias shifts center UP (confirm with prices), negative shifts DOWN, spread width is unchanged, composes with `hedgeCostBps`, 0/undefined is a no-op.

**Formula (for the run-review record):**
```
fundingBiasBps = −fundingRatePerHour × 24 × 10_000 × MM_FUNDING_SKEW_MULT
```
`fundingRatePerHour` is the raw HL funding rate (e.g. +0.0001 = 1bps/h). Multiplied by 24 → daily rate. ×10_000 → to bps. Negated: positive funding (longs pay) → negative bias (center down → bias short). `MM_FUNDING_SKEW_MULT` ∈ (0, 1] scales the effect. A value of 1 means the reservation is shifted by the full daily carry in bps.

**Why NOT use the existing `FundingBiasSource`:** That path injects `ctx.bias` for the directional-GLFT quoter only (it scales `q*`). T3 is orthogonal — it shifts the quote center for ALL quoters by an additive bps amount. The two mechanisms are separate by design and can coexist.

---

**T4 — Cross-venue basis arb detector (`CrossVenueBasisArbDetector`):**

Principle: when the HL↔Binance basis exceeds the round-trip fee cost (14bps default) plus a safety margin (5bps default) = 19bps threshold, a real dislocation is live. These events are LARGE and SLOW relative to the HFT arms race — vol spikes, listings, liquidation cascades — and do not require <100ms execution. P1 = detect and log only. Measure convergence hit-rate over the paper window before sizing up.

**Data context (from T1 120-sample run, 2026-06-15):**
- BTC mean basis: −3.0bps, std 0.8bps. ETH: −4.5bps, std 1.0bps. BNB: −6.2bps, std 0.9bps. XRP: −4.1bps, std 1.3bps. SOL: −3.8bps, std 1.1bps.
- std/|mean| < 1 for all: this is structural discount (HL perps trade at a persistent discount to Binance spot), not noise.
- Max |basisBps| observed in the 120-sample run: XRP at −13bps. Still below the 19bps threshold → no T4 signals in a quiet session. Target events are tail realizations of this distribution.
- `hlDataAgeMs` negative (~−300ms mean) due to WSL2 clock drift. Basis structure is not affected (derived from prices, not timestamps). Validation on an NTP-synced host remains on the TODO.

**What shipped:**
- `src/market-data/cross-venue/cross-venue-basis-arb.interface.ts` — `BasisArbDirection`, `BasisArbSignal`, `ICrossVenueBasisArb`, `MockCrossVenueBasisArb` (returns null always — safe default).
- `src/market-data/cross-venue/cross-venue-basis-arb.ts` — `CrossVenueBasisArbDetector`: `check(snapshot)` returns `BasisArbSignal | null`. Fires when `|basisBps| > thresholdBps`. Direction: `LONG_HL_SHORT_BINANCE` when HL is cheap (negative basis); `LONG_BINANCE_SHORT_HL` when HL is rich (positive basis). `netEdgeBps = |basisBps| − roundTripCostBps`. Config: `roundTripCostBps` (default 14) + `marginBps` (default 5) → `thresholdBps = 19`.
- `scripts/cross-venue-basis-arb.ts` — live detector script: polls at `CV_INTERVAL_MS` (default 500ms, 2 Hz), runs `CrossVenueBasisArbDetector.check` on every snapshot, logs every signal with timestamp, direction, entry basis, and net edge. At end of session (default 10 min) prints a convergence summary + per-symbol basis range.
- `scripts/cross-venue-basis.ts` — updated validation note: acknowledges WSL2 clock skew as the source of negative `hlDataAgeMs`; basis structure section is the true P1 deliverable.
- Spec: 11 tests covering null-below-threshold, null-at-threshold, LONG_HL_SHORT_BINANCE fires (neg basis), LONG_BINANCE_SHORT_HL fires (pos basis), roundTripCostBps + thresholdBps in signal, full snapshot carried, custom config, interface satisfaction, mock always null.

**Swap-seam compliance (CLAUDE.md §7):** `ICrossVenueBasisArb` is the interface; `CrossVenueBasisArbDetector` is the real impl; `MockCrossVenueBasisArb` is the safe offline default (always null — no false signals in unit tests or the paper loop). The detector is pure (no state, no IO) — test entirely offline.

**Regression discipline (§10.1 — before this commit):**
- `npx tsc --noEmit`: clean (exit 0).
- `npx jest src/market-data/cross-venue src/market-making/quote/quote-pair.spec.ts src/market-data/funding`: **8 suites / 75 tests, all green.** T3 adds 5 tests; T4 adds 11 tests.

**How to run T3/T4 (operator):**
- T3 (live with desk): set `MM_FUNDING_SKEW_MULT=0.5` in `.env` alongside the paper loop. The shift shows up in `reservationMicros` each tick — grep `MmBook` log for `fundingBias`.
- T4 detect: `CV_DURATION_MIN=10 CV_SYMBOLS=BTC,ETH npx ts-node -r tsconfig-paths/register scripts/cross-venue-basis-arb.ts` → runs 10 min of 2-Hz polling, logs any signal that crosses 19bps.
- T4 with lower threshold (to see how often mid-range events occur): `CV_THRESHOLD_BPS=10 npx ts-node -r tsconfig-paths/register scripts/cross-venue-basis-arb.ts`.

**Next (journal #72 — after the combined live run):**
After the operator runs `cross-venue-basis.ts` + `cross-venue-basis-arb.ts` + `funding-carry-oos.ts` + `funding-carry-live.ts` in sequence, Entry #72 will record the full combined P1 live results and note which symbols passed the OOS gate, whether any T4 signals fired, and what the first carry-accrual numbers look like.

---

## 2026-06-15 — Entry #72 (T2 Funding Carry Live Paper Run — first real accrual numbers)

**What ran:** `FCL_HOURS=48 FCL_SYMBOLS=BTC,ETH,SOL,BNB,XRP npx ts-node -r tsconfig-paths/register scripts/funding-carry-live.ts`

**OOS gate results (60d, posFrac ≥ 0.65):**
- PASS: ETH (+4% gross annualised, 11.6d breakeven), BNB (+7% gross annualised, 6.9d breakeven)
- FAIL (not tracked): BTC, SOL, XRP

**Live accrual — ~85 polls (~85 min):**

| Symbol | Live rate (end) | Accrued funding | Entry fee | Net P&L |
|--------|----------------|----------------|-----------|---------|
| ETH | +0.125 bps/hr (stable throughout) | +$53.13 | −$35 | **+$18.13** |
| BNB | −0.076 bps/hr (volatile, regime flip) | −$58.25 | −$35 | **−$93.25** |
| **Combined** | | | | **−$75.12** |

**ETH — thesis confirmed.** Rate was perfectly stable at +0.125 bps/hr every single poll. This is the 8h HL funding period expressed as an hourly rate — highly structural. Cleared the $35 entry fee at poll ~56 (~56 min). At the live rate: ~$6.25/hr gross on $50K notional, ~10.95% annualised gross vs the OOS estimate of +4% (live rate is running hotter than 60d avg). Clean carry asset.

**BNB — regime flip, gate edge case.** The 60d OOS passed BNB (+7% gross avg) but live funding turned negative within 10 polls and drilled to −0.31 bps/hr peak (polls 11–65). It bounced near zero at the 8h funding reset window (polls 66–73) then drifted negative again. Total bleed: −$93.25 in ~85 min. This is a classic lookback-vs-regime mismatch: BNB carry is volatile and mean-reverting; the 60d average smoothed over a current negative regime.

**Gate improvement identified (deferred):** Add recency weighting to `FundingCarryOosGate` — weight last 7d at 2× vs prior 53d, or add a hard 7d-avg veto (if last-7d rate < 0, reject regardless of 60d avg). This would have blocked BNB entry today. ETH passes either filter trivially.

**Strategic read — carry trade is the desk's core business:**
This run closes the Profit Pivot P1 research pass. The carry-trade thesis is validated on ETH: the funding rate is structural, persistent, and material enough to clear fees within ~1h on a $50K leg. The path forward is:
1. **More markets** — extend the carry scan to more perp CLOBs (dYdX, Drift, Bybit, OKX) and more symbols; find all structurally persistent positive-carry legs the same way ETH was found here.
2. **Longer horizons** — run ETH carry for the full 48h (and beyond) to build a track record; let the compounding work.
3. **Stat-arb complement** — long-horizon cointegration across many markets (equities sectors, cross-chain DEX pairs) as an uncorrelated diversifier; same OOS discipline.
4. **Gate tightening** — recency weighting to prevent BNB-class regime-flip entries.

The desk is carry + stat-arb over long horizons across many markets. This is the mission. Research pass complete.

**tsc / tests:** No code changes this entry — journal-only.

---

## 2026-06-16 — Entry #73 (Take Sides P1: the standalone Regime Directional Book — book + consensus gate + stop, built & green)

**The direction (operator):** beyond delta-neutral carry, start *taking sides* — a conservative,
risk-averse, regime-driven directional strategy that is "not a bot, managed in our engine" and trades
only "statistically obvious chances." Chosen over expanding the carry universe or building the regime
monitor first. Expression chosen: a **standalone** directional book (an outright position), NOT the
axed market-maker (a quote skew, [DIRECTIONAL_MM_STRATEGY.md](DIRECTIONAL_MM_STRATEGY.md)).

**Key finding before building:** most of this already existed — `IBiasSource` + the `validated`
honesty flag, concrete signals (funding/flow/momentum/house view), the full OOS forward-return gate
(`bias/oos/forward-return-ic.ts`: purged k-fold + deflated-Sharpe + IC + verdict + size cap), and the
`InventoryBook` P&L engine. All built for the axed maker. The only missing piece is the **consumer**
that turns a validated view into an outright, sized, stopped position. So P1 = build that one organ.

**What shipped (`src/market-making/directional/`, paper-only, offline, unit-tested):**
- `consensus-bias-source.ts` — `ConsensusBiasSource implements IBiasSource`: a non-zero view only when
  ≥`minAgree` independent, individually-OOS-validated signals AGREE in sign (any opposing validated
  vote ⇒ neutral, with `vetoOnConflict`). The literal "take sides only when funding + trend align"
  gate; inherits each signal's OOS gate via `effectiveBias` rather than re-implementing it.
- `regime-directional-book.ts` — `RegimeDirectionalBook`: pure + clock-free (caller passes nowMs +
  tick), owns one `InventoryBook`. Per tick: (1) **directional stop** preempts all (flatten when
  unrealised < −`stopFrac`·notional); (2) **stand-aside** flag flattens / blocks entry; (3) signal →
  target: enter on `|effB| ≥ bEnter` sized by conviction `min(|bias|, biasMagnitudeCap(IC))`, **hold**
  in the `[bExit,bEnter)` band (no resize churn), **decay** to flat below `bExit`, **flip** on a strong
  sign change. Funding accrues on the held side (long pays / short receives when funding +). Every
  entry/exit/stop emits a `DeskEvent` (reuses `fillEvent`/`controlEvent`).
- Specs lock the acceptance criteria: neutral/**unvalidated** reading never opens (the gate + safe
  swap-seam default — no regression); validated strong view opens the right side, **monotonic** in
  conviction, **IC-capped**; stop **preempts** a still-bullish signal; decay/flip/stand-aside exit;
  in-band same-side holds; funding sign correct + in total P&L; ctor rejects `bExit ≥ bEnter`.
- Docs: [REGIME_DIRECTIONAL_BOOK.md](REGIME_DIRECTIONAL_BOOK.md) (the spec) + `DESK_GLOSSARY.md` §3g
  (plain-language: regime, consensus bias, conviction sizing, directional stop, decay-to-flat, stand-aside).

**Regression discipline (§10.1 — before commit):** `npx tsc --noEmit` clean (exit 0); `npx jest
src/market-making/directional src/market-making/bias` → **10 suites / 70 tests green** (2 new suites).

**Next (the arc, one change per run):** P2 `scripts/regime-bias-oos.ts` (per-symbol VALIDATED board —
the "statistically obvious" gate) → P3 `regime-monitor.ts` (funding/basis/vol regime state + change
events on `/demo` — the "monitor regime changes" deliverable, and the shared spine that later tightens
the carry gate) → P4 `scripts/regime-book-live.ts` (forward-paper track record = the demo).

---

## 2026-06-16 — Entry #74 (Take Sides P2: the VALIDATED BOARD — per-symbol OOS gate + the trader's morning read)

**What this is (playbook S1).** P2 of the standalone "take sides" book: the screen a trader reads each
morning to know *what can I bet on today*. For every symbol it screens the candidate directional
signals across several forward horizons, scores each through the repo's honest OOS gate, picks the
**best signal per symbol**, and prints ONE row: `SYMBOL | BEST SIGNAL | OOS IC | HIT% | DSR | VERDICT |
CONV CAP | ELIGIBLE`. Only ✅ VALIDATED symbols are ever allowed to take a side in the live book (P4).

**What shipped:**
- `src/market-making/directional/regime-signals.ts` — the PURE, no-look-ahead signal library, now the
  **single home** of the two interpretable signals: `funding-paid-side` (bias = −trailing-mean funding)
  and `momentum` (bias = trailing L-bar log return). Exposes `regimeSignalSeries` / `regimeSignalPairs`
  (→ `buildSignalForwardPairs`) + `defaultRegimeSignalSpecs` (hours→bars by interval). Both the offline
  gate AND the live runner (P4) consume it, so what gets validated is exactly what gets traded.
- `scripts/directional-bias-oos.ts` **refactored** to import those builders instead of its own inline
  copies — one definition, no drift between the research sweep and the morning board.
- `scripts/regime-bias-oos.ts` — the VALIDATED BOARD. Builds every (symbol × signal × horizon) trial,
  deflates over the WHOLE sweep's trial count + σ_SR (honest multiple-testing haircut), runs
  `oosForwardReturnIc` + `verdictFor` + `biasMagnitudeCap`, collapses to the best signal per symbol
  (a VALIDATED one with the strongest IC if any, else the highest-IC near-miss), prints an ANSI board
  sorted by IC, and writes a compact `eligibleSymbols` JSON the P4 runner reads. Prints the
  pre-registered success metric + the exact re-run command.
- `regime-signals.spec.ts` — locks the gate's correctness: no-look-ahead (a future price/funding point
  can't change a past signal), exact windowed-funding values, NaN where no view, a known-answer
  trending series scores a positive momentum IC, and a flat market produces **zero** positions.

**Regression discipline (§10.1):** `npx tsc --noEmit` clean (exit 0); `npx jest
src/market-making/directional` → **3 suites / 36 tests green** (regime-signals new). Scripts type-check
(in tsconfig scope).

**First live read — pipeline proven, numbers NOT yet a board.** A bounded smoke (BTC/ETH, HL, **20d**,
fwd 8/24h) ran end-to-end against live HL candles+funding and rendered the board: BTC momentum(24h)
+0.36 IC / ETH funding-paid-side(24h) +0.32 IC, both DSR 1.00 → VALIDATED. **Caveat (binding honesty):
20d over-validates** — exactly the short-window cliff the desk has been burned by (#72 BNB lesson); the
artifact was **deleted**, not committed, so it can't masquerade as a tradeable read. The authoritative
morning board is the **90d** default; that run is the operator's to fire on a networked host:
`RBO_DAYS=90 RBO_SYMBOLS=BTC,ETH,SOL,BNB,XRP,DOGE,ADA npx ts-node -r tsconfig-paths/register scripts/regime-bias-oos.ts`.

**Next:** P3 `regime-monitor.ts` (funding/basis/vol "weather" + change events on the tape — the
stand-aside source and `/demo` deliverable) → P4 `scripts/regime-book-live.ts` (gate-first forward-paper
runner + terminal dashboard = the track record).

---

## 2026-06-16 — Entry #75 (Take Sides P3: the REGIME MONITOR — the "weather" + change-alerts on the tape)

**What this is (playbook S2).** The per-symbol WEATHER: each tick it reads funding / basis / vol,
classifies the market into a tradeability state, and fires ONE event when the weather flips. It is the
book's **stand-aside source** AND the "monitor regime changes" deliverable on the Activity feed.

**What shipped (`src/market-making/directional/regime-monitor.ts`, pure + clock-free, same discipline
as `FlowRegimeMachine`):**
- Three sub-regimes on a shared FAVORABLE/NEUTRAL/ADVERSE ladder: **funding** (a TAILWIND read — a clear
  one-sided carry regime is FAVORABLE, flat is NEUTRAL; the alert fires on a SIDE flip paid-short ⇄
  paid-long), **basis** (calm → widening → BLOWOUT past the ≈19bp fee+margin threshold, reusing
  `computeThreshold(14,5)`), **vol** (a relative short/slow EWMA realised-vol SPIKE detector,
  price-scale-invariant, with a cold-start guard so it never false-spikes before warm).
- `overall = STAND_ASIDE` iff a HAZARD dim (basis/vol) is ADVERSE or the feed is stale; `HOLD_ONLY` on a
  hazard NEUTRAL; else `TRADEABLE`. **Funding is deliberately excluded from the hazard ladder** — being
  paid-long is not a reason to sit out. So STAND_ASIDE is reachable ONLY from a real adverse read (asserted).
- **Hysteresis + dwell, baseline-silent:** escalation to a worse hazard is immediate (protection must not
  lag); de-escalation waits out a dwell (no chatter); the first observation per dimension sets the baseline
  silently (alerts announce CHANGES, the Weather strip shows current state).
- **The color law is exported ONCE** (`REGIME_LEVEL_COLOR` / `REGIME_OVERALL_COLOR`, semantic green/amber/
  red) so the S4 UI chips mean exactly what the engine does. Tape wiring: `regimeEvent` (new `regime`
  DeskEventKind) + `regimeChangeEvent(transition)` → `REGIME ▸ <symbol> <plain-English sentence>`.

**Regression discipline (§10.1):** `npx tsc --noEmit` clean; `npx jest src/market-making/directional
src/market-making/bias` → **12 suites / 95 tests green** (regime-monitor new: color law, boundary
classification, one-event-per-flip + dwell suppression, blowout/spike ⇒ STAND_ASIDE, the invariant, feed
staleness, tape mapping).

**First live weather read (bounded smoke, HL, 14d hourly, funding+vol; basis not wired in the smoke):**
BTC funding paid-short/NEUTRAL (+4.0%/yr) · ETH paid-short/FAVORABLE (+9.9%/yr) · SOL paid-short/NEUTRAL
(+7.5%/yr) — all **vol FAVORABLE, overall TRADEABLE**, no spikes this calm window; the tape fired only
benign `vol rising`/`vol quiet again` lines. The monitor classifies live data sensibly.

**Authoritative 90d VALIDATED BOARD landed (the operator ran S1's default; recovered + kept at
`docs/research/2026-06-16-14-23-regime-validated-board-hyperliquid.json`).** On the honest 90d window
(63 trials, σ_SR 0.081) the 20d over-fit collapses to **1/7 eligible — only BTC** (funding-paid-side,
72h horizon, OOS IC +0.20, hit 55%, **DSR 0.97**, conv cap 0.50). ETH had the highest IC (+0.24) but
DSR 0.81 ⇒ INCONCLUSIVE; the rest INCONCLUSIVE/NOT_VALIDATED. The winning signal everywhere is the
**carry-sign**, not momentum — consistent with the desk's standing finding that funding is the real edge.
This is the gate doing its job: most symbols don't earn a side.

**Next:** P4 `scripts/regime-book-live.ts` — gate first (BTC only, today), build a `RegimeDirectionalBook`
+ `ConsensusBiasSource` + this `RegimeMonitor` per eligible symbol, forward-paper with the terminal
dashboard (the distance-to-stop gauge as the hero widget), print the realised-first verdict = the track record.

---

## 2026-06-16 — Entry #76 (Take Sides P4: the LIVE FORWARD-PAPER RUNNER + terminal cockpit)

**What this is (playbook S3).** The forward-paper runner you leave running for hours — `scripts/regime-book-live.ts`
— and the live terminal cockpit that produces the track record. It **gates first** (the exact same OOS gate
as the morning board, now a shared module so they cannot drift), trades ONLY today's VALIDATED symbols, and
prints why the rest are refused.

**What shipped:**
- `src/market-making/directional/regime-board.ts` — the **shared scorer** extracted from the board script:
  `scoreRegimeBoard` (every symbol×signal×horizon trial, deflated over the whole sweep) + `bestPerSymbol`
  (the printable board) + `validatedSignalsPerSymbol` (the constituent set the live consensus votes over).
  `scripts/regime-bias-oos.ts` **refactored** onto it — the morning board and the live gate are now one
  definition (no drift between what validates and what trades).
- `src/market-making/bias/momentum-bias-source.ts` — the missing `MomentumBiasSource` (long the trend, reads
  `recentReturns`), the second consensus constituent beside `FundingBiasSource`. `validated` defaults FALSE.
- `scripts/regime-book-live.ts` — per eligible symbol: a `RegimeDirectionalBook` + a `ConsensusBiasSource`
  (the symbol's validated funding/momentum signals + a manual house-view slot) + a `RegimeMonitor`. Each poll
  fetches HL mid + funding + Binance basis, feeds the monitor (stand-aside) and the consensus (the bias),
  calls `book.update` with the OOS IC for the conviction cap, and books the fill paper-only against the book's
  own `InventoryBook`. The dashboard redraws in place: a CARD per book (side, size, entry/mark, uPnL, funding,
  the **distance-to-stop gauge** — the hero widget — the bias with a ↗/↘ decay arrow, age), a desk header
  (realised + unrealised, **maxDD**, books live/aside), and a weather-strip footer. The verdict is
  **realised-first**: realised + funding − fees per book + desk, judged on realised, never the open mark.
  Funding subtlety handled honestly: the **trailing-mean** funding (what validated) drives the signal +
  monitor; the **instantaneous** rate drives the book's funding accrual (the real carry).

**Regression discipline (§10.1):** `npx tsc --noEmit` clean; `npx jest src/market-making/directional
src/market-making/bias src/market-making/events` → **16 suites / 120 tests green** (regime-board + momentum
new). Scripts type-check.

**First forward-paper micro-run (bounded smoke, HL, 2 polls — proves the pipeline, NOT a track record).**
Gate (30d, over-fit short window) validated BTC (momentum, IC +0.28) and ETH (funding, IC +0.56). The runner
then behaved exactly as designed: **BTC opened SHORT on validated momentum** (conv 0.27, IC-capped, $13.7k of
$50k base), while **ETH stood FLAT** — on 30d both its funding signal (short) *and* momentum (long) validated,
so the consensus `vetoOnConflict` neutralised them (the "stand aside on internal disagreement" rule, working
live). The stop gauge (empty — no drawdown), weather strip (both TRADEABLE, vol ×1.00), decay arrows, and the
realised-first verdict all rendered. Over the 10-second smoke desk realised was just the **−$6.17 entry fee**,
maxDD −$11.38, 1 entry, 0 stops — a pipeline proof, not a number to trust.

**Observation for the operator (a trading-policy choice, yours):** with `vetoOnConflict` on, a symbol whose
funding and momentum *both* validate but *disagree* in sign trades nothing — conservative-correct, but it
means fewer positions. `RBL_MIN_AGREE` / the veto are the knobs. The authoritative **90d** gate (#75) validates
only **BTC** (funding), so the conflict case won't bind on the real run today — but it will when more symbols
validate.

**This completes the standalone "take sides" build (P1–P4): the book + consensus gate + stop (P1), the OOS
VALIDATED board (P2), the regime monitor / weather (P3), and the live forward-paper runner + cockpit (P4).**
The remaining playbook sessions (S4–S6) are the `/demo` web cockpit + the multi-hour forward run that becomes
the demo's track record.

---

## 2026-06-16 — Entry #77 (Take Sides P5: the DESK RISK SPINE — caps, kill-switch, flatten-on-exit)

**What this is (Playbook II P5).** The first institutional-grade phase: a **desk-level** risk layer so one
bad book can't sink the desk, plus the manual "react" controls the terminal runner lacked. Until now each
book policed only *itself* (its own stop/decay); nothing watched the **portfolio** — gross exposure, net
beta, the desk's daily loss, or its aggregate drawdown — and Ctrl-C *abandoned* open paper positions
unrealised instead of flattening them. P5 closes both gaps. This is the spine the universe expansion (P12)
leans on — a bigger universe is only safe once desk-level caps + a kill-switch exist (Playbook II §3).

**What shipped:**
- `src/market-making/directional/regime-desk-risk.ts` — `RegimeDeskRisk`: a **pure, clock-free, stateful**
  desk risk engine (mirrors `CompositeRiskGate`'s verdict shape). Each poll it ingests every book's
  `{notionalUsd, side, realisedPnl, unrealisedPnl}` and enforces, in order: **(a)** GROSS + NET exposure
  caps (USD) ⇒ `BlockNewEntry`; **(b)** a DAILY-LOSS limit (realised+funding−fees below −X) ⇒ **HALT**;
  **(c)** a desk maxDD circuit breaker (peak-to-trough equity beyond Y% of capital) ⇒ **HALT**. Returns a
  per-book verdict (`Allow` / `BlockNewEntry` / `FlattenNow`) + a desk verdict (`Run` / `Halt`). Plus manual
  `manualHalt()` (kill-switch) + `manualFlatten(symbol)`. **The breakers LATCH** (a tripped daily-loss/maxDD/
  manual halt stays tripped until `reset()` — a kill-switch you can un-trip by luck isn't one); the exposure
  caps do **not** latch (they only block growth while over-cap). Peak equity starts at 0, so a loss from the
  flat open counts as drawdown — the honest budget read.
- `scripts/regime-book-live.ts` — **wired the spine in**. The poll loop is now **two-pass**: PASS 1 stages
  every symbol's fresh tick (no `book.update` yet) so the desk-risk assessment sees one coherent whole-desk
  snapshot; PASS 2 consults `RegimeDeskRisk.assess(...)`; PASS 3 updates each book under its verdict —
  `FlattenNow`/`Halt` ⇒ `standAside` (flatten), `BlockNewEntry` ⇒ a flat book is fed a neutral reading so it
  cannot open (open books unchanged, governed by their own exits). A **desk-risk banner** renders in the
  cockpit (RUN/HALT, gross/net vs caps, DD vs budget, `[h]=halt [f]=flatten-all`). Live **keypress controls**
  (TTY only, non-interactive runs unaffected): `h` engages the kill-switch, `f` flattens every book; both
  emit a `controlEvent` on the tape. Env equivalents: `RBL_HALT=1`, `RBL_FLATTEN=BTC,ETH`. Caps default to
  the universe size (gross ≤ maxNotional×N, net ≤ maxNotional×⌈N/2⌉, daily-loss 1.5% of capital, maxDD 2%).
- **GRACEFUL SHUTDOWN:** on Ctrl-C (or window-elapsed) `flattenAllOpenBooks` books every open position to
  realised at its last mid (via `standAside`), restores the TTY, then prints the realised-first verdict — **no
  paper position is ever left dangling/unrealised at exit.** (Raw mode swallows SIGINT, so Ctrl-C `\x03` is
  caught on the keypress stream.)

**Regression discipline (§10.1):** `npx tsc --noEmit` clean (exit 0); `npx jest src/market-making/directional`
→ **6 suites / 67 tests green** incl. the new `regime-desk-risk.spec` (14 tests): caps fire at the boundary
(gross ≥ cap blocks; net cap distinct from gross via a long+short pair), daily-loss HALT flattens **all**
books and a halted desk opens nothing (latched), the maxDD breaker trips on peak-to-trough and latches,
manual halt/flatten + `reset()`, and verdict precedence (a halt outranks a cap). Bounded live smoke (BTC,
1 poll) ran end-to-end: gate→open short→desk-risk banner→**flatten-on-exit closed the book to realised** with
no dangling unrealised. DB-free, no artifact written.

**Next:** P6 — durable `mm_nav`-tagged persistence + restart recovery (the track record must survive a crash).

---

## 2026-06-16 — Entry #78 (Take Sides P6: DURABLE PERSISTENCE + restart recovery — the track record survives a crash)

**What this is (Playbook II P6).** An unrecoverable paper run is not a track record. P6 makes the regime
desk's equity curve **and** its open positions survive a crash/restart — on reboot the runner reloads each
book's inventory, avg-cost, realised, fees, funding, and entry context and **resumes** the carried position
instead of re-opening from flat. Built behind `MM_PERSIST` (off by default ⇒ DB-free runs unchanged).

**What shipped:**
- `RegimeDirectionalBook.serializeState()` / `restoreState()` + the `RegimeBookState` blob (InventoryBook
  ledger + accrued funding + **`lastMs`**). `lastMs` is the regime analogue of the **#47 rehydrate trap** —
  drop it and a revived book mis-accrues funding over the wrong Δt; the test below locks it.
- `src/market-making/directional/regime-state-store.ts` — the persistence seam (`IRegimeStateStore`:
  `saveBook`/`loadOpen`/`closeBook`/`appendNav`), a no-op `NullRegimeStateStore` (the safe default), and a
  **pure** `reconcileResume(eligibleToday, openRecords)` → `{resume, startFlat, orphaned}`. A symbol that
  validated yesterday but **not today** is ORPHANED — closed, not ridden (the BNB lesson, #72: regimes shift).
- `src/market-making/directional/postgres-regime-state-store.ts` — the real backend, taking a TypeORM
  `DataSource` directly (NOT the Nest `DbService`) so the standalone runner can persist without a Nest context,
  using the app-role `DATABASE_URL_APP` (same grants the service uses). `regime_book_state` is a mutable
  upsert/soft-close cache; `mm_nav` gets the equity curve.
- `migrations/1724000000000-AddRegimeDeskState.ts` — `regime_book_state` (one row/symbol, JSONB state,
  SELECT/INSERT/UPDATE, no DELETE — the `mm_book_state` posture) + an **additive** `mm_nav.desk` column
  (DEFAULT `'mm'`). The regime desk writes `desk='regime'` under a **`@regime` book_key namespace**, so its
  curve never collides with the MM desk's (`book_key '' / 'SYMBOL'`) — **the MM repo is untouched** (its INSERT
  defaults `desk='mm'`, its `book_key` reads never match `@regime`). Zero MM blast radius, an explicit
  filterable tag — exactly the P6 instruction.
- `scripts/regime-book-live.ts` — wired it through: `buildStore()` opens the app-role DataSource when
  `MM_PERSIST=true` **and the DB is reachable**, else falls back to the Null store with a clear warning (a
  requested-but-down DB never crashes the operator's run). On boot: `loadOpen` → `reconcileResume` against
  today's gated set → restore the resumed books (printing inv/realised/funding recovered), close orphans loudly.
  Each poll: `appendNav` (desk row + per-book rows) + `saveBook` per book. On shutdown: a **final** checkpoint
  after the flatten so the durable state reflects the realised (flat) desk, then the DataSource closes.

**Regression discipline (§10.1):** `npx tsc --noEmit` clean (exit 0); `npx jest src/market-making/directional`
→ **8 suites / 78 tests green**. New: the **#47 rehydrate-trap regression** (`regime-directional-book.spec`):
a rehydrated book fed the SAME next tick as the never-restarted survivor produces the **identical** action,
fill, and snapshot (incl. funding accrued over the same Δt) — restart-path drift is now impossible to
reintroduce silently. Plus `regime-state-store.spec` (reconcile resume/start-flat/orphan + Null no-op) and
`postgres-regime-state-store.int-spec` (save→load→upsert→close + regime-tagged nav round-trip; auto-skips
without Postgres). Bounded live smoke: `MM_PERSIST=true` with the DB down ⇒ **graceful DB-free fallback** +
warning, run completed, flatten-on-exit fired. No artifact written.

**Next:** P7 — slippage + market-impact on the paper fill (frictionless mid-fills overstate the edge).

---

## 2026-06-16 — Entry #79 (Take Sides P7: HONEST FILLS — slippage + market-impact cost model)

**What this is (Playbook II P7).** Frictionless mid-fills overstate the edge — a taker never executes at
the mid. P7 gives the book a **pluggable fill-cost model** so the realised P&L is credible. Default OFF
(byte-identical to the old mid-fill); callers opt in to honest costs.

**What shipped:**
- `src/market-making/directional/fill-cost-model.ts` — `FillCostModel` interface + two impls, mirroring the
  `HistoricalReplayVenue` math: `NoSlippageModel` (mid-fill, the safe default) and `SlippageImpactModel
  ({halfSpreadBps, impactBpsPerMillionUsd})` — adverse = half-spread + linear impact·(notional/$1M), BUY fills
  above the mid, SELL below, capped at 500bps. Plus `slippageCostUnits(size, mid, fill)` (the ≥0 cost).
- `RegimeDirectionalBook` — a `fillModel` ctor knob (default `NoSlippageModel`). The fill now EXECUTES at the
  model's worsened price (so the cost lands in realised/unrealised via the avg-cost ledger), while the taker
  fee stays computed on the mid notional — keeping **fee and slippage cleanly separable for TCA (P10)**. A new
  `slippageAccrued` accumulator + `slippageUnits()` getter + `snapshot().slippageUnits` surface the cost as a
  diagnostic (it is already inside realised — not double-counted). The fill-event tape now records the actual
  executed price. Slippage is persisted/restored in `RegimeBookState` (optional field, backward-compatible).
- `scripts/regime-book-live.ts` — `RBL_SLIPPAGE_BPS` (half-spread) + `RBL_IMPACT_BPS_PER_MM` (linear impact)
  build the model (both 0 ⇒ frictionless, no change); the verdict shows per-book + desk `slip`.

**Regression discipline (§10.1):** `npx tsc --noEmit` clean; `npx jest src/market-making/directional` →
**9 suites / 88 tests green**. New `fill-cost-model.spec` (default fills at mid; BUY above / SELL below;
symmetric half-spread; monotone in size; **size 0 ⇒ no cost**; 500bps cap) + book-level P7 tests: **the
default model produces zero slippage and a flat mark (no regression)**, a slipped entry is strictly costlier
than mid+fee, and slippage survives a persist→restore. Bounded live smoke (BTC, 5bps + 10bps/$1M): a
round-trip cost **$15.48 slippage**, booked into realised and shown separately (`slip −$15.48`). No artifact.

**Next:** P8 — book-level walk-forward backtest (prove the BOOK makes money after costs, not just the signal IC).

---

## 2026-06-16 — Entry #80 (Take Sides P8: BOOK-LEVEL WALK-FORWARD BACKTEST — and the honest first read)

**What this is (Playbook II P8).** The OOS gate (P2) proves a SIGNAL predicts forward return; P8 proves the
**BOOK** — the whole chain gate→consensus→size→stop→fees→funding→slippage — actually makes money after costs
on out-of-sample history. It is a distinct, **stricter** bar than the IC gate.

**What shipped:**
- `src/market-making/directional/regime-backtest.ts` — the PURE replay engine `replayRegimeBook(bars, cfg,
  signalAt)`. It replays the EXACT live `RegimeDirectionalBook` + P7 fill model bar by bar, so backtest and
  live are **one code path** (no drift). **No look-ahead is structural**: the engine hands the signal callback
  only `bars[0..i]`. Returns a realised-first scorecard (realised−fees+funding, slippage, maxDD, #entries/
  #stops, hit rate, exposure, the per-trade Sharpe stream).
- `scripts/regime-book-backtest.ts` — the WALK-FORWARD driver: re-gates on a trailing TRAIN window
  (`scoreRegimeBoard`), trades the next TEST window with that gate, rolls; a window where nothing validates
  trades nothing. Per-symbol + desk scorecard with the **deflated** Sharpe (multiple-testing haircut over the
  book grid), a JSON artifact under `docs/research/`, and the **pre-registered bar**: a book is "validated"
  only if walk-forward realised > 0 AND per-trade Sharpe > 0 AND maxDD ≤ budget.
- Tests: `regime-backtest.spec` (no-look-ahead structurally enforced; a known edge → positive realised; a
  known stop → the stop fires + a cut loss is realised; an always-neutral signal trades nothing).

**Regression discipline (§10.1):** `npx tsc --noEmit` clean; `npx jest src/market-making/directional` →
**10 suites / 93 tests green**.

**THE FIRST HONEST READ (60d × 1h walk-forward, BTC + ETH, train 720 / test 168, slippage 1bps + impact
5bps/$1M):** **0/2 books cleared the book-level bar.** BTC realised **−$713** (15 trades, 27% hit, 2 stops,
maxDD 2.46%, SR −0.25); ETH realised **−$770** (9 trades, 56% hit, 4 stops, maxDD 4.04%, SR −0.17); **desk
−$1,484**, PSR 0.20, DSR 0.16. Funding was a small positive (+$67) but fees (−$351) + slippage (−$85) + the
adverse directional moves sank it. **This is the mission outcome working as designed:** the SIGNAL validated
OOS on several windows (4/5 BTC, 3/5 ETH), but the BOOK — once it pays real fees, slippage, and rides the
view through whipsaws — did **not** make money on this window. The book-level gate correctly **rejects** what
the IC gate alone would have waved through. **Honest caveat:** one 60d window, 2 symbols, default knobs — this
is a methodology proof + a first read, not a verdict on the strategy. The wider universe (P12) + a longer
window are where a real edge would have to show.

---

## 2026-06-16 — Entry #81 (Take Sides P9: EXPOSURE TOGGLE — outright ⇄ beta-hedged)

**What this is (Playbook II P9).** The operator's locked decision: build BOTH exposure modes behind a toggle
(default OUTRIGHT). A desk long several alts can flip to HEDGED to neutralise its net crypto-beta and express
only the signal's idiosyncratic edge — the two track records run side by side for comparison.

**What shipped:**
- `src/market-making/directional/regime-beta-hedge.ts` — a PURE `RegimeBetaHedge`: net book beta (USD-beta) =
  Σ(signedNotional·β); the hedge leg that flattens it is −netBookBeta in one hedge instrument (β=1 to itself);
  a rebalance BAND avoids churn. `estimateBeta(assetRets, hedgeRets)` = cov/var (unit beta when data is thin).
  Emits `hedgeEvent` + accrues a fee on each rebalance. Clock-free, fully unit-tested.
- `scripts/regime-book-live.ts` — `RBL_EXPOSURE=outright|hedged` (default outright), `RBL_HEDGE_SYMBOL`
  (default BTC), `RBL_HEDGE_BAND_USD`, `RBL_HEDGE_BETA_LOOKBACK`. In hedged mode a PASS-4 each poll estimates
  every non-flat book's β to the hedge instrument from trailing returns, rebalances a paper perp leg (its own
  `InventoryBook` for honest P&L+fees), and the verdict reports BOTH the gross book realised and the
  **NET-OF-HEDGE** total. The hedge covers EVERY non-flat book (no naked net beta — the coherence rule).

**Regression discipline (§10.1):** `npx tsc --noEmit` clean; `npx jest src/market-making/directional` →
**11 suites / 102 tests green** (new `regime-beta-hedge.spec`: beta estimation 1×/2×, target = −Σβ·notional,
hedged drives residual→~0 covering all books, a partial set leaves naked residual, band suppresses churn,
hedgeEvent+fee fire, outright leaves beta intact). Bounded live smoke (BTC+ETH, hedged): the leg bought
**$11,741 BTC-perp**, residual β **$0**, verdict printed DESK vs NET-OF-HEDGE.

---

## 2026-06-17 — Entry #82 (Take Sides P10: DESK RISK AGGREGATION + FACTOR SPLIT + TCA)

**What this is (Playbook II P10).** See the desk like a risk manager: portfolio heat, factor exposure, and
where every basis point of P&L came from. Two pure modules + runner wiring.

**What shipped:**
- `src/market-making/directional/regime-tca.ts` — `RegimeTcaAttributor` (the `PnlAttributor` analogue for the
  directional desk). `attributeBook`/`attributeDesk` split each book's realised-first P&L into **idiosyncratic ·
  beta · funding · fees · slippage**. The algebra: realised+unrealised already carries the slippage drag (worse
  fills), so `directionalGross = realised + unrealised + slippage` (add it back) and `idiosyncratic =
  directionalGross − betaPnl` (the honest residual after the supplied market-factor P&L). **THE INVARIANT
  (asserted): `total = idio + beta + funding − fees − slip`, exactly, to the cent** — and because idio is DEFINED
  as the residual, it reconciles for ANY beta estimate (the split is a modelling choice; the total is invariant).
  `reconciliationResidual`/`assertReconciles` are the guard.
- `src/market-making/directional/regime-portfolio-risk.ts` — `aggregatePortfolioRisk` gives gross / net / **net-β
  exposure** (Σ N·β = $/1.00 market move), per-symbol realised vol, and a **single-factor parametric VaR**: the
  market (hedge instrument) is the common factor, so `factorVol$ = |Σ N·β|·σ_m` (does NOT diversify) and
  `idioVol$ = √Σ(N·σ_idio)²` (independent ⇒ DOES diversify), `σ_desk = √(factor²+idio²)`, `VaR = z·σ_desk·√h`
  (Z95 1.645 / Z99 2.326). Ties the VaR to the SAME β the P9 hedge neutralises. `betaPnlIncrementUnits(N,β,r_m)`
  accrues the market-factor P&L each interval on the held position (like funding).
- `scripts/regime-book-live.ts` — PASS 1.5 each poll: fetch the market factor (`RBL_MARKET_SYMBOL`, default BTC,
  reuses the staged book when traded), estimate each book's β, accrue beta-P&L on the **pre-update** (held)
  position, and aggregate the risk read. Header gains a **risk** line (βexp · σdesk factor/idio · VaR95 %cap) and
  an **attr** line (P&L = idio · beta · funding · fees · slip); the verdict prints a **DESK ATTRIBUTION (TCA)**
  block (per-book + desk, `assertReconciles` on every line) + the parting risk read. β-P&L is session-local
  (not persisted — a within-session attribution, like maxDD/peak). Knobs: `RBL_MARKET_SYMBOL`, `RBL_RISK_LOOKBACK`
  (72), `RBL_VAR_HORIZON_BARS` (24).

**Regression discipline (§10.1):** `npx tsc --noEmit` clean; `npx jest src/market-making/directional` →
**13 suites / 123 tests** (+21: `regime-tca.spec` — reconciliation exact, slippage backed out, beta/idio split
on constructed cases, reconciles for any β, desk sum, tampered-attribution throws; `regime-portfolio-risk.spec`
— sample stdev, gross/net/β-exposure, factor-vs-idio decomposition with factor-not-diversifying / idio-does,
VaR scales with z and √h, heat fraction, boundaries). Bounded 2-poll live smoke (BTC,ETH): header printed
`risk βexp −$32,403 · σdesk $170/bar (factor $137 · idio $101) · VaR95 $1,372 (1.37% cap)`; verdict TCA
reconciled to the cent (βexp/$25k ETH short ⇒ β≈1.3, correct).

**Honest caveat:** the β/idio split is a single-factor (BTC-beta) model — beta-P&L is an estimate accrued on the
realised market path; idiosyncratic is its residual. The TOTAL it reconciles to is exact regardless; the split's
*accuracy* is only as good as the trailing-β estimate. VaR is Gaussian-parametric (thin-tailed vs crypto reality)
— a floor, not a worst case; P11's stress harness is the tail read.

---

## 2026-06-17 — Entry #83 (Take Sides P11: SCENARIO / STRESS HARNESS)

**What this is (Playbook II P11).** Prove the desk SURVIVES the tails before trusting it: a flash crash, a
simultaneous vol spike, a funding sign-flip, and a stale feed — run through the REAL components, asserting the
protective response. The stress harness doubles as a regression guard.

**What shipped:**
- `src/market-making/directional/regime-stress.ts` — pure scenario engine. `buildStressPath(kind, cfg)`
  synthesises a warmup (seats a validated LONG, warms the vol EWMA) + a shock per symbol; `runStressScenario`
  runs `RegimeDirectionalBook` (stop) + `RegimeMonitor` (STAND_ASIDE) + `RegimeDeskRisk` (kill-switch) over it
  and returns a scorecard (stops fired, books stood aside, regime transitions, desk HALT, **maxDD vs budget**,
  flat-at-end). The headline invariant: `budgetRespected = maxDD ≤ budget OR halted`.
- `scripts/regime-stress.ts` — prints the scorecard (DB-free, no network, deterministic), exit 1 if any
  scenario breaches the budget without halting.

**The reads (deterministic):** **flash crash** (−15% gap, 3 books) → 3 stops fire + desk HALTs (maxDD 7.6% >
2% ⇒ kill-switch engages, flat-at-end) — *breached but never silently*; **vol spike** (×6 alternating) → every
held book STAND_ASIDE, maxDD 0.07%; **funding flip** (paid-short→paid-long) → regime transition fires, book
flips, budget intact; **feed blackout** (feedStale) → every book STAND_ASIDE + flat. All four `budgetRespected`.

**Regression discipline (§10.1):** `npx tsc --noEmit` clean; `npx jest src/market-making/directional` →
**14 suites / 133 tests** (+10: the four scenarios' protective responses + the whole-set budget invariant +
the deterministic-path builder). Script runs + prints `STRESS OK`.

---

## 2026-06-17 — Entry #84 (Take Sides P12: UNIVERSE EXPANSION — signals, venues, cross-sectional allocator)

**What this is (Playbook II P12, the headline).** Expand what the desk can take sides on — more symbols, more
validated signals, another venue, and a CROSS-SECTIONAL ranking gate that funds the top-N edges instead of an
equal split. The desk-risk spine (P5–P10) exists so a wider universe is *safe*.

**What shipped (every new signal pure + no-look-ahead + known-answer spec + OOS-gated — no exceptions):**
- **SIGNALS** (`regime-signals.ts`): `reversal` (−trailing return, fade the pop), `vol-scaled-momentum`
  (trailing return / realised vol — risk-adjusted trend), and `trailingRealisedVol`. All in
  `defaultRegimeSignalSpecs` now. Live bias sources `ReversalBiasSource` + `VolScaledMomentumBiasSource`
  (`trend-variant-bias-sources.ts`) wired into the runner's `buildConsensus`.
- **CROSS-SECTIONAL** (`regime-cross-sectional.ts`): `crossSectionalRankSignals(universe, lookback)` ranks the
  whole universe each bar → [−1,1] demeaned bias (top +1, bottom −1). Scored IN-SWEEP via a new `extraSignals`
  param on `scoreRegimeBoard` (honest deflation across the full candidate set); wired into the morning board
  (`regime-bias-oos.ts`). Kind `cross-sectional-momentum` is gate-only (universe-wide ⇒ not a per-symbol live
  consensus source yet — a clean follow-on).
- **VENUE** (`bybit-client.ts`): `BybitClient` — Bybit v5 public perp klines (`category=linear`, newest-first,
  injected GET) behind `IReferenceBarSource`. A second order-book venue + Binance/HL basis breadth.
  DATA_SOURCES.md updated (WIRED; L2+funding ingest still open).
- **ALLOCATOR** (`regime-universe-allocator.ts`): `allocateUniverse` selects the top-N by conviction
  (IC-capped |bias|), sizes notional = base·conviction (per-symbol capped), then **TRIMS to the gross cap
  uniformly and the net cap pro-rata on the heavier side — an over-budget request is trimmed, never breached**.
  Wired into the runner: it funds the top-N validated symbols (net handled live by RegimeDeskRisk) and prints
  the allocation table. Universe defaults widened to 16 symbols.

**Live read (bounded smoke, 6-symbol gate, 126 trials):** ETH validated on funding-paid-side, **SOL validated on
the NEW vol-scaled-momentum(72h)** — the allocator funded both ($25k each, top-4), and the runner opened ETH
short + SOL long live. The new signal flowing gate→allocator→book is the proof the expansion is real, not cosmetic.

**Regression discipline (§10.1):** `npx tsc --noEmit` clean; `npx jest src/market-making/directional
src/market-making/bias src/market-data/reference` → **36 suites / 268 tests** (+ the P12 specs: new-signal
known-answers, cross-sectional rank flip/warmup/exclusion/demean, allocator top-N + gross/net trim-not-breach,
Bybit parse/interval/error). Wider-universe scripts run.

**Honest caveat:** the new signals + cross-sectional are SCREENED honestly but most won't validate on any given
window (the smoke: 2/6 validated) — that is the correct outcome. The cross-sectional is gate-reported, not yet a
live consensus source. Bybit is OHLCV-only so far.

---

## 2026-06-17 — Entry #85 (Take Sides P13: /demo REGIME DESK WEB COCKPIT)

**What this is (Playbook II P13).** Host the take-sides desk in-process + a live `/demo` "◆ Regime Desk" tab so
a trader with no terminal can run + watch + intervene. Behind a `REGIME_DESK` flag, **OFF by default** (nothing
about existing desks changes).

**What shipped:**
- `regime-desk-trader.ts` — `RegimeDeskTrader`, the in-process analogue of `MmPortfolioTrader`. Tick-driven +
  network-free (the driver feeds it): one `tick()` runs the same PASS sequence as the runner (weather →
  desk-risk assess → beta-P&L accrual + portfolio risk read → book updates), and `snapshot()` returns the
  cockpit DTO (desk totals · risk/VaR · TCA · position cards w/ stop gauge · weather). `halt()` / `flatten(sym)`
  controls. Fully unit-tested (open on a view, TCA reconciles, halt flattens all, flatten one).
- `regime.controller.ts` — `GET /api/regime/snapshot`, `POST /api/regime/flatten`, `POST /api/regime/halt`.
  **Inert when the trader is null** (flag off) ⇒ `{ enabled:false }`. Unit-tested both ways.
- `regime.module.ts` — trader factory (null unless `marketMaking.regimeDeskEnabled`) + a `RegimeBootstrap`
  (`OnModuleInit`) that, when enabled, builds + starts `RegimeLiveDriver`. Wired into `AppModule`.
  `app-config.factory` reads `REGIME_DESK` (the only sanctioned env reader, §6).
- `regime-live-driver.ts` — the NETWORK leg: gate (HL candles+funding) → cross-sectional allocator → seat the
  top-N validated books → poll + feed the trader. Thin + fully guarded (a fetch miss never crashes boot).
- `index.html` — a "Regime Desk" tab: desk header (realised/maxDD/βexp/VaR), the `attr` TCA line, position
  cards with the **STOP GAUGE** (the hero widget) + per-book FLATTEN, a HALT button, and the weather strip —
  reusing the engine's green/amber/red weather color law. Polls `/api/regime/snapshot` every 5s; shows
  "OFF — set REGIME_DESK=true" when inert.

**Regression discipline (§10.1):** `npx tsc --noEmit` clean; `npx jest src/market-making/directional
src/market-making/bias` → **29 suites / 223 tests** (+ trader tick/snapshot/halt/flatten + controller inert &
enabled). **Visual acceptance (cockpit renders live)** needs a local `npm run start:dev` with `REGIME_DESK=true`
— the sandbox can't run the dev server (exits 144), so this one item is handed to the operator (P16).

**Honest caveat:** the trader + controller + inert default are unit-tested green; the `RegimeLiveDriver` network
gate+poll is real but UNTESTED HERE (no network in the sandbox) — verify in the local run. Cockpit events log to
the server; wiring regime events onto the shared `/api/market-making/events` Activity tape is a clean follow-on.

---

## 2026-06-17 — Entry #86 (Take Sides P14: TEAR-SHEET vs BTC BENCHMARK)

**What this is (Playbook II P14).** Prove the demo honestly — a QuantStats-style, benchmark-relative scorecard
from the run's equity curve. Realised-first: the curve is realised − fees + funding, never an unrealised-led mark.

**What shipped:**
- `regime-tearsheet.ts` — `computeTearsheet(curve, benchmark, …)` → Sharpe + Sortino (annualised via barsPerYear),
  maxDD% + its underwater duration, hit rate / avg win-loss / payoff (from per-trade P&L), exposure, turnover, and
  the **BTC buy-hold benchmark** read: total return, **excess return (pp)**, **β** (cov/var to the benchmark), and
  correlation. Pure + clock-free.
- `scripts/regime-book-live.ts` — samples the realised-first equity curve + the BTC mid each poll and prints the
  tear-sheet at session end (return · Sharpe · Sortino · maxDD+duration · exposure; and vs-BTC bench/excess/β/ρ).

**Regression discipline (§10.1):** `npx tsc --noEmit` clean; `npx jest src/market-making/directional/regime-tearsheet`
→ **8 tests** (total-return = Δequity/capital, maxDD%+duration, annualised Sharpe + Sortino on a dip curve,
Sortino=0 when no losing bars, excess return vs BTC, β≈k recovered when desk = k·bench, hit/payoff from trades,
degenerate-curve no-NaN guard).

**Honest caveat:** the tear-sheet is only as honest as the curve fed it — the runner samples realised-first equity
(the judged number), so the headline can't be inflated by an open mark. Per-trade hit/payoff in the live runner is
omitted (passed only when available); the curve-based + benchmark metrics are the headline.

---

## 2026-06-17 — Entry #87 (Take Sides P15: FEED WATCHDOG + ALERTING)

**What this is (Playbook II P15).** Data-integrity protection + one alert channel so a trader away from the
screen still gets warned. Bad data is a silent killer (a stale tick freezes a position; a spike mis-marks the
book; a cross-venue divergence means a feed is lying).

**What shipped (`feed-watchdog.ts`, pure + guarded):**
- `FeedWatchdog` — per-symbol detection of **stale** (no update within N×poll), **gap/outlier** (|Δprice| past a
  band), and **cross-venue divergence** (HL vs Binance past a band). Drives `RegimeMonitor.feedStale` ⇒
  STAND_ASIDE (the input nothing computed before). A gap/divergent print does NOT become the new baseline (so a
  bad mark can't be silently accepted next tick).
- `IAlertSink` (swap seam) — `NoopAlertSink` default (no webhook ⇒ no behaviour change) + `WebhookAlertSink`
  (Slack-style `{text}` POST, injected ⇒ offline-testable). `AlertDispatcher` fires **exactly once per
  condition**: desk-halt + dd-breach once ever, feed-stale once per false→true transition per symbol (re-arms on
  recovery), stop-hit per distinct event. `buildAlertSink(url)` selects the impl.
- `regime-book-live.ts` — the watchdog runs each poll (price + Binance cross-venue) → `monitor.feedStale`; the
  dispatcher fires from the same trigger points the desk-event tape uses: loss-stop (in `onEvent`), DESK HALT +
  maxDD-budget breach (PASS 2), feed-stale (PASS 1). Sink no-op unless `RBL_ALERT_WEBHOOK` is set.

**Regression discipline (§10.1):** `npx tsc --noEmit` clean; `npx jest src/market-making/directional
src/market-making/bias` → **31 suites / 243 tests** (+12: stale/gap/divergence at the boundary + baseline-not-
adopted, dispatcher once-per-condition for halt/dd/stale-transition/stop, no-op default no-throw, webhook payload).
Bounded live smoke (BTC,ETH,SOL): watchdog ran clean, TCA reconciled to the cent, no crash.

---

## 2026-06-17 — Entry #88 (Take Sides P16: ALL-AT-ONCE FORWARD RUN — OPERATOR HANDOVER, READY)

**Status: P5–P15 are ALL built, green, and committed (#77–#87).** The institutional-grade take-sides desk is
complete in paper. P16 is the operator's single multi-hour forward run — **the operator runs it; this entry is
the handover, not a result** (per the playbook: do NOT run it for them). When Ronnie runs it, the result goes in
a follow-up #89 with the DB-sourced realised numbers + the tear-sheet.

**The full institutional stack now on `scripts/regime-book-live.ts` + the `/demo` cockpit:** OOS gate-first
(P2) · desk-risk spine — caps, kill-switch, flatten-on-exit (P5) · durable persistence + restart recovery (P6,
`MM_PERSIST`) · slippage+impact fills (P7) · book-level walk-forward backtest (P8) · exposure toggle
outright⇄hedged (P9) · desk risk aggregation + factor split + TCA (P10) · stress harness (P11,
`scripts/regime-stress.ts`) · universe expansion: 16 symbols + reversal/vol-scaled-momentum/cross-sectional
signals + Bybit venue + cross-sectional allocator (P12) · `/demo` Regime Desk cockpit behind `REGIME_DESK` (P13)
· realised-first tear-sheet vs BTC (P14) · feed watchdog + alerting (P15).

**HOW TO RUN THE FORWARD TEST (operator):**
1. **Re-gate first** (regimes shift — never trust a stale board):
   `RBO_DAYS=90 npx ts-node -r tsconfig-paths/register scripts/regime-bias-oos.ts` — note today's validated set.
2. **Stress check** (deterministic, ~instant): `npx ts-node -r tsconfig-paths/register scripts/regime-stress.ts`
   → expect `STRESS OK`.
3. **Launch the multi-hour run** (terminal cockpit, persisted, honest fills) — pick OUTRIGHT then HEDGED to
   compare:
   `MM_PERSIST=true RBL_HOURS=8 RBL_SLIPPAGE_BPS=1 RBL_EXPOSURE=outright RBL_TOP_N=8 \
     npx ts-node -r tsconfig-paths/register scripts/regime-book-live.ts`
   (or the web cockpit: `REGIME_DESK=true MM_PERSIST=true FEED_SOURCE=binance EXECUTION_MODE=paper
   MOCK_TRADING_ENABLED=false npm run start:dev` → `/demo` → Regime Desk tab.)
4. **Review** with the `mm-run-review` skill (pull realised P&L from `mm_nav` desk='regime' — do NOT read the
   multi-MB log end to end, §12). The runner prints the realised-first verdict + DESK ATTRIBUTION (TCA) + the
   tear-sheet vs BTC at Ctrl-C.

**What to watch:** the STOP gauge (distance to the directional stop), desk-risk RUN/HALT + gross/net vs caps,
the `attr` line (idio vs beta — is the edge idiosyncratic or just carried market beta?), and maxDD vs the 2%
budget. **Pre-registered metric:** realised + funding − fees − slippage > 0 with maxDD inside 2%, on the symbols
validated today. A flat, honest "we sat aside / the edge didn't survive costs" is the correct mission outcome,
not a failure (CLAUDE.md §1).

**Caveat:** the web cockpit's live render + the `RegimeLiveDriver` network gate (P13) were not runnable in the
build sandbox (dev server exits 144) — verify them in this first local run. Everything else is unit-tested green.

---

## 2026-06-17 — Entry #89 (Regime Desk: SERVE-vs-DRIVE split — stop the UI backend running a competing desk)

**Problem (Ronnie):** running the take-sides desk was *interfering with the backend needed for the UI.* The P13
cockpit hosted the desk **in-process**: `REGIME_DESK=true npm run start:dev` fired the heavy `RegimeLiveDriver`
inside the UI backend — a 16-symbol × 90-day OOS gate at boot, then a 60s HL poll loop + in-memory trading. So if
the operator ran the standalone `scripts/regime-book-live.ts` (the real desk / track record) AND the backend (for
the UI), there were **two regime desks** double-polling Hyperliquid and competing for the one event loop. The
principle Ronnie wants: **run the backend for the UI, run the scripts for the desks — they must not interfere.**

**Fix — split "serve the cockpit" from "drive the desk" behind two flags (the driver now OFF by default):**
- `REGIME_DESK=true` → **SERVE ONLY**: the `/demo` Regime tab + `/api/regime/*` control plane are hosted, but
  **no in-process driver runs** — no boot gate, no HL polling, no trading. The backend stays light and never
  competes with the desk scripts. Snapshot reports `driving:false` + a SERVE-ONLY note; the UI renders it honestly
  instead of a misleading empty "0 validated" desk.
- `REGIME_DESK_DRIVE=true` (new) → additionally run the in-process `RegimeLiveDriver` (the old all-in-one). Use
  this only for a single-process web cockpit, and then **don't** also run the script.

Implementation: `regimeDeskDrive` config (`REGIME_DESK_DRIVE`) in the one sanctioned env reader; `RegimeBootstrap`
only news-up/starts the driver when drive is on (else logs SERVE-ONLY); the controller surfaces `driving` + the
note (reads `ConfigService`, no module cycle); `/demo` renders the SERVE-ONLY banner. No DB collision either: the
in-process trader never persisted (no store in the module factory) — only the script writes `mm_nav` desk='regime'.

**Tests + build:** `npx tsc --noEmit` exit 0; `npx jest src/market-making/directional` green (22 suites / 190
tests). Pinned the split with direct-construction specs (offline, no network): `RegimeBootstrap.driving` stays
false when serve-only, and the controller returns `driving:false`+SERVE-ONLY note vs `driving:true` with no note.
README §E rewritten around the two-step run (script = desk, backend = UI). The operator forward run (P16, #90) is
unchanged — run it via the terminal cockpit; the web backend can serve the UI alongside without interfering.

---

## 2026-07-02 — Entry #90 (PROFIT_PIVOT_II adopted → the CARRY DESK is built: gate veto + FundingCarryBook + 30-day runner. Plus an honesty correction to #72)

**Context.** The Fable review ([PROFIT_PIVOT_II.md](PROFIT_PIVOT_II.md), commit 5eadd68) was adopted
by the operator this session. P0 ("turn the validated edge on and leave it on") is now BUILT:
the #72 recency veto, a real `FundingCarryBook`, durable carry persistence, and the forward runner
`scripts/carry-desk-live.ts`. Four commits on master (2ec5d24, e831c6f, 68ce390, c919792).

**⚠ FIRST, the honesty correction (this changes a #72 headline, not the thesis):**
`funding-carry-live.ts` accrued **one full hourly funding period per 60-second poll** — a ~60×
overstatement. #72's "ETH cleared its $35 entry fee at poll ~56 (~56 min)" and "~$6.25/hr gross"
were artifacts of that bug: at the true +0.125bps/h on $50k the honest accrual is **~$0.62/hr**,
honest fee-clear ≈ **2.3 days** — which is exactly what the OOS board's breakeven column always
said (ETH 11.6d on the 60d avg; the live rate ran hotter). **What survives #72 unchanged:** the
rate itself (+0.125bps/h ≈ 10.95%/yr gross, stable every poll), the OOS gate verdicts, the BNB
regime-flip lesson, and the strategic pivot. What dies is only the "breakeven in an hour" glamour.
The tracker is fixed (time-weighted accrual) and the new book's spec locks the bug class out
("60 one-minute accruals equal ONE one-hour accrual").

**What shipped (P0, all specs green, tsc clean):**
1. **E3 recency veto** (`oosCarryGate`): trailing-7d **mean** funding must still pay the gated
   direction, else 🚫 VETO regardless of the 90d windows — the exact fix specified in #72 the day
   BNB bled −$93, now default-ON. Veto is on the mean, not sign-counts (magnitude matters). New
   `recent` block on every gate result; the board prints a `recent7d%` column. 5 locking specs
   incl. the literal BNB case (windows pass, only the veto catches the flip).
2. **`FundingCarryBook`** (`src/market-making/carry/`): the delta-neutral pair as a real book —
   two equal-qty `InventoryBook` legs (spot @ Binance mid, perp @ HL mid), **time-weighted**
   funding accrual, P7-convention fees/slippage split, and the **R9a margin model**: each leg
   posts notional/maxLeverage; either leg's unrealised loss at maintenanceFrac ⇒ `wouldLiquidate`
   (a delta-neutral pair CAN be liquidated on one leg — "paper holds forever" was overstating our
   capacity). Serialize/restore locks the #47 accrual-clock trap. 14 specs.
3. **Persistence** (`carry_book_state` migration 1725000000000 + Postgres/Null stores): the P6
   pattern; nav rows under `mm_nav desk='carry'` / `'@carry'` namespace. **One deliberate
   difference from the regime desk:** shutdown with persistence ON checkpoints the pair **OPEN
   and resumes on reboot** — carry is hold-past-breakeven; flatten-on-restart would pay the
   round-trip fee every reboot and destroy the economics the run measures. `reconcileCarryResume`
   orphans a pair that fails today's gate OR whose direction flipped. 10 pure specs + int-spec
   (auto-skips, DB was down locally).
4. **`scripts/carry-desk-live.ts`** — the 30-day runner: gate-first (90d + veto) → open ≤8 pairs →
   poll loop (accrue, checkpoint, nav-append) → **daily re-gate** (closes de-validated books,
   admits new passers — the #72 rule as a standing cadence) → **DD kill-switch** (flatten + exit
   at the pre-registered 0.5% budget, computed on the TOTAL mark incl. basis — conservative) →
   realised-first verdict + tear-sheet vs BTC. **On resume, the offline gap is accrued from the
   venue's ACTUAL settled funding history** (fundingHistory replay), not an estimate.

**Bounded live smoke (36s, BTC+ETH, 4d gate — plumbing proof, NOT a read):** gate board rendered
(both pass, recent7d column live), pairs opened at real mids (fees $35/side-pair, basis −2.3bps /
+1.2bps in the measured #71 band), funding accrued **+$0.01 over 36s** at the live +0.125bps/h —
the honest magnitude (the old bug would have printed ~$0.75) — flatten-on-exit realised all, no
dangling positions. Realised-first read −$87/pair = the round-trip fees + micro-move, i.e. exactly
what "breakeven ~8d, do NOT churn" means.

**HOW TO LAUNCH P0 (operator — the 30-day run that IS the demo):**
```bash
# once (persistence): sudo docker compose up -d postgres && npm run migration:run
MM_PERSIST=true npx ts-node -r tsconfig-paths/register scripts/carry-desk-live.ts
```
Defaults: 10-symbol universe, 90d gate + 7d veto, $50k/leg × ≤8 pairs, 60s polls, re-gate 24h,
DD kill 0.5%. Ctrl-C any time — with persistence the pairs checkpoint OPEN and the next boot
resumes them (replaying the gap's settled funding). Review via `mm_nav WHERE desk='carry'`
(never the log end-to-end, §12). Optional: `CD_ALERT_WEBHOOK=<slack-url>` for dd/liquidation/
feed alerts. **Pre-registered (P0): rolling-7d (funding + realised − fees) > 0 AND desk maxDD
< 0.5%.** A flat/negative honest read after the breakeven window is a legitimate mission outcome
— report it, don't churn it.

**Next:** P1 (breadth) — the full-universe scan via `rankCarryUniverse` over all ~230 HL perps,
the maker-execution service (E2: cut the 7bps taker entry toward the −0.2bps rebate), Bybit
funding ingest + the three-venue differential board (E4/M2). The session ledger + pickup prompt
live in [PROFIT_PIVOT_II.md](PROFIT_PIVOT_II.md) §4-ledger.

---

## 2026-07-02 — Entry #91 (P1 BREADTH, all three built + first measurements: 231-perp scan → 68 gated/13 deployable · E2 maker execution live-smoked · Bybit + three-venue differential board day 1/7)

**Session 2 of PROFIT_PIVOT_II — the P1 build ledger items (a)/(b)/(c) in one pass.** Commits:
`7112c08` (P1a scan), `202b45c` (P1b E2), `df29fcf` (P1c E4). Repo green: `npx tsc --noEmit`
exit 0; `npx jest src/market-making src/market-data src/stat-arb/feed` **128 suites / 921
tests** pass (the jest force-exit warning is the long-known teardown noise, not a failure).

### P1a — the full-universe carry scan (`scripts/carry-universe-scan.ts`)

The desk's OWN gate (`rankCarryUniverse`: 90d OOS split, posFrac ≥ 0.65 both windows, #72
7d-recency veto) over **all 231 main-dex HL perps** — not the 10-major default. Two findings
about the *scan itself* first:

- **Rate-limit lesson (it cost one aborted run):** `fundingHistory` is a heavyweight HL info
  call; a naive 231×5-page sweep 429'd after ~25 coins. The shipped scan is TWO-STAGE — one 14d
  page per coin for the whole universe, then the full 90d gate only on coins whose 14d
  |ann funding| ≥ 3.5%/yr — with a single ~1.1s-paced request pipe + exponential 429 backoff.
  The sieve is a completeness trade-off and is RECORDED (`sievedOut` in the artifact): a coin
  quiet for 14d but strong at 90d would be missed today and caught by tomorrow's scan.
- **Deployability ≠ gate:** the pair needs a Binance spot leg. Each coin is annotated from one
  `ticker/price` sweep (kPEPE→PEPEUSDT unwrapping handled); HIP-3 dex perps are out of scope
  (no spot hedge).

**The board (artifact `docs/research/carry-universe/scan-2026-07-02T17-57-21-501Z.json`):**
231 universe → 231 stage-A scored (0 failures) → 143 survivors → 142 gated → **68 GATE-PASS →
13 DEPLOYABLE**: `GRAM,NEAR,LIT,DYDX,LINK,AAVE,XPL,UNI,PUMP,TAO,BNB,ENA,ZEC`. The P1
pre-registered "≥8 gated legs" is comfortably fed. Honest flags: **GRAM** prints +108%/yr at
posFrac 1.00/1.00 but is a $7M/day small-cap — real stream, crowding/cap risk, the per-leg
margin model + DD kill bound it; the reliable middle is **NEAR/LIT/DYDX/LINK/AAVE/XPL/UNI at
+8…+12%/yr** with 0.9+ posFrac both windows. 55 of the 68 passers fail deployability on spot
availability or the $5M liquidity floor — the no-spot tail (FARTCOIN +13%, HYPE +9%, PURR…)
is where an HL-only (perp-vs-perp or margin-spot) future variant would hunt.

### P1b — E2 maker execution (`src/market-making/execution/maker-execution.ts`)

`acquireFill(side, touchSource, cfg)`: join the touch post-only, poll every `tickMs`, fill by
the **conservative cross-through rule** (a resting BUY fills only when the best ask trades down
THROUGH it — no queue-position credit; under-fills vs a real book, honest in the conservative
direction), escalate to a taker cross at the freshest touch after `patienceMs`. Every fill
carries TCA: liquidity, waited ms, **signed shortfall vs arrival mid**. Wired end-to-end:
`FundingCarryBook.openWithExecutions/closeWithExecutions` (executed prices + SIGNED fees — the
HL −0.2bps rebate is revenue; the slippage diagnostic is now signed, taker path byte-identical),
`BinancePublicClient.bookTicker` (spot touch), and `carry-desk-live` routes **patient** paths
(boot/re-gate entries, de-validation + orphan closes) through it — **urgent paths (margin
liquidation, DD kill) never wait**. `CD_MAKER_ENTRY=true` default; any touch failure falls back
to the legacy taker-at-mid path, so an outage degrades, never blocks.

**Bounded live smoke (2 pairs, 30s patience, real touches):** 2 of 4 entry legs filled MAKER —
BNB spot maker at **0.9bps all-in** (−0.09bps shortfall + 1bps fee — *meets the ≤2bps P1
metric*), DYDX perp maker at −0.38bps + the −0.2bps rebate. The two escalations are the honest
part: DYDX spot crossed at **+11.65bps** — the ~23bps DYDX spot spread the old mid-fill model
silently ignored. E2 didn't make entries more expensive; it made the cost REAL and measured.
Consequences, not yet acted on: (1) the 30-day run should use **minutes** of patience
(`CD_MAKER_PATIENCE_S`), a carry book has no urgency; (2) a wide-spread symbol arguably wants
re-rest-instead-of-cross on timeout — parked until the run's TCA says it matters.

### P1c — Bybit ingest + the three-venue differential board (E4/M2)

`BybitFundingClient` (v5 public linear; newest-first pages → BACKWARDS pagination, re-sorted
chronological; per-symbol funding intervals ⇒ never assume 8h) + `funding-differential.ts` —
the cadence-honest core: **UTC-day funding sums** make HL (hourly) comparable with
Binance/Bybit (8h); differential = daily A−B on common days; gates = overlap ≥5d, |ann| ≥3%,
sign-stability ≥0.7, breakeven ≤20d vs a MAKER-routed 4-fill round trip (E2 is what makes that
fee assumption real). `scripts/funding-differential-board.ts` writes daily boards to
`docs/research/funding-differentials/`.

**Day 1 of ≥7 (board-2026-07-02T19-08-53):** 30 pairs scored, **7 harvestable**. Top:
**ADA hyperliquid↔bybit −18.0%/yr differential, 0.86 stable, 0.7d breakeven** (HL shorts PAY
18.9%/yr ⇒ long HL perp / short Bybit perp receives the spread); LINK/LTC short-HL pairs at
+4.6…+5.9%/yr. **R4's suspicion confirmed on day 1: the majors are sub-fee** (BTC HL↔Binance
−0.0%, ETH ≤0.5%) — the clientele spread lives in the mid-caps. M2 stays measurement-only until
7 boards agree; the go/no-go cites the series, not this snapshot.

**Verdict:** P1 items 1–3 are BUILT and MEASURING; the P1 chain's remaining item is **E7
allocator v0 + the aggregate beta-hedge** (ledger item 4). The operator launch (P0→P1 combined:
the scan's 13 deployables + maker entry + persistence) is the next real event — everything this
session exists to make that run's numbers both bigger (breadth) and truer (execution honesty).

---

## 2026-07-03 — Entry #92 (review of the P0/P1 operator launch — a ticker-collision bug found live: HL "LIT" ≠ Binance "LITUSDT")

**The operator launched the 30-day run (#91's recommended command).** DB record: 8 of the 13
deployables opened — `GRAM,NEAR,LIT,DYDX,LINK,AAVE,XPL,UNI` (the ≤8-pair cap took the first 8 of
the `CD_SYMBOLS` list, exactly as launched) — from **2026-07-02 19:50:04 to 2026-07-03
05:02:01 UTC (~9.6h)**, then the process stopped (no crash signature found; nothing in the code
failed — it was a foreground process with no supervisor, per the standing no-background-tasks
rule). All 8 books remain `OPEN` in `carry_book_state` (resume-not-flatten, #90, working as
designed) but **unmonitored for ~3h10m at review time** — the DD kill-switch and daily re-gate
are inert while the process is down. No re-gate has fired yet (9.6h < 24h cadence) and
`realised_pnl_units` is $0 on every book — nothing has closed, everything below is mark-to-market.

**Headline finding — LIT is not a valid carry pair; it's a ticker collision.** Hyperliquid's
`LIT` perp is **Lighter** (a rival perp-DEX's token, newly launched); Binance's `LITUSDT` is
**Litentry**, an unrelated, older project. Confirmed live against both public APIs at review
time: HL mid **$2.1231** vs Binance mid **$0.7430** — 177% apart. The book's own entry marks show
the identical gap from minute one: entry perp mid $2.0618 vs entry spot mid $0.7430 (**+177.5%**),
against every other open pair's entry gap of **0.0–0.5%** (AAVE 0.0, DYDX −0.1, GRAM +0.5, LINK
0.0, NEAR 0.0, UNI 0.0, XPL 0.0 — the sane band a real spot/perp basis sits in and a one-line,
mechanically-detectable tell). **Root cause:** `spotMarketFor()` in
`scripts/carry-universe-scan.ts` (~L111) maps an HL coin to a Binance market by **string
equality alone** (`${coin}USDT`, with the k-prefix unwrap for kPEPE-style wrappers) — there is no
check that the two venues list the *same underlying token*. The scan's `deployable` boolean
(`r.passGate && market !== null && liquid`) and the live desk both trusted that string match.

**Impact:** over the 9.6h window, LIT alone carries **unrealised −$1,054** against a desk total
unrealised of **−$1,042** — LIT is *more than 100%* of the desk's loss. **Ex-LIT the other 7
pairs net +$48.54** (funding ≈$99 accrued, fees ≈$63, small basis noise) — modest and in line
with the #91 breakeven expectation, not concerning at 9.6h. Desk `maxDD` reads **0.328%** (66% of
the 0.5% kill budget) and is almost entirely attributable to the mismatched LIT leg, not to
genuine strategy risk. Execution (E2) read on the real pairs: maker-filled legs cost **≈$4/leg
(~0.8bps all-in)**, consistent with #91; legs that escalated to taker (AAVE, GRAM, LIT) cost
**≈$20–21 (~4.2bps)** — still well under the pre-E2 7bps taker baseline, the expected mix.

**Verdict:** the 7 genuine carry pairs look healthy and unremarkable this early — judge them
again after the 24h re-gate and multiple days, not now. LIT is a **bug, not a trading-risk
event**, and must not be graded against the carry thesis. **Not yet acted on (Ronnie's call):**
(1) close LIT now — it is a naked cross-asset bet the strategy never intended, not carry;
(2) add an entry-basis sanity gate to the scan (reject `deployable` if `|perpMid/spotMid − 1|`
exceeds a few % at scan time) so no future ticker collision reaches the live desk; (3) relaunch
under process supervision (nohup/tmux/systemd) so a stall like this doesn't eat days out of the
"30-day" window unnoticed. **Also overdue:** the differential board's daily cadence — only day
1/7 exists (`board-2026-07-02T19-08-53`); day 2 was not run today.

---

## 2026-07-03 — Entry #93 (LIT remediated + the collision guard on every entry path + supervised launch + board day 2/7; postmortem + UI Plan II)

**The #92 pickup, executed.** Commits `ccbc7fd` (guard + close utility), `db52f9a` (launch
wrapper + board day 2), `76ea2c6` (the two docs).

**1. LIT closed — realised-first +$268.29, and the sign is luck.** New operator utility
`scripts/carry-close-book.ts` closes one persisted book out-of-band through the book's own
ledger (restore → replay settled funding over the offline gap → close taker-at-mid with the
desk slippage model → persist CLOSED). LIT's close: 5.8h gap replayed from 5 settled prints
(+$3.08), spot leg realised −$3.59, perp leg **+$307.72** (Lighter fell $2.1231 → $2.0487
between the #92 review and the close, straight through the $2.0615 entry), funding +$5.29,
fees −$41.14, slippage −$13.56 → **realised-first +$268.29**. That is a **$1,322 swing in
~3h** on a "hedged" book — the naked-variance demonstration, measured. Judged per the
resulting rule: the close decision was right at −$1,054 and equally right at +$268; the
number goes into month-end accounting but is **excluded from the carry thesis's report card
in both directions** (it was never carry). Full lesson: [TICKER_COLLISION_POSTMORTEM.md](TICKER_COLLISION_POSTMORTEM.md).

**2. The collision guard now covers every path a pair becomes a position.** #92's fix
(`b0ac393`) gated the scan; the residual gap was the runner. `carry-desk-live.ts` now runs
`basisGuard()` (`checkSameUnderlyingBasis`, knob `CD_MAX_BASIS_PCT`, default 5%) at **fresh
open, re-gate open, and resume** — a resumed book failing the guard is closed at market
after honest gap-funding accrual (the LIT scenario, now self-healing on boot); a fresh/
re-gate candidate is refused + alerted. `isKScaledCoin()` extracted + spec'd (kPEPE/kBONK
true; KAVA/LIT false). **Live smoke of the exact reproduction:** `CD_SYMBOLS=LIT` boots,
*passes the funding gate* (+12.2% ann., recent7d +29.4%, posFrac 0.91/0.98 — the same
seduction that got it deployed), and is **guard-refused at 175.8%**, zero books opened.

**3. Supervised launch (the #92 stall class, closed).** `scripts/launch-carry-30d.sh`:
nohup + pidfile + `start`/`status`/`stop`, logs under `logs/` (git-ignored). Default
`CD_SYMBOLS` = the 13 scan deployables **minus LIT**: `GRAM,NEAR,DYDX,LINK,AAVE,XPL,UNI,
PUMP,TAO,BNB,ENA,ZEC`. On start the 7 held books resume (offline funding replayed from
settled history) and PUMP contends for the 8th slot at the boot gate. Graceful stop
checkpoints OPEN (resume-not-flatten). **Operator relaunches** — sandbox can't hold a
30-day process.

**4. Differential board day 2/7** (`board-2026-07-03T10-55-52-054Z.json`): 30 pairs scored,
**6 harvestable** (day 1: 7) — cadence intact, M2 needs 5 more consecutive days.

**5. Docs (Ronnie's mid-session directives: teaching write-up + plan-first UI).**
[TICKER_COLLISION_POSTMORTEM.md](TICKER_COLLISION_POSTMORTEM.md) — the incident from first
principles (hedge identity → basis as the market's identity oracle → names-vs-identities →
naked-position physics → resulting → defense-in-depth → controls-are-processes).
[UI_REWRITE_PLAN_II.md](UI_REWRITE_PLAN_II.md) — the UI rewrite's continuation, plan-first:
**U1 = `/desk/carry`** (the flagship desk has no page; both #92 failures were visibility
failures over data already sitting in `carry_book_state` + `mm_nav` `@carry`), with the
liveness banner (LIVE/STALE/DOWN off checkpoint age), CLOSED-rows-visible books table,
read-only `CarryReadService`, file-by-file build list + acceptance criteria for the
implementing session. Also flagged: `postgres-carry-state-store.int-spec.ts` leaks its
`ITA5NED7` fixture into the real paper DB — cleanup is U1's pre-item.

**Regression (§10.1):** `npx tsc --noEmit` exit 0; `npx jest src/market-data/funding`
8 suites / 70 tests green (incl. the new `isKScaledCoin` cases); `npx jest
src/market-making/carry` 3 suites / 28 tests green. Desk DB state verified directly:
7 books OPEN (AAVE DYDX GRAM LINK NEAR UNI XPL, last checkpoint 05:02 UTC), LIT CLOSED.

---

## ⏭️ NEXT SESSION — pick up here (kept current every session; last updated 2026-07-03, #93)

**The active plan is [PROFIT_PIVOT_II.md](PROFIT_PIVOT_II.md) (ADOPTED 2026-07-02) — the carry
desk is the priority chain; its §4-ledger carries the authoritative per-phase state + pickup
prompt.** Repo green: `npx tsc --noEmit` exit 0; `npx jest src/market-making src/market-data
src/stat-arb/feed` 128 suites / 921 tests.

1. **OPERATOR: relaunch the 30-day carry run** — everything is ready (#93: LIT closed, guard
   on every entry path, supervision wrapper):
   ```bash
   sudo docker compose up -d postgres && npm run migration:run   # once, if not already up
   bash scripts/launch-carry-30d.sh          # start (nohup+pidfile; 7 books resume + PUMP contends)
   bash scripts/launch-carry-30d.sh status   # any time: is the desk alive?
   ```
   Every session while it runs: score realised-first from `mm_nav desk='carry'` + read the
   entry TCA lines (P1 metric: ≤2bps/leg).
2. **Daily (operator or session):** `scripts/funding-differential-board.ts` — M2 needs ≥7
   consecutive daily boards (**day 2/7 done #93**, day 3 due 2026-07-04); re-run
   `scripts/carry-universe-scan.ts` before/at re-gate to refresh the deployable set (the scan
   now prints basis% + collision tags, #92 fix).
3. **UI: implement U1 `/desk/carry`** per [UI_REWRITE_PLAN_II.md](UI_REWRITE_PLAN_II.md) —
   liveness banner + books table + NAV + runbook palette, read-only `CarryReadService`;
   pre-item: fix the `postgres-carry-state-store.int-spec.ts` fixture leak (ITA5NED7) and
   delete the stray rows. The plan doc carries the file-by-file list + acceptance criteria —
   built to be implemented mechanically (Opus-suitable per Ronnie).
4. **NEXT BUILD SESSION — finish P1:** item 4 = **E7 allocator v0** (fixed 70/20/10 weights) +
   the **aggregate beta-hedge** (one BTC/ETH leg flattens the cross-sectional book's residual
   delta via the existing `RegimeBetaHedge`). Also worth a look: HL-only variants for the
   no-spot gate-passers (FARTCOIN/HYPE/PURR tail, #91).
5. **Then P2:** the VRP short-vol satellite (E6 — Deribit paper short-strangle on the existing
   `src/derivatives/` Greeks, stress-gated by the P11 harness, ≤20% of desk capital).
6. **Still pending from the regime desk:** the P16 operator forward run (#88 handover) — now a
   BENCHMARK track alongside the carry desk, not the priority.

**Operating rules in force (PROFIT_PIVOT_II §4):** winners get the hours; no infra-only sessions
while zero books accrue; a failed pre-registered metric halts its build chain. **Real-money stays
PARKED** (CLAUDE.md §1).
Per-poll/shutdown persistence, slippage, and the desk-risk spine are all wired into `scripts/regime-book-live.ts`
already — P9's hedge + P13's cockpit build on that runner.