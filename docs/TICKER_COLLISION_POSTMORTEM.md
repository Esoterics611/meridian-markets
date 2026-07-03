# The LIT Affair: a first-principles postmortem of a ticker collision

*Meridian Markets — 2026-07-03. Companion to Journal #92/#93 and commits `b0ac393`,
`ccbc7fd`. Written as a teaching document: the incident is small (paper money, one book,
one day), but every lesson in it is the full-size version of something that ruins real
desks.*

---

## 0. What happened, in five lines

On 2026-07-02 the carry desk opened what it believed was a delta-neutral funding-carry
pair on "LIT": short the Hyperliquid `LIT` perpetual, long Binance `LITUSDT` spot,
$50k a leg. The two legs were **different assets** — Hyperliquid's `LIT` is *Lighter*
(a rival perp-DEX's token); Binance's `LITUSDT` is *Litentry* (an unrelated, older
project). The desk had accidentally placed a naked two-sided bet on two uncorrelated
coins. It was marked −$1,054 at review, +$268 by the time it was closed three hours
later — and both numbers are the same lesson.

---

## 1. First principles: what a funding-carry trade actually is

Start from the instrument. A **perpetual future** is a derivative that never expires,
so nothing ever forces its price to converge to the spot price the way an expiry date
forces a normal future. Left alone, the perp could drift arbitrarily far from the
asset it references. The mechanism that prevents this is **funding**: at fixed
intervals (hourly on Hyperliquid), whichever side of the market is "heavy" pays the
other side a rate proportional to how far the perp has drifted from spot. Longs pay
shorts when the perp trades rich; shorts pay longs when it trades cheap.

Funding is therefore a *tether*. And a tether you get **paid to hold one end of** is a
business:

- **Long** the asset in the spot market: +1 unit of exposure.
- **Short** the perpetual on the same asset: −1 unit of exposure.
- Net price exposure: **zero**. What remains is the funding stream the crowded long
  side pays you, minus fees.

That is the entire strategy the desk runs (PROFIT_PIVOT_II, E1). Its edge is modest
and measurable — a few to a dozen percent annualized on majors — and its risk is
supposed to be *basis risk only*: the wiggle in the perp−spot gap between entry and
exit.

Now name the load-bearing assumption, because everything that follows is about it:

> **The hedge identity.** "+1 spot, −1 perp = 0 exposure" is only arithmetic if both
> legs are claims on the **same underlying asset**. The subtraction happens in the
> *asset*, not in the ticker string.

Every carry desk, every basis trader, every cash-and-carry arb in history rests on
that one identity. It is so obvious that nobody writes it down — which is precisely
how it gets violated.

### 1.1 The basis is the identity's fingerprint

There is a second first-principles fact, and it is the one that makes the bug
*mechanically detectable*: **two claims on the same asset cannot trade far apart,
because arbitrage eats the gap.** If the perp trades 5% over spot, you short the perp,
buy spot, and collect 5% risk-free at convergence — and the funding mechanism
accelerates the convergence by paying you while you wait. Competition compresses a
genuine perp/spot basis to a band of a few tenths of a percent in normal conditions, a
few percent in extremis.

Two *different* assets, by contrast, have no tether at all. The ratio of Lighter's
price to Litentry's price is not an equilibrium anybody enforces; it's an arbitrary
number that happens to exist.

So the observable "how far apart do the two legs price?" separates the two cases by
**two orders of magnitude**. On the night of 2026-07-02, the desk's eight entries
showed it perfectly:

| pair | entry basis (perp vs spot) |
|---|---|
| AAVE, LINK, NEAR, UNI, XPL, DYDX | 0.0% – 0.1% |
| GRAM | +0.5% |
| **LIT** | **+177.5%** |

A genuine basis and a ticker collision are not near neighbours you must carefully
distinguish — they are different regimes. That is what makes a cheap, dumb,
price-based check into a near-perfect classifier. Hold that thought for §4.

---

## 2. How the bug got in: names are not identities

The universe scan (`carry-universe-scan.ts`, built in #91) maps a Hyperliquid perp
coin to its Binance spot market like this: take the coin string, append `USDT`, and
ask whether Binance lists that market. `AAVE` → `AAVEUSDT` ✓. `LIT` → `LITUSDT` ✓.

The assumption smuggled in: *if both venues use the same ticker, they mean the same
asset.* But tickers are **uncoordinated namespaces**. There is no global registry; each
venue assigns short mnemonic strings independently, first-come-first-served in its own
listing history. Binance assigned `LIT` to Litentry years ago. Hyperliquid assigned
`LIT` to Lighter recently. Neither is wrong. String equality across two namespaces is
not evidence of identity — it's a pun.

Three things are worth teaching here, because they generalize far beyond this repo:

**(a) The failure was caused by success.** For months the desk traded a hand-curated
list of majors (BTC, ETH, SOL...) where a human had implicitly verified every
name-to-asset mapping just by knowing what the tickers meant. #91's breadth push
scaled the universe from ~10 curated names to **231 scanned perps** — and the very
first scan minted a collision. When you automate *selection*, you must also automate
every sanity check the human was silently performing. An AI-run desk has no "wait,
LIT? on Hyperliquid?" reflex unless one is built. This is the deep pattern: **scaling
converts implicit checks into missing checks.**

**(b) The gate looked at one leg's history and never at the pair's identity.** LIT
passed the 90-day funding gate *honestly* — +12.2% annualized, positive on 91%/98% of
in-sample/OOS days, +29.4% recent — because Lighter really is a hot new token whose
perp longs really do pay that much. Every number the gate examined was true. The
falsehood lived in the *join* between two datasets, and no component owned the join.
Bugs love unowned seams.

**(c) The k-prefix wrinkle proves the mapping was already known to be nontrivial.**
Hyperliquid lists `kPEPE` — a 1000× wrapper on PEPE — and the scan already contained
special-case code to unwrap it. A mapping that needs special cases is a mapping that
can be wrong; the wrapper handling was the clue that identity, not spelling, was the
real key.

---

## 3. The physics of the position, and the arithmetic of the close

What did the desk actually hold for 15 hours? Two independent positions:

- **Long 24,251 Litentry** at $0.7431 — about **$18k** of exposure.
- **Short 24,251 Lighter-perp** at $2.0615 — about **$50k** of exposure.

Notice even the *sizing* was corrupted: the book sizes both legs to equal quantity off
the perp price, so the "hedge" wasn't even dollar-balanced across the two unrelated
assets ($50k short Lighter vs ~$18k long Litentry). Not that balance would have
helped — with uncorrelated legs there is nothing to balance *against*.

A true carry pair's P&L is `qty × Δ(basis)` — the change in a spread that arbitrage
holds in a band of tenths of a percent. The naked pair's P&L is
`qty_spot × Δspot − qty_perp × Δperp` with **no cancellation term**: variance adds
(σ² ≈ σ²_A + σ²_B for ρ≈0) and each σ is the full daily volatility of a small-cap
crypto asset. The desk measured this directly, without meaning to:

| time (UTC, 07-03) | Lighter perp | position mark |
|---|---|---|
| 02-Jul 19:38 (entry) | $2.0618 | 0 |
| ~08:10 (review, #92) | $2.1231 | **−$1,054** |
| 10:51 (close) | $2.0487 | **+$268 realised-first** |

A **$1,322 swing in under three hours** on a book whose *entire desk* had otherwise
moved $48.54 in ten hours. The bug position carried roughly two orders of magnitude
more risk than the strategy it was impersonating — exactly the ratio §1.1 predicted,
because it's the same ratio in both places: tethered spread vs untethered assets.

### 3.1 The close, step by step (honest accounting)

The position was closed at 10:51 UTC through a new out-of-band utility
(`scripts/carry-close-book.ts`) that deliberately reuses the book's own ledger rather
than touching the database by hand:

1. **Restore** the persisted book state (`carry_book_state.state`) into a real
   `FundingCarryBook` — same code path as a desk resume.
2. **Replay the offline gap's funding from settled history**, not an estimate: 5
   settled hourly prints over the 5.8h since the last checkpoint, +$3.08. (Yes — the
   naked short *earned* real funding; Lighter's longs paid us the whole time. True and
   irrelevant: $5.29 of funding does not price $1,300/3h of naked variance.)
3. **Close both legs at live mids** with taker fees and the desk's slippage model —
   the "urgent closes never wait" doctrine.
4. **Persist status=CLOSED with the final ledger.** The row stays forever.

Final accounting: spot leg realised −$3.59 (Litentry barely moved), perp leg realised
**+$307.72** (covered at $2.0487 vs $2.0615 entry), funding +$5.29, fees −$41.14,
slippage −$13.56 → **realised-first +$268.29**.

Two honesty rules were enforced and are worth stating as doctrine:

- **A bug's P&L is still the desk's P&L.** The row is not deleted, the number is not
  footnoted away. It goes into month-end accounting like every other close.
  *Attribution* — "this was a bug, not carry" — happens in the journal, not by editing
  history. A demo that quietly drops its embarrassing rows is worthless (CLAUDE.md §1).
- **Symmetrically: a lucky bug is excluded from the strategy's report card.** The
  +$268 must not flatter the carry thesis, exactly as the −$1,054 must not indict it.

### 3.2 Resulting: the decision was right at −$1,054 and right at +$268

The most instructive fact in the whole affair is that the position **made money**, and
that this changes nothing. Poker players call the error "resulting" — grading a
decision by its outcome instead of its process. The decision framework for an
unintended position is one line:

> You have no thesis about this position. Expected value: unknown, roughly zero.
> Variance: enormous. A rational desk pays to shed unpriced variance — so the moment
> a position is identified as unintended, the only defensible action is to close it
> *now*, at whatever the mark happens to be.

Had we held at −$1,054 "to see if it comes back," we'd have been rewarded this time —
and the reward would have trained the worst possible reflex into the desk's operating
culture, one that eventually donates far more than $1,322 back to the market. The
close crystallised +$268 by *coin flip*. Log the luck, keep the rule.

---

## 4. The fix: defense in depth along the identity seam

The invariant to enforce: **no pair may be treated as one asset unless the market
itself says they're one asset.** Prices are the oracle — venues can disagree on names,
but arbitrage guarantees that same-asset claims price together (§1.1). So the check
(`checkSameUnderlyingBasis`, `src/market-data/funding/cross-venue-symbol-match.ts`) is:

```
comparable_perp = perp_mark / 1000        (only for k-prefixed wrapper coins)
basis% = (comparable_perp / spot − 1) × 100
same asset ⟺ |basis%| ≤ 5
```

Why 5%? Threshold-setting is about the *gap between the two populations*: genuine
bases live at 0–0.5% (a few % in stress); collisions live at 50–10,000%+ (LIT: 177%).
Any threshold in the dead zone between them classifies perfectly; 5% sits comfortably
above any basis a real pair could sustain (funding arb compresses wider gaps within
hours) and far below anything a collision produces. The cost asymmetry seals it: a
false rejection skips one symbol or pays one round-trip fee (bounded, small); a false
acceptance opens unbounded naked exposure. **Fail closed.**

It is enforced at *every* seam where a pair becomes a position — not just where the
pair is recommended:

1. **Scan-side** (`b0ac393`): a candidate whose basis fails the check can never be
   marked `deployable`; the scan board prints each row's basis% with a "ticker
   collision?" tag so a mismatch is visible at scan time.
2. **Runner-side, fresh open** (`ccbc7fd`): `carry-desk-live.ts` re-checks at the
   moment of execution — a hand-typed `CD_SYMBOLS` list, a stale artifact, or any
   future scan bug is caught at the last line of defense.
3. **Runner-side, re-gate open**: same check when the daily re-gate admits a new
   symbol mid-run.
4. **Runner-side, resume**: a *persisted* book that fails the check on rehydrate is
   closed at market (after honest gap-funding accrual) instead of being carried
   forward — the exact LIT scenario, now self-healing on the next boot.

Why both scan and runner, when the runner alone would stop the position? Because the
two layers fail independently: the scan gate keeps garbage out of the *plan* (you
never budget capital for a phantom pair), the runner gate keeps garbage out of the
*book* regardless of where the symbol list came from. Recommendation-time checks
protect a workflow; execution-time checks protect the money. You want both, and the
execution-time one is the one that must never be optional.

Verification, per the regression discipline (§10.1): the pure check carries unit specs
pinned to the **real numbers** — LIT's actual entry prices as the failing case, AAVE's
as the passing control, kPEPE as the scaled-wrapper case — and the runner path was
smoked live: `CD_SYMBOLS=LIT` boots, **passes the funding gate** (+12.2% ann., the
same seduction as before), and is refused by the guard at 175.8% with zero books
opened. The bug's exact reproduction now dies at the gate it used to walk through.

---

## 5. The second finding: a kill-switch that isn't running protects nothing

The same review found the quieter failure: the 30-day run was launched as a bare
foreground process, died with its terminal at t+9.6h, and sat for 3+ hours with eight
open books, an inert DD kill-switch, and an inert daily re-gate. Nothing in the code
failed — and that's the point. **Risk controls are not properties of a codebase; they
are properties of a running process.** A desk's risk model must therefore include the
process's own lifetime: supervision, liveness checks, and an unambiguous answer to
"is the desk alive right now?"

Hence `scripts/launch-carry-30d.sh`: nohup + pidfile + `start`/`status`/`stop`, so the
run survives its terminal and any session can verify liveness in one command. (The
graceful path matters too: SIGINT checkpoints books OPEN — carry is hold-past-
breakeven, and flatten-on-restart would pay the round-trip fee every reboot.)

Worth crediting the control that *did* work: persistence + the review discipline. The
books checkpointed correctly through the stall, the DB told the truth, and the #92
review found the collision within a day off exactly the artifacts designed for it
(entry marks, per-book attribution). Detection layers are risk controls of the same
rank as gates — this incident was caught by one.

---

## 6. The generalizable checklist

For any strategy that pairs instruments across venues/sources — carry, cross-venue
basis, stat-arb, ADR/ordinary, ETF/NAV, anything:

1. **Name ≠ identity.** Any join of two catalogs on a symbol string is a bug until
   proven otherwise. Ask what *enforces* the correspondence; if the answer is "we
   assume it," build a check.
2. **Find the market's own identity oracle.** Same-asset claims are arb-tethered;
   price coherence is a near-perfect, zero-dependency identity test. Prefer checks the
   *market* maintains for you over reference-data lookups that rot.
3. **Guard the execution seam, not just the recommendation seam.** Every path that
   turns a pair into a position runs the check: open, re-open, and rehydrate.
   Manual overrides go through the same gate.
4. **Fail closed under asymmetric costs.** Bounded false-reject cost vs unbounded
   false-accept cost isn't a judgment call.
5. **Close unintended positions immediately; grade the decision, not the outcome.**
   And write the outcome down honestly in both directions — no dropped rows, no
   flattered thesis.
6. **A control exists only while its process runs.** Supervise the process, expose
   liveness, and include detection/review in the control stack.
7. **When you scale an automated pipeline, inventory the implicit human checks you
   just removed.** Each one must reappear as code, or it reappears as an incident.

---

*Numbers in this document are from `carry_book_state`, the #92 review, and the live
close at 2026-07-03 10:51 UTC. One honest caveat: the ±5% threshold has been validated
against one live collision and seven live true pairs plus the scan universe — the two
populations are so far apart that the classifier's margin is enormous, but if a
genuinely stressed basis ever brushes 5%, the guard will skip a real pair for a day.
That failure mode costs a day of carry; we accept it gladly.*
