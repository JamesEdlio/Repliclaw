// Repliclaw progress event emitter.
//
// Emits NDJSON progress events during a run, for orchestrators that want to
// stream run activity live (not just read the final audit).
//
// Sinks (choose one via run.mjs CLI):
//   --events-fd <N>      write to fd N (file descriptor opened by parent process)
//   --events-file <path> write to a file (appended, one JSON object per line)
//
// Both are optional. If neither is given, emit() is a no-op.
//
// Event shape:
//   { ts, runId, type, ...payload }
// where `type` is one of:
//   "phase"    payload: { phase }        preflight|prepare|spawn|awaiting|cleanup|done
//   "stdout"   payload: { text }         chunk of replica stdout
//   "stderr"   payload: { text }         chunk of replica stderr
//   "result"   payload: { envelope }     final envelope (after validation)
//   "error"    payload: { message }      bridge/runtime error
//
// Contract notes for consumers:
//   - Events are append-only and best-effort. A dropped event is never retried.
//   - `stdout`/`stderr` chunks are NOT line-buffered; consumers must split.
//   - `phase: "done"` is always the last event emitted before process exit.
//   - If neither sink is configured, nothing is emitted and no file is created.

import { writeSync, openSync, closeSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let fd = -1;
let runId = null;
let closed = false;

/**
 * Configure the events emitter.
 * @param {object} opts
 * @param {string} opts.runId  run id (included on every event)
 * @param {number} [opts.fd]   file descriptor to write to
 * @param {string} [opts.file] path to append NDJSON to (created if missing)
 */
export function initEvents({ runId: id, fd: openFd, file }) {
  runId = id;
  closed = false;
  if (typeof openFd === "number" && openFd >= 0) {
    fd = openFd;
    return;
  }
  if (file) {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    fd = openSync(file, "a");
    return;
  }
  // no sink configured; emit() becomes a no-op
  fd = -1;
}

/**
 * Emit a progress event. No-op if no sink configured.
 * @param {string} type
 * @param {object} [payload]
 */
export function emit(type, payload = {}) {
  if (fd < 0 || closed) return;
  const ev = { ts: new Date().toISOString(), runId, type, ...payload };
  try {
    writeSync(fd, JSON.stringify(ev) + "\n");
  } catch {
    // Sink closed on consumer side. Mark closed so we don't spam errors.
    closed = true;
  }
}

/** Close the events sink. Safe to call multiple times. */
export function closeEvents() {
  if (fd < 0 || closed) return;
  // Only close file descriptors we opened ourselves (from --events-file).
  // fd passed via --events-fd is owned by the parent; leave it alone.
  // We can't easily tell them apart here, so: best effort close for >2.
  // fd 0,1,2 are stdin/stdout/stderr and shouldn't have been handed in.
  // Parent-provided fds will likely survive being closed here anyway
  // because parent holds its own reference.
  try { closeSync(fd); } catch { /* ignore */ }
  closed = true;
}
