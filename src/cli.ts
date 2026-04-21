#!/usr/bin/env node
/**
 * CLI: spawn a replica directly, without the HTTP server.
 *
 * Usage:
 *   tsx src/cli.ts --agent <name> --skill <name> --inputs '<json>' [--timeout 300]
 */
import { loadRegistry, getAgent } from "./registry.js";
import { spawn } from "./spawner.js";
import { runStore } from "./runs.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      out[key] = val;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registryPath = args.registry ?? "./registry.json";
  const agentName = args.agent;
  const skill = args.skill;
  const inputsRaw = args.inputs ?? "{}";
  const timeoutSec = args.timeout ? parseInt(args.timeout, 10) : 300;

  if (!agentName || !skill) {
    console.error(
      "Usage: tsx src/cli.ts --agent <name> --skill <name> --inputs '<json>' [--timeout 300] [--registry path] [--keep-workspace]"
    );
    process.exit(2);
  }

  const reg = loadRegistry(registryPath);
  const agentEntry = getAgent(reg, agentName);
  const inputs = JSON.parse(inputsRaw);

  const runId = spawn({
    parentAgent: agentName,
    skill,
    inputs,
    agentEntry,
    timeoutSec,
    keepWorkspace: args["keep-workspace"] !== undefined,
  });

  console.error(`[repliclaw] runId=${runId}`);

  // Poll until done
  while (true) {
    await new Promise((r) => setTimeout(r, 1000));
    const run = runStore.get(runId);
    if (!run) break;
    if (
      run.status === "completed" ||
      run.status === "error" ||
      run.status === "timeout"
    ) {
      console.error(`[repliclaw] status=${run.status}`);
      if (run.error) console.error(`[repliclaw] error: ${run.error}`);
      console.log(JSON.stringify(run.result ?? null));
      process.exit(run.status === "completed" ? 0 : 1);
    }
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
