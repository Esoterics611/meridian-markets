import { attributeBook, attributeDesk, reconciliationResidual, assertReconciles, BookTcaInput } from './regime-tca';

const U = (usd: number): bigint => BigInt(Math.round(usd * 1_000_000));

describe('RegimeTcaAttributor (P10)', () => {
  it('reconciles to the realised-first total to the cent (the invariant)', () => {
    const input: BookTcaInput = {
      symbol: 'ETH',
      realisedUnits: U(120),
      feesUnits: U(4.5),
      fundingUnits: U(8),
      unrealisedUnits: U(-15),
      slippageUnits: U(3),
      betaPnlUnits: U(40),
    };
    const tca = attributeBook(input);
    // total = realised − fees + funding + unrealised = 120 − 4.5 + 8 − 15 = 108.5
    expect(tca.totalUnits).toBe(U(108.5));
    // components: idio + beta + funding − fees − slippage must equal total exactly.
    expect(reconciliationResidual(tca)).toBe(0n);
    expect(() => assertReconciles(tca)).not.toThrow();
  });

  it('backs slippage out of the directional gross and beta out of idiosyncratic', () => {
    // directionalGross = realised + unrealised + slippage = 100 + 0 + 3 = 103.
    // idiosyncratic = directionalGross − beta = 103 − 40 = 63.
    const tca = attributeBook({
      symbol: 'SOL',
      realisedUnits: U(100),
      feesUnits: U(2),
      fundingUnits: U(0),
      unrealisedUnits: U(0),
      slippageUnits: U(3),
      betaPnlUnits: U(40),
    });
    expect(tca.directionalGrossUnits).toBe(U(103));
    expect(tca.betaUnits).toBe(U(40));
    expect(tca.idiosyncraticUnits).toBe(U(63));
    expect(tca.idiosyncraticUnits + tca.betaUnits).toBe(tca.directionalGrossUnits);
  });

  it('puts all of the directional edge into idiosyncratic when there is no factor view', () => {
    const tca = attributeBook({
      symbol: 'BTC',
      realisedUnits: U(50),
      feesUnits: U(1),
      fundingUnits: U(2),
      unrealisedUnits: U(10),
      slippageUnits: U(0),
      betaPnlUnits: U(0),
    });
    expect(tca.idiosyncraticUnits).toBe(U(60)); // 50 + 10 + 0
    expect(tca.betaUnits).toBe(0n);
    expect(reconciliationResidual(tca)).toBe(0n);
  });

  it('reconciles for ANY beta estimate (the split is a modelling choice; the total is invariant)', () => {
    const base = { symbol: 'X', realisedUnits: U(77), feesUnits: U(3), fundingUnits: U(-5), unrealisedUnits: U(12), slippageUnits: U(2) };
    for (const betaUsd of [-100, -1, 0, 0.5, 999.99]) {
      const tca = attributeBook({ ...base, betaPnlUnits: U(betaUsd) });
      expect(reconciliationResidual(tca)).toBe(0n);
      expect(tca.totalUnits).toBe(U(77 - 3 - 5 + 12)); // 81, regardless of beta
    }
  });

  it('handles a losing book with a maker rebate (negative fees)', () => {
    const tca = attributeBook({
      symbol: 'DOGE',
      realisedUnits: U(-30),
      feesUnits: U(-1.2), // rebate: revenue
      fundingUnits: U(4),
      unrealisedUnits: U(-8),
      slippageUnits: U(1),
      betaPnlUnits: U(-25),
    });
    // total = −30 − (−1.2) + 4 − 8 = −32.8
    expect(tca.totalUnits).toBe(U(-32.8));
    expect(reconciliationResidual(tca)).toBe(0n);
  });

  it('sums the desk to the cent: per-book components add up and reconcile', () => {
    const inputs: BookTcaInput[] = [
      { symbol: 'ETH', realisedUnits: U(120), feesUnits: U(4.5), fundingUnits: U(8), unrealisedUnits: U(-15), slippageUnits: U(3), betaPnlUnits: U(40) },
      { symbol: 'SOL', realisedUnits: U(100), feesUnits: U(2), fundingUnits: U(0), unrealisedUnits: U(0), slippageUnits: U(3), betaPnlUnits: U(40) },
      { symbol: 'BTC', realisedUnits: U(50), feesUnits: U(1), fundingUnits: U(2), unrealisedUnits: U(10), slippageUnits: U(0), betaPnlUnits: U(0) },
    ];
    const desk = attributeDesk(inputs);
    expect(desk.perBook).toHaveLength(3);
    // desk total = 108.5 + 96 + 60... compute: ETH 108.5, SOL = 100−2+0+0 = 98, BTC = 50−1+2+10 = 61
    expect(desk.totalUnits).toBe(U(108.5) + U(98) + U(61));
    // component sums match the per-book sums.
    const sum = (f: (b: typeof desk.perBook[number]) => bigint) => desk.perBook.reduce((a, b) => a + f(b), 0n);
    expect(desk.idiosyncraticUnits).toBe(sum((b) => b.idiosyncraticUnits));
    expect(desk.betaUnits).toBe(sum((b) => b.betaUnits));
    expect(desk.slippageUnits).toBe(sum((b) => b.slippageUnits));
    // the desk reconciles too.
    expect(desk.idiosyncraticUnits + desk.betaUnits + desk.fundingUnits - desk.feesUnits - desk.slippageUnits).toBe(desk.totalUnits);
  });

  it('assertReconciles throws on a tampered (non-balancing) attribution', () => {
    const tca = attributeBook({ symbol: 'X', realisedUnits: U(10), feesUnits: U(1), fundingUnits: U(0), unrealisedUnits: U(0), slippageUnits: U(0), betaPnlUnits: U(0) });
    const tampered = { ...tca, idiosyncraticUnits: tca.idiosyncraticUnits + U(1) };
    expect(reconciliationResidual(tampered)).toBe(U(1));
    expect(() => assertReconciles(tampered)).toThrow(/does not reconcile/);
  });
});
