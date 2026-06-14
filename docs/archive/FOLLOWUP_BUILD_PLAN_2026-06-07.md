# Follow-up Build Plan — 2026-06-07

**Inputs:** (a) a cynical practitioner analysis of how top HFMMs / derivatives LPs actually
monetize flow (Jane Street / Citadel Securities / Optiver profile); (b) what we learned through
Journal Entries #29–#38 (the cadence flip, F1/F2/F3, the directional axe, OOS bias, the live
10h-style run); (c) this session's flow-shadow tapes
(`docs/research/flow-shadow-2026-06-07T*.jsonl`).

This plan does **not** rebuild infrastructure. We are **not** competing with the latency/franchise
market-makers — we are learning to make markets in new stablecoin / DEX / decentralized venues.
The analysis teaches and directs; it is not a spec to clone.

---

## 0. The one finding that frames everything

The HFMM machine exists to **never hold net directional risk**. Our last run proved we have the
*inverse* posture:

- **Spread engine = profitable.** Entry #32 flipped `spread − adverse` positive at sub-second
  cadence; the Entry #38 live run was **ex-BTC +$311** (ETH +$397, BNB +$67, …).
- **The only loss = held directional inventory.** BTC **−$1,207** mark on a ~9-lot short the static
  funding axe carried while BTC rose ~0.2%. That −$1,207 *was* the entire −$788 desk loss.

⇒ The single biggest thing the best systems do that we don't is **hedge the residual to flat.**
That is Phase 1, and it is the exact fix for the exact loss we measured.

This session's tape also re-measured our "fast direction" (book-imbalance) signal — a **30s edge on
the majors that decays to ~0 by 300s and flips to reversal by 900s**, per-coin heterogeneous:

| coin | IC@30s | IC@300s | IC@900s |
|---|---|---|---|
| BTC | +0.186 (57% hit) | +0.03 | −0.02 |
| XRP | +0.133 | +0.01 | −0.12 |
| ETH | +0.101 | −0.03 | −0.03 |
| SOL | +0.059 | 0.00 | +0.02 |
| ADA / DOGE / SUI | ~0 / negative | negative | negative |

Confirms the per-coin self-gating (`RollingIcFlowBiasSource`) is the right shape and bounds how
long any flow-lean may be held (seconds, not minutes).

---

## 1. Analysis → us (the four pillars, mapped honestly)

