# BOOK SELECTION & ROTATION — Candidate Analysis (MM Master Plan §3.F deliverable)
**Date:** 2026-06-10
**Status:** Prior-scoring document. Every number marked [E] is an estimate from public data and structural reasoning, NOT from live L2 measurement. The Session D4 tool (build prompt at end / companion file) re-scores everything from live data and is the only thing that promotes a book to tradeable.

---

## 0. Data provenance & honesty box

What this analysis is grounded in (public, June 2026): HL runs ~230 perp markets, ~$7B+/day perp volume, ~$9.8B OI; HIP-3 cleared ~$62B in May volume with RWA OI ~$2.65B; commodities have been the breakout HIP-3 category (WTI peaked ~$1.27B/day, Brent ~$1.04B, silver ~$1.0B in March 2026; gold consistently top-tier); XYZ100 dominates HIP-3 equities; HIP-3 growth mode cuts all-in taker fees to ~0.0045–0.009%.

What it is NOT grounded in (must come from your capture + the D4 tool): live L2 depth, realized spreads, per-book maker-account counts, markout-by-book, current margin requirements per HIP-3 DEX, and your actual achievable share. Composite scores below are **priors for the tool to confirm or kill**, ranked by my confidence-weighted judgment.

**Two breaking items that materially affect the list:**
1. **Felix Protocol (HIP-3 deployer) announced shutdown in June 2026.** Felix ran OIL/GOLD/SILVER pairs (~$3B volume Dec–Jan) and 250+ tokenized stocks, settled in USDH. Implications: (a) verify which commodity/equity tickers are trade.xyz vs Felix before touching anything — Felix books are wind-down, not opportunities; (b) Felix's flow migrates to trade.xyz books over weeks → temporary maker shortage on the receiving books = a classic §3.F(c) entry window; (c) it is a live demonstration of deployer risk as a real, realized risk class.
2. **HIP-3 economics now favor a near-monopoly deployer (trade.xyz/Hyperunit)** — it's winning ticker auctions and most volume. For book selection this is good news: one deployer to diligence, one oracle stack to sanity-check, one margin regime to learn.

---

## 1. Scoring rubric

Live model (the D4 tool computes in $/day):
```
NetEdge = Volume × RealizedSpread(markout-adj) × AchievableShare
        − ToxicityCost − InventoryVolCost − HedgeabilityPenalty − MarginCost
        + StructuralAdders (growth-mode fees, maker rebate, tier volume value, incentive/points programs)
```
Prior model (this document): components scored 0–5, composite = weighted sum.

| Component | Weight | What it captures |
|---|---|---|
| VOL — volume | .15 | enough flow to matter |
| SPR — realized spread width | .15 | what's available to capture |
| SHR — achievable share (inverse pro-maker density) | .15 | what YOU get of it |
| FLW — flow quality (inverse toxicity) | .15 | retail/naive vs informed flow |
| HDG — hedgeability (factor R², on-venue hedge legs) | .15 | inventory risk exit |
| STR — structural fees (growth mode, rebates, points, tier feed) | .10 | deterministic adders |
| FIT — your specific infrastructure edge (Tessera/Pyth reference feeds, hours calendars, QA-grade ops, HL-native data) | .15 | why YOU vs the field |

Composite ≥3.6 → Sweet-16 candidate. 3.0–3.6 → watchlist. <3.0 → pass (for MM; some remain stat-arb relevant).

A note on the two majors: BTC and ETH score high on VOL and HDG and near-zero on SHR/FLW/SPR — the toxic-flow share is the highest on the venue and the maker queue is professional. They remain in the portfolio as **hedge legs, not quoted books**. This is the "donating two slots" hard truth, now scored.

---

## 2. THE SWEET-16 — HL books ranked by YOUR edge fit (priors; verify with D4)

