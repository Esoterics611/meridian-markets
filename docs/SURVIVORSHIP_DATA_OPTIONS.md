# Survivorship data options — equities stat-arb (P0.5)

> **Status:** scoping + a paste-ready Phase-1 experiment spec. No code shipped yet.
> Companion: [PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md) §P0.5,
> [EQUITIES_STATARB_PLAN.md](./EQUITIES_STATARB_PLAN.md), QUANT_JOURNAL Entry #13.

## 1. Why this is now the binding blocker

The method side of equities stat-arb is **done and trustworthy** — the OOS gate
(walk-forward + deflated Sharpe + purged k-fold) has earned its keep (it killed the
crypto family and refused the borderline Alpaca pairs). The remaining gap is **data,
not technique**, and after the Yahoo lever it narrowed to one thing: **survivorship**.

Journal #13 ran the de-biased cross-sector basket on free Yahoo daily history and saw
the pooled Sharpe rise **monotonically with window length**:

| window | source | OOS trades | pooled Sharpe | gate |
|---|---|---|---|---|
| ~5yr | Alpaca IEX | 507 | 0.06 | INCONCLUSIVE |
| ~10yr | Yahoo | 887 | 0.09 | PASS (PSR 99%) |
| ~24yr | Yahoo | 1867 | 0.15 | PASS (PSR 100%) |

A Sharpe that *grows* as you add history is the signature of **survivorship + crisis
inflation**, not a stable edge: a 24yr backtest on *today's* survivors silently drops
the 2008 casualties (Wachovia, WaMu, National City, Bear, Lehman…), whose spreads never
mean-reverted, while keeping the survivors whose spreads did. The long-window "PASS" is
an **upper bound**, not truth. We cannot answer "is the 0.09 real?" without a
point-in-time, delisted-inclusive universe.

## 2. The problem is two layers, not one

Survivorship enters the equities path in **two independent places**, and the Yahoo
lever fixed neither:

1. **Universe survivorship.** `src/stat-arb/markets/market-presets.ts` defines
   `EQUITY_PRESETS` as hardcoded lists of *today's* tickers, e.g.
   `equity-banks: [JPM, BAC, WFC, C, USB, PNC, TFC, GS, MS]`. The 2008 casualties are
   simply **not in the basket**, so the edge-disjoint pair-matching in
   `scripts/oos-candidates.ts` can never even *consider* a pair that later blew up.
   Even with perfect prices, the universe is survivor-only.
2. **Price survivorship + ticker reuse.** `YahooDailyClient.historicalBars()` can only
   return a series for a ticker that *still exists*, and Yahoo reuses tickers (the client
   doc already flags `TFC` = Truist post-2019 possibly carrying BB&T history). A dead name
   silently disappears; a recycled ticker silently contaminates. Same hazard exists raw on
   Alpaca.

**A real fix must supply four things:**
- (a) **Delisted-inclusive daily history** that reaches through **2008** (the regime doing
  the inflating), split/dividend-adjusted;
- (b) a **stable entity key** (CRSP PERMNO / Sharadar permaticker) so reused tickers don't
  contaminate;
- (c) **point-in-time membership** — who was in each sector/index *as of date D*;
- (d) proper **delisting handling** — a terminal/delisting return (acquisition price, or
  ~0 for a bankruptcy), not a silent gap.

## 3. The options

