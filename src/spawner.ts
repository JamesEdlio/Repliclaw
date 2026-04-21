import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentEntry } from "./registry.js";
import { runStore } from "./runs.js";
import { spawnKernReplica } from "./runtimes/kern.js";

export interface SpawnRequest {
  parentAgent: string;
  skill: string;
  inputs: unknown;
  agentEntry: AgentEntry;
  timeoutSec?: number;
  keepWorkspace?: boolean;
}

export function spawn(req: SpawnRequest): string {
  const run = runStore.create({
    parentAgent: req.parentAgent,
    skill: req.skill,
    inputs: req.inputs,
  });

  // Fire-and-forget
  runReplica(run.id, req).catch((err) => {
    runStore.update(run.id, {
      status: "error",
      error: `spawn error: ${err?.message || err}`,
      endedAt: new Date().toISOString(),
    });
  });

  return run.id;
}

async function runReplica(runId: string, req: SpawnRequest): Promise<void> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "repliclaw-"));
  const timeoutSec = req.timeoutSec ?? 300;

  try {
    if (req.agentEntry.runtime === "kern") {
      await spawnKernReplica({
        runId,
        agent: req.agentEntry,
        skill: req.skill,
        inputs: req.inputs,
        workspaceDir,
        timeoutSec,
      });
    } else {
      runStore.update(runId, {
        status: "error",
        error: `runtime ${req.agentEntry.runtime} not implemented in v0`,
        endedAt: new Date().toISOString(),
      });
    }
  } finally {
    if (!req.keepWorkspace) {
      try {
        rmSync(workspaceDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
