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
4. **`courses/stat-arb/` is documentation, not code.** It lives under `courses/` (not `docs/`) to keep mkdocs-built sites separable from the repo's flat-file docs. The course's existence does not create a Phase 3 commitment — implementation is still gated behind Phase 2 legal formation per [PHASED_PLAN.md](archive/PHASED_PLAN.md) cross-phase dependency #1.

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

---

## 7. Session 16 — Universe expansion + pair discovery + regime detection (2026-05-28)

**Goal:** lift the desk from a single hardcoded BTC/ETH pair to a tradeable-universe discovery engine. New library searches an N-symbol universe, scores every pair on cointegration + OU half-life + ADV, clusters by correlation to deduplicate, classifies regime per pair, and surfaces the result on a new Research-desk Universe card with a KYB-gated "promote to live" intent log. 70 net-new specs (445 → 515 total). Synthetic-feed this session; real CCXT ingest is the queued follow-on.

Includes a small errors-prelude commit (3584961) that brought the int-spec suite to 445/445 by fixing two pre-existing bugs: missing GRANT USAGE on `hedge_movements_id_seq` (S4 migration miss) and a too-thin retry policy in `runInSerializableTransaction`.

### Shipped

- **`src/stat-arb/backtest/synthetic-universe.ts`** (10 specs) — `generateSyntheticUniverse({ clusterCount, symbolsPerCluster, noiseSymbols, ... })` produces N symbols organised into ground-truth cointegration clusters plus standalone noise symbols. Each cluster member is `driver(clusterId) + symLevel + idio` where `idio` is a **stationary AR(1)** process (ρ=0.72) driven by a small deterministic sine forcing. Earlier sine-wave residuals decorrelated cluster pairs and failed ADF tests; AR(1) gives textbook-stationary residuals that the cointegration test cleanly rejects the unit root for. Cluster drivers have linearly independent waveforms (different sine periods + cosine offsets) so distinct clusters don't cross-correlate.

- **`src/stat-arb/discovery/pair-discovery.ts`** (15 specs) — `discoverPairs(universe, cfg)` walks every (a, b) pair, runs the Session-5 `cointegrationTest`, applies a composite score `pValue + halfLifePenalty + advPenalty`, and returns a ranked list. Hard cutoffs filter by `pValueCutoff`, `[minHalfLifeBars, maxHalfLifeBars]`, and `minAdv` (drop illiquid pairs entirely rather than just ranking them low). Default sweet-spot is half-life ∈ [5, 30] bars.

- **`src/stat-arb/discovery/clustering.ts`** (13 specs) — `clusterSymbols(universe, { distanceThreshold })` builds an N×N Pearson-distance matrix (d = 1 − |ρ|), runs single-linkage agglomerative clustering with a flat cut, and nominates a representative per cluster (highest average pairwise |ρ| against cluster-mates). `pickRepresentativePairs(candidates, symbolToCluster)` filters the discovery output to one pair per (clusterA, clusterB) bucket — keeps the dashboard from showing ten copies of the same trade.

- **`src/stat-arb/regime/regime-detector.ts`** (15 specs) — `detectRegime(logPricesA, logPricesB?)` returns `{ vol: LOW|NORMAL|HIGH, trend: RANGE|TRENDING, decoupling: boolean, realisedVol, trendSlope, pValue }`. Vol is realised σ over a rolling lookback vs the historical median (configurable mults). Trend is the OLS slope × lookback compared against `trendSlopeThreshold` (default 0.05 = 5% log-return). Decoupling fires when the rolling Engle-Granger p-value exceeds `decouplingPValueAlarm` (default 0.10); null when no B series passed. Pure function; no state.

- **`src/stat-arb/discovery/signal-decay.ts`** (10 specs) — `detectSignalDecay(pnlPerTrade, { windowTrades, decayRatio, minBaselineSharpe? })`. Computes the trailing Sharpe over `windowTrades` and compares against the **median** of all earlier overlapping windows (the "historical baseline"). Flag fires when `recent / baseline < decayRatio`. Handles the negative-baseline edge case (decay = even more negative Sharpe) and the near-zero-baseline edge case (treats baseline as zero; flag cannot fire).

- **`src/stat-arb/discovery/universe.controller.ts`** (7 specs) — three endpoints on `/api/stat-arb/research/`:
  - `GET universe` — runs `runUniverse()` (composes synthetic-feed + discovery + clustering + regime per pair) and returns `{ symbols, groundTruthClusters, noiseSymbols, discoveredClusters, topPairs[20], representativePairs[10] }`. Each pair carries clusterA/clusterB + regime chip tags.
  - `POST universe/promote` — accepts `{ symbolA, symbolB, note? }`, appends to an in-memory 50-entry promotion log, returns `{ ok: true, loggedAt, intent, gate: 'KYB_REQUIRED_BEFORE_LIVE' }`. Does **not** flip anything live — the gate string is the audit trail for the human-approved Phase-4 step.
  - `GET universe/promotions` — returns the log newest-first.

- **Wiring:** `UniverseController` registered in `StatArbModule.controllers`. No new providers — discovery + clustering + regime are pure functions imported directly.

- **Dashboard:** new **Universe** card at the bottom of `/demo#research`. 11-column table (rank, pair, cluster, β, p-value, half-life, min ADV, vol chip, trend chip, score, promote button). Vol chip is OK/WARN/DANGER on LOW/NORMAL/HIGH; trend chip is OK/WARN on RANGE/TRENDING. "log intent" buttons POST to the promote endpoint and flip their own text to "logged". Loaded once-per-page-visit (same pattern as walk-forward / sweep / MC — research endpoints are expensive).

- **E2E smoke:** server boots clean (515/515 specs green, tsc clean). `GET /api/stat-arb/research/universe` returns 13 symbols (3 clusters × 3 + 4 noise), 20 top pairs, 10 representative pairs, each with vol+trend+decoupling chips. `POST .../promote` writes the entry; `GET .../promotions` reads it back. The dashboard's Universe card renders the table with cluster ids matching the ground-truth clusters.

### Architectural notes (binding for future sessions)

1. **The synthetic universe is the discovery-engine test fixture.** Real ingest will replace `runUniverse()`'s `generateSyntheticUniverse` call with a `marketDataRepository.universeBars(from, to)` lookup — no other code in the discovery library or the Universe card changes. The cluster-and-rank pipeline is data-source agnostic by design.

2. **Clustering distance metric is `1 − |ρ|`, not `1 − ρ`.** Anti-correlated symbols are tradeable as the same factor (you just flip the leg). Don't switch to signed correlation without thinking about the front-end implication (the same pair would suddenly appear in two clusters).

3. **Decay detection is Sharpe-based and Sharpe-blind to constant losses.** A pair that drifts from +profit to +flat with no variance has Sharpe → 0 and triggers decay; a pair that flips from -loss to MORE -loss with no variance does NOT trigger decay via Sharpe (variance is zero, mean is captured but Sharpe normalises it out). The position-sizing / drawdown gates are the right place to catch flat-loss patterns — `signal-decay.ts` is specifically for "this used to make money, now it doesn't."

4. **The promotion log is intentionally in-memory.** When the persistence layer for promotion-ladder events lands (Session 16 backlog item, called out in S16 closing notes), the log writes through to a `promotion_intents` table. Until then the in-memory ring is good enough for the dashboard's audit-trail demo.

5. **Universe-card-loaded-once-per-page-visit** matches walk-forward / sweep / MC. Research endpoints all run multiple backtests; reloading them on every poll would melt the CPU. The whole research desk follows the same lazy-once pattern.

### Open follow-ups

- **Real CCXT bar ingest cron.** The single biggest follow-on. Today the Universe card runs against a 13-symbol synthetic feed. A small ingest job pulling Binance public history into `market_bars` flips the engine onto real data without touching any of S16's code.
- **Promotion log → DB.** Append-only `promotion_intents` table with `(symbol_a, symbol_b, logged_by, logged_at, note)` and a unique index on `(symbol_a, symbol_b, day)` for idempotency. Same posture as `treasury_movements`.
- **Signal-decay wired into the Universe card.** Today decay tracking is a pure library function; the Universe card doesn't display recent vs baseline Sharpe per pair. One column + one fetch.
- **Session 10 (multi-strategy router + funding-carry + budget allocator).** Still deferred. With S16 done, the gap is starting to bind: the Trader-desk only shows pairs, but the engine could surface multiple strategies if the registry+allocator were in.

