// OpenClaw runtime adapter for Repliclaw.
//
// Primary path: the openclaw gateway (persistent process, default port 18789).
// "Disposable replica" = a sub-agent session spawned via `sessions_spawn` on
// an existing agent session. The gateway manages the session lifecycle; we
// just seed a task, poll until the sub-agent emits its final assistant
// message containing <<RESULT>>, then let `cleanup: "delete"` (set at spawn
// time) tear the session down.
//
// How we reach the gateway:
//   - Preflight health:  `openclaw gateway call health`  (CLI RPC path)
//   - Tool invocations:  HTTP POST http://127.0.0.1:18789/tools/invoke
//                        with Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN
//
// The CLI's `gateway call` method dispatcher only routes a narrow allowlist
// (health, status, system-presence, cron.*, sessions.*) and does NOT expose
// `tools.invoke`. Tool invocation lives on the HTTP API instead.
//
// Tools used:
//   - sessions_spawn    (spawn the child session)   [requires allowlist, see below]
//   - sessions_history  (poll for the child's final reply)
//   - subagents         (kill on timeout/error)
//
// Operator config requirement: `sessions_spawn` is in the gateway's default
// HTTP deny-list. Lift it in openclaw.json:
//   { "gateway": { "tools": { "allow": ["sessions_spawn"] } } }
// This keeps the trust boundary at loopback + bearer token (same as the rest
// of the HTTP API) and does not broaden network exposure.
//
// Fallback path: `openclaw agent --local` runs the runtime embedded in a
// short-lived CLI process, no gateway required. Per OpenClaw docs this is
// explicitly a fallback, not a production-blessed disposable-replica path.
// Opt-in per task via `openclawMode: "local"` in SKILL.md frontmatter.
// The per-run agent workspace isolation is real, but there is no sandbox
// guarantee, so don't run mutating tasks this way if you care about blast
// radius.
//
// Seed shape: same contract as kern — a single task message with the skill
// name, inputs, runId, and an explicit instruction to emit exactly one
// `<<RESULT>>{envelope}` line. We also ask the child to reply ANNOUNCE_SKIP
// in the announce step so it doesn't burn tokens re-posting the result to
// the parent chat. The parent here is us, a fake "repliclaw-host" session;
// we only care about the child's own final assistant message, which the
// adapter reads via `sessions_history` on the child session key.

