# Directional-Bias OOS Results — does the candidate bias predict FORWARD return?

> **Status:** gate harness BUILT + unit-tested (2026-06-07). The RESULTS TABLE below
> is **PENDING a real-data run** — this session's sandbox has **no network**, so no
> live HL/Binance history could be fetched here. The methodology, the pure math, and
> the runnable sweep are complete and green; the operator runs **one command**
> (bottom of this doc) on a networked host to fill the numbers in. **Any number shown
> as an illustrative row is labelled SYNTHETIC and must not be acted on.**

This is the **honesty gate** before the desk runs the **axed (directional) market
maker** ([DIRECTIONAL_MM_STRATEGY.md](DIRECTIONAL_MM_STRATEGY.md) §9): the directional
book rests at a target inventory `q* = bias·Q_max`. A bias is *alpha*, and "a blind
bias is just a leveraged way to lose", so **no bias sizes live carry until it shows a
positive OOS forward-return correlation, per coin / per asset class, after the
multiple-testing haircut.** This doc measures exactly that and hands back the verdict
table the desk uses to **set** (or refuse) a directional bias.

---

## 1. What is tested (two interpretable signals — no ML, CLAUDE.md doctrine)

| # | Signal | The directional claim | Bias `b` fed to the gate |
|---|---|---|---|
| 1 | **Funding-carry sign** ("be long the funding-PAID side") | On a perp, **+funding ⇒ longs pay ⇒ SHORT is the paid side**. The claim is that *leaning the paid side predicts forward price return* — a **distinct** claim from merely harvesting the carry. | `b = −trailing-mean(funding/hr)` over a 24h window (matches `FundingBiasSource`). A **positive IC** ⇒ the paid-side lean predicts forward return. |
| 2 | **Momentum / trend** | The trailing L-bar return predicts the forward return (a simple, interpretable trend follow). | `b = trailing log-return` over lookback L (24h, 72h). Positive IC ⇒ trend persists. |

Horizons tested: forward returns at **8h, 24h, 72h, 168h** (hours→days — the bias'
daily/weekly scope). Momentum lookbacks: **24h, 72h**.

**The funding caveat (binding):** funding-as-*direction* is NOT the same as
funding-*carry harvest*. The carry board ([funding-carry-discovery](../src/market-data/funding/funding-carry-discovery.ts))
already says funding carry is *real but modest* (~3–8%/yr on majors) — that is a
delta-neutral harvest. Here we ask the **different** question: does the funding sign
*also* predict the directional price move? Only the **forward-return prediction**
counts for sizing `q*`. A signal can be a good carry harvest and a useless direction
signal (or vice-versa).

---

## 2. Method (honest, OOS — this is the whole point)

1. **No look-ahead.** Every signal at bar `t` is computed from data **up to `t`
   only** — a *trailing* funding mean and a *trailing* momentum return. The label is
   the realised **forward** log-return `log(P_{t+h}/P_t)`.
2. **Effect size = Information Coefficient.** Pearson **and** Spearman (rank) IC of
   `corr(signal, forwardReturn)`. Spearman is the headline (robust to fat tails).
3. **Direction-only P&L stream.** Per observation, `pnl = sign(b)·forwardReturn` — what
   a fixed-size bias on the signal's side would earn that step. Its mean/σ is a
   per-observation **Sharpe** we feed to the repo's existing deflated-Sharpe engine.
4. **Purged k-fold + embargo** ([purged-kfold.ts](../src/stat-arb/research/purged-kfold.ts),
   reused). 5 folds; each fold's test block is scored on its own observations only,
   with the **embargo widened to cover the forward horizon** so a multi-bar forward
   label never leaks into a neighbouring fold (the real leakage source in a
   horizon>1 forward-return study). OOS observations are pooled.
5. **Multiple-testing correction** ([deflated-sharpe.ts](../src/stat-arb/research/deflated-sharpe.ts),
   reused — *not reinvented*). We test **coins × signals × horizons** trials, so the
   raw best is selection-biased. We report the **Deflated Sharpe**: PSR against
   `E[max Sharpe]` over the full trial count, with σ_SR = the **cross-trial Sharpe
   dispersion** measured in the same sweep. **We report the deflated number, not the
   best raw one.**
6. **Verdict.** `VALIDATED` only when (a) ≥30 pooled OOS observations, (b) the OOS
   mean direction-P&L is **positive** AND the Spearman IC is **positive**, and (c) the
   **Deflated Sharpe ≥ 0.95**. PSR<0.90 with a positive raw edge ⇒ `NOT_VALIDATED`
   (noise); positive edge + PSR ok but DSR short of the bar ⇒ `INCONCLUSIVE`.

Pure core: [`src/market-making/bias/oos/forward-return-ic.ts`](../src/market-making/bias/oos/forward-return-ic.ts)
(+ specs). Sweep: [`scripts/directional-bias-oos.ts`](../scripts/directional-bias-oos.ts).

---

## 3. RESULTS TABLE — per coin (PENDING real-data run)

> **The table below is a TEMPLATE with the exact columns the sweep emits.** Run the
> command in §6 to populate it. Columns: `spearIC` = pooled OOS Spearman IC;
> `meanPnL` = mean direction-only P&L/obs (bp); `psr` = P(Sharpe>0); `dsr` = Deflated
> Sharpe over all trials; `verdict`; `bias` = recommended **sign** + magnitude cap
> `|b| = clamp(4·|IC|, 0, 0.5)` if VALIDATED.

| coin | class | signal | fwd | n | spearIC | hit | meanPnL | psr | dsr | verdict | bias |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BTC | majors | funding-paid-side | 24h | — | — | — | — | — | — | _pending_ | — |
| BTC | majors | momentum-24h | 24h | — | — | — | — | — | — | _pending_ | — |
| … | … | … | … | … | … | … | … | … | … | … | … |

