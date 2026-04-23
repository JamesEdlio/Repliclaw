// Kern runtime adapter for Repliclaw.
//
// Model: one kern-ai child process per run. We materialize a fresh workspace
// under $HOME/.repliclaw/runs/<runId>/workspace/, seed it from the replica
// template, copy the task skill in, spawn `kern-ai run <workspace>`, wait for
// it to open a local HTTP port, POST a seed message, then stream /events SSE
// until we see <<RESULT>> or the timeout fires. SIGTERM on cleanup.

import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { tryExtractResult } from "../parse-result.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPLICLAW_ROOT = resolve(__dirname, "..", "..", "..", "..");

export default {
  id: "kern",

  preflight(_ctx) {
    // kern-ai must be on PATH. Best-effort check; spawn will fail loudly if not.
    // (No synchronous `which` in Node without child_process; we rely on spawn ENOENT.)
  },

  async prepare(ctx) {
    const workspaceDir = join(ctx.runDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });

    const templateDir = join(REPLICLAW_ROOT, "skills", "repliclaw", "templates", "replica-workspace");
    cpSync(templateDir, workspaceDir, { recursive: true });

    // Drop the task skill into the replica's skills/ dir.
    const replicaSkillDir = join(workspaceDir, "skills", ctx.taskName);
    cpSync(ctx.taskSkillDir, replicaSkillDir, { recursive: true });

    ctx._runtimeState = { workspaceDir, child: null };
  },

  async spawnAndSeed(ctx) {
    const { workspaceDir } = ctx._runtimeState;

    const childEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG || "C.UTF-8",
      ...ctx.scopedEnv,
      KERN_NAME: `replica-${ctx.runId}`,
      REPLICLAW_RUN_ID: ctx.runId,
      REPLICLAW_TASK: ctx.taskName,
    };
    // Child must mint its own auth token, not inherit ours.
    delete childEnv.KERN_AUTH_TOKEN;

    const child = spawn("kern-ai", ["run", "--init-if-needed", workspaceDir], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    ctx._runtimeState.child = child;

    child.stdout.on("data", d => ctx.logSink.pushStdout(d.toString()));
    child.stderr.on("data", d => ctx.logSink.pushStderr(d.toString()));

    // Wait for workspace to signal ready via .kern/config.json + port probe.
    const port = await waitForPort(workspaceDir, 30_000);
    if (!port) {
      throw new Error("kern replica failed to open port within 30s");
    }
    ctx._runtimeState.port = port;

    // Token is written to .env after port opens — small delay.
    await sleep(400);
    const authToken = readAuthToken(workspaceDir);
    ctx._runtimeState.baseUrl = `http://127.0.0.1:${port}`;
    ctx._runtimeState.headers = {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    };

    const seedText = buildSeedText(ctx);

    const resp = await fetch(`${ctx._runtimeState.baseUrl}/message`, {
      method: "POST",
      headers: ctx._runtimeState.headers,
      body: JSON.stringify({
        text: seedText,
        userId: "repliclaw",
        interface: "web",
        channel: "web",
      }),
    });
    if (!resp.ok) throw new Error(`kern seed POST failed: ${resp.status}`);
  },

  async awaitResult(ctx) {
    const { baseUrl, headers } = ctx._runtimeState;
    const deadline = Date.now() + ctx.timeoutSec * 1000;
    let assistantText = "";

    const resp = await fetch(`${baseUrl}/events`, {
      headers,
      signal: AbortSignal.timeout(ctx.timeoutSec * 1000),
    });
    if (!resp.body) throw new Error("kern SSE: no response body");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const raw of events) {
        const dataLines = raw.split("\n")
          .filter(l => l.startsWith("data:"))
          .map(l => l.slice(5).trim());
        if (!dataLines.length) continue;

        try {
          const ev = JSON.parse(dataLines.join("\n"));
          const text = extractText(ev);
          if (text) assistantText += text;

          const isEndOfTurn = ["message", "turn_end", "assistant_message", "done"].includes(ev?.type);
          if (isEndOfTurn || assistantText.includes("<<RESULT>>")) {
            const ex = tryExtractResult(assistantText);
            if (ex.kind === "ok") return assistantText;
            if (ex.kind === "malformed" && isEndOfTurn) {
              // Let run.mjs deal with malformed — return the raw text.
              return assistantText;
            }
          }
        } catch {
          // non-JSON SSE line — ignore.
        }
      }
    }
    return assistantText; // timeout path; caller checks tryExtractResult
  },

  async cleanup(ctx) {
    const state = ctx._runtimeState ?? {};
    const child = state.child;
    if (child) {
      try { child.kill("SIGTERM"); } catch {}
      await sleep(500);
      try { if (!child.killed) child.kill("SIGKILL"); } catch {}
    }
    if (!ctx.keepWorkspace) {
      try { rmSync(ctx.runDir, { recursive: true, force: true }); } catch {}
    }
  },
};

// ---- helpers ----

function buildSeedText(ctx) {
  return [
    "[task]",
    `Run skill: ${ctx.taskName}`,
    `Inputs: ${JSON.stringify(ctx.inputsObj)}`,
    `Run ID: ${ctx.runId} (use this as the runId field in your envelope)`,
    "",
    `Your skill file is at skills/${ctx.taskName}/SKILL.md. Read it carefully and follow it exactly.`,
    "",
    "When complete, emit exactly one line of the form:",
    "  <<RESULT>>{...envelope...}",
    "where {...envelope...} is the standard Repliclaw result envelope as defined by the skill. The envelope MUST include all required fields (status, taskName, taskVersion, runId, startedAt, finishedAt, inputs, actions, notes, errors, data) per the schema. Then stop. Do not await further input. Do not add commentary after the result marker.",
  ].join("\n");
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
    return ev.content
      .filter(p => p?.type === "text" && typeof p.text === "string")
      .map(p => p.text)
      .join("");
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
