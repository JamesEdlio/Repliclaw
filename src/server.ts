import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { loadRegistry, getAgent } from "./registry.js";
import { spawn } from "./spawner.js";
import { runStore } from "./runs.js";

const REGISTRY_PATH = process.env.REPLICLAW_REGISTRY ?? "./registry.json";
const PORT = parseInt(process.env.PORT ?? "8787", 10);

const app = new Hono();

const SpawnBody = z.object({
  parentAgent: z.string(),
  skill: z.string(),
  inputs: z.unknown().default({}),
  timeoutSec: z.number().int().positive().optional(),
  keepWorkspace: z.boolean().optional(),
});

app.get("/", (c) =>
  c.json({
    name: "repliclaw",
    version: "0.0.1",
    registry: REGISTRY_PATH,
  })
);

app.post("/spawn", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = SpawnBody.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid body", detail: parsed.error.issues }, 400);
  }

  const reg = loadRegistry(REGISTRY_PATH);
  let agentEntry;
  try {
    agentEntry = getAgent(reg, parsed.data.parentAgent);
  } catch (e: any) {
    return c.json({ error: e.message }, 404);
  }

  const runId = spawn({
    parentAgent: parsed.data.parentAgent,
    skill: parsed.data.skill,
    inputs: parsed.data.inputs,
    agentEntry,
    timeoutSec: parsed.data.timeoutSec,
    keepWorkspace: parsed.data.keepWorkspace,
  });

  return c.json({ runId }, 202);
});

app.get("/runs/:id", (c) => {
  const run = runStore.get(c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  return c.json(run);
});

app.get("/runs", (c) => {
  return c.json({ runs: runStore.list() });
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`repliclaw listening on :${info.port}`);
  console.log(`registry: ${REGISTRY_PATH}`);
});
