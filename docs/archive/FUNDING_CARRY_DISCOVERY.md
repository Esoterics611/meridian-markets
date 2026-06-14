# Funding-carry universe discovery (HL)

> Shipped 2026-06-04 (evening). Module + script + spec triple, the carry analogue
> of [hl-universe-discovery](../src/market-making/screen/hl-universe-discovery.ts).
> Answers: **"which Hyperliquid perp pays persistent, _harvestable_ funding?"**

---

## 1. What it does (and why)

Hyperliquid perps settle **funding hourly**. A delta-neutral **cash-and-carry**
— long the spot, short the perp (or the reverse when funding is persistently
negative) — **harvests that funding stream** while being immune to price
direction. This tool scans the **whole HL perp universe** (~230 perps), pulls
each coin's recent funding history, and ranks them by the funding they'd
harvest, **net of the one-time round-trip fee**, behind an honesty gate.

It is the **discovery / watchlist** layer for the cross-venue funding-carry leg
the roadmap flagged ("Cross-venue funding capture — long spot / short HL perp").
It is **not** a fill forecast or a live book — it tells you *where* the carry is;
the live cross-venue book is the verdict.

### The model (honest by construction)

`net = funding harvested − round-trip fee` (basis P&L is **excluded** — the
position is delta-neutral, so directional moves wash out and what's left is
mean-zero entry-timing noise). The key insight, identical to the rest of the
desk's fee discipline:

> The **edge is the funding stream** (continuous, paid every hour). The **4-fill
> round trip is a ONE-TIME cost** (spot in/out + perp in/out). So a perp is only
> worth harvesting when the funding is **material**, its **sign is STABLE** (you
> cannot harvest a stream that keeps flipping — you'd pay the round trip over and
> over), the **breakeven hold is short**, and it's **liquid** enough to leg into.

A coin is flagged **`harvestable`** only when it clears **all four** gates:

| Gate | Default | Meaning |
|---|---|---|
| `minAnnualizedFundingPct` | 8% | `\|annualised funding\|` must be this big to matter |
| `minStableFraction` | 0.70 | `max(posFrac, 1−posFrac)` — how one-signed the stream is |
| `maxBreakevenDays` | 20 | days of funding to clear the one-time round-trip fee |
| `minDayNtlVlmUsd` | $5M | daily $-volume floor (can you actually leg in?) |

Each scored coin also reports its **`direction`**: `SHORT_PERP` (harvest positive
funding: long spot / short perp) or `LONG_PERP` (harvest negative funding: short
spot / long perp).

---

## 2. How to run

DB-free, hits the **real HL public API** (no key, no account):

```bash
# Default: 14d history, top-80 by daily volume, the gates above.
npx ts-node -r tsconfig-paths/register scripts/hl-funding-discovery.ts

# Tunable via env:
FCD_DAYS=14 FCD_TOP=80 FCD_MIN_ANN_PCT=8 \
  npx ts-node -r tsconfig-paths/register scripts/hl-funding-discovery.ts
```

### Env knobs

| Var | Default | What |
|---|---|---|
| `FCD_DAYS` | 14 | days of funding history per coin |
| `FCD_TOP` | 80 | scan the top-N perps by daily volume (politeness + relevance) |
| `FCD_SPOT_FEE_BPS` | 4.5 | taker fee/side, the long spot leg (Binance) |
| `FCD_PERP_FEE_BPS` | 2.5 | taker fee/side, the short perp leg (HL) |
| `FCD_MIN_ANN_PCT` | 8 | harvestable funding floor (%/yr) |
| `FCD_MIN_STABLE` | 0.70 | sign-stability floor |
| `FCD_MAX_BREAKEVEN_DAYS` | 20 | max breakeven hold |
| `FCD_MIN_VOL_USD` | 5_000_000 | liquidity floor (USD/day) |
| `FCD_NOTIONAL_UNITS` | 100_000_000_000 | $100k/leg (cancels in the % metrics) |
| `FCD_BASE_URL` | `https://api.hyperliquid.xyz` | HL info endpoint |

It prints a board (top 30) + the harvestable set, and **writes a JSON board** to
`docs/research/hl-funding/discovery-<timestamp>.json`.

### Reading the output

```
symbol    dir         annFund%   stable   breakeven  annNet%   vol$M    harvest
XMR       SHORT_PERP     +35.7    0.97       1.4d    +32.1      13  ✅
TRUMP     LONG_PERP      -23.8    0.79       2.1d    +20.1       6  ✅
...
ETH       SHORT_PERP      +7.8    0.88       6.5d     +4.2    1799  ·
```

- **annFund%** — signed annualised funding (the raw stream).
- **stable** — sign-stability (1.00 = always one sign; 0.50 = coin-flip, useless).
- **breakeven** — days of funding to repay the round trip. Short = good.
- **annNet%** — net annualised return on one leg over the **observed window**.
  Note: over a *short* window the one-time fee looms large in the annualisation,
  so a positive-funding coin can show a negative `annNet%` while still being
  harvestable (its `breakeven` is short — hold past it and it turns positive).
  `breakeven` and `harvestableFundingPct` are the cleaner persistence signals.
- **harvest** — `✅` clears every gate · `·` liquid but misses a gate · `illiq`
  below the volume floor.

---

## 3. How to test

```bash
npx jest src/market-data/funding/funding-carry-discovery.spec.ts
```

7 unit specs over **synthetic** funding series (no network): a persistently
positive stream → harvestable `SHORT_PERP`; a persistently negative stream →
harvestable `LONG_PERP`; a sign-flipping stream → rejected; a tiny-but-stable
stream that can't clear the fee → rejected; thin history → `null`; the liquidity
floor; and the board ranking + harvestable filter. tsc clean.

---

## 4. Latest real read (artifact)

`docs/research/hl-funding/discovery-2026-06-04T18-05-48-312Z.json` — 14d / top-50,
HL public API: **23 harvestable perps**. Highlights:

- **XMR +36%/yr** (stable 0.97, 1.4d breakeven, short perp) — the standout.
- **TRUMP −24%/yr** and **BCH −21%/yr** — harvested via **LONG_PERP** (shorts pay).
- **HYPE/NEAR/WLD/VVV/ZRO ~13–17%/yr**, sign-stable, short breakevens.
- **Majors ETH/BTC ~8%/yr**, stable — matches
  [RESEARCH_FINDINGS](RESEARCH_FINDINGS.md) "funding carry real but modest on majors".

**Honest caveats (binding):** funding-only (basis excluded); a 14-day window is
one regime, not a forward track; the board is a **watchlist**, not a fill
forecast — the deployable form (long Binance spot / short HL perp) and its real
slippage/basis are the live verdict. Re-run across regimes to build a
distribution (the funding analogue of the γ/κ-distribution plan).

---

## 5. Where it fits

- **Code:** `src/market-data/funding/funding-carry-discovery.ts`
  (`scoreFundingCarry` + `assembleFundingBoard`, reusing
  [`staticCarry`](../src/market-data/funding/funding-carry.ts) +
  [`parseHlUniverse`](../src/market-making/screen/hl-universe-discovery.ts)).
- **Script:** `scripts/hl-funding-discovery.ts`.
- **Per-basket carry P&L (fixed symbol list, both venues):** the older
  `scripts/funding-carry-research.ts` (`FC_SOURCE=hyperliquid`) — this discovery
  tool is the universe-scan layer above it.
- **Roadmap:** the "Funding-carry basket on HL" open-quant-backlog item +
  "Cross-venue funding capture" parked item.
