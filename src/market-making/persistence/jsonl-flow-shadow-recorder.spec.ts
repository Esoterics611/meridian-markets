import { readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonlFlowShadowRecorder } from './jsonl-flow-shadow-recorder';
import { NoopFlowShadowRecorder, FlowShadowObs } from '../bias/flow-shadow-recorder';

const obs = (signal: number): FlowShadowObs => ({
  tsMs: 1000,
  symbol: 'BTC',
  signal,
  bookImbalance: 0.5,
  tradeFlowImbalance: 0.1,
  midMicros: '66000000000',
  microMicros: '66000100000',
});

describe('JsonlFlowShadowRecorder', () => {
  it('appends one JSONL line per obs (durable immediately)', () => {
    const path = join(tmpdir(), `flow-shadow-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    const rec = new JsonlFlowShadowRecorder(path);
    rec.record(obs(0.3));
    rec.record(obs(-0.4));
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).signal).toBeCloseTo(0.3, 9);
    expect(JSON.parse(lines[1]).symbol).toBe('BTC');
    expect(rec.count).toBe(2);
    rmSync(path);
  });
});

describe('NoopFlowShadowRecorder', () => {
  it('drops everything (no throw, writes nothing)', () => {
    expect(() => new NoopFlowShadowRecorder().record(obs(0.1))).not.toThrow();
  });
});
