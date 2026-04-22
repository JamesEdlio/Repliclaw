---
name: hello
version: 0.2.0
description: Verify the Repliclaw spawn/seed/result loop end-to-end. Emits a greeting envelope and terminates.
requires: []
inputs:
  name:
    type: string
    required: true
    description: Name to greet.
outputs:
  greeting:
    type: string
outputs_schema: ./schema.json
---

# hello

The simplest possible task skill. Used to validate that a replica can be spawned, seeded with a task, execute it, emit a well-formed Repliclaw result envelope, and terminate cleanly.

## Steps

1. Read the inputs. You will receive a `name` field.
2. Emit exactly one line of the form:

   ```
   <<RESULT>>{ ...envelope... }
   ```

   The envelope MUST conform to the standard Repliclaw envelope schema (see `skills/repliclaw/schemas/envelope.schema.json`). For this task, no external side-effects are taken, so `actions`, `notes`, and `errors` should be empty arrays.

3. Stop. Do not await further input. Do not add commentary after the marker.

## Envelope to emit

Replace `<NAME>` with the input name and `<RUN_ID>` with the value of `REPLICLAW_RUN_ID` from your environment. Use ISO-8601 timestamps for `startedAt`/`finishedAt`.

```json
<<RESULT>>{
  "status": "ok",
  "taskName": "hello",
  "taskVersion": "0.2.0",
  "runId": "<RUN_ID>",
  "startedAt": "<ISO-8601>",
  "finishedAt": "<ISO-8601>",
  "inputs": { "name": "<NAME>" },
  "actions": [],
  "notes": [],
  "errors": [],
  "data": { "greeting": "hello, <NAME>" }
}
```

No tool calls needed. No file writes. Single line, single output, then terminate.
