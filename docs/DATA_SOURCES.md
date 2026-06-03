# Data Sources & Venue Evaluation Ledger

> The single source of truth for **every market-data vendor / trading venue** the desk
> uses, has evaluated, or is considering. When you evaluate a new source, add a row here
> with the rubric below — this is *how we document evals* (replacing the scattered mentions
> in the roadmap/course/prompts). Owner: the **Market Data Researcher** role
> ([../desk/ROLE_market_data_researcher.md](../desk/ROLE_market_data_researcher.md)).

## Why this exists (the goal it serves)

The mission (CLAUDE.md §1) is a **paper-trading demo** whose growth lever is **market
discovery — new venues to make markets in, especially DEX / decentralized**. Every venue
is judged against two engines and one discipline:

- **MM (the steady earner):** needs a **≤0 bps maker venue** (Journal #6/#23/#16) and,
  ideally, an **L2 order book** so fills are queue-aware, not fill-on-touch (our #1
  honesty gap). A real CLOB beats an AMM here.
- **Stat-arb (the diversifier):** needs **cross-venue basis** + **funding** series and a
  point-in-time (survivorship-safe) universe for equities.
- **Honesty:** public/no-key sources keep the paper posture credible; paid sources are
  flagged and justified.

## Rubric (every row fills these)

| Field | Meaning |
|---|---|
| **Kind** | CEX · Perp-DEX (CLOB) · DEX (AMM) · Equities · FX · Reference · Options |
| **Posture** | `no-key` (public) · `key-free` (free account) · `paid` |
| **Data** | OHLCV · L2 (depth) · funding · trades · options-IV |
| **Maker** | for venues: `rebate` / `0` / `cost` (the MM deploy condition) |
| **Fit** | MM · stat-arb · discovery · options · macro |
| **Status** | `WIRED` · `EVALUATED` · `CANDIDATE` · `REJECTED` |
| **Seam** | the interface it plugs into (`IBarFeed`/`IPriceSource` · `IReferenceBarSource` · `ITradingVenue`) |

---

## WIRED today

| Source | Kind | Posture | Data | Maker | Fit | Seam | Notes |
|---|---|---|---|---|---|---|---|
| **Binance public** | CEX | no-key | OHLCV (L2 not ingested) | maker ~1bps / taker 5bps | MM + stat-arb (default) | `IBarFeed`/`IPriceSource` | the spine; `BinancePublicClient` |
| **Alpaca** | Equities | key-free (paper) | OHLCV (split/div adj) | commission-free | stat-arb (equities live) | `IBarFeed` + `ITradingVenue` | key-gated; RTH-aware |
| **Yahoo daily** | Equities | no-key | daily OHLCV (adj) | — | stat-arb (long history/research) | bespoke client | `YahooDailyClient`; survivorship caveat |
| **Pyth Benchmarks** | FX (Reference) | no-key | true FX OHLC | — | stat-arb (FX scan) | `IReferenceBarSource` | `fx-pyth` preset; scannable |
| **DefiLlama** | Reference (peg) | no-key | peg level (1 bar) | — | reference readout | `IReferenceBarSource` | flat series, not scanned |
| **Bit2C** | Reference (ILS) | no-key | last + 24h (1 bar) | — | stat-arb (ILS basis, pending) | `IReferenceBarSource` | needs cross-source pairing |
| **GeckoTerminal** | DEX (AMM, 100+ chains) | no-key | OHLCV | LP-fee→maker (pool-dependent) | MM + discovery | `IReferenceBarSource` (+ MM `source`) | S28/S29; `dex-eth-bluechip` |

---

## EVALUATED

| Source | Kind | Posture | Data | Maker | Fit | Status | Notes |
|---|---|---|---|---|---|---|---|
| **Hyperliquid** | Perp-DEX (CLOB) | no-key (market data) | OHLCV + **L2 (20×20)** + funding | **rebate −0.2 bps** | MM (top) + funding-carry + basis | EVALUATED 2026-06-03 | 230 perp markets, live-verified. The maker-rebate CLOB + L2 tape we need. **Wire after σ-normalization** (Journal #17). Majors are tight (BTC TOB 0.15bps) → wide-spread edge is long-tail only. Real orders need wallet-signed actions (parked `live` seam); paper needs only public data. |

---

## CANDIDATES (prioritized by fit to goal)

### A. Perp-DEX CLOBs — the MM growth frontier (maker rebate + L2, the native habitat for AS/GLFT)
| Source | Posture | Data | Maker | Why / Status |
|---|---|---|---|---|
| **dYdX v4** | no-key (indexer REST/WS) | OHLCV + L2 + funding | rebate tiers | On-chain order book; second perp-DEX after HL. CANDIDATE (high). |
| **Drift** (Solana) | no-key | OHLCV + funding | rebate | CLOB+AMM hybrid; Solana funding universe. CANDIDATE. |
| **Vertex / Aevo / Paradex** | no-key | L2 + funding | rebate | More CLOB perp venues for cross-venue basis breadth. CANDIDATE (lower). |
| **GMX** | no-key | oracle px + OI + funding | — (oracle-priced, no book) | **REJECTED for MM** (no spread to make); funding/OI data still useful for stat-arb. |

### B. CEXs — cross-venue basis, funding dispersion, deeper universe (stat-arb + MM A/B)
| Source | Posture | Data | Maker | Why / Status |
|---|---|---|---|---|
| **Bybit** | no-key (public) | OHLCV + L2 + funding | rebate tiers | Biggest non-Binance perp/spot; basis + funding vs Binance/HL. CANDIDATE (high). |
| **OKX** | no-key (public) | OHLCV + L2 + funding | rebate tiers | CANDIDATE (high). |
| **Deribit** | no-key (public) | **options-IV** + OHLCV + funding | — | Feeds the Greeks layer + options vol-selling (rewrite #4). CANDIDATE (high for options). |
| **Coinbase / Kraken** | no-key (public) | OHLCV + L2 | — | US-venue reference + basis. CANDIDATE (med). |

### C. DEX spot / on-chain — discovery breadth beyond GeckoTerminal
| Source | Posture | Data | Why / Status |
|---|---|---|---|
| **Birdeye** (Solana) | key-free | OHLCV | Solana DEX breadth. CANDIDATE. |
| **The Graph / Uniswap subgraph** | no-key (hosted varies) | swaps + pool state | Direct on-chain; heavier ingest. CANDIDATE (lower). |

### D. Equities — the survivorship lever (the binding stat-arb blocker)
| Source | Posture | Data | Why / Status |
|---|---|---|---|
| **Sharadar SEP** (Nasdaq Data Link) | **paid (~$30/mo)** | EOD, **point-in-time, delisted-inclusive** | The one source that *solves survivorship* (Journal #13/#14). Against the free posture → flagged; the only paid lever worth considering. CANDIDATE. |
| **Polygon.io free / Finnhub / Tiingo / Stooq** | key-free / no-key | OHLCV | More equities breadth/history; do **not** solve survivorship. CANDIDATE (lower). |

### E. FX / macro (lower priority — Pyth covers FX majors)
| Source | Posture | Data | Why / Status |
|---|---|---|---|
| **TrueFX / exchange-rate APIs** | no-key | FX OHLCV/ticks | More FX legs beyond Pyth majors. CANDIDATE (low). |
| **FRED / SEC EDGAR / GDELT** | no-key | macro / fundamentals / news | Out of scope for the price engines today. PARKED. |

---

## How to add a source (the eval workflow)

1. **Probe it live** (desk doctrine: verify, don't assume) — confirm the public endpoint,
   no-key access, and the payload shape. Record the live result in the row's Notes.
2. **Implement the seam** — most sources are an `IReferenceBarSource` (`klines(symbol,
   interval, limit) → Bar[]`, injected `httpGet`, offline unit tests). A full trading
   venue is an `ITradingVenue`; an L2 tape feeds `LobReplayHarness`/`SimpleQueueModel`.
3. **Register** in `buildReferenceSources` (→ the registry, the `/api/market-data/reference`
   readout, `makeScannerLoader` routing) + config base URL. For MM, add a preset with
   `source:` set (S29).
4. **Move the row to WIRED** here, and journal the first real read (QUANT_JOURNAL).

## How a trader sees / interacts with sources today (and the gap)

**Today (fragmented):**
- `GET /api/market-data/reference/sources` lists the **reference** sources only (Pyth /
  DefiLlama / Bit2C / GeckoTerminal) — the `/demo` "data sources wired" readout. Binance /
  Alpaca / Yahoo are **not** in that view.
- Scanning is **per-preset**: `/api/opportunities` (stat-arb) and `/api/market-making/screen`
  + `/markets` (MM). Presets now carry `source`, so a DEX preset routes correctly — but
  there's no single board that says "here is every venue, its status, its markets."
- **Discovery already half-compounds:** any new `IReferenceBarSource` wired into
  `buildReferenceSources` auto-appears in the registry/reference readout and is scannable —
  no UI change needed to *exist*. The gap is a unified, trader-facing catalog.

**Proposed (the unified venue board — not built yet):**
- A `GET /api/market-data/sources` (or `/venues`) catalog endpoint returning **every**
  source — Binance, Alpaca, Yahoo, all reference sources, future HL — with: `id, label,
  kind, assetClasses, capabilities (ohlcv/l2/funding/options), posture (no-key/key/paid),
  status (live/key-needed), marketCount, sampleSymbol, addedAt`, and a live **health probe**
  (reachable? latency?).
- A `/demo` **"Venues" tab** rendering the catalog as status-lit cards with capability
  badges, market counts, a **NEW** badge (sources whose `addedAt` is recent), and one-click
  **Scan** / **Quote** that launches the stat-arb scan or an MM book for that venue's preset.
- This makes "notice a new venue" a first-class signal: a researcher wires a source → it
  appears in the catalog with a NEW badge → the trader scans/quotes it from the UI.
