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
requires: []
inputs: {}
outputs: {}
outputs_schema: ./schema.json
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
  taskName: "app-sftp-case",
  taskVersion: "0.1.0",
  inputs,
  async work(ctx) {
    const issue = await jira.get(inputs.ticketId);
    ctx.action("jira.issue.read", inputs.ticketId);

    if (!userExists) {
      await filemage.createUser({ ... });
      ctx.action("filemage.user.create", username, {
        username, endpointId, accountType: "sftp"
      });
    }

    return { classification: "new-setup", nextAction: "await-first-upload" };
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
