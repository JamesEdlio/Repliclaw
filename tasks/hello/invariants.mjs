// Invariant check for the `hello` task.
//
// Demonstrates the pattern: cross-field constraints JSON Schema can't express.
// Here we verify the emitted greeting actually contains the name — schema
// can only say "both fields are non-empty strings"; it can't compare them.
//
// Return shape: Array<{ path?: string, message: string }>. Empty array = pass.
// `path` is relative to /data; the runtime prefixes it.
export function check(data) {
  const errors = [];
  if (typeof data?.greeting !== "string" || typeof data?.name !== "string") {
    return errors; // schema already flagged it
  }
  if (!data.greeting.includes(data.name)) {
    errors.push({
      path: "/greeting",
      message: `greeting must contain the name (got greeting=${JSON.stringify(data.greeting)}, name=${JSON.stringify(data.name)})`,
    });
  }
  return errors;
}