---

## 8. Session 17 — Real paper trading: live data spine + live loop (2026-05-29)

**Pivot.** This session changed direction on owner instruction: the repo is a *trading engine*, not a gated demo, and the "business gate" framing (KYB / Phase-2 / Phase-4 / mock-default-as-binding) was wrong for paper trading — public market data and a paper simulator need no business anything. We stripped that framing from the rails and made the engine actually paper-trade live data. (The originally-queued Sessions 17/18 — fund fees/LP/3(c)(7), and KYB-gated venue activation — are explicitly *not* this work; the fee/LP business layer was started and deleted as out of scope for the repo.)

### Shipped

- **Real market-data spine** — `src/stat-arb/feed/binance-public-client.ts` (klines + ticker over Binance **public** REST, injected `HttpGet` so tests run offline), `binance-public-bar-feed.ts` (real `IBarFeed` with a per-symbol closed-bar cursor; returns null until a new 1m bar closes), `binance-symbol.ts` (BTC→BTCUSDT mapping), `price-source.ts` (`IPriceSource`: `BinancePriceSource` + `StaticPriceSource`). Replaced the dormant `RealCcxtBarFeed` stub. No API key, no account, no KYB.
- **Live event loop** — `src/execution/live-paper-trader.ts`. Pulls aligned closed bars for both legs, runs `PairsStrategy`, routes to the injected venue (`PaperVenue` in paper mode), tracks open-position state, marks to market each bar, books realised PnL on close, persists closed round-trips to `stat_arb_trades`. Depends on a `LiveStrategy` interface, not the concrete class. `legPnlUnits` is a pure, tested per-leg PnL helper. Auto-starts on boot when `LIVE_AUTOSTART=true` + `FEED_SOURCE=binance`.
- **Control plane** — `src/execution/live.controller.ts`: `POST /api/stat-arb/live/{start,stop,tick}`, `GET /api/stat-arb/live/snapshot`. The dashboard is just one consumer of `/snapshot`; the engine is headless and terminal-drivable.
- **Rails reframed engineering, not business** — `kybConfirmed`→`liveTradingArmed` (`KYB_CONFIRMED`→`LIVE_TRADING_ARMED`) across config/factory/guard/specs; `ExecutionModeBootGuard` now reads "armed" (paper needs nothing; canary/live need armed). Error messages and interface comments in the feed/venue seams stripped of "business sign-off / KYB-gated" language. New config blocks `feed` + `live`; `.env.example` rewritten with a paper-trading recipe.
- **Dashboard** — fixed the infinite-scroll bug on the Trader/Risk tabs: `newOrReplace` (the shared Chart.js component) now wraps each sparkline/tape canvas once in a fixed-height `position:relative` box, so `responsive:true + maintainAspectRatio:false` sizes into a constrained container instead of feeding back into page height. Boot-guard panel text updated to the arm-switch framing.
- **Docs** — [PAPER_TRADING.md](PAPER_TRADING.md) (run guide); CLAUDE.md §1 + §7 reframed (engine-as-product, execution modes, swap seams).

### Verification

- `npx tsc --noEmit` clean; `npx jest` green (**530/530**, +15 net-new: feed client 5, bar feed 5, live trader 5 incl. `legPnlUnits`).
- Smoke against **real Binance**: `FEED_SOURCE=binance EXECUTION_MODE=paper LIVE_AUTOSTART=true` boots, the loop pulls real closed 1m bars (`feedId=binance.spot`, `venueId=paper`), and `/snapshot` reflects live state. BTC ticker confirmed (~$73.5k at run time).

### Architectural notes / open follow-ups

1. **Paper-vs-live gap to close next:** the slippage model + exec algos (TWAP/VWAP/POV/iceberg) exist but are **not yet in the live loop** — `PaperVenue` assumes a full fill at the ticker. Wiring the exec layer + a real venue adapter (signed REST, rate limits, key rotation via `ISecretProvider`) is the path to `canary`/`live`.
2. **REST poll, not websocket.** The feed polls klines on a timer. A websocket feed is the latency upgrade; the `IBarFeed` seam absorbs it without touching the loop.
3. **Single pair, no live MTM dashboard, no risk-engine in the hot path** yet — the risk gates (Session 8) are pure functions not yet consulted per-order in the live loop.
4. **Full roadmap/DESK_GAPS re-author still pending** — CLAUDE.md was reframed; the long roadmap doc still carries Phase/KYB framing and should be re-authored toward trading-infra.

---

## 9. Session 18 + 10 — Live multi-asset desk + multi-currency portfolio (2026-05-29)

**Owner-directed.** Turn the synthetic demo into a **live multi-asset trading console** on real Binance, then run **multiple currencies concurrently**. Three commits: `fe0a26f` (backend), `756ac02` (UI + de-gating + course), `1a7f85a` (multi-currency portfolio).

### Shipped

- **Multi asset-class presets** (`src/stat-arb/markets/market-presets.ts`, +spec): curated, asset-class-grouped sets of real Binance spot symbols (Large Cap, Layer-1, DeFi, ETH ecosystem, Payments/SoV incl. PAXG gold). Curated to assets >~$0.10 for the 6-decimal micros convention.
- **Multi-symbol data + real-data discovery**: `MarketDataRepository.{distinctSymbols,barsForSymbols}`; `runUniverseOnBars()` extracted so the synthetic and real-Binance paths share the discover→cluster→regime pipeline (`source: real-binance-history`). New `MarketDataController` routes: `GET /presets`, `POST /backfill-preset`, `GET /universe`, `GET /candles`.
- **Live pair/capital switching**: `LivePaperTrader.reconfigure()` (repoint on the same feed, fresh strategy w/ discovered β; defensive-copies cfg), `setStartingCapital()` + capital/equity in snapshot; `POST /api/stat-arb/live/configure`.
- **Multi-currency portfolio** (`src/execution/live-portfolio-trader.ts`, +6 specs): `LivePortfolioTrader` runs N pairs concurrently, each an **isolated** paper book (own feed cursor + venue + strategy via a `makeTrader` factory), capital split evenly, one timer, aggregate + per-pair snapshot. `POST /portfolio{,/start,/stop,/tick}`, `GET /portfolio`.
- **`/demo` rewritten** as a single live Trading Desk console (preset switcher, backfill, discovered-pairs table with trade/backtest, live snapshot panel, real candle chart, starting-capital input, "Trade top 3 multi-currency" + portfolio panel). The synthetic 5-persona dashboard and all KYB/Phase/investor-disclosure theater are gone.
- **De-gated the trading engine**: removed `KYB_REQUIRED_BEFORE_LIVE` + Phase-4/business-sign-off framing from `universe.controller` and seam comments (mock-trading-venue, paper-venue, app-config, bar-ingest, ccxt-bar-ingest, exec-demo). Kept the legitimate `LIVE_TRADING_ARMED` engineering arm switch; left genuine Ondo/Hyperliquid onboarding notes in the hedge/yield modules.
- **Course** (`courses/stat-arb`): ch 8 (baskets + funding carry, worked examples) + ch 9 (hands-on testing-in-Meridian lab); `mkdocs build --strict` passes (Netlify-safe).
- **`scripts/smoke-live-multi-asset.ts`**: in-process live smoke (boots the app context, no HTTP listen, so it runs where the watch server is killed by the sandbox).

### Verification

- `tsc --noEmit` clean; `jest` **560/560** (76 suites). No new DB migrations (reuses `market_bars` / `funding_rates`).
- **Live**: the smoke ran end-to-end against real Binance — backfilled `crypto-majors`, discovered LINK/SOL β=1.07 p=0.005, backtested 360 real bars, ran 3 pairs concurrently on a 300k split. Binance public REST reachable from the dev box; the `nest --watch` server cannot be launched from the tool sandbox (exit 144) — verify via tsc+jest+the smoke script instead.

### Open follow-ups

1. **Funding-carry / cross-sectional basket strategies** — course §8 skeletons; `funding_rates` table + repo exist, no `FundingCarryStrategy` / `CrossSectionalStrategy` wired.
2. **Budget allocator** — the portfolio splits capital evenly; mean-variance sizing is the next refinement (the deferred Session-10 allocator).
3. **Orphaned Track-B real-venue adapter** — set aside in git `stash@{0}` (2 known-bad specs: wrong signer vector; bucket refill anchor). Restart fresh.
4. **Exec algos + WebSocket feed in the live loop**; risk-engine per-order in the portfolio hot path.
5. **Course gaps**: Johansen, purged k-fold CV, deflated-Sharpe endpoint (course §9.9).

