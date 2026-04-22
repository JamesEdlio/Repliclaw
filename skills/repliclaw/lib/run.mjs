#!/usr/bin/env node
// Repliclaw run helper.
// Spawns a disposable kern replica, seeds it with a task skill, waits for
// <<RESULT>>, writes an audit log, and terminates.
//
// Exit codes:
//   0 = spawn + run completed (task itself may have returned status:error, still exit 0)
//   1 = usage/config error
//   2 = spawn failure (replica never came up)

import { parseArgs } from "node:util";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, rmSync, cpSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { scopeCreds, STRIPPED_PREFIXES } from "./scope-creds.mjs";
import { tryExtractResult, validateEnvelope, loadTaskOutputsSchema, loadTaskInvariants } from "./parse-result.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPLICLAW_ROOT = resolve(__dirname, "..", "..", "..");

// ---- Args ----------------------------------------------------------------
let args;
try {
  args = parseArgs({
    options: {
      task:       { type: "string" },
      inputs:     { type: "string" },
      "audit-dir":{ type: "string" },
      timeout:    { type: "string" },
      "keep-workspace": { type: "boolean", default: false },
    },
  }).values;
} catch (err) {
  die(1, `arg parse error: ${err.message}`);
}

if (!args.task) die(1, "--task required");
if (!args.inputs) die(1, "--inputs required (JSON string)");
let inputsObj;
try { inputsObj = JSON.parse(args.inputs); } catch (e) {
  die(1, `--inputs is not valid JSON: ${e.message}`);
}
const timeoutSec = args.timeout ? Number(args.timeout) : 600;
const auditDir = args["audit-dir"]
  ? resolve(args["audit-dir"])
  : join(process.env.HOME || "/tmp", ".repliclaw", "audit");
mkdirSync(auditDir, { recursive: true });

// ---- Locate task skill ---------------------------------------------------
const taskSkillDir = locateTaskSkill(args.task);
if (!taskSkillDir) {
  die(1, `task skill not found: ${args.task}`);
}

// ---- Prepare run ---------------------------------------------------------
const runId = mkRunId();
const runDir = join(process.env.HOME || "/tmp", ".repliclaw", "runs", runId);
const workspaceDir = join(runDir, "workspace");
mkdirSync(workspaceDir, { recursive: true });

const startedAt = new Date().toISOString();
const auditPath = join(auditDir, `${runId}.json`);

// ---- Materialize replica workspace --------------------------------------
const templateDir = join(REPLICLAW_ROOT, "skills", "repliclaw", "templates", "replica-workspace");
cpSync(templateDir, workspaceDir, { recursive: true });
// Copy task skill into replica's skills/
const replicaSkillDir = join(workspaceDir, "skills", args.task);
cpSync(taskSkillDir, replicaSkillDir, { recursive: true });

// ---- Scope creds ---------------------------------------------------------
const taskSkillMeta = readSkillFrontmatter(join(taskSkillDir, "SKILL.md"));
const requires = Array.isArray(taskSkillMeta.requires) ? taskSkillMeta.requires : [];
const scopedEnv = scopeCreds(process.env, requires);

// ---- Spawn kern-ai run ---------------------------------------------------
const childEnv = {
  // Neutral base
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: process.env.LANG || "C.UTF-8",
  // Scoped creds
  ...scopedEnv,
  // Replica-specific
  KERN_NAME: `replica-${runId}`,
  REPLICLAW_RUN_ID: runId,
  REPLICLAW_TASK: args.task,
};
// Never inherit parent auth token — child must generate its own.
delete childEnv.KERN_AUTH_TOKEN;

