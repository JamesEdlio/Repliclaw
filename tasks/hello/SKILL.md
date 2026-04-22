---
name: hello
description: Verify the Repliclaw spawn/seed/result loop end-to-end. Emits a greeting and terminates.
requires: []
inputs:
  name:
    type: string
    required: true
    description: Name to greet.
outputs:
  greeting:
    type: string
---

# hello

The simplest possible task skill. Used to validate that a replica can be spawned, seeded with a task, execute it, emit a result, and terminate cleanly.

## Steps

1. Read the inputs. You will receive a `name` field.
2. Emit exactly one line:
   ```
   <<RESULT>>{"status":"ok","data":{"greeting":"hello, <name>"}}
   ```
3. Stop. Do not await further input. Do not add commentary.

No tool calls needed.
