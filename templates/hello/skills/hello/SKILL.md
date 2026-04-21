# Hello skill

Just say hello and emit a result. Used to verify the Repliclaw spawn loop.

## Steps

1. Read the inputs. They will contain a `name` field.
2. Emit a single line:
   ```
   <<RESULT>>{"status":"ok","data":{"greeting":"hello, <name>"}}
   ```
3. Stop.

No tool calls needed.
