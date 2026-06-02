# The Desk — roles, skills, and the agentic architecture

This folder is the **desk**: the specialist roles a (human or Claude) operator
adopts to run Meridian Markets, and how they fit the repo's agentic design. Each
role is a **brief** (what you own + how you work) plus a **skill** (a slash
command that boots a session into that role).

## Roles

| Role | Owns | Edge | Brief | Skill |
|---|---|---|---|---|
| **Strategy Developer** | strategy catalogue, signal/risk, the validation gate | proving edge survives OOS net of cost | [ROLE_strategy_developer.md](./ROLE_strategy_developer.md) | `/strategy-developer` |
| **Market Data Researcher** | the reference-data layer + new universe | **discovery** — under-watched markets, DEX-first | [ROLE_market_data_researcher.md](./ROLE_market_data_researcher.md) | `/market-data-researcher` |

The two are a pipeline: the **Researcher widens the universe** (new
`IReferenceBarSource` adapters), the **Strategy Developer validates and trades**
what's wired. Neither ships on in-sample numbers; both narrate every step in
**terminal + UI**; both conserve equity first (see [[feedback-desk-risk-doctrine]]).

These two are **cross-cutting specialist** roles. The pre-existing
[STATION_BRIEF.md](./STATION_BRIEF.md) + [roster.yaml](./roster.yaml) define the
complementary **per-station quant** (owns *one strategy on one book*, driven by
the `mq` CLI over the control plane). A Strategy Developer's validated edge
becomes a station entry in `roster.yaml`; a Market Data Researcher's new source
becomes a `preset` those stations can trade.

## Skills (how a follow-up session picks up a role)

Skills live in `.claude/commands/<name>.md` and are invoked as `/<name>` (same
mechanism as `/meridian-start`). **`.claude/` is git-ignored** (CLAUDE.md §0), so
those files are local to this machine — the **committed, canonical source of
truth is the brief in this folder**. The skill is a thin launcher that says "adopt
the role in `docs/desk/ROLE_*.md`" plus the operating rules inline. To recreate a
skill on a fresh checkout, copy the "Session prompt" block from the brief into
`.claude/commands/<name>.md`.

## Primer — the agentic architecture in this repo

Full design: [../AGENTIC_HEDGE_FUND_DESIGN.md](../docs/AGENTIC_HEDGE_FUND_DESIGN.md).
The short version, and why it's deliberately lean:

- **One engine, one DB, one repo** (the modular monolith, CLAUDE.md §6). Agents do
  **not** get their own services or apps. The correctness model (append-only
  tables + Postgres `SERIALIZABLE`) only holds against a single DB in a single
  service, so we keep it that way.
- **Agents are differentiated by a brief + a scope, not by infrastructure.** A
  "role" is a markdown brief (this folder) + the slice of the system it touches.
  A Strategy Developer scopes to `src/stat-arb/strategies/` + the gate; a Market
  Data Researcher scopes to `src/market-data/reference/`. Same engine underneath.
- **Coordination substrate = git + the existing control plane.** Agents commit
  like any quant; books are already isolated by the portfolio trader; the HTTP
  control plane (`/api/stat-arb/*`, `/api/market-data/*`, `/api/market-making/*`)
  is how work is launched and observed. No orchestration framework.
- **Swap seams are the extension points.** Every external integration sits behind
  an interface with a real + mock impl, selected by config (CLAUDE.md §7):
  `IReferenceBarSource` (data), `ITradingVenue` (execution), `IQuoter` (MM),
  `IYieldProvider` (treasury). A new role's work is almost always "implement an
  interface, register it, leave the safe default on."
- **The human supervises one screen.** The `/demo` console is a thin read-only-ish
  view over the engine; everything an agent does is meant to surface there **and**
  be reproducible from the terminal. (This session's rule: every feature lands in
  both.)

### Future implications

- **More roles, same pattern.** Risk Officer (owns the gates + desk-level limits),
  Execution Engineer (maker/limit fills, the real-venue adapter + reconciliation),
  Treasury Operator (the yield module) — each a brief + a scope, no new infra.
- **Roster-driven autonomy.** A manifest of (role, scope, book) lets several
  sessions run concurrently on isolated books/branches, supervised from the one
  screen — the design's end state.
- **The seam discipline is what makes agents safe.** Because each agent works
  behind an interface with a mock default and commits through git, a bad change is
  contained to a book/branch and a safe default, not the whole engine.
- **Discovery compounds.** Every source the Market Data Researcher wires is
  permanently in the scan universe and tradeable on the live loop — the desk's
  edge surface grows monotonically without new services.

## See also

- [SESSION_NOTES_2026-06-01.md](./SESSION_NOTES_2026-06-01.md) — what shipped in
  the S22 session + step-by-step demo (UI + terminal).
- [SESSION_NOTES_2026-06-02_market-making.md](./SESSION_NOTES_2026-06-02_market-making.md)
  — S23 pivot: MM is the live earner (`mm-paper-session` harness) + the
  strategy-library rewrite brief; terminal + UI test steps.
- [../PRODUCTION_READINESS.md](../docs/PRODUCTION_READINESS.md) — the P0/P1 gate list.
- [../QUANT_TERMINAL_SPEC.md](../docs/QUANT_TERMINAL_SPEC.md) — the terminal surface.