| Pillar | Real mechanism | Copyable? | Kernel we take |
|---|---|---|---|
| **1. Internalization / PFOF** | Buy uninformed retail flow, match internally in an ATS, net to ~0 delta, never touch lit market | **No** — no captive flow, no ATS; on a DEX *we are* the lit venue, can't pick counterparty | The *outcome* (net delta ≈ 0 except a validated lean) via inventory targeting + risk gate |
| **2. Macro-hedge at scale** | Net Greeks of 1000s of strikes to a few factors; hedge residual with cheapest liquid proxy (ES/SPY/VIX) | **Yes, directly** — we're linear not Greeks, but "net the book, hedge residual cheaply" maps 1:1 | **The missing pillar** → Phase 1 |
| **3. Toxic-flow deflection** | VPIN+/order-book toxicity/latency fingerprinting → fade/pull/flip on informed flow | **Defensive yes; nanosecond no** (colo/FPGA) | Price toxicity into the quote: widen/pull/single-side on a regime break → Phase 2 |
| **4. Arb moats** | AP creation/redemption, maker rebates, portfolio margin → risk-insulated loops | **AP no; rebates YES** (HL −0.2bp = our live earner); basis loops yes | Low-directional structural loops + always-be-the-maker → Phase 4 (the mission's frontier) |

---

## 2. The phased plan

Each phase: flag-gated, `off` reproduces today's quoter bit-for-bit, validated on the existing
tapes (markout / adverse reduction / NAV drawdown) **before** it is trusted live. Honesty rails as
in every prior layer.

### Phase 1 — Residual delta hedger  *(fixes the measured loss; pillar 2)*
- **Build:** `PortfolioDeltaHedger` — sum signed inventory × price across all books → desk net USD
  delta (optionally beta-weight alts → BTC). When `|net| > band`, lay it off on the most-liquid
  perp (BTC) — taker at the touch, or a passive rebate-capturing maker leg ("get paid to hedge").
  Config: band, max hedge clip, hedge instrument, beta map.
- **Relation to the axe:** the directional axe (`DirectionalGlftQuoter`) chooses a *target*
  inventory `q*`; the hedger keeps the book *at* `q*` and flattens the **unintended** residual.
  Together = "net delta near zero except where we have a validated lean."
- **Gate:** replay the existing 8h tapes through the inventory paths; show carry-P&L variance and
  NAV max-drawdown collapse vs unhedged on the same tape. Ship only if DD drops.
- **Why first:** clearest analysis lesson *and* it kills the only loss we actually have.

### Phase 2 — Toxic-flow deflection pack  *(protects the now-profitable spread; pillar 3)*
The exact list Entry #38 named, made concrete on the fast path:
- **(2a) Realized-vol → instant spread.** Fast EWMA realized vol on the tick path; half-spread floor
  scales with it. Vol spike ⇒ pull wide. Cheap, pure-defensive, high value.
- **(2b) CUSUM change-point on signed flow.** Detect a regime break in order-flow imbalance ⇒
  widen / pull / disable the lean. The "regime detector" #38 named.
- **(2c) Live markout→spread feedback.** The offline markout gate, online: track realized markout on
  recent fills; if recent fills mark adverse, widen *that side*. Closes the loop between our markout
  discipline and the live quote.
- **(2d) VPIN on the fast path.** Ensure `VpinEstimator` + `CompositeRiskGate` run on the 100ms
  loop, not just the bar path.
- **Gate:** adverse reduction on the tapes per component; each earns its weight or stays behind the
  seam (the F3 precedent).

### Phase 3 — Laddered multi-level quotes  *(earn more of the spread)*
- **Build:** quote a sized curve (N levels each side, decaying size) instead of a single level via
  `quote-pair` / the quoters. More fills across the spread distribution, better queue priority, more
  realistic MM.
- **Gate:** more captured spread on the tapes with **no** rise in adverse; queue-aware fills remain
  the honest lower bound.

### Phase 4 — Stablecoin / DEX structural-loop research  *(the mission's growth edge; pillar 4)*
- **Approach:** shadow / measure-only first, exactly like the flow-imbalance shadow — capture now,
  trust only what clears an offline gate.
- **Targets:** (i) stablecoin de-peg / re-peg loops on DEX (USDC/USDT/DAI + new stables — the
  explicit frontier); (ii) CEX↔DEX spot basis as a **maker** loop (we found FX-stable basis reverts
  reliably but is sub-fee for a taker → route to a maker book); (iii) funding-carry as a
  maker-built position (the validated-but-weak BTC funding tilt lives here).
- **Gate:** offline reversion / forward-IC gate per loop (the OOS discipline); pre-register the
  universe (the #36 methodology fix) before sweeping.
- **Why these:** low-directional, mean-reverting, *structural* — our honest version of the AP loop,
  where the moat is structure, not speed.

---

## 3. Explicitly out of scope (named so we stop chasing them)
- **PFOF / internalization / running an ATS** — no captive flow, no counterparty selection.
- **Nanosecond FPGA cancels / colocation / latency fingerprinting** — our 100ms re-quote is a *paper
  upper bound* (HL rate-limits order actions); the latency arms race is the "stuff we can't do."
- **ETF AP creation/redemption arbitrage** — requires issuer AP status.
- **Last-look fill rejection** — we quote on a CLOB; we can't reject a fill after seeing it.

---

## 4. Sequencing & how we judge each phase
1. **Phase 1** first — fixes the measured loss, clearest lesson. Judge: NAV drawdown on the tape ↓.
2. **Phase 2** — protects the proven spread. Judge: adverse ↓ per component.
3. **Phase 3** — grows the spread capture. Judge: captured spread ↑, adverse flat.
4. **Phase 4** — parallel shadow research track. Judge: a loop clears the offline reversion/IC gate.

The demo's core claim is unchanged: a steady, low-drawdown NAV curve over hours/days of live paper
trading. Phase 1 is what most directly buys that curve.
