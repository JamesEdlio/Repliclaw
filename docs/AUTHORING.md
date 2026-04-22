# Authoring a task skill

A Repliclaw task skill is a directory with a `SKILL.md` at its root. The `SKILL.md` is both documentation and executable playbook — the replica reads it and follows it.

## Minimum viable task skill

```
tasks/my-task/
├── SKILL.md
└── schema.json     # optional, validates the `data` payload
```

```markdown
---
name: my-task
version: 0.1.0
description: One sentence describing what this does.
repliclawEnvelopeVersion: 0.2.0
requires: []
inputs: {}
outputs: {}
outputs_schema: ./schema.json
# Optional forward-compat keys (see docs/PATTERNS.md):
supports_plan_mode: false       # honor `inputs.mode: "plan"` for dry-runs
outputs_files: []               # artifact globs copied back to parent on success
---

# my-task

Step-by-step instructions for the replica. End by emitting the Repliclaw
result envelope via `<<RESULT>>{...}`.
```

## The two-layer contract

Every task returns a **standard envelope** (enforced by Repliclaw) with a task-owned `data` payload inside it:

```json
{
  "status": "ok",
  "taskName": "my-task",
  "taskVersion": "0.1.0",
  "runId": "2026-04-22T19-00-48_7088c5",
  "startedAt": "2026-04-22T19:00:51Z",
  "finishedAt": "2026-04-22T19:00:52Z",
  "inputs": { ... },
  "actions": [
    { "type": "jira.comment.create", "ref": "SS-1234",
      "ts": "2026-04-22T19:00:52Z",
      "details": { "body": "..." } }
  ],
  "notes":  [ { "type": "flag", "message": "second domain observed" } ],
  "errors": [],
  "data":   { /* task-shaped */ }
}
```

The envelope is validated against [`envelope.schema.json`](../skills/repliclaw/schemas/envelope.schema.json). The `data` payload is validated against the task's own `outputs_schema` (if declared). Validation happens in the parent after the replica exits — a bad envelope is recorded as `status: error` with `validationErrors` in the audit log, and the run is returned to the caller as an error.

## Frontmatter contract

### `name` (string, required)

Must match the directory name. `^[a-z0-9][a-z0-9-]*$`.

### `version` (string, required)

Semver of the skill itself. Bump when the contract changes — orchestrators use this to reason about compatibility over time.

### `description` (string, required)

One sentence. Shown in skill catalogs so invoking agents know what this does.

### `requires` (array of strings, required)

Env var names (or prefixes ending in `_`) the replica needs to do its job.

```yaml
requires:
  - JIRA_EMAIL
  - JIRA_API_TOKEN
  - FILEMAGE_API_KEY
  - GOOGLE_       # prefix form — matches GOOGLE_CLIENT_ID, GOOGLE_REFRESH_TOKEN, etc.
```

Repliclaw strips every interface/runtime credential before spawning (Slack, Telegram, Matrix, Discord, kern auth tokens) and then injects only the keys listed here. A task can never accidentally inherit Slack or Telegram posting ability.

### `inputs`, `outputs` (object, required)

Human-readable shape description. Not currently enforced by Repliclaw itself — the `outputs_schema` file is what's enforced at runtime. Keep these in sync.

### `outputs_schema` (string, optional but recommended)

Relative path to a JSON Schema file that validates the `data` payload inside the envelope. Strongly recommended — without it you get envelope validation but no check on the task's own semantics.

## Writing the playbook body

The body of `SKILL.md` is the replica's instructions. Write it for a fresh agent with no context beyond what you hand it. Be explicit about:

1. **What inputs it will receive.** Repeat the input shape in the prose.
2. **What it should do, in order.** Numbered steps.
3. **How to classify outcomes.** Enumerate the statuses the task can return.
4. **What `data` fields to emit for each outcome.**
5. **Exactly how to terminate:** one line starting with `<<RESULT>>{...}`, nothing after it.

Short, declarative sentences. No "consider" or "you might want to" — the replica will.

## Emitting the envelope

Two patterns.

### Pattern A: LLM emits the envelope directly (playbook-only task)

For pure-reasoning tasks where the replica isn't running code. Include the full envelope template in the SKILL body and tell the model to fill it in and emit it. This is what `tasks/hello` does.

