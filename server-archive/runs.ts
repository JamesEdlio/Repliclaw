import { randomBytes } from "crypto";

export type RunStatus =
  | "pending"
  | "spawning"
  | "running"
  | "completed"
  | "error"
  | "timeout";

export interface Run {
  id: string;
  parentAgent: string;
  skill: string;
  inputs: unknown;
  status: RunStatus;
  result?: unknown;
  error?: string;
  transcript: string[];
  startedAt: string;
  endedAt?: string;
  workspaceDir?: string;
  pid?: number;
}

class RunStore {
  private runs = new Map<string, Run>();

  create(input: {
    parentAgent: string;
    skill: string;
    inputs: unknown;
  }): Run {
    const id = "r_" + randomBytes(6).toString("hex");
    const run: Run = {
      id,
      parentAgent: input.parentAgent,
      skill: input.skill,
      inputs: input.inputs,
      status: "pending",
      transcript: [],
      startedAt: new Date().toISOString(),
    };
    this.runs.set(id, run);
    return run;
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  update(id: string, patch: Partial<Run>) {
    const r = this.runs.get(id);
    if (!r) return;
    Object.assign(r, patch);
  }

  appendTranscript(id: string, line: string) {
    const r = this.runs.get(id);
    if (!r) return;
    r.transcript.push(line);
  }

  list(): Run[] {
    return Array.from(this.runs.values());
  }
}

export const runStore = new RunStore();