| Source | Has 2008 dead names? | Entity-keyed? | PIT membership | Access | Cost tier | Fit for this engine |
|---|---|---|---|---|---|---|
| **Sharadar SEP** (Nasdaq Data Link / QuantRocket) | ✅ 1998–present, active **+ delisted**, "no survivorship bias" | ✅ permaticker | ✅ `SHARADAR/SP500` membership | **REST + bulk CSV** | Non-pro ~tens of $/mo (gated; bundle higher) — *verify* | **Best fit** — mirrors `historicalBars()` in ~a day |
| **Norgate Data** (Platinum/Diamond) | ✅ **25,222 delisted, 1950→2022**, deepest history | ✅ delisted symbols suffixed `-YYYYMM` | ✅ historically accurate index constituents (retail gold standard) | ⚠️ **Windows desktop updater + plugin** (AmiBroker/Python/Zipline); no REST | Retail, 6/12-mo terms only | Strong data, **awkward** — needs an offline Windows export-to-CSV step |
| **CRSP** (via WRDS) | ✅ back to 1925, **delisting returns** done right | ✅ PERMNO (the standard) | ✅ | WRDS query / bulk | **Institutional/academic** — free-ish *if* university/WRDS affiliation, else $$$$ | Gold standard — only if you already have WRDS access |
| **Polygon.io** | ⚠️ delisted tickers queryable (`active=false`), depth/curation thinner | partial | ✗ no curated PIT index sets | REST | ~$30–200/mo | Medium — some dead prices, not a clean universe |
| **EODHD** | ❌ **delisted EOD only ~2018+**; membership from 2000 | partial | ✅ membership (but prices miss 2008) | REST | Cheap ($20–80/mo) | **Reject for this purpose** — misses the 2008 regime |
| **Free** (GitHub/Wikipedia S&P constituent histories) | membership only, **no dead prices** | — | ✅ membership | git/CSV | $0 | Insufficient alone — Yahoo can't price the dead names it points to |

## 4. Recommendation — phased, cheapest-first

**Phase 1 — answer the research question, don't build production.** You do **not** need a
standing subscription or a live integration to learn whether the 0.09 is real. Take
**Sharadar SEP** (REST, cheap, entity-keyed, covers 1998→ including 2008), do a **one-off
backfill** of the sector baskets *with the dead names hand-added* (§6), re-run the exact
`oos-candidates.ts OOS_BASKET` cross-sector pool, and compare the pooled Sharpe to
Journal #13. Decision rule:
- pooled Sharpe **holds ~0.09** → the edge is real (just thin) → proceed to a deploy decision;
- pooled Sharpe **collapses toward 0** → confirmed survivor artifact → equities stat-arb is
  dead the same way crypto was, and you've spent ~$30 instead of standing up infra for a mirage.

This is the highest information-per-dollar move on the whole equities track.

**Phase 2 — only if Phase 1 survives:** stand up the `PointInTimeUniverse` seam + delisting-
return cost handling for an automatable gate, plus a standing Sharadar (or WRDS/CRSP)
subscription.

**If Ronnie has any university/WRDS affiliation → flip the recommendation to CRSP** — strictly
better (PERMNO, delisting returns done right, back to 1925) and effectively free; point Phase 1
there instead of Sharadar.

**Non-data alternative (free, slow):** stop treating the long-window Yahoo number as truth —
gate on a survivorship-robust recent window (survivor set ≈ live set) and lean on forward
paper-trading for the real verdict. Never tells you whether the *historical* edge was real.

---

## 5. Phase-1 experiment spec (Sharadar)

### 5.1 `SharadarDailyClient` — the price source
Mirror `src/stat-arb/feed/yahoo/yahoo-daily-client.ts` exactly (same contract, injected
transport, daily-only, unit-tested offline):

```ts
class SharadarDailyClient {
  // injected HttpGet so unit tests run offline (same as Yahoo/Binance clients)
  historicalBars(symbol: string, interval: string, startMs: number, endMs: number): Promise<Bar[]>;
}
```

- **Symbol resolution.** Accept a ticker *or* a permaticker. Resolve ticker → permaticker via
  a cached `SHARADAR/TICKERS` pull, disambiguating reuse by `firsttradedate`/`lasttradedate`
  overlapping the requested window. For the hand-curated dead names (§5.5), pass the
  **permaticker** directly to sidestep reuse entirely (this is the whole point of entity-keying).
- **Adjustment.** SEP columns: `open/high/low/close` (split-adjusted), `closeadj`
  (split + dividend adjusted), `closeunadj` (raw). Use `closeadj` as the close and scale O/H/L
  by `closeadj/close` — the **same pattern `YahooDailyClient` already uses** with `adjclose/close`.
