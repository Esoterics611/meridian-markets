# MM leak table — screen25-s2
Window: 2026-06-14T16:55:00.000Z → 2026-06-14T21:00:00.000Z · log: run-20260614-195649-mm10h.log
Windowed split: LIVE snapshot · per-fill markouts: mm_fill_markout @ 1s/5s/30s/60s/300s

**Desk:** net −3091 (realised −2783, unreal +164, fees +474) over 3.7h · books-sum net −3022 · hedge-leg P&L measured −75 (implied −69)
**Hedge:** 21 orders · $207,842 churned · est cost $56 · 11 track / 1 flip / 9 open · zombie lines 0

## Hedge legs — measured (mm_hedge_nav, window Δ per leg)

| leg | P&L | funding | fees | last residual | last notional |
|---|---|---|---|---|---|
| BTC | −34.9 | +0.0 | +12.5 | +0 | −6905 |
| ENA | −187.1 | −0.1 | +8.6 | −966 | −14638 |
| ETH | +11.7 | +0.0 | +9.4 | −3551 | +1958 |
| HYPE | −147.0 | +0.3 | +8.2 | +0 | −27586 |
| LIT | +14.0 | +0.0 | +1.1 | +0 | −3522 |
| MEGA | +0.0 | +0.0 | +0.0 | −106 | +0 |
| NEAR | +0.0 | +0.0 | +0.0 | −49436 | +0 |
| TON | +0.0 | +0.0 | +0.0 | −1704 | +0 |
| TRUMP | +0.0 | +0.0 | +0.0 | +48918 | +0 |
| VVV | +21.0 | +0.0 | +0.8 | +50 | +0 |
| WLD | +0.0 | +0.0 | +0.0 | +712 | +0 |
| XMR | +44.8 | +0.1 | +4.3 | −700 | +0 |
| XPL | +109.7 | −0.0 | +1.5 | +0 | +5195 |
| ZEC | +92.7 | −0.1 | +6.8 | +22916 | +22916 |

## Hedge quality (mm_hedge_quality, latest in window)

| book | leg | β cfg | β live | R² | basis share |
|---|---|---|---|---|---|
| AAVE | ETH | 1.11 | 1.00 | 0.35 | 50% |
| ADA | ETH | 1.05 | 1.18 | 0.31 | 66% |
| BNB | BTC | 0.92 | 0.84 | 0.43 | 55% |
| CRV | ETH | 1.14 | 0.84 | 0.07 | 61% |
| DOGE | ETH | 0.94 | 1.01 | 0.52 | 63% |
| ENA | ENA | 1.00 | 1.00 | 1.00 | 0% |
| FARTCOIN | ETH | 1.50 | 1.77 | 0.46 | 64% |
| HYPE | HYPE | 1.00 | 1.00 | 1.00 | 0% |
| LIT | LIT | 1.00 | 1.00 | 1.00 | 0% |
| MEGA | MEGA | 1.00 | 1.00 | 1.00 | 0% |
| NEAR | NEAR | 1.00 | 1.00 | 1.00 | 0% |
| ONDO | ONDO | 1.00 | 1.00 | 1.00 | n/a |
| PUMP | ETH | 1.51 | 1.66 | 0.25 | 69% |
| SOL | ETH | 1.02 | 1.18 | 0.54 | 67% |
| SUI | ETH | 1.29 | 1.38 | 0.63 | 27% |
| TAO | BTC | 1.69 | 1.45 | 0.10 | 83% |
| TON | TON | 1.00 | 1.00 | 1.00 | 0% |
| TRUMP | TRUMP | 1.00 | 1.00 | 1.00 | 0% |
| VVV | VVV | 1.00 | 1.00 | 1.00 | 0% |
| WLD | WLD | 1.00 | 1.00 | 1.00 | 0% |
| XMR | XMR | 1.00 | 1.00 | 1.00 | 0% |
| XPL | XPL | 1.00 | 1.00 | 1.00 | 0% |
| XRP | BTC | 1.15 | 0.92 | 0.44 | 62% |
| ZEC | ZEC | 1.00 | 1.00 | 1.00 | 0% |
| kPEPE | ETH | 1.20 | 1.24 | 0.46 | 50% |

## Hedge variance reduction (F1.6) — σ of 5-min P&L, primary vs primary+leg

