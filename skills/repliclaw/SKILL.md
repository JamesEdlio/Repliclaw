---
name: repliclaw
version: 0.2.0
description: Spawn a disposable replica of yourself to run a single task skill to completion, then terminate. Returns the replica's result and audit log. Use when a task needs isolated execution (scoped creds, clean context, long-running), or when running multiple similar tasks in parallel.
requires: []
inputs:
  task:
    type: string
    required: true
    description: Name of the task skill the replica should run (must be discoverable on disk, e.g. "app-sftp-case", "hello").
  inputs:
    type: object
    required: true
    description: Input payload passed to the task skill. Shape is defined by the task skill's own frontmatter.
  auditDir:
    type: string
    required: false
    description: Directory where the replica should write its audit log. Defaults to ~/.repliclaw/audit/.
  timeoutSec:
    type: number
    required: false
    description: Max seconds the replica may run before being killed. Default 600.
outputs:
  runId:
    type: string
    description: Unique ID for this run, matches the audit log filename.
  status:
    type: string
    description: "ok | error | timeout"
  result:
    type: object
    description: Whatever the task skill emitted via <<RESULT>>.
  auditPath:
    type: string
    description: Path to the written audit log.
---

# repliclaw

Repliclaw clones the agent you are right now into a disposable replica, hands it a single task, waits for it to finish, captures the audit log, and terminates the replica.

**Mental model:** this skill is you, teaching yourself how to fork. The replica is a fresh instance of your runtime (kern today, others later) with a clean workspace, a scoped subset of your credentials, an ephemeral identity ("you are a replica"), and exactly one task to do. When it emits a result, it dies.

Use this when:
- A task needs isolation — either because the creds shouldn't touch your main context, or because the replica's context would pollute yours.
- You want to run multiple tasks in parallel.
- A task is long-running and would block your conversation.
- You want a clean audit trail, separable from your own notes.

Do **not** use this for trivial operations you can do inline. The replica boot costs ~3–5 seconds and one model turn of setup. For one-liners, just do the thing.

## Prerequisites

- `node` ≥ 20 on PATH (the helper script is Node).
- The runtime you're running on is supported. Today: **kern** (`kern-ai` v0.30+). OpenClaw support planned.
- The task skill you're invoking must be locatable on disk — either:
  - Inside your own skills catalog (`skills/<task>/SKILL.md` or `.agents/skills/<task>/SKILL.md`), **or**
  - Inside this repo's `tasks/<task>/`.
  The skill lookup walks these in order.

## What the replica gets

A fresh workspace under `~/.repliclaw/runs/<runId>/workspace/` containing:

- `AGENTS.md` — replica protocol: "you are ephemeral, run the skill, emit `<<RESULT>>`, stop."
- `IDENTITY.md` — "You are a replica of {parent} running task {task}."
- `skills/<task>/` — the task skill's directory, copied in.
- `.kern/.env` — scoped credentials only (see below).
- `.kern/config.json` — minimal config: same model + provider as parent, no interfaces beyond `web` (for programmatic control).

The replica's first user message is the seed prompt:

```
[task]
Run skill: <task-name>
Inputs: <inputs-json>
Run ID: <runId>

Your skill file is at skills/<task-name>/SKILL.md. Read it carefully and follow it exactly.

When complete, emit exactly one line of the form:
  <<RESULT>>{...envelope...}
where the envelope conforms to the standard Repliclaw envelope schema. Then stop.
```

## The result envelope (two-layer contract)

Every task returns a standard envelope validated against [`schemas/envelope.schema.json`](./schemas/envelope.schema.json). The envelope's `data` field is task-owned and validated against the task's `outputs_schema` if one is declared.

```json
{
  "status":        "ok | error | partial | timeout | declined | needs-input",
  "taskName":      "<from SKILL.md>",
  "taskVersion":   "<from SKILL.md>",
  "runId":         "<same runId the parent passed in>",
  "startedAt":     "ISO-8601",
  "finishedAt":    "ISO-8601",
  "inputs":        { "...": "echoed" },
  "actions":       [ { "type": "jira.comment.create", "ref": "SS-1", "ts": "...", "details": { "body": "..." } } ],
  "notes":         [ { "type": "flag", "message": "...", "severity": "info" } ],
  "errors":        [ { "code": "x.y.z", "message": "...", "retryable": false, "at": "..." } ],
  "data":          { /* task-shaped */ }
}
```

Validation happens in the parent after the replica exits. A malformed envelope becomes `status: error` in the audit, with structured `validationErrors`. Tasks are strongly encouraged to ship a helper that uses [`lib/result.mjs`](./lib/result.mjs) so they can't emit an invalid envelope by accident.