const child = spawn("kern-ai", ["run", "--init-if-needed", workspaceDir], {
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdoutBuf = "";
let stderrBuf = "";
child.stdout.on("data", d => { stdoutBuf += d.toString(); if (stdoutBuf.length > 1e6) stdoutBuf = stdoutBuf.slice(-5e5); });
child.stderr.on("data", d => { stderrBuf += d.toString(); if (stderrBuf.length > 1e6) stderrBuf = stderrBuf.slice(-5e5); });

// ---- Wait for replica to open port --------------------------------------
const port = await waitForPort(workspaceDir, 30_000);
if (!port) {
  await terminate(child);
  writeAudit({
    status: "error",
    error: "replica failed to open port within 30s",
    endedAt: new Date().toISOString(),
  });
  cleanupWorkspace();
  printResult({ runId, status: "error", result: null, auditPath });
  process.exit(2);
}

// ---- Post seed message ---------------------------------------------------
// kern appends KERN_AUTH_TOKEN to .env after port opens — give it a beat.
await sleep(400);
const authToken = readAuthToken(workspaceDir);
const baseUrl = `http://127.0.0.1:${port}`;
const headers = {
  "Content-Type": "application/json",
  ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
};

const seedText = [
  "[task]",
  `Run skill: ${args.task}`,
  `Inputs: ${JSON.stringify(inputsObj)}`,
  `Run ID: ${runId} (use this as the runId field in your envelope)`,
  "",
  "Your skill file is at skills/" + args.task + "/SKILL.md. Read it carefully and follow it exactly.",
  "",
  "When complete, emit exactly one line of the form:",
  "  <<RESULT>>{...envelope...}",
  "where {...envelope...} is the standard Repliclaw result envelope as defined by the skill. The envelope MUST include all required fields (status, taskName, taskVersion, runId, startedAt, finishedAt, inputs, actions, notes, errors, data) per the schema. Then stop. Do not await further input. Do not add commentary after the result marker.",
].join("\n");

try {
  const resp = await fetch(`${baseUrl}/message`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: seedText,
      userId: "repliclaw",
      interface: "web",
      channel: "web",
    }),
  });
  if (!resp.ok) throw new Error(`seed POST failed: ${resp.status}`);
} catch (e) {
  await terminate(child);
  writeAudit({
    status: "error",
    error: `seed failed: ${e.message}`,
    endedAt: new Date().toISOString(),
  });
  cleanupWorkspace();
  printResult({ runId, status: "error", result: null, auditPath });
  process.exit(2);
}

// ---- Stream SSE, scan for result ----------------------------------------
const deadline = Date.now() + timeoutSec * 1000;
let assistantText = "";
let result = null;
let errorReason = null;

try {
  const resp = await fetch(`${baseUrl}/events`, { headers, signal: AbortSignal.timeout(timeoutSec * 1000) });
  if (!resp.body) throw new Error("no SSE body");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (Date.now() < deadline && !result && !errorReason) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const raw of events) {
      const dataLines = raw.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim());
      if (!dataLines.length) continue;
      try {
        const ev = JSON.parse(dataLines.join("\n"));
        const text = extractText(ev);
        if (text) assistantText += text;
        const isEndOfTurn = ["message","turn_end","assistant_message","done"].includes(ev?.type);
        if (isEndOfTurn || assistantText.includes("<<RESULT>>")) {
          const ex = tryExtractResult(assistantText);
          if (ex.kind === "ok") { result = ex.value; break; }
          if (ex.kind === "malformed" && isEndOfTurn) { errorReason = `malformed result JSON: ${ex.raw}`; break; }
        }
      } catch { /* non-JSON SSE line */ }
    }
  }
} catch (e) {
  errorReason = `SSE error: ${e.message}`;
}

// ---- Terminate + write audit --------------------------------------------
await terminate(child);
const endedAt = new Date().toISOString();

let status, auditResult;
let validationErrors = null;
if (result) {
  // Validate envelope (and task data schema if declared)
  const dataSchema = loadTaskOutputsSchema(taskSkillDir);
  const invariants = await loadTaskInvariants(taskSkillDir);
  const valOpts = {};
  if (dataSchema) valOpts.dataSchema = dataSchema;
  if (invariants) valOpts.invariants = invariants;
  const v = await validateEnvelope(result, valOpts);
  if (!v.ok) {
    validationErrors = v.errors;
    status = "error";
    auditResult = {
      status: "error",
      reason: "envelope validation failed",
      validationErrors: v.errors,
      raw: result,
    };
  } else {
    status = typeof result === "object" && result !== null && result.status === "error" ? "error" : (result.status || "ok");
    auditResult = result;
  }
} else if (errorReason) {
  status = "error";
  auditResult = { status: "error", reason: errorReason };
} else {
  status = "timeout";
  auditResult = { status: "timeout", reason: `no result within ${timeoutSec}s` };
}

