#!/usr/bin/env bash
# Launch a DETACHED, max-fidelity Hyperliquid L2 capture across the liquid perp set
# (≥ ~$10M/day). The coin list lives HERE so you never paste a line long enough to
# wrap/break in the terminal. Tapes feed scripts/mm-l2-tune.ts (see tune-hl-l2.sh).
#
#   bash scripts/capture-hl-l2.sh                  # 6h, 10s polls, top-20 liquid perps (defaults)
#   DURATION_MIN=720 bash scripts/capture-hl-l2.sh # 12h (overnight — most fills)
#   POLL_S=5 bash scripts/capture-hl-l2.sh         # denser polling
#   COINS=BTC,ETH,SOL bash scripts/capture-hl-l2.sh # a custom set
set -euo pipefail
cd "$(dirname "$0")/.."

# Default = the TOP 20 HL perps by daily volume (2026-06-04 scan, all ≥ ~$10M/day) —
# enough liquidity to actually fill, broad enough to find edge. Tapes checkpoint every
# 10min (MM_L2_CHECKPOINT_MIN) so a crash never loses the run. No lowercase symbols
# (mm-l2-session upper-cases coin names, which would break HL's lowercase-k tickers).
COINS="${COINS:-BTC,HYPE,ETH,ZEC,SOL,NEAR,WLD,XRP,LIT,TON,ENA,XPL,VVV,ONDO,BNB,SUI,ADA,DOGE,PUMP,ASTER}"
POLL_S="${POLL_S:-10}"
DURATION_MIN="${DURATION_MIN:-360}"
QUOTE_USD="${QUOTE_USD:-50000}"

mkdir -p docs/research/l2-tapes
TAPE="docs/research/l2-tapes/hl-discovery-$(date +%Y%m%d)"
LOG="docs/research/l2-tapes/capture-$(date +%Y%m%d-%H%M).log"
N=$(echo "$COINS" | tr ',' '\n' | grep -c .)

MM_L2_COINS="$COINS" \
MM_L2_POLL_S="$POLL_S" \
MM_L2_DURATION_MIN="$DURATION_MIN" \
MM_L2_QUOTE_USD="$QUOTE_USD" \
MM_L2_TRADES_WS=true \
MM_L2_FUNDING=true \
MM_L2_SAVE_TAPE="$TAPE" \
nohup npx ts-node -r tsconfig-paths/register scripts/mm-l2-session.ts > "$LOG" 2>&1 &

PID=$!
echo "✅ capture started — PID $PID"
echo "   coins:    $N perps"
echo "   cadence:  ${POLL_S}s polls · ${DURATION_MIN} min (~$(echo "scale=1; $DURATION_MIN/60" | bc 2>/dev/null || echo "?")h)"
echo "   tapes:    ${TAPE}-<COIN>.json   (written at the END — let it finish)"
echo "   log:      $LOG"
echo
echo "   watch:    tail -f $LOG"
echo "   stop:     kill $PID"
echo "   verify:   ps -p $PID >/dev/null && echo running || echo stopped"