### Illustrative SYNTHETIC sanity rows (NOT market data — do not act on)

The offline unit tests plant known structure to prove the gate's discrimination:

| series (synthetic) | signal | verdict | why |
|---|---|---|---|
| trending price (regime-persistent drift) | momentum-24h | **VALIDATED** | trailing return predicts forward — the gate fires when the edge is real |
| mean-reverting price | momentum-24h | **NOT_VALIDATED** | trailing return predicts *against* forward — correctly rejected |
| price ⟂ random funding sign | funding-paid-side | **NOT_VALIDATED** | no relation ⇒ no validation, even before the haircut |

These confirm the gate VALIDATES a real edge and REJECTS noise / anti-signal. The
**real-market verdict is unknown until the §6 run.**

---

## 4. RESULTS TABLE — per asset class (PENDING)

The class row is the **n-weighted aggregate** of its coins' OOS reports. A class
`VALIDATED`s only when the weighted edge is positive AND a **majority of its coins
individually validated** (no single coin carrying the class). We deliberately do
**not** assert a class-level Deflated Sharpe — cross-coin correlation shrinks the
effective `n`, so the **per-coin DSR is the rigorous read** and the class row is the
diversified-direction summary.

| class | signal | fwd | coins validated | spearIC (wtd) | meanPnL | verdict |
|---|---|---|---|---|---|---|
| majors | funding-paid-side | 24h | —/5 | — | — | _pending_ |
| majors | momentum-24h | 24h | —/5 | — | — | _pending_ |
| alts | funding-paid-side | 24h | —/4 | — | — | _pending_ |
| alts | momentum-24h | 24h | —/4 | — | — | _pending_ |

---

## 5. How the desk reads this (the action)

- **VALIDATED (per coin, a horizon):** the desk MAY set `FundingBiasSource.validated=true`
  (signal 1) or wire a momentum bias source for that coin, at the **recommended sign**
  and **|b| ≤ the magnitude cap**. The cap `4·|IC|` (≤0.5) keeps even a strong one-window
  read well below full inventory — `q*` is a *tilt*, not a max-long bet. The directional
  stop in `CompositeRiskGate` still gates the live carry.
- **INCONCLUSIVE:** keep the source `validated=false` (neutral MM). Re-run on a longer
  window / forward paper before licensing carry.
- **NOT_VALIDATED:** **STAND ASIDE — `b=0` (neutral GLFT).** The signal does not predict
  forward return; leaning the book on it is leverage on noise. This is the **default**
  and is what `FundingBiasSource` ships as (`validated=false`) until this gate flips it.

**Prior from the carry research:** funding *carry* is real-but-modest and its *sign is
persistent* on majors — but persistence of the carry sign is **not** evidence the sign
predicts the directional move. Expect the funding-as-direction signal to be **weak**;
treat a `VALIDATED` there as the surprise that must clear the full DSR bar, and a
`NOT_VALIDATED` as the prior-consistent, honest default. Momentum at daily/weekly
horizons is the more plausible validator on majors; both must clear the same bar.

---

## 6. Operator command — run the sweep on REAL data

DB-free, no API key. Hyperliquid public candles + hourly funding (the desk's MM
venue) by default; `DBO_SOURCE=binance` for Binance spot + USDⓈ-M funding.

```bash
# Default: 180d × 1h, majors+alts, forward 8h/24h/72h/168h, 5-fold purged.
npx ts-node -r tsconfig-paths/register scripts/directional-bias-oos.ts

# Explicit (the headline run):
DBO_DAYS=180 DBO_INTERVAL=1h DBO_FWD_HOURS=8,24,72,168 \
  DBO_MOM_LOOKBACK_HOURS=24,72 DBO_FUNDING_WINDOW_HOURS=24 \
  DBO_MAJORS=BTC,ETH,SOL,BNB,XRP DBO_ALTS=AVAX,LINK,ARB,DOGE \
  npx ts-node -r tsconfig-paths/register scripts/directional-bias-oos.ts

# Cross-check on Binance data:
DBO_SOURCE=binance npx ts-node -r tsconfig-paths/register scripts/directional-bias-oos.ts
```

It prints the per-coin and per-class tables and writes the full result to
`docs/research/<ts>-directional-bias-oos-<source>.json`. Paste the per-coin /
per-class tables into §3 / §4 and flip the verdict cells.

### Limitations / caveats

- **Window length.** HL `candleSnapshot` returns the most-recent `limit` candles
  (hourly ⇒ ~months in one request); for longer than HL serves, use `DBO_SOURCE=binance`
  (paginated `historicalKlines`, multi-year). The verdict is a function of the window —
  state it. A single window is one regime; **forward paper is the ultimate verdict**.
- **HL funding is HOURLY** (`HYPERLIQUID_PERIODS_PER_YEAR = 8760`); Binance is 8h.
  The signal is the trailing **mean** rate, so it is comparable across venues, but the
  per-settlement magnitudes differ — read the sign + the IC, not the raw bp.
- **Selection haircut is honest only if `trials` reflects the WHOLE sweep.** The script
  counts every (coin, signal, horizon) trial and deflates by the cross-trial σ_SR
  measured in the same run — do **not** cherry-pick one horizon and report its raw IC.
- **This is signal validation, not a P&L backtest.** A `VALIDATED` licenses a sized,
  stop-gated directional tilt; it does **not** claim the live MM engine is profitable.
  The spread/rebate/adverse terms are judged elsewhere (the MM tape + γ/κ sweep).
