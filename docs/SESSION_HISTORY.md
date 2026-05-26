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
