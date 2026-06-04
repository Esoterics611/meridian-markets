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

# Default = the KEEP set after the 2026-06-04 6h harvest (QUANT_JOURNAL #28): the
# liquid, low-σ perps where fills recycle + drawdown stays low. The toxic coins
# (NEAR,HYPE,WLD,LIT,ZEC,XPL,TON,VVV) are CUT — they fail fills<30/6h OR maxDD>0.40%
# OR net<−$1,500 (structural disqualifiers, not edge claims). Re-add any via COINS=.
# BTC kept as benchmark. Tapes checkpoint every 10min so a crash never loses the run.
# No lowercase symbols (mm-l2-session upper-cases, which would break HL's kPEPE tickers).
COINS="${COINS:-BTC,ETH,SOL,XRP,ADA,SUI,BNB,DOGE,ENA,ONDO,PUMP}"
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
