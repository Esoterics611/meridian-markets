import { RegimeDirectionalBook, RegimeTick } from './regime-directional-book';
import { BiasReading } from '../bias/bias-source.interface';
import { DeskEventInput } from '../events/desk-event';
import { SlippageImpactModel } from './fill-cost-model';

const MID = 50_000_000_000n; // $50,000 in price micros
const reading = (bias: number, validated = true): BiasReading => ({ bias, validated, reason: `b=${bias}` });

function book(overrides = {}) {
  return new RegimeDirectionalBook({ baseNotionalUsd: 50_000, bEnter: 0.15, bExit: 0.07, stopFrac: 0.02, takerFeeBps: 4.5, ...overrides });
}

function tick(p: Partial<RegimeTick> & { reading: BiasReading }): RegimeTick {
  return { nowMs: 0, midMicros: MID, ...p };
}

describe('RegimeDirectionalBook', () => {
  describe('the safe default (no regression)', () => {
    it('a neutral (b=0) reading NEVER opens a position', () => {
      const b = book();
      const a = b.update(tick({ reading: reading(0) }));
      expect(b.inventoryUnits()).toBe(0n);
      expect(a.action).toBe('none');
      expect(a.trigger).toBe('flat');
    });

    it('an UNVALIDATED strong reading never sizes a position (the OOS gate)', () => {
      const b = book();
      b.update(tick({ reading: reading(0.9, false) }));
      expect(b.inventoryUnits()).toBe(0n);
    });

    it('a validated reading below the entry floor stays flat', () => {
      const b = book();
      b.update(tick({ reading: reading(0.1) })); // 0.1 < bEnter 0.15
      expect(b.inventoryUnits()).toBe(0n);
    });
  });

  describe('entry', () => {
    it('a validated strong long opens a long position of the right size', () => {
      const b = book();
      const a = b.update(tick({ reading: reading(0.5) }));
      // conviction 0.5 → $25,000 notional → 0.5 BTC at $50k → 500_000 units (6-dec)
      expect(b.inventoryUnits()).toBe(500_000n);
      expect(a.action).toBe('open');
      expect(a.trigger).toBe('entry');
    });

    it('a validated strong short opens a short position', () => {
      const b = book();
      b.update(tick({ reading: reading(-0.5) }));
      expect(b.inventoryUnits()).toBe(-500_000n);
    });

    it('position size is monotonic in conviction', () => {
      const small = book();
      const big = book();
      small.update(tick({ reading: reading(0.3) }));
      big.update(tick({ reading: reading(0.6) }));
      expect(big.inventoryUnits()).toBeGreaterThan(small.inventoryUnits());
    });

    it('the OOS IC caps conviction below |bias| when supplied', () => {
      const capped = book();
      const uncapped = book();
      // ic 0.05 → biasMagnitudeCap = min(0.5, 4·0.05)=0.2 < bias 0.5 ⇒ smaller position
      capped.update(tick({ reading: reading(0.5), ic: 0.05 }));
      uncapped.update(tick({ reading: reading(0.5) }));
      expect(capped.inventoryUnits()).toBeLessThan(uncapped.inventoryUnits());
    });
  });

  describe('exits', () => {
    it('the directional stop flattens a losing position (preempts the still-bullish signal)', () => {
      const b = book();
      b.update(tick({ reading: reading(0.5) })); // long 0.5 BTC at $50k
      // 5% adverse move with the signal STILL bullish: the stop, not decay, must flatten.
      const a = b.update(tick({ reading: reading(0.5), midMicros: 47_500_000_000n }));
      expect(b.inventoryUnits()).toBe(0n);
      expect(a.trigger).toBe('loss-stop');
      expect(a.action).toBe('close');
    });

    it('a faded view (below the exit band) decays to flat', () => {
      const b = book();
      b.update(tick({ reading: reading(0.5) }));
      const a = b.update(tick({ reading: reading(0.05) })); // 0.05 < bExit 0.07
      expect(b.inventoryUnits()).toBe(0n);
      expect(a.trigger).toBe('decay');
    });

    it('a flipped view crosses to the opposite side', () => {
      const b = book();
      b.update(tick({ reading: reading(0.5) }));
      const a = b.update(tick({ reading: reading(-0.5) }));
      expect(b.inventoryUnits()).toBeLessThan(0n);
      expect(a.trigger).toBe('flip');
      expect(a.action).toBe('flip');
    });

    it('a stand-aside regime flag flattens an open position', () => {
      const b = book();
      b.update(tick({ reading: reading(0.5) }));
      const a = b.update(tick({ reading: reading(0.5), standAside: true }));
      expect(b.inventoryUnits()).toBe(0n);
      expect(a.trigger).toBe('stand-aside');
    });
  });

  describe('hold (hysteresis)', () => {
    it('holds the existing position when the view sits in the [bExit, bEnter) band, same side', () => {
      const b = book();
      b.update(tick({ reading: reading(0.5) }));
      const inv = b.inventoryUnits();
      const a = b.update(tick({ reading: reading(0.1) })); // 0.07 ≤ 0.1 < 0.15, same sign
      expect(b.inventoryUnits()).toBe(inv); // unchanged — no resize churn
      expect(a.action).toBe('none');
      expect(a.trigger).toBe('hold');
    });
  });

  describe('funding accrual', () => {
    it('a short collects funding when funding is positive (longs pay shorts)', () => {
      const b = book();
      b.update(tick({ nowMs: 0, reading: reading(-0.5) })); // open short
      b.update(tick({ nowMs: 3_600_000, reading: reading(-0.5), fundingRatePerHour: 0.000125 })); // +1h
      expect(b.fundingUnits()).toBeGreaterThan(0n);
    });

    it('a long pays funding when funding is positive', () => {
      const b = book();
      b.update(tick({ nowMs: 0, reading: reading(0.5) }));
      b.update(tick({ nowMs: 3_600_000, reading: reading(0.5), fundingRatePerHour: 0.000125 }));
      expect(b.fundingUnits()).toBeLessThan(0n);
    });

    it('funding is included in total P&L', () => {
      const b = book();
      b.update(tick({ nowMs: 0, reading: reading(-0.5) }));
      b.update(tick({ nowMs: 3_600_000, reading: reading(-0.5), fundingRatePerHour: 0.000125 }));
      const snap = b.snapshot(MID);
      expect(snap.totalPnlUnits).toBe(snap.realisedUnits - snap.feesUnits + snap.fundingUnits + snap.unrealisedUnits);
      expect(snap.fundingUnits).toBeGreaterThan(0n);
    });
  });

  describe('tape', () => {
    it('emits a fill event on entry and a control + fill event on a loss-stop', () => {
      const events: DeskEventInput[] = [];
      const b = book({ onEvent: (e: DeskEventInput) => events.push(e), book: 'BTC' });
      b.update(tick({ reading: reading(0.5) }));
      b.update(tick({ reading: reading(0.5), midMicros: 47_500_000_000n }));
      const kinds = events.map((e) => `${e.kind}:${e.trigger ?? ''}`);
      expect(kinds).toContain('fill:entry');
      expect(kinds).toContain('fill:loss-stop');
      expect(events.some((e) => e.kind === 'control')).toBe(true);
    });
  });

  describe('config guard', () => {
    it('rejects bExit ≥ bEnter (the hysteresis band must be ordered)', () => {
      expect(() => book({ bEnter: 0.1, bExit: 0.1 })).toThrow(/bExit/);
    });
  });

  describe('fill-cost model (P7 — honest slippage)', () => {
    it('the default model is frictionless: zero slippage, fills at the mid (no regression)', () => {
      const b = book();
      b.update(tick({ reading: reading(0.5) })); // open long at the mid
      const s = b.snapshot(MID);
      expect(s.slippageUnits).toBe(0n);
      expect(s.unrealisedUnits).toBe(0n); // entered at mid ⇒ marking back to mid is flat (only the fee is the cost)
    });

    it('a slippage model worsens the fill: a slipped entry is strictly costlier than mid+fee', () => {
      const frictionless = book();
      const slipped = book({ fillModel: new SlippageImpactModel({ halfSpreadBps: 10 }) });
      frictionless.update(tick({ reading: reading(0.5) }));
      slipped.update(tick({ reading: reading(0.5) }));
      const fs = frictionless.snapshot(MID);
      const ss = slipped.snapshot(MID);
      expect(ss.slippageUnits).toBeGreaterThan(0n);
      // Bought ABOVE the mid ⇒ marking back to the mid is an immediate loss vs frictionless.
      expect(ss.unrealisedUnits).toBeLessThan(fs.unrealisedUnits);
      expect(ss.totalPnlUnits).toBeLessThan(fs.totalPnlUnits);
    });

    it('slippage is persisted + restored (survives a restart)', () => {
      const b = book({ fillModel: new SlippageImpactModel({ halfSpreadBps: 10 }) });
      b.update(tick({ reading: reading(0.5) }));
      const slip = b.slippageUnits();
      expect(slip).toBeGreaterThan(0n);
      const revived = book(); // a fresh frictionless book restoring a slipped state
      revived.restoreState(b.serializeState());
      expect(revived.slippageUnits()).toBe(slip);
    });
  });

  describe('persistence (restart-safe books — the #47 rehydrate trap)', () => {
    it('serialize → restore is a lossless round-trip', () => {
      const orig = book();
      orig.update(tick({ nowMs: 0, reading: reading(0.5) })); // open a real position
      orig.update(tick({ nowMs: 3_600_000, reading: reading(0.4), fundingRatePerHour: 0.0001 }));
      const state = orig.serializeState();
      expect(BigInt(state.book.inventoryUnits)).not.toBe(0n); // there IS state to carry

      const revived = book();
      revived.restoreState(state);
      expect(revived.serializeState()).toEqual(state); // exact
      expect(revived.inventoryUnits()).toBe(orig.inventoryUnits());
      expect(revived.fundingUnits()).toBe(orig.fundingUnits());
      expect(revived.snapshot(MID)).toEqual(orig.snapshot(MID));
    });

    it('a REHYDRATED book trades IDENTICALLY to one that never restarted (no path drift)', () => {
      // The #47 lesson: the restart path must not diverge from the live path. Drive an
      // original into an open long with funding history, serialize, rebuild + restore, then
      // feed BOTH the survivor (orig) and the rehydrated (revived) the SAME next tick.
      const orig = book();
      orig.update(tick({ nowMs: 0, reading: reading(0.5) }));
      orig.update(tick({ nowMs: 3_600_000, reading: reading(0.4), fundingRatePerHour: 0.0001 }));
      const state = orig.serializeState();

      const revived = book();
      revived.restoreState(state);

      const next = tick({ nowMs: 7_200_000, reading: reading(0.05), fundingRatePerHour: 0.0001 }); // decay→flat, +1h funding
      const aOrig = orig.update(next);
      const aRevived = revived.update(next);

      // Same decision, same fill, same booked P&L — funding accrues over the SAME Δt because
      // lastMs was restored (drop it and the revived book mis-accrues — the trap this guards).
      expect(aRevived.action).toBe(aOrig.action);
      expect(aRevived.trigger).toBe(aOrig.trigger);
      expect(aRevived.filledUnits).toBe(aOrig.filledUnits);
      expect(revived.inventoryUnits()).toBe(orig.inventoryUnits());
      expect(revived.snapshot(MID)).toEqual(orig.snapshot(MID));
    });
  });
});
