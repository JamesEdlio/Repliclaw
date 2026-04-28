#!/usr/bin/env node
// Repliclaw run helper.
// Spawns a disposable replica via a runtime adapter (kern / openclaw / ...),
// seeds it with a task skill, waits for <<RESULT>>, writes an audit log,
// and terminates. Runtime-agnostic — all runtime-specific plumbing lives
// behind the adapter interface in lib/runtimes/.
//
// Exit codes:
//   0 = spawn + run completed (task itself may have returned status:error, still exit 0)
//   1 = usage/config error
//   2 = spawn failure (replica never came up)

import { parseArgs } from "node:util";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { scopeCreds, STRIPPED_PREFIXES } from "./scope-creds.mjs";
import { tryExtractResult, validateEnvelope, loadTaskOutputsSchema, loadTaskInvariants } from "./parse-result.mjs";
import { loadRuntime, SUPPORTED_RUNTIMES } from "./runtimes/index.mjs";
import { initEvents, emit, closeEvents } from "./events.mjs";

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
      runtime:    { type: "string", default: "kern" },
      "audit-dir":{ type: "string" },
      timeout:    { type: "string" },
      "keep-workspace": { type: "boolean", default: false },
      "events-fd":   { type: "string" },
      "events-file": { type: "string" },
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

const runtimeId = args.runtime;
if (!SUPPORTED_RUNTIMES.includes(runtimeId)) {
  die(1, `unknown --runtime ${runtimeId}. Supported: ${SUPPORTED_RUNTIMES.join(", ")}`);
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

// ---- Parse skill frontmatter (runtimes, requires, taskMeta) -------------
const taskSkillMeta = readSkillFrontmatter(join(taskSkillDir, "SKILL.md"));
const supportedRuntimes = Array.isArray(taskSkillMeta.runtimes)
  ? taskSkillMeta.runtimes
  : ["kern"]; // default: kern only, for backward compatibility
if (!supportedRuntimes.includes(runtimeId)) {
  die(1,
    `task '${args.task}' does not declare support for runtime '${runtimeId}'. ` +
    `Declared: [${supportedRuntimes.join(", ")}]. ` +
    `Add '${runtimeId}' to the task's 'runtimes:' frontmatter to enable.`
  );
}

const requires = Array.isArray(taskSkillMeta.requires) ? taskSkillMeta.requires : [];
const scopedEnv = scopeCreds(process.env, requires);

// ---- Prepare run ---------------------------------------------------------
const runId = mkRunId();
const runDir = join(process.env.HOME || "/tmp", ".repliclaw", "runs", runId);
mkdirSync(runDir, { recursive: true });

const startedAt = new Date().toISOString();
const auditPath = join(auditDir, `${runId}.json`);

// ---- Events emitter (optional) -------------------------------------------
// Allows orchestrators to stream run progress live. If neither --events-fd
// nor --events-file is supplied, emit() is a no-op and nothing is written.
initEvents({
  runId,
  fd: args["events-fd"] !== undefined ? Number(args["events-fd"]) : undefined,
  file: args["events-file"],
});
emit("phase", { phase: "start", task: args.task, runtime: runtimeId });

// Log buffers, bounded so they don't grow unbounded during long runs.
let stdoutBuf = "";
let stderrBuf = "";
const logSink = {
  pushStdout(s) {
    stdoutBuf += s; if (stdoutBuf.length > 1e6) stdoutBuf = stdoutBuf.slice(-5e5);
    emit("stdout", { text: s });
  },
  pushStderr(s) {
    stderrBuf += s; if (stderrBuf.length > 1e6) stderrBuf = stderrBuf.slice(-5e5);
    emit("stderr", { text: s });
  },
};

const ctx = {
  runId,
  taskName: args.task,
  taskSkillDir,
  taskSkillMeta,
  inputsObj,
  scopedEnv,
  timeoutSec,
  runDir,
  keepWorkspace: args["keep-workspace"],
  logSink,
};

const runtime = loadRuntime(runtimeId);

// ---- Run phases ----------------------------------------------------------
let assistantText = "";
let errorReason = null;

try {
  emit("phase", { phase: "preflight" });
  await runtime.preflight(ctx);
  emit("phase", { phase: "prepare" });
  await runtime.prepare(ctx);
  emit("phase", { phase: "spawn" });
  await runtime.spawnAndSeed(ctx);
  emit("phase", { phase: "awaiting" });
  assistantText = await runtime.awaitResult(ctx);
} catch (e) {
  errorReason = `${runtimeId} runtime error: ${e.message}`;
  emit("error", { message: errorReason });
}

// Cleanup is always attempted.
emit("phase", { phase: "cleanup" });
try { await runtime.cleanup(ctx); } catch { /* best-effort */ }

// ---- Extract + validate result ------------------------------------------
const endedAt = new Date().toISOString();
let status, auditResult;
let validationErrors = null;
let result = null;

if (!errorReason && assistantText) {
  const ex = tryExtractResult(assistantText);
  if (ex.kind === "ok") {
    result = ex.value;
  } else if (ex.kind === "malformed") {
    errorReason = `malformed result JSON: ${ex.raw}`;
  } else {
    // no marker found
    errorReason = `no <<RESULT>> marker in assistant output`;
  }
}

if (result) {
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
  status = errorReason.startsWith("no <<RESULT>>") ? "timeout" : "error";
  auditResult = { status, reason: errorReason };
} else {
  status = "timeout";
  auditResult = { status: "timeout", reason: `no result within ${timeoutSec}s` };
}

writeAudit({ status, result: auditResult, endedAt, validationErrors });
emit("result", { status, envelope: auditResult });
emit("phase", { phase: "done", status });
closeEvents();
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

function writeAudit(patch) {
  const record = {
    runId,
    task: args.task,
    runtime: runtimeId,
    taskMeta: {
      name: taskSkillMeta.name ?? null,
      version: taskSkillMeta.version ?? null,
      repliclawEnvelopeVersion: taskSkillMeta.repliclawEnvelopeVersion ?? null,
      runtimes: supportedRuntimes,
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
    runDir,
    stdoutTail: stdoutBuf.slice(-4096),
    stderrTail: stderrBuf.slice(-4096),
    scopedEnvKeys: Object.keys(scopedEnv).sort(),
    strippedPrefixes: STRIPPED_PREFIXES,
  };
  writeFileSync(auditPath, JSON.stringify(record, null, 2));
}

function printResult(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function die(code, msg) {
  process.stderr.write(`repliclaw: ${msg}\n`);
  process.exit(code);
}