| leg | books | σ primary $/√hr | σ hedged $/√hr | reduction | fees | verdict |
|---|---|---|---|---|---|---|
| BTC | BNB TAO XRP | 235.3 | 234.9 | 0% | +12.5 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| ENA | ENA | 96.8 | 29.6 | 69% | +8.6 | earns churn |
| ETH | AAVE ADA CRV DOGE FARTCOIN PUMP SOL SUI kPEPE | 184.2 | 182.9 | 1% | +9.4 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| HYPE | HYPE | 168.7 | 138.3 | 18% | +8.2 | earns churn |
| LIT | LIT | 37.7 | 35.0 | 7% | +1.1 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| MEGA | MEGA | 1.2 | 1.2 | 0% | +0.0 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| NEAR | NEAR | 251.9 | 251.9 | 0% | +0.0 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| ONDO | ONDO | 0.0 | 0.0 | 0% | +0.0 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| TON | TON | 79.5 | 79.5 | 0% | +0.0 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| TRUMP | TRUMP | 92.7 | 92.7 | 0% | +0.0 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| VVV | VVV | 98.5 | 103.8 | -5% | +0.8 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| WLD | WLD | 123.0 | 123.0 | 0% | +0.0 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| XMR | XMR | 61.4 | 51.9 | 16% | +4.3 | earns churn |
| XPL | XPL | 104.0 | 97.7 | 6% | +1.5 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| ZEC | ZEC | 126.5 | 118.3 | 7% | +6.8 | FLATTEN-ONLY candidate (no variance cut for the fees) |

## Per-book identity — net = fillEdge + warehouseMTM + funding − fees ($)

| book | net | fillEdge | warehouse | funding | fees | spread | adverse | wedge | maxDD% | worst5m | conc | fills | vpin | mk1s | mk300s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TAO | −436 | −187 | −125 | +0 | +123 | +149 | +336 | +0 | 0.67 | −167 | 21% | 128 | 0.32 | −1.7 | −14.3 |
| XPL | −435 | −70 | −321 | −0 | +43 | +92 | +162 | −1 | 0.46 | −113 | 20% | 130 | 0.19 | −1.6 | −2.1 |
| WLD | −430 | −14 | −371 | +0 | +45 | +59 | +73 | −0 | 0.50 | −140 | 23% | 127 | 0.38 | −1.9 | −11.3 |
| CRV | −402 | −96 | −257 | +0 | +49 | +80 | +176 | +0 | 0.45 | −151 | 30% | 68 | 0.00 | −1.6 | +0.7 |
| VVV | −313 | −54 | −237 | −0 | +23 | +21 | +75 | −0 | 0.36 | −107 | 22% | 124 | 0.00 | −1.6 | +1.4 |
| TON | −286 | −104 | −159 | −0 | +22 | +48 | +152 | −0 | 0.30 | −138 | 40% | 154 | 0.51 | −1.1 | −6.8 |
| XMR | −267 | +6 | −258 | +0 | +15 | +30 | +24 | +0 | 0.28 | −55 | 15% | 50 | 0.00 | −2.3 | −3.3 |
| FARTCOIN | −239 | −19 | −210 | +0 | +10 | +16 | +35 | −0 | 0.31 | −45 | 13% | 86 | 0.00 | −1.6 | −1.9 |
| ZEC | −141 | +18 | −110 | +0 | +49 | +107 | +89 | +0 | 0.25 | −120 | 23% | 59 | 0.33 | −2.2 | −1.0 |
| XRP | −133 | +9 | −118 | +0 | +24 | +9 | +0 | +0 | 0.19 | −117 | 47% | 9 | 0.82 | −0.2 | +3.0 |
| DOGE | −128 | −36 | −68 | −0 | +24 | +17 | +53 | +0 | 0.13 | −75 | 46% | 4 | 0.72 | −5.0 | −1.3 |
| NEAR | −114 | −6 | −85 | +0 | +23 | +60 | +66 | −0 | 0.43 | −307 | 47% | 18 | 0.82 | −2.5 | +12.9 |
| AAVE | −80 | −14 | −53 | +1 | +13 | +25 | +40 | −0 | 0.25 | −81 | 22% | 69 | 0.00 | −1.0 | +1.0 |
| BNB | −45 | +4 | −49 | −0 | −1 | +6 | +2 | +0 | 0.09 | −67 | 36% | 50 | 0.00 | −0.2 | +1.6 |
| kPEPE | −39 | −4 | −35 | +0 | −1 | +10 | +3 | −11 | 0.08 | −20 | 12% | 79 | 0.00 | −0.6 | −1.8 |
| SOL | −2 | −0 | −2 | −0 | −0 | +0 | +0 | −0 | 0.01 | −1 | 24% | 2 | 0.30 | −3.7 | +2.4 |
| LIT | −0 | −10 | +8 | −0 | −1 | +25 | +35 | +0 | 0.09 | −21 | 17% | 113 | 0.00 | −1.9 | −1.1 |
| ONDO | +0 | +0 | +0 | +0 | +0 | +0 | +0 | +0 | 0.00 | +0 | n/a | 0 | 0.83 | n/a | n/a |
| MEGA | +0 | −0 | +0 | +0 | −0 | +0 | +0 | −0 | 0.00 | −1 | 31% | 11 | 0.82 | −3.1 | −5.3 |
| ADA | +2 | −0 | +1 | +1 | −0 | +3 | +3 | +0 | 0.07 | −22 | 16% | 20 | 0.00 | −1.3 | +1.3 |
| TRUMP | +15 | +20 | +13 | +1 | +19 | +47 | +26 | +0 | 0.22 | −147 | 51% | 183 | 0.03 | −1.4 | −1.0 |
| PUMP | +20 | +1 | +21 | +0 | +2 | +92 | +64 | −27 | 0.17 | −52 | 18% | 88 | 0.00 | −2.6 | +1.0 |
| ENA | +64 | +17 | +44 | +0 | −3 | +36 | +19 | +0 | 0.20 | −30 | 10% | 130 | 0.60 | −0.9 | +0.0 |
| SUI | +143 | +16 | +125 | −0 | −2 | +18 | +1 | +0 | 0.07 | −21 | 40% | 29 | 0.00 | −0.2 | −3.6 |
| HYPE | +226 | −120 | +344 | −0 | −3 | +393 | +509 | −5 | 0.19 | −176 | 31% | 216 | 0.53 | −1.6 | −3.3 |

