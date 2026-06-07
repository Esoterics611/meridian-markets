import { L2Snapshot } from '../../market-data/reference/reference-source.interface';

// bookImbalanceFromL2 — signed top-N order-book imbalance, the fast microstructure
// directional input that belongs on EVERY market (FAIR_VALUE_AND_THESIS_DESIGN.md
// §Layer C). Book pressure leads the next mid move: when resting size piles on the bid,
// price tends to tick up. It is the same imbalance the micro-price weights, exposed as a
// standalone [−1,+1] signal a flow bias source can lean on.
//
//   imbalance = (ΣbidSize − ΣaskSize) / (ΣbidSize + ΣaskSize)   over the top `depth` levels/side
//
// Always computed off REAL L2 depth (no trade-print estimate), so it stays honest at any
// cadence — unlike sub-second trade flow, which goes sparse (Entry #32). null when both
// sides are empty.
export function bookImbalanceFromL2(snap: L2Snapshot, depth: number): number | null {
  const n = Math.max(1, Math.floor(depth));
  let bid = 0;
  let ask = 0;
  const nb = Math.min(n, snap.bids.length);
  const na = Math.min(n, snap.asks.length);
  for (let i = 0; i < nb; i++) bid += Number(snap.bids[i].sizeUnits);
  for (let i = 0; i < na; i++) ask += Number(snap.asks[i].sizeUnits);
  const tot = bid + ask;
  if (tot <= 0) return null;
  return (bid - ask) / tot;
}
