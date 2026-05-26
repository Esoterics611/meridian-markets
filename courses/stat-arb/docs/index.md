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

Several chapters cite an X thread by a user "rohn / roan" (the user's recollection — exact handle TBD). All such citations are explicitly marked **[TODO: verify]** in the source notebook. **This material is not load-bearing yet.** Promotion to "verified" requires (a) the actual X handle, (b) a WebFetch of the original thread, (c) a check that the claims line up with the underlying academic literature.

The verified material — Engle-Granger, Johansen, Bertram, Avellaneda-Lee, López de Prado — stands on its own regardless of how the X-thread vetting goes.