## Alignment split — A = sign(q)·sign(flow), markout @ 300s (F4 calibration)

| book | A+ fills | A+ bps | A+ $ | A− fills | A− bps | A− $ |
|---|---|---|---|---|---|---|
| AAVE | 34 | +0.4 | +12.4 | 33 | +1.3 | +13.5 |
| ADA | 3 | −12.6 | −2.6 | 16 | +3.3 | +15.9 |
| BNB | 15 | +7.0 | −0.1 | 34 | −0.5 | +3.1 |
| CRV | 29 | +2.2 | +24.2 | 35 | −0.9 | −679.6 |
| DOGE | 1 | +0.7 | +0.0 | 1 | +8.3 | +0.1 |
| ENA | 86 | −0.9 | −31.1 | 42 | +2.7 | +4.9 |
| FARTCOIN | 25 | −2.0 | +20.4 | 59 | −2.2 | −86.5 |
| HYPE | 122 | −4.2 | −486.0 | 91 | −2.0 | +44.4 |
| LIT | 52 | +1.7 | +30.4 | 58 | −3.1 | +5.2 |
| MEGA | 6 | +9.3 | −0.3 | 4 | −20.4 | −0.3 |
| NEAR | 5 | +8.2 | −0.9 | 12 | +11.5 | +198.6 |
| PUMP | 38 | +1.5 | −15.1 | 49 | +0.7 | +29.8 |
| SOL | 0 | n/a | n/a | 1 | +5.6 | +0.4 |
| SUI | 8 | +2.1 | +10.5 | 20 | −5.8 | +5.6 |
| TAO | 64 | −18.2 | −352.5 | 58 | −10.9 | −280.2 |
| TON | 74 | −10.8 | −40.5 | 77 | −3.1 | −34.0 |
| TRUMP | 79 | −4.7 | +97.7 | 103 | +1.4 | +11.7 |
| VVV | 74 | +3.4 | +79.0 | 46 | −3.3 | −41.9 |
| WLD | 62 | −10.5 | −364.6 | 60 | −13.1 | −592.5 |
| XMR | 16 | −5.7 | −46.2 | 31 | −2.7 | −88.6 |
| XPL | 56 | +6.0 | −65.0 | 70 | −10.3 | −786.0 |
| XRP | 4 | +6.6 | +0.0 | 4 | −1.3 | +22.0 |
| ZEC | 34 | −10.4 | −259.3 | 22 | +19.4 | +672.3 |
| kPEPE | 38 | −4.7 | −13.8 | 40 | +1.1 | −4.9 |

## Per-hour strip — which hours pay (markout @ 300s)

| hour (UTC) | desk netΔ | fills | ⌀abs(flow) | ⌀vpin | ⌀σ | mk bps | mk $ |
|---|---|---|---|---|---|---|---|
| 2026-06-14T16 | +67.5 | 28 | 0.97 | 0.03 | 1.3e-4 | +2.6 | −141.5 |
| 2026-06-14T17 | −1409.9 | 756 | 0.99 | 0.06 | 1.5e-4 | −1.9 | −1164.2 |
| 2026-06-14T18 | −1063.5 | 682 | 0.96 | 0.21 | 1.3e-4 | −3.3 | −1445.2 |
| 2026-06-14T19 | −450.4 | 481 | 0.97 | 0.23 | 1.3e-4 | −4.1 | −189.3 |

## Microstructure cuts

- Markout @ 300s by queue tercile (1 = front): T1 −1.3bps (n=649) · T2 −6.5bps (n=649) · T3 −0.8bps (n=649)
- Top-of-hour (±3min, funding prints): +2.1bps (n=238) vs rest −3.5bps (n=1709)

## Ranked leaks ($, largest first)

1. WLD warehouse MTM: −371
2. XPL warehouse MTM: −321
3. XMR warehouse MTM: −258
4. CRV warehouse MTM: −257
5. VVV warehouse MTM: −237
6. FARTCOIN warehouse MTM: −210
7. hedge leg ENA (measured): −187
8. TAO fill edge (picked off): −187
9. TON warehouse MTM: −159
10. hedge leg HYPE (measured): −147
11. TAO warehouse MTM: −125
12. TAO fees paid: −123
13. HYPE fill edge (picked off): −120
14. XRP warehouse MTM: −118
15. ZEC warehouse MTM: −110
