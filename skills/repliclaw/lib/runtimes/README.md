# Runtimes

A **runtime** is a target agent platform (kern, openclaw, etc.) that Repliclaw can spawn a disposable replica inside. Each runtime implements the same small interface so `run.mjs` can stay runtime-agnostic.

## Interface

A runtime module exports a default object with four methods:

```js
export default {
  id: "kern",                 // short name, matches task frontmatter `runtimes:` entries
  preflight(ctx),             // verify prereqs (binary installed, gateway up, etc.). Throw to abort.
  async prepare(ctx),         // materialize workspace / register session / copy task skill in
  async spawnAndSeed(ctx),    // start replica, inject seed message, return control object
  async awaitResult(ctx),     // block until <<RESULT>> or timeout, return raw assistant text
  async cleanup(ctx),         // terminate replica, delete workspace (unless keepWorkspace)
}
```

### Shared `ctx` object

```
{
  runId,              // string, unique per run
  taskName,           // string, task skill name
  taskSkillDir,       // absolute path to the task skill source dir
  taskSkillMeta,      // parsed frontmatter object
  inputsObj,          // parsed JSON inputs
  scopedEnv,          // credential-scoped env to pass to replica
  timeoutSec,         // integer, upper bound for awaitResult
  runDir,             // host-side scratch dir for this run (runtime-local artifacts)
  keepWorkspace,      // boolean — if true, don't delete on cleanup
  logSink,            // { stdoutTail(): string, stderrTail(): string } for audit
}
```

Runtimes may stash runtime-specific state on `ctx._runtimeState` between calls — it's passed by reference through the four phases.

## Contract guarantees

- `spawnAndSeed` must have fully established the replica before returning. The only thing `awaitResult` does is wait for output.
- `awaitResult` returns a plain string (the assistant's final turn, concatenated). `run.mjs` does envelope extraction + validation — runtimes don't touch that.
- `cleanup` is always called, even on preflight/prepare failure, even on timeout. It must be idempotent.
- Any runtime-side failure should throw an `Error` with a diagnostic message; `run.mjs` catches and records it in the audit log.

## Current runtimes

- **[kern.mjs](./kern.mjs)** — spawns `kern-ai run <workspace>` as a child process per run. Waits for `.kern/config.json` port file, POSTs seed message, streams SSE events from `/events`. SIGTERM on cleanup. This is the reference implementation.

- **[openclaw.mjs](./openclaw.mjs)** — two modes. **Gateway** (default): spawns a sub-agent session via `sessions_spawn` on an existing gateway agent. Health check goes through `openclaw gateway call health` (CLI RPC); tool invocations (`sessions_spawn`, `sessions_history`, `subagents`) go through `POST http://127.0.0.1:18789/tools/invoke` with `Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN` — the CLI dispatcher does not expose `tools.invoke`. Poll `sessions_history` for the child's final assistant message; `cleanup: "delete"` at spawn time auto-archives the session. Requires `openclawAgent:` set in task frontmatter (or `OPENCLAW_AGENT_ID` env), `OPENCLAW_GATEWAY_TOKEN` in env, and `sessions_spawn` added to the gateway's HTTP allowlist (`gateway.tools.allow`) since it's hard-denied by default. **Local** (opt-in via `openclawMode: local` in task frontmatter): creates a scratch openclaw agent per run via `openclaw agents add --workspace <runDir> --non-interactive`, runs `openclaw agent --local --agent <scratch-id> --message <seed> --json`, then `openclaw agents delete <scratch-id> --force` on cleanup. No gateway needed but no sandbox either — fallback use only. **Status: experimental** — gateway path verified against a live gateway by Diana (openclaw fleet agent); local path still unverified end-to-end.

## Adding a new runtime

1. Create `skills/repliclaw/lib/runtimes/<name>.mjs` implementing the interface.
2. Register it in `skills/repliclaw/lib/runtimes/index.mjs`.
3. Document it in this README and add a matching section to `docs/RUNTIMES.md`.
4. Add at least one smoke test in `tests/runtimes-<name>.test.mjs` if the runtime can be driven headlessly.