import { spawn } from "node:child_process";
import { mkdirSync, cpSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { tryExtractResult } from "../parse-result.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPLICLAW_ROOT = resolve(__dirname, "..", "..", "..", "..");

// Polling cadence for sessions_history while waiting on a gateway sub-agent.
const POLL_MS = 1500;

export default {
  id: "openclaw",

  async preflight(ctx) {
    // Resolve mode: frontmatter wins, else gateway (the recommended path).
    const modeFromSkill = ctx.taskSkillMeta?.openclawMode;
    const mode =
      modeFromSkill === "local" ? "local"
        : modeFromSkill === "gateway" ? "gateway"
        : "gateway";
    const agentIdFromSkill =
      ctx.taskSkillMeta?.openclawAgent || process.env.OPENCLAW_AGENT_ID;

    const cliOk = await runQuick("openclaw", ["--version"], 4000);
    if (!cliOk.ok) {
      throw new Error(
        `openclaw CLI not usable: ${cliOk.reason}. ` +
        `Install from https://docs.openclaw.ai/start/getting-started or add it to PATH.`
      );
    }

    if (mode === "gateway") {
      if (!agentIdFromSkill) {
        throw new Error(
          "openclaw gateway mode requires an agent id. Set `openclawAgent: <id>` " +
          "in the task SKILL.md frontmatter, or export OPENCLAW_AGENT_ID. " +
          "The spawning session uses this agent's tool policy, sandbox config, " +
          "and allowlist."
        );
      }
      if (!process.env.OPENCLAW_GATEWAY_TOKEN) {
        throw new Error(
          "openclaw gateway mode requires OPENCLAW_GATEWAY_TOKEN. " +
          "Export the gateway bearer token for the HTTP API (used by /tools/invoke). " +
          "Confirm with: `curl -sH \"Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN\" " +
          "http://127.0.0.1:18789/health`."
        );
      }
      const health = await callGateway("health", {}, { timeoutMs: 15_000 });
      if (!health.ok) {
        throw new Error(
          `openclaw gateway not reachable (health check failed: ${health.reason}). ` +
          `Start it with 'openclaw gateway start', verify 'openclaw gateway status', ` +
          `or switch the task to local mode via 'openclawMode: local' in SKILL.md.`
        );
      }
      // Parent session key we'll spawn from. Spawning from the main session is
      // the simplest; the child session key is returned by sessions_spawn.
      const parentSessionKey =
        ctx.taskSkillMeta?.openclawParentSessionKey || `agent:${agentIdFromSkill}:main`;

      ctx._runtimeState = {
        mode: "gateway",
        agentId: agentIdFromSkill,
        parentSessionKey,
        childSessionKey: null,
        runId: null,
      };
    } else {
      // Local mode — mint a scratch openclaw agent per run, run
      // `openclaw agent --local` against it, tear it down afterwards.
      const scratchAgentId = `rpc-${ctx.runId}`.slice(0, 48).toLowerCase().replace(/[^a-z0-9-]/g, "-");
      ctx._runtimeState = {
        mode: "local",
        agentId: scratchAgentId,
        scratchAgentCreated: false,
      };
    }
  },

  async prepare(ctx) {
    mkdirSync(ctx.runDir, { recursive: true });

    if (ctx._runtimeState.mode === "local") {
      const workspaceDir = join(ctx.runDir, "workspace");
      mkdirSync(workspaceDir, { recursive: true });

      const templateDir = join(REPLICLAW_ROOT, "skills", "repliclaw", "templates", "replica-workspace");
      cpSync(templateDir, workspaceDir, { recursive: true });

      const replicaSkillDir = join(workspaceDir, "skills", ctx.taskName);
      cpSync(ctx.taskSkillDir, replicaSkillDir, { recursive: true, dereference: true });

      // Note: on openclaw CLI 2026.3.28, `agents add` was still an interactive
      // wizard and did not accept `--non-interactive`. Newer builds are
      // expected to support it. If this call errors with an unknown flag,
      // either upgrade the CLI or switch the task to gateway mode.
      const add = await runCaptured(
        "openclaw",
        ["agents", "add", ctx._runtimeState.agentId, "--workspace", workspaceDir, "--non-interactive", "--json"],
        { env: localChildEnv(ctx), timeoutMs: 15_000 },
      );
      if (!add.ok) {
        throw new Error(
          `failed to register scratch openclaw agent '${ctx._runtimeState.agentId}': ` +
          `${add.reason}. stderr: ${add.stderr.slice(-400)}`
        );
      }
      ctx._runtimeState.scratchAgentCreated = true;
      ctx._runtimeState.workspaceDir = workspaceDir;
      return;
    }

    // Gateway mode: no per-run workspace setup. The child session inherits
    // the agent's workspace + tool policy. Task skill must be mountable via
    // an existing mechanism (managed skill on the agent, shared skills dir,
    // or vendored into the agent workspace out-of-band).
    //
    // We stage the skill to disk anyway so the audit record can point at it
    // for reproducibility, even though the replica reads the copy the
    // gateway resolved.
    const stagingDir = join(ctx.runDir, "skill-snapshot");
    mkdirSync(stagingDir, { recursive: true });
    cpSync(ctx.taskSkillDir, stagingDir, { recursive: true, dereference: true });
    ctx._runtimeState.stagingDir = stagingDir;
  },

  async spawnAndSeed(ctx) {
    const state = ctx._runtimeState;
    if (state.mode === "local") {
      return spawnLocal(ctx);
    }
    return spawnGateway(ctx);
  },

  async awaitResult(ctx) {
    const state = ctx._runtimeState;
    if (state.mode === "local") {
      return awaitLocal(ctx);
    }
    return awaitGateway(ctx);
  },

  async cleanup(ctx) {
    const state = ctx._runtimeState ?? {};

    // 1. Stop any in-flight child process (local mode).
    if (state.child && state.child.exitCode === null) {
      try { state.child.kill("SIGTERM"); } catch {}
      await sleep(500);
      try { if (!state.child.killed) state.child.kill("SIGKILL"); } catch {}
    }

    // 2. Gateway cleanup: kill the sub-agent if it's still running.
    //    We asked for `cleanup: "delete"` at spawn, so a finished run
    //    should already be gone. This is a best-effort guard for timeouts
    //    and thrown errors mid-await.
    if (state.mode === "gateway" && state.childSessionKey) {
      await invokeTool(
        "subagents",
        { action: "kill", target: state.childSessionKey },
        { sessionKey: state.parentSessionKey, timeoutMs: 5000 },
      ).catch(() => {}); // best-effort
    }

    // 3. Local mode: tear down the scratch agent registration.
    if (state.mode === "local" && state.scratchAgentCreated) {
      await runCaptured(
        "openclaw",
        ["agents", "delete", state.agentId, "--force", "--json"],
        { env: localChildEnv(ctx), timeoutMs: 10_000 },
      ).catch(() => {});
    }

    // 4. Host-side scratch dir.
    if (!ctx.keepWorkspace) {
      try { rmSync(ctx.runDir, { recursive: true, force: true }); } catch {}
    }
  },
};

// ---- gateway mode -------------------------------------------------------

async function spawnGateway(ctx) {
  const state = ctx._runtimeState;
  const seedText = buildSeedText(ctx, { announceSkip: true });

  const spawnArgs = {
    task: seedText,
    agentId: state.agentId,
    cleanup: "delete", // auto-archive transcript after announce
    runTimeoutSeconds: ctx.timeoutSec,
    sandbox: "inherit", // let the agent's sandbox config decide
    label: `repliclaw:${ctx.taskName}:${ctx.runId}`,
  };

  const res = await invokeTool(
    "sessions_spawn",
    spawnArgs,
    { sessionKey: state.parentSessionKey, timeoutMs: 15_000 },
  );
  if (!res.ok) {
    throw new Error(
      `openclaw sessions_spawn failed: ${res.reason}. ` +
      `${res.hint ? `hint: ${res.hint}. ` : ""}` +
      `body: ${(res.body || "").slice(-400)}`
    );
  }

  // HTTP shape (OpenClaw 2026.3.28+):
  //   { ok: true, result: {
  //       content: [{ type: "text", text: "<JSON-as-string>" }],
  //       details: { status, runId, childSessionKey, ... }
  //   }}
  // Legacy shape: { ok: true, result: { status, runId, childSessionKey } }
  const payload = res.result || {};
  const details = payload.details || {};
  const childKey =
    details.childSessionKey ||
    payload.childSessionKey ||
    payload.result?.childSessionKey;
  const childRunId =
    details.runId || payload.runId || payload.result?.runId;
  if (!childKey) {
    throw new Error(
      `openclaw sessions_spawn returned no childSessionKey. body: ${(res.body || "").slice(-400)}`
    );
  }
  state.childSessionKey = childKey;
  state.runId = childRunId;
  ctx.logSink.pushStdout(
    `[openclaw] spawned child session ${childKey} (runId=${childRunId})\n`
  );
}

async function awaitGateway(ctx) {
  const state = ctx._runtimeState;
  const deadline = Date.now() + ctx.timeoutSec * 1000;

  let lastAssistantText = "";
  while (Date.now() < deadline) {
    const histRes = await invokeTool(
      "sessions_history",
      { sessionKey: state.childSessionKey, limit: 30 },
      { sessionKey: state.parentSessionKey, timeoutMs: 8000 },
    );

    if (histRes.ok) {
      const text = extractAssistantText(histRes.result);
      if (text) {
        lastAssistantText = text;
        const ex = tryExtractResult(text);
        if (ex.kind === "ok") return text;
      }

      // If the session no longer exists (cleanup: "delete" already fired),
      // return whatever we have — run.mjs will interpret empty/malformed.
      if (sessionGone(histRes.body)) {
        return lastAssistantText;
      }
    }
    // Errors are silently retried until the deadline.

    await sleep(POLL_MS);
  }
  return lastAssistantText; // timeout path; run.mjs reports the error
}

/**
 * sessions_history return shape varies across OpenClaw versions:
 *   2026.3.28+: { ok, result: { content: [...], details: { messages|items|history } } }
 *   legacy:     { ok, result: { messages|items|history } }
 * We pick the latest assistant message's concatenated text.
 */
function extractAssistantText(resultPayload) {
  if (!resultPayload || typeof resultPayload !== "object") return "";
  const details = resultPayload.details || {};
  const candidates = [
    details.messages,
    details.items,
    details.history,
    resultPayload.messages,
    resultPayload.items,
    resultPayload.history,
    resultPayload.result?.messages,
    resultPayload.result?.items,
    resultPayload.result?.history,
  ].filter(Array.isArray);
  if (!candidates.length) return "";

  const rows = candidates[0];
  // Walk newest-first, return first assistant text.
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row || row.role !== "assistant") continue;
    const text = rowText(row);
    if (text) return text;
  }
  return "";
}

