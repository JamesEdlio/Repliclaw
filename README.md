# Repliclaw

**Clone-thyself primitive for AI agents.**

Repliclaw is an open-source skill that teaches any agent how to spawn a disposable replica of itself, hand it a scoped task, wait for it to finish, capture the audit log, and terminate the clone.

No central orchestrator. No hosted service. Just a skill + a small helper your agent runs. The agent is its own orchestrator.

## Why

AI agents are stateful and conversational — great for long-lived operators, bad for running isolated tasks with bounded scope, scoped credentials, and clean audit trails.

Repliclaw gives you forks. You (the agent) run one task in a fresh replica — scoped creds, clean context, one-shot — and get back a structured result and audit log. When the task is done, the replica dies.

Use cases:
- **Task isolation** — run a sensitive action in a clone that can't accidentally leak into your main conversation.
- **Credential scoping** — the clone only sees the secrets its task declares it needs.
- **Parallel work** — fan out N replicas across M tasks without polluting your own context.
- **Auditability** — every replica writes a structured JSON log. Your parent agent commits them wherever you like (git repo, S3, Notion).

## How it works

1. Your agent has the **`repliclaw`** skill loaded (this repo, `skills/repliclaw/`).
2. Given a task, the agent calls the skill's helper (`skills/repliclaw/lib/run.mjs`) with a task name and inputs.
3. The helper:
   - Locates the task skill on disk.
   - Reads the task skill's `requires:` list.
   - Scopes the parent's env down to only those credentials (and strips every interface token unconditionally).
   - Materializes a fresh workspace.
   - Spawns a `kern-ai` replica with the scoped env.
   - Seeds the replica with `[task] Run skill: <name> / Inputs: {...}`.
   - Streams SSE, waits for `<<RESULT>>{json}`.
   - Kills the replica, writes a JSON audit log, returns the result.
4. Your agent reads the audit log and reports back to the operator.

## Layout

```
repliclaw/
├── skills/
│   └── repliclaw/
│       ├── SKILL.md                    ← the cloning primitive playbook
│       ├── lib/
│       │   ├── run.mjs                 ← the helper your agent invokes
│       │   ├── scope-creds.mjs         ← cred-scoping enforcement
│       │   ├── parse-result.mjs        ← streaming JSON extract + AJV validation
│       │   └── result.mjs              ← helper for task scripts (recordAction/Note/Error/emit)
│       ├── schemas/
│       │   └── envelope.schema.json    ← canonical result envelope
│       └── templates/
│           └── replica-workspace/      ← AGENTS.md + IDENTITY.md for replicas
├── tasks/                              ← example/reference task skills
│   └── hello/                          ← smoke test (rename/copy as the starting point for your own task)
└── docs/
    ├── AUTHORING.md                    ← how to write a task skill
    ├── ACTION-TYPES.md                 ← canonical action type vocabulary
    ├── CREDENTIALS.md                  ← cred-scoping contract
    └── AUDIT.md                        ← audit log schema
```

## Quick start

Requires Node 20+ and `kern-ai` v0.30+ on PATH.

```bash
git clone https://github.com/JamesEdlio/Repliclaw.git
cd Repliclaw

# Smoke test: spawn a replica that runs the hello task
export OPENROUTER_API_KEY=sk-...
export KERN_PROVIDER=openrouter
export KERN_MODEL=anthropic/claude-haiku-4-5

node skills/repliclaw/lib/run.mjs \
  --task hello \
  --inputs '{"name":"world"}' \
  --audit-dir /tmp/audit
```

Output:

```json
{"runId":"...","status":"ok","result":{"status":"ok","taskName":"hello","taskVersion":"0.2.0","runId":"...","startedAt":"...","finishedAt":"...","inputs":{"name":"world"},"actions":[],"notes":[],"errors":[],"data":{"greeting":"hello, world"}},"auditPath":"/tmp/audit/..."}
```

Total time: ~6s (replica boot is ~3s, model turn ~3s).

## The result envelope

Every task returns a validated two-layer envelope: a standard outer shell (status, taskName, taskVersion, runId, timing, actions, notes, errors) wrapping a task-owned `data` payload. The outer shell is enforced by Repliclaw against a JSON Schema; the `data` payload is validated against the task's own `outputs_schema` if declared.

```json
{
  "status": "ok | error | partial | timeout | declined | needs-input",
  "taskName": "my-task",
  "taskVersion": "0.1.0",
  "runId": "...",
  "startedAt": "...",
  "finishedAt": "...",
  "inputs":  { "...": "echoed" },
  "actions": [ { "type": "jira.comment.create", "ref": "SS-1234", "ts": "...", "details": { "body": "..." } } ],
  "notes":   [ { "type": "flag", "message": "second domain observed" } ],
  "errors":  [],
  "data":    { "...": "task-shaped" }
}
```

This means **every audit log across every task is queryable the same way.** "Show me every `gmail.message.send` from replicas in the last week" works across the whole fleet.

See [`docs/AUTHORING.md`](./docs/AUTHORING.md) for how to write a task and [`docs/ACTION-TYPES.md`](./docs/ACTION-TYPES.md) for the canonical action vocabulary.

## Using it from an agent

Add this repo's `skills/repliclaw/` to your agent's skill catalog (e.g. symlink into `.agents/skills/` or install via `npx skills install ...`). Activate the skill. Your agent can now call `node .../skills/repliclaw/lib/run.mjs ...` from any shell it has access to.

Any task skill in this repo's `tasks/` directory — or in your agent's own skill catalog — is callable as `--task <name>`.

## Writing a task skill

A task skill is a directory with a `SKILL.md` plus an optional `schema.json` that validates the `data` payload. See [`tasks/hello/`](./tasks/hello/) for the minimal template and [`docs/AUTHORING.md`](./docs/AUTHORING.md) for the full contract (envelope, helpers, action vocabulary, cred-scoping, testing loop).

## Status

v0.1 — working. Single-host, kern-only, serial spawns, no parallel support yet.

Tested end-to-end with kern v0.31.1 and Anthropic Haiku 4.5 on April 22, 2026.

## License

MIT.
