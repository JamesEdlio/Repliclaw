import { readFileSync } from "fs";
import { resolve } from "path";
import { z } from "zod";

const GitTemplate = z.object({
  type: z.literal("git"),
  url: z.string(),
  branch: z.string().optional(),
});

const LocalTemplate = z.object({
  type: z.literal("local"),
  path: z.string(),
});

const WorkspaceTemplate = z.union([GitTemplate, LocalTemplate]);

const AgentEntry = z.object({
  runtime: z.enum(["kern", "openclaw"]),
  workspaceTemplate: WorkspaceTemplate,
  envFile: z.string().optional(),
  model: z.string(),
  provider: z.string().default("openrouter"),
});

const Registry = z.object({
  agents: z.record(z.string(), AgentEntry),
});

export type AgentEntry = z.infer<typeof AgentEntry>;
export type WorkspaceTemplate = z.infer<typeof WorkspaceTemplate>;
export type Registry = z.infer<typeof Registry>;

export function loadRegistry(path: string): Registry {
  const raw = readFileSync(resolve(path), "utf-8");
  const parsed = JSON.parse(raw);
  return Registry.parse(parsed);
}

export function getAgent(reg: Registry, name: string): AgentEntry {
  const entry = reg.agents[name];
  if (!entry) throw new Error(`unknown parent agent: ${name}`);
  return entry;
}
