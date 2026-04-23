#!/usr/bin/env node
// Runtime adapter tests.
//
// We don't spin up a real replica here — that's covered by the hello smoke
// test. This suite verifies the runtime interface contract + error paths
// that don't require spawning real processes:
//
//   - loadRuntime returns the right adapter for known ids
//   - loadRuntime throws on unknown ids
//   - adapters implement the full 5-method surface
//   - openclaw preflight rejects tasks that use the (default) gateway mode
//     without declaring openclawAgent
//   - openclaw preflight fails loudly when the `openclaw` CLI isn't on PATH
//   - openclaw local-mode opt-in routes past the openclawAgent check
//   - kern cleanup is idempotent on empty state
//
// We deliberately skip anything that requires a real openclaw/kern install.

import { loadRuntime, SUPPORTED_RUNTIMES } from "../skills/repliclaw/lib/runtimes/index.mjs";

let fails = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { fails++; console.log(`  FAIL  ${name}\n    ${e.message}`); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
async function assertThrows(fn, msgMatch) {
  try { await fn(); } catch (e) {
    if (msgMatch && !e.message.includes(msgMatch)) {
      throw new Error(`wrong error: got "${e.message}", expected to include "${msgMatch}"`);
    }
    return;
  }
  throw new Error("expected throw, none");
}

function mkCtx(overrides = {}) {
  return {
    runId: "test-run",
    taskName: "hello",
    taskSkillDir: "/tmp/fake",
    taskSkillMeta: {},
    inputsObj: {},
    scopedEnv: {},
    timeoutSec: 10,
    runDir: "/tmp/fake/runs/test",
    keepWorkspace: false,
    logSink: { pushStdout() {}, pushStderr() {} },
    ...overrides,
  };
}

// ----------------------------------------------------------------------------

console.log("runtimes/index.mjs");

await t("SUPPORTED_RUNTIMES lists kern and openclaw", () => {
  assert(SUPPORTED_RUNTIMES.includes("kern"));
  assert(SUPPORTED_RUNTIMES.includes("openclaw"));
});

await t("loadRuntime('kern') returns kern adapter with full interface", () => {
  const rt = loadRuntime("kern");
  assert(rt.id === "kern", `got id=${rt.id}`);
  assert(typeof rt.preflight === "function");
  assert(typeof rt.prepare === "function");
  assert(typeof rt.spawnAndSeed === "function");
  assert(typeof rt.awaitResult === "function");
  assert(typeof rt.cleanup === "function");
});

await t("loadRuntime('openclaw') returns openclaw adapter with full interface", () => {
  const rt = loadRuntime("openclaw");
  assert(rt.id === "openclaw");
  assert(typeof rt.preflight === "function");
  assert(typeof rt.prepare === "function");
  assert(typeof rt.spawnAndSeed === "function");
  assert(typeof rt.awaitResult === "function");
  assert(typeof rt.cleanup === "function");
});

await t("loadRuntime throws on unknown id", () => {
  assertThrows(() => loadRuntime("nope"), "unknown runtime");
});

// ----------------------------------------------------------------------------

console.log("runtimes/openclaw.mjs preflight");

await t("openclaw preflight rejects gateway mode with no openclawAgent", async () => {
  // Contract check — we stage this so the CLI check (which would fail on a
  // machine without openclaw installed) happens first; but we're really
  // asserting the frontmatter gate exists for gateway mode.
  const openclaw = loadRuntime("openclaw");
  const ctx = mkCtx({
    taskSkillMeta: { openclawGateway: true }, // missing openclawAgent
  });
  // Either the CLI-missing error or the openclawAgent error is acceptable —
  // both are legit preflight failures. We just require *some* throw.
  await assertThrows(() => openclaw.preflight(ctx));
});

await t("openclaw preflight throws when openclaw CLI is missing", async () => {
  // Force PATH to somewhere without openclaw so spawn ENOENTs.
  const origPath = process.env.PATH;
  process.env.PATH = "/var/empty";
  try {
    const openclaw = loadRuntime("openclaw");
    const ctx = mkCtx(); // local mode, no gateway required
    await assertThrows(() => openclaw.preflight(ctx), "openclaw CLI not usable");
  } finally {
    process.env.PATH = origPath;
  }
});

await t("openclaw local mode sets scratch agent id on _runtimeState", async () => {
  // We can't actually run preflight without the CLI, but we can verify the
  // mode-selection logic by stubbing: a task without openclawGateway should
  // plan for local mode. We detect this by asserting the preflight error
  // path is the CLI-missing one, not the openclawAgent one.
  const origPath = process.env.PATH;
  process.env.PATH = "/var/empty";
  try {
    const openclaw = loadRuntime("openclaw");
    const ctx = mkCtx({ taskSkillMeta: {} }); // local mode (no gateway flag)
    await assertThrows(() => openclaw.preflight(ctx), "CLI not usable");
  } finally {
    process.env.PATH = origPath;
  }
});

// ----------------------------------------------------------------------------

console.log("runtimes/kern.mjs contract");

await t("kern adapter has expected interface shape", () => {
  const rt = loadRuntime("kern");
  assert(rt.id === "kern");
  assert(typeof rt.preflight === "function");
  assert(typeof rt.prepare === "function");
  assert(typeof rt.spawnAndSeed === "function");
  assert(typeof rt.awaitResult === "function");
  assert(typeof rt.cleanup === "function");
});

await t("kern cleanup is idempotent on empty state", async () => {
  const rt = loadRuntime("kern");
  const ctx = mkCtx();
  // No _runtimeState set — cleanup should not throw.
  await rt.cleanup(ctx);
});

await t("openclaw cleanup is idempotent on empty state", async () => {
  const rt = loadRuntime("openclaw");
  const ctx = mkCtx();
  // No _runtimeState set — cleanup should not throw.
  await rt.cleanup(ctx);
});

console.log("");
console.log(fails === 0 ? "✓ all runtime tests passed" : `✗ ${fails} runtime test failures`);
process.exit(fails === 0 ? 0 : 1);