- **Daily-only** guard (same as Yahoo); reject non-`1d` intervals.

### 5.2 Sharadar tables used
- **`SHARADAR/SEP`** — daily prices, active + delisted, 1998→present. The price series.
- **`SHARADAR/TICKERS`** — `permaticker`, `ticker`, `name`, `sector`, `isdelisted`,
  `firsttradedate`, `lasttradedate`. Entity key + delisting flag + reuse disambiguation.
- **`SHARADAR/ACTIONS`** — corporate actions (delisting, mergers, ticker changes). Drives the
  terminal/delisting value (§5.4).
- **`SHARADAR/SP500`** — historical index membership. Not needed for hand-curated sector baskets;
  it's the path to a fully-automated PIT universe in Phase 2.
- Access: Nasdaq Data Link API key, `https://data.nasdaq.com/api/v3/datatables/SHARADAR/SEP.json?ticker=…&date.gte=…&api_key=…`,
  paginate via `qopts.cursor_id`, or bulk-export the table (`qopts.export=true`).

### 5.3 Wiring (no live-loop change — swap seam only)
- Secret `SHARADAR_API_KEY` read **only** in `src/config/app-config.factory.ts` (CLAUDE.md §6),
  exposed via `ISecretProvider.get()`.
- Add a `sharadar` branch to `scripts/oos-candidates.ts` and `scripts/cointegration-stability.ts`,
  mirroring the existing `yahoo` branch (`OOS_SOURCE=sharadar` / `STAB_SOURCE=sharadar`). Reuse the
  `IS_EQUITY` cost model already added for Yahoo (0bps fee, 1bps half-spread, 50bps/yr borrow,
  daily `barSeconds`).

### 5.4 Delisting-return handling (the one non-trivial code addition)
`HistoricalReplayVenue` already carries the P0.4 borrow hook. Add: when a held name reaches its
`lasttradedate` mid-window, **settle the leg at its terminal value** from `SHARADAR/ACTIONS`
(acquisition price for a merger; ~0 for a bankruptcy) instead of letting the series silently end.
This is exactly the asymmetry survivorship hides — a **short** leg in a name that goes to zero is a
*gain*; a **long** leg in a bankruptcy is the realistic loss. Without it the experiment is only
half-de-biased.

### 5.5 Hand-curated dead-name list per sector
Add these to a PIT-augmented preset set (e.g. `EQUITY_PRESETS_PIT`, kept separate from the live
`EQUITY_PRESETS`). Tickers below are *historical*; **resolve each to a Sharadar permaticker** before
use (several reuse a live ticker — `WM`, `G`, `DNA`, `ONE`, `EP` — which is precisely why
entity-keying matters). Names chosen for sector-centrality and for dying *inside* the backtest window.

