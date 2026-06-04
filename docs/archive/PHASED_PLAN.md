# Meridian Markets — Phased Plan

Per-phase detail behind the README. Each phase is self-contained: a clear deliverable, a clear regulatory/capital posture, a clear next-phase dependency. **Skipping a phase or running them out of order = blowing up the licensing path or the cap table.**

---

## Phase 0 — Treasury yield service (first product)

**Deliverable:** a separate-repo NestJS service exposing `IYieldProvider` with at least one integration (start with one of: BlackRock BUIDL, Ondo USDY, Maker sDAI). Manages Lira-Bridge's idle Path C reserve-pool USDC. Earns 4–5% on float that today sits dead.

**Why it's first.** Zero regulatory surface (first-party treasury management of our own subsidiary's float is not investment advice), improves Lira-Bridge's Path C gross margin materially, creates the foundational repo + integrations the later phases inherit.

**Regulatory posture.** None. No RIA, no broker-dealer, no fund. Disclosed in Lira-Bridge ToS as "we may place idle reserves in tokenized money-market instruments."

**Capital need.** Engineering only — ~2 Claude sessions. Real on-chain placement requires KYB onboarding with the chosen issuer (BlackRock requires a Securitize KYC for BUIDL; Ondo requires institutional KYB; Maker is permissionless via DSR but operationally clunky). Pick one and run KYB in parallel with the build.

**Shared seam with Lira-Bridge.** `ITreasuryClient` — Lira-Bridge calls `deposit(amount)` / `withdraw(amount)` / `getYieldEarned()`. Markets implements it. Designed-for in this phase; Lira-Bridge integration is a one-line factory swap when Phase 0 deploys.

**Done when.** Mock-default (real on-chain calls behind `MOCK_YIELD_ENABLED=true` until KYB lands). 30+ tests passing. One concrete provider (recommend USDY — cleanest API, real-world USD yield, no Ethereum-only constraint).

**Next:** Phase 1 (FX hedge) or stop here and let Lira-Bridge consume the service for 3–6 months to build a track record before doing anything else.

---

## Phase 1 — On-chain FX hedge module

**Deliverable:** an automated hedger that watches Lira-Bridge's outstanding Path C ILS exposure (USDC issued against ILS-wire-pending) and opens/closes short-ILS positions on an on-chain perp venue (Drift, Hyperliquid, GMX) to neutralise FX risk during the wire-settlement window.

**Why it matters.** Lira-Bridge's [PATH_C_DESIGN §8](../meridian/docs/PATH_C_DESIGN.md) explicitly flags FX gap-risk between credit-time and replenishment-time as "the dominant operational cost of Path C at scale." Today the answer is "bake a wider FX margin into the rate" — fine at PoC volumes, untenable at $1B+ annual flow. Hedging converts that gap from a 50–150bp tax into a 5–10bp hedging cost.

**Regulatory posture.** None — first-party treasury hedging of our own subsidiary's FX book is not advisory, not a managed product, not principal trading on behalf of clients. (The instant we hedge *for customers* we're an advisor — don't.)

**Capital need.** ~2–3 Claude sessions for the engine. ~$500k–1M of working margin for the perp positions (sized to outstanding exposure, not customer count). Hedge venue KYB.

**Risk to manage explicitly.** Funding rate volatility on perp venues. Hedge-venue solvency (Hyperliquid > Drift > GMX > others). Liquidation buffer (size positions for 3σ ILS moves, not 1σ).

**Done when.** Hedging engine runs against Lira-Bridge's live Path C exposure feed, automatically scales positions, has documented circuit breakers (kill switch on extreme funding, on venue health degradation, on Lira-Bridge-side data staleness).

**Next:** Phases 0+1 are the *first-party-only* baseline. Everything from Phase 2 onward requires legal formation first.

---

## Phase 2 — Legal formation (no code)

**Deliverable:** Meridian Markets exists as a real legal entity. Operating agreement, CCO, regulatory opinion letters, prime broker / fund admin relationships scoped.

**Structure to default to (subject to counsel):**
- **Delaware C-corp** for the operating company (the trading desk, IP, employees).
- **Cayman SPC (segregated portfolio company)** for the fund vehicle that will hold customer money in Phase 4. Standard structure for offshore crypto funds with US AML cooperation.
- **State RIA** initially (Israel or NY, depending on team location), **SEC RIA** when AUM crosses ~$150M.
- **CCO** — fractional first (Greenberg Traurig, CrossCheck, etc.), full-time before Phase 4.

**Counsel must answer (the actual diligence):**
1. Does Phase 0 + Phase 1 (first-party only, no customer money) require any registration in our team's jurisdictions? (Expected answer: no.)
2. What is the trigger for required registration? (Typical: first dollar of third-party assets under management; first marketed investment product; first solicitation of accredited investors.)
3. RIA exemption analysis — private fund adviser exemption (§203(m)) keeps us state-only up to $150M AUM if we manage only "qualifying private funds." Verify.
4. Cross-border: how does the IL/US team split affect ISA jurisdiction over the activity?

**Capital need.** $200–300k setup (legal + entity + CCO setup) + ~$15–25k/month ongoing CCO + counsel.

**Done when.** The entity exists, opinions are on file, prime broker / fund admin term sheets are signed (even if dormant). We can take third-party money the day we want to.

---

## Phase 3 — Prop desk (own capital only)

**Deliverable:** quant trading infrastructure trading Meridian Markets' own treasury. No customer money, no fund offering, no advice published.

