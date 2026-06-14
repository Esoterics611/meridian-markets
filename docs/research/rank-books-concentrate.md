# MM book ranking — concentrate
Source: leak-table-screen25-s2.json · window 2026-06-14T16:55:00.000Z → 2026-06-14T21:00:00.000Z
Desk over the screen: realised -2783 / 3.7h. Rule: KEEP iff fillEdge ≥ +0 AND fills ≥ 10; WATCH = earns but < 10 fills (thin); CUT = fillEdge < +0. Ranked on REALISED FILL EDGE (not net — net is warehouse luck).

| rank | book | cat | fillEdge | spread | adverse | warehouse | realised | net | fills | maxDD% | mk300s | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | TRUMP | KEEP | +20 | +47 | +26 | +13 | +33 | +15 | 183 | 0.22 | -1.0 | — |
| 2 | ZEC | KEEP | +18 | +107 | +89 | -110 | -93 | -141 | 59 | 0.25 | -1.0 | WAREHOUSE-KILLED HIGH-ADVERSE |
| 3 | ENA | KEEP | +17 | +36 | +19 | +44 | -92 | +64 | 130 | 0.20 | +0.0 | — |
| 4 | SUI | KEEP | +16 | +18 | +1 | +125 | +135 | +143 | 29 | 0.07 | -3.6 | — |
| 5 | XRP | WATCH | +9 | +9 | +0 | -118 | -109 | -133 | 9 | 0.19 | +3.0 | WAREHOUSE-KILLED THIN |
| 6 | XMR | KEEP | +6 | +30 | +24 | -258 | -259 | -267 | 50 | 0.28 | -3.3 | WAREHOUSE-KILLED HIGH-ADVERSE |
| 7 | BNB | KEEP | +4 | +6 | +2 | -49 | -35 | -45 | 50 | 0.09 | +1.6 | — |
| 8 | PUMP | KEEP | +1 | +92 | +64 | +21 | +21 | +20 | 88 | 0.17 | +1.0 | — |
| 9 | ONDO | WATCH | +0 | +0 | +0 | +0 | +0 | +0 | 0 | 0.00 | n/a | THIN |
| 10 | MEGA | CUT | -0 | +0 | +0 | +0 | -0 | +0 | 11 | 0.00 | -5.3 | PICKED-OFF MIRAGE HIGH-ADVERSE |
| 11 | SOL | CUT | -0 | +0 | +0 | -2 | +0 | -2 | 2 | 0.01 | +2.4 | PICKED-OFF HIGH-ADVERSE THIN |
| 12 | ADA | CUT | -0 | +3 | +3 | +1 | -10 | +2 | 20 | 0.07 | +1.3 | PICKED-OFF MIRAGE HIGH-ADVERSE |
| 13 | kPEPE | CUT | -4 | +10 | +3 | -35 | +15 | -39 | 79 | 0.08 | -1.8 | PICKED-OFF |
| 14 | NEAR | CUT | -6 | +60 | +66 | -85 | -91 | -114 | 18 | 0.43 | +12.9 | PICKED-OFF HIGH-ADVERSE |
| 15 | LIT | CUT | -10 | +25 | +35 | +8 | +13 | -0 | 113 | 0.09 | -1.1 | PICKED-OFF HIGH-ADVERSE |
| 16 | WLD | CUT | -14 | +59 | +73 | -371 | -391 | -430 | 127 | 0.50 | -11.3 | PICKED-OFF HIGH-ADVERSE |
| 17 | AAVE | CUT | -14 | +25 | +40 | -53 | -38 | -80 | 69 | 0.25 | +1.0 | PICKED-OFF HIGH-ADVERSE |
| 18 | FARTCOIN | CUT | -19 | +16 | +35 | -210 | -229 | -239 | 86 | 0.31 | -1.9 | PICKED-OFF HIGH-ADVERSE |
| 19 | DOGE | CUT | -36 | +17 | +53 | -68 | -103 | -128 | 4 | 0.13 | -1.3 | PICKED-OFF HIGH-ADVERSE THIN |
| 20 | VVV | CUT | -54 | +21 | +75 | -237 | -291 | -313 | 124 | 0.36 | +1.4 | PICKED-OFF HIGH-ADVERSE |
| 21 | XPL | CUT | -70 | +92 | +162 | -321 | -392 | -435 | 130 | 0.46 | -2.1 | PICKED-OFF HIGH-ADVERSE |
| 22 | CRV | CUT | -96 | +80 | +176 | -257 | -361 | -402 | 68 | 0.45 | +0.7 | PICKED-OFF HIGH-ADVERSE |
| 23 | TON | CUT | -104 | +48 | +152 | -159 | -259 | -286 | 154 | 0.30 | -6.8 | PICKED-OFF HIGH-ADVERSE |
| 24 | HYPE | CUT | -120 | +393 | +509 | +344 | +64 | +226 | 216 | 0.19 | -3.3 | PICKED-OFF MIRAGE HIGH-ADVERSE |
| 25 | TAO | CUT | -187 | +149 | +336 | -125 | -312 | -436 | 128 | 0.67 | -14.3 | PICKED-OFF HIGH-ADVERSE |

## Launch-ready (selected 8 of --keep 8)

```bash
# BOOKS for launch-concentrate.sh (KEEP + thin WATCH continuity, ranked by fillEdge):
BOOKS=(TRUMP ZEC ENA SUI XMR BNB PUMP XRP)

# server env (start-desk.sh overrides):
MM_FAST_SYMBOLS=TRUMP,ZEC,ENA,SUI,XMR,BNB,PUMP,XRP
MM_HEDGE_BETA_MAP='SUI|ETH|1.29'
```

**Hedged (factor hedge, R²≥0.5):** SUI→ETH
**Naked (no fittable factor hedge — the inventory time-stop is their warehouse control):** TRUMP, ZEC, ENA, XMR, BNB, PUMP, XRP

**CUT (16):** MEGA SOL ADA kPEPE NEAR LIT WLD AAVE FARTCOIN DOGE VVV XPL CRV TON HYPE TAO
**⚠ MIRAGE (green net on warehouse luck, fillEdge<0 — do NOT keep on net):** MEGA (net +0, fillEdge -0); ADA (net +2, fillEdge -0); HYPE (net +226, fillEdge -120)
