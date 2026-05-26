# Appendix A — Code-shape catalogue

> **Status: outline.** Will accumulate as `src/stat-arb/` actually gets written.

A reference catalogue of the code patterns the course relies on, in TypeScript, matching the conventions in `src/yield/` and `src/hedge/`.

## A.1 The swap-seam pattern (recap)

Every external dependency in this codebase has the shape:

1. An `I<Thing>` interface in `<module>/<thing>.interface.ts`
2. A `Mock<Thing>` in `<module>/mock-<thing>.ts` — deterministic, default-on
3. A `Real<Thing>` in `<module>/real-<vendor>-<thing>.ts` — dormant, KYB-gated
4. A factory in `<module>/<module>.module.ts` selecting on `MOCK_<MODULE>_ENABLED`

Worked examples in `src/yield/` (Phase 0) and `src/hedge/` (Phase 1 scaffold).

## A.2 Pure signal functions

**TODO:** show the `cointegrationTest`, `ouFit`, `halfLife`, `zScore` signatures together with their unit-test patterns. The principle: signal functions take `readonly number[]` (or `readonly bigint[]`) and return value objects. No `Date`, no I/O, no DI. This is what makes them golden-vector-testable.

## A.3 IStrategy

**TODO:** the canonical `onBar(bar, ctx) => Order[]` interface plus the context shape. Variant: streaming strategies that buffer multiple bars before emitting.

## A.4 Append-only ledger (recap)

The `treasury_movements` pattern repeats: `INSERT`-only at the DB-grant layer; `(provider, idempotency_key) UNIQUE`; CHECK constraints for positive amounts; partial unique indexes for cron idempotency. Apply identically to `prop_movements` when it lands.

## A.5 Bigint price arithmetic

**TODO:** how we handle price math in bigint without losing precision. Pattern: prices in micros (1e6) of the quote unit; sizes in micros (1e6 = 6-decimal USDC convention) of the base. All arithmetic exact. Float allowed only inside pure signal functions, where statistical math (regressions, eigendecompositions) is unavoidable — with explicit conversion at the boundary.
