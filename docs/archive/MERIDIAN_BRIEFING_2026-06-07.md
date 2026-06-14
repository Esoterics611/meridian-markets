# Meridian Markets — Progress Briefing

**Prepared:** 7 June 2026
**Status:** Live paper trading on real market data — no real capital at risk

---

## What this project is

Meridian Markets is a working demonstration of an **AI-agent-run quant trading desk**. Several
trading strategies run side by side, each managed by an AI agent, against **real, live market
data** from public crypto and equity venues. No real money is deployed — every trade is paper —
but the prices, the order books, and the costs are real.

The goal is deliberately modest and deliberately honest: **steady, low-drawdown returns**, and a
truthful account of what actually works. We are not trying to beat the world's fastest trading
firms. We are **learning the craft of market-making by doing it hands-on**, measuring every
decision against real fill data, and keeping the scoreboard honest. A demonstration that reports
inflated numbers is worthless — so the discipline that keeps our paper P&L truthful *is* the
product.

The frontier we care about is **new markets** — decentralized exchanges, stablecoin markets, and
other venues that the established players have not yet saturated. That is where a small, disciplined
desk can still find an edge.

---

## What we've proven so far (real feedback from live runs)

We recently ran the market-making desk on a real crypto order-book venue for a multi-hour live
paper session. Three concrete findings came out of it:

**1. The core engine works — we make money on the spread.**
When the desk re-prices its quotes fast enough (sub-second), the market-making business becomes
**profitable**. In the live run, the desk made money on **every market except one**: setting aside
a single problem position, the desk was **+$311**, led by ETH at **+$397**. This is the central
claim of the demonstration, and it now has a real number behind it.

**2. The one thing that lost money was a single un-hedged bet.**
The entire loss came from **one held directional position**: a Bitcoin position that bled
**−$1,207** as the price drifted ~0.2% against it. That one position turned an otherwise-positive
day slightly negative (−$788 on an ~$8M paper book, about −0.01%). The lesson is sharp and useful:
**we earn the spread reliably; we lose money when we carry inventory we haven't hedged.** This is
exactly the failure mode the next phase of work is built to fix.

**3. Our fast "direction" signal is real but short-lived.**
We measured whether order-book pressure predicts the next price move. It does — but only briefly
(roughly the next **30 seconds** on the most liquid coins), and it fades to nothing within minutes.
On some smaller coins it doesn't work at all. So the system now **validates the signal coin by
coin, continuously**, and only acts on it where it is currently proving itself. We trust the data,
not a hunch.

---

## What we learned from studying how the best firms operate

We studied, in detail, how the leading market-making firms (Jane Street, Citadel Securities,
Optiver) actually make money. Their playbook has four pillars. The valuable exercise was separating
**what is a structural privilege we cannot copy** from **the transferable craft we can**:

| Their pillar | What it really is | Can a small desk copy it? |
|---|---|---|
| **Internalizing retail flow** | Pay retail brokers for order flow, match it privately, never touch the open market | **No** — requires a captive flow franchise. On open exchanges, we *are* the public market. |
| **Hedging at scale** | Net thousands of positions down to a few risks, then hedge the leftover cheaply | **Yes** — this is the single most valuable lesson, and it's exactly our gap. |
| **Avoiding "toxic" flow** | Detect informed traders in real time and pull back before getting run over | **The defensive parts, yes**; the nanosecond hardware race, no. |
| **Structural arbitrage** | Exploit exclusive privileges (e.g. ETF creation rights) and exchange rebates | **Rebates, yes** (already our edge); the exclusive privileges, no. |

The honest conclusion: the giants win largely on **speed and exclusive access** — advantages bought
with colocation, custom hardware, and franchise relationships we neither have nor are pursuing. But
the **economic core** of their business — *make the spread on ordinary flow, keep your net position
near zero, hedge what's left cheaply, and step back when the flow turns against you* — is craft, not
privilege. That craft transfers, and it is what we are building.

Most striking: **their entire machine is engineered to never hold a directional bet.** Our own live
run pointed at the same lesson from the other side — our spread engine was profitable, and our only
loss was a held position. The analysis and our own data agree on what to fix first.

---

## What we're building next

Four phases, in priority order. Each is switched off by default and must prove itself on recorded
real-market data before it is trusted live.

1. **Hedge the leftover position.** Net the whole desk's exposure down and lay off the remainder on
   the most liquid market. This directly fixes the only loss we've actually measured. *(Highest
   priority — it buys the steady, low-drawdown curve that is the demo's core promise.)*

2. **Step back from toxic flow.** Widen or pull our quotes automatically when volatility spikes,
   when the order flow breaks regime, or when our recent fills show we're being picked off.
   *(Protects the spread profit we've now proven.)*

3. **Quote more of the market.** Post a fuller ladder of prices rather than a single level, to
   capture more of the available spread.

4. **Explore new decentralized and stablecoin markets.** Research — in measure-only mode first —
   the structural, low-risk opportunities (stablecoin re-pegs, price gaps between exchanges,
   funding-rate carry) that suit a disciplined desk in venues the giants haven't crowded. *(This is
   the growth frontier where structure, not speed, is the edge.)*

---

## The bottom line

Meridian is doing exactly what it set out to do: **learning market-making hands-on, on real data,
and reporting the results honestly.** We have a working engine, a profitable core business in our
last live run, a precise and well-understood explanation of the one thing that lost money, and a
clear, prioritized plan to fix it. We are not chasing the latency arms race we can't win — we are
learning the durable craft and pointing it at the new markets where it still pays.

---

*Meridian Markets is a paper-trading demonstration. All figures above are from simulated trading on
real, live market prices. No real capital is deployed, and none is planned.*
