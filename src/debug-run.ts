import { loadRegistry, getAgent } from "./registry.js";
import { spawn } from "./spawner.js";
import { runStore } from "./runs.js";

const reg = loadRegistry("./registry.json");
const runId = spawn({
  parentAgent: "hello",
  skill: "hello",
  inputs: {name: "James"},
  agentEntry: getAgent(reg, "hello"),
  timeoutSec: 60,
  keepWorkspace: true,
});
console.error("runId=", runId);

while (true) {
  await new Promise(r => setTimeout(r, 2000));
  const run = runStore.get(runId)!;
  console.error(`[${run.status}] transcript lines: ${run.transcript.length}`);
  if (run.transcript.length > 0) {
    console.error("--- last 10 lines ---");
    run.transcript.slice(-10).forEach(l => console.error(l.slice(0, 200)));
  }
  if (["completed","error","timeout"].includes(run.status)) {
    console.error("workspace:", run.workspaceDir);
    console.error("result:", JSON.stringify(run.result));
    console.error("error:", run.error);
    break;
  }
}