function rowText(row) {
  if (typeof row.text === "string") return row.text;
  if (typeof row.content === "string") return row.content;
  if (Array.isArray(row.content)) {
    return row.content
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("");
  }
  return "";
}

function sessionGone(body) {
  if (!body) return false;
  // Heuristic — gateway surfaces "session not found" / "unknown sessionKey"
  // in tool error payloads after cleanup:"delete" archives the row.
  return /session (?:not found|unknown|archived)/i.test(body);
}

// ---- local mode (experimental fallback) ---------------------------------

async function spawnLocal(ctx) {
  const state = ctx._runtimeState;
  const seedText = buildSeedText(ctx, { announceSkip: false });

  const args = [
    "agent",
    "--local",
    "--agent", state.agentId,
    "--message", seedText,
    "--json",
    "--timeout", String(ctx.timeoutSec),
  ];

  const child = spawn("openclaw", args, {
    env: localChildEnv(ctx),
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;
  state.stdoutBuf = "";
  state.stderrBuf = "";
  state.exited = new Promise((resolveFn, reject) => {
    child.on("exit", (code, signal) => resolveFn({ code, signal }));
    child.on("error", reject);
  });

  child.stdout.on("data", d => {
    const s = d.toString();
    state.stdoutBuf += s;
    ctx.logSink.pushStdout(s);
  });
  child.stderr.on("data", d => {
    const s = d.toString();
    state.stderrBuf += s;
    ctx.logSink.pushStderr(s);
  });
}

async function awaitLocal(ctx) {
  const state = ctx._runtimeState;
  const timeoutMs = (ctx.timeoutSec + 30) * 1000;
  const timedOut = { timedOut: true };
  const timeout = new Promise(resolveFn => setTimeout(() => resolveFn(timedOut), timeoutMs));
  const winner = await Promise.race([state.exited, timeout]);

  if (winner === timedOut && state.child.exitCode === null && !state.child.killed) {
    try { state.child.kill("SIGTERM"); } catch {}
    await sleep(500);
  }

  return extractLocalReplyText(state.stdoutBuf);
}

/**
 * `openclaw agent --local --json` writes a single JSON object on stdout.
 * Shape has a top-level `reply` whose `content[]` is Anthropic-style
 * text blocks, plus a `result.payloads[]` fallback on older builds.
 */
function extractLocalReplyText(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) return "";
  try {
    const obj = JSON.parse(trimmed);
    // Newer shape.
    if (Array.isArray(obj?.reply?.content)) {
      const t = obj.reply.content
        .filter(b => b && b.type === "text" && typeof b.text === "string")
        .map(b => b.text)
        .join("");
      if (t) return t;
    }
    if (typeof obj?.reply?.text === "string") return obj.reply.text;
    // Older shape.
    const payloads = obj?.result?.payloads ?? obj?.payloads ?? [];
    if (Array.isArray(payloads) && payloads.length) {
      const t = payloads
        .map(p => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("");
      if (t) return t;
    }
    if (typeof obj?.result?.text === "string") return obj.result.text;
    if (typeof obj?.summary === "string") return obj.summary;
    return trimmed;
  } catch {
    return trimmed;
  }
}

// ---- shared -------------------------------------------------------------

function buildSeedText(ctx, { announceSkip }) {
  const lines = [
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
  ];
  if (announceSkip) {
    lines.push(
      "",
      "After you emit the <<RESULT>> line, reply with the single token ANNOUNCE_SKIP if you are asked to summarize for the requester — Repliclaw reads the <<RESULT>> directly and does not need a natural-language recap."
    );
  }
  return lines.join("\n");
}

/**
 * Env handed to spawned CLI processes in local mode. Gateway mode does not
 * need this — the gateway is already running in its own env.
 */
function localChildEnv(ctx) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || "C.UTF-8",
    ...(process.env.OPENCLAW_PROFILE ? { OPENCLAW_PROFILE: process.env.OPENCLAW_PROFILE } : {}),
    ...(ctx.scopedEnv || {}),
    REPLICLAW_RUN_ID: ctx.runId,
    REPLICLAW_TASK: ctx.taskName,
  };
}

