# Meridian Markets — Desk Progress Letter

**July 14, 2026 · paper capital on live markets**

---

Meridian is a quantitative trading desk with an unusual staffing model: the research, the
engineering, the live operation, and the post-trade analysis are all done by an AI agent —
Anthropic's Claude (Fable 5) — with a human principal setting risk policy and making every
launch decision. The desk trades **paper capital against live market data**: real order books,
real funding prints, real options chains, with explicit fee and impact models on every
simulated fill.

Let's be precise about what that means. Nothing in this letter is a real-money track record,
and we will not dress it up as one. What we are demonstrating is something a backtest cannot
fake: a desk that runs institutional research discipline end to end — pre-registered success
metrics, out-of-sample gates, transaction-cost accounting, and a post-mortem culture that
publishes its losses in the same font size as its wins. Every number below is reproducible
from journals committed to version control the morning they were produced.

## How the desk is built: a pyramid

**The base of the pyramid is engineering infrastructure, and most of the desk's first months
went into it.** The wins are unglamorous and compounding. A market-data spine that speaks to
five-plus live sources — perpetuals order books at 20 levels of depth with real-time trade
flow and funding, an institutional options chain, spot exchanges, equities feeds, and a
scanner that covers order books across 100+ chains — every one behind a clean interface with
an offline mock, so the entire desk runs and tests without a network connection. Execution
simulators built to charge us honestly: fee, impact, and borrow models on every paper fill,
and a queue-aware replay harness that fills our quotes against recorded real depth tapes,
FIFO position in line included, because a simulator that flatters you is worse than none.
A strategy library — three market-making quoters, inventory and carry books with margin
models, options Greeks validated against exchange marks, risk gates, per-fill P&L attribution
to the basis point. A research harness whose explicit purpose is to kill ideas: walk-forward
out-of-sample testing, multiple-testing corrections, survivorship gates. And the operations
layer — supervised launchers, append-only equity-curve persistence, a live business-event
tape, operator consoles — with roughly a thousand automated tests over the whole stack.

The payoff of that base is **speed with integrity**: a new idea becomes a live, cost-audited,
journaled paper book in about a day. Three did exactly that this week. Most shops can move
fast or keep their numbers honest; the infrastructure is what lets this desk do both at once.

**Above the engineering sits what we consider the desk's true foundation: risk management.** In the markets where we make markets today — BTC and
ETH books on a major perpetuals exchange — we hold no structural advantage over the incumbent
professionals, and we do not pretend to. In those markets our edge is to **not lose money**:
refuse negative-expectation nights, keep drawdowns measured in hundredths of a percent, audit
every basis point of execution cost, and let discipline compound while others pay tuition.
That sounds unambitious until you watch how most systematic books actually die. Our first
months were spent proving this layer: the desk's founding market-making result was not a
profit number, it was the diagnosis that naive quoting loses to adverse selection at *every*
spread width — and the repricing discipline (microprice centering, sub-second re-quoting) that
turned an 8-hour window from −$1,020 to +$133 of spread-versus-adverse-selection, later a
tuned +$345 over two hours on $1M of paper capital with a 0.53% max drawdown. One strong
window, not an annuity — but the mechanism that stops the bleeding is validated, and everything
else we build stands on it.

**The layer now under construction is alpha.** A prediction-market relative-value book — young,
retail-heavy event markets priced against institutional-grade options information — is the
desk's first genuine alpha attempt, and it went live this week.

**The layer being prepared is market making where we *do* have a clear advantage: new
markets.** Shekel-denominated (ILS) markets, newly listed perpetuals, tokenized equities,
on-chain event markets — books that are days or weeks old, where spreads are wide, competition
is thin, and the first disciplined quoter earns the spread while everyone else is still writing
connectors. The desk's market-making stack is venue-agnostic by construction (a new venue is an
adapter, not a rebuild), the discovery scanner is already hunting for these books, and this
week demonstrated the other half of the thesis: three new books went from concept to running
live in a single build session. Speed to a new market, with the risk foundation already
underneath it, is the advantage.

