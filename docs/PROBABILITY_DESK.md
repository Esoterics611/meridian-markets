# The Probability Desk — HIP-4 binaries vs the Deribit RND (paper, live)

> Born 2026-07-13 from the alpha mandate ([FABLE_ALPHA_MANDATE.md](FABLE_ALPHA_MANDATE.md) §6).
> Code: `src/prediction/` + `src/derivatives/rnd/` + `scripts/outcome-rv-live.ts`.
> Companion book shipped the same session: the VRP satellite (`src/derivatives/vrp/`,
> `scripts/vrp-live.ts`) — same fair-value machinery, opposite counterparty.

## The thesis (why this desk, why now)

Hyperliquid's HIP-4 event markets went live on mainnet 2026-05-02 — recurring **daily BTC price
binaries** (machine-readable spec: `class:priceBinary|underlying:BTC|expiry:…|targetPrice:…`)
plus validator-published event markets, trading in the same margin system as the perps, with a
standard L2 book per outcome side (coin `#<outcomeId><side>`, prices in probability units).

The crowd on those books prices binaries by feel. **This desk owns an options-calibrated fair
value** — the smile-adjusted Deribit digital (−dC/dK = N(d2) − vega·dσ/dK), sitting on the same
Greeks layer that was validated line-by-line against live Deribit prices (#12). Nobody else on a
HIP-4 book is quoting off an RND. That asymmetry — not latency, not rebates — is the edge, and it
is exactly the kind this desk can actually have (mandate §3: no colocation, no flow, no scale).

**Founding live read (2026-07-13 18:08 UTC, locked in `implied-digital.spec.ts`):** HIP-4 BTC
daily, K=62,814, 11.9h to expiry: YES quoted 0.153/0.180 vs smile-adjusted fair 0.1334. The
crowd's mid was near-fair (0.1455 vs naive 0.1425 — the smile adjustment is what exposes the
gap); the executable dislocation was ~+2c on the bid side, ~1.5c fee-adjusted — **below the 3c
entry gate**. Honest: at that snapshot the book correctly does nothing. The gate exists to trade
the fat dislocations (news hours, expiry runs, thin weekends), not the calm ones.

## Why this is not the killed spread-MM (#70) with extra steps

- Entries require a **signed fair-value edge** past a pre-registered gate — never queue rent.
- Positions are **defined-risk** (max loss = collateral, known at entry) and **self-settle to
  0/1 within hours** — there is no inventory to warehouse, which was the entire spread-MM bleed.
- Realised-first is structural: most positions settle the same day.

## The discipline (pre-registered, decided before the first run)

- **Entry gate:** fee-adjusted edge ≥ **0.03** probability (ORV_EDGE_MIN). Fee placeholder 0.005
  per contract until HIP-4's actual close/settle schedule is confirmed — **the P&L is not to be
  trusted until that number is real.**
- **Caps:** $500 collateral/market, $2,000 total; ≤50% of touch size; no entry <45min to expiry.
- **Success metric (pre-registered):** over the first **14 days** of running, realised P&L > 0
  **and** ≥10 settled positions (else the sample is too thin to claim anything) **and** win rate
  consistent with the entry edges taken (a 60%+ implied-edge book winning 40% means the fair
  value is wrong — stop and re-derive, don't re-tune the gate).
- Only `class:priceBinary` on Deribit-priceable underlyings (BTC/ETH) is ever traded. Event
  markets (sports/politics) have no model here and are refused by construction. The #92
  same-underlying guard (venue spot vs Deribit index ±5%) sits on every pricing call.

## Known honest gaps (v0)

- Fee schedule + oracle: placeholder fee; settlement uses HL mid vs target at expiry (venue
  oracle may differ marginally). Confirm both against a settled market early in run 1.
- Taker-only entries at the touch; no queue model. The obvious v1 is **maker-side resting**
  inside the spread anchored to fair (the founding read's spread was 2.7c wide) — that converts
  the same fair value into bigger per-fill edge, but only after run 1 proves the fair value out.
- Deribit smile is marked, not executable; tenor gap (HIP-4 06:00 vs Deribit 08:00 dailies) is
  priced with the binary's own T on the option expiry's smile (flat forward vol over 2h).

## Run it (operator, DB-free)

```bash
# The probability desk (HIP-4 binaries vs RND):
npx ts-node -r tsconfig-paths/register scripts/outcome-rv-live.ts
# The VRP satellite (gated short straddle, band-hedged, hard stop):
npx ts-node -r tsconfig-paths/register scripts/vrp-live.ts
```

Both journal every EVAL/ENTER/SETTLE to `docs/research/{outcome-rv,vrp}/*.jsonl` and print a
10-minute SUMMARY line; kill with Ctrl-C, the FINAL line is the honest scorecard.