| # | Book | Class | Composite [E] | One-line case |
|---|---|---|---|---|
| 1 | **GOLD (trade.xyz)** | HIP-3 metal | 4.3 | Top-tier volume, retail macro flow, growth-mode fees, and your Pyth/COMEX reference feed is a true fair-value edge during CME hours; closed-hours regime is codifiable (gap-vol model). |
| 2 | **XYZ100 (trade.xyz)** | HIP-3 index | 4.2 | The biggest HIP-3 book and the **on-venue hedge leg for every single-name equity perp** — quote it partly to BE the hedge venue for slots 4–7; CME ES/NQ + Pyth give you reference superiority incl. Sunday CME opens. Pro competition rising — expect lower share, but the infrastructure anchor value is real. |
| 3 | **SILVER (trade.xyz)** | HIP-3 metal | 4.1 | ~$1B/day at peaks, more volatile and less professionally quoted than gold, same reference edge; wider spreads compensate inventory risk. Pairs with GOLD for internal cross-metal netting. |
| 4 | **NVDA (trade.xyz)** | HIP-3 equity | 4.0 | Retail single-name flow, hedgeable on-venue via XYZ100 beta + off-venue reference; earnings-calendar gating is exactly your event-mute infrastructure. |
| 5 | **WTI / OIL (trade.xyz)** | HIP-3 commodity | 3.9 | Breakout volume (~$1B+/day peaks), geopolitical retail flow, CME CL reference. **Verify deployer post-Felix**; if Felix's oil flow is migrating to trade.xyz, the next weeks are a maker-shortage entry window. |
| 6 | **TSLA (trade.xyz)** | HIP-3 equity | 3.8 | Same as NVDA with higher idio vol — wider spreads, tighter inventory caps, hedge via XYZ100 partial. |
| 7 | **BRENT (trade.xyz)** | HIP-3 commodity | 3.7 | Quote alongside WTI and internally net the WTI–Brent spread — two books, one risk; spread itself is a stable hedge relationship (rare in crypto). |
| 8 | **HYPE perp** | HL-native major | 3.7 | HL **is** price discovery for HYPE — no Binance-informed snipers; your local microprice is the global truth. Competition is heavy (everyone's flagship book) → share is the question. Synergy: staking-discount hedge leg lives here. |
| 9 | **HL-primary meme slot** (FARTCOIN-class — D4 picks the live occupant by volume) | mid-tail meme | 3.6 | Where HL is the dominant venue for a meme, the lead-lag toxicity vanishes; huge spreads, naive flow; idio risk means small caps + meme-basket internal netting (with #10). |
| 10 | **kPEPE** (or current #2 meme by HL share) | mid-tail meme | 3.5 | Second leg of the meme basket; partial beta to majors + basket netting against #9 makes the inventory tolerable. |
| 11 | **PURR/USDC (spot) + PURR perp** | HL-native pair | 3.5 | Spot fees are higher (wider quoted spreads), spot books are amateur-quoted, and the spot↔perp pair gives you an internal hedge AND a carry book (Master Plan II §S1) on one asset. |
| 12 | **CORN or WHEAT (trade.xyz)** | HIP-3 ag | 3.4 | Very wide spreads, near-zero pro competition, CBOT reference; volume is small → small allocation, but $/margin ROI can be the best on the venue. One of the two, not both, until measured. |
| 13 | **New HIP-1 spot listing (rotating slot)** | episodic | 3.4 | First-days spreads are enormous with purely naive flow; this is a standing slot with an onboarding playbook (E2 template), not a fixed asset. |
| 14 | **SUI-class mid-tail L1** (SUI/SEI/TIA tier — D4 picks by toxicity-adjusted volume) | mid-tail alt | 3.3 | Decent volume, mid pro-density, clean BTC/ETH-beta hedge. **Gated on Session D1** (Binance lead-lag feed) — without the cross-venue FV these books pick you off. |
| 15 | **Ventuals pre-IPO slot (vSPACEX / vOPENAI / vANTHROPIC)** | HIP-3 exotic | 3.1 | Spreads are huge and flow is purely speculative (the Anthropic contract traded ~53% premium) — but the oracle is deployer marks on private valuations, hedge is zero, and settlement is USDH. Tiny size, optionality/learning book only. |
| 16 | **HIP-4 BTC daily outcome book** | outcome | 3.0 | Probability quoting near a known reference (BTC perp distribution); shallow new books = first-quoter premium. Different quoting discipline — last in, smallest size, mostly to build the muscle. |

**Deliberately absent:** BTC, ETH, SOL, XRP, DOGE perps (hedge legs, not books — SHR/FLW kill them); Felix-deployed anything (wind-down); Trove/Pokemon (no reference, no hedge, pure novelty risk).

**Portfolio shape this implies for 8 live slots:** 2 metals (1+3), 1 index (2), 1–2 equities (4/6), 1 energy (5), 1 HL-native (8 or 11), 1 meme (9), 1 rotating opportunistic (13). That portfolio has: on-venue internal hedges (XYZ100↔singles, GOLD↔SILVER, WTI↔BRENT, spot↔perp), reference-feed edge on 6 of 8 books, and growth-mode fees on the HIP-3 majority — structurally different from quoting 8 crypto alts against Binance-informed flow.

---

## 3. LONG LIST — full candidate universe with component scores [all E]

Confidence: H = structural/verified by multiple sources; M = inferred; L = needs live data before any weight.

### 3a. Hyperliquid — core crypto perps
| Book | VOL | SPR | SHR | FLW | HDG | STR | FIT | Comp | Conf | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| BTC | 5 | 1 | 1 | 1 | 5 | 3 | 2 | 2.5 | H | Hedge leg only |
| ETH | 5 | 1 | 1 | 1 | 5 | 3 | 2 | 2.5 | H | Hedge leg only |
| SOL | 5 | 2 | 1 | 1 | 4 | 3 | 2 | 2.5 | H | Hedge leg only |
| XRP | 4 | 2 | 2 | 2 | 3 | 3 | 2 | 2.6 | M | Pass |
| DOGE | 4 | 2 | 2 | 2 | 3 | 3 | 2 | 2.6 | M | Pass; meme-basket hedge leg |
| HYPE | 4 | 3 | 2 | 3 | 3 | 5 | 5 | 3.7 | H | **Sweet-16 #8** |

### 3b. Hyperliquid — mid-tail / meme perps
| Book | VOL | SPR | SHR | FLW | HDG | STR | FIT | Comp | Conf | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| FARTCOIN-class (HL-primary meme) | 3 | 5 | 4 | 4 | 1 | 3 | 4 | 3.6 | M | **Sweet-16 #9** |
| kPEPE | 3 | 4 | 3 | 3 | 2 | 3 | 3 | 3.0→3.5 w/ basket | M | **Sweet-16 #10** |
| WIF / kBONK / PENGU tier | 2 | 4 | 4 | 3 | 1 | 3 | 3 | 3.0 | L | Watchlist (basket members) |
| SUI / SEI / TIA tier | 3 | 3 | 3 | 2 | 4 | 3 | 3 | 3.3 | M | **Sweet-16 #14**, gated on D1 |
| AVAX / LINK / LTC tier | 3 | 2 | 2 | 2 | 4 | 3 | 2 | 2.8 | M | Pass — Binance-led, mid competition, mediocre spreads |
| TAO / ENA / ONDO tier | 2 | 3 | 3 | 2 | 3 | 3 | 3 | 2.9 | L | Watchlist; idiosyncratic event risk high |
| Long-tail (<$10M/day) perps | 1 | 5 | 5 | 3 | 1 | 3 | 3 | 2.8 | M | Pass as standing books; raid after vol events (§3.F(c) playbook) |

### 3c. HIP-3 RWA perps (trade.xyz unless noted — VERIFY deployer per ticker post-Felix)
| Book | VOL | SPR | SHR | FLW | HDG | STR | FIT | Comp | Conf | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| GOLD | 5 | 3 | 3 | 4 | 3 | 5 | 5 | 4.3 | H | **#1** |
| XYZ100 | 5 | 2 | 2 | 3 | 4 | 5 | 5 | 4.2 | H | **#2** |
| SILVER | 4 | 4 | 3 | 4 | 3 | 5 | 5 | 4.1 | H | **#3** |
| NVDA | 4 | 3 | 3 | 4 | 4 | 5 | 5 | 4.0 | H | **#4** |
| WTI | 4 | 3 | 3 | 4 | 3 | 5 | 4 | 3.9 | M | **#5**; deployer check |
| TSLA | 3 | 4 | 3 | 4 | 3 | 5 | 5 | 3.8 | H | **#6** |
| BRENT | 3 | 3 | 3 | 4 | 4* | 5 | 4 | 3.7 | M | **#7**; *HDG via WTI spread |
| AAPL/MSFT/GOOGL/AMZN/META | 2 | 3 | 3 | 3 | 4 | 5 | 5 | 3.4 | M | Watchlist — add as volume grows; same template as NVDA |
| PLTR | 2 | 4 | 4 | 4 | 3 | 5 | 5 | 3.5 | L | Watchlist — retail favorite, verify volume |
| CORN / WHEAT | 1 | 5 | 5 | 4 | 3 | 5 | 4 | 3.4 | M | **#12** small |
| FX perps (EUR/JPY-class, if live) | 2 | 2 | 3 | 3 | 4 | 5 | 5 | 3.3 | L | Watchlist — verify tickers/liquidity; intersects Tessera FX/ILS work |
| Felix anything | — | — | — | — | — | — | — | — | H | **DO NOT TOUCH** — wind-down |

### 3d. HIP-3 exotics & HIP-4
| Book | VOL | SPR | SHR | FLW | HDG | STR | FIT | Comp | Conf | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| Ventuals vSPACEX/vOPENAI/vANTHROPIC | 2 | 5 | 4 | 4 | 0 | 4 | 2 | 3.1 | M | **#15** tiny; USDH margin; deployer-mark oracle |
| Trove (Pokemon/collectibles) | 1 | 5 | 5 | 4 | 0 | 4 | 0 | 2.7 | M | Pass — no reference, no hedge, pure novelty |
| HIP-4 BTC daily outcomes | 2 | 4 | 4 | 3 | 3 | 4 | 3 | 3.0 | L | **#16** smallest |

### 3e. Hyperliquid spot (HIP-1)
| Book | VOL | SPR | SHR | FLW | HDG | STR | FIT | Comp | Conf | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| HYPE/USDC spot | 4 | 3 | 2 | 3 | 4 | 4 | 4 | 3.4 | H | Watchlist; carry-leg synergy (MP-II §S1) |
| PURR/USDC spot | 2 | 4 | 4 | 4 | 3 | 4 | 4 | 3.5 | M | **#11** (with perp) |
| UBTC/UETH (Unit-bridged) spot | 2 | 3 | 3 | 3 | 4 | 4 | 3 | 3.1 | L | Watchlist; bridge-risk diligence first |
| New HIP-1 listings (rotating) | 2 | 5 | 5 | 4 | 1 | 4 | 4 | 3.4 | H | **#13** standing slot |

### 3f. Other venues (MM target = quote there; HEDGE = use as hedge/reference only)
| Venue | Maker economics | Pro density | Your fit | Verdict |
|---|---|---|---|---|
| **Lighter** (zk-L2) | 0/0 retail fees → no rebate; premium low-latency accounts; LIT points seasons (S3 pending, 25% supply reserved) | High on majors (zero-fee attracts pros) | API-native; points = the actual maker pay | **Pilot candidate #1 off-HL**: quote 1–2 mid-tail books for points season + diversification. No rebate means spread+points must carry it. |
| **Aster** (BNB) | 1bp maker base → 0 at VIP; taker 3.5bp; ASTER discounts; stock/synthetic markets | Medium | CEX-like APIs; Binance-ecosystem flow | **Pilot candidate #2**: mid-tail alts where HL competition is worse; verify wash-volume share before trusting volume stats |
| **Paradex** (Starknet) | Zero-fee; DIME points Season 2 (to ~Q3 2026); pre-market/privacy niche | Low-mid | Pre-market listings rhyme with Ventuals book | Watchlist: points-paid making; thin real flow risk |
| **Pacifica** (Solana) | Pre-TGE, no token yet, points live, ex-Jane Street/Binance team | Low (early) | Early-maker land grab; HL-airdrop playbook repeat | Watchlist-to-pilot: small, early presence = cheap option on retro rewards |
| **edgeX** (StarkEx) | Post-TGE (Mar 2026); referral rebates + trader rewards | Medium | Claims CEX-grade perf | Watchlist |
| **dYdX / GMX / Drift** | Legacy; losing share in this cycle | — | — | Pass for MM; data feeds only |
| **Binance/Bybit/OKX** | Negative maker tiers exist but require MM-program onboarding/KYC; Israel-access constraints previously flagged on Binance | Extreme | — | **HEDGE/REFERENCE legs only** (D1 feed, S2 funding arb) |
| **CME (micros via broker)** | n/a | n/a | Gold/oil/index reference + potential RWA inventory hedge | Reference now; hedge leg = Phase-2 decision (adds a regulated broker dependency) |

**Venue strategy in one line:** HL remains the franchise (rebates + HIP-3 + your infra). The off-HL play is not diversified MM — it's **paid-to-make**: 1–2 small pilots on points-paying venues (Lighter, Pacifica) where the retro-reward expectation is the real maker fee, sized so they can go to zero.

---

## 4. What the live tool must verify before ANY promotion (the [E]-killers)
1. Per-book L2 depth at 1/5/10bp and realized spread distribution (24h × 7d) — replaces SPR.
2. Maker-account fingerprint count + quoting-pattern classification per book — replaces SHR.
3. Markout curves on a paper/probe basis — replaces FLW.
4. Current deployer, oracle source, margin tier, growth-mode status per HIP-3 ticker — gates everything in 3c/3d.
5. Funding regime + OI cap headroom per book.
6. Rolling beta/R² to your factor pairs (BTC, ETH, XYZ100-as-equity-factor) — replaces HDG.
7. USDH exposure audit for any Ventuals/ex-Felix book.
