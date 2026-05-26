# 7. From paper to production

> **Status: outline.** Will be fleshed out in a follow-up session.

## 7.1 The shadow phase

Run the strategy live, against a real data feed, but **with execution disabled**. Logs every order that *would* have been submitted. Compare to backtest expectations. Mismatch tells you the backtest model is wrong somewhere — find it.

## 7.2 The minimum-capital phase

When shadow matches backtest within tolerance, deploy with the smallest capital that lets you measure fee impact and slippage honestly. Typically $50k–$100k per strategy. **Not** scaled-up backtest sizing.

## 7.3 The capital-ramp curve

If minimum-capital live matches scaled-down backtest:

- Week 1: $50k.
- Week 2–4: $100k.
- Month 2: $250k.
- Month 3+: scale to full allocation only after a clean month at $250k.

Each step requires the previous step to match expectation. **Anti-pattern:** scaling because the strategy "is making money." Strategies make money during regime-favourable weeks regardless of edge.

## 7.4 The Phase-2 gate

Per [PHASED_PLAN.md cross-phase dependency #1](../../../PHASED_PLAN.md): no production capital — even Meridian Markets' own — until legal formation closes. The shadow phase is fine to run pre-formation; **flipping execution on is not.**

## 7.5 Operations: the daily checklist

**TODO:** every-morning routine — read overnight P&L, check circuit-breaker state, re-fit OU parameters, review any tripped gates.

## 7.6 Operations: the weekly checklist

**TODO:** universe re-screening, strategy attribution review, capacity utilisation.

## 7.7 What "audited NAV" actually means

**TODO:** what the auditor wants to see (segregated bank account or qualified custodian, daily price marks from an independent source, position reconciliation against venue statements). Per PHASED_PLAN.md §Phase 3 "audited daily NAV from day one" — this section names the artifacts we need to produce.

## 7.8 Citations

Forthcoming. Production-trading operational practice is largely uncodified in literature; references will be a mix of regulatory-guidance citations (SEC ADV requirements, fund admin SLA templates) once this chapter is fleshed out.
