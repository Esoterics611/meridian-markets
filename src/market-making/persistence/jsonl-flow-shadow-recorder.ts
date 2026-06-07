import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { FlowShadowObs, IFlowShadowRecorder } from '../bias/flow-shadow-recorder';

// JsonlFlowShadowRecorder — durable append-only JSONL sink for the shadow flow signal.
// One JSON line per observation, appended IMMEDIATELY (no buffering), so a killed/crashed
// run keeps every line already written — the exact persistence gap that lost the last
// session's data does not apply here. The file is the input to scripts/flow-bias-markout.ts.
export class JsonlFlowShadowRecorder implements IFlowShadowRecorder {
  private wrote = 0;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  record(obs: FlowShadowObs): void {
    appendFileSync(this.path, JSON.stringify(obs) + '\n');
    this.wrote += 1;
  }

  get count(): number {
    return this.wrote;
  }

  get filePath(): string {
    return this.path;
  }
}
