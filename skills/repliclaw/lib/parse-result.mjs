// Extract a <<RESULT>>{json} payload from streaming assistant text,
// then validate it against the standard envelope schema and (optionally)
// the task's own data schema.
//
// Two-layer model:
//   - envelope (status, taskName, taskVersion, runId, timing, actions, notes,
//     errors, data) is enforced by Repliclaw.
//   - data is task-owned; validated against `outputs_schema` from the task's
//     SKILL.md frontmatter if one is declared.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENVELOPE_SCHEMA_PATH = join(__dirname, "..", "schemas", "envelope.schema.json");

let _ajv = null;
let _envelopeValidator = null;

function ajv() {
  if (!_ajv) {
    _ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(_ajv);
  }
  return _ajv;
}

function envelopeValidator() {
  if (!_envelopeValidator) {
    const schema = JSON.parse(readFileSync(ENVELOPE_SCHEMA_PATH, "utf-8"));
    _envelopeValidator = ajv().compile(schema);
  }
  return _envelopeValidator;
}

/**
 * @typedef {{kind:"ok", value:object}
 *          | {kind:"incomplete"}
 *          | {kind:"malformed", raw:string}
 *          | {kind:"invalid", value:object, errors:Array<{path:string,message:string}>}} ExtractResult
 */

/**
 * Try to find and parse a <<RESULT>> JSON blob in a (possibly partial) stream.
 * Does NOT validate — that's done after the stream completes.
 *
 * @param {string} text
 * @returns {{kind:"ok",value:object}|{kind:"incomplete"}|{kind:"malformed",raw:string}}
 */
export function tryExtractResult(text) {
  const idx = text.lastIndexOf("<<RESULT>>");
  if (idx === -1) return { kind: "incomplete" };
  const tail = text.slice(idx + "<<RESULT>>".length).trimStart();
  if (tail.length === 0) return { kind: "incomplete" };

  const first = tail[0];
  if (first !== "{" && first !== "[") {
    return { kind: "malformed", raw: tail.slice(0, 200) };
  }

  const open = first;
  const close = first === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const jsonStr = tail.slice(0, i + 1);
        try { return { kind: "ok", value: JSON.parse(jsonStr) }; }
        catch { return { kind: "malformed", raw: jsonStr.slice(0, 200) }; }
      }
    }
  }
  return { kind: "incomplete" };
}

// Statuses for which the task's `data` payload is expected to be well-formed
// enough to satisfy its outputs_schema. Error-ish statuses get a pass because
// the task bailed before populating data, by design.
const DATA_VALIDATED_STATUSES = new Set(["ok", "partial"]);

/**
 * Validate a parsed envelope against the standard schema and (optionally) a
 * task-specific data schema plus a task-specific invariants function.
 *
 * Data-schema validation is only performed when `value.status` is "ok" or
 * "partial". Error envelopes (error / timeout / declined / needs-input) are
 * exempt because their data payload is empty/minimal by design.
 *
 * Invariants run only if the envelope + data schema both passed. They express
 * cross-field or stateful checks JSON Schema can't — e.g. "count == len(list)".
 *
 * @param {object} value
 * @param {object} [opts]
 * @param {object} [opts.dataSchema] - optional JSON Schema to validate `data` against
 * @param {(data:object) => Array<{path?:string,message:string}> | Promise<Array<{path?:string,message:string}>>} [opts.invariants]
 *   - optional task-owned function. Return an array of errors (empty = pass).
 * @returns {Promise<{ok:true} | {ok:false, errors:Array<{path:string,message:string}>}>}
 */
