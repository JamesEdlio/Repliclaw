// Events emitter unit tests.
//
// Covers:
//   - no-op when neither fd nor file provided
//   - file mode: NDJSON written, each line parses
//   - fd mode: writes go to caller-owned fd
//   - events contain ts, runId, type
//   - closeEvents() is safe to call twice
//   - errors on a closed consumer don't throw

import { test } from "node:test";
import assert from "node:assert/strict";
import { openSync, closeSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initEvents, emit, closeEvents } from "../skills/repliclaw/lib/events.mjs";

function tmpFile(name) {
  const p = join(tmpdir(), `repliclaw-evtest-${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`);
  try { unlinkSync(p); } catch {}
  return p;
}

test("events emitter: no sink => emit is a no-op", () => {
  initEvents({ runId: "r1" });
  // Should not throw, not create any file.
  assert.doesNotThrow(() => emit("phase", { phase: "start" }));
  closeEvents();
});

test("events emitter: file mode writes NDJSON with required fields", () => {
  const p = tmpFile("file-mode");
  initEvents({ runId: "r2", file: p });
  emit("phase", { phase: "start" });
  emit("stdout", { text: "hello\n" });
  emit("result", { envelope: { status: "ok" } });
  emit("phase", { phase: "done", status: "ok" });
  closeEvents();

  assert.ok(existsSync(p), "events file must exist");
  const lines = readFileSync(p, "utf8").trim().split("\n");
  assert.equal(lines.length, 4, "one event per emit()");

  for (const l of lines) {
    const ev = JSON.parse(l);
    assert.ok(ev.ts, "event has ts");
    assert.equal(ev.runId, "r2");
    assert.ok(ev.type, "event has type");
  }

  const phases = lines.map(JSON.parse).filter(e => e.type === "phase");
  assert.deepEqual(phases.map(p => p.phase), ["start", "done"]);

  unlinkSync(p);
});

test("events emitter: fd mode writes to caller-owned fd", () => {
  const p = tmpFile("fd-mode");
  const fd = openSync(p, "a");
  initEvents({ runId: "r3", fd });
  emit("phase", { phase: "start" });
  emit("phase", { phase: "done" });
  closeEvents();
  // closeEvents() will attempt to close fd; caller close may fail but that's fine
  try { closeSync(fd); } catch {}

  const lines = readFileSync(p, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  for (const l of lines) {
    const ev = JSON.parse(l);
    assert.equal(ev.runId, "r3");
  }
  unlinkSync(p);
});

test("events emitter: closeEvents is idempotent", () => {
  const p = tmpFile("close-twice");
  initEvents({ runId: "r4", file: p });
  emit("phase", { phase: "done" });
  assert.doesNotThrow(() => closeEvents());
  assert.doesNotThrow(() => closeEvents());
  unlinkSync(p);
});

test("events emitter: emit after close is a no-op", () => {
  const p = tmpFile("after-close");
  initEvents({ runId: "r5", file: p });
  emit("phase", { phase: "start" });
  closeEvents();
  assert.doesNotThrow(() => emit("phase", { phase: "late" }));
  // The late event shouldn't land in the file.
  const lines = readFileSync(p, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  unlinkSync(p);
});
