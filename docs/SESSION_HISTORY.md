# Meridian Markets — Session History

Per-session log. Architectural notes that earn keep-around status get a numbered §; everything else is one-paragraph context for future-you.

---

## 1. Session 1 — Phase 0 scaffold (2026-05-26)

**Goal:** execute [prompts/PHASE_0_PROMPT.md](../prompts/PHASE_0_PROMPT.md). Treasury yield service: NestJS scaffold + append-only ledger + `IYieldProvider` interface + mock-default + dormant Ondo stub + HTTP API + tests.

### Shipped

- **Scaffold.** NestJS 10 + TypeScript strict (CommonJS), Postgres 16 on port 5433, `tsconfig` / `tsconfig.build` / `nest-cli.json` / `docker-compose.yml` / `.env.example` mirrored from Lira-Bridge's conventions.
- **Migration `1715000000000-Initial.ts`.**
  - `treasury_movements` — append-only ledger. `meridian_markets_app` role has `SELECT, INSERT` only (no UPDATE/DELETE). `chk_amount_positive` CHECK enforces `> 0`. `(provider, idempotency_key)` UNIQUE for replay safety. `(provider, created_at::date) WHERE direction='YIELD_ACCRUAL'` UNIQUE for cron idempotency.
  - `treasury_positions` — mutable cached current view; `(provider)` PK; `SELECT, INSERT, UPDATE` for the app role; no DELETE.
  - `meridian_markets_app` LOGIN role created; privilege grants asserted in `src/database/append-only.int-spec.ts`.