**Why this is the "patient" phase.** The investable assets a fund needs — track record, risk discipline, demonstrated PnL — cannot be bought, only earned. Trading own capital for 12+ months builds them while costing only opportunity cost on the money. Skipping straight to Phase 4 is what fails: investors discount any fund with <1yr audited history to zero.

**Scope (start small, expand):**
- Market data ingest (CCXT or direct exchange WS) for top-15 spot pairs and the venues we'll trade on.
- Signal store (Postgres + columnar — TimescaleDB or DuckDB).
- Execution router with venue abstraction (so we can swap CEX/DEX without rewriting strategy).
- Risk module (per-position, per-venue, portfolio VaR, drawdown gate).
- Daily NAV calc + audited reporting from day one (so when we want to open it to investors, the history is real).
- Strategy library — start with three: (a) cross-venue spot arb, (b) funding-rate carry on perps, (c) basis trade between spot and futures. None of these is novel; all are profitable at small scale; all build the infra needed for novel strategies later.

**Regulatory posture.** Spot crypto with own capital, no advice, no third-party money = no registration in most jurisdictions. Adding crypto futures triggers CFTC. Adding US-listed securities triggers SEC. Stay spot + crypto-derivatives-only until Phase 4.

**Capital need.** $5–10M of trading capital (below this the strategies don't scale; above this the leap to "should we open this to investors" makes sense). Engineering: ongoing Claude sessions; ~1 senior quant hire when capital deployed.

**Done when.** 12 months of audited daily NAV with a Sharpe ratio worth showing investors. Until then, do not pitch the fund.

---

## Phase 4 — 3(c)(7) crypto fund for accredited Lira-Bridge members

**Deliverable:** an opt-in investment product visible from inside the Lira-Bridge app. Accredited-investor-only. Sub/red portal, fund admin integration, audited NAV. Driven by the Phase 3 strategy book.

**Why "for Lira-Bridge members" specifically.** CAC for a crypto fund is brutal — typical institutional fundraising takes 2+ years and a placement agent. We have a captive distribution channel: Lira-Bridge's own member base, many of whom (Israeli tech, Aliyah families, crypto-native users) qualify as accredited and trust the Lira-Bridge brand. CAC approximately zero if we earn it.

**Structure.** 3(c)(7) Cayman SPC fund (per Phase 2). Each strategy is a segregated portfolio. Sub-min $250k (3(c)(7) requires "qualified purchasers" — $5M investable assets — not just accredited; if we want accredited-only it's 3(c)(1) with a 100-investor cap). Choose 3(c)(7) for scalability if our LPs qualify; 3(c)(1) if they don't.

**Fund admin.** NAV Consulting, SS&C, or Sudrania. Cost ~$30–60k/year. Don't try to do this in-house.

**Regulatory posture.** SEC RIA (if AUM > $150M) or state RIA (below). 1940 Act exemption via 3(c)(7) or 3(c)(1). KYC/AML at the fund-admin level. SEC Form ADV filed.

**Capital need.** $1–2M operating cost in year 1 (fund admin + counsel + tech). Trading capital comes from LPs; we ideally seed 5–10% from our own balance sheet to align incentives ("eating our own cooking").

**Done when.** First LP wire received, accepted, and reflected in audited NAV.

---

## Phase 5 — Derivatives venue (optional, hardest, probably never)

**Deliverable:** a regulated retail-facing derivatives offering — either a permissioned perps DEX (US: licensed venue; IL: ISA-regulated CFD-equivalent) or an NFA-registered FX/crypto futures broker.

**Why it's probably the wrong move.** The license stack is the heaviest in retail finance. NFA FDM (Forex Dealer Member) requires ~$20M net capital. ISA license in Israel requires similar capital + operational requirements. Compliance burden is permanent — every leverage offer, every margin call, every promotional email is regulated speech. Margin per customer is *lower* than Phase 4's management fees + carry.

**When it makes sense.** Only if (a) Phases 0–4 are working but TAM-constrained — i.e., we've saturated our member base for the managed product and want a second product line — and (b) there's a clear path to differentiating from already-licensed competitors (Plus500, IBKR, dYdX as a venue). Without a real edge, this is regulatory cost-burn.

**Honest recommendation:** revisit in year 3+ only if the rest of the stack is succeeding and there's a specific customer need we can't otherwise serve. Default to *don't*.

---

## Cross-phase dependencies (do not violate)

1. **Never run Phase 3+ before Phase 2 closes.** Trading with first-party capital is fine pre-formation; the moment you publish strategy results or solicit investors, you've crossed a line.
2. **Never let Lira-Bridge customer money flow into Phases 3/4/5 without an *opt-in* through a separately-branded screen with explicit risk disclosures.** Conflating payment balances with invested balances is the FTX failure mode. Lira-Bridge ledger and Markets fund balances must be in different databases.
3. **Phase 0/1 stay first-party forever.** The moment we offer "hedging as a service" or "yield as a service" to customers, the regulatory frame changes — those become securities/advisory products. Keep them as internal Lira-Bridge cost-of-goods optimizations only.
4. **The `ITreasuryClient` seam is the only API between Lira-Bridge and Markets.** No cross-database reads, no shared models, no Markets code in the Lira-Bridge repo. The companies talk over HTTP/gRPC, like real third parties.

---

## What to build first (if you do nothing else)

Start with [`prompts/PHASE_0_PROMPT.md`](prompts/PHASE_0_PROMPT.md). It's self-contained, ~2 Claude sessions, no legal dependency, and the yield uplift on Lira-Bridge Path C float pays for several phases of legal cost on its own.
