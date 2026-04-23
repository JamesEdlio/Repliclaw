# Runtimes

Repliclaw abstracts over multiple agent runtimes. A task skill declares which runtimes it supports, and the caller picks one at spawn time with `--runtime`. Each runtime has its own model for how a "replica" comes into being, so this doc covers what you need to know per target.

## Supported runtimes

| id         | status       | default replica lifecycle                                                              | filesystem isolation                                                |
| ---------- | ------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `kern`     | stable       | one `kern-ai` child process per run                                                    | host scratch dir, seeded from template                              |
| `openclaw` | experimental | default: sub-agent session inside a running gateway. Fallback: `openclaw agent --local` | gateway sandbox per session (configurable) / scratch workspace (local) |

## Picking a runtime

Two gates decide whether a run happens:

1. **Task opt-in.** The task skill's frontmatter must list the runtime in its `runtimes:` array. Missing means the task was only validated against other runtimes; we refuse to run it there.
2. **`--runtime` flag** on `run.mjs`. Defaults to `kern`.

```bash
# explicit
node run.mjs --task ticket-triage --runtime openclaw --inputs '{...}'

# implicit (kern)
node run.mjs --task ticket-triage --inputs '{...}'
```

If you don't declare `runtimes:` at all, the task is treated as kern-only — safe default that matches the historical behavior.

## kern runtime

**Model:** one `kern-ai` child process per run. Repliclaw creates a fresh workspace under `~/.repliclaw/runs/<runId>/workspace/`, seeds it from the replica template, copies the task skill in, spawns `kern-ai run --init-if-needed <workspace>`, waits for the child to open a local HTTP port (via `.kern/config.json`), POSTs a seed message to `/message`, and streams SSE from `/events` until a `<<RESULT>>` marker appears or the timeout expires. SIGTERM on cleanup; workspace deleted unless `--keep-workspace`.

**Requirements:**

- `kern-ai` on `PATH`.
- An OpenRouter (or other supported LLM provider) API key in the environment. Model keys are always passed through the cred scoper.

**Isolation guarantees:**

- Fresh workspace per run, deleted after cleanup.
- Parent `KERN_AUTH_TOKEN` is stripped; replica mints its own.
- Credential scoping (`scope-creds.mjs`) drops all `SLACK_*`, `TELEGRAM_*`, `MATRIX_*`, etc. unless the task explicitly declares them in `requires:` — and interface tokens are hard-stripped regardless.

## openclaw runtime

OpenClaw's replica primitive is a **sub-agent session spawned inside a running gateway**. The gateway multiplexes many sessions inside one long-lived process; your "replica" is one such session, not a new OS process. Filesystem isolation comes from the target agent's per-session sandbox config, not from a workspace Repliclaw materialized.

There's also an experimental local mode that runs `openclaw agent --local` in a short-lived CLI process, kept as a fallback for environments without a gateway. Per OpenClaw docs, local mode is explicitly a fallback, not the production-blessed disposable-replica path — treat it that way.

### Gateway mode (default)

**Model:** Repliclaw talks to the gateway through the `openclaw` CLI — specifically `openclaw gateway call <method>` — which handles WS auth (v3 challenge-sign, token, or password) natively so this adapter doesn't have to speak WebSocket. Per run:

1. **Preflight** — verify CLI present, `gateway call health` succeeds, and an `openclawAgent` is declared.
2. **Spawn** — `gateway call tools.invoke` with `tool: "sessions_spawn"`, `args: { task, agentId, cleanup: "delete", runTimeoutSeconds, sandbox: "inherit" }`, `sessionKey: <parent>`. Returns `{ status: "accepted", runId, childSessionKey }` immediately — it's non-blocking.
3. **Poll** — `gateway call tools.invoke` with `tool: "sessions_history"`, `sessionKey: <parentKey>`, args pointing at the child session key. Polling cadence is ~1.5s. We look for an assistant message whose concatenated `content[type==="text"].text` contains the `<<RESULT>>` marker, then parse the envelope.
4. **Cleanup** — `cleanup: "delete"` at spawn time handles the normal exit. On timeout or thrown error, the adapter calls `tools.invoke subagents { action: "kill", target: <childKey> }` for a cascade stop.

**Why polling, not push?** OpenClaw's own guidance tells sub-agent orchestrators inside the gateway to rely on push announces and avoid polling. Repliclaw is an **external** orchestrator (we're outside the parent session), so we don't get the push. Polling is the practical path; keep the cadence modest and rely on `cleanup: "delete"` to bound the session's lifetime.

**Announce skip.** `sessions_spawn` runs an announce step after the child's main turn that re-posts the result to the parent session as an extra LLM turn (wasted tokens for us). The seed tells the child to reply with just the token `ANNOUNCE_SKIP` in that announce step so we don't pay for a recap we're not going to read.

**Requirements:**

