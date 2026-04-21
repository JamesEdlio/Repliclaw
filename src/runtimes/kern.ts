import { spawn, ChildProcess } from "child_process";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { cp } from "fs/promises";
import { join, resolve } from "path";
import type { AgentEntry } from "../registry.js";
import { runStore } from "../runs.js";

const RESULT_MARKER = /<<RESULT>>(.+)/;

interface SpawnOpts {
  runId: string;
  agent: AgentEntry;
  skill: string;
  inputs: unknown;
  workspaceDir: string;
  timeoutSec: number;
}

/**
 * Spawn a kern replica:
 *   1. Materialize workspace (git clone or local copy)
 *   2. Copy scoped .env into it (creds)
 *   3. Start `kern-ai run --init-if-needed <workspace>`
 *   4. Wait for port to appear in .kern/config.json
 *   5. POST seed message to /message
 *   6. Listen on /events SSE for <<RESULT>> marker in assistant text
 *   7. SIGTERM on result / timeout
 */
export async function spawnKernReplica(opts: SpawnOpts): Promise<void> {
  const { runId, agent, skill, inputs, workspaceDir, timeoutSec } = opts;

  runStore.update(runId, { status: "spawning", workspaceDir });

  // --- 1. Materialize workspace
  await materializeWorkspace(agent, workspaceDir);

  // --- 2. Load creds from envFile into child env (not written to disk —
  // kern's scaffoldAgent overwrites .env during init, so disk creds would
  // be wiped. Inject via child process env instead.)
  const credsEnv = agent.envFile && existsSync(agent.envFile)
    ? parseEnvFile(agent.envFile)
    : {};

  // --- 3. Spawn kern-ai
  // Strip parent's KERN_AUTH_TOKEN so child generates its own.
  const { KERN_AUTH_TOKEN: _strip, ...parentEnv } = process.env;
  const env = {
    ...parentEnv,
    ...credsEnv,
    KERN_NAME: `replica-${runId}`,
    KERN_PROVIDER: agent.provider,
    KERN_MODEL: agent.model,
  };

  const child = spawn(
    "kern-ai",
    ["run", "--init-if-needed", workspaceDir],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    }
  );

  runStore.update(runId, { status: "running", pid: child.pid });

  // Capture stdout/stderr as transcript (runtime-level, not conversation)
  child.stdout.on("data", (d) => {
    const text = d.toString();
    runStore.appendTranscript(runId, `[stdout] ${text.trim()}`);
  });
  child.stderr.on("data", (d) => {
    const text = d.toString();
    runStore.appendTranscript(runId, `[stderr] ${text.trim()}`);
  });

  // --- 4. Wait for port
  const port = await waitForPort(workspaceDir, 30_000);

  if (!port) {
    child.kill("SIGTERM");
    runStore.update(runId, {
      status: "error",
      error: "replica failed to open port within 30s",
      endedAt: new Date().toISOString(),
    });
    return;
  }

  // Token is appended to .env AFTER port opens (by startApp). Give it a beat
  // and re-read.
  await new Promise((r) => setTimeout(r, 300));
  const token = readAuthToken(workspaceDir);

  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  // --- 5. POST seed message
  const seedText = buildSeedPrompt(skill, inputs);
  await fetch(`${baseUrl}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      text: seedText,
      userId: "repliclaw",
      interface: "web",
      channel: "web",
    }),
  });

  // --- 6. Listen on SSE for result marker
  const deadline = Date.now() + timeoutSec * 1000;
  let result: unknown = null;
  let errorReason: string | null = null;

  // Debug: capture raw SSE stream
  const sseLogPath = join(workspaceDir, "sse.log");
  const { appendFileSync } = await import("fs");

  // Accumulator for streaming assistant text. Deltas arrive piecewise; we
  // concatenate them into `assistantText` and scan for a COMPLETE result line
  // (marker + JSON + newline or end-of-turn).
  let assistantText = "";

  try {
    const resp = await fetch(`${baseUrl}/events`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    if (!resp.body) throw new Error("no SSE body");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (Date.now() < deadline && !result && !errorReason) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      try { appendFileSync(sseLogPath, chunk); } catch {}

      // Split on SSE event boundaries (blank line)
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const raw of events) {
        const dataLines = raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        const data = dataLines.join("\n");
        try {
          const ev = JSON.parse(data);

          // Check for end-of-turn events, which signal we should try to
          // extract the result from accumulated text.
          const type = ev?.type;
          const isEndOfTurn =
            type === "message" ||
            type === "turn_end" ||
            type === "assistant_message" ||
            type === "done";

          const text = extractTextFromEvent(ev);
          if (text) assistantText += text;

          // Try to extract result either at end-of-turn or when we see
          // a complete marker line with balanced JSON.
          if (isEndOfTurn || assistantText.includes("<<RESULT>>")) {
            const extracted = tryExtractResult(assistantText);
            if (extracted.kind === "ok") {
              result = extracted.value;
              break;
            } else if (extracted.kind === "malformed" && isEndOfTurn) {
              errorReason = `malformed result JSON: ${extracted.raw}`;
              break;
            }
            // kind === "incomplete" → keep streaming
          }
        } catch {
          // non-JSON SSE line, skip
        }
      }
    }
  } catch (err: any) {
    errorReason = `SSE error: ${err?.message || err}`;
  }

  // --- 7. Terminate
  try {
    child.kill("SIGTERM");
  } catch {}
  // give it a moment to clean up
  await new Promise((r) => setTimeout(r, 500));
  try {
    if (!child.killed) child.kill("SIGKILL");
  } catch {}

  if (result) {
    runStore.update(runId, {
      status: "completed",
      result,
      endedAt: new Date().toISOString(),
    });
  } else if (errorReason) {
    runStore.update(runId, {
      status: "error",
      error: errorReason,
      endedAt: new Date().toISOString(),
    });
  } else {
    runStore.update(runId, {
      status: "timeout",
      error: `no result within ${timeoutSec}s`,
      endedAt: new Date().toISOString(),
    });
  }
}

async function materializeWorkspace(
  agent: AgentEntry,
  dest: string
): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const tmpl = agent.workspaceTemplate;
  if (tmpl.type === "local") {
    const src = resolve(tmpl.path);
    await cp(src, dest, { recursive: true });
  } else if (tmpl.type === "git") {
    const { execSync } = await import("child_process");
    const args = ["clone", "--depth", "1"];
    if (tmpl.branch) args.push("--branch", tmpl.branch);
    args.push(tmpl.url, dest);
    execSync(`git ${args.map(shellQuote).join(" ")}`, { stdio: "pipe" });
  }
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function waitForPort(
  workspaceDir: string,
  timeoutMs: number
): Promise<number | null> {
  const start = Date.now();
  const cfgPath = join(workspaceDir, ".kern", "config.json");
  while (Date.now() - start < timeoutMs) {
    try {
      if (existsSync(cfgPath)) {
        const raw = readFileSync(cfgPath, "utf-8");
        const cfg = JSON.parse(raw);
        if (cfg.port) {
          // Port is reserved — now check it's actually listening
          if (await probePort(cfg.port)) return cfg.port;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function probePort(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(500),
    });
    return resp.status === 200 || resp.status === 401;
  } catch {
    return false;
  }
}

function readAuthToken(workspaceDir: string): string | null {
  const envPath = join(workspaceDir, ".kern", ".env");
  if (!existsSync(envPath)) return null;
  const raw = readFileSync(envPath, "utf-8");
  const m = raw.match(/^KERN_AUTH_TOKEN=(.+)$/m);
  return m ? m[1].trim() : null;
}

function parseEnvFile(path: string): Record<string, string> {
  const raw = readFileSync(path, "utf-8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function buildSeedPrompt(skill: string, inputs: unknown): string {
  return [
    `[task]`,
    `Run skill: ${skill}`,
    `Inputs: ${JSON.stringify(inputs)}`,
    ``,
    `When complete, output exactly one line starting with <<RESULT>> followed by JSON, then stop. Do not await further input. Do not add commentary after the result marker.`,
  ].join("\n");
}

function extractTextFromEvent(ev: any): string | null {
  // kern SSE events come in a few shapes. We care about assistant text output.
  // Common shapes observed: { type: "text", text: "..." }, { type: "message", content: [...] }
  if (!ev || typeof ev !== "object") return null;
  if (typeof ev.text === "string") return ev.text;
  if (typeof ev.delta === "string") return ev.delta;
  if (Array.isArray(ev.content)) {
    return ev.content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");
  }
  return null;
}

type ExtractResult =
  | { kind: "ok"; value: unknown }
  | { kind: "incomplete" }
  | { kind: "malformed"; raw: string };

/**
 * Scan accumulated assistant text for `<<RESULT>>{json}` where {json} is a
 * complete, balanced JSON object or array. Returns `incomplete` if the
 * marker is present but the JSON isn't fully streamed yet.
 */
function tryExtractResult(text: string): ExtractResult {
  const idx = text.lastIndexOf("<<RESULT>>");
  if (idx === -1) return { kind: "incomplete" };
  const tail = text.slice(idx + "<<RESULT>>".length).trimStart();
  if (tail.length === 0) return { kind: "incomplete" };

  const first = tail[0];
  if (first !== "{" && first !== "[") {
    return { kind: "malformed", raw: tail.slice(0, 200) };
  }

  // Scan for balanced braces, respecting string literals and escapes.
  const open = first;
  const close = first === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const jsonStr = tail.slice(0, i + 1);
        try {
          return { kind: "ok", value: JSON.parse(jsonStr) };
        } catch {
          return { kind: "malformed", raw: jsonStr.slice(0, 200) };
        }
      }
    }
  }
  return { kind: "incomplete" };
}
