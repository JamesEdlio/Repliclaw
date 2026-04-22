// Repliclaw result helper.
// Task skills call recordAction/recordNote/recordError throughout the run,
// then call emit() once at the end. This guarantees a well-formed envelope
// that passes schema validation in the parent's parse-result.
//
// Usage inside a task skill (the replica imports this from the seeded workspace):
//
//   import { run } from "./repliclaw-result.mjs";
//
//   await run({
//     taskName: "my-task",
//     taskVersion: "0.1.0",
//     inputs,
//     async work(ctx) {
//       const record = await api.get(inputs.recordId);
//       ctx.action("api.record.read", inputs.recordId);
//       // ... do stuff, calling ctx.action / ctx.note / ctx.error ...
//       return { outcome: "processed", recordId: record.id };
//     }
//   });
//
// On success this prints exactly one line:
//   <<RESULT>>{...envelope...}
//
// and resolves. The replica's outer agent loop then sees the marker and dies.

/**
 * @typedef {Object} ResultContext
 * @property {(type: string, ref?: string, details?: object) => void} action  - replica performed the action
 * @property {(type: string, ref?: string, details?: object, payload?: object) => void} plan  - replica declares intent, parent will execute
 * @property {(type: string, message: string, opts?: {severity?: 'info'|'warn'|'error', details?: object}) => void} note
 * @property {(code: string, message: string, opts?: {retryable?: boolean, details?: object}) => void} error
 */

/**
 * @typedef {Object} RunOptions
 * @property {string} taskName
 * @property {string} taskVersion
 * @property {object} inputs
 * @property {string} [runId]   - injected by repliclaw runner; auto-generated if absent
 * @property {(ctx: ResultContext) => Promise<object>} work  - returns task data payload
 * @property {(text: string) => void} [emit] - override stdout writer (for tests)
 */

/**
 * @param {RunOptions} opts
 */
export async function run(opts) {
  const startedAt = new Date().toISOString();
  const runId = opts.runId || process.env.REPLICLAW_RUN_ID || mkRunId();
  const actions = [];
  const notes = [];
  const errors = [];

  const ctx = {
    action(type, ref, details) {
      validateActionType(type);
      const a = { type, ts: new Date().toISOString() };
      if (ref !== undefined) a.ref = String(ref);
      if (details !== undefined) a.details = details;
      // mutating actions must have details
      if (!isReadVerb(type) && a.details === undefined) {
        a.details = {};
        // attach a note so it shows up in audit
        notes.push({
          type: "warn",
          message: `mutating action ${type} emitted without details — audit replay will be incomplete`,
          severity: "warn",
        });
      }
      actions.push(a);
    },
    plan(type, ref, details, payload) {
      // Emit a parent-executed action. Replica did NOT perform this; parent will.
      // Use for interface sends (slack.message.send, telegram.message.send) and
      // for any action where `mode: "plan"` is in effect.
      validateActionType(type);
      const a = {
        type,
        ts: new Date().toISOString(),
        status: "planned",
        details: details || {},
      };
      if (ref !== undefined) a.ref = String(ref);
      if (payload !== undefined) a.payload = payload;
      actions.push(a);
    },
    note(type, message, opts = {}) {
      notes.push({
        type: String(type),
        message: String(message),
        severity: opts.severity || "info",
        ...(opts.details ? { details: opts.details } : {}),
      });
    },
    error(code, message, opts = {}) {
      errors.push({
        code: String(code),
        message: String(message),
        retryable: opts.retryable === true,
        at: new Date().toISOString(),
        ...(opts.details ? { details: opts.details } : {}),
      });
    },
  };

  let data = {};
  let status = "ok";

  try {
    const out = await opts.work(ctx);
    if (out && typeof out === "object") data = out;
  } catch (e) {
    ctx.error("task.exception", e?.message || String(e), {
      retryable: false,
      details: e?.stack ? { stack: String(e.stack).slice(0, 4000) } : undefined,
    });
  }

  // Derive status from actions/errors if task didn't explicitly set one
  if (errors.length > 0) {
    const anySuccess = actions.some(a => (a.status ?? "success") === "success");
    status = anySuccess ? "partial" : "error";
  }
  if (data.__status && typeof data.__status === "string") {
    status = data.__status;
    delete data.__status;
  }

  const envelope = {
    status,
    taskName: opts.taskName,
    taskVersion: opts.taskVersion,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    inputs: opts.inputs || {},
    actions,
    notes,
    errors,
    data,
  };

  const line = "<<RESULT>>" + JSON.stringify(envelope);
  (opts.emit || ((s) => process.stdout.write(s + "\n")))(line);
  return envelope;
}

function isReadVerb(type) {
  return /\.(read|get|list|search|fetch)$/.test(type);
}

function validateActionType(type) {
  if (typeof type !== "string" || !/^[a-z0-9]+(\.[a-z0-9]+){1,3}$/.test(type)) {
    throw new Error(`invalid action type: ${type} (expected service.resource.verb)`);
  }
}

function mkRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}_${rand}`;
}