writeAudit({
  status,
  result: auditResult,
  endedAt,
  validationErrors,
});
cleanupWorkspace();
printResult({ runId, status, result: auditResult, auditPath });
process.exit(0);

// ==========================================================================
// Helpers
// ==========================================================================

function mkRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${ts}_${randomBytes(3).toString("hex")}`;
}

function locateTaskSkill(name) {
  const candidates = [
    join(process.cwd(), "skills", name),
    join(process.cwd(), ".agents", "skills", name),
    join(REPLICLAW_ROOT, "tasks", name),
    join(REPLICLAW_ROOT, "skills", name),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "SKILL.md"))) return c;
  }
  return null;
}

function readSkillFrontmatter(path) {
  try {
    const raw = readFileSync(path, "utf-8");
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    // Tiny YAML subset: top-level scalars and sequences.
    const out = {};
    let key = null;
    for (const line of m[1].split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const seqMatch = line.match(/^\s+-\s+(.*)$/);
      if (seqMatch && key) {
        if (!Array.isArray(out[key])) out[key] = [];
        out[key].push(seqMatch[1].trim());
        continue;
      }
      const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
      if (kv) {
        key = kv[1];
        const v = kv[2].trim();
        if (v === "" || v === "[]") out[key] = v === "[]" ? [] : null;
        else if (v.startsWith("[") && v.endsWith("]")) {
          out[key] = v.slice(1, -1).split(",").map(s => s.trim()).filter(Boolean);
        } else {
          out[key] = v;
        }
      }
    }
    return out;
  } catch { return {}; }
}

async function waitForPort(workspaceDir, timeoutMs) {
  const start = Date.now();
  const cfgPath = join(workspaceDir, ".kern", "config.json");
  while (Date.now() - start < timeoutMs) {
    try {
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
        if (cfg.port && await probePort(cfg.port)) return cfg.port;
      }
    } catch { /* not ready */ }
    await sleep(250);
  }
  return null;
}

async function probePort(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(500) });
    return r.status === 200 || r.status === 401;
  } catch { return false; }
}

function readAuthToken(workspaceDir) {
  const p = join(workspaceDir, ".kern", ".env");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf-8").match(/^KERN_AUTH_TOKEN=(.+)$/m);
  return m ? m[1].trim() : null;
}

function extractText(ev) {
  if (!ev || typeof ev !== "object") return null;
  if (typeof ev.text === "string") return ev.text;
  if (typeof ev.delta === "string") return ev.delta;
  if (Array.isArray(ev.content)) {
    return ev.content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text).join("");
  }
  return null;
}

async function terminate(child) {
  try { child.kill("SIGTERM"); } catch {}
  await sleep(500);
  try { if (!child.killed) child.kill("SIGKILL"); } catch {}
}

function writeAudit(patch) {
  const record = {
    runId,
    task: args.task,
    taskMeta: {
      name: taskSkillMeta.name ?? null,
      version: taskSkillMeta.version ?? null,
      repliclawEnvelopeVersion: taskSkillMeta.repliclawEnvelopeVersion ?? null,
      supports_plan_mode: taskSkillMeta.supports_plan_mode === true || taskSkillMeta.supports_plan_mode === "true",
      outputs_files: Array.isArray(taskSkillMeta.outputs_files) ? taskSkillMeta.outputs_files : [],
    },
    inputs: inputsObj,
    startedAt,
    endedAt: patch.endedAt ?? null,
    durationMs: patch.endedAt ? (new Date(patch.endedAt) - new Date(startedAt)) : null,
    status: patch.status,
    result: patch.result ?? null,
    error: patch.error ?? null,
    validationErrors: patch.validationErrors ?? null,
    replicaWorkspace: workspaceDir,
    stdoutTail: stdoutBuf.slice(-4096),
    stderrTail: stderrBuf.slice(-4096),
    scopedEnvKeys: Object.keys(scopedEnv).sort(),
    strippedPrefixes: STRIPPED_PREFIXES,
  };
  writeFileSync(auditPath, JSON.stringify(record, null, 2));
}

function cleanupWorkspace() {
  if (args["keep-workspace"]) return;
  try { rmSync(runDir, { recursive: true, force: true }); } catch {}
}

function printResult(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function die(code, msg) {
  process.stderr.write(`repliclaw: ${msg}\n`);
  process.exit(code);
}
