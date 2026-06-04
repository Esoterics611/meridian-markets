#!/usr/bin/env bash
# Sweep γ/κ/floor over a captured tape set and print the best drawdown-compliant,
# maker-net (at the HL −0.2bps rebate) combo per coin. Run AFTER the capture
# finishes. The full output is tee'd to a timestamped .txt so you keep it for
# analysis. Grid defaults are WIDE (brackets the boundary winner from Journal #23).
#
#   bash scripts/tune-hl-l2.sh                 # today's tapes, 6-coin set, wide grid
#   DATE=20260604 bash scripts/tune-hl-l2.sh   # a specific capture day
#   COINS=BTC,XRP bash scripts/tune-hl-l2.sh   # a subset
set -euo pipefail
cd "$(dirname "$0")/.."

DATE="${DATE:-$(date +%Y%m%d)}"
COINS="${COINS:-BTC,ETH,SOL,XRP,DOGE,BNB}"
PREFIX="docs/research/l2-tapes/hl-discovery-${DATE}"
OUT="docs/research/l2-tapes/tune-${DATE}-$(date +%H%M).txt"

shopt -s nullglob
have=( ${PREFIX}-*.json )
if [ ${#have[@]} -eq 0 ]; then
  echo "✗ no tapes at ${PREFIX}-*.json — has the capture finished? (ls docs/research/l2-tapes/)"
  exit 1
fi
echo "tuning ${#have[@]} tape(s) from ${PREFIX}  →  $OUT"

MM_TUNE_TAPE_PREFIX="$PREFIX" \
MM_TUNE_COINS="$COINS" \
MM_TUNE_GAMMAS="${GAMMAS:-0.0001,0.0005,0.0025,0.01,0.05}" \
MM_TUNE_KAPPAS="${KAPPAS:-0.5,1,2,5}" \
MM_TUNE_MIN_BPS="${FLOORS:-1,2,5,8,12}" \
  npx ts-node -r tsconfig-paths/register scripts/mm-l2-tune.ts 2>&1 | tee "$OUT"

echo
echo "✅ analysis saved → $OUT"
echo "   copy the per-coin winners into docs/research/TUNED_PARAMS.md (the durable record)"
