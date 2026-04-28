# Live Events Stream

Repliclaw runs emit a full audit record on completion. For orchestrators that want to *observe a run as it happens* — say, to stream progress into a dashboard, forward to a webhook, or surface live logs in a UI — the run helper can additionally emit an **NDJSON event stream**.

## Enabling the stream

Pass one of these flags to `skills/repliclaw/lib/run.mjs`:

| Flag | Meaning |
|---|---|
| `--events-fd <N>` | Write events to file descriptor `N`. Parent process is responsible for opening (and eventually closing) the fd. Zero disk I/O — well-suited to in-memory pipes. |
| `--events-file <path>` | Append events to a file on disk, one JSON object per line. Directory is created if needed. |

Both are optional. If neither is supplied, no events are emitted (`emit()` is a no-op, no file is created).

**Typical use**: an orchestrator spawning repliclaw as a child process sets `stdio: ['ignore','pipe','pipe','pipe']` and passes `--events-fd 3`. It then reads the extra fd as a stream and forwards each line to its own consumers.

```js
const child = spawn("node", [
  "skills/repliclaw/lib/run.mjs",
  "--task", "my-task",
  "--inputs", JSON.stringify({ ticket_key: "ABC-123" }),
  "--events-fd", "3",
], {
  stdio: ["ignore", "pipe", "pipe", "pipe"],
});

child.stdio[3].setEncoding("utf8");
child.stdio[3].on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    // ... forward it
  }
});
```

## Event schema

Every event is a JSON object on its own line:

```json
{ "ts": "2026-04-28T03:45:12.001Z", "runId": "2026-04-28T03-45-09_a7f1b2", "type": "phase", "phase": "spawn" }
```

Common fields (always present):

- `ts` — ISO-8601 timestamp of emission
- `runId` — the repliclaw run id (same as the audit filename)
- `type` — one of the types below

### Event types

| `type` | Extra fields | When |
|---|---|---|
| `phase` | `phase`: `start` \| `preflight` \| `prepare` \| `spawn` \| `awaiting` \| `cleanup` \| `done` | State transitions in the run lifecycle |
| `stdout` | `text` | A chunk of stdout from the replica process. **Not line-buffered** — consumers must split on `\n` if they want lines. |
| `stderr` | `text` | Same as `stdout`, for stderr. |
| `result` | `status`, `envelope` | Emitted once, after the replica returns and the envelope is validated. The `envelope` is the same object written to the audit's `result` field. |
| `error` | `message` | Emitted when the runtime throws (spawn failure, timeout from runtime adapter, etc.). |

The `start` phase is emitted before preflight and carries extra fields: `task` and `runtime`. The `done` phase is emitted last, immediately before process exit, and carries the final `status`.

### Ordering guarantees

- `phase: "start"` is always the first event.
- `phase: "done"` is always the last event.
- `result` is emitted exactly once — before `phase: "done"` — if the run produced any envelope (valid, malformed, or error-status).
- `stdout`/`stderr` events interleave freely with phase events.

### Delivery semantics

- **Best-effort, no retry.** If the consumer stops reading (closes the fd or file), emit becomes a silent no-op for the rest of the run. The audit record is still written on disk regardless.
- **No backpressure handling.** Repliclaw uses `writeSync`; a slow reader on fd mode can block the run briefly.
- **No buffering.** Events are flushed to the sink synchronously at emit time.

## Relationship to the audit record

Events are an *addition*, not a replacement. On exit, repliclaw still writes the full audit record to `<audit-dir>/<runId>.json` as usual. The audit contains the final envelope, stdout/stderr tails, validation errors — everything a post-hoc review needs.

Use events for **live UX**; use the audit for **after-the-fact analysis**.

## Example: minimal consumer

```bash
# Run with events streaming to a file
node skills/repliclaw/lib/run.mjs \
  --task hello \
  --inputs '{"name":"world"}' \
  --events-file /tmp/hello.ndjson

# In another terminal:
tail -f /tmp/hello.ndjson | jq .
```

## Stability

The events format is part of the Repliclaw contract. New event types or fields may be added without warning, but existing fields will not change meaning. Consumers should ignore unknown `type` values and unknown fields on known types.
