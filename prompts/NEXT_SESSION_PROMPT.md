# Next session prompt — Meridian Markets stat-arb engine

> Paste this verbatim into the next Claude Code session in `/home/nexus/code/meridian-markets`.

## Where we are (read first)

- `git log` recent: `dc6ed02` (real-history backfill + real-data backtest; slippage + risk gate in live loop), `f4eae9e` (real paper trading: live Binance data spine + live event loop).
- The repo is a **trading engine**, not a gated demo. The "business gate" framing (KYB/Phase-2/Phase-4/mock-default-as-binding) was removed. Gates are **engineering** switches now: `paper` needs nothing; `canary`/`live` need `LIVE_TRADING_ARMED=true`.
- **Working today:** `FEED_SOURCE=binance EXECUTION_MODE=paper LIVE_AUTOSTART=true` paper-trades BTC/ETH live (real Binance public data → `PairsStrategy` → `PaperVenue` → MTM → `stat_arb_trades`). Real-data backtests run via `POST /api/market-data/backfill` then `POST /api/market-data/backtest`. Control plane: `/api/stat-arb/live/{start,stop,tick,snapshot}`.
- Read: `CLAUDE.md` §1+§7, `docs/PAPER_TRADING.md`, `docs/SESSION_HISTORY.md` §8.

## Hard rails (binding — keep)

- Modular monolith; one repo, one DB, one ordered migration history (CLAUDE.md §6).
- `process.env` only in `src/config/app-config.factory.ts`.
- Append-only ledger tables grant `SELECT, INSERT` only to `meridian_markets_app`; extend `src/database/append-only.int-spec.ts` for any new movement table.
- Never touch the Lira-Bridge repo; HTTP-only via `ITreasuryClient`.
- **No business/KYB/Phase language.** Real money is an `EXECUTION_MODE=live` + `LIVE_TRADING_ARMED=true` engineering decision; a real-money go is a human action outside the code.
- `tsc --noEmit` clean + `jest` green + a smoke against real Binance before each commit. End the session with one coherent commit on `master`.

## Track A — Session 10: multi-strategy router + funding-carry + budget allocator (~70 specs)

The desk runs N strategies on one capital pool; a router decides allocation.

1. `src/stat-arb/strategies/strategy-registry.ts` — registry; each strategy declares `id`, `capitalRequest()`, `onBar()`. `PairsStrategy` adapts to it.
2. `src/stat-arb/strategies/funding-carry.ts` — long perp / short spot when funding < 0 (reverse when > 0); half-life exit on funding-regime flip. Reads a perp funding rate via a new `funding-rate.interface.ts` seam (`FEED_SOURCE`-style: real Binance funding endpoint vs mock).
3. `src/stat-arb/capital/budget-allocator.ts` — strategies declare requested notional + est. Sharpe; allocator does mean-variance with constraints. Pure, tested against a fixture.
4. `src/execution/live-paper-trader.ts` — generalise from one `PairsStrategy` to a set of registered strategies sharing the allocator's capital; per-strategy PnL attribution in `/snapshot`.
5. Dashboard: a **Strategies** card (per-strategy PnL, capital %, regime chip).

**Done when:** two strategies (pairs + funding-carry) run concurrently in one paper loop against real data with shared capital; per-strategy PnL attributable; one commit.

## Track B — Session 18: real-venue activation (engineering, NOT business)

Make a real venue adapter so `canary`/`live` can be armed. No KYB framing — this is "the integration is wired and a testnet round-trip passed."

1. `src/stat-arb/venues/rate-limiter.ts` — token-bucket (weight-aware, time-injected), pure + tested.
2. `src/stat-arb/venues/binance-signer.ts` — HMAC-SHA256 query signing; test against Binance's published vector.
3. `src/stat-arb/venues/venue-credentials.ts` — load `BINANCE_API_KEY/SECRET` via `ISecretProvider` (re-read each call → rotation-safe; throws if missing).
4. Make `RealBinanceVenue` a real adapter: compose rate-limiter + signer + credentials + an injected `IHttpSender` (no sender ⇒ stays dormant/throws `TradingVenueNotConfiguredError`; tests inject a fake — no network).
5. `src/stat-arb/venues/real-hyperliquid-venue.ts` — dormant `ITradingVenue`, EIP-712 signing noted; parallels Binance.
6. `src/stat-arb/venues/testnet-harness.ts` — `runTestnetRoundTrip(venue, {symbol, notionalUnits})` → `{ok, steps[]}`; tested against `MockTradingVenue` (ok) + a throwing venue (captures error).
7. Extend `ExecutionModeBootGuard`: in `live` mode require `reconciliationIntervalMs > 0` (mandatory reconciliation) and credentials present.
8. `docs/RUNBOOK_KEY_ROTATION.md` — rotating `MERIDIAN_CLIENT_KEY`, exchange keys, DB passwords without downtime.

**Done when:** testnet round-trip passes against a configured fixture (no real network in tests); boot assertions refuse `live` without arm + creds + reconciliation; one commit. Real-money flip stays a separate human action.

## Track C — paper→live parity follow-ons (pick up if A/B leave room)

1. Wire the exec algos (TWAP/VWAP/POV/iceberg) + slippage attribution into the live loop (today `PaperVenue` fills the full notional at the ticker; slippage model exists but only the simple linear adjust is in the loop).
2. WebSocket feed behind `IBarFeed` (lower latency than REST poll) — no loop changes.
3. Live MTM + a single dense **ops view** (positions, PnL, z/β/regime, gate states, feed-age, fills tape) — and retire the 6 persona tabs to a read-only overview.
4. Multi-pair: run the discovery output's top pairs concurrently in paper.

## Suggested order

Track B first if real-venue readiness is the priority; Track A first if breadth/alpha is. Either is independent. Update `docs/SESSION_HISTORY.md` and CLAUDE.md §8 when done.
