# Audit log schema

Every Repliclaw run writes a single JSON file to the audit directory, named `<runId>.json`.

## Schema

```json
{
  "runId":        "2026-04-22T18-40-01_019a76",
  "task":         "hello",
  "inputs":       {"name": "world"},
  "startedAt":    "2026-04-22T18:40:01.234Z",
  "endedAt":      "2026-04-22T18:40:07.560Z",
  "durationMs":   6326,
  "status":       "ok",
  "result":       { "...validated envelope..." },
  "error":        null,
  "validationErrors": null,
  "replicaWorkspace": "/home/.../.repliclaw/runs/2026-04-22T18-40-01_019a76/workspace",
  "stdoutTail":   "...last 4k of replica kern-ai stdout...",
  "stderrTail":   "...last 4k of replica kern-ai stderr...",
  "scopedEnvKeys": ["FILEMAGE_API_KEY", "JIRA_API_TOKEN", ...],
  "strippedPrefixes": ["SLACK_", "TELEGRAM_", ...]
}
```

## Field reference

| Field | Type | Notes |
|---|---|---|
| `runId` | string | Unique per run. Format: ISO timestamp + random suffix. |
| `task` | string | Name of the task skill. |
| `inputs` | object | Exactly what was passed via `--inputs`. |
| `startedAt` | ISO-8601 | When `run.mjs` started, not when the replica opened its port. |
| `endedAt` | ISO-8601 | When `run.mjs` finished cleanup. |
| `durationMs` | number | endedAt - startedAt in ms. |
| `status` | string | `ok` \| `error` \| `partial` \| `timeout` \| `declined` \| `needs-input`. Derived from the envelope after validation. |
| `result` | object\|null | The validated envelope from the replica. If validation failed, this holds `{status:"error", reason:"envelope validation failed", validationErrors, raw}`. |
| `error` | string\|null | Spawn-level error if the replica never produced a result. |
| `validationErrors` | array\|null | AJV validation errors if the envelope was malformed. `null` on success. |
| `replicaWorkspace` | string | Path to the replica's workspace on disk. Deleted after run unless `--keep-workspace`. |
| `stdoutTail` | string | Last 4k bytes of replica `kern-ai` stdout. Useful for debugging spawn issues. |
| `stderrTail` | string | Last 4k bytes of replica `kern-ai` stderr. |
| `scopedEnvKeys` | string[] | Names (not values) of env vars the replica received. |
| `strippedPrefixes` | string[] | The hard-strip list that was applied. |

## Status values

- **`ok`** — Replica emitted a valid envelope with `status:"ok"`.
- **`partial`** — Some actions succeeded, some failed. Inspect `result.actions[].status` and `result.errors[]`.
- **`error`** — Envelope reported error, or validation failed, or spawn failed, or the result JSON was malformed.
- **`timeout`** — Replica never emitted a result before `--timeout` expired.
- **`declined`** — Replica refused to proceed (policy/safety guard in the task playbook).
- **`needs-input`** — Replica did everything it could and is blocked on a human/parent decision.

## What's NOT in the audit log

Intentionally absent:

- **Credential values.** Only key names (`scopedEnvKeys`). Never the values.
- **Full conversation transcript.** Too large. If you need it, re-run with `--keep-workspace` and read the replica's kern state directly.
- **Intermediate tool calls.** The replica's tool-call traces live in the replica's kern workspace, not the audit log. By design — audit logs are structured summaries, not debug dumps.

## Durable storage

Repliclaw does not commit audit logs anywhere. The invoking agent is responsible for durable storage.

**Common patterns:**

```bash
# Option 1: Dedicated audit git repo
AUDIT_REPO=~/edith-audit-dump
node run.mjs --audit-dir $AUDIT_REPO/runs ... \
  && cd $AUDIT_REPO && git add runs/ && git commit -m "audit: $runId" && git push

# Option 2: S3
node run.mjs --audit-dir /tmp/audit ... \
  && aws s3 cp /tmp/audit/$runId.json s3://bucket/repliclaw-audit/

# Option 3: Notion/Confluence/etc.
# Agent reads the JSON, converts to a page, posts via API.
```

## Schema evolution

The schema is additive. New fields may be added in minor releases; existing fields will not change type or meaning without a major version bump.

If you're programmatically consuming audit logs, tolerate unknown fields.
