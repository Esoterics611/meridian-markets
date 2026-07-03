import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// Loader for the funding-differential board artifacts (UI_REWRITE_PLAN_II U3.1).
// The board is a MEASUREMENT the terminal script writes daily
// (scripts/funding-differential-board.ts → docs/research/funding-differentials/);
// /research serves the newest artifact read-only at page load. This is not a live
// engine endpoint and must not become a trade trigger: M2 pre-registers ≥7 daily
// boards before any differential leg may open — the page's job is to show how far
// that measurement has progressed, honestly.
//
// I/O lives here (controller-side); the render function stays pure.

/** One scored venue-pair differential, as the artifact records it. */
export interface DiffBoardPair {
  symbol: string;
  venueA: string;
  venueB: string;
  overlapDays: number;
  annualizedAPct: number;
  annualizedBPct: number;
  annualizedDiffPct: number;
  direction: 'SHORT_A_LONG_B' | 'SHORT_B_LONG_A';
  stableFraction: number;
  breakevenDays: number;
  harvestable: boolean;
}

export interface DifferentialBoardData {
  /** One artifact per day — the M2 cadence counter. */
  boardCount: number;
  /** The M2 pre-registration: boards needed before any differential leg opens. */
  requiredBoards: number;
  generatedAtMs: number;
  scored: number;
  harvestable: number;
  pairs: DiffBoardPair[];
}

/** M2 (PROFIT_PIVOT_II): ≥7 daily boards before the go/no-go verdict. */
export const REQUIRED_BOARDS = 7;

export const DIFFERENTIAL_BOARD_DIR = join(process.cwd(), 'docs', 'research', 'funding-differentials');

/**
 * Read the newest board-*.json (returns null when none exist or the dir is absent —
 * the page renders that honestly). ISO-timestamped filenames sort lexicographically.
 */
export function loadLatestDifferentialBoard(dir: string = DIFFERENTIAL_BOARD_DIR): DifferentialBoardData | null {
  try {
    const files = readdirSync(dir).filter((f) => /^board-.*\.json$/.test(f)).sort();
    if (files.length === 0) return null;
    const parsed = JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8')) as {
      board: { generatedAt: string; scored: number; harvestable: number; pairs: DiffBoardPair[] };
    };
    return {
      boardCount: files.length,
      requiredBoards: REQUIRED_BOARDS,
      generatedAtMs: Date.parse(parsed.board.generatedAt),
      scored: parsed.board.scored,
      harvestable: parsed.board.harvestable,
      pairs: parsed.board.pairs,
    };
  } catch {
    return null;
  }
}
