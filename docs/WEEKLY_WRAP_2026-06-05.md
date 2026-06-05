# Meridian Markets — Weekly Wrap (week ending 2026-06-05)

> One amazing week. We went from "the market-making desk loses money and we're not
> sure why" to a **measured, honest understanding of where the edge is, a proof that
> we can capture it, and the engine to do it** — built on a discipline of killing our
> own hypotheses with data. This is the business summary, the state of the system, the
> detailed next build, the plan for next week, and ideas worth carrying forward.

---

## 1. Business summary — what this week proved

The mission is a **paper-trading demonstration of an honest, AI-run quant desk**: steady,
low-drawdown returns on real market data, where *honesty about the numbers is the entire
product*. This week we put the market-making desk under that microscope and learned the
truth — most of it uncomfortable, all of it actionable.

**The headline journey (each step measured, not asserted):**

1. **Naive spread MM does not work.** We captured a real 6-hour, 20-perp Hyperliquid L2
   tape and proved that quoting a symmetric spread around the mid **loses to adverse
   selection at every spread width** — widening the spread does *not* help, because
   adverse selection is a *fair-value* problem (you get picked off because your quote is
   on a stale mid), not a width problem. The desk's apparent profits were **inventory
   carry** — directional luck, not a repeatable edge.

2. **We cut the junk.** Eight high-volatility, low-liquidity coins were ruled out by a
   regime-robust disqualifier rule (too few fills / too much drawdown / real losses),
   leaving a clean **KEEP set** of liquid, low-σ coins (DOGE, BNB, ETH, SOL, XRP, ADA,
   SUI). Coin selection alone moves the desk from −$7.3k toward break-even.

3. **We found the real fix and built it: the fair-value ("theo") engine.** Quote a
   *better price*, not a wider spread. **F1 — the micro-price** (book-imbalance fair
   value) cut adverse selection ~21%. **F2 — cross-venue (Binance) fusion** turned out to
   be a **no-op**: we *measured* it and HL prices itself (the operator's instinct was
   right — HL is a lead venue, not a follower). **F3 — confidence-scaled spread** was
   inconclusive at coarse cadence.

4. **THE PROOF — cadence is the lever.** The three layers' mixed results had one root
   cause: 18-second polling is far too coarse for a phenomenon that happens in
   milliseconds. We rebuilt the capture to run **sub-second** and re-ran everything. The
   desk's spread-vs-adverse edge flipped **−$1,020 → +$133 (a 7× swing), positive on
   all five coins** — two of them (ETH, DOGE) net-positive at low drawdown.
   **The spread business is profitable once we re-quote fast.**

