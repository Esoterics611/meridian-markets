import { loadLatestDifferentialBoard, DIFFERENTIAL_BOARD_DIR, REQUIRED_BOARDS } from './research-board-loader';

// The loader reads the repo's REAL artifact directory (the boards are committed
// research deliverables), so this doubles as a schema-drift guard: if the board
// script changes its JSON shape, this fails here, not silently on the page.

describe('loadLatestDifferentialBoard', () => {
  it('loads the newest committed board with the M2 counter and scored pairs', () => {
    const b = loadLatestDifferentialBoard(DIFFERENTIAL_BOARD_DIR);
    expect(b).not.toBeNull();
    expect(b!.boardCount).toBeGreaterThanOrEqual(2); // day 1 (#91) + day 2 (#93) exist
    expect(b!.requiredBoards).toBe(REQUIRED_BOARDS);
    expect(b!.generatedAtMs).toBeGreaterThan(Date.parse('2026-07-01'));
    expect(b!.scored).toBeGreaterThan(0);
    expect(b!.pairs.length).toBeGreaterThan(0);
    const p = b!.pairs[0];
    expect(typeof p.symbol).toBe('string');
    expect(typeof p.annualizedDiffPct).toBe('number');
    expect(typeof p.stableFraction).toBe('number');
    expect(typeof p.harvestable).toBe('boolean');
    expect(['SHORT_A_LONG_B', 'SHORT_B_LONG_A']).toContain(p.direction);
  });

  it('returns null (never throws) for a missing directory — the page renders that honestly', () => {
    expect(loadLatestDifferentialBoard('/nonexistent/dir')).toBeNull();
  });
});
