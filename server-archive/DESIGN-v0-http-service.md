# Design

## Goals

1. **One primitive, many runtimes.** Same API for spawning kern or openclaw replicas.
2. **Disposable by default.** Replicas are ephemeral. No persistent state, no memory writeback.
3. **Cred-safe.** Replicas get scoped creds, not the parent's full vault.
4. **Observable.** Every run produces a transcript that can be audited later.
5. **Lean.** v0 is one Node service. No queues, no DBs, no fancy scheduler.

## Non-goals (v0)

- Multi-tenant auth
- Cross-machine scheduling
- Live streaming of replica output to the caller
- Sub-agents spawning sub-agents
- Replica-to-replica communication

## Architecture

```
┌─────────┐   POST /spawn      ┌────────────┐
│ Parent  │ ──────────────────▶│ Repliclaw  │
│ Agent   │                    │   Server   │
└─────────┘◀── { runId } ──────└─────┬──────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │  Spawner                │
                        │  - mkdtemp workspace    │
                        │  - git clone template   │
                        │  - write scoped .env    │
                        │  - spawn runtime child  │
                        └─────────────┬───────────┘
                                      │
                                      ▼
                        ┌─────────────────────────┐
                        │  Replica (kern/openclaw)│
                        │  - loads skill          │
                        │  - runs task            │
                        │  - emits <<RESULT>>     │
                        │  - exits                │
                        └─────────────────────────┘
```

## Components

### Server (`src/server.ts`)
Hono HTTP server. Two endpoints:
- `POST /spawn` — accept a run request, return `runId` immediately, start spawning in background
- `GET /runs/:runId` — return run state, result, transcript

### Registry (`src/registry.ts`)
Static config file (`registry.json`) mapping parent agent IDs to their spawn parameters:
- `runtime`: "kern" | "openclaw"
- `workspaceTemplate`: git URL + branch (template workspace, stripped of memory/dashboards)
- `credsVault`: how to fetch creds (op:// URI or env ref)
- `model`: model to use for the replica
- `systemPromptOverrides`: optional prompt additions for replica context

### Spawner (`src/spawner.ts`)
Runtime-agnostic interface:
```ts
interface Spawner {
  spawn(ctx: SpawnContext): Promise<RunHandle>
}
```
Dispatches to the right runtime-specific implementation based on registry entry.

### Runtime adapters (`src/runtimes/`)
- `kern.ts`: spawns `npx kern-ai` with prepared workspace, pipes seed prompt via stdin, watches stdout for `<<RESULT>>` marker
- `openclaw.ts`: stub for v0

### Run store (`src/runs.ts`)
In-memory map of runId → run state for v0. Transcript captured to disk and to a git audit repo on completion.

## Data flow: a single run

1. Parent agent: `POST /spawn { parentAgent: "edith", skill: "app-sftp-case", inputs: { ticket: "SS-445" } }`
2. Server: validates parent exists in registry, generates `runId`, returns immediately
3. Spawner (async):
   - `mkdtemp` at `/tmp/repliclaw/<runId>/workspace`
   - `git clone --depth 1 --branch replica-template <template-url>` into workspace
   - Fetch creds from vault → write `.kern/.env`
   - Write seed prompt to `.kern/seed.md`:
     > Run skill `app-sftp-case` with inputs `{ticket: "SS-445"}`. When complete, emit a single line `<<RESULT>>{JSON}` and exit. Do not await further input.
   - Spawn runtime process with workspace as CWD
4. Runtime adapter:
   - Capture stdout/stderr to transcript buffer
   - Watch for `<<RESULT>>` marker line
   - On marker: parse JSON, mark run complete, send SIGTERM
   - On timeout: send SIGTERM, mark failed
   - On exit without marker: mark failed, record transcript
5. On completion:
   - Write transcript + result to `/tmp/repliclaw/runs/<runId>.json`
   - Push transcript to audit git repo
   - Destroy workspace dir (keep transcript)
6. Parent agent: `GET /runs/<runId>` → retrieves result

## Seed prompt pattern

The replica needs to know:
1. What skill to run
2. What inputs were given
3. That it's ephemeral and must emit a result marker and exit

v0 approach: write a file (`.kern/seed.md` or `.openclaw/task.md`) that the agent reads on boot, containing the skill name, inputs as JSON, and termination instructions. The runtime's default startup hook reads and acts on it.

Alternatively, pipe the prompt via stdin on boot. Needs runtime support — to be probed.

## Result marker

Replica emits a single final line:
```
<<RESULT>>{"status":"ok","data":{...}}
```

Repliclaw parses this line out of stdout. Everything before it is transcript. Everything after (if any) is ignored. Then SIGTERM.

v1: add a `complete(result)` tool to kern/openclaw that signals done more cleanly than a stdout marker. For v0, the marker is fine — all LLMs can reliably emit structured text.

## Cred handoff

v0: `.kern/.env` copied from a static `creds/<agent>.env` file on the Repliclaw host.

v1: 1Password service account fetch at spawn time using `op read`, scoped to a per-skill vault.

v2: short-lived tokens minted per run, revoked on termination.

## Workspace template

Parent agents are responsible for maintaining a `replica-template` branch in their workspace repo. This branch contains:
- `skills/` directory with all shareable skills
- `IDENTITY.md` minimal version (name, "you are a replica of X, run one task and exit")
- `.kern/config.json` baseline

It does NOT contain:
- `notes/` or any narrative memory
- `knowledge/` personal state files
- `dashboards/`
- `.kern/sessions/` or `.kern/recall.db`

Parent agents can rebase this branch periodically as skills evolve.

## Failure modes

| Failure | Handling |
|---|---|
| Workspace clone fails | Mark run failed with `clone_error`, transcript = git error output |
| Runtime fails to boot | Mark failed with `boot_error`, capture stderr |
| Timeout | SIGTERM, mark `timeout` |
| Replica errors out mid-task | Transcript captured, marked `replica_error` |
| Replica exits without emitting result | Marked `no_result`, transcript retained |
| Replica hangs waiting for input | Timeout catches it |

## Open questions

1. **Kern seed injection:** does `npx kern-ai` have a `--message` flag or equivalent? If not, do we need a small config-level hook that reads `.kern/seed.md` on boot and prompts itself?
2. **Openclaw runtime interface:** TBD — needs investigation.
3. **Transcript storage:** local disk + git repo is fine for v0. At scale we'd want object storage.
4. **Cred rotation:** when a replica's `.env` has a 1Password service token, that token is live for the whole run. Is scope granular enough via 1P vaults alone?
5. **Model-specific costs:** replicas inherit parent's model which might be expensive. v1 could downgrade to a cheaper model for straightforward skills.
6. **Concurrency limits:** v0 unlimited (each run is a process). Need per-machine and per-parent limits eventually.

## v0 deliverable

One Node service, ~300 lines TS, that:
- Runs locally or on Railway
- Exposes `/spawn` and `/runs/:id`
- Supports kern runtime only
- Ships with one sample parent agent config (Edith) and one sample skill (`hello-world`)
- `hello-world` skill just prints "hello from replica" and emits a result — proves the spawn/terminate loop works

Once this runs end-to-end, we port `app-sftp-case` as the second skill and have a real workload.
