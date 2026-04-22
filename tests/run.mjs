#!/usr/bin/env node
// Tiny test runner. No dependencies.
import { scopeCreds, STRIPPED_PREFIXES } from "../skills/repliclaw/lib/scope-creds.mjs";
import { tryExtractResult } from "../skills/repliclaw/lib/parse-result.mjs";

let fails = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { fails++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg || "not equal"}: ${A} !== ${B}`);
}

console.log("scope-creds:");

t("strips interface tokens unconditionally", () => {
  const env = { SLACK_TOKEN: "x", TELEGRAM_BOT_TOKEN: "x", MATRIX_HOMESERVER: "x" };
  const s = scopeCreds(env, ["SLACK_TOKEN"]); // even if task declares it
  eq(Object.keys(s), []);
});

t("strips parent KERN_AUTH_TOKEN", () => {
  const s = scopeCreds({ KERN_AUTH_TOKEN: "parent" }, []);
  eq("KERN_AUTH_TOKEN" in s, false);
});

t("always passes model keys", () => {
  const env = { OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k" };
  const s = scopeCreds(env, []);
  eq(Object.keys(s).sort(), ["OPENAI_API_KEY","OPENROUTER_API_KEY"]);
});

t("passes task-declared exact names", () => {
  const env = { JIRA_EMAIL: "e", JIRA_API_TOKEN: "t", RANDOM: "no" };
  const s = scopeCreds(env, ["JIRA_EMAIL","JIRA_API_TOKEN"]);
  eq(Object.keys(s).sort(), ["JIRA_API_TOKEN","JIRA_EMAIL"]);
});

t("supports prefix requires", () => {
  const env = { JIRA_EMAIL: "e", JIRA_API_TOKEN: "t", OTHER: "no" };
  const s = scopeCreds(env, ["JIRA_"]);
  eq(Object.keys(s).sort(), ["JIRA_API_TOKEN","JIRA_EMAIL"]);
});

t("STRIPPED_PREFIXES covers all known channels", () => {
  for (const p of ["SLACK_","TELEGRAM_","MATRIX_","DISCORD_","TWILIO_"]) {
    if (!STRIPPED_PREFIXES.includes(p)) throw new Error(`missing ${p}`);
  }
});

console.log("\nparse-result:");

t("ok JSON object", () => {
  const r = tryExtractResult('<<RESULT>>{"status":"ok","data":{"x":1}}');
  eq(r, { kind: "ok", value: { status: "ok", data: { x: 1 } } });
});

t("ok JSON array", () => {
  const r = tryExtractResult('<<RESULT>>[1,2,3]');
  eq(r, { kind: "ok", value: [1,2,3] });
});

t("incomplete when marker missing", () => {
  eq(tryExtractResult("no marker here"), { kind: "incomplete" });
});

t("incomplete when JSON truncated", () => {
  eq(tryExtractResult('<<RESULT>>{"status":"ok","da'), { kind: "incomplete" });
});

t("incomplete when only marker present", () => {
  eq(tryExtractResult('<<RESULT>>'), { kind: "incomplete" });
});

t("malformed when bad char after marker", () => {
  const r = tryExtractResult('<<RESULT>>not json');
  if (r.kind !== "malformed") throw new Error("expected malformed");
});

t("handles escaped quotes in strings", () => {
  const r = tryExtractResult('<<RESULT>>{"msg":"he said \\"hi\\""}');
  eq(r.kind, "ok");
  eq(r.value.msg, 'he said "hi"');
});

t("handles braces inside strings", () => {
  const r = tryExtractResult('<<RESULT>>{"tmpl":"{foo}"}');
  eq(r.kind, "ok");
  eq(r.value.tmpl, "{foo}");
});

t("takes last marker when multiple present", () => {
  const r = tryExtractResult('<<RESULT>>{"old":1} blah <<RESULT>>{"new":2}');
  eq(r, { kind: "ok", value: { new: 2 } });
});

console.log(`\n${fails === 0 ? "✓" : "✗"} ${fails} failures`);
process.exit(fails === 0 ? 0 : 1);