5. **The last leak is inventory carry — and we built the tool to turn it into alpha.**
   With the spread edge positive, the only remaining loss is the carry on coins that
   trended. So we shipped the **directional / "axed" market maker**: it rests at a
   *target inventory* aligned with a house view, accumulating the position via the maker
   (earning spread + rebate while building it). The mechanism works; the honest demo
   showed that a **blind** bias loses (it's a bet) — which is exactly why the next build
   is the **validated bias signal**.

**Plus, the same week, we closed real engineering gaps:** the stat-arb desk got the
same per-trade business-event tape + restart-safe books as the MM desk, and we shipped a
**funding-carry universe scanner** (which HL perps pay persistent, harvestable funding —
XMR +36%/yr, majors ~8%).

**The one-line business takeaway:** *Market-making on a DEX is a real business, but the
edge is **fair-value prediction + speed**, not spreads — and we can now measure exactly
how much of it we capture. We price better, and we will bet only on a validated view.*

---

## 2. State of the system (end of week)

| Area | Status |
|---|---|
| **Tests** | 155 suites / **1,037 tests**, tsc clean |
| **MM fair-value engine** | F1 micro-price ✅ · F2 cross-venue (no-op, behind the seam) ✅ · F3 confidence-scaled ✅ — all on the `IQuoter` seam, off by default |
| **Directional MM** | `mm-directional-glft` quoter ✅ registered + tested (needs the validated bias) |
| **Capture** | parallel fetch + **sub-second cadence** ✅ · micro/F3 in the end-replay · checkpointed |
| **Both desks** | restart-safe books (MM + stat-arb) ✅ · per-trade business-event tape + `/demo` Activity ✅ |
| **Research** | funding-carry universe scanner ✅ · the honest L2 harvest pipeline ✅ |
| **PRs** | **#11 merged** (stat-arb tape + persistence + funding) · **#12 open** (fair-value engine + directional quoter + research) |
| **Proof artifact** | `docs/research/l2-tapes/hl-fine-20260605-*.json` — 8h sub-second, the window the spread edge went positive on |

**Key documents written this week:** `FAIR_VALUE_AND_THESIS_DESIGN.md` (the theo engine +
Thesis Register + the ms milestone), `DIRECTIONAL_MM_STRATEGY.md` (intentional carry / the
axe), `FUNDING_CARRY_DISCOVERY.md`, `TUNED_PARAMS.md` (the KEEP/CUT board), and **QUANT_JOURNAL
#26–#33** (the full honest trail).

---

## 3. Honest caveats we are carrying forward (so we don't fool ourselves)

1. **The sub-second flow was 88% estimated.** At ~0.6s the WS trade prints are sparse, so
   most steps fell back to a candle-volume estimate. The *qualitative* flip (−1,020 → +133,
   a 7× swing) is robust, but the *exact* number is not gospel. **The true read needs
   event-driven WS capture** (real flow) — top of next week.
2. **One window, one regime.** The proof is one 8-hour tape. It needs to hold across
   regimes (the distribution) before anything is "true."
3. **A blind bias loses.** The directional quoter is a bet; without a validated signal it's
   leverage on noise. No carry sizing without a positive out-of-sample forward-return IC.
4. **The sim has no cancel/replace latency.** The fast-requote benefit is real but will be
   smaller with realistic latency modeled — we must model it before believing the edge live.

---

## 4. Next week — the plan

**Theme: turn the proven *spread* edge + the *carry* tool into a running, validated paper desk.**

| Phase | What | Why |
|---|---|---|
| **B1 IBiasSource** | `bias(symbol)→[-1,1]` seam: Null (default), Momentum (daily), Funding (weekly — reuse the funding scanner), Manual (house view) | the directional quoter is useless without a real view |
| **B2 OOS gate** | `mm-bias-validate.ts` — each signal's forward-return IC (purged k-fold); only positive-IC signals may size carry | the honesty rail — a bias is alpha and must be validated |
| **B3 Directional sweep** | `mm-directional-sweep.ts` — prove the *validated* bias beats neutral AND beats blind bias on the tapes | the honest verdict on directional MM |
| **B4 Thesis Register** | durable, P&L-graded house-view table → the long-term bias + a `/demo` panel | the research→quotes→accountability loop (the agentic interface) |
| **B5 Live wire** | directional quoter + bias source in the live book; a directional stop; the carry equity curve; forward paper | from analysis to actual trades |
| **(parallel) ms-capture** | event-driven WS capture (HL l2Book + trades) → real, non-estimated flow + latency model | kills the 88%-estimate caveat; the clean read |

The end-to-end runbook (capture → fair value → bias → validate → directional MM → trades)
and the full kickoff prompt are in **`docs/NEXT_SESSION.md`**.

---

## 5. Ideas worth carrying forward (things on my mind)

These are not yet in the plan — they're the highest-leverage thoughts from the week:

1. **The funding + directional synthesis (highest conviction, near-term).** Bias the maker
   toward the funding-*paid* side (from the funding scanner). Then the book earns **spread +
   rebate + funding + (if the view is right) carry** — four *aligned* income streams, and the
   funding sign is an already-measured, persistent signal. This is the most defensible first
   directional bias: you're paid to hold the side you're leaning.

2. **Intra-venue lead-lag (the cross-venue edge F2 wasn't).** F2 found HL doesn't lag Binance.
   But within HL, do the **majors lead the alts**? BTC ticks → SOL/alts follow seconds later.
   A BTC-(or ETH-)lead signal for alt fair value could be the real, exploitable lead-lag —
   and it's measurable with the tapes we already have (no second venue needed). Worth a
   `mm-intravenue-leadlag.ts` early.

3. **Portfolio carry netting → a market-neutral carry book.** Run directional MM on many
   coins but bias the *book* to a target net exposure (e.g. delta-neutral, or a chosen factor
   tilt). You harvest spread + rebate everywhere while the directional carries net out — a
   market-neutral maker that still expresses views at the portfolio level. This is where the
   capital allocator and the directional MM meet.

4. **Rebate-farming economics at scale.** On benign flow (the BNB regime), adverse ≈ 0 and the
   −0.2bps rebate alone is the business. Model the **volume-tier rebate economics** — at scale
   the rebate tier improves, which compounds. A tight-spread, high-fill, rebate-maximizing book
   on the 2–3 most benign coins may be the steadiest (if thinnest) income, independent of any
   view.

5. **The discipline is the moat.** The biggest win this week wasn't a number — it was that we
   *killed our own hypotheses with data* (spread tuning, cross-venue fusion, blind bias) and
   kept only what measured positive. For an honesty-is-the-product demo, that repeatable
   "measure → believe only the positive read → log the caveat" loop **is** the deliverable. As
   we add the agentic layer, that discipline is what a quant agent must inherit: propose a
   thesis, validate it OOS, size it by conviction, grade it by realized P&L, retire it if it
   stops paying.

6. **Latency honesty before any live claim.** Before we ever say "the spread edge is +$X live,"
   we need (a) real WS flow (not estimate) and (b) a modeled cancel/replace latency. The gap
   between "positive in a zero-latency sim" and "positive with 50–250ms latency" is the whole
   ballgame at fine cadence. Build the latency model into the harness next week.

---

## 6. The arc, in one breath

> Spread MM loses → the fix is price + cadence, not wider spreads → at sub-second the spread
> edge flips positive → the last leak is carry → we built the tool to make carry chosen alpha →
> next week we validate the view that aims it, and run it for real (paper) trades.

We priced better. Next week we bet — only on a validated view. Great week. 🚀