### Pattern B: Task ships a helper script (recommended for mutating tasks)

For tasks with real side-effects, ship a small helper (Node, Python, whatever) that the replica runs. Have the helper use `skills/repliclaw/lib/result.mjs` and call `recordAction()` / `recordNote()` / `recordError()` as it goes. At the end it calls `emit()` and the envelope is guaranteed valid.

```javascript
import { run } from "../../skills/repliclaw/lib/result.mjs";

await run({
  taskName: "my-task",
  taskVersion: "0.1.0",
  inputs,
  async work(ctx) {
    const record = await someApi.get(inputs.recordId);
    ctx.action("someapi.record.read", inputs.recordId);

    if (record.needsUpdate) {
      await someApi.update(record.id, { status: "processed" });
      ctx.action("someapi.record.update", record.id, {
        status: "processed"
      });
    }

    return { outcome: "processed", recordId: record.id };
  }
});
```

The helper auto-derives `status` from actions and errors:
- all actions succeeded, no errors → `ok`
- any errors + zero successful actions → `error`
- any errors + at least one successful action → `partial`
- override by returning `{ __status: "needs-input", ... }` from `work()`

## Action types

Every `actions[]` entry must use a canonical type string (`<service>.<resource>.<verb>`). See [`ACTION-TYPES.md`](./ACTION-TYPES.md) for the vocabulary. Add new types via PR — don't invent them silently in a task.

## Credentials

See [`CREDENTIALS.md`](./CREDENTIALS.md). The short version: declare exactly what you need in `requires`, nothing more. The replica can't reach anything you didn't list.

## Audit contract

See [`AUDIT.md`](./AUDIT.md). The parent writes a per-run audit file containing the envelope, validation result, scoped env keys (not values), replica workspace path, and stdout/stderr tails. Tasks don't write the audit themselves — they just emit a clean envelope.

## Testing your task

The cheapest loop:

```bash
node skills/repliclaw/lib/run.mjs \
  --task my-task \
  --inputs '{"ticketId":"SS-1234"}' \
  --keep-workspace
```

`--keep-workspace` leaves the replica's directory at `~/.repliclaw/runs/<runId>/workspace` so you can inspect what it saw. Drop the flag for normal runs.

## Editing an existing skill

Task skills are versioned, schema-validated contracts. Treat changes like you would an API change.

**1. Bump `version` in SKILL.md frontmatter.**
- Patch (`0.1.0` → `0.1.1`) for phrasing, internal logic, non-contract tweaks.
- Minor (`0.1.0` → `0.2.0`) for additive changes to `inputs`, `outputs_schema`, or action types used.
- Major (`0.1.0` → `1.0.0`) for breaking changes — required input added, schema field removed/renamed, status enum tightened. Orchestrators use `taskVersion` in the envelope to reason about replay compatibility; don't lie about it.

**2. Update `outputs_schema` in lockstep with the `data` payload.**
If the task now returns a new field, add it to the schema. If the task stops returning a field, remove it (or mark it optional) in the schema. A silent drift here means validation will fail at runtime with no useful error for the caller.

**3. Keep action types canonical.**
New external call? Check [`ACTION-TYPES.md`](./ACTION-TYPES.md). If the type isn't there, open a PR adding it to the registry — don't inline-invent `myservice.thing.frob` in a task.

**4. Don't widen `requires` casually.**
Every new cred listed is a new blast radius. If the task needs Gmail now but didn't before, that's a contract change worth calling out in the version bump.

**5. Re-run validation.**
At minimum, spawn the task once end-to-end with `--keep-workspace` and confirm:
- Envelope validates (check the audit file's `validationErrors: null`).
- `scopedEnvKeys` matches the updated `requires` list.
- No actions reference unknown types.

Any task-specific test harness (e.g. fixture-based schema validation) should be re-run too — tasks are encouraged to keep a `tests/` directory with AJV-validated fixtures for their major execution branches.

**6. Idempotency.**
If the task mutates external state, it should be safely re-runnable. Common patterns: check-before-create (Jira comment marker, 1Password item title lookup, FileMage username uniqueness). Document the idempotency strategy in the SKILL body so future editors don't regress it.