---

## 10. Session 19 — Automated market-making desk + fee discipline (2026-05-31)

**Goal:** add automated market-making (MM) strategies that run as books *next to* the stat-arb portfolio — backtestable, pluggable into any asset class (stablecoin-first), on the same real Binance feed. Then make fees real in the *entry decision* of every strategy, and tune for profit-with-certainty.

### Shipped — the MM desk (`src/market-making/`)

- **Quoters (`IQuoter`, the MM twin of `IStrategy`):** `SymmetricQuoter` (baseline), `AvellanedaStoikovQuoter` (AS08 reservation price `r=s−qγσ²(T−t)` + inventory skew + optimal half-spread), `GlftQuoter` (the §3.5 steady-state / infinite-horizon variant — invariant to the horizon countdown). Inventory is normalised to **lots** (inv ÷ quote size) so skew is size-agnostic; half-spread rails are **bps of mid** so the same quoter is sane from a $1 stablecoin to $60k BTC.
- **`InventoryBook`** — average-cost inventory + realised/unrealised/fees accounting, shared by backtest and live so P&L is computed identically.
- **Risk:** `VpinEstimator` (toxic-flow signal) + `CompositeRiskGate` with the MM-specific **Pause** verdict (stand still through a VPIN/adverse burst, don't panic-flatten).
- **Backtest:** `MmBacktestRunner` (bar-driven, runnable on today's OHLCV) + 4-component `PnlAttributor` (spread / adverse selection / inventory carry / fees) + `SimpleQueueModel` (the honest queue-aware scaffold; the full `LobReplayHarness` lands with L2 ingest). Fill model is fill-on-touch — documented as an upper bound on fills (course §6.8).
- **`MmStrategyRegistry`** (mirrors `StrategyRegistry`) + `mm-market-presets` (stablecoin-peg, fx-via-stables, crypto-majors). Added a `stablecoin-peg` preset to the stat-arb presets too.
- **Live:** `MmBook` (one instrument, real bars → quote → passive fills → mark) + `MmPortfolioTrader` (N books, one control plane) + `MmController` (`/api/market-making/*`). `MarketMakingModule` is self-contained (own Binance client + per-book feed) and imported once into `AppModule` — never touches `StatArbModule`.

### Shipped — fees in the entry decision (both engines)

- **Stat-arb:** confirmed `MockTradingVenue`/`PaperVenue` charge 5 bps taker and the backtest subtracts all 4 legs. Added `signal/fee-gate.ts`: the z-score pairs strategies (`PairsStrategy`, `BollingerPairsStrategy`) now **only open when the expected reversion `(|z|−exitZ)·σ_spread` clears `minEdgeMultiple ×` the 4-leg round-trip fee**. Registry turns it on by default (5 bps, 1.5×). Routes sub-fee spreads (a stablecoin peg) *away* from taker stat-arb and *toward* the maker MM books.
- **MM:** maker fee (signed; `-1` = rebate) on every fill, folded into net P&L; a fee-aware spread floor so the quoter never quotes below the maker round-trip break-even.

### Verification

- `tsc --noEmit` clean; `npm run build` clean; `jest` **673/673** (101 suites, +49 MM + 8 fee-gate). No DB migrations (MM is DB-free).
- **Live**: `scripts/smoke-mm-stablecoin.ts` (DB-free) backfilled real FDUSD/USDC/TUSD, backtested all three quoters (FDUSD AS: 156 fills, +13.67 spread, +15.59 rebate, −7.30 adverse → **+21.67 net** over ~6.6h), and drove one live `MmBook` tick (quoting bid 0.9993 / ask 0.9995, verdict Allow).

### Open follow-ups (S19)

1. **Cross-asset opportunity scanner** — the "scan far and wide, place few trades" engine. Sweep all presets + the TESSERA stablecoin/FX/ILS universe; rank each candidate by **net-edge-after-fees per unit time** (per-trade edge over the fee gate × expected trades/day from half-life × signal stability); surface only what clears. Reuses `discovery/pair-discovery`, `signal-decay`, `signal/fee-gate`. Add a deflated-Sharpe correction (we'll be multiple-testing hard).
2. **MM spread-capture screener** — rank instruments by `realised-spread − adverse(VPIN) − inventory-risk(vol) + rebate`, weighted by depth/fill-rate; a "where to quote" board.
3. **Reference-data adapters** (TESSERA): OANDA/Pyth FX (`EUR/USD`, `USD/ILS`), DefiLlama peg, Bit2C `USDC/NIS` — unlock the FX-via-stables and ILS basis trades.
4. **L2 ingest** → promote `SimpleQueueModel` to the honest `LobReplayHarness`.

---

## 11. Session 20 — Research realignment (scan→asset-classes→trade) + reference data sources (2026-05-31 → 2026-06-01)

**Owner-directed.** Rebuild the `/demo` **Research** tab into a single *scan → asset-classes → trade* flow, add a cross-asset opportunity scanner + a "where to quote" MM screener, then wire **TESSERA reference-data adapters** (true FX OHLC, peg, ILS) as a second data source — scannable, and tradeable on a per-source live feed. Commits `770480d` → `c2dd518`.

### Shipped

- **Cross-asset opportunity scanner + MM screener** (`770480d`): `src/stat-arb/discovery/opportunity-scanner.ts` + `net-edge-scorer.ts` sweep every preset and rank each candidate by **net-edge-after-fees per unit time** (per-trade edge over the fee gate × expected trades/day from half-life × signal stability). `GET /api/opportunities`; `POST /api/market-making/screen` ranks instruments by realised-spread − adverse(VPIN) − inventory-risk + rebate. Both surfaced on the UI.
- **P0 button consistency** (`84c2036`): wired the previously-dead **FLATTEN ALL**, added **per-station ✕ remove** on stat-arb cards, made **Trade-top-N append** (no silent portfolio wipe).
- **Research = scan→asset-classes→trade** (`c9f7bbd`, plan `b9924df`): **⊹ Scan all source data** sweeps every asset class at once (`/api/opportunities` + `/api/market-making/screen`), results **grouped by asset class** with a cross-class "fits the model" rollup; folded the standalone Scanner tab in; retired the legacy single-book path — every "trade" now launches a portfolio station. Surfaced the robustness tools (walk-forward/sweep/MC) with a synthetic-feed caveat.
- **FX (EUR stables) stat-arb preset** (`21091a2`).
- **TESSERA reference-data adapters** (`ab0f28e`, smoke `2d19397`): `src/market-data/reference/` — `PythBenchmarksClient` (true FX OHLC via the TradingView shim — scannable), `DefiLlamaPegClient`, `Bit2CClient`, all one `IReferenceBarSource`, injected HTTP, public/no-key; `ReferenceSourceRegistry` + `makeScannerLoader` route the scanner per source; new `fx-pyth` reference preset; `GET /api/market-data/reference[/sources]` + a UI "data sources wired" readout.
- **Reference pairs tradeable on the live loop** (`c2dd518`): per-source feed (`ReferenceBarFeed`/`ReferencePriceSource`/`warmupFromReference`, selected by `PortfolioPair.source`); each Live-books card shows its `feedId`.

### Verification
- `tsc --noEmit` clean; `jest` **714 tests / 111 suites**.
- Live (DB-free): `scripts/smoke-reference-sources.ts` exercises Pyth/DefiLlama/Bit2C; the scanner sweeps real presets end-to-end.

### Open follow-ups
1. **Cross-source pairing** (per-symbol source + timestamp resampling) for the USD/ILS (Pyth) × USDC/NIS (Bit2C) basis — the single-source per-source feed is done; cross-source resampling is not.
2. **Plumb `ReplayEngine` into `/api/stat-arb/research/*`** so walk-forward/sweep/MC run on real scanned history (drop the synthetic caveat).
3. **L2 ingest** → honest `LobReplayHarness`. Course gaps: Johansen, purged k-fold, deflated-Sharpe (doubly relevant given the scanner's multiple-testing risk).

See [docs/RESEARCH_TAB_REALIGNMENT_PLAN.md](RESEARCH_TAB_REALIGNMENT_PLAN.md).

---

## 12. Session 21 — Quant desk: research harness, sizing truth, sim-fidelity, single desk lot (2026-06-01)

**Owner-directed.** Turn the engine from "it can paper-trade" into "a quant can run the **find → prove → ship → watch** loop, *honestly*." Commits `35afd21`, `80bedbe`, `1c215e3`, `bc84903`, plus this session's desk-lot unification + history backfill.

### Shipped

- **Research harness + role docs** (`35afd21`): `scripts/quant-research.ts` — DB-free, sweeps **asset-class × strategy × entry-z × bar-interval** on live Binance, ranked net-of-fee, + a sizing study; writes `docs/research/*.json`. New `docs/QUANT_ROLE.md` (the operating manual: scan→hypothesize→backtest→validate→ship→monitor→journal, tech-stack map, "how to add a strategy") + `docs/QUANT_JOURNAL.md` (running research log, append-only — read the latest dated entry first).
- **Strategy catalogue grows** (`35afd21`): `pairs-zscore-selective`, `pairs-zscore-wide`, `pairs-ewma-conviction`, `ou-bertram-throttled` added to `strategy-registry.ts`; the registry spec is now **structural** (asserts clean growth, not a pinned list).
- **Sizing study in the UI** (`35afd21`): `POST /api/market-data/sizing-study` + a Research panel — 1×/10×/100× **size-invariance** (net edge in bps + Sharpe are size-invariant under flat fees), round-trip fee, and the **impact-optimal N\*** (impact ∝ N²).
- **Durable desk equity + connection health** (`35afd21`): session equity curve persisted to `localStorage` (survives refresh ~8h, with session age/peak); a heartbeat colours by data age and flips the live badge to "stale Ns" if the poll loop stalls — frozen numbers never read as live.
- **Production-readiness gate** (`80bedbe`): `docs/PRODUCTION_READINESS.md` — the tiered checklist. **P0** = sim fidelity (gate before trusting a backtest); **P1** = before real capital (canary); **P2** = polish.
- **P0.1 — sim fidelity in the replay venue** (`1c215e3`): `HistoricalReplayVenue` now worsens every fill by a **half-spread (bps of price) + linear market impact (λ·notional/ADV)**; BUY pays up, SELL receives less. Defaults off (back-compat); the harness board + `/api/market-data/backtest` turn it on (2 bps spread, 10 bps impact/participation). ADV = mean(volume×close) over loaded bars. +4 venue specs.
- **Lot size actually sizes trades** (`bc84903`): root-cause fix — the portfolio always built strategies with the fixed `app.live.notionalUnits`, so the capital input never changed trade size. `PortfolioPair.notionalUnits` now threads through the portfolio factory into the strategy (survives reconfigure); `/portfolio/launch` takes `notionalUsdc`. Research streamlined to **① Scan → ② ⚖ Size → ③ ▶ Trade**.
- **One desk lot across the WHOLE desk** (this session): the top-strip **Lots / leg (USDC)** is now the single sizing master for *every* trade button — scan ▶trade, Signal, ⚖ Size, Trade-top-N, **and the previously-independent Launch cockpit + MM book/preset launchers** all mirror it (`syncDeskLot()` on the `#capital` input → `#lx-capital` / `#mm-capital`, also synced once on load) and stay editable to **override a single launch**. UI notes added: top-strip "· sizes every trade", panels "· follows desk lot" + tooltips. This closes the `bc84903` holdouts (cockpit + MM had kept their own inputs).

### Findings (QUANT_JOURNAL)
- **Entry #1:** position size is a **risk** lever, not an alpha lever — net edge in bps and Sharpe are size-invariant under flat fees; **impact (∝ N²)** is what caps size. **Bar interval is the biggest free profitability lever** — the prior "fee drag dominates" diagnosis was a **1m artifact**; at 15m the board flips positive (edge/trade clears the ~20 bps fee floor). crypto-majors does **not** pair-trade profitably after fees at any interval tested.
- **Entry #2 (the honest reversal):** adding slippage **flips the ranking** — eth-ecosystem (the Entry-#1 Sharpe-3.16 "consistency winner") collapses to ≈ −$270 because its legs are thin (impact eats it at $25k/leg); **ai-data z-score @ eZ2–2.5 survives at +$4,460** (more liquid). **Liquidity, not just cointegration, decides what's tradeable at size.**

### Verification
- `tsc --noEmit` clean; `jest` **717 tests / 111 suites** (+3 over S20). HTML/UI is not unit-tested here, and the dev server can't launch in the tool sandbox (exit 144) — verify the single-desk-lot flow manually via `FEED_SOURCE=binance EXECUTION_MODE=paper npm run start:dev` + `/demo`.
- Live: `scripts/quant-research.ts` + `scripts/quant-session.ts` run end-to-end against real Binance public REST.

### Open follow-ups (the P0 frontier — gate before trusting any backtest)
1. **OOS / walk-forward on REAL history** — `/api/stat-arb/research/*` still runs on the synthetic feed; plumb `ReplayEngine` in + a train/test split. **No strategy ships on in-sample numbers** (the #1 backlog item; every current Journal candidate is blocked on it).
2. **Multiple-testing correction** — deflated Sharpe + purged k-fold (we scan ~80–90 pairs/class and report the top → selection bias).
3. **Borrow/funding cost on the short leg**; **more history + point-in-time universe** (10 days isn't "consistent over days"; presets are *today's* listed symbols → survivorship).
4. **P1 (real capital):** risk-parity allocator wired into the *live* path, maker/limit execution (reuse `src/market-making/`), real venue adapter + reconciliation, restart-safe live books.

See [docs/PRODUCTION_READINESS.md](PRODUCTION_READINESS.md), [docs/QUANT_ROLE.md](QUANT_ROLE.md), [docs/QUANT_JOURNAL.md](QUANT_JOURNAL.md).

## 13. Session 27 — Mission reframe to a paper-trading demo + the survivorship gate (2026-06-03)

> This file paused at Session 21; the detailed per-session log for **Sessions 22–26** lives in
> [CLAUDE.md](../CLAUDE.md) §8 (the maintained running log) and [QUANT_JOURNAL.md](QUANT_JOURNAL.md)
> Entries #6–#13 (MM-as-earner pivot, the strategy-library rewrites, the equities Alpaca/Yahoo arc).
> This entry resumes the high-level history.

### What changed
- **Mission reframe (binding — CLAUDE.md §1):** the deliverable is a **paper-trading demonstration of
  an AI-agent-run quant desk** — several strategies, each manned by a quant agent, that **minimize
  drawdown and show steady, conserved returns over hours and days** of live paper trading on real data.
  **Paper-only for the foreseeable future; no real-capital/production deploy on the roadmap.** Crypto
  MM is the steady earner; equities stat-arb is a thin uncorrelated diversifier; **the growth frontier
  is market *discovery* — DEX / decentralized / anonymous markets on the MM side.** Honest numbers are
  the whole point. Reframed across CLAUDE.md §1, README, PRODUCTION_READINESS (P1 "real capital" → ⏸
  PARKED), EQUITIES_STATARB_PLAN, MARKET_MAKING (new **Frontier — DEX/decentralized** section),
  SURVIVORSHIP_DATA_OPTIONS, AGENTIC_HEDGE_FUND_DESIGN, QUANT_ROLE.
- **Survivorship gate (P0.5, the free no-data path — Journal #14):** `src/stat-arb/research/survivorship-gate.ts`
  (`assessSurvivorship` + `applySurvivorshipGate`, 11 unit tests) encodes the Journal #13 lesson —
  a window on TODAY's survivor-only `EQUITY_PRESETS` is survivorship-inflated (Sharpe rises with
  window length). It judges survivor ≈ live (~5yr default) and **downgrades a strong read on a
  survivor-unsafe equity window to `UPPER-BOUND`**. Wired into `scripts/oos-candidates.ts` (banner +
  verdict cap via `OOS_SURVIVOR_SAFE_DAYS` + `survivorship` artifact block; crypto exempt). The real
  equities verdict is now **forward paper-trading**, not the long-window backtest. Chose the free path
  over paid Sharadar/CRSP precisely because the mission is a paper demo, not a real-capital deploy.

### Verification
- `tsc --noEmit` clean; `jest` **125 suites / 841 tests** (+1 suite / +11 = the survivorship-gate spec).
- The survivor-safe vs. capped OOS runs are hand-off (need network/Alpaca key); reproduce commands in
  [QUANT_JOURNAL.md](QUANT_JOURNAL.md) Entry #14.

## 14. Session 28 — Discovery frontier, step 1: a GeckoTerminal DEX source (2026-06-03)

### Shipped
- **`GeckoTerminalClient` behind `IReferenceBarSource`** (`src/market-data/reference/geckoterminal-client.ts`,
  8 unit tests) — free, no-key DEX OHLCV across 100+ chains. Maps a kline interval to GeckoTerminal's
  `{minute|hour|day, aggregate}`, fetches `/networks/{net}/pools/{pool}/ohlcv/…?currency=usd`, and parses
  the newest-first `ohlcv_list` into ascending `Bar[]`. Injected `httpGet` (offline tests) + a `poolMap`
  of live-verified Uniswap-v3 addresses (raw `'net/0x…'` passthrough).
- **Registered** in `buildReferenceSources` (→ `ReferenceSourceRegistry`, the `/api/market-data/reference`
  readout, `makeScannerLoader` routing) + config (`GECKOTERMINAL_BASE_URL`, `app.feed.geckoTerminalBaseUrl`).
  New scanner preset **`dex-eth-bluechip`** (WETH/USDC, WETH/USDT, WBTC/WETH, USDC/USDT — eth + base chains).
- **Scope (honest):** data adapter + scan-universe only — the growth-lever *half* of the S27 frontier. NOT
  yet a live MM book on a DEX feed (needs the S20 `ReferenceBarFeed` analogue for the MM side — the next
  step). DEX prints are noisier (MEV/thin pools) → the wider spread is hazard-compensation, not free money.

### Verification
- `tsc --noEmit` clean; `jest` **126 suites / 849 tests** (+1 suite / +8 = the GeckoTerminal spec).
- Live-verified end-to-end against the real API (24 ascending hourly bars/pool: ETH/USD ≈ $1855, BTC/USD
  ≈ $66.5k). Details + reproduce in [QUANT_JOURNAL.md](QUANT_JOURNAL.md) Entry #15.

## 15. Session 29 — Discovery frontier, step 2: MM books quote DEX pools live (2026-06-03)

### Shipped
- **DEX pool → first-class live paper MM book.** `MmBook` was already feed-agnostic (injected
  `nextBar`/`warmupCloses`), so the change is the book factory: **`MmBookSpec.source` +
  `MmMarketPreset.source`** (the MM twin of `PortfolioPair.source`, S20); `market-making.module.ts`
  builds a `ReferenceSourceRegistry` and routes a `source` book through a **`ReferenceBarFeed`** (+
  source-backed warmup) instead of the Binance feed. **`MmScreener` is now source-aware**
  (`MmBarLoader(symbol, source?)`, preset carries `source`) so DEX pools rank without 404-ing Binance;
  `MmController` threads `source` through `launch`/`launch-preset`. New MM preset **`dex-eth-bluechip`**
  (`source:'geckoterminal'`).
- **Honest scope:** the path works + P&L is honestly attributed; the first live reads are net-negative —
  that's the lesson, not a wiring failure (needs a ≤0bps maker venue + per-pool tuning + queue-aware fills,
  Journal #23). Fill-on-touch is an upper bound.

### Verification
- `tsc --noEmit` clean; `jest` **126 suites / 853 tests** (+4 = preset/screener/controller routing).
- Live-verified end-to-end (real GeckoTerminal → `ReferenceBarFeed` → `MmBook` → fills → 4-component P&L,
  ~200 hourly bars): WETH/USDC symmetric-8bps 129 fills, +$20.6k spread − $24.2k adverse → net −$45k;
  USDC/USDT GLFT peg near-flat, maxDD 0.01% at $1M. Details in [QUANT_JOURNAL.md](QUANT_JOURNAL.md) Entry #16.

### Next (the paper-demo frontier)
- **Market discovery** — DEX **data + live MM books are wired (S28/S29)**; remaining: **per-pool tuning +
  the maker-rebate fee model** on the low-vol DEX **stable** pools (the only regime with a structural shot
  at positive), a `source` knob on `scripts/mm-paper-session.ts`, then wider long-tail pools/chains.
- **Forward paper track records** — run the MM book + the survivor-safe equities basket live for
  hours/days; show steady, low-drawdown equity curves (the demo itself).
- **P1 (real capital) is parked** (allocator-on-live, maker/limit exec, real-venue adapter — out of scope).

---

## 16. Backend telemetry P1 — metrics + health endpoints (2026-06-04)

**Goal:** [docs/NEXT_SESSION.md](NEXT_SESSION.md) — make the persistent paper-trading research system observable for unattended multi-hour runs, built exactly to [TELEMETRY_REQUIREMENTS.md](TELEMETRY_REQUIREMENTS.md) P1, behind a config-gated swap seam with a no-op default.

### Shipped (`src/telemetry/`)
- **The seam (DC-1).** `ITelemetry` (counter / gauge / histogram + a uniform `alert()` hook) + a `TELEMETRY` token. `NullTelemetry` (no-op, default) ⇒ `TELEMETRY_ENABLED=false` runs + every existing test behave exactly as before, near-zero overhead. `PrometheusTelemetry` writes the §4 catalog into a **hand-rolled, dependency-free** `PrometheusRegistry` (Counter/Gauge/Histogram + standard v0.0.4 text exposition — chosen over adding `prom-client` to keep the modular monolith dep-light + the whole layer offline-unit-testable). Every emit is best-effort: an error is swallowed + counted (`meridian_telemetry_errors_total`), never thrown into a tick (DC-5).
- **Endpoints.** `GET /metrics` (on scrape the collector reads the live desk `snapshot()` → gauges, the **pull model** DC-3 — no parallel accounting path), `GET /health` (liveness), `GET /health/ready` (DB under `MM_PERSIST` + tick fresh within N×poll + ≥1 feed fresh ⇒ 200 / else 503). Readiness is a **pure** `assessReadiness()` (a warming book with no bar yet is *not* a failure) — exhaustively unit-tested.
- **The §4 catalog.** Operational (uptime, event-loop lag via a self-managed unref'd sampler, rss/heap, http via a global interceptor, db via `DbService`, tick count/duration/**overrun**), feed (poll count/duration by source, **last-bar-age staleness**), desk/financial mapped from `snapshot()` (per-book + desk equity/net/realised/unrealised/fees/**funding**/inventory/**maxDD**/fills/blocked/**risk-verdict state**/NAV; bounded labels book/source/strategy/verdict DC-4), persistence (checkpoint ok/error + duration + rehydrated-books). Alerts (FR-10) → `meridian_alerts_total{kind,severity}` + a structured log on tick-overrun / persist-failure.
- **Instrumentation (all no-op when off).** `MmPortfolioTrader` (tick metrics + overrun alert, `lastTickAt()`/`getPollIntervalMs()`, persist ok/error + critical alert + duration, rehydrated-books gauge on boot); the MM module wraps `nextBar` for feed-poll metrics + `MmBook` now carries `source`; `DbService` gains `ping()` (readiness) + optional tx duration/error metrics.
- **Wiring.** `AppConfig.telemetry { enabled, readyTickMultiplier, feedStalenessMs }` read once in `app-config.factory.ts` (DC-2). `@Global TelemetryModule` (config-selected) imports `MarketMakingModule` (now exports `MmPortfolioTrader`); the global `TELEMETRY` token flows back in (optional) so the graph stays acyclic. An **offline DI-compile spec** (disabled + enabled) catches wiring breaks without booting the app (`start:dev` exits 144 here).

### Verification
- `npx tsc --noEmit` clean; **143 suites / 942 tests** (+6 suites / +31 tests, all telemetry). Default-off ⇒ no behaviour change.

### Not in P1 (honest)
- `ws_connected` + `feed_gaps` (the HL trades/WS path, not the bar loop), a dedicated stale-feed / risk-`Pause` *alert event* (the verdict is computed inside `MmBook`), a starter Grafana dashboard, and **P3 durable NAV history** (the multi-day track-record table) — all tracked in TELEMETRY_REQUIREMENTS §7/§8. The live `meridian_desk_nav_units` gauge already equals desk equity to the unit on scrape.

---

## 17. Backend telemetry P3 — durable MM NAV / equity-curve history (2026-06-04)

**Goal:** close the one remaining ⏳ in [TELEMETRY_REQUIREMENTS.md](TELEMETRY_REQUIREMENTS.md) §8 — make the desk NAV **queryable over a multi-day run and matching the ledger/gauge to the unit**, surviving restart. Built behind `MM_PERSIST` (the restart-safe-books flag) with a Postgres/no-op swap seam, mirroring the stat-arb per-day NAV cron but generalised to a **per-interval MM time series**.

### Shipped (`src/market-making/persistence/mm-nav.*` + migration)
- **`mm_nav` (migration `1721000000000`).** An **append-only** per-interval series — one table, `book_key=''` = the **desk aggregate** row, `book_key='<SYMBOL>'` = a per-book equity row. Columns: `equity/net/realised/unrealised/fees/funding/inventory_units` (BIGINT) + `max_drawdown_pct`. Indexes `(as_of DESC)` + `(book_key, as_of DESC)`; **no per-day unique** — every interval is a row. `meridian_markets_app` gets **SELECT,INSERT only** (same append-only oracle as `stat_arb_nav`, asserted in `append-only.int-spec.ts`).
- **`MmNavRepository`** (mirrors `StatArbRepository`): `insertNavSnapshot(rows[])` batches the desk + per-book rows in **one SERIALIZABLE txn** (a reader never sees a desk row without its books); `navHistory(fromAsOf, bookKey?)` returns the curve oldest-first; bigint↔decimal-string coercion.
- **`MmNavCron`** (mirrors `StatArbNavCron`): each `MM_NAV_INTERVAL_MS` (default 60s) reads `MmPortfolioTrader.snapshot()` and appends a desk row + one per book. **Derived from `snapshot()` (DC-3)** — the cron owns no accounting state, so the desk row's `equity_units` **equals the live `meridian_desk_nav_units` gauge to the unit** (both read the same snapshot). No-op unless `MM_PERSIST` **and** a `DbService` are present; skips the timer under `nodeEnv=test`; explicit `tick(now?)`.
- **Endpoint.** `GET /api/market-making/nav?hours=24[&book=SYMBOL]` → `{ points }` (bigints → decimal strings, like every MM read). Returns `{ enabled:false, points:[] }` with a note when `MM_PERSIST` is off.
- **Wiring.** `MmNavRepository` (optional `DbService`) + `MmNavCron` registered in `market-making.module.ts` — Postgres when `MM_PERSIST` and a DB are present, else `null` ⇒ cron + endpoint no-op. `MM_NAV_INTERVAL_MS` added to `AppConfig.marketMaking` (interface + factory + `.env.example`).

### Verification
- `npx tsc --noEmit` clean; **146 suites / 962 tests** (+3 suites / +20 tests: cron mapping incl. the §8 desk-equity identity `desk.equity == BigInt(snapshot.equityUnits)`, repository unit + DB-gated round-trip, append-only grants, endpoint shape). Migration applied to local Postgres; the DB-gated round-trip + grant specs pass against it.
- **Default off ⇒ full suite unchanged**: `MM_PERSIST=false` makes the repo provider `null`, so the cron + endpoint are inert and no live-loop behaviour changes.

### Not in P3 / next
- Stat-arb live books are still in-memory (the next restart-safety target). A **multi-hour forward paper run** writing a real multi-day `mm_nav` curve is the live deliverable (hand to the operator — `start:dev` exits 144 in this sandbox). P2 (structured logs) + P4 (traces + Grafana dashboard reading these curves) remain.

---

## 18. Operator enablement + HL market discovery + the first broad L2 capture (2026-06-04)

Same day as §17 (Telemetry P3). With durable NAV shipped and the desk paper-trading, the session pivoted to making the system **operable by a human**, the mission's growth frontier (**HL market discovery**), and kicking off the first **broad high-fidelity L2 capture** to move the n=1 BTC MM read (Journal #23) toward a cross-coin distribution.

### Shipped
- **Durable NAV on the UI** — a "Desk NAV — durable" curve on the `/demo` Market-Making panel (6h/24h/72h/7d) reading `GET /api/market-making/nav`. The P3 track record is now visible at a glance, not just via curl.
- **HL universe MM discovery** (Journal #24) — `scripts/hl-universe-discovery.ts` + the unit-tested pure `src/market-making/screen/hl-universe-discovery.ts`. One `metaAndAssetCtxs` call → rank all ~230 HL perps by inventory risk → surface the calm liquid non-majors (XRP/DOGE/ASTER/BNB → the `hl-discovery` preset). Honest finding: a fixed-spread OHLCV scan nets negative on *every* perp — the deliverable is the σ-ranked liquid shortlist to point the L2 capture at.
- **The Operator's Manual** (`docs/OPERATIONS_MANUAL.md`) — the three systems (live desk / research pipeline / observability), the storage map (Postgres vs files vs memory), and every recurring job end-to-end; written because the operator was (reasonably) drowning in ad-hoc commands. Plus `docs/research/TUNED_PARAMS.md` (the winners' book) + a cheatsheet pointer.
- **One-command capture/tune tooling** — `scripts/capture-hl-l2.sh` + `scripts/tune-hl-l2.sh` bake the coin list + settings into the file (no terminal line-wrap footguns), default to the top-20 liquid perps / 6h / 10s, wide tune grid, tee'd analysis.
- **Tape checkpointing** (operator's idea) — `mm-l2-session.ts` now flushes every coin's tape to disk every `MM_L2_CHECKPOINT_MIN` (default 10min), so a crash/kill mid-run never loses the whole capture.

### In flight → next session's first action
A **20-perp, 6h, 10s-poll, real-WS-flow** L2 capture is running (checkpointed). **Verdict pending** — harvest it with `tune-hl-l2.sh` → record winners in `TUNED_PARAMS.md` → relaunch books tuned. See [NEXT_SESSION.md](NEXT_SESSION.md) (Priority 0).

### Verification
- `npx tsc --noEmit` clean; **147 suites / 976 tests** (+ the discovery pure module/spec); demo + preset + script changes covered by tsc + the demo/preset specs.

---

## 19. Gap-closing run — stat-arb event tape + restart-safe stat-arb books + funding-carry discovery (2026-06-04 evening)

Same day, evening. With the 20-perp L2 capture running all session (harvest is next-session work), the session closed the **real remaining asymmetries** between the MM and stat-arb desks, one item at a time, each committed so a credit-out is always safe. (The doc reorg — archiving finished plan/spec docs under `docs/archive/` — was done manually by the operator and committed as-is.)

### Shipped (each its own commit on master)
1. **Stat-arb business-event tape (Telemetry P2 remainder)** — the operator-flagged gap: the MM desk logged every fill, stat-arb logged only lifecycle. Now the shared `IDeskEventSink`/`DeskEventLog` is wired into the stat-arb `LivePaperTrader`/`LivePortfolioTrader`: every enter/exit (with realised round-trip P&L), risk-block and book/desk lifecycle emits a `DeskEvent` (`src/execution/live-desk-events.ts`), rendered as a server **log line** + `GET /api/stat-arb/live/events` (seq-cursor long-poll) + a `/demo` **Desk-tab "Activity"** feed. Each desk owns its own `DeskEventLog` instance. `DeskEvent.desk` generalised to `'mm' | 'stat-arb'`.
2. **Restart-safe stat-arb books** — mirrors the MM persistence arc end-to-end: `StatArbBookState` + `serializeState/restoreState` on `LivePaperTrader` (realised P&L, open position, drawdown peak; the **stateful** pairs strategy resumes its held regime via a new `LiveStrategy.restorePosition(side)`, so a rehydrated trade is worked off, not re-opened); `stat_arb_book_state` checkpoint table (migration 1722…) behind `IStatArbStateStore` (Null/Postgres); `LivePortfolioTrader` rehydrate-on-boot + checkpoint-per-tick + soft-close-on-remove + shutdown flatten/checkpoint. Gated by `STAT_ARB_PERSIST` (default off ⇒ no DB dependency on the live path). Scope: the **portfolio** desk (the legacy single-pair console is not persisted).
3. **HL funding-carry universe discovery** — `src/market-data/funding/funding-carry-discovery.ts` + `scripts/hl-funding-discovery.ts` rank the whole HL universe by *persistent, harvestable* funding net of the one-time round-trip fee (sign-stability + breakeven + liquidity gates). Real 14d/top-50 read: 23 harvestable perps, XMR +36%/yr, majors ~8% ([Journal #26](QUANT_JOURNAL.md), [doc](FUNDING_CARRY_DISCOVERY.md)).

### Deferred to next session
- **Priority 0 (perishable):** harvest the 20-perp/6h L2 capture (`DATE=20260604 bash scripts/tune-hl-l2.sh`) → record per-coin (γ,κ,floor) winners in `TUNED_PARAMS.md` + **Journal #27**. The capture finishes ~00:14; the harvest is pure offline analysis.
- Funding-carry **cross-venue live book** (short HL perp / long Binance spot) + a multi-regime re-run; the γ/κ-distribution harness; the capital allocator; the agentic layer.

### Verification
- `npx tsc --noEmit` clean; **153 suites / 1019 tests** (was 149/993 at session start — +4 suites/+26 tests across the event tape, persistence, and funding-carry discovery). Each item committed on master with a `Co-Authored-By` trailer.

---

## 20. Role-scoped UI redesign — design doc + six role pages (2026-06-06…07)

Executed [docs/UI_REDESIGN_PROMPT.md](UI_REDESIGN_PROMPT.md): replace the 100KB `/demo` `index.html` with **role-scoped, server-rendered pages** served by the same Nest app — **no React, no build step, no new npm deps**, terminal aesthetic, thin read-only-over-the-engine doctrine (CLAUDE.md §1). New code lives in `src/ui/`; views are **pure functions → unit-tested** (render → assert HTML), so the UI rejoined the test discipline.

### Stack decided (recorded in [docs/UI_ARCHITECTURE.md](UI_ARCHITECTURE.md))
Server-rendered partials via a hand-rolled auto-escaping `html\`\`` tagged template (no template engine) + native **SSE** (`@Sse`) for live regions + vanilla **Web Components** for the shared client primitives + one terminal CSS. **htmx/Alpine were evaluated and not adopted** — the control plane returns JSON not HTML fragments, so htmx's swap model doesn't fit; a ~40-line `<desk-action>`/`<desk-form>` does the write path dependency-free. SPA rejected on doctrine.

### Shipped — six role pages (each its own commit on master)
1. **`/exec`** — read-only executive overview (desk NAV, net P&L, worst-book drawdown vs the 2% budget, per-book table) + the SSE spine + the `<desk-feed>` shared component + the offline DI-compile test (since `start:dev` exits 144 here).
2. **`/ops`** — first action page: process/feed/DB health (reusing `assessReadiness`), MM desk status, persistence; **action palette** (Start/Stop/Flatten) via the new `<desk-action>`.
3. **`/desk/mm`** — MM console: per-book quotes + 4-component PnL attribution + Activity tape (from the MM `DeskEventLog`, exported for this) + launch/preset/remove via `<desk-form>`/`<desk-action>` (re-launch = reconfigure).
4. **`/desk/statarb`** — stat-arb console: per-pair z/β/regime/position + the persisted blotter (DB-guarded) + tape + launch/remove. **Controller declared in `StatArbModule`** (not UiModule) because that graph won't boot under the light DI test — recorded as the wiring rule (§7).
5. **`/risk`** — drawdown vs budget, net/gross exposure, **adverse selection as the live toxicity signal (no fabricated VPIN — the gate passes vpin=0)**, verdict-transition feed, de-risk levers + the **cross-desk kill switch**.
6. **`/research`** — static findings KEEP/CUT/RESERVE board (tracks `RESEARCH_FINDINGS.md`) + the **copy-the-runbook-command** helper (`<copy-cmd>`, no execution, §5). No live funding board — there is no funding endpoint, so it is shown as a verdict with that caveat, not invented rates.

Shared widgets in `src/ui/render/components.ts` + `src/ui/public/*.js`: `topBar`/`pageShell`, `<desk-feed>` (SSE read), `<desk-action>` + `<desk-form>` (writes → existing control plane), `<copy-cmd>`, `activityTape`/`deskControls`/`statArbControls`. The top-bar nav marks unbuilt pages as disabled "soon" (no dead links). `/demo` is untouched and runs side-by-side until parity.

### Deferred to next session
- **`/pm`** (Thesis Register) — its engine endpoints don't exist yet (CLAUDE.md §8 "coming"); needs the engine surface first or an honest stub. The **`/` launcher** (role index) — trivial.
- Deferred panels: a `<nav-spark>` equity sparkline (`/exec`,`/desk`), an `/ops` Prometheus-metrics panel, an append-mode cursor-based `<activity-tape>`, a **live funding board** + MM screener panel (need serving endpoints — funding has none), a mode-aware/live stat-arb blotter, and a real **per-book pause/deny + limit-lowering** risk endpoint (engine work).
- Then: retire `/demo` on parity (keep the JSON `DemoController` endpoints).

### Verification
- `npx tsc -p tsconfig.build.json --noEmit` clean; **168 suites / 1116 tests** (was 149/993 at the start of the redesign — +19 suites / +123 tests, all in `src/ui/`). Zero regressions; each page committed on master with a `Co-Authored-By` trailer. `start:dev` exits 144 in the sandbox ⇒ all live runs handed to the operator (steps in [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) §10).

---

## 21. UI rebuild — the deferred-panel pass (2026-06-07)

Continued the role-scoped UI rebuild (§20) by working the **buildable** deferred
panels from [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) §9 — the ones with an existing
serving endpoint, so nothing is faked. Four commits on master, each tsc-clean +
spec'd (render → assert HTML, plus the offline DI-compile test):

### Shipped (each its own commit on master)
1. **`/` role launcher** — the missing entry point. A static role-card index
   (`LandingController` in `UiModule` + `renderLandingPage`/`LAUNCHER_ENTRIES`)
   replaces the old `AppController` root→`/demo` redirect (deleted). Live cards link;
   the unbuilt `/pm` renders as a disabled "soon" card (honest nav). The top-bar brand
   now links back to `/`.
2. **`<nav-spark>` equity sparkline** — a shared Web Component that self-fetches
   `GET /api/market-making/nav` (durable NAV, Telemetry P3) and draws the equity curve
   as an inline SVG. On `/exec` + `/desk/mm` (desk-aggregate), placed **outside** the
   SSE region so a tick can't recreate it. **Honest:** when `MM_PERSIST` is off the
   endpoint says `enabled:false` and the component shows that, not a fake flat line.
3. **`/ops` telemetry/runtime panel** — process memory (RSS, heap) + the live loop
   counters (mm ticks + mean tick duration, overruns, event-loop lag, persist ok/err)
   read straight from the `PrometheusRegistry` (the metrics ledger). Injected
   `@Optional` (TelemetryModule is `@Global`) so the offline DI test still resolves.
   **Honest:** telemetry OFF ⇒ the panel shows OFF + the enable hint and still shows
   memory (a process stat), but does **not** print 0-counters as if measured.
4. **Append-mode `<activity-tape>`** — a cursor-based Web Component that polls
   `…/events?since=<cursor>` and **prepends only new events**, preserving the
   operator's scroll into history (the old full-replace tape reset scroll every 2s).
   On `/desk/mm` + `/desk/statarb`: the tape moved **out** of the SSE live region onto
   the static page; the streams now carry only summary + cards; controllers supply
   `cursor = DeskEventLog.lastSeq()`. `/risk`'s short verdict feed kept the in-stream
   full-replace `activityTape()`.

### Deferred (endpoint-blocked, not page-blocked) — the only thing between here and `/demo` retirement
- **`/pm`** Thesis Register (no thesis endpoints), a **live funding board / MM screener**
  (no serving endpoint — funding has none), a real **per-book pause/deny + limit** risk
  lever (engine work), a **mode-aware/live blotter**, and **per-book-in-card sparklines**
  (the cards live in the SSE region — needs the persistent/append placement pattern).
- **`/demo` is ready to retire pending a deliberate call** — it's a large, working,
  pre-existing console, so it was left in place (both run side by side, no behaviour
  change). Not deleted unilaterally.

### Verification
- `npx tsc --noEmit -p tsconfig.json` clean (full project, incl. specs); **169 suites /
  1128 tests** (was 168/1116 at §20 — +1 suite / +12 tests, all in `src/ui/`). Zero
  regressions. `start:dev` exits 144 in the sandbox ⇒ live runs handed to the operator
  (same steps, [UI_ARCHITECTURE.md](UI_ARCHITECTURE.md) §10; now also `/` for the launcher).

## 2026-06-10 — Trader-UI extension: /desk/markout + /desk/toxicity (TRADER_UI_SPEC §2/§3)

The two BUILD pages from the spec, in the established controller/view/SSE pattern,
plus the engine fields the toxicity page needed (the spec's "~5-line add").

1. **Engine surface (3 new snapshot fields)** — `vpinWindowBuckets` (the estimator's
   EMA window, via a new `VpinEstimator.windowBuckets()`), and fast-path-only
   `bookImbalance` / `tradeFlowImbalance` (last quoting-step reads, kept on
   `L2LiveFillEngine` metrics; the trade-flow read holds its last *traded* tick —
   a quiet tick is "no new information", not "balanced"). Bar-path books surface
   `undefined` ⇒ the UI says "n/a (bar path)" instead of faking a 0.
2. **`/desk/markout`** (`markout-desk.controller.ts` + `render/markout-desk-view.ts`) —
   desk strip (total fills + fill-count-weighted avg markout per horizon) and per-book
   cards with three curve rows (all/buy/sell), one cell per horizon (signed bps +
   sample count + |bps|-width bar), the F3 reaction line on the same card, and the
   amber `ONE-SIDED` flag when |buy−sell| > 2bps at the longest horizon with ≥30
   fills/side. Honesty rules: cells dim under 30 samples, "—" while a horizon is
   unresolved (`bps: null`), every number carries its count.
3. **`/desk/toxicity`** (`toxicity-desk.controller.ts` + `render/toxicity-desk-view.ts`) —
   per-book VPIN gauge **greyed with "warming m/n buckets" until `vpinBuckets` clears
   the EMA window**, F3 scale row (widen/tighten counts), signed −1→+1 imbalance bars
   (neutral colour — direction is not good/bad), verdict chip, and the **"monitoring,
   not yet validated as predictive"** footnote (roadmap 1c). 15-min history strips are
   the new `<tox-strips>` Web Component (`public/tox-strips.js`): self-polls the
   snapshot, client-side ring buffer, VPIN solid vs F3-scale dashed per book — placed
   OUTSIDE the SSE region so a tick can't wipe the buffer (nav-spark discipline).
4. **Wiring** — UiModule controllers, ROLE_LINKS + launcher cards, asset allow-list +
   pageShell script. **Next-run wiring:** `scripts/start-desk.sh` now defaults
   `MM_MARKOUT_HORIZONS_MS=1000,5000,30000,60000,300000` (Journal #49: the loss lives
   outside the 1–30s windows; study §2.1 says read the curve where it saturates).
   Verified both `makeBook` AND `rebuildBook` share `buildFastEngine` (#47 discipline)
   so a rehydrated desk keeps the horizons + new fields.

### Verification
- tsc clean; **191 suites / 1287 tests, 190/1285 green** — the 1 failing suite is the
  known flaky `telemetry.module.spec` (standing rule: not re-investigated).
- **Live QA on the running desk** (restarted via start-desk.sh, 8 books): snapshot
  carries the new fields (`bookImbalance` 0.91, `tradeFlowImbalance` 1.0, vpin warming
  0/50); `/desk/markout` renders 8×3×5 horizon cells incl. 1m/5m; `/desk/toxicity`
  renders 8 gauge cards (warming state, F3 ×0.50–×3.00, verdict chips); landing/nav
  carry both pages; `/ui/tox-strips.js` serves. QA side-effect cleaned up: the BTC
  book was relaunched at the standard $1M/$100k config.

### Deferred (spec §4, next session)
`/desk/mm` upgrades (per-side 60s markout cells, bucketMs label, card-header deep links),
`/risk` exposure block ($ notional vs cap, hedge legs, factor-vs-basis σ), Grafana/
Prometheus is operator-run (spec §5 — hand the commands to Ronnie, don't run them).

## 2026-06-12 — F0: persistence & attribution instrumentation (MASTER PLAN II opener)

Shipped the F-chain's hard prerequisite (QUANT_JOURNAL #59): migration
`1723000000000-AddMmResearchTables` (4 append-only research tables), `MmResearchRepository`
+ `BufferedSink`/`MmResearchSinks` (bounded, interval-flushed, shutdown-drained), per-fill
markout persistence with fill context (MarkoutTracker sink → L2LiveFillEngine →
mm_fill_markout), per-leg hedge P&L each NAV interval + hedge quality hourly/shutdown
(DR-2 closed), durable DeskEvent tape (mm_desk_event, PART V req #8), HIP-3 per-dex
funding (xyz:* measured, was 0 by construction), NAV corrupt-mark interval guard, and the
leak-table upgrade: worst5m corrupt-mark/reset bug fixed (kPEPE −3.03M → −75 on run55
data), finished-run spread/adverse from mm_book_state, measured-hedge + per-hour strip +
A-quadrant + queue-tercile + top-of-hour sections, `--self-check` (exit 2 on any n/a).
196 suites / 1344 tests green (the flaky telemetry suite is the known exception); tsc
clean. UI QA note: no API field shape changed (HedgeUnderlyingSnap gained per-leg
mark/pnl/funding/fees — additive; both UIs unaffected, fixtures updated). Next: F1 hedge
anti-churn, replay-gated on the now-persisted run data.

## 2026-06-12 (same session, cont.) — F1: hedge anti-churn

Shipped F1 (QUANT_JOURNAL #60): five brakes between the hedge plan and execution in
`DeskHedgeController` — min-hold per leg, flip cooldown, flow-sign-flip add-freeze
(REDUCES pass), net-first (a primary flatten — loss-stop included, detected by the trader
as inventory→0 between hedge ticks — suppresses the opposing leg and restarts min-hold),
and the per-book basis gate (FARTCOIN/kPEPE/ADA excluded from the plan per run55 basis,
delta announced not hidden). New DeskEvent kinds `blocked`/`flow`; every suppression
carries its trigger numbers, rate-bounded, durable via F0's mm_desk_event. New
`scripts/hedge-churn-replay.ts` (run55: mechanical rules −17% churn cost; ≥50% gate
moves to the first live post-F1 run) + F1.6 per-leg variance-reduction report in the
leak table. Config: 5 new MM_HEDGE_* knobs (factory defaults + start-desk.sh +
RUN_THE_DESK.md). UI QA: new event kinds render verbatim on the existing tape (default
badge); no API field shape changed. 196 suites / 1354 tests; tsc clean; telemetry flake
only. Next: F2 quote anti-churn.

## 2026-06-12 (same session, cont.) — F2: quote anti-churn

Shipped F2 (QUANT_JOURNAL #61): shared `decideRequote` (queue-fill.ts — live engine and
LobReplayHarness run identical hysteresis/dwell/urgent logic), per-trigger taker-cross
attribution (every guardrail flatten tagged loss-stop/session-close/event-blackout/
remove/manual on the snapshot AND the durable fill tape — "stop tax" separable from
SQL), the grep-able `F2 requote:` interval line, and `scripts/mm-requote-compare.ts`
(A/B on the 14h hl-fine tapes: fill edge up on EVERY coin — +$346 desk at defaults,
BNB fills 187→9,018 — but net couples to the warehouse path, so hysteresis ships
DEFAULT OFF per the #53 precedent; arm `MM_REQUOTE_MIN_BPS=1` after F3). Maker-bias is
structural (post-only engine). 3 new MM_REQUOTE_* knobs. UI QA: `takerCrosses`/`requote`
are additive snapshot fields (UIs unaffected; tape messages carry `[taker: reason]`).
196 suites / 1361 tests; tsc clean; telemetry flake only. Next: F3 inventory skew.

## 2026-06-12 (same session, cont.) — F3: inventory skew + the loss-stop curve

Shipped F3 (QUANT_JOURNAL #62): GLFT concentration controls — past conc=|q|/cap 0.5 the
reservation skew strengthens (×(1+2r)) and the ADDING side's size ramps to zero at 0.85
(reduce-only), default ON (exact legacy no-op below the band); per-side quote sizes now
flow through QuotePair into both the live engine and the replay harness (0-size side
pulled). Change-driven `CONTROL ▸`/`BLOCKED ▸ conc-cap` events (new `control` DeskEvent
kind; blockedEvent generalised). Loss-stop added to LobReplayHarness +
`scripts/mm-inventory-sweep.ts`: the 0.01% stop prior is now a measured curve — desk
warehouse −1,632→−79 (−95%) at 8 lots, maxDD halved, 0.05%+ never fire; honest cost: it
cuts BNB's trend-winner. Conc mechanism validated where it binds (BNB: all metrics up);
ADA conc<70% is the live gate. 3 new MM_CONC_* knobs. UI QA: additive fields only.
196 suites / 1367 tests; tsc clean; telemetry flake only. Next: F4 Stage A (+arm F2 live).