/**
 * Run `openclaw gateway call <method> --params <json>` and capture stdout.
 * The CLI returns JSON for RPC replies; errors still go to stderr + exit != 0.
 *
 * Only used for the narrow set of methods the CLI dispatcher actually routes:
 * health, status, system-presence, cron.*, sessions.* (sessions.list etc.).
 * Tool invocation does NOT go through here — see invokeTool() below.
 */
async function callGateway(method, params, opts = {}) {
  const args = ["gateway", "call", method, "--params", JSON.stringify(params || {}), "--json"];
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || "C.UTF-8",
    ...(process.env.OPENCLAW_PROFILE ? { OPENCLAW_PROFILE: process.env.OPENCLAW_PROFILE } : {}),
    ...(process.env.OPENCLAW_GATEWAY_TOKEN ? { OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN } : {}),
    ...(process.env.OPENCLAW_GATEWAY_PASSWORD ? { OPENCLAW_GATEWAY_PASSWORD: process.env.OPENCLAW_GATEWAY_PASSWORD } : {}),
  };
  return runCaptured("openclaw", args, { env, timeoutMs: opts.timeoutMs ?? 10_000 });
}

/**
 * POST /tools/invoke on the local gateway HTTP API.
 *
 * Returns a normalized shape:
 *   { ok: true,  result: <tool payload>, body: <raw body> }          on 200 + {ok:true}
 *   { ok: false, reason, hint, body, status }                         on any error
 *
 * `opts.sessionKey` is forwarded to the tool when present — many tools
 * (sessions_spawn, sessions_history, subagents) require a calling session
 * context so the gateway can resolve parent agent policy and allowlists.
 */