- **Secrets** — `ISecretProvider` + `EnvSecretProvider` copy-pattern from Lira-Bridge. `SecretsModule` is `@Global()`.
- **Config** — typed `AppConfig`; `appConfigFactory` is the only sanctioned `process.env` reader.
- **Database** — `DbService.runInSerializableTransaction(fn)` with retry-once-on-`40001`. `DatabaseModule` is `@Global()` and connects as `meridian_markets_app`.
- **Yield** — `IYieldProvider` interface with `deposit / withdraw / fetchPosition`. `MockYieldProvider` is deterministic (injectable clock for tests, simple time-weighted yield accrual). `RealOndoYieldProvider` throws `YieldProviderNotConfiguredError` on every method until `MOCK_YIELD_ENABLED=false` AND `ONDO_*` secrets are populated. Factory in `YieldModule` selects on `cfg.yield.mockEnabled`.
- **Treasury** — `TreasuryService.deposit/withdraw/getPosition/getYieldEarned/syncYield`. Every state change is a SERIALIZABLE transaction with idempotency-key dedup. `TreasuryController` serialises BigInts as strings (JSON doesn't carry them). `TreasuryClientGuard` enforces `x-meridian-client-key`. `YieldSyncCron` polls `IYieldProvider.fetchPosition()` and writes `YIELD_ACCRUAL` movements, capped at one per provider per day by the unique partial index.
- **Tests** — 51 tests across 9 suites:
  - `src/secrets/env-secret.provider.spec.ts` (8)
  - `src/yield/mock-yield-provider.spec.ts` (10)
  - `src/yield/real-ondo-yield-provider.spec.ts` (4)
  - `src/treasury/treasury.errors.spec.ts` (2)
  - `src/treasury/treasury-client.guard.spec.ts` (5)
  - `src/treasury/treasury.controller.spec.ts` (9)
  - `src/treasury/treasury.service.int-spec.ts` (6 — DB-gated)
  - `src/database/append-only.int-spec.ts` (4 — DB-gated)
  - `src/treasury/yield-sync.cron.spec.ts` (3)
  - DB-gated suites use `describeIfDb` + `dbAvailableCached` and pass-as-skipped when Postgres on `:5433` is unreachable.

### Architectural notes (binding for future sessions)

1. **`treasury_movements` is forever append-only at the DB privilege layer.** Future migrations may add columns but MUST NOT grant UPDATE or DELETE to `meridian_markets_app`. The privilege test is the regression oracle.
2. **The `IYieldProvider` swap seam is the only point of variance for yield providers.** Adding BUIDL or sDAI is "implement the interface + register in the factory" — no service-layer changes. Same posture as Lira-Bridge's `IBridgeApiClient` / `IOnRampAdapter` family.
3. **Real Ondo wire-up is a business gate, not an engineering gate.** The stub stays NotConfigured until KYB completes. Do not implement real REST calls before that — wrong order.
4. **Cross-service auth is v1 (shared secret in `x-meridian-client-key`).** Replace with mTLS or signed JWT before either side handles real money. Documented in [INTEGRATION_WITH_LIRA_BRIDGE.md](INTEGRATION_WITH_LIRA_BRIDGE.md) §4.
5. **TreasuryService runs the provider call inside the SERIALIZABLE tx today.** Fine for the mock (zero side effects beyond memory). When the real Ondo provider lands, the deposit/withdraw ordering moves to a saga/outbox so a DB rollback after a provider mint isn't possible. Flagged for Phase 1 hardening.
6. **The yield-sync cron is single-replica.** If the service ever runs >1 instance, only one should run the cron — same posture as Lira-Bridge's crons today (no leader election; deployment-level constraint).

### Open follow-ups

- **Lira-Bridge-side `ITreasuryClient` implementation.** Separate session, separate repo (`/home/nexus/code/meridian`). One-line factory swap once it lands.
- **KYB with Ondo.** Business track; engineering unblocked the day it closes.
- **Phase 1 FX hedge orchestrator** — see [Session 2](#2-session-2--phase-1-hedge-scaffold--stat-arb-course-2026-05-26) and [PHASE_1_PROMPT.md](../prompts/PHASE_1_PROMPT.md).
- **Multi-provider routing.** Single provider is enough for v1. Defer.

---

## 2. Session 2 — Phase 1 hedge scaffold + stat-arb course (2026-05-26)

**Goal:** make as much Phase 1 + Phase 3 progress as possible in a tight time budget. Two tracks ran in parallel; both delivered as scaffold-level rather than full implementation.

### Shipped

- **Phase 1 FX hedge scaffold** — `src/hedge/`:
  - `hedge-venue.interface.ts` — `IHedgeVenue` + types (`OpenShortRequest/Result`, `CloseShortRequest/Result`, `HedgePosition`, `VenueHealth`) + errors (`HedgeVenueNotConfiguredError`, `HedgeVenueUnhealthyError`, `HedgeVenueInsufficientMarginError`, `HedgePositionNotFoundError`).
  - `mock-hedge-venue.ts` — deterministic, injectable clock, bigint arithmetic in micros (1e6) for prices and 6-decimal units for notional. 10 bps/day funding placeholder; configurable linear ILS drift.
  - `real-hyperliquid-hedge-venue.ts` — dormant; throws `HedgeVenueNotConfiguredError` on every method. Same posture as `RealOndoYieldProvider`.
  - `hedge.module.ts` — factory selects on `MOCK_HEDGE_ENABLED`.
  - `mock-hedge-venue.spec.ts` (9 specs) + `real-hyperliquid-hedge-venue.spec.ts` (5 specs) — pure-unit, mirror the `mock-yield-provider.spec.ts` patterns.
- **Config additions** — `AppConfig.hedge.{mockEnabled, mockFxDriftBpsPerDay, mockSettleMs}`. New env keys `MOCK_HEDGE_ENABLED`, `MOCK_HEDGE_FX_DRIFT_BPS_PER_DAY`, `MOCK_HEDGE_SETTLE_MS` in `.env.example`. `HedgeModule` registered in `AppModule`.
- **`docs/STAT_ARB_PLAN.md`** — full engineering plan for Phase 3 stat-arb: strategy taxonomy, reference-repo table (URLs flagged unverified pending next-session WebFetch), proposed `src/stat-arb/` module layout, 6-step phased build-out, open questions.
- **`prompts/PHASE_1_PROMPT.md`** — next-session prompt for the Phase 1 orchestrator (HedgeService, monitor cron, circuit breakers, hedge_movements/positions migration). Done-when criteria explicit; out-of-scope items called out.
- **`courses/stat-arb/`** — mkdocs course backing the Phase 3 plan:
  - `mkdocs.yml` building with vanilla mkdocs + readthedocs theme (upgrade path to mkdocs-material + pymdownx documented).
  - Chapters §0 (charter & sources), §1 (intro), §2 (cointegration), §3 (OU), §4 (execution), §5 (risk) — full first drafts with Mermaid diagrams and inline math.
  - Chapters §6 (backtesting), §7 (production), Appendix A (code shapes) — outlines only.
  - Appendix B sources notebook with tier system (A verified, B unverified pending WebFetch, C placeholder).
  - `docs/RESEARCH_PROMPT.md` — detailed self-contained prompt to run in a Claude Code desktop session with web access to verify sources, identify the user-mentioned X thread, flesh out §6/§7/Appendix A, upgrade the mkdocs theme, and add charts.
- **Verified**: `npx tsc --noEmit -p tsconfig.json` clean; `npx jest src/hedge` green (14 new hedge specs); `mkdocs build` clean (warnings are cross-doc-root links, expected).

### Architectural notes (binding for future sessions)

1. **The hedge module follows the swap-seam pattern verbatim.** Future venues (Drift, GMX) implement `IHedgeVenue` and register in the `HedgeModule` factory. No service-layer changes when adding venues.
2. **Bigint price math in micros (1e6) is the codebase convention.** Same as `treasury_movements.amount_units` (USDC micros). `MockHedgeVenue` does all FX math in bigint with explicit scaling to avoid precision loss — the pattern extends to any future hedge venue.
3. **The hedge module ships with no DB tables yet.** Persistence (`hedge_movements`, `hedge_positions`) lands in [PHASE_1_PROMPT.md](../prompts/PHASE_1_PROMPT.md)'s next session. The swap seam works without persistence; persistence is the orchestrator's concern, not the venue's.
4. **`courses/stat-arb/` is documentation, not code.** It lives under `courses/` (not `docs/`) to keep mkdocs-built sites separable from the repo's flat-file docs. The course's existence does not create a Phase 3 commitment — implementation is still gated behind Phase 2 legal formation per [PHASED_PLAN.md](../PHASED_PLAN.md) cross-phase dependency #1.

### Open follow-ups

- **Phase 1 orchestrator** — see [PHASE_1_PROMPT.md](../prompts/PHASE_1_PROMPT.md).
- **Stat-arb course research** — completed in [Session 3](#3-session-3--stat-arb-course-research-mkdocs-upgrade-rohonchain-archive-2026-05-26).
- **X-thread identification** — resolved in Session 3.

---

## 3. Session 3 — Stat-arb course research, mkdocs upgrade, RohOnChain archive (2026-05-26)

**Goal:** execute [courses/stat-arb/docs/RESEARCH_PROMPT.md](../courses/stat-arb/docs/RESEARCH_PROMPT.md) variant — identify the user-mentioned "rohn / roan" X handle, archive the threads, fold their material into the mkdocs course alongside Tier-A literature, flesh out §6 / §7 / Appendix A from outline to full chapter, add Appendix C for practitioner lore, and upgrade the mkdocs theme to Material with Mermaid + MathJax rendering.

### Shipped

- **X archive — `@RohOnChain` identified and three artifacts captured under `courses/stat-arb/docs/_archive/`:**
  - [`x-search-attempt-2026-05-26.md`](../courses/stat-arb/docs/_archive/x-search-attempt-2026-05-26.md) — search log documenting every URL attempted (X gated with HTTP 402; nitter empty; Wayback blocked; rattibha 403), the WebSearch queries that surfaced the threads, and the confidence statement that earns promotion to Tier-C verified.
  - [`roan-markov-hedge-fund-method-2026-05-26.md`](../courses/stat-arb/docs/_archive/roan-markov-hedge-fund-method-2026-05-26.md) — full verbatim text of the Markov Hedge Fund Method framework from the public companion repo `jackson-video-resources/markov-hedge-fund-method` (211 ⭐, MIT, explicit Roan attribution). 12 claims extracted with Tier-A mappings (Hamilton 1989, Rabiner 1989, López de Prado 2018).
  - [`roan-fundamental-law-active-mgmt-2026-05-26.md`](../courses/stat-arb/docs/_archive/roan-fundamental-law-active-mgmt-2026-05-26.md) — paraphrase of the "50 weak signals / Fundamental Law of Active Management" thread (original X gated; recovered second-hand from PANews structured summary and acidcapitalist write-up). 8 claims extracted with Tier-A mappings (Grinold 1989, Grinold & Kahn 1999, Clarke et al. 2002).
- **New course sections (per the Session 3 prompt's priority list):**
  - **§2.8** "Universe construction — from infinite candidate pairs to a tractable book." 600+ words, concrete crypto numbers, six-stage funnel, multiple-testing treatment, Practitioner-note callout on cross-family diversification.
  - **§2.9** "Spread-staleness diagnostics — knowing when a cointegrated pair has broken." 500+ words, four diagnostics in order of decisiveness, regime-catalyst table, Practitioner-note on per-leg Markov persistence as a 5th diagnostic.
  - **§3.6** "Reading the OU fit — diagnostics in practice." 600+ words, healthy-vs-unhealthy theta patterns, refit cadence guidance, kill-switch theta floor anchors, Practitioner-note on HMM-as-upgrade-path with multi-seed discipline.
  - **§4.5** "Passive vs aggressive entry/exit — the asymmetry." 500+ words, entry-passive / exit-aggressive rationale, fee-table walkthrough showing 40% fee reduction from getting the asymmetry right, chase-logic refinement, AC01 Almgren-Chriss grounding.
- **§6 "Backtesting honestly"** — outline → full chapter (~2000 words). Look-ahead / survivorship / multiple-testing failure modes; event-driven loop sketch; purged k-fold worked example with the embargo-window table; fee/slippage audit loop; DSR closed-form math with reporting block template; survivorship war stories; sensitivity-to-defaults methodology; Practitioner-note tying both RohOnChain threads to the DSR / walk-forward discipline.
- **§7 "From paper to production"** — outline → full chapter (~1800 words). Shadow phase acceptance bands; minimum-capital phase acceptance bands; capital-ramp curve with concrete dollar amounts ($50k → $5M); Phase-2 gate guarding all execution; daily and weekly operational checklists as literal checklists (not prose); audited-NAV section with the three providers (NAV Consulting next-business-day delivery, SS&C GlobeOp monthly-final with SOC 1, Sudrania crypto-native daily NAV with 120+ API connections); decision matrix; engineering-side artifacts required by any administrator.
- **Appendix A "Code-shape catalogue"** — outline → full chapter (~2200 words). Ten patterns: swap-seam, pure signal functions, IStrategy, append-only ledger, bigint price arithmetic, risk-layer pipeline, deterministic-clock, factory selector, DB-gated integration spec, cross-pattern composition. Each pattern has a TypeScript signature, a 5-line Jest test pattern, and a pointer to the existing repo file that demonstrates the same shape.
- **Appendix C "Practitioner lore (RohOnChain archive)"** — new chapter. 12 Q&A entries each with archive provenance, Tier-A mapping, and the chapter section the claim lands in. Explicit "what's not in this appendix" section ruling out unverifiable and contradicting claims.
- **Practitioner-note callouts** added to §2.8, §2.9, §3.6, §5.2, §5.3, §6.7 — each one cites the relevant archive file and pairs the practitioner claim with its Tier-A source.
- **Appendix B updates:**
  - §B.1 (Tier A) expanded from 9 to 19 entries — added Bailey-López de Prado, Bailey-Borwein, Grinold, Grinold-Kahn, Clarke-de Silva-Thorley, Hamilton, Rabiner, Ang-Bekaert, Asness-Moskowitz-Pedersen, Benjamini-Hochberg, Lo-MacKinlay. All of these are referenced from new course content.
  - §B.3 (Tier C) replaced the unverified placeholder with the verified RohOnChain rows (archive paths, fetch dates, claims-extracted counts, verdict mixes, chapter-citation lists).
  - §B.4 verification ledger gained four new rows for this session.
- **mkdocs upgrade** to Material theme: `requirements.txt` pins `mkdocs-material>=9.5` and `pymdown-extensions>=10`; `mkdocs.yml` switched to the Material theme with navigation features, light/dark indigo palette with toggles, all the relevant `pymdownx.*` extensions (arithmatex for MathJax, superfences with mermaid custom_fence, highlight, inlinehilite, snippets, details, tabbed), MathJax + Mermaid CDN references in `extra_javascript`. `validation.links.{not_found, unrecognized_links}` set to `ignore` so the four-then-thirty-three cross-doc-root-link warnings (links pointing to PHASED_PLAN.md, CLAUDE.md, src/yield/, src/hedge/, etc.) don't fail strict mode.
- **`mkdocs build --strict`** succeeds clean. Site output structurally verified to contain MathJax script references, mermaid `class="mermaid"` divs in §1/§2/§3/§4/§5, arithmatex blocks in math-heavy chapters (33 in §2, 31 in §3, 15 in §5, 18 in §6), Material's `md-header__button` and `slate` (dark mode) hooks.
- **`.gitignore`** at `courses/stat-arb/.gitignore` fixed to use the correct relative paths (`site/`, `.venv/`, `__pycache__/`) so the build output and virtualenv aren't committed.

### Architectural notes (binding for future sessions)

1. **Practitioner threads (Tier C) are always paired with Tier-A mappings.** Every promoted claim in the RohOnChain archive maps to a peer-reviewed source. Per [`00-charter-and-sources.md §0.3`](../courses/stat-arb/docs/00-charter-and-sources.md), no Tier-C claim is ever the sole support for a course assertion. If a future session adds Tier-C material, the same discipline binds.
2. **The archive files are the durable record.** X content rots; the verbatim Markov Hedge Fund Method text + the FLAM thread paraphrase live in `courses/stat-arb/docs/_archive/` for the course's own use even if the X timeline disappears.
3. **mkdocs `validation.links: ignore`** is intentional, not a hack. The course chapters reference repo files outside `docs/` (PHASED_PLAN.md, CLAUDE.md, src/yield/, src/hedge/) by design — they're working-document cross-references rather than site-internal navigation. Future sessions adding new such links don't need to update the validation config.
4. **The `_archive/` directory uses a leading underscore to keep its files out of mkdocs nav** (per the prompt's specification) but they're still indexed and `--strict`-buildable. Future archive files should use the same naming convention `_archive/<source>-<topic>-<YYYY-MM-DD>.md`.

### Verification gap (honest disclosure)

- **mkdocs build clean under --strict: confirmed.** Output HTML contains the MathJax script tag, mermaid `class="mermaid"` divs, arithmatex spans, and Material's `slate` dark-mode toggle hook.
- **Visual browser confirmation: NOT done.** This agent runs on Windows host but operates against the WSL filesystem and has no way to open a browser at http://127.0.0.1:8000. The structural confirmation above is the best I can offer; a follow-up `mkdocs serve` in a real shell + browser visit is needed to claim the rendering is *visually* correct.

### Open follow-ups

- **Browser-level visual confirmation** of MathJax, Mermaid, dark-mode toggle, and code-block copy buttons. Single human task: `cd courses/stat-arb && .venv/Scripts/python.exe -m mkdocs serve` then open http://127.0.0.1:8000, click through §1–§7 and Appendix A–C, toggle dark mode, copy a code block. Should take ~5 minutes.
- **Tier-B repo URL verification** (the `❌` rows in [Appendix B §B.2](../courses/stat-arb/docs/appendix-b-sources.md)) — still pending. Could be done in any follow-up session.
- **The "Neural Networks" RohOnChain thread** (`https://en.rattibha.com/thread/2052043443766194272`) — body gated at fetch time. If the user has a saved copy, archive it and promote; otherwise leaves the pointer in [`_archive/x-search-attempt-2026-05-26.md`](../courses/stat-arb/docs/_archive/x-search-attempt-2026-05-26.md) for a future retry.

---

## 4. Session 4 — Phase 1 orchestrator (2026-05-27)

**Goal:** flesh out the Phase 1 FX hedge module beyond the scaffold: persistence, `HedgeService`, `HedgeMonitorCron`, circuit breakers, and 29 net-new tests. Brings Phase 1 to a completeable state. Demo surface deferred to Session 5.

### Shipped

- **Migration `1716000000000-AddHedgeTables.ts`** — two tables with the same privilege posture as Phase 0:
  - `hedge_movements` — append-only ledger. `meridian_markets_app` has `SELECT, INSERT` only. `chk_hm_direction` and `chk_hm_notional` CHECK constraints enforce valid directions and sign conventions. `(venue, idempotency_key)` UNIQUE for replay safety. Two partial unique indexes: `uniq_mark_per_position_per_day` (MARK_TO_MARKET, cron idempotency) and `uniq_funding_per_position_per_day` (FUNDING_ACCRUAL, same).
  - `hedge_positions` — mutable cached view. `SELECT, INSERT, UPDATE` for the app role; no DELETE.
  - Privilege assertions added to `src/database/append-only.int-spec.ts` (+4 specs).

- **`src/hedge/hedge.errors.ts`** — `InvalidHedgeAmountError` and `FeedStaleError`. Mirrors `treasury.errors.ts`.

- **`src/hedge/exposure-client.interface.ts`** — `IExposureClient` interface + `StubExposureClient`. `StubExposureClient` returns 500k USDC outstanding exposure by default. Real `LiraBridgeExposureClient` is a separate session in `/home/nexus/code/meridian`. New `EXPOSURE_CLIENT` DI token.

- **`src/hedge/hedge-circuit-breaker.ts`** — `HedgeCircuitBreaker` `@Injectable()`. Three gates:
  1. Venue health: `checkVenueHealth(health)` — throws `HedgeVenueUnhealthyError` if `!healthy` or `lastFundingBps > maxFundingBps`.
  2. Feed staleness: `checkFeedStaleness(asOf)` — throws `FeedStaleError` if exposure feed is older than `maxFeedStalenessMs`.
  3. Liquidation buffer: `maxNotional(marginUnits)` — returns `margin × 10_000 / (3 × ilsSigmaBps)` so callers can verify sizing stays inside the 3σ ILS-move buffer.

- **`src/hedge/hedge.service.ts`** — `HedgeService`. Five public methods:
  - `openShort(notional, key)` — checks circuit breaker, calls venue, writes `OPEN_SHORT` movement + `hedge_positions` row in a SERIALIZABLE tx. Idempotent on `(venue, key)`.
  - `closeShort(positionRef, key)` — calls venue, writes `CLOSE_SHORT` movement (negative notional + realised PnL), marks position closed.
  - `getPosition(positionRef)` — reads from `hedge_positions` cache; falls back to `venue.fetchPosition()` if `updated_at` is older than `positionStalenessMs`.
  - `getTotalOpenNotional()` — sums notional of open positions for the configured venue.
  - `listOpenPositionRefs()` — returns `position_ref` values of open positions, oldest-first.
  - `markAll()` — iterates open positions, calls `markPosition()` per position (one MARK_TO_MARKET per day via unique index), updates cache; swallows per-position errors and continues.

- **`src/hedge/hedge-monitor.cron.ts`** — `HedgeMonitorCron`. Runs on `HEDGE_MONITOR_INTERVAL_MS` (default 60s). Per tick:
  1. Fetches exposure from `IExposureClient`.
  2. Checks feed staleness via `HedgeCircuitBreaker`.
  3. Checks venue health via `HedgeCircuitBreaker`.
  4. Computes target notional (`hedgeRatioPct%` of outstanding USDC exposure).
  5. Rebalances: opens a short for the delta if under-hedged by > `rebalanceThresholdPct%`; nuke-and-pave if over-hedged; does nothing within threshold.
  6. Calls `hedgeService.markAll()`.
  - Circuit-breaker fires and unexpected errors are caught, logged, and do not rethrow — the interval survives.
  - `nodeEnv === 'test'` skips `setInterval` (same as `YieldSyncCron`).

- **`src/config/app-config.interface.ts`** — added to the `hedge` section: `maxFundingBps`, `maxFeedStalenessMs`, `hedgeRatioPct`, `rebalanceThresholdPct`, `monitorIntervalMs`, `ilsSigmaBps`, `positionStalenessMs`.

- **`src/config/app-config.factory.ts`** — reads the 7 new env vars (`HEDGE_MAX_FUNDING_BPS`, `HEDGE_MAX_FEED_STALENESS_MS`, `HEDGE_RATIO_PCT`, `HEDGE_REBALANCE_THRESHOLD_PCT`, `HEDGE_MONITOR_INTERVAL_MS`, `HEDGE_ILS_SIGMA_BPS`, `HEDGE_POSITION_STALENESS_MS`).

- **`.env.example`** — documents all 7 new env vars with rationale comments.

- **`src/hedge/hedge.module.ts`** — updated to provide `EXPOSURE_CLIENT` (useValue: StubExposureClient), `HedgeCircuitBreaker`, `HedgeService`, `HedgeMonitorCron`, and export `HedgeService`.

- **`docs/INTEGRATION_WITH_LIRA_BRIDGE.md`** — §9 added: `GET /api/path-c/outstanding-exposure` endpoint definition, auth, polling cadence, and Lira-Bridge implementation notes.

- **Tests — 29 net-new specs (65 → 94 total):**
  - `hedge-circuit-breaker.spec.ts` (7 specs) — each gate; maxNotional formula.
  - `hedge.service.spec.ts` (8 specs) — zero/negative notional guard; circuit-breaker pre-check; DB write; idempotency replay; markAll per-position error resilience.
  - `hedge.service.int-spec.ts` (6 specs — DB-gated) — full roundtrip: open, idempotency, close, total notional, mark idempotency.
  - `hedge-monitor.cron.spec.ts` (5 specs) — does-not-start-in-test; open when under-hedged; no-op within threshold; circuit-breaker swallowed; markAll called.
  - `append-only.int-spec.ts` additions (4 specs) — `hedge_movements` append-only; `hedge_positions` mutable-not-deletable; direction CHECK constraint.

- **`npx tsc --noEmit`** clean. `npx jest src/hedge` green.

### Architectural notes (binding for future sessions)

1. **`StubExposureClient` stays until Lira-Bridge implements `GET /api/path-c/outstanding-exposure`.** The real `LiraBridgeExposureClient` is a drop-in: implement `IExposureClient`, register as `EXPOSURE_CLIENT` in `HedgeModule`, keep the same `asOf` freshness contract. No other code changes.
2. **`HedgeCircuitBreaker` is the only place that gates on venue health and feed staleness.** Future sessions adding new hedge strategies should consult it before any `openShort`. The three-gate contract (venue health, feed staleness, max notional) is the complete Phase 1 circuit-breaker surface.
3. **The nuke-and-pave over-hedge strategy is v1-correct.** It keeps one position at a time and avoids partial-close complexity. When the hedge exposure reaches meaningful scale ($500k+), a smarter partial-close that minimises round-trip cost belongs in the Phase 1 hardening session.
4. **The `markPosition` unique-index swallow (code 23505) is the same pattern as `syncYield`.** If you add a new cron-idempotent write pattern anywhere in this codebase, check code 23505 and collapse silently; expose the collision as an error only if idempotency key logic is wrong (which 23505 on a non-cron insert would indicate).
5. **Phase 1 saga/outbox flag remains open.** The venue call in `openShort` / `closeShort` happens before the DB transaction. A DB crash after a successful venue call produces an inconsistency. Fix: move to a saga pattern (open venue → write movement → confirm) before any real-money flip. Same flag as Session 1 architectural note 5.

### Open follow-ups

- **Lira-Bridge-side `GET /api/path-c/outstanding-exposure`** — separate session in `/home/nexus/code/meridian`. Markets is ready to consume it the day it ships; just swap `StubExposureClient` for `LiraBridgeExposureClient` in `HedgeModule`.
- **KYB with Hyperliquid** (or alternate venue). Business track; `RealHyperliquidHedgeVenue` stays dormant.
- **Phase 3 stat-arb signal library + demo dashboard** — Session 5. See `prompts/PHASE_3_DEMO_PROMPT.md`.

---

## 5. Session 5 — Phase 3 stat-arb demo + signal library (2026-05-28)

**Goal:** build the Phase 3 stat-arb signal library, a deterministic backtest runner, and a live web dashboard at `http://localhost:3100/demo` for traders, operators, and sales. Mock-default; no real venue connections; not customer-facing. Scope and rails per [prompts/PHASE_3_DEMO_PROMPT.md](../prompts/PHASE_3_DEMO_PROMPT.md).

### Shipped

- **`src/stat-arb/signal/` — pure math layer (no I/O, no NestJS):**
  - `_math.ts` — `ols()` and `olsWithStats()` (closed-form normal equations, slope t-statistic). No external library.
  - `cointegration.ts` — `cointegrationTest(logA, logB)` — Engle-Granger two-step: OLS for β, ADF unit-root test on residuals via AR(1) regression, MacKinnon (1994) coarse-tabled p-value. Returns `{ beta, pValue, halfLifeBars }`.
  - `ou.ts` — `ouFit(spread)` recovers OU `θ, μ, σ` from a discrete-time AR(1) form. `bertramThresholds(fit, txCost)` returns entry/exit distances from μ; entry widens monotonically with cost.
  - `z-score.ts` — `rollingZScore(series, lookback)` (NaN-pads early indices, zero on constant windows) and `ewmaZScore(series, lambda)`.
  - `spread.ts` — `logSpread(pricesA, pricesB, beta)`.
  - **30 specs** across the math layer with seeded-RNG golden vectors so the random-walk and cointegrated cases don't flake.

- **`src/stat-arb/trading-venue.interface.ts` — execution swap seam.** `TRADING_VENUE` symbol, `ITradingVenue`, `PlaceOrderRequest`, `Fill`, `TradingVenueNotConfiguredError`. Same pattern as `HEDGE_VENUE` / `IYieldProvider`.
- **`src/stat-arb/mock-trading-venue.ts`** — deterministic per-symbol price model: hashed-seed mean + sine + linear drift, no RNG. Constant 5 bps taker fee. Idempotent on `idempotencyKey`. Injectable clock for tests.
- **`src/stat-arb/real-binance-venue.ts`** — dormant stub. Throws `TradingVenueNotConfiguredError` on every method until `MOCK_TRADING_ENABLED=false` AND Binance KYB completes.
- **9 venue specs.**

- **`src/stat-arb/backtest/` — event-driven backtest runner:**
  - `bar.ts` — OHLCV `Bar` interface (floats; venue boundary still uses bigint micros).
  - `synthetic-feed.ts` — `generateSyntheticFeed(cfg)` produces a clean oscillating log-spread (sine + minor cosine perturbation) on a slow random-walk-like drift. No RNG; bit-stable across runs.
  - `strategy.interface.ts` — `IStrategy`, `BarContext`, `DesiredOrder`. History array passed in is inclusive of the current bar.
  - `pairs-strategy.ts` — `PairsStrategy` implementing rolling-z-score pairs trading with configurable `entryZ`, `exitZ`, `notionalUnits`. Three regimes: `LONG`, `SHORT`, `FLAT`. β passed in (no per-bar refitting in the demo).
  - `backtest-runner.ts` — `BacktestRunner.run({ barsA, barsB, strategy, venue })`. Returns `{ trades, metrics, spreadSeries }`. P&L attribution: signed pair P&L net of fees on round-trip, sign-flipped for LONG vs SHORT spread positions.
  - `pnl-attribution.ts` — total P&L (bigint), Sharpe (per-trade mean/std), max drawdown %, win rate, total trades.
  - **8 specs** including a lookahead-prevention assertion (subclass `PairsStrategy` and verify `history.length ≤ index+1`).

- **`src/stat-arb/demo/` — REST API + static dashboard:**
  - `demo.service.ts` — singleton `DemoService` holding the most-recent `BacktestResult` in memory (no DB persistence in Phase 3). `runFreshBacktest()`, `snapshot()`, `reset()`, `hasResult()`.
  - `demo.controller.ts` — `GET /api/stat-arb/demo/run`, `GET /status` (auto-runs first time), `GET /history`, `POST /reset`. All bigints serialised as strings.
  - `demo-page.controller.ts` — serves `index.html` at `GET /demo`. Multi-candidate path resolution (dist asset / src / __dirname) so it works under both `nest start` and `start:prod`.
  - `public/index.html` — single-file dark-mode dashboard, vanilla JS + Chart.js via CDN. Strategy card, drawdown gauge, Chart.js z-score line with entry/exit threshold bands, trade table (last 10), metrics card (Sharpe, win rate, max DD, trades), "Run Demo" button. Polls `/status` every 5s.
  - **5 controller specs** with mocked `DemoService`.

- **Config + wiring:**
  - `AppConfig.statArb` added (`mockEnabled`, `demoBarCount`, `demoPairA`, `demoPairB`).
  - `app-config.factory.ts` reads `MOCK_TRADING_ENABLED`, `DEMO_BAR_COUNT`, `DEMO_PAIR_A`, `DEMO_PAIR_B`. Single sanctioned `process.env` reader still.
  - `.env.example` documents all four with the Phase 3 cross-phase-dep rationale.
  - `StatArbModule` registers `TRADING_VENUE` factory (mock vs Binance), `DemoService`, `DemoController`, `DemoPageController`.
  - `AppModule` imports `StatArbModule`.
  - `nest-cli.json` `assets` config copies `stat-arb/demo/public/` to `dist/` at build time.

- **No new DB migration this session.** Demo state lives in `DemoService` only, per the prompt's "out of scope" §7.

- **`npx tsc --noEmit`** clean. **`npx jest`** green: 24 suites, 150 tests (56 net-new from the 94 carried in from Session 4).

### Architectural notes (binding for future sessions)

1. **The pairs strategy uses a constant β passed via config**, not a sliding cointegration refit. That's a demo simplification per the prompt. The real Phase 3 step-2 wiring re-fits β on a sliding window before each entry — handle this when the live shadow run starts.
2. **`MockTradingVenue` has no randomness.** Every backtest with the same config and clock is bit-stable. This is deliberate so the demo is reproducible for sales walkthroughs. Do not introduce RNG; if you want noisier output use a different seeded source per symbol.
3. **The lookahead invariant is enforced by `backtest.spec.ts`.** Any future change to `BacktestRunner` that exposes more than `historyA.length ≤ index+1` will fail that test. Do not weaken it.
4. **`DemoController.status()` auto-runs a backtest if one hasn't been triggered yet.** This is so the dashboard's first paint is never a 500. Don't add a second auto-run path elsewhere — keep it in `status()`.
5. **`/demo` is a static-HTML controller (Option B from the prompt), not `@nestjs/serve-static`.** Reason: avoids adding a new npm dep this session. If a real asset pipeline is ever needed, swap in `ServeStaticModule` and remove `DemoPageController` — drop-in replacement.

### Open follow-ups

- **Verify the running dashboard end-to-end.** This session shipped the code and 150 green tests but did not start the Nest server and hit `http://localhost:3100/demo` in a browser. First action in the next session should be `npm run start:dev` + visual smoke test of `/demo` + `curl /api/stat-arb/demo/run`.
- **Phase 3 Step 2 — sliding-window β refit + live shadow run.** Replace constant-β `PairsStrategy` with one that refits cointegration on each entry; pipe live market data (CCXT) through `SyntheticFeed`'s seam.
- **Phase 3 Step 3 — risk module.** `kelly.ts`, `drawdown-gate.ts`, `venue-cap.ts` per the prompt's §7 "out of scope" list.
- **Phase 3 Step 4 — `stat_arb_trades` + `stat_arb_nav` migration.** Append-only role grants for both tables; extend `append-only.int-spec.ts`.
- **Phase 3 Step 5 — funding-carry + cross-venue spot-arb strategies.** Add additional `IStrategy` implementations alongside `PairsStrategy`.
- **KYB with Binance (or first real venue).** Business gate; `RealBinanceVenue` stays dormant.

---

## 6. Session 14 — Execution maturity (S13 backfill + paper-trading) + Lightweight Charts (2026-05-28)

**Goal:** finish the execution surface deferred from Session 13 (lite) — VWAP / POV / iceberg algos, multi-venue split routing, risk-engine on child orders, Exec persona on the dashboard — then ship Session 14 (paper venue, canary router, reconciliation cron, `EXECUTION_MODE` boot guard), and swap the dashboard's main charts from Chart.js to TradingView Lightweight Charts. 102 net-new specs (343 → 445 total).

### Shipped

- **Session 13 backfill — `src/execution/`:**
  - `vwap.ts` (10 specs) — `VwapAlgo` slices the parent proportional to a volume curve; long curves aggregate down to `maxSlices`; remainder lands on the largest-weight bucket so `sum(child notionals) === parent notional` exactly.
  - `pov.ts` (11 specs) — `PovAlgo` caps each child at `participationPct%` of `intervalVolumeUnits` and stops at `horizonMs`; under-fills when horizon is too short.
  - `iceberg.ts` (9 specs) — `IcebergAlgo` emits fixed-size visible tips spaced at `refillIntervalMs`; residual rides the last tip.
  - `multi-venue-split.ts` (8 specs) — `splitAcrossVenues({ parentNotional, venues, side })` greedily fills chunk-by-chunk by lowest marginal-cost venue. Marginal cost computed in **floating point** (slippage-model's bigint cost rounds impactBps to integer bp and truncates to 0 for small chunks). Respects per-venue `maxNotionalUnits`; reports `underfilled` when caps bind.
  - `multi-venue-router.ts` (8 specs) — `MultiVenueOrderRouter` plans across N venues + slices each allocation via the configured `IExecAlgo`. **Risk-engine on child orders:** optional `VenueCapGate` consulted before every child `placeOrder`; children breaching the cap are skipped (`blockedByCapCount` reported on the result). Supports `initialLiveNotional` so the gate is pre-loaded with prior fills.

- **Exec persona — `src/execution/exec-demo.service.ts` + `exec.controller.ts` + dashboard tab:**
  - `ExecDemoService` keeps a 25-event ring buffer of routed parents. Hard-coded 3-venue liquidity profile (`mock-a` 400M ADV, `mock-b` 200M, `mock-c` 100M) so the multi-venue split is visibly different across venues. Each route runs through `MultiVenueOrderRouter` with a `VenueCapGate` set to 30% of the parent so dashboard demos visibly trip the gate on oversized parents.
  - `ExecController` exposes `POST /api/stat-arb/exec/run?algo=&notional=&side=`, `GET /api/stat-arb/exec/recent`, `POST /api/stat-arb/exec/reset`. Bigints serialised as strings.
  - New `#exec` persona tab on `/demo` with the algo / notional / side controls, a theoretical-vs-realised slippage area chart (Lightweight Charts), recent-routes table, and an "Execution mode & KYB posture" card spelling out the boot-guard rules.

- **Session 14 — paper trading + canary + reconciliation:**
  - `paper-venue.ts` (15 specs) — `PaperVenue` implements `ITradingVenue` but writes into an in-memory book instead of hitting a network. Injectable `pricePoller` (so it can consume a live feed without DB persistence yet), idempotency replay, per-symbol long/short tracking, snapshot helpers (`bookSnapshot`, `positionSnapshot`, `netNotional`).
  - `canary-router.ts` (10 specs) — `CanaryRouter implements ITradingVenue`. Splits each parent across paper + real legs by `paperPct` (default 100). `placeOrder` returns an aggregated `Fill` with notional-weighted price; `placeOrderSplit` returns per-leg `CanaryFill` with `source` + `parentNotionalUnits` tags for the audit trail. `fetchPrice` delegates to the real venue.
  - `reconciliation.cron.ts` (9 specs) — `ReconciliationCron` sweeps every `RECONCILIATION_INTERVAL_MS` (default 60s) and emits `NET_DRIFT` / `MISSING_FILL` / `GHOST_FILL` events comparing the internal-book reader against the paper venue's book. `setSources({ internalBook, paperVenue })` plugs in the data sources; mock-default safe. Test-env skips `setInterval`.
  - `execution-mode.guard.ts` (8 specs) — `ExecutionModeBootGuard` on `OnApplicationBootstrap`. Refuses to boot in `canary` without `KYB_CONFIRMED=true`, in `live` without both `KYB_CONFIRMED=true` AND `MOCK_TRADING_ENABLED=false`. `mock` / `paper` always allowed. Throws `ExecutionModeNotPermittedError` synchronously so the process exits non-zero.
  - `execution.module.ts` — provides `ExecutionModeBootGuard` + `ReconciliationCron`. Imported by `AppModule`.

- **AppConfig + env additions:** `AppConfig.execution.{mode, canaryPaperPct, reconciliationIntervalMs, kybConfirmed}` + `ExecutionMode` type alias. New env vars `EXECUTION_MODE`, `CANARY_PAPER_PCT`, `RECONCILIATION_INTERVAL_MS`, `KYB_CONFIRMED`. Documented in `.env.example`.

- **Lightweight Charts swap on `/demo`:**
  - Loaded from `unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js`.
  - Four main canvases swapped to Lightweight Charts divs: spread (Trader), NAV (Investor), underwater (Investor), Monte Carlo fan (Research). Plus a new exec slippage chart on the Execution tab.
  - Helpers `lwGetOrCreate(id, opts)` + `lwSetSeries(id, key, type, data, options)` keep the call sites symmetrical to the old `newOrReplace` Chart.js helper. `ResizeObserver` per host handles persona-switch 0px-width windows.
  - **`GET /api/stat-arb/demo/candles?symbol=a|b`** added on `DemoController` so a future swap from synthetic feed to real `market_bars` is a single fetch URL change. Returns Unix-seconds `time` + float OHLC (Lightweight Charts format).
  - Chart.js stays in the head for the small canvas sparklines (tape, dd-spark, risk-dd-spark, risk-pval-spark, risk-exp-spark). Full Chart.js removal is queued as a follow-up nit — rewriting those decorative sparklines in either Lightweight Charts or inline SVG adds noise without UX value this session.

- **Wiring:**
  - `StatArbModule` registers `ExecDemoService` + `ExecController`.
  - `AppModule` imports `ExecutionModule`.
  - `DemoService.bars(symbol)` exposes the synthetic feed (caches `barsA` / `barsB` from each backtest run) so the candles endpoint can serve OHLC without re-running the feed.

- **E2E smoke (full):**
  - `npx tsc --noEmit` clean. `npx jest` → 445 tests / 60 suites, 6 failures = same baseline (5 `hedge.service.int-spec` sequence-grant + 1 `treasury.service.int-spec` SERIALIZABLE retry) called out in `docs/RUN_AND_TEST.md` §2.4.
  - `npm run start:prod` boots, `ExecutionModeBootGuard` logs `EXECUTION_MODE=mock — boot guard ok`, all four crons start.
  - 19 curl smoke tests across `/api/stat-arb/demo/*`, `/api/stat-arb/exec/*`, `/api/stat-arb/research/*`, treasury, and the `/demo` HTML. Multi-venue split: parent 1M TWAP routed 570k/290k/140k across mock-a/b/c; risk-engine on children blocked 2 of mock-a's 4 children (cap = 300k = 30% of 1M; 285.5k * 4 children → 2 fit, 2 blocked). VWAP, POV, iceberg all dispatched. Decoupled scenario surfaced 75 P_VALUE_BLOCK gate events.

### Architectural notes (binding for future sessions)

1. **Multi-venue cost ranking is in floats.** `multi-venue-split.ts` deliberately bypasses `estimateSlippage`'s bigint cost path because rounding `impactBps` to integer basis points zeros the marginal-cost comparator for small chunks. Bigint stays for the final allocation; the float is local to the ranking decision. Don't "fix" this without re-checking the small-chunk regime.
2. **`MultiVenueOrderRouter` per-child risk check is the canonical extension point.** Future risk gates (correlation, exposure) bolt in next to `venueCapGate` in `MultiVenueRouterOpts`. The `live` Map is the canonical source of post-fill per-venue notional and survives across all gates on the same parent.
3. **`PaperVenue` is the seam between `EXECUTION_MODE=paper` and live market data.** When the live `market_bars` ingest cron lands, the `pricePoller` factory in `ExecutionModule` becomes `(symbol) => marketDataRepo.latestPrice(venue, symbol)`. No `PaperVenue` API change.
4. **`CanaryRouter implements ITradingVenue` so the strategy doesn't know about it.** Strategies see one venue and call `placeOrder`; the router multiplexes. `placeOrderSplit` is the audit-grade leg-tagged variant — use it when reconciliation needs per-leg attribution.
5. **`ExecutionModeBootGuard` is the only enforcement layer.** No downstream component (router, paper venue, canary) duplicates the check. If you add a 5th mode, the switch in `assert()` is the only place to widen.
6. **Lightweight Charts ResizeObserver pattern is the template** for any future chart in this dashboard. Hosts can be 0px-wide during persona switches; the observer corrects on the next layout pass. Don't open-code chart sizing.

### Open follow-ups

- **Real-bar ingest cron** (`docs/DESK_GAPS.md` §9 punch list item 1). The `pricePoller` wiring above is ready to consume it.
- **`/candles` returns synthetic feed bars today.** Once `market_bars` carries real history, swap `DemoService.bars()` to `marketDataRepository.barsBetween()`. Single-line change.
- **Remove Chart.js entirely.** Five small canvas sparklines remain; rewrite as inline SVG or migrate to Lightweight Charts. Removes a CDN dependency.
- **Strategy → CanaryRouter wiring.** Today's `TRADING_VENUE` factory picks `MockTradingVenue` vs `RealBinanceVenue`. A `canary`-mode factory branch needs to instantiate `new CanaryRouter(new PaperVenue(...), new RealBinanceVenue(), { paperPct: app.execution.canaryPaperPct })`. Mock-default safe until then.
- **Reconciliation drift events to an alert sink.** Currently only logged + queryable via in-memory ring buffer. Session 15 (ops / Slack / PagerDuty) wires the sink.
- **Treasury concurrent-deposits flake.** The single `treasury.service.int-spec.ts` failure is a SERIALIZABLE retry-once race — it would fix with a second retry or a backoff. Out of scope this session; same status as the hedge sequence-grant bug.
