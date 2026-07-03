# The Carry Desk — an operator's manual for the human quant

*Meridian Markets, 2026-07-03. The companion to `/desk/carry` (the screen) and
[TICKER_COLLISION_POSTMORTEM.md](TICKER_COLLISION_POSTMORTEM.md) (the hardest lesson so
far). This is not a button reference — it teaches the reasoning the desk was built on,
because an operator who knows *why* each number exists supervises differently from one
who knows only *where* it is.*

---

## 0. What you are holding

You are supervising a **paper-trading demonstration of an AI-agent-run quant desk**
(CLAUDE.md §1). Several strategies were researched by the agents; most were killed by
their own honesty gates; the survivor — a funding-carry book on Hyperliquid perpetuals
hedged with Binance spot — is running a **30-day forward track record on live market
data**. That forward curve, with truthful accounting, *is* the product. Not the P&L —
the *truthfulness* of the P&L. A demo that flatters itself is worthless; the desk's
entire value is that every number on your screen survives adversarial scrutiny.

Your role is therefore not "trader." The models trade. You are the **process
supervisor and honesty auditor**: you keep the desk alive, verify its controls are
engaging, and make sure what gets written down is what actually happened.

---

## 1. Where the money comes from (so you know what "normal" looks like)

A perpetual future never expires, so an hourly **funding payment** tethers its price
to spot: when the perp trades rich (crowded longs — the usual state in crypto, where
traders pay for leverage), longs pay shorts. The desk holds +1 spot / −1 perp on the
same asset: price risk nets to zero, the funding stream remains. You are being paid
for **balance-sheet patience** — renting your capital to leveraged optimists.

Three consequences you'll see on screen every day:

- **The edge is modest and drips.** Majors run ~3–12%/yr gross. A $50k/leg book
  earns single-digit dollars per day. Days of quiet accrual are *success*, not
  stagnation. If the desk suddenly "earns" big, be suspicious, not pleased.
- **Costs are half the game.** The round trip used to cost ~14bps taker — most of a
  month's edge. The maker-first execution service (E2) rests post-only up to 300s and
  escalates only on timeout; measured entry cost is ≈0.8bps maker / ≈4.2bps on taker
  escalations. The TCA line printed at every entry/exit is the receipt — read it.
- **The basis breathes.** The perp−spot gap wiggles tenths of a percent. That wiggle
  is the *reported-not-judged* "basis MTM" column. It is not P&L until closed; it is
  also the desk's identity check (see §4 — a gap beyond a few percent means the legs
  aren't the same asset, which is a bug, not a market).

## 2. Why *this* desk — the graveyard that taught the approach

The desk's wisdom is mostly in what it refused to keep. Every gate exists because a
specific loss got in without it. The short tour (full record: QUANT_JOURNAL,
RESEARCH_FINDINGS):

| candidate | verdict | the lesson that became a rule |
|---|---|---|
| crypto taker stat-arb | **killed** | short-window cointegration was an artifact — collapses to ≈0 at 90–180d. *Gate on long-window OOS persistence, never in-sample fit.* |
| naive spread MM | **lost, then fixed** | at every spread width, adverse selection ate the spread — a *fair-value* problem, not width. *Price off the micro-price, re-quote sub-second.* |
| equities stat-arb | real but ~0.06 Sharpe | survivorship-bound; forward paper is the only honest verdict. |
| options VRP | positive, **parked** | validated Greeks vs Deribit; waits its stress-gated turn (P2). |
| funding carry | **the live earner** | real, modest, cost-dominated → maker routing + hold past breakeven + the #72 recency veto (don't hold what recently stopped paying). |

Two meta-rules fell out of the graveyard and now bind every session:

- **R-A: winners get the hours.** Runtime and build effort follow *realised* P&L, not
  sunk cost. A validated edge with no running book is a defect.
