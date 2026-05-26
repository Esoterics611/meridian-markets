# Statistical Arbitrage — A Working Course

> Course material backing Meridian Markets' Phase 3 prop-desk build. Theory, math, and code-shape — no marketing voice, no "secrets revealed."

This is not a textbook. It is a working document tied to:

- [PHASED_PLAN.md](../../../PHASED_PLAN.md) §Phase 3 (the regulatory & capital envelope)
- [docs/STAT_ARB_PLAN.md](../../../docs/STAT_ARB_PLAN.md) (the engineering plan)
- The forthcoming `src/stat-arb/` module (not yet written)

Each chapter is structured the same way:

1. **What it is** — one paragraph, plain language.
2. **Math sketch** — the minimum equations you need to implement it.
3. **When it works / when it breaks** — empirical edges of the result.
4. **Code shape** — TypeScript interfaces, pure functions, where the seam belongs in our modular monolith.
5. **Sources** — papers, repos, X threads. Every chapter ends with a citations block.

## How to read this

- If you've never seen stat arb before: §0 → §1 → §2 in order. Skip the others until §2 makes sense.
- If you've done quant work and just want the codebase-specific shape: §4 → §5 → Appendix A.
- If you're vetting whether to invest engineering time here: just §1 and §7.

## Status banner

The X threads by [@RohOnChain](https://x.com/RohOnChain) (display name "Roan") were identified, archived, and promoted to **Tier-C verified** in Session 3 (2026-05-26). Two threads are now cited alongside Tier-A literature in §2.8, §2.9, §3.6, §5.2, §5.3, §6.5, §6.7, and Appendix C. The full archive lives at [`docs/_archive/`](_archive/x-search-attempt-2026-05-26.md); the dedicated practitioner-lore chapter is [Appendix C](appendix-c-practitioner-lore.md).

Per §0.3's promotion rule, every practitioner claim is paired with its Tier-A mapping — none is the sole support for any course assertion. The verified Tier-A material (Engle-Granger, Johansen, Bertram, Avellaneda-Lee, López de Prado, Grinold-Kahn, Hamilton, Rabiner) is documented in [Appendix B §B.1](appendix-b-sources.md).