Last night, the foundation layer and the alpha layer were both on display — which is why we
are writing this letter about a night the desk lost $156 of paper.

## The overnight trial: three books, 13 hours, no supervision

| Book | Layer | Night's result | What the night established |
|---|---|---|---|
| Volatility risk premium | foundation | flat — refused to trade | The gate would not sell vol on a night when selling vol lost money |
| Funding carry (fresh legs) | foundation | −$77 at hour 12, on schedule | Accrual ran at forecast, drawdown pinned at 0.056%; execution costs flagged |
| Event-market relative value | alpha | **−$78.65** | Mechanics work; the edge is unproven; the path to proving it costs nothing |

Zero crashes. One transient network failure, absorbed and logged. Every fill, gate decision,
and risk verdict written to an append-only journal as it happened.

### The volatility book: paid to do nothing, and proud of it

The short-volatility book sells a delta-hedged daily straddle on BTC or ETH — but only when
implied volatility exceeds recent realized by 3 points or more. Last night realized vol ran
*above* implied nearly the entire session (ETH realizing 51–54% against 39–48% implied): a
night when every straddle sold was a donation. The book checked its gate 1,270 times and
refused 1,269 of them.

That refusal is the result we care most about in this letter. A short-vol book that cannot sit
on its hands is a blow-up on a timer; this one sat on its hands for thirteen straight hours
while the premium was negative. This is the foundation layer doing its job — the trade you
don't put on is the purest form of not losing money.

The one trade it did take exposed a genuine defect, which we are equally happy to show you: at
04:00 the realized-vol estimate dropped eight points in a single minute — one hot hour rolling
out of a plain rolling window, not a regime change — and the gate briefly read +4.8 points and
sold a (tiny) straddle. Entry signal: artifact. The fix is standard and already specified —
exponentially weighted realized vol plus a consecutive-readings requirement — and it ships with
a regression test before this book runs long again. The position, $3.79 of premium against a
Wednesday expiry, was abandoned with the trial and is excluded from scoring.

### Funding carry: the signal worked; the execution bill came in high

Eight fresh legs went on at $50k each — short perpetuals collecting funding against spot
hedges, on names passing a 90-day funding-history gate. Funding accrued at a steady
$4.92/hour, about 11% annualized on the $400k deployed and consistent with the gate's
forecast; no leg flipped negative all night; basis noise stayed stationary; and desk drawdown
was pinned at **0.056%** from hour one. The trial was killed at hour 12.5, before the
~28-hour fee-breakeven point, so the −$77 print is a construction of the trial's length, not
a verdict on the trade. Carry pays on multi-day holds; the 30-day supervised run is where this
book's track record gets built.

The night's real finding was in execution: our maker-first entry logic (rest at the touch,
then escalate) got genuine maker fills on three legs at 0.8bps all-in — and escalated to full
taker on four or five others at 3.5–7bps, against a pre-registered cost bar of 2bps per leg.
On a book whose gross edge is ~11% a year, a 7bps entry doubles the breakeven horizon. That
gets fixed — longer maker patience on thin names, a fee-aware breakeven recheck at entry —
before the long run launches. Signal research is glamorous; cost control is foundation-layer
work, and it is where carry books actually live or die.

### The alpha layer's first live test: an instructive loss

This book prices Hyperliquid's on-chain event markets — binary contracts on "will BTC close
above $X" — against a risk-neutral density extracted from the Deribit options smile. The
thesis is an information asymmetry: event markets are young and retail-driven; the options
market is deep and professional; where the two disagree on a probability by more than a
pre-registered 3-point edge net of fees, the book trades, defined-risk, and holds to
settlement.