- **Judge realised-first.** `realised-first = funding + realised − fees`. Unrealised
  ("basis MTM") is reported, never judged — the desk once sat "green" on unrealised
  while warehousing inventory risk (#64, the warehouse trap). Green marks are
  positions, not profits.

## 3. The gates (the desk's immune system)

Before a symbol earns a book, it passes — in order:

1. **The 90-day funding gate**: OOS persistence (positive-funding fraction ≥0.65
   in-sample *and* out-of-sample), breakeven vs full costs.
2. **The #72 recency veto**: trailing-7d funding must agree — a great year that
   stopped paying last week is a "no."
3. **The #92 ticker-collision guard**: perp and spot must price within ±5% — the
   market's own proof both legs are the same asset. Checked at scan time *and* at
   every runner entry/resume. (Read the postmortem; it's the best hour you'll spend.)
4. **The ≤8-leg cap + per-leg margin model** with forced liquidation at 80% of
   leg margin — paper, but honest paper.

While a book runs: **daily re-gate** (a book that fails today's gate is closed, not
ridden), and the **desk DD kill-switch** at 0.5% of desk capital — pre-registered, so
nobody moves the goalposts after the fact.

**Your discipline as operator: never override a gate by hand.** The gates *are* the
strategy. The one discretionary power you have — and the duty that comes with it — is
§6's playbook: keeping the process alive and closing what was never intended.

## 4. Your screen: `/desk/carry`, number by number

Open the launcher (`/`) → **desk · carry**. Everything on the page is a projection of
the desk's durable checkpoints (`carry_book_state` + `mm_nav`); the page can't trade,
and the browser computes nothing.

**The liveness banner — read this first, always.**
The runner checkpoints every ~60s; checkpoint age is its heartbeat:

| banner | meaning | your move |
|---|---|---|
| `DESK LIVE` (green) | checkpointing on cadence | nothing — enjoy |
| `DESK STALE` (amber) | polls missed for 3–15min | watch it; check host/network if it persists |
| `DESK DOWN` (red) | books OPEN, no heartbeat ≥15min | **act now** — §6.1. The DD kill-switch and daily re-gate are INERT while it's down (that's #92's whole story) |
| `DESK IDLE` | no open books | normal between runs |

**The stat strip.** `realised-first` (the judged number — funding + realised − fees,
summed over every book the desk has ever run, closed ones included); `funding accrued`
(should grind up hourly); `fees` (coloured by contribution: costs red, rebates green);
`basis MTM` (open marks — breathe with it, don't judge by it); `max drawdown vs 0.5%`
(from the desk aggregate curve — amber past half budget, red past 80%); `books n open
· m closed`.

**The books table.** Per book: structure (long spot / short perp or mirror), the gate's
annualized % at entry (what qualified it — compare against what it's actually paying),
age, funding/fees/realised-first, basis MTM (open) and `checkpoint` age (a single
lagging book = its feed, not the process). **CLOSED rows stay on screen deliberately** —
closed P&L is desk history, bug or not. The LIT row is supposed to make you ask what
happened; the postmortem is the answer. That is the honesty doctrine working.

**The NAV sparkline** (`@carry`, 48h): the desk equity curve from the durable store —
the same series a month-end wrap will cite, so what you see is what gets reported.

**The runbook palette**: copy-buttons for the four real controls (§5). The page never
executes anything — read-only is a design guarantee, not a limitation.

## 5. Your day (10 minutes, honestly)

**Morning check, in order:**
1. Liveness **LIVE**? If not → §6.1.
2. `realised-first` trending up over days? (Not hours — the edge drips.)
3. `maxDD` inside budget? Amber/red → §6.3.
4. Funding column beating fees per book? A book below breakeven pace mid-window is
   *fine* (hold-past-breakeven); persistent negative funding is the re-gate's job —
   verify it fired at the 24h mark (`DE-VALIDATED` in the log) rather than overriding.
5. **Run the daily differential board** (measurement first — M2 needs 7 consecutive
   days before any cross-venue leg may open):
   `npx ts-node -r tsconfig-paths/register scripts/funding-differential-board.ts`

**The four process controls** (terminal, not browser):

```bash
bash scripts/launch-carry-30d.sh           # start supervised (nohup+pidfile)
bash scripts/launch-carry-30d.sh status    # heartbeat + last log lines
bash scripts/launch-carry-30d.sh stop      # graceful: books checkpoint OPEN
CCB_SYMBOL=<SYM> CCB_REASON="<why>" \
  npx ts-node -r tsconfig-paths/register scripts/carry-close-book.ts   # runner DOWN only
```

**Weekly:** score from the durable store, never the raw log
(`mm_nav WHERE desk='carry'`), read the TCA receipts against the ≤2bps/leg
pre-registration, and write the journal entry. The journal is the desk's memory —
an unrecorded week didn't happen.

## 6. The playbook (when to act, and the reasoning)

**6.1 DESK DOWN.** Don't panic — *resume-not-flatten* means you lose time, not money:
books are checkpointed OPEN, and on relaunch the offline gap's funding is replayed
from the venue's *settled* history (not estimated). But move promptly: while it's
down, nothing enforces the DD budget or the re-gate. `status` → read the last log
lines → `start`. If it died on an error, the log tail is the journal entry.

**6.2 A position the strategy never intended** (wrong asset, wrong size, a pair you
can't explain): **close it now, at whatever the mark says.** You have no thesis about
it, so its expected value is unknown and its variance is unpriced — a rational desk
pays to shed unpriced variance. The LIT case is canon: marked −$1,054 at review,
closed +$268 three hours later. Both numbers were luck; the close was right at both.
Grade decisions, not outcomes — the operator who "waits to see if it comes back" is
training the desk's worst reflex.

**6.3 Drawdown approaching budget.** The kill-switch fires itself at 0.5% *if the
process is up* (why liveness is check #1). Your job is verification, not anticipation:
don't pre-empt the budget on nerves (that's moving goalposts too — in the safe
direction, but it corrupts the pre-registered test). If it fires: the desk flattens,
reports, exits nonzero. The next session's job is diagnosis, not relaunch-and-hope.

**6.4 A book's basis MTM looks big.** Within a few tenths of a percent of notional:
the basis breathing — do nothing. Persistently wide (approaching whole percents):
that's not carry weather, that's an identity alarm — the guard should have made it
impossible, so treat it as a bug hunt (§6.2 close + postmortem), not a trade.

**6.5 What you never do.** Override a gate. Judge a day by unrealised. Delete or edit
a row (attribution happens in the journal, not by rewriting history). Trade manually
against the desk. Run research from the browser (research runs from the terminal; the
UI is a read-only view — an architectural guarantee that also keeps the demo honest).

## 7. Honest caveats (say them before anyone asks)

- **Paper flatters carry.** No counterparty risk, no real liquidation engine, no
  margin funding cost, no borrow scarcity. The margin model narrows the gap; it does
  not close it. The demo's claim is *process and truthful accounting*, not riches.
- **The edge is regime-dependent.** Funding follows leverage demand; a long risk-off
  stretch can mute or invert it. That's what the recency veto and daily re-gate are
  for — expect the desk to *sit out* sometimes. Sitting out is a position.
- **Single-window numbers aren't gospel.** One 9.6h launch, one closed bug book. The
  30-day curve is the test; resist quoting anything shorter as a result.

## 8. Where everything lives

| you want | go to |
|---|---|
| the plan + current state (update every session) | [PROFIT_PIVOT_II.md](PROFIT_PIVOT_II.md) §4 ledger |
| the chronological truth (per-run numbers) | [QUANT_JOURNAL.md](QUANT_JOURNAL.md) |
| the hardest lesson, taught properly | [TICKER_COLLISION_POSTMORTEM.md](TICKER_COLLISION_POSTMORTEM.md) |
| the screens, role by role | [UI_ROLE_GUIDE.md](UI_ROLE_GUIDE.md) · design: [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) · next: [UI_REWRITE_PLAN_II.md](UI_REWRITE_PLAN_II.md) |
| how paper trading works here | [PAPER_TRADING.md](PAPER_TRADING.md) |
| the whole mission + binding rules | [../CLAUDE.md](../CLAUDE.md) |

*Last word: the desk's controls are processes, not properties — a kill-switch that
isn't running protects nothing, and a number nobody reads honestly reports nothing.
You are the part of the system that keeps both true.*
