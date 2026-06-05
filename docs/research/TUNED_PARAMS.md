# Tuned market-making parameters — the winners' book

> **What this is.** The desk's record of the **best (γ, κ, floor) per coin** found by the L2 queue-aware tuner (`scripts/mm-l2-tune.ts`). One row = one coin, judged on a real L2 tape at the venue's maker fee, drawdown-compliant. **Read the TIER first** — the raw tuned net is an *in-sample upper bound*, not a forecast (see the honesty note).
>
> **How to use a row:** launch the book with those params (see [OPERATIONS_MANUAL.md](../OPERATIONS_MANUAL.md) §3/§5). γ and κ go in the launch `params`; the **floor** is `MM_MIN_HALF_SPREAD_BPS`.

## Coin selection — KEEP / CUT (2026-06-05, QUANT_JOURNAL #28)

> **Critical finding:** with inventory clamped, **spread − adverse is negative at every width on every liquid coin** — naive spread MM has no edge here; all positive P&L is inventory carry. So the cheap, robust win is **coin selection + inventory discipline**, not parameter tuning. The real edge needs the **microprice/fast-requote** quoter and/or **intentional carry** ([DIRECTIONAL_MM_STRATEGY.md](../DIRECTIONAL_MM_STRATEGY.md)).

**CUT (toxic / structurally untradeable — drop from all future runs):** **NEAR, HYPE, WLD, LIT, ZEC, XPL, TON, VVV.**
Exclusion rule (regime-robust, disqualifiers not edge claims): **fills < ~30/6h OR default maxDD > 0.40% OR default net < −$1,500.**

**KEEP (clean substrate):** **DOGE, BNB, ETH, SOL, XRP, ADA, SUI** (liquid, low-σ, fills recycle, low DD) · carry-watch: ENA, ONDO, PUMP · benchmark: BTC.

---

## 2026-06-04 — 20-perp / 6h (1168 polls) HL capture, γ/κ/floor sweep (100 combos/coin)

Grid: γ∈{0.0001,0.0005,0.0025,0.01,0.05} κ∈{0.5,1,2,5} floor∈{1,2,5,8,12}bps · lot $50k · $1M/book · DD limit 2% · HL −0.2bps maker. Tapes: `docs/research/l2-tapes/hl-discovery-20260604-*.json`. Full sweep: `tune-20260604-0052.txt`; the unbiased single-config read: `replay-20260604-default-config.txt`.

| Coin | γ | κ | floor | tuned maker-net /6h/$1M | maxDD | fills (default cfg) | TIER | read |
|---|---|---|---|---|---|---|---|---|
| **BNB** | 0.0025 | 0.5 | 1 | +$184 | 0.075% | 184 | **A** | cleanest: spread−adverse **positive (+$9)** even at default; many fills, tiny DD |
| **DOGE** | 0.0001 | 0.5 | 1 | +$307 | 0.027% | 303 | **A** | most fills, lowest DD of the set; steady |
| **ETH** | 0.0005 | 0.5 | 1 | +$902 | 0.098% | 192 | **A** | liquid, low DD, high fills |
| **SOL** | 0.0005 | 0.5 | 1 | +$1,881 | 0.363% | 130 | **A** | liquid; net partly carry — confirm next regime |
| **XRP** | 0.0005 | 0.5 | 1 | +$853 | 0.121% | 117 | **A** | liquid, low DD |
| **ADA** | 0.0025 | 0.5 | 2 | +$741 | 0.105% | 105 | **A** | liquid, low DD |
| **SUI** | 0.0005 | 0.5 | 1 | +$2,157 | 0.266% | 96 | **A** | liquid; net partly carry |
| ENA | 0.0001 | 0.5 | 1 | +$14,758 | 1.690% | 130 | B | many fills but net+DD = **carry-inflated**, not spread |
| ONDO | 0.0001 | 0.5 | 8 | +$4,899 | 0.178% | 65 | B | carry-leaning; low DD is encouraging |
| PUMP | 0.0025 | 0.5 | 1 | +$1,035 | 0.185% | 48 | B | meme; fills ok, watch toxicity |
| TON | 0.0025 | 0.5 | 12 | +$42 | 0.061% | 49 | B | barely positive even tuned |
| ASTER | 0.0001 | 0.5 | 12 | +$7 | 0.001% | 288 | B | many fills but edge ≈ 0 (adverse-heavy); stand mostly aside |
| BTC | 0.0025 | 0.5 | 1 | +$511 | 0.302% | 21 | C | too few fills to be a fill-edge business; benchmark only |
| VVV | 0.0001 | 0.5 | 1 | +$11,120 | 0.652% | 71 | C | **overfit carry** |
| LIT | 0.0001 | 0.5 | 12 | +$6,163 | 0.232% | 15 | C | **overfit carry**, 15 fills |
| HYPE | 0.0005 | 0.5 | 5 | +$4,259 | 1.078% | 6 | C | **overfit**, 6 fills, high DD |
| ONDO… | | | | | | | | |
| ZEC | 0.0001 | 0.5 | 8 | +$22,411 | 1.580% | 17 | C | **overfit carry**, 17 fills, high DD — DO NOT deploy |
| WLD | 0.0005 | 0.5 | 12 | +$22,334 | 1.802% | **1** | C | **pure noise** (1 fill) — ignore |
| NEAR | 0.0001 | 0.5 | 8 | +$739 | 0.193% | 4 | C | 4 fills — noise |
| XPL | 0.01 | 0.5 | 1 | $0 | 0.000% | 18 | C | optimizer chose **stand aside** (best = don't quote) |

**Universal sweep signal:** every winner picked **κ=0.5 (the lowest)** and the lowest-or-near-lowest γ — i.e. the data wants **WIDER spreads + strong inventory skew**. Read that as the engine telling you the default spread is too tight.

**Honesty note (binding).** This is an **in-sample upper bound** (100 combos/coin, pick-the-max). The big nets (ZEC/WLD/ENA/VVV +$11–22k) correlate with the **highest drawdowns and/or tiniest fill counts** → they are **inventory-carry luck the optimizer cherry-picked**, not repeatable spread edge. The **unbiased** read is the default-config replay (desk **−$7,352/$20M**, spread−adverse ≤ 0 on 14/20 coins). Trust **TIER A** (positive + low-DD + many fills + ideally spread−adverse > 0), treat B as "confirm next regime," and **discard C**. A row earns "deployable" only after it's TIER-A-positive across **≥2–3 regimes** (the distribution), never on one window.

---

### Prior (superseded for these coins)
| Coin | γ | κ | floor | maker-net | maxDD | source | notes |
|---|---|---|---|---|---|---|---|
| BTC | 0.0005 | 1 | 5 | +$345 / 2h / $1M | 0.53% | `wsflow1` 2026-06-04 — Journal #23 | first net-positive read; n=1, directional |

**Defaults (reference):** γ=0.0025, κ=2, floor=1bps.
