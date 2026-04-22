# Authoring a task skill

A Repliclaw task skill is a directory with a `SKILL.md` at its root. The `SKILL.md` is both documentation and executable playbook — the replica reads it and follows it.

## Minimum viable task skill

```
tasks/my-task/
└── SKILL.md
```

```markdown
---
name: my-task
description: One sentence describing what this does.
requires: []
inputs: {}
outputs: {}
---

# my-task

Describe what the replica should do, step by step. End with:

`<<RESULT>>{"status":"ok","data":{...}}`
```

## Frontmatter contract

### `name` (string, required)

Must match the directory name. Used as the task ID in audit logs.

### `description` (string, required)

One sentence. Shown in skill catalogs so invoking agents know what this does.

### `requires` (array of strings, required)

Env var names (or prefixes ending in `_`) the replica needs to do its job.

**Examples:**

```yaml
requires:
  - JIRA_EMAIL
  - JIRA_API_TOKEN
  - FILEMAGE_API_KEY
```

```yaml
# Pull all GWS_* vars
requires:
  - GWS_
```

```yaml
# Pure-reasoning skill, no external creds needed
requires: []
```

**What you DON'T declare:**

- Model keys (`OPENROUTER_API_KEY`, etc.) — always passed through.
- Kern runtime config (`KERN_PROVIDER`, `KERN_MODEL`) — always passed through.
- Interface tokens (`SLACK_*`, `TELEGRAM_*`, `MATRIX_*`, etc.) — **always stripped**. Task skills cannot opt back into these. This is a security boundary.

If you need to declare interface-like creds, you're using Repliclaw wrong. Replicas shouldn't message humans; they should return results to the parent, which messages humans.

### `inputs` (object, optional)

JSON-Schema-ish declaration of the inputs the task skill expects.

```yaml
inputs:
  ticketId:
    type: string
    required: true
    description: Jira issue key, e.g. SS-445.
  dryRun:
    type: boolean
    required: false
    default: true
```

Enforcement is currently advisory — invoking agents should validate before calling, but the runtime doesn't reject malformed inputs.

### `outputs` (object, optional)

Declaration of the result shape. Used by consuming agents to validate the replica's `<<RESULT>>` payload.

```yaml
outputs:
  classification:
    type: string
    description: One of NEW | FOLLOW-UP | INTERNAL-BUG | ...
  recommendation:
    type: string
  blockers:
    type: array
```

## Body (the playbook)

Everything after the frontmatter `---` is the playbook. This is what the replica reads and executes. Write it for a capable but context-free reader — the replica has no memory, no operator to ask, no context beyond this skill and the inputs you pass.

**Include:**

- **Steps** — numbered, imperative. What to do first, second, third.
- **Tools the replica should use** — mention them explicitly. e.g. "use curl to call the Jira API", "read the Staff.csv file with the csv module".
- **Decision points** — if/then. "If the ticket has no attachments, classify as X. If it has attachments, analyze them before classifying."
- **The exit contract** — how to emit the result, what fields to include.

**Always end with:**

```
When done, emit exactly one line:

<<RESULT>>{"status":"ok","data":{...}} (or {"status":"error","reason":"..."})

Then stop. Do not await further input.
```

## Additional files

A skill directory can contain anything else the replica needs:

```
tasks/my-task/
├── SKILL.md
├── templates/
│   └── email-body.txt
├── helpers/
│   └── validate.py
└── examples/
    └── reference-output.json
```

The entire directory is copied into the replica's workspace at `skills/<name>/`. The replica can read any file within it.

## Testing

```bash
node skills/repliclaw/lib/run.mjs \
  --task my-task \
  --inputs '{"ticketId":"SS-445"}' \
  --audit-dir ./audit-dev \
  --keep-workspace   # don't delete the replica workspace, useful for debugging
```

Inspect `./audit-dev/*.json` for the audit log. If `--keep-workspace` was set, the replica's workspace is preserved under `~/.repliclaw/runs/<runId>/workspace/` — look at the replica's own conversation transcript to debug what it did.

## Style guide

- **Be terse.** The replica pays tokens for every word.
- **Be explicit about the exit.** Ambiguity on when to emit `<<RESULT>>` is the #1 way replicas time out.
- **Prefer idempotence.** The replica might be retried. Design steps so re-running is safe.
- **Declare minimum creds.** If your skill only needs Jira read, don't declare Jira write. Scoping is defense in depth.
- **Log mutations in the result payload.** If the replica creates/updates/emails, put what it did in the result so the audit log has it.