Canonical action type vocabulary: see [`docs/ACTION-TYPES.md`](../../docs/ACTION-TYPES.md).

## Credential scoping

**This is the security boundary. Read it carefully.**

The replica **never** receives:
- Slack, Telegram, Matrix, or any other interface tokens. The replica has no way to message humans.
- Secrets unrelated to the declared `requires:` of the task skill.
- Your parent `KERN_AUTH_TOKEN` (the replica generates its own).

The replica **does** receive:
- Every env var named in the task skill's `requires:` list, if present in the parent's env.
- Neutral runtime settings (`PATH`, `HOME`, `LANG`, model keys explicitly marked shareable).

The cred-scoping logic lives in `lib/scope-creds.mjs` and is the single enforcement point. If a task skill forgets to declare a requirement, the replica will fail — by design.

## Audit logs

When the replica emits `<<RESULT>>`, the spawn helper validates the envelope, then writes an audit record to `{auditDir}/<runId>.json`:

```json
{
  "runId": "2026-04-22T18-40-00_abc123",
  "task": "app-sftp-case",
  "inputs": { "...": "..." },
  "startedAt": "2026-04-22T18:40:00Z",
  "endedAt":   "2026-04-22T18:40:42Z",
  "durationMs": 42101,
  "status": "ok",
  "result": { "...the validated envelope..." },
  "validationErrors": null,
  "replicaWorkspace": "/home/.../runs/.../workspace",
  "stdoutTail": "last 4k of replica stdout",
  "stderrTail": "last 4k of replica stderr",
  "scopedEnvKeys": ["JIRA_EMAIL", "JIRA_API_TOKEN", "FILEMAGE_API_KEY"],
  "strippedPrefixes": ["SLACK_", "TELEGRAM_", "MATRIX_", "DISCORD_"]
}
```

If envelope validation fails, `status` is `error`, `validationErrors` contains the schema errors, and `result.raw` contains whatever the replica emitted so you can debug.

Parent is responsible for moving these to durable storage (a git repo, S3, wherever). Repliclaw doesn't commit anything on your behalf.

## How to invoke (from your agent)

You run the helper directly — it's the entire skill:

```bash
node ~/path/to/repliclaw/skills/repliclaw/lib/run.mjs \
  --task <task-name> \
  --inputs '<json>' \
  [--audit-dir <path>] \
  [--timeout 600]
```

It prints a JSON line on stdout:

```json
{"runId":"...","status":"ok","result":{...},"auditPath":"..."}
```

Non-zero exit means the run itself failed to set up (not the task — task failures come back as `status: "error"` with exit 0).

## Steps (as you, the invoking agent, should execute this skill)

1. Verify the task skill exists. Walk: `./skills/<task>/SKILL.md`, `./.agents/skills/<task>/SKILL.md`, `<repliclaw-root>/tasks/<task>/SKILL.md`. If none found, stop and report.
2. Prepare inputs JSON. Validate against the task skill's frontmatter `inputs:` schema if you can.
3. Invoke the helper via your shell tool. Capture stdout.
4. On success, parse the JSON, read the audit log, present the result to the operator. Commit or forward the audit as appropriate.
5. On error/timeout, surface the reason, the stdout/stderr tails from the audit record, and ask the operator how to proceed.

## Known constraints (v0)

- kern runtime only. OpenClaw spawn adapter is stubbed but not implemented.
- Serial only — one replica at a time per host by default, because replicas bind `.kern/config.json` ports in a shared namespace. Parallel support requires port-pool management (planned).
- Replica shares the parent's model provider. No per-run model override yet.
- No cross-host spawn. Replicas are always on the same machine as the parent.
- Replica cannot spawn further replicas. Intentional — prevents runaway trees.

## Known gotchas (observed during development)

1. **kern scaffold overwrites `.env` on init.** Creds injected via disk file get wiped. Solution: pass creds as child-process env, not on disk.
2. **Parent `KERN_AUTH_TOKEN` inherits into child and blocks child token generation.** Solution: strip it before spawn.
3. **Result marker may stream across SSE chunks.** Solution: accumulate assistant text, scan for balanced-brace JSON after the marker. Never naive-regex it.
4. **Interface plugins activate if their tokens are present in env.** This is how replicas would start posting in your Slack. Solution: the cred-scoping step *must* strip every `SLACK_*`, `TELEGRAM_*`, `MATRIX_*`, etc., before spawn. No exceptions.

## Authoring your own task skills

See [`docs/AUTHORING.md`](../../docs/AUTHORING.md) in this repo. TL;DR: create `tasks/<name>/SKILL.md` with frontmatter declaring `requires:`, `inputs:`, `outputs:`. The skill body is the playbook the replica reads. The replica has the same tool catalog as the parent — so anything you could do inline, the replica can do in isolation.
