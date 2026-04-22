// Credential scoping for Repliclaw replicas.
//
// The rule: a replica gets ONLY what its task skill explicitly declares it
// needs. Everything else — especially interface tokens that would let the
// replica message humans — is stripped at the boundary.
//
// This file is the single enforcement point. Keep it simple, keep it loud,
// do not sprinkle similar logic elsewhere.

// Prefixes that are ALWAYS stripped regardless of task-skill requires[].
// These are interfaces (channels the replica would use to talk to humans).
// Adding a replica to your Slack by accident is a bug we don't want.
export const STRIPPED_PREFIXES = [
  "SLACK_",
  "TELEGRAM_",
  "MATRIX_",
  "DISCORD_",
  "TWILIO_",
  // Parent's kern interface tokens — replica gets its own.
  "KERN_AUTH_TOKEN",
  "KERN_INTERFACE_",
];

// Variables always passed through if present (neutral runtime config).
// Model keys go through here because without them the replica can't think.
// If you want to change which model the replica uses, edit this list or
// scope further in a future per-task config.
const ALWAYS_PASS = [
  // Model providers. Repliclaw assumes the replica talks to the same model
  // as the parent.
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  // kern runtime config (non-auth).
  "KERN_PROVIDER",
  "KERN_MODEL",
  // Headless keyring — without this, any lib trying to use the OS keyring
  // will hang a replica indefinitely.
  "PYTHON_KEYRING_BACKEND",
];

/**
 * Filter the parent env down to the subset a replica is allowed to see.
 *
 * @param {NodeJS.ProcessEnv} parentEnv - process.env or equivalent
 * @param {string[]} requires - list of env var names (or prefixes ending in _)
 *                              the task skill declares it needs.
 * @returns {Record<string,string>} scoped env
 */
export function scopeCreds(parentEnv, requires) {
  const out = {};
  const allowedExact = new Set(ALWAYS_PASS);
  for (const r of requires || []) allowedExact.add(r);

  // Additionally allow prefix matches for task-declared requires ending in _
  const allowedPrefixes = (requires || []).filter(r => r.endsWith("_"));

  for (const [k, v] of Object.entries(parentEnv)) {
    if (v == null) continue;

    // Hard block: stripped prefixes win over everything else.
    if (STRIPPED_PREFIXES.some(p => k === p || k.startsWith(p))) continue;

    if (allowedExact.has(k)) { out[k] = v; continue; }
    if (allowedPrefixes.some(p => k.startsWith(p))) { out[k] = v; continue; }
  }
  return out;
}