| sector | dead/merged names (ticker → fate) |
|---|---|
| **banks** | Wachovia (WB→WFC '08), Washington Mutual (WM→failed/JPM '08), National City (NCC→PNC '08), Countrywide (CFC→BAC '08), Bear Stearns (BSC→JPM '08), Lehman (LEH→bankrupt '08), Merrill Lynch (MER→BAC '09), SunTrust (STI→Truist/TFC '19), Sovereign (SOV→Santander '09), CIT (CIT→bankrupt '09), FleetBoston (FBF→BAC '04), Bank One (ONE→JPM '04), Golden West (GDW→Wachovia '06) |
| **energy** | Anadarko (APC→OXY '19), XTO (XTO→XOM '10), El Paso (EP→Kinder Morgan '12), Burlington Resources (BR→COP '06), Kerr-McGee (KMG→APC '06), Unocal (UCL→CVX '05), Pioneer (PXD→XOM '24), Marathon Oil (MRO→COP '24), Hess (HES→CVX, pending), Chesapeake (CHK→bankrupt '20) |
| **rails** | Burlington Northern Santa Fe (BNI→Berkshire '10), Kansas City Southern (KSU→CPKC '21), Conrail (CRR→split CSX/NS '99) |
| **staples** | Gillette (G→PG '05), Wrigley (WWY→Mars '08), Heinz (HNZ→private '13), Anheuser-Busch (BUD→InBev '08), Sara Lee (SLE→split '12), Cadbury (→Kraft '10) |
| **pharma** | Wyeth (WYE→PFE '09), Schering-Plough (SGP→MRK '09), Pharmacia (PHA→PFE '03), Warner-Lambert (WLA→PFE '00), Genentech (DNA→Roche '09), Allergan (AGN→ABBV '20), Celgene (CELG→BMY '19), Genzyme (GENZ→Sanofi '11) |
| **semis** | Broadcom-old (BRCM→Avago/AVGO '16), Altera (ALTR→INTC '15), Xilinx (XLNX→AMD '22), Linear (LLTC→ADI '17), Maxim (MXIM→ADI '21), National Semi (NSM→TXN '11), SanDisk (SNDK→WDC '16), Cypress (CY→Infineon '20) |
| **megacap-tech** | *(weakest case to de-bias — the basket is by construction the winners; few in-window deaths)* Yahoo (YHOO→Altaba '17), Sun Micro (JAVA→Oracle '10), Compaq (CPQ→HP '02), EMC (EMC→Dell '16) |
| **payments** | *(young basket — V/MA IPO'd '06–'08; consolidation, not death)* First Data (FDC→Fiserv '19), TSYS (TSS→GPN '19), Heartland (HPY→GPN '16) |

> Note on coverage: the **rails** and **megacap-tech** baskets have few in-window casualties, so
> the survivorship test is least informative there; **banks, pharma, semis, staples** are where the
> de-biasing will move the number most.

### 5.6 Run + decision rule
```bash
# after SharadarDailyClient + the sharadar branch + EQUITY_PRESETS_PIT land:
OOS_SOURCE=sharadar OOS_BASKET=true \
  OOS_PRESET=equity-banks-pit,equity-energy-pit,equity-rails-pit,equity-staples-pit,equity-pharma-pit,equity-semis-pit \
  OOS_DAYS=9000 OOS_INTERVAL=1d OOS_TRAIN=120 OOS_TEST=120 OOS_ZLOOKBACK=20 \
  npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
```
Compare the pooled Sharpe / PSR to Journal #13's Yahoo run on the same baskets. **Holds ~0.09 →
real & thin (proceed); collapses toward 0 → survivor artifact (kill).** Record as a new
QUANT_JOURNAL entry either way — a clean "no" is as valuable as a "yes."

### 5.7 Effort & cost
- **Cost:** Sharadar SEP non-professional tier — order of tens of $/month (gated behind login;
  verify on the Nasdaq Data Link / QuantRocket pricing page or the Core US Equities bundle).
- **Effort:** ~1–2 days — `SharadarDailyClient` + spec (mirror Yahoo) ½ day; the two script
  branches + `EQUITY_PRESETS_PIT` ½ day; delisting-return handling in `HistoricalReplayVenue`
  ½ day; run + write-up ½ day.

## 6. Sources
- [Norgate data content tables](https://norgatedata.com/data-content-tables.php) ·
  [Norgate survivorship-free DB guide](https://concretumgroup.com/how-to-construct-a-survivorship-bias-free-database-in-norgate-using-python/)
- [Sharadar SEP (Nasdaq Data Link)](https://data.nasdaq.com/databases/SEP) ·
  [Sharadar coverage (QuantRocket)](https://www.quantrocket.com/sharadar/)
- [EODHD survivorship-free / delisted coverage](https://eodhd.com/financial-academy/financial-faq/survivorship-bias-free-financial-analysis) ·
  [EODHD delisted data (2018+)](https://eodhd.com/financial-apis/delisted-stock-companies-data)
- [CRSP](https://www.crsp.org/)
</content>
</invoke>
