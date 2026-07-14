/**
 * md-plant runner — the market-data service as a process (TECHNOLOGY_OVERVIEW §3.1,
 * Phase A slice 1: the HIP-4/Deribit vertical).
 *
 * Owns venue connectivity, publishes normalized streams on NATS, and captures every
 * published topic to a daily-rotating JSONL tape (the tickerplant log — replayable,
 * git-ignored). Consumers run with OCAL_SOURCE=bus (or their own PlantClient).
 *
 * Run (operator; requires the broker: sudo docker compose up -d nats):
 *   npx ts-node -r tsconfig-paths/register scripts/md-plant.ts
 * Knobs:
 *   NATS_URL(nats://127.0.0.1:4222) MDP_MIDS_MS(1000) MDP_BOOK_MS(1000) MDP_META_MS(60000)
 *   MDP_CHAIN_MS(60000) MDP_DEPTH(5) MDP_UNDERLYINGS(BTC,ETH) MDP_HOURS(0=indefinite)
 *   MDP_TAPE_DIR(docs/research/plant-tapes; empty string disables capture)
 */
import * as fs from 'fs';
import * as path from 'path';
import { DeribitClient } from '../src/derivatives/deribit/deribit-client';
import { HyperliquidOutcomeClient } from '../src/prediction/hyperliquid-outcome-client';
import { NatsBus } from '../src/bus/nats-bus';
import { DEFAULT_MD_PLANT, MdPlant } from '../src/market-data/plant/md-plant';

const HOURS = Number(process.env.MDP_HOURS ?? 0);
const TAPE_DIR = process.env.MDP_TAPE_DIR ?? 'docs/research/plant-tapes';
const CFG = {
  ...DEFAULT_MD_PLANT,
  priceableUnderlyings: (process.env.MDP_UNDERLYINGS ?? 'BTC,ETH').split(',').map((s) => s.trim().toUpperCase()),
  midsMs: Number(process.env.MDP_MIDS_MS ?? 1_000),
  bookMs: Number(process.env.MDP_BOOK_MS ?? 1_000),
  metaMs: Number(process.env.MDP_META_MS ?? 60_000),
  chainMs: Number(process.env.MDP_CHAIN_MS ?? 60_000),
  bookDepth: Number(process.env.MDP_DEPTH ?? 5),
};
const TICK_MS = 250; // scheduler granularity; per-topic cadence is in CFG

const log = (msg: string) => console.log(`[plant ${new Date().toISOString().slice(11, 19)}] ${msg}`);

function tapeWriter(): ((line: string) => void) | null {
  if (!TAPE_DIR) return null;
  fs.mkdirSync(TAPE_DIR, { recursive: true });
  let day = '';
  let file = '';
  return (line: string) => {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      file = path.join(TAPE_DIR, `plant-${d}.jsonl`);
      log(`tape → ${file}`);
    }
    fs.appendFileSync(file, line + '\n');
  };
}

async function main(): Promise<void> {
  const bus = await NatsBus.connect();
  const plant = new MdPlant(
    bus,
    { outcome: new HyperliquidOutcomeClient(), chain: new DeribitClient() },
    CFG,
  );
  // Tape capture is a subscriber, like any other consumer (the plant stays a pure publisher).
  const tape = tapeWriter();
  if (tape) bus.subscribe('md.>', (m) => tape(JSON.stringify(m)));

  const t0 = Date.now();
  let stopping = false;
  process.on('SIGINT', () => (stopping = true));
  log(
    `md-plant up — ${CFG.priceableUnderlyings.join('/')} | mids ${CFG.midsMs}ms books ${CFG.bookMs}ms meta ${CFG.metaMs / 1000}s chain ${CFG.chainMs / 1000}s depth ${CFG.bookDepth} | bus ${process.env.NATS_URL ?? 'nats://127.0.0.1:4222'}`,
  );

  let lastSummary = 0;
  let lastErr = '';
  while (!stopping) {
    const nowMs = Date.now();
    if (HOURS > 0 && nowMs - t0 > HOURS * 3_600_000) break;
    await plant.cycle(nowMs);
    if (plant.stats.lastError && plant.stats.lastError !== lastErr) {
      lastErr = plant.stats.lastError;
      log(`ERROR ${lastErr} (absorbed; ${plant.stats.errors} total)`);
    }
    if (nowMs - lastSummary > 10 * 60_000) {
      lastSummary = nowMs;
      log(`SUMMARY published=${plant.stats.published} errors=${plant.stats.errors}`);
    }
    const elapsed = Date.now() - nowMs;
    if (elapsed < TICK_MS) await new Promise((r) => setTimeout(r, TICK_MS - elapsed));
  }
  log(`FINAL published=${plant.stats.published} errors=${plant.stats.errors}`);
  await bus.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