async function invokeTool(tool, args, opts = {}) {
  const host = process.env.OPENCLAW_GATEWAY_HOST || "127.0.0.1";
  const port = process.env.OPENCLAW_GATEWAY_PORT || "18789";
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    return {
      ok: false,
      reason: "OPENCLAW_GATEWAY_TOKEN not set",
      hint: "export the gateway bearer token; see preflight error for details",
      body: "",
      status: 0,
    };
  }

  const url = `http://${host}:${port}/tools/invoke`;
  const payload = { tool, args: args || {} };
  if (opts.sessionKey) payload.sessionKey = opts.sessionKey;

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}

    // Gateway shape: { ok: true, result: ... }  OR  { ok: false, error: { type, message } }
    if (res.ok && parsed && parsed.ok === true) {
      return { ok: true, result: parsed.result ?? parsed, body, status: res.status };
    }
    const errType = parsed?.error?.type || "unknown";
    const errMsg = parsed?.error?.message || body.slice(0, 200) || `HTTP ${res.status}`;
    let hint = null;
    if (errType === "not_found" && /sessions_spawn/.test(errMsg)) {
      hint =
        "sessions_spawn is in the gateway's default HTTP deny-list. " +
        "Add `gateway.tools.allow: [\"sessions_spawn\"]` to openclaw.json and restart the gateway.";
    } else if (res.status === 401 || res.status === 403) {
      hint = "bearer token rejected; verify OPENCLAW_GATEWAY_TOKEN";
    }
    return {
      ok: false,
      reason: `${errType}: ${errMsg}`,
      hint,
      body,
      status: res.status,
    };
  } catch (e) {
    return {
      ok: false,
      reason: e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : e.message,
      body: "",
      status: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Legacy helper kept only for any ad-hoc CLI JSON the adapter may still parse.
 * HTTP responses use the normalized shape from invokeTool() directly.
 */
function pluckToolResult(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === "object") {
      if (obj.result && typeof obj.result === "object") return obj.result;
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- process helpers ----------------------------------------------------

function runQuick(cmd, args, timeoutMs) {
  return new Promise(resolveFn => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolveFn(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return finish({ ok: false, reason: e.message });
    }
    const t = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ ok: false, reason: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", e => { clearTimeout(t); finish({ ok: false, reason: e.message }); });
    child.on("exit", code => {
      clearTimeout(t);
      finish({ ok: code === 0, reason: code === 0 ? null : `exit ${code}` });
    });
  });
}

function runCaptured(cmd, args, opts = {}) {
  return new Promise(resolveFn => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolveFn(v); } };
    let out = "", err = "";
    let child;
    try {
      child = spawn(cmd, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return finish({ ok: false, reason: e.message, stdout: "", stderr: "" });
    }
    child.stdout.on("data", d => out += d.toString());
    child.stderr.on("data", d => err += d.toString());
    const t = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish({ ok: false, reason: `timed out after ${opts.timeoutMs}ms`, stdout: out, stderr: err });
    }, opts.timeoutMs ?? 15_000);
    child.on("error", e => { clearTimeout(t); finish({ ok: false, reason: e.message, stdout: out, stderr: err }); });
    child.on("exit", code => {
      clearTimeout(t);
      finish({ ok: code === 0, reason: code === 0 ? null : `exit ${code}`, stdout: out, stderr: err });
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
