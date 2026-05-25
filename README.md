# Meridian Markets

> Sister entity to [Lira-Bridge](https://github.com/vanguard-dao/meridian) (`~/code/meridian`). The yield / treasury / markets arm. Pick a real legal name later — this is the working alias.

**Status:** planning only. No code yet. Phase 0 (treasury yield service for first-party Path C float) is the first thing that ships; see [`prompts/PHASE_0_PROMPT.md`](prompts/PHASE_0_PROMPT.md).

---

## What this is

A separate legal/technical entity that:

- **Earns yield** on Lira-Bridge's idle Path C reserve-pool float (Phase 0 — first product, no license).
- **Hedges FX** for Path C's ILS/USDC exposure (Phase 1 — first-party, no license).
- **Later** becomes the home for any prop trading, 3(c)(7) crypto fund, or derivatives venue we want to offer — each with its own license stack, cap table, and balance sheet.

It shares brand and customer pipeline with Lira-Bridge, but does not share the regulated payments surface.

## Why it must be separate from Lira-Bridge

Payments licenses (MTL / EMI / CMA money-services-business) are conditioned on **not** trading principally with customer funds and **not** offering investments. Stapling yield, hedging-for-customers, or any investment product into Lira-Bridge breaks the licensing pathway it's currently pursuing (CU-05 / CU-07). Putting them in a sister entity that *buys services from* Lira-Bridge (e.g., "manage our reserve float") and *sells products to* Lira-Bridge customers who opt in keeps the regulated surfaces clean.

Cap tables are also priced differently — payments is a unit-economics game (Wise multiples), markets/fund is a fee-on-AUM game (Brevan / Citadel multiples). Investors price them differently; let each raise from its natural buyer.

## Phased build

| Phase | What ships | License/cap need | When |
|---|---|---|---|
| **0 — Treasury yield service** | `IYieldProvider` + integrations (BUIDL, Ondo USDY, Maker sDAI). Manages first-party Lira-Bridge Path C float only. No customer money. | None | **Parallel today** — ~2 Claude sessions |
| **1 — On-chain FX hedge module** | Auto-hedges Path C ILS exposure via on-chain perps (Drift / Hyperliquid). First-party only. | None for first-party | After Phase 0 — ~2–3 sessions |
| **2 — Markets Co. legal formation** | Delaware C-corp + Cayman SPC for future fund vehicles. CCO hire. Counsel opinion on RIA exemption. | $200–300k setup | Months 3–6. Business work; no code. |
| **3 — Prop desk (own capital only)** | Quant infra: market-data ingest, signal store, execution router, risk module. Trades own treasury. No customer money. Builds the track record. | None for own-capital spot; CFTC if futures | Months 6–12 |
| **4 — 3(c)(7) crypto fund for accredited Lira-Bridge members** | NAV calc, subscription/redemption portal, fund admin integration. Opt-in from Lira-Bridge UI. | SEC RIA + accredited verification | Year 2 — requires 1yr of Phase 3 track record |
| **5 — Derivatives venue (optional)** | Permissioned perps DEX or NFA-registered FX dealer | NFA FDM (~$20M net cap) or ISA license | Year 3+. Probably never if 0–4 work. |

Full per-phase detail in [`PHASED_PLAN.md`](PHASED_PLAN.md).

## The Claude-parallel trick

Because Markets is a **separate repo, separate Postgres, separate deploy**, we can run two Claude sessions concurrently — one hardening Lira-Bridge ([`prompts/LIRA_BRIDGE_PROD_READY_PROMPT.md`](prompts/LIRA_BRIDGE_PROD_READY_PROMPT.md)), one building Markets Phase 0 ([`prompts/PHASE_0_PROMPT.md`](prompts/PHASE_0_PROMPT.md)) — without either touching the other's working tree.

The **single shared touchpoint** is a future `ITreasuryClient` interface that Lira-Bridge will call to deposit/withdraw float. Designed-for, not built yet. Same posture as Lira-Bridge's transactional outbox: invented now, deployable later, no rewrite.

## Minimum viable wedge

**Phase 0 alone.** A tiny repo that exposes a treasury-yield service to Lira-Bridge's reserve pool. No license, no LP marketing, no fund formation. Just *"where does idle Path C USDC sit."*

That alone improves Lira-Bridge's Path C gross margin by ~400 bps and creates the seed asset — a working markets stack, a small track record, a recognised internal counterparty — that every later phase compounds on. Everything else waits for legal capital and for Lira-Bridge's customer base to be worth selling investment products to.

## Layout

```
meridian-markets/
  README.md                                  ← this file (1-pager)
  PHASED_PLAN.md                             ← per-phase deep dive (regulatory, capital, sequencing)
  prompts/
    PHASE_0_PROMPT.md                        ← Markets Phase 0 — treasury yield service
    LIRA_BRIDGE_PROD_READY_PROMPT.md         ← parallel-track prompt for hardening Lira-Bridge
```

When code starts landing in Phase 0, mirror the Lira-Bridge layout (`src/`, `migrations/`, `test/`, `package.json`, NestJS + TypeORM strict, `ISecretProvider` for vault swap-point). The Lira-Bridge architectural decisions (modular monolith, append-only ledger if relevant, machine-enforced boundaries, transactional outbox) are the model — don't re-litigate them.