The night: six entries, every one clearing the 3-point bar at fill. Five closed early at
take-profit for +$20.20. The sixth bought the "no" side of an ETH strike at 79 cents against a
model fair value of 82 — then watched ETH rally into the strike overnight and settle 0.3%
through it. Full collateral gone: −$98.84. Net for the night, **−$78.65**.

Here is why we are showing you this trade. The loss itself is unremarkable — a book that risks
roughly four dollars to win one took the wrong side of a near-coin-flip once in six tries, and
six trades decide nothing in either direction. What matters is the structural read, and the
agent flagged it while the position was still open, hours before settlement: every edge the
model found all night was on the same side (event-market "yes" prices persistently rich versus
the options-implied probability), and a book like that only makes money if the model's
probabilities are genuinely better calibrated than the market's. Either retail overpays for
lottery tickets on event markets — in which case this book is a premium collector with a real
edge — or the options-derived density underprices tails, in which case we are the ones selling
cheap insurance and last night was a preview.

Small-sample P&L cannot distinguish those two worlds. Calibration can, and it can do so
**without risking a dollar**: every event market that settles hands us a free
(model probability, market price, outcome) observation, position or no position. So the desk's
next build is a settlement scorer that grades our model against the market on every listed
contract — roughly 10 to 50 times the data per day that trading would produce. After 100+
settlements, a Brier-score comparison with a bootstrap confidence interval makes the call: if
the model beats the market, the book scales with conviction; if it doesn't, the book dies
before it bleeds. Trading is parked until then. That decision — *calibration before capital* —
was made and pre-registered the same morning as the loss. It is the foundation layer governing
the alpha layer, which is the whole design.

## Why we report this way

A paper-trading desk has exactly one asset: the credibility of its numbers. So the desk runs
rules that make self-deception expensive. Success metrics are pre-registered before a book
launches, and a failed metric halts that book's build chain. Strategy P&L is judged
*realized-first* — unrealized gains don't count until they are banked, a rule that has already
killed one seductive strategy whose green was all warehouse risk. Out-of-sample and
survivorship gates have killed others (crypto taker stat-arb died that way; we published the
autopsy). Costs are modeled on every fill and audited against per-leg budgets, as above. And
every run's raw journal is committed to the repository, losses included, the same day.

Last night is the system working: three books built in a day, run unattended overnight, one
loss taken, three defects found (a calibration question, an estimator artifact, an execution
cost miss), each with a specific, pre-registered fix — and the whole record, this letter
included, in version control by the next morning.

## What happens next

1. **Foundation:** fix the carry desk's maker-escalation cost leak, wire in the portfolio
   allocator, then launch the 30-day supervised run — that equity curve is the deliverable.
   Ship the vol book's estimator fix with its regression test.
2. **Alpha:** build the settlement scorer; let 100+ settles decide whether our model or the
   market is better calibrated. No capital until the data votes.
3. **New markets:** continue scouting the venues where the market-making advantage is
   structural — ILS-denominated markets, new perpetual listings, tokenized equities, event
   markets — and stand up paper books there with the same gates. The stack is ready; the
   discipline travels with it.

## Caveats, so nobody has to hunt for them

Paper fills, even with fee and impact models, flatter execution — some of these event markets
quoted 23-point-wide books overnight, and no simulator suffers a real queue. One night is one
night: n=6 on the event book, one artifact trade on the vol book, half a breakeven period on
carry. Event-market fee and oracle assumptions are still placeholders pending confirmation.
The market-making result remains one strong window, not an annuity. The new-markets advantage
is a thesis with supporting evidence (speed, infrastructure, discipline), not yet a measured
result — it will be tested the same way everything else here is. Where a number above is an
estimate, we have tried to say so in the sentence that contains it.

---

*Prepared by the desk's agent (Claude Fable 5) and reviewed by the principal. Underlying
artifacts: research journal entry #96 and raw run journals under `docs/research/` (event-market
and volatility books in JSONL, carry desk console log), commit `64686c0` and successors.*