export async function validateEnvelope(value, opts = {}) {
  const v = envelopeValidator();
  const errors = [];
  if (!v(value)) {
    for (const e of v.errors || []) {
      errors.push({ path: e.instancePath || "/", message: `${e.message}${e.params ? " " + JSON.stringify(e.params) : ""}` });
    }
  }

  const status = value?.status;
  const shouldValidateData = DATA_VALIDATED_STATUSES.has(status);

  if (opts.dataSchema && shouldValidateData) {
    const dv = ajv().compile(opts.dataSchema);
    if (!dv(value?.data ?? {})) {
      for (const e of dv.errors || []) {
        errors.push({ path: "/data" + (e.instancePath || ""), message: `${e.message}${e.params ? " " + JSON.stringify(e.params) : ""}` });
      }
    }
  }

  // Only run invariants if nothing has failed so far AND data is in scope.
  // Invariants assume a well-typed payload; running them over a schema-invalid
  // blob would just produce noise.
  if (opts.invariants && shouldValidateData && errors.length === 0) {
    try {
      const result = await opts.invariants(value?.data ?? {});
      if (Array.isArray(result)) {
        for (const e of result) {
          if (!e) continue;
          errors.push({
            path: e.path ? `/data${e.path}` : "/data",
            message: `invariant: ${e.message || "failed"}`,
          });
        }
      }
    } catch (err) {
      errors.push({ path: "/data", message: `invariant check threw: ${err?.message || String(err)}` });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Convenience: load a task skill's outputs_schema if one is declared.
 *
 * @param {string} taskSkillDir - directory containing SKILL.md
 * @returns {object|null}
 */
export function loadTaskOutputsSchema(taskSkillDir) {
  const skillPath = join(taskSkillDir, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  const raw = readFileSync(skillPath, "utf-8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];
  const schemaMatch = fm.match(/^outputs_schema:\s*(.+)$/m);
  if (!schemaMatch) return null;
  const schemaRel = schemaMatch[1].trim().replace(/^["']|["']$/g, "");
  const schemaPath = join(taskSkillDir, schemaRel);
  if (!existsSync(schemaPath)) return null;
  try { return JSON.parse(readFileSync(schemaPath, "utf-8")); }
  catch { return null; }
}

/**
 * Load a task skill's invariants function if declared.
 *
 * Looks for an `invariants:` key in SKILL.md frontmatter pointing to a relative
 * ESM module path. The module must export a `check(data)` function that
 * returns (or resolves to) an array of `{path?, message}` error objects —
 * empty array = invariants pass.
 *
 * Invariants complement JSON Schema for cross-field constraints schema can't
 * express (count == len(list), conditional requireds across branches, etc.).
 *
 * @param {string} taskSkillDir - directory containing SKILL.md
 * @returns {Promise<((data:object) => Array<{path?:string,message:string}> | Promise<Array<{path?:string,message:string}>>) | null>}
 */
export async function loadTaskInvariants(taskSkillDir) {
  const skillPath = join(taskSkillDir, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  const raw = readFileSync(skillPath, "utf-8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];
  const mm = fm.match(/^invariants:\s*(.+)$/m);
  if (!mm) return null;
  const rel = mm[1].trim().replace(/^["']|["']$/g, "");
  const modPath = join(taskSkillDir, rel);
  if (!existsSync(modPath)) return null;
  try {
    // Import via file URL for ESM compatibility.
    const url = new URL(`file://${modPath}`).href;
    const mod = await import(url);
    if (typeof mod.check === "function") return mod.check;
    if (typeof mod.default === "function") return mod.default;
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse task SKILL.md frontmatter into a structured object. Best-effort — does
 * not fail on unknown keys. Recognizes:
 *   name, version, description, repliclawEnvelopeVersion, requires, inputs,
 *   outputs_schema, supports_plan_mode, outputs_files.
 *
 * `supports_plan_mode` and `outputs_files` are accepted today but not yet
 * enforced at runtime — reserved for task skills to declare forward-compatibly.
 *
 * @param {string} taskSkillDir - directory containing SKILL.md
 * @returns {object|null} parsed frontmatter fields, or null if no SKILL.md/frontmatter
 */
export function parseTaskFrontmatter(taskSkillDir) {
  const skillPath = join(taskSkillDir, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  const raw = readFileSync(skillPath, "utf-8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];

  const out = {};
  const scalar = (k) => {
    const re = new RegExp(`^${k}:\\s*(.+)$`, "m");
    const mm = fm.match(re);
    if (!mm) return undefined;
    return mm[1].trim().replace(/^["']|["']$/g, "");
  };
  const bool = (k) => {
    const s = scalar(k);
    if (s === undefined) return undefined;
    return /^(true|yes|1)$/i.test(s);
  };
  const list = (k) => {
    // supports "key: [a, b, c]" inline form and "key:\n  - a\n  - b" block form
    const inline = new RegExp(`^${k}:\\s*\\[([^\\]]*)\\]\\s*$`, "m");
    const mm1 = fm.match(inline);
    if (mm1) return mm1[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const block = new RegExp(`^${k}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m");
    const mm2 = fm.match(block);
    if (mm2) return mm2[1].split("\n").map(l => l.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    return undefined;
  };

  const name = scalar("name");
  const version = scalar("version");
  const description = scalar("description");
  const envelopeVersion = scalar("repliclawEnvelopeVersion");
  const outputsSchema = scalar("outputs_schema");
  const invariants = scalar("invariants");
  const supportsPlanMode = bool("supports_plan_mode");
  const requires = list("requires");
  const outputsFiles = list("outputs_files");

  if (name !== undefined) out.name = name;
  if (version !== undefined) out.version = version;
  if (description !== undefined) out.description = description;
  if (envelopeVersion !== undefined) out.repliclawEnvelopeVersion = envelopeVersion;
  if (outputsSchema !== undefined) out.outputs_schema = outputsSchema;
  if (invariants !== undefined) out.invariants = invariants;
  if (requires !== undefined) out.requires = requires;
  if (supportsPlanMode !== undefined) out.supports_plan_mode = supportsPlanMode;
  if (outputsFiles !== undefined) out.outputs_files = outputsFiles;

  return out;
}