- `openclaw` CLI on `PATH`.
- A running gateway the CLI can reach (`openclaw gateway call health` returns ok).
- Auth wired for the CLI: either `gateway.auth.mode="token"` with `OPENCLAW_GATEWAY_TOKEN` in env, `gateway.auth.mode="password"` with `OPENCLAW_GATEWAY_PASSWORD`, or `gateway.auth.mode="none"` on private ingress. Device-identity (v3 challenge-sign) also works if your CLI has a registered device keypair.
- `openclawAgent: <id>` set in SKILL.md frontmatter (or `OPENCLAW_AGENT_ID` env var). This is the existing gateway agent whose config (sandbox, env, tool allowlist) will govern the child session. Repliclaw does NOT create gateway agents on demand.
- That agent's `subagents.allowAgents` must permit spawning itself (or include `"*"`).

**Recommended target-agent config:**

```json
{
  "agents": {
    "defaults": {
      "subagents": {
        "maxConcurrent": 8,
        "maxChildrenPerAgent": 5,
        "runTimeoutSeconds": 900,
        "archiveAfterMinutes": 60
      },
      "sandbox": {
        "mode": "non-main",
        "scope": "session",
        "backend": "docker",
        "workspaceRoot": "~/.openclaw/sandboxes",
        "prune": { "idleHours": 24, "maxAgeDays": 7 }
      },
      "env": {
        "OPENROUTER_API_KEY": { "from": "env" }
      }
    },
    "your-task-runner-agent": {
      "tools": {
        "subagents": {
          "tools": {
            "deny": ["message", "sessions_send", "gateway", "cron"]
          }
        }
      }
    }
  }
}
```

- `sandbox.mode: "non-main"` + `scope: "session"` gives each sub-agent session its own Docker-backed sandbox workspace, which is what you want for real isolation.
- Denying `message` and `sessions_send` enforces Repliclaw's actions-through-parent pattern (see [`PATTERNS.md`](./PATTERNS.md) §1) — replicas can't DM Slack/Telegram on your behalf.

### Host-side vs gateway-side credential scoping (important)

Unlike kern (where Repliclaw materializes the workspace and controls env at spawn time), gateway-mode sessions run inside the gateway's policy envelope. The gateway forwards env from **its own** config, not from the Repliclaw CLI invocation's env.

1. **Host-side:** Repliclaw's cred scoper controls what the `openclaw gateway call` CLI process sees. Its only job is to submit the RPC, so this mostly doesn't matter.
2. **Gateway-side:** the target agent's `agents.<id>.env` / `agents.defaults.env` block decides what the replica can read.

If you need strong host-side control over what the replica can touch, use local mode or kern. Gateway mode is for fleets that want one shared policy envelope across many concurrent sessions.

### Local mode (experimental fallback)

**Model:** `openclaw agent --local` runs the runtime embedded in the CLI process itself. No gateway required. Repliclaw materializes a fresh workspace under `~/.repliclaw/runs/<runId>/workspace/` (seeded from the replica template + task skill copy), registers it as a scratch openclaw agent via `openclaw agents add`, invokes `openclaw agent --local --agent <scratch-id> --message <seed> --json`, parses the reply's `content[]`/`payloads[]`, and scans for `<<RESULT>>`. Cleanup deletes the scratch agent and workspace.

Use only when:

- You can't run a gateway (CI ephemeral hosts, one-off local dev, airgapped debugging).
- You're OK without sandbox isolation — `--local` does not run tools in a sandbox.

Opt in per-task:

```yaml
openclawMode: local
```

**Requirements:**

- `openclaw` CLI on `PATH`.
- An LLM provider API key in the environment.

**Status:** experimental, fallback-only. Gateway mode is the primary path.

## Declaring runtime support on a task

Add `runtimes:` to your skill frontmatter:

```yaml
---
name: my-task
version: 1.0.0
repliclawEnvelopeVersion: 0.2.0
runtimes:
  - kern
  - openclaw
# openclaw configuration (all optional):
# openclawMode: gateway          # "gateway" (default) or "local"
# openclawAgent: data-integrations  # required for gateway mode
# openclawParentSessionKey: agent:data-integrations:main  # defaults to agent:<id>:main
requires:
  - JIRA_API_TOKEN
  - OP_SERVICE_ACCOUNT_TOKEN
outputs_schema: ./schema.json
---
```

Only list a runtime here after you've actually run the task against it at least once. Declaring is a claim that the task works there.

## Adding a new runtime

See [`../skills/repliclaw/lib/runtimes/README.md`](../skills/repliclaw/lib/runtimes/README.md) for the adapter interface contract. Short version: five async methods (`preflight`, `prepare`, `spawnAndSeed`, `awaitResult`, `cleanup`) that share a `ctx` object. Register in `runtimes/index.mjs`, add tests in `tests/runtimes.test.mjs`, document here.
