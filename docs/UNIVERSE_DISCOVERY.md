# UNIVERSE DISCOVERY — finding, ranking, and rotating MM markets

How the desk decides **which markets to quote**: an empirical definition of a "good market",
the two scans that rank the whole universe, the promote/demote rule, and the shortlist ledger.
This is the operator's runbook — every step is a command you can run yourself.

## 1. What is a "good market"? (the empirical definition)

A market earns a desk slot only if, **measured live on the leak table**:

1. **fillEdge > 0** over a meaningful sample (≥ ~300 fills or ≥ 6h quoting). fillEdge =
   spread captured − adverse selection − fees. This is the structural number: if it's
   negative after a real sample it does NOT mean-revert — more hours just lose more money.
2. **maxDD% and worst5m inside the risk budget** (desk bar: maxDD < 1%/run per book).
3. **Enough flow to matter** (fills happening; a book that never trades is a dead slot).

Warehouse MTM (inventory luck) is **noise** — it must not drive keep/kill decisions.
SPCX is the canonical write-off: a good-looking prior ($66M/day, ~2–3bps spread) that bled
live → cut on the fillEdge rule. **Priors ≠ P&L** (same lesson as BRENTOIL/SILVER).

## 2. The two scans (rank candidates BEFORE risking a slot)

### a) Main HL dex (~150 perps) — scored discovery

```bash
HLD_SHORTLIST=100 HLD_MIN_VOL_USD=5000000 \
  npx ts-node -r tsconfig-paths/register scripts/hl-universe-discovery.ts
```

One `metaAndAssetCtxs` call for the whole universe, then per-coin candles scored with the
same `scoreMmSuitability` the live screener uses. Writes
`docs/research/hl-universe/discovery-<ts>.json`. NOTE (2026-06-11 read): with the fixed-1bps
gate nothing "passes" — use the **calmest-liquid shortlist** it prints (lowest σ = lowest
inventory risk) as the candidate list, not the yes/no.

### b) xyz dex (HIP-3 RWA/equities) — spread×volume revenue proxy

The xyz dex is where the desk's measured winners live (CL/GOLD/NVDA/TSLA). One curl, ranked
by **proxy $/day = dayVolume × 1% share × spread**:

```bash
curl -s -X POST https://api.hyperliquid.xyz/info -H 'content-type: application/json' \
  -d '{"type":"metaAndAssetCtxs","dex":"xyz"}' | jq -r '
  .[0].universe as $u |
  [range(0; ($u|length)) as $i |
    {coin: $u[$i].name, vol: (.[1][$i].dayNtlVlm|tonumber), mid: (.[1][$i].markPx|tonumber),
     bid: (.[1][$i].impactPxs[0]//empty|tonumber), ask: (.[1][$i].impactPxs[1]//empty|tonumber)}] |
  map(select(.vol > 1000000 and .bid != null)) |
  map(. + {spreadBps: (((.ask-.bid)/.mid)*10000)}) |
  map(. + {proxy: (.vol*0.01*.spreadBps/10000)}) |
  sort_by(-.proxy) | .[] |
  [.coin, (.vol/1e6|floor|tostring+"M"), (.spreadBps*100|floor/100), (.proxy|floor)] | @tsv'
```

Columns: coin, $vol/day, spread bps, proxy $/day. **Caveats:** spread sampled at one moment
(equity-linked books breathe with US hours); the proxy RANKS, it does not forecast fills —
the live leak table is the verdict.

## 3. The rotation rule (promote / demote)

- **Demote** when a book fails §1 on its leak table (fillEdge < 0 over the sample, or DD bar
  breach). Add it to `DROPPED` in `scripts/launch-mm-10h.sh` (MM_PERSIST rehydrates otherwise).
- **Promote** the top unmeasured candidate from the scans, with a liquidity floor
  (≥ ~$50M/day for xyz equities; thin books like PURRDAT rank high on proxy but can't fill).
  New books enter **β=0, governor-capped**, and are judged on their first leak table.
- Update three places per swap: `BOOKS` + `DROPPED` in `scripts/launch-mm-10h.sh`,
  `MM_FAST_SYMBOLS` + `MM_HEDGE_BETA_MAP` in `scripts/start-desk.sh`, and the ledger below.
- **Before every relaunch** run the leak table on the finishing run (S1 rule):
  `npx ts-node -r tsconfig-paths/register scripts/mm-leak-table.ts --since <start> --until <now> --log <log> --label runNN`

## 4. Shortlist ledger (update every run)

Status: **elite** (has a slot) · **candidate** (scan-ranked, unmeasured) · **written-off**
(failed §1 live — needs new evidence to re-enter).

| market | status | evidence (last update 2026-06-11) |
|---|---|---|
| xyz:CL | elite | +$1,397 realised/3.7h (#51), maxDD 0.25% — best book ever; proxy $413/d |
| xyz:GOLD | elite | +$161 realised (#51); proxy low but measured beats proxy |
| xyz:NVDA | elite | +$155 realised (#51), 117 fills |
| xyz:TSLA | elite | +$165 realised (#51), 84 fills |
| FARTCOIN | elite | +$313 realised (#51), 231 fills, hedged ETH β1.53 |
| kPEPE | elite | +$69 realised (#51), 176 fills, hedged ETH β1.20 |
| **xyz:SKHX** | **elite (NEW)** | proxy $1,194/d (9.4bps × $126M) — #1 candidate two scans running; unmeasured |
| **xyz:ORCL** | **elite (NEW)** | proxy $403/d (6.2bps × $65M); unmeasured |
| xyz:SNDK | candidate | proxy $385/d (2.7bps × $140M) — first reserve |
| xyz:MRVL | candidate | proxy $309/d (3.7bps × $82M) |
| xyz:MU | candidate | proxy $159/d (0.6bps × $249M) — tight spread, big flow |
| PURR | rotated out | operator cut 2026-06-11; fillEdge −$22 (run52), $0.7M/day flow |
| xyz:SPCX | **written-off** | kept losing live (operator, 2026-06-11); prior didn't survive contact |
| HYPE | written-off | −$1,507 realised, maxDD 1.76%, VPIN 0.58 (#51) |
| xyz:BRENTOIL | written-off | −$1,187 realised, sprd/adverse 597/867 (#51) |
| xyz:SILVER | written-off | −$816 realised, worst pick-off ratio 528/1273 (#51) |
| SOL ADA DOGE SUI | rotated out | flat realised + warehouse bleed (#53 addendum) |
| xyz:SP500 xyz:XYZ100 | rotated out | near-dead our hours; XYZ100 red (#53 addendum) |
| BTC ETH | reserved | hedge LEGS, not quoted books |
| XRP BNB | written-off | worst bleeder + basis / inert (#50) |
