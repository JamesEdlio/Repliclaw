// Unit tests for Repliclaw envelope parsing and validation.
// Run: node tests/parse-result.test.mjs

import { tryExtractResult, validateEnvelope, loadTaskOutputsSchema } from "../skills/repliclaw/lib/parse-result.mjs";
import { run as resultRun } from "../skills/repliclaw/lib/result.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`, extra ?? ""); }
}

console.log("# tryExtractResult");

ok("incomplete when no marker", tryExtractResult("hello world").kind === "incomplete");
ok("incomplete when marker but no body", tryExtractResult("foo <<RESULT>>").kind === "incomplete");
{
  const r = tryExtractResult('foo <<RESULT>>{"a":1}');
  ok("ok with simple object", r.kind === "ok" && r.value.a === 1);
}
{
  const r = tryExtractResult('text <<RESULT>>{"a":{"b":[1,2,3]},"c":"}"} trailing');
  ok("ok with nested + brace-in-string", r.kind === "ok" && r.value.c === "}");
}
{
  const r = tryExtractResult('<<RESULT>>{"a":1');
  ok("incomplete when unclosed", r.kind === "incomplete");
}
{
  const r = tryExtractResult('<<RESULT>>not-json');
  ok("malformed when not json", r.kind === "malformed");
}

console.log("\n# validateEnvelope (standard envelope)");

const goodEnvelope = {
  status: "ok",
  taskName: "hello",
  taskVersion: "0.2.0",
  runId: "2026-04-22T18-40-00_abc123",
  startedAt: "2026-04-22T18:40:00.000Z",
  finishedAt: "2026-04-22T18:40:01.000Z",
  inputs: { name: "world" },
  actions: [],
  notes: [],
  errors: [],
  data: { greeting: "hello, world" },
};

ok("good envelope passes", validateEnvelope(goodEnvelope).ok);

ok("bad status rejected",
  !validateEnvelope({ ...goodEnvelope, status: "great" }).ok);

ok("missing runId rejected",
  !validateEnvelope({ ...goodEnvelope, runId: undefined }).ok);

ok("invalid taskName pattern rejected",
  !validateEnvelope({ ...goodEnvelope, taskName: "Hello World" }).ok);

ok("action read without details ok",
  validateEnvelope({
    ...goodEnvelope,
    actions: [{ type: "jira.issue.read", ref: "SS-1", ts: new Date().toISOString() }]
  }).ok);

ok("action mutating without details rejected",
  !validateEnvelope({
    ...goodEnvelope,
    actions: [{ type: "jira.comment.create", ref: "SS-1", ts: new Date().toISOString() }]
  }).ok);

ok("action mutating with details ok",
  validateEnvelope({
    ...goodEnvelope,
    actions: [{ type: "jira.comment.create", ref: "SS-1", ts: new Date().toISOString(), details: { body: "hi" } }]
  }).ok);

ok("error missing retryable rejected",
  !validateEnvelope({
    ...goodEnvelope,
    status: "error",
    errors: [{ code: "x.y", message: "boom", at: new Date().toISOString() }]
  }).ok);

ok("error structured ok",
  validateEnvelope({
    ...goodEnvelope,
    status: "error",
    errors: [{ code: "filemage.api.5xx", message: "boom", retryable: true, at: new Date().toISOString() }]
  }).ok);

ok("note structured ok",
  validateEnvelope({
    ...goodEnvelope,
    notes: [{ type: "flag", message: "second domain", severity: "info" }]
  }).ok);

console.log("\n# loadTaskOutputsSchema");

const helloSchema = loadTaskOutputsSchema(join(ROOT, "tasks", "hello"));
ok("loads hello schema", helloSchema && helloSchema.required?.includes("greeting"));

console.log("\n# validateEnvelope (with task data schema)");

ok("good data passes task schema",
  validateEnvelope(goodEnvelope, { dataSchema: helloSchema }).ok);

ok("missing greeting fails task schema",
  !validateEnvelope({ ...goodEnvelope, data: {} }, { dataSchema: helloSchema }).ok);

console.log("\n# result.mjs helper");

await (async () => {
  let captured = null;
  const env = await resultRun({
    taskName: "hello",
    taskVersion: "0.2.0",
    inputs: { name: "world" },
    runId: "test-run-1",
    emit: (s) => { captured = s; },
    async work(ctx) {
      ctx.action("jira.issue.read", "SS-1");
      ctx.action("jira.comment.create", "SS-1", { body: "hi" });
      ctx.note("flag", "test note");
      return { greeting: "hello, world" };
    }
  });
  ok("helper emits a <<RESULT>> line", captured?.startsWith("<<RESULT>>"));
  ok("envelope round-trips through validator",
    validateEnvelope(env, { dataSchema: helloSchema }).ok);
  ok("status defaults to ok with no errors", env.status === "ok");
  ok("actions captured", env.actions.length === 2);
  ok("notes captured", env.notes.length === 1);

  // Error path: ensure status flips to "error" if no successful actions
  const env2 = await resultRun({
    taskName: "hello",
    taskVersion: "0.2.0",
    inputs: {},
    runId: "test-run-2",
    emit: () => {},
    async work(ctx) {
      ctx.error("test.boom", "kaboom", { retryable: false });
      return { greeting: "x" };
    }
  });
  ok("status=error when only errors and no actions", env2.status === "error");

  // Partial path: action succeeded but error logged
  const env3 = await resultRun({
    taskName: "hello",
    taskVersion: "0.2.0",
    inputs: {},
    runId: "test-run-3",
    emit: () => {},
    async work(ctx) {
      ctx.action("jira.comment.create", "SS-1", { body: "hi" });
      ctx.error("gmail.send.quota", "rate limited", { retryable: true });
      return { greeting: "x" };
    }
  });
  ok("status=partial when action+error", env3.status === "partial");

  // Exception inside work() is caught and recorded
  const env4 = await resultRun({
    taskName: "hello",
    taskVersion: "0.2.0",
    inputs: {},
    runId: "test-run-4",
    emit: () => {},
    async work() { throw new Error("oops"); }
  });
  ok("exception captured as error", env4.errors.some(e => e.code === "task.exception"));
  ok("exception flips status to error", env4.status === "error");
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
