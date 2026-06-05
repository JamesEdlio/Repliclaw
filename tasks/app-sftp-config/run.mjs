#!/usr/bin/env node
// app-sftp-config task skill — deterministic executable.
//
// Runs under repliclaw with `exec:` frontmatter. Reads task inputs from
// stdin as JSON, emits a Repliclaw <<RESULT>> envelope on stdout.
//
// Flow (see ./SKILL.md for full spec):
//   1.  GET Forge ticket; type-guard APP_SFTP
//   2.  Idempotency guard ([app-sftp-config] marker)
//   3.  Edlio auth (cached refresh-token → password+TOTP fallback)
//   4.  Resolve Edlio FTP account by FileMage username
//   5.  SFTP-list + sample first ~50 rows of each .csv
//   6.  Classify each CSV by role (filename + column heuristics)
//   7.  Per-role fuzzy column mapping vs canonical aliases
//   8.  Build SchemaMapping payload
//   9.  Upsert SchemaMapping (create / update / reuse)
//   10. Apply per-role sync config to FTP account (V3 default)
//   11. Link SchemaMapping to FTP account; UpdateFtpAccount
//   12. POST Forge comment with [app-sftp-config] marker
//
// Idempotent on re-run via marker check + UpdateFtpAccount being PUT-ish.

import { readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { modelMapAll, modelMappingToRoleMapping } from "./lib/model-mapper.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SKILL_VERSION = "0.3.4";
const TASK_NAME = "app-sftp-config";

const SFTP_HOST = process.env.FILEMAGE_SFTP_HOST || "52.165.175.27";
const SFTP_PORT = Number(process.env.FILEMAGE_SFTP_PORT || 22);
const FILEMAGE_SSH_KEY = process.env.FILEMAGE_SSH_KEY || `${process.env.HOME || ""}/.ssh/filemage_ed25519`;

const MARKER_TAG = "[app-sftp-config]";
const MARKER_EVENT = "configured";
const APPSFTP_MARKER_TAG = "[app-sftp]";  // upstream skill's marker — confirms email was sent

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_WRITE_TIMEOUT_MS = 60_000;

// Edith's filemage SSH key — fingerprint is stable, used to detect presence.
// Hoisted to module top so it's available inside the top-level `await main()`
// block (TDZ safety — see Step 4.5 / ensureFileMageKey()).
const EDITH_KEY_FINGERPRINT_MD5 = "28:bd:3d:21:1f:e2:61:fd:fc:c2:11:e0:43:fc:18:c7";
const EDITH_KEY_TITLE = "edith-agent";

// Edlio API constants — hoisted to module top so the `await main()` block
// (which runs before later top-level statements execute) can reach them.
const EDLIO_API = "https://edlio-connect.schoolinfo.app";
const EDLIO_CLIENT_ID = "schoolinfoapp_dashboard";

const SAMPLE_ROW_LIMIT = 50;
const ALIAS_AUTO_THRESHOLD = 0.85;

// Person roles we sync. Each gets a *Settings block on both the SchemaMapping
// and the FTP account.
const ACTIVE_ROLES = ["student", "teacher", "staff", "parent", "guardian", "relative", "administrator"];

// Non-person sync entities. Each gets its own SchemaMapping sub-model + FTP-
// account-level toggle. Grade/lineItem are deferred — different field shape.
const NONPERSON_ROLES = ["classroom", "enrollment"];

// Roles whose sync we MUST disable even when the spec mentions them.
const FORCE_DISABLED_ROLES = ["aide"];

// Repliclaw-passed env (REPLICLAW_RUN_ID is set by run.mjs in core skill).
const runId = process.env.REPLICLAW_RUN_ID || "run_unknown";

// ==========================================================================
// fetch with hard timeout
// ==========================================================================

async function fetchT(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`HTTP timeout after ${timeoutMs}ms: ${opts.method || "GET"} ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function withRetry(label, fn, { attempts = 4, baseMs = 100 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const wait = baseMs * Math.pow(4, i);
      process.stderr.write(`[retry] ${label} ${i + 1}/${attempts} failed: ${err.message}; sleeping ${wait}ms\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ==========================================================================
// Bootstrap
// ==========================================================================

/**
 * Some inputs (field_overrides, role_assignments) are objects when dispatched
 * directly via the API, but arrive as JSON *strings* when entered through the
 * Forge RunModal (all config-field values are serialized to strings there).
 * Accept both: parse strings into objects, pass objects through, treat blank
 * or invalid as undefined so the `|| {}` fallback applies.
 */
function parseMaybeJson(val) {
  if (val == null) return undefined;
  if (typeof val === "object") return val;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Invalid JSON in input: ${err.message} — got: ${trimmed.slice(0, 120)}`);
    }
  }
  return undefined;
}

const inputs = readInputsFromStdin();
const dryRun = inputs.dry_run === true;
const triggeredBy = typeof inputs.triggered_by === "string" && inputs.triggered_by
  ? inputs.triggered_by : null;
const mode = inputs.mode === "v2" ? "v2" : "v3";

const ctx = {
  runId,
  ticketKey: inputs.ticket_key,
  dryRun,
  triggeredBy,
  mode,
  forceRerun: inputs.force_rerun === true,
  applyMapping: inputs.apply_mapping === true || inputs.apply_mapping === "true",
  schemaMappingIdOverride: inputs.schema_mapping_id || null,
  filemageUsernameOverride: inputs.filemage_username || null,
  fieldOverrides: parseMaybeJson(inputs.field_overrides) || {},
  roleAssignments: parseMaybeJson(inputs.role_assignments) || {},
  actions: [],
  notes: [],
  errors: [],
  _startedAt: new Date().toISOString(),
};

const ROLE_CONFIG = JSON.parse(readFileSync(resolve(__dirname, "assets/role-config.json"), "utf-8"));
const ALIASES = JSON.parse(readFileSync(resolve(__dirname, "assets/aliases.json"), "utf-8"));

try {
  await main();
} catch (err) {
  recordError("pipeline", err);
  emitResult({
    status_reason: "error",
    ticket: { key: ctx.ticketKey || "unknown" },
  }, "error");
  process.exit(1);
}

// ==========================================================================
// Main pipeline
// ==========================================================================

async function main() {
  if (!ctx.ticketKey) throw new Error("ticket_key required in inputs");

  // -- Step 1: Forge ticket
  const ticket = await forgeGetTicket(ctx.ticketKey);
  recordAction({ type: "forge.ticket.read", status: "success", ref: ticket.key });

  // -- Step 2: type guard
  if (ticket.product !== "APP" || ticket.integrationType !== "APP_SFTP") {
    recordNote(
      `wrong type: product=${ticket.product} integrationType=${ticket.integrationType}; ` +
      `app-sftp-config only handles APP_SFTP tickets`,
      "guard", "warn"
    );
    return done({
      status_reason: "wrong_type",
      ticket: ticketSummary(ticket),
    }, "declined");
  }

  // -- Step 3: idempotency guard
  const prior = findPriorMarker(ticket.comments || []);
  if (prior && !ctx.forceRerun) {
    recordNote(
      `prior ${MARKER_TAG} ${MARKER_EVENT} marker found (run_id=${prior.run_id}, ts=${prior.ts}); short-circuiting`,
      "idempotency", "info"
    );
    return done({
      status_reason: "already_done",
      ticket: ticketSummary(ticket),
      prior_run: prior,
    }, "ok");
  }

  // Sanity: confirm app-sftp ran first (setup email was sent). This catches
  // the case where someone drags the configurator before the FTP account
  // exists or before the client has been told to upload anything.
  const priorAppSftp = findAppSftpMarker(ticket.comments || []);
  if (!priorAppSftp && !ctx.forceRerun) {
    recordNote(
      `no upstream ${APPSFTP_MARKER_TAG} setup-sent marker on ticket — ` +
      `app-sftp may not have run yet. Continuing best-effort; FTP-account ` +
      `lookup will fail-fast if there's no Edlio FTP account.`,
      "ordering", "warn"
    );
  }

  // -- Step 4: Edlio FTP account lookup
  const username = ctx.filemageUsernameOverride || deriveFileMageUsername(ticket.schoolName);
  const ftpAccount = await edlioFindFtpAccount(username);
  if (!ftpAccount) {
    recordError("edlio.ftp.notfound", new Error(
      `no Edlio FTP account with userName=${username}; ` +
      `run app-sftp first to provision the FTP account`
    ));
    return done({
      status_reason: "needs_filemage",
      ticket: ticketSummary(ticket),
      ftp_account: null,
    }, "error");
  }
  recordAction({
    type: "edlio.ftp.read",
    status: "success",
    ref: `edlio:ftp:${ftpAccount.id}`,
    details: {
      userName: ftpAccount.userName,
      district_id: ftpAccount.districtId,
      district_name: ftpAccount.districtName || null,
      schemaMappingId: ftpAccount.syncSchema?.id || null,
      enabled: ftpAccount.enabled,
    },
  });

  // -- Step 4.5: FileMage SSH-key preflight
  // Ensure Edith's pubkey is authorized on this user's FileMage account
  // before we try to sftp into it. Idempotent: skips if already present.
  try {
    const keyResult = await ensureFileMageKey(username);
    recordAction({
      type: "filemage.key.attach",
      status: keyResult.alreadyHad ? "skipped" : "success",
      ref: `filemage:user:${keyResult.user.id}`,
      details: {
        username,
        fingerprint: EDITH_KEY_FINGERPRINT_MD5,
        already_authorized: keyResult.alreadyHad,
      },
    });
    if (keyResult.attached) {
      recordNote(
        `attached edith-agent pubkey to filemage user ${username} (id=${keyResult.user.id}) — was not previously authorized`,
        "preflight",
        "info"
      );
    }
  } catch (err) {
    recordError("filemage.key.attach", err);
    return done({
      status_reason: "filemage_key_failed",
      ticket: ticketSummary(ticket),
      ftp_account: ftpAccountSummary(ftpAccount),
    }, "error");
  }

  // -- Step 5: SFTP list + sample
  let csvs;
  try {
    csvs = await sftpListAndSample(username);
  } catch (err) {
    recordError("sftp.connect", err);
    return done({
      status_reason: "sftp_failed",
      ticket: ticketSummary(ticket),
      ftp_account: ftpAccountSummary(ftpAccount),
    }, "error");
  }
  recordAction({
    type: "sftp.file.list",
    status: csvs.length ? "success" : "skipped",
    details: { user: username, host: SFTP_HOST, file_count: csvs.length },
  });

  if (!csvs.length) {
    recordNote(
      `no .csv files in ~${username}/ on ${SFTP_HOST}. ` +
      `Client probably hasn't uploaded their first sync batch yet.`,
      "no_files", "warn"
    );
    return done({
      status_reason: "no_files",
      ticket: ticketSummary(ticket),
      ftp_account: ftpAccountSummary(ftpAccount),
      csvs: [],
    }, "needs-input");
  }

  // -- Step 6: classify each CSV by role.
  //
  // Model pre-pass: hand the model all CSV headers + sample rows + the Edlio
  // schema and let it classify roles AND map columns in one shot. The
  // deterministic alias matcher (classifyCsv / mapRoleColumns) remains as the
  // fallback when the model is unavailable or unsure. Operator overrides
  // (role_assignments / field_overrides) always win.
  let modelResult = null;
  if (!Object.keys(ctx.roleAssignments).length || Object.keys(ctx.fieldOverrides).length === 0) {
    try {
      modelResult = await modelMapAll(csvs, ALIASES, {
        activeRoles: ACTIVE_ROLES,
        nonpersonRoles: NONPERSON_ROLES,
      });
    } catch (err) {
      modelResult = { ok: false, reason: err.message };
    }
    recordAction({
      type: "schema.model.map",
      status: modelResult?.ok ? "success" : "skipped",
      details: modelResult?.ok
        ? {
            model: modelResult.model,
            files_classified: Object.keys(modelResult.classifications || {}).length,
            roles_mapped: Object.keys(modelResult.mappings || {}).length,
            dropped_hallucinated_columns: modelResult.dropped_hallucinated_columns || 0,
          }
        : { reason: modelResult?.reason || "model unavailable; using alias matcher" },
    });
  }
  const modelClass = (modelResult?.ok && modelResult.classifications) || {};

  for (const f of csvs) {
    const assigned = ctx.roleAssignments[f.filename];
    if (assigned !== undefined) {
      // Operator override
      f.classified_role = assigned;  // can be null = "ignore"
      f.classification_via = "operator_override";
      f.confidence = 1;
      continue;
    }
    const guess = classifyCsv(f);
    f.classified_role = guess.role;
    f.confidence = guess.score;
    f.classification_via = guess.via;

    // If the deterministic matcher was unsure but the model classified this
    // file, adopt the model's role.
    const unsureHeuristic =
      f.classified_role === undefined ||
      (f.classification_via === "heuristic" && (f.confidence || 0) < 0.5);
    if (unsureHeuristic && Object.prototype.hasOwnProperty.call(modelClass, f.filename)) {
      const mrole = modelClass[f.filename];
      f.classified_role = mrole === null ? null : mrole;
      f.classification_via = "model";
      f.confidence = 0.75;
    }
  }

  // Deterministic multi-promotion guard.
  //
  // The model (and the alias matcher) sometimes pins an all-people roster file
  // to ONE person role — e.g. classifying a users.csv as just "staff" when it
  // actually carries Students, Teachers, Parents, etc. (SS-273: users.csv with
  // Student ID / Grade / Relationship ID columns and a Role column whose values
  // are "Student" got called "staff"). If we honor that literally, only the one
  // role is mapped and the rest of the roster is silently dropped — and the
  // mapping written to Edlio is simply wrong.
  //
  // So: if a file is single-classified as a PERSON role but its columns show it
  // serves multiple person types, promote it to "multi" so every person role is
  // mapped from it. Signals (any one):
  //   - a Role/UserType column (mixed person types live in one file), OR
  //   - BOTH a student-id-ish AND an employee-id-ish column present.
  const PERSON_ROLES_SET = new Set(["student", "teacher", "staff", "parent", "guardian", "relative", "administrator"]);
  for (const f of csvs) {
    if (!PERSON_ROLES_SET.has(f.classified_role)) continue;
    if (ctx.roleAssignments[f.filename] !== undefined) continue; // respect explicit operator choice
    const hl = (f.headers || []).map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
    const hasRoleCol = hl.some(h => h === "role" || h === "user_type" || h === "usertype" || h === "person_type" || h.includes("role_type"));
    const hasStudentId = hl.some(h => h.includes("student") && h.includes("id"));
    const hasEmployeeId = hl.some(h => h.includes("employee") && h.includes("id"));
    if (hasRoleCol || (hasStudentId && hasEmployeeId)) {
      f.classified_role = "multi";
      f.classification_via = "multi_promoted";
      f.confidence = Math.max(f.confidence || 0, 0.8);
    }
  }
  recordAction({
    type: "csv.classify",
    status: "success",
    details: {
      file_count: csvs.length,
      classifications: csvs.map(f => ({
        filename: f.filename, role: f.classified_role,
        confidence: Number((f.confidence || 0).toFixed(2)),
        via: f.classification_via,
      })),
    },
  });

  // Identify unclassified files (still unsure even after model assist).
  const unclassified = csvs.filter(f =>
    f.classified_role === undefined ||
    (f.classification_via === "heuristic" && f.confidence < 0.5)
  );
  if (unclassified.length && !ctx.forceRerun) {
    return done({
      status_reason: "needs_input",
      ticket: ticketSummary(ticket),
      ftp_account: ftpAccountSummary(ftpAccount),
      csvs: csvs.map(csvSummary),
      needs_input: {
        unclassified_files: unclassified.map(f => ({
          filename: f.filename,
          best_guess: f.classified_role,
          confidence: f.confidence,
          headers: f.headers,
        })),
        summary: `${unclassified.length} file(s) couldn't be confidently classified by role. ` +
          `Provide role_assignments input on rerun: ` +
          `{"${unclassified[0].filename}": "student|teacher|staff|parent|administrator|relative|classroom|enrollment|null"}`,
      },
    }, "needs-input");
  }

  // -- Step 7: per-role column mapping.
  // Per role: operator override > model mapping > alias matcher.
  const modelMappings = (modelResult?.ok && modelResult.mappings) || {};
  const sampleRowsByFile = Object.fromEntries(
    csvs.map(f => [f.filename, f.sampleRows || []])
  );

  // Index the model's field mappings by source file. A single CSV (e.g.
  // users.csv) often serves MANY person roles ("multi"), but the model only
  // emits one mappings entry per file (keyed under whichever role it picked).
  // Build a filename -> { fields, csv_file } index so every role sharing that
  // file can reuse the model's column mapping instead of silently dropping to
  // the alias matcher (which is exactly what left teacher/administrator's
  // employeeIdFieldName unmapped on SS-273).
  const modelByFile = {};
  for (const me of Object.values(modelMappings)) {
    if (me && me.csv_file && !modelByFile[me.csv_file]) {
      modelByFile[me.csv_file] = me;
    }
  }

  const roleMappings = {};   // role -> { csv_file, auto_mapped, low_confidence, missing_required, proposal?, source }
  const presentRoles = new Set();

  const mapOneRole = (role, f) => {
    const override = ctx.fieldOverrides[role];
    // Model mapping for this role: prefer a role-specific entry, otherwise fall
    // back to whatever the model mapped for this file (shared across roles on a
    // multi file). Re-evaluate required fields against THIS role's schema.
    const me = modelMappings[role] && (!modelMappings[role].csv_file || modelMappings[role].csv_file === f.filename)
      ? modelMappings[role]
      : modelByFile[f.filename];
    if (me) {
      const mm = modelMappingToRoleMapping(role, me, ALIASES, sampleRowsByFile);
      // Layer operator field_overrides on top of the model proposal.
      if (override && typeof override === "object") {
        for (const [field, ov] of Object.entries(override)) {
          if (ov && ov.csv_column) mm.auto_mapped[field] = ov.csv_column;
          else delete mm.auto_mapped[field];
        }
      }
      // Recompute required-field gaps for THIS role (a multi file's shared
      // mapping may satisfy student but still miss employeeIdFieldName for
      // teacher). The model's fields are role-agnostic column picks; required
      // sets differ per role.
      mm.missing_required = ((ALIASES.role_required_fields || {})[role] || [])
        .filter(fld => !mm.auto_mapped[fld]);
      mm.source = "model";
      return mm;
    }
    // Fallback: deterministic alias matcher.
    return mapRoleColumns(role, f, override);
  };

  // When more than one file serves the same person role (e.g. BOTH users.csv
  // and staff.csv classify 'multi' and each can serve teacher/administrator),
  // we must NOT blindly last-write-wins: CSV listing order would otherwise let
  // a weaker file (users.csv, no Employee ID column) clobber a complete mapping
  // from a stronger file (staff.csv, has Employee ID) and re-trigger the gate.
  // Prefer the candidate that satisfies more required fields for THIS role;
  // tie-break on more fields mapped overall, then keep the incumbent (stable).
  const assignRole = (role, f) => {
    const cand = mapOneRole(role, f);
    cand.csv_file = cand.csv_file || f.filename;
    const cur = roleMappings[role];
    presentRoles.add(role);
    if (!cur) { roleMappings[role] = cand; return; }
    const candMissing = (cand.missing_required || []).length;
    const curMissing = (cur.missing_required || []).length;
    if (candMissing < curMissing) { roleMappings[role] = cand; return; }
    if (candMissing > curMissing) return; // keep incumbent (better coverage)
    const candMapped = Object.keys(cand.auto_mapped || {}).length;
    const curMapped = Object.keys(cur.auto_mapped || {}).length;
    if (candMapped > curMapped) roleMappings[role] = cand;
    // else keep incumbent (stable)
  };

  // Employee-family roles all share the same source schema (they carry an
  // Employee ID and are distinguished by a Role column). A roster commonly
  // ships ONE staff/employee file that serves staff + teacher + administrator,
  // but the model may classify that file as just "staff" (single role). If we
  // honored that literally, teacher/administrator would fall through to a
  // person-multi file (e.g. users.csv) that has NO Employee ID column and
  // re-gate on employeeIdFieldName forever (SS-273). So: when a file is
  // single-classified as one employee role, also OFFER it to the other
  // employee roles via the coverage-aware assignRole — it only wins where it
  // actually covers more required fields (i.e. it has the Employee ID).
  const EMPLOYEE_FAMILY = ["staff", "teacher", "administrator"];

  // For a "multi" file, figure out which person roles actually appear in it by
  // reading the Role/UserType column values. Forcing ALL seven person roles on
  // a file that only contains Students would create teacher/administrator
  // entries that miss employeeIdFieldName and re-gate forever. Map the value
  // text to our canonical roles; if there's no role column (or nothing maps),
  // fall back to all ACTIVE_ROLES (old behavior).
  const detectMultiRoles = (f) => {
    const headers = f.headers || [];
    const roleHeader = headers.find(h => {
      const n = h.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      return n === "role" || n === "user_type" || n === "usertype" || n === "person_type";
    });
    if (!roleHeader) return ACTIVE_ROLES;
    const seen = new Set();
    for (const row of (f.sampleRows || [])) {
      const raw = String(row?.[roleHeader] || "").toLowerCase().trim();
      if (!raw) continue;
      if (raw.includes("student")) seen.add("student");
      else if (raw.includes("teacher") || raw.includes("faculty") || raw.includes("instructor")) seen.add("teacher");
      else if (raw.includes("admin") || raw.includes("principal")) seen.add("administrator");
      else if (raw.includes("parent")) seen.add("parent");
      else if (raw.includes("guardian")) seen.add("guardian");
      else if (raw.includes("relative")) seen.add("relative");
      else if (raw.includes("staff") || raw.includes("employee")) seen.add("staff");
    }
    const roles = ACTIVE_ROLES.filter(r => seen.has(r));
    return roles.length ? roles : ACTIVE_ROLES;
  };

  for (const f of csvs) {
    if (!f.classified_role || f.classified_role === "multi") {
      const roles = f.classified_role === "multi" ? detectMultiRoles(f) : [];
      f.detected_multi_roles = roles;
      for (const role of roles) assignRole(role, f);
      continue;
    }
    if (FORCE_DISABLED_ROLES.includes(f.classified_role)) continue;
    const role = f.classified_role;
    if (!ACTIVE_ROLES.includes(role) && !NONPERSON_ROLES.includes(role)) continue;
    // A single-classified file is authoritative for its own role; assign directly
    // (it should win over any multi-file guess for the same role).
    roleMappings[role] = mapOneRole(role, f);
    roleMappings[role].csv_file = roleMappings[role].csv_file || f.filename;
    presentRoles.add(role);
    // Employee-family fan-out: offer this employee file to its sibling roles too,
    // letting coverage win (staff.csv with Employee ID beats users.csv without).
    if (EMPLOYEE_FAMILY.includes(role)) {
      for (const sib of EMPLOYEE_FAMILY) {
        if (sib === role || !ACTIVE_ROLES.includes(sib)) continue;
        assignRole(sib, f);
      }
    }
  }

  // Auto-fill `fileName` for non-person roles (classroom/enrollment). This is a
  // required field but it is NOT a CSV column — it is the source file's own
  // name, which we already know from classification. Neither the model nor the
  // alias matcher can/should "map" it from a column, so fill it deterministically
  // and remove it from missing_required. (Without this, classroom/enrollment
  // would always block on a phantom required field.)
  for (const role of NONPERSON_ROLES) {
    const m = roleMappings[role];
    if (!m) continue;
    if (!m.auto_mapped.fileName && m.csv_file) {
      m.auto_mapped.fileName = m.csv_file;
    }
    m.missing_required = ((ALIASES.role_required_fields || {})[role] || [])
      .filter(fld => !m.auto_mapped[fld]);
  }

  // -- Step 7b: gating.
  //
  // Decide between three outcomes:
  //   1. Model produced a proposal  -> park as awaiting_mapping_approval and show
  //      the per-field proposal (including any still-missing required fields,
  //      flagged inline) so the operator can review + Apply, or correct via
  //      field_overrides. This is the primary path now.
  //   2. No model proposal (alias-only) but required fields missing -> the old
  //      bare needs_input gate (operator must supply field_overrides).
  //   3. Everything mapped and approved (apply_mapping / dry run) -> proceed.
  const usedModel = Object.values(roleMappings).some(m => m.source === "model");
  const rolesNeedingInput = Object.entries(roleMappings).filter(
    ([_, m]) => m.missing_required.length > 0
  );

  recordAction({
    type: "schema.fields.match",
    status: "success",
    details: Object.fromEntries(
      Object.entries(roleMappings).map(([role, m]) => [
        role,
        { auto: Object.keys(m.auto_mapped).length, missing: m.missing_required.length, low_confidence: m.low_confidence.length, source: m.source || "alias" },
      ])
    ),
  });

  // Build the review-friendly proposal block (used by the approval gate and the
  // apply-blocked guard).
  const buildProposal = () => ({
    model: modelResult?.model || null,
    roles: Object.fromEntries(
      Object.entries(roleMappings).map(([role, m]) => [
        role,
        {
          csv_file: m.csv_file,
          source: m.source || "alias",
          missing_required: m.missing_required,
          fields: m.proposal || Object.entries(m.auto_mapped).map(([field, col]) => ({
            field, csv_column: col, confidence: 1, rationale: "alias match",
          })),
        },
      ])
    ),
    summary:
      (usedModel
        ? `Model proposed a mapping for ${Object.keys(roleMappings).length} role(s). `
        : `Proposed mapping for ${Object.keys(roleMappings).length} role(s). `) +
      (rolesNeedingInput.length
        ? `${rolesNeedingInput.length} role(s) still need a required field — correct via field_overrides, then Apply. `
        : `Review the columns below; click Apply mapping to write it to Edlio, ` +
          `or rerun with field_overrides to correct any field.`),
  });

  // Path 1: model proposal awaiting approval (not yet applied).
  if (usedModel && !ctx.applyMapping && !ctx.forceRerun && !dryRun) {
    return done({
      status_reason: "awaiting_mapping_approval",
      ticket: ticketSummary(ticket),
      ftp_account: ftpAccountSummary(ftpAccount),
      csvs: csvs.map(csvSummary),
      role_mappings: roleMappings,
      mapping_proposal: buildProposal(),
    }, "needs-input");
  }

  // Path 2 / apply guard: required fields still missing. Never write a partial
  // mapping to Edlio even if apply_mapping was set — re-park with the proposal
  // (if model) or the bare needs_input gate (alias-only) so the operator fixes
  // the gap before anything is written.
  if (rolesNeedingInput.length && !ctx.forceRerun) {
    if (usedModel) {
      return done({
        status_reason: "awaiting_mapping_approval",
        ticket: ticketSummary(ticket),
        ftp_account: ftpAccountSummary(ftpAccount),
        csvs: csvs.map(csvSummary),
        role_mappings: roleMappings,
        mapping_proposal: buildProposal(),
      }, "needs-input");
    }
    return done({
      status_reason: "needs_input",
      ticket: ticketSummary(ticket),
      ftp_account: ftpAccountSummary(ftpAccount),
      csvs: csvs.map(csvSummary),
      role_mappings: roleMappings,
      needs_input: {
        unmapped_fields: Object.fromEntries(
          rolesNeedingInput.map(([role, m]) => [
            role,
            {
              missing: m.missing_required,
              low_confidence_guesses: m.low_confidence,
              csv_file: m.csv_file,
            },
          ])
        ),
        summary: `${rolesNeedingInput.length} role(s) missing required field mappings. ` +
          `Provide field_overrides input on rerun: ` +
          `{"<role>": {"<edlio_field>": {"csv_column": "<colname>" | null}}}`,
      },
    }, "needs-input");
  }


  // -- Step 8: build SchemaMapping payload
  const mappingPayload = buildSchemaMappingPayload({
    ticket, ftpAccount, csvs, roleMappings, presentRoles,
  });

  // -- Step 9: upsert SchemaMapping
  let schemaMapping;
  if (dryRun) {
    recordAction({
      type: "edlio.schemamapping.upsert",
      status: "skipped",
      details: { dry_run: true, name: mappingPayload.name, action_planned: ctx.schemaMappingIdOverride ? "update" : "create_or_update" },
    });
    schemaMapping = { id: 0, name: mappingPayload.name, action: "skipped" };
  } else {
    schemaMapping = await upsertSchemaMapping(mappingPayload);
    recordAction({
      type: "edlio.schemamapping.upsert",
      status: "success",
      ref: `edlio:schemamapping:${schemaMapping.id}`,
      details: { id: schemaMapping.id, name: schemaMapping.name, action: schemaMapping.action },
    });
  }

  // -- Step 10 + 11 + 12: apply per-role config + link mapping; UpdateFtpAccount
  let appliedRoles = [];
  if (dryRun) {
    appliedRoles = Array.from(presentRoles);
    recordAction({
      type: "edlio.ftp.update",
      status: "skipped",
      details: {
        dry_run: true,
        roles_to_apply: appliedRoles,
        schemaMappingId: schemaMapping.id,
        enabled: ftpAccount.enabled,  // unchanged
      },
    });
  } else {
    appliedRoles = await applyFtpAccountConfig({
      ftpAccount,
      schemaMappingId: schemaMapping.id,
      presentRoles,
      mode,
    });
    recordAction({
      type: "edlio.ftp.update",
      status: "success",
      ref: `edlio:ftp:${ftpAccount.id}`,
      details: {
        roles_applied: appliedRoles,
        schemaMappingId: schemaMapping.id,
        enabled: ftpAccount.enabled,
      },
    });
  }

  // -- Step 13: Forge comment with marker
  const commentBody = renderForgeComment({
    ticket, ftpAccount, schemaMapping, csvs, roleMappings,
    appliedRoles, mode, prior,
  });
  if (dryRun) {
    recordAction({
      type: "forge.comment.create",
      status: "skipped",
      details: { dry_run: true, body_preview: commentBody.slice(0, 200) },
    });
  } else {
    await withRetry("forge.comment.create", () =>
      forgePostComment(ticket.key, commentBody)
    );
    recordAction({
      type: "forge.comment.create",
      status: "success",
      ref: ticket.key,
    });
  }

  return done({
    status_reason: "configured",
    ticket: ticketSummary(ticket),
    ftp_account: {
      ...ftpAccountSummary(ftpAccount),
      schemaMappingId: schemaMapping.id,
      rolesApplied: appliedRoles,
    },
    schema_mapping: {
      id: schemaMapping.id,
      name: schemaMapping.name,
      description: mappingPayload.description,
      action: schemaMapping.action,
      hasMultipleFiles: mappingPayload.hasMultipleFiles,
      organizationIdentifierInFiles: mappingPayload.organizationIdentifierInFiles,
      acceptedFileNames: mappingPayload.acceptedFileNames,
    },
    csvs: csvs.map(csvSummary),
    role_mappings: roleMappings,
  }, "ok");
}

// ==========================================================================
// Forge API
// ==========================================================================

function forgeUrl(path) {
  const base = process.env.FORGE_URL || process.env.FORGE_BASE_URL ||
    "https://forge-production-0cfd.up.railway.app";
  return `${base.replace(/\/$/, "")}${path}`;
}

function forgeHeaders() {
  const secret = process.env.FORGE_SHARED_SECRET;
  if (!secret) throw new Error("FORGE_SHARED_SECRET not in env");
  return {
    "x-forge-secret": secret,
    "content-type": "application/json",
  };
}

async function forgeGetTicket(key) {
  const res = await fetchT(forgeUrl(`/api/tickets/${encodeURIComponent(key)}`), {
    headers: forgeHeaders(),
  });
  if (!res.ok) throw new Error(`forge GET ticket -> ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.ticket;
}

async function forgePostComment(key, body) {
  const res = await fetchT(forgeUrl(`/api/tickets/${encodeURIComponent(key)}/comments`), {
    method: "POST",
    headers: forgeHeaders(),
    body: JSON.stringify({ body }),
  }, FETCH_WRITE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`forge POST comment -> ${res.status}: ${await res.text()}`);
  return (await res.json()).comment;
}

function findPriorMarker(comments) {
  return findMarker(comments, MARKER_TAG, MARKER_EVENT);
}

function findAppSftpMarker(comments) {
  return findMarker(comments, APPSFTP_MARKER_TAG, "setup-sent");
}

function findMarker(comments, tag, event) {
  const sorted = [...comments].sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt));
  const escTag = tag.replace(/[[\]]/g, m => "\\" + m);
  const re = new RegExp(`${escTag}\\s+${event}\\s+run_id=(\\S+)\\s+ts=(\\S+)\\s+skill_version=(\\S+)`);
  for (const c of sorted) {
    const m = c.body?.match(re);
    if (m) return { run_id: m[1], ts: m[2], skill_version: m[3], comment_id: c.id };
  }
  return null;
}

// ==========================================================================
// Edlio dashboard API
// (constants EDLIO_API, EDLIO_CLIENT_ID are hoisted to top of file)
// ==========================================================================

function edlioCachePath() {
  return process.env.EDLIO_TOKEN_CACHE_PATH ||
    `${process.env.HOME || "/tmp"}/.edlio_token_cache.json`;
}

function edlioReadCache() {
  try { return JSON.parse(readFileSync(edlioCachePath(), "utf-8")); }
  catch { return null; }
}

function edlioWriteCache(data) {
  try {
    const path = edlioCachePath();
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (err) {
    process.stderr.write(`[edlio] cache write failed: ${err.message}\n`);
  }
}

async function edlioFormPost(params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetchT(`${EDLIO_API}/api/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }, FETCH_WRITE_TIMEOUT_MS);
  const text = await res.text();
  if (!res.ok) throw new Error(`edlio /api/token -> ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`edlio /api/token -> bad JSON: ${text.slice(0, 200)}`); }
}

async function edlioFullLogin() {
  const username = process.env.EDLIOAPP_USER;
  const opItemId = process.env.EDLIOAPP_OP_ITEM_ID;
  const opVault = process.env.EDLIOAPP_OP_VAULT || "Agent: Edith";
  if (!username) throw new Error("EDLIOAPP_USER not in env");
  if (!opItemId) throw new Error("EDLIOAPP_OP_ITEM_ID not in env");

  const pwResult = spawnSync("op",
    ["item", "get", opItemId, "--vault", opVault, "--fields=password", "--reveal"],
    { env: opEnv(), encoding: "utf-8" });
  if (pwResult.status !== 0) throw new Error(`op fetch password failed: ${pwResult.stderr || pwResult.stdout}`);
  const password = pwResult.stdout.trim();
  if (!password) throw new Error("edlio password from 1Password was empty");

  const otpResult = spawnSync("op",
    ["item", "get", opItemId, "--vault", opVault, "--otp"],
    { env: opEnv(), encoding: "utf-8" });
  if (otpResult.status !== 0) throw new Error(`op fetch otp failed: ${otpResult.stderr || otpResult.stdout}`);
  const totp = otpResult.stdout.trim();
  if (!/^\d{6}$/.test(totp)) throw new Error(`edlio TOTP malformed`);

  const r1 = await edlioFormPost({
    grant_type: "password", username, password, client_id: EDLIO_CLIENT_ID,
  });
  if (!r1.totpToken) {
    if (r1.access_token) {
      return { accessToken: r1.access_token, refreshToken: r1.refresh_token || null, expiresIn: r1.expires_in || 1800 };
    }
    throw new Error(`edlio password grant returned no totpToken: ${Object.keys(r1).join(",")}`);
  }
  const r2 = await edlioFormPost({
    grant_type: "totp_token", totp_token: r1.totpToken, totp_password: totp, client_id: EDLIO_CLIENT_ID,
  });
  if (!r2.access_token) throw new Error(`edlio totp grant returned no access_token`);
  return {
    accessToken: r2.access_token,
    refreshToken: r2.refresh_token,
    expiresIn: r2.expires_in || 1800,
  };
}

async function edlioRefreshLogin(refreshToken) {
  const r = await edlioFormPost({
    grant_type: "refresh_token", refresh_token: refreshToken, client_id: EDLIO_CLIENT_ID,
  });
  if (!r.access_token) throw new Error(`edlio refresh returned no access_token`);
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token || refreshToken,
    expiresIn: r.expires_in || 1800,
  };
}

async function edlioGetAccessToken() {
  const cache = edlioReadCache();
  const now = Date.now();
  if (cache?.accessToken && cache.expiresAt && cache.expiresAt - now > 120_000) {
    return cache.accessToken;
  }
  if (cache?.refreshToken) {
    try {
      const r = await edlioRefreshLogin(cache.refreshToken);
      const expiresAt = Date.now() + r.expiresIn * 1000;
      edlioWriteCache({ accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt });
      return r.accessToken;
    } catch (err) {
      process.stderr.write(`[edlio] refresh failed, full login: ${err.message}\n`);
    }
  }
  const r = await edlioFullLogin();
  const expiresAt = Date.now() + r.expiresIn * 1000;
  edlioWriteCache({ accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt });
  return r.accessToken;
}

async function edlioApiCall(className, payload = {}, { write = false } = {}) {
  const token = await edlioGetAccessToken();
  const verb = write ? "command" : "query";
  const res = await fetchT(`${EDLIO_API}/api/channel/${verb}/${className}`, {
    method: "POST",
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ $className: className, ...payload }),
  }, write ? FETCH_WRITE_TIMEOUT_MS : FETCH_TIMEOUT_MS);
  const text = await res.text();
  if (!res.ok) {
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const msg = parsed?.result?.errors?.length ? parsed.result.errors.join("; ")
      : (parsed?.message || text.slice(0, 400));
    throw new Error(`edlio ${verb}/${className} -> ${res.status}: ${msg}`);
  }
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return text; }
}

async function edlioFindFtpAccount(userName) {
  const list = await edlioApiCall("GetFtpAccountIndex");
  const arr = Array.isArray(list) ? list : (list?.items || []);
  const hit = arr.find(a => a.userName === userName);
  if (!hit) return null;
  // Index entries don't carry per-role settings or syncSchema.id reliably.
  // Fetch the full edit model.
  const edit = await edlioApiCall("GetEditFtpAccountModel", { id: hit.id });
  // edit responses sometimes wrap under {model: ...}, sometimes return raw.
  return edit?.model || edit;
}

async function upsertSchemaMapping(payload) {
  // Strategy:
  //   - If schema_mapping_id input was supplied → fetch + update
  //   - Else search by name → update if found
  //   - Else create
  if (ctx.schemaMappingIdOverride) {
    return updateSchemaMapping(ctx.schemaMappingIdOverride, payload, "updated");
  }

  const list = await edlioApiCall("GetIndexListSchemaMappingModel", {});
  const arr = Array.isArray(list) ? list : (list?.items || []);
  const existing = arr.find(m =>
    (m.name || "").toLowerCase().trim() === payload.name.toLowerCase().trim()
  );

  if (existing) {
    return updateSchemaMapping(existing.id, payload, "updated");
  }

  const created = await edlioApiCall("CreateSchemaMapping", { model: payload }, { write: true });
  const newId = created?.id || created?.model?.id;
  if (!newId) throw new Error(`CreateSchemaMapping returned no id: ${JSON.stringify(created).slice(0, 200)}`);
  return { id: newId, name: payload.name, action: "created" };
}

async function updateSchemaMapping(id, payload, action) {
  // Fetch the edit model so we have the canonical shape with $className
  // and other server-managed fields, then overlay our payload.
  const edit = await edlioApiCall("GetEditSchemaMappingModel", { id });
  const base = edit?.model || edit;
  const merged = { ...base, ...payload, id };
  await edlioApiCall("UpdateSchemaMapping", { model: merged }, { write: true });
  return { id, name: payload.name, action };
}

async function applyFtpAccountConfig({ ftpAccount, schemaMappingId, presentRoles, mode }) {
  // Re-fetch fresh edit model to avoid stale ETags/conflicts.
  const edit = await edlioApiCall("GetEditFtpAccountModel", { id: ftpAccount.id });
  const base = edit?.model || edit;
  const spec = ROLE_CONFIG[mode] || ROLE_CONFIG.v3;

  const applied = [];
  for (const role of ACTIVE_ROLES) {
    const settingsKey = `${role}Settings`;
    const specForRole = spec[settingsKey];
    if (!specForRole) continue;
    if (presentRoles.has(role)) {
      base[settingsKey] = { ...(base[settingsKey] || {}), ...specForRole };
      applied.push(role);
    } else {
      // Role isn't in the CSVs — disable.
      base[settingsKey] = {
        ...(base[settingsKey] || {}),
        ...specForRole,
        syncEnabled: false,
      };
    }
  }

  // Force-disable Aide etc.
  for (const role of FORCE_DISABLED_ROLES) {
    const k = `${role}Settings`;
    if (base[k]) base[k] = { ...base[k], syncEnabled: false };
  }

  // Classroom-level FTP-account toggles. Enrollment rides as a side-effect
  // of classroom + person syncs — there's no separate FTP-side enrollment
  // toggle. Grade/lineItem stay off in v0.1.
  if (presentRoles.has("classroom")) {
    base.classroomSyncEnabled = true;
    base.deleteMissingClassrooms = true;
    base.includeExistingNotSyncedClassrooms = false;
    applied.push("classroom");
  } else {
    base.classroomSyncEnabled = false;
  }
  if (presentRoles.has("enrollment")) {
    applied.push("enrollment");
  }
  // Hard-off in v0.1
  base.gradeSyncEnabled = false;
  base.lineItemSyncEnabled = false;

  // Link schema mapping
  base.syncSchema = { id: schemaMappingId };

  // Hard rule: never flip enabled on. If it was enabled, leave it. If not, leave it.
  // No mutation to base.enabled.

  await edlioApiCall("UpdateFtpAccount", { model: base }, { write: true });
  return applied;
}

// ==========================================================================
// FileMage API — preflight SSH-key attach
// ==========================================================================
//
// Before we try to sftp into a client FileMage user, ensure Edith's pubkey
// is authorized on that account. The user object returned by GET /users/{id}/
// includes a `keys: [{fingerprint, keyData, title, ...}]` array. If our
// fingerprint is missing, POST a new key. Idempotent.

// (EDITH_KEY_FINGERPRINT_MD5 and EDITH_KEY_TITLE hoisted to top of file.)

function fileMageHeaders() {
  const key = process.env.FILEMAGE_API_KEY;
  if (!key) throw new Error("FILEMAGE_API_KEY not in env");
  return { "filemage-api-token": key, "content-type": "application/json" };
}

function fileMageUrl(path) {
  const base = process.env.FILEMAGE_API_URL ||
    "https://sia-ftp-gw.centralus.cloudapp.azure.com";
  return `${base.replace(/\/$/, "")}${path}`;
}

async function fileMageFindUser(username) {
  // /users/ ignores query filters — fetch all then filter client-side.
  const res = await fetchT(fileMageUrl(`/users/?limit=1000`), {
    headers: fileMageHeaders(),
  });
  if (!res.ok) {
    throw new Error(`filemage GET /users -> HTTP ${res.status}`);
  }
  const body = await res.json();
  const users = Array.isArray(body) ? body : body.results || [];
  return users.find(u => u.username === username) || null;
}

async function fileMageGetUser(userId) {
  // Single user fetch — includes `keys[]` array which is not always present
  // on the list endpoint.
  const res = await fetchT(fileMageUrl(`/users/${userId}/`), {
    headers: fileMageHeaders(),
  });
  if (!res.ok) {
    throw new Error(`filemage GET /users/${userId}/ -> HTTP ${res.status}`);
  }
  return res.json();
}

async function fileMageAttachKey(userId, { keyData, title }) {
  const payload = { keyData, title, create: false };
  const res = await fetchT(fileMageUrl(`/users/${userId}/keys/`), {
    method: "POST",
    headers: fileMageHeaders(),
    body: JSON.stringify(payload),
  }, FETCH_WRITE_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`filemage POST /users/${userId}/keys/ -> HTTP ${res.status}: ${await res.text()}`);
  }
  // FileMage returns HTTP 200 with an empty body on success — don't try to parse.
  const text = await res.text();
  if (!text) return { ok: true };
  try { return JSON.parse(text); } catch { return { ok: true, raw: text }; }
}

function readEdithPubkey() {
  // Public key is stable, read from the same path we use for sftp auth.
  const pubKeyPath = (process.env.FILEMAGE_SSH_KEY || `${process.env.HOME || ""}/.ssh/filemage_ed25519`) + ".pub";
  try {
    return readFileSync(pubKeyPath, "utf8").trim();
  } catch (err) {
    throw new Error(`cannot read pubkey at ${pubKeyPath}: ${err.message}`);
  }
}

/**
 * Ensure Edith's SSH key is attached to the FileMage user for `username`.
 * Returns { user, attached: boolean, alreadyHad: boolean }.
 * - alreadyHad=true => key was already on the account (no-op)
 * - attached=true   => key was missing and we just POSTed it
 * Throws if user not found or POST fails.
 */
async function ensureFileMageKey(username) {
  // Look up the user first (list endpoint), then refetch by id to get keys[].
  const lite = await fileMageFindUser(username);
  if (!lite) {
    throw new Error(`filemage user not found: ${username}`);
  }
  const user = await fileMageGetUser(lite.id);
  const keys = Array.isArray(user.keys) ? user.keys : [];
  const hasOurKey = keys.some(k => k.fingerprint === EDITH_KEY_FINGERPRINT_MD5);

  if (hasOurKey) {
    return { user, attached: false, alreadyHad: true };
  }

  const pubkey = readEdithPubkey();
  await fileMageAttachKey(user.id, {
    keyData: pubkey,
    title: EDITH_KEY_TITLE,
  });
  return { user, attached: true, alreadyHad: false };
}

// ==========================================================================
// SFTP sampling (system `sftp` CLI in batch mode)
// ==========================================================================

async function sftpListAndSample(username) {
  // Step 1: list files in user's home via batch sftp.
  const listResult = sftpBatch(username, "ls -1");
  // listResult.stdout looks like:
  //   sftp> ls -1
  //   Students.csv
  //   Staff.csv
  //   ...
  const files = parseSftpLs(listResult.stdout)
    .filter(f => /\.csv$/i.test(f))
    .filter(f => !f.startsWith(".") && !f.endsWith("/"));

  if (!files.length) return [];

  // Step 2: download each file to a scratch dir.
  const scratch = mkdtempSync(`${tmpdir()}/app-sftp-config-${ctx.runId}-`);
  try {
    const cmds = files.map(f => `get -- "${escSftp(f)}" "${scratch}/${escSftp(basename(f))}"`).join("\n");
    sftpBatch(username, cmds);

    const samples = [];
    for (const fname of files) {
      const local = `${scratch}/${basename(fname)}`;
      let size = 0;
      try { size = statSync(local).size; } catch { continue; }
      const sample = readCsvSample(local, SAMPLE_ROW_LIMIT);
      samples.push({
        filename: fname,
        size_bytes: size,
        rows_sampled: sample.rows.length,
        column_count: sample.headers.length,
        headers: sample.headers,
        sampleRows: sample.rows,
        skipped: sample.headers.length === 0,
        skip_reason: sample.headers.length === 0 ? "empty or unreadable" : null,
      });
    }
    return samples.filter(s => !s.skipped);
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
}

function sftpBatch(username, body) {
  // Use `-b -` to read commands from stdin; -i for our key.
  const args = [
    "-b", "-",
    "-i", FILEMAGE_SSH_KEY,
    "-P", String(SFTP_PORT),
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "PasswordAuthentication=no",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    `${username}@${SFTP_HOST}`,
  ];
  const r = spawnSync("sftp", args, { input: body, encoding: "utf-8", timeout: 60_000 });
  if (r.error) throw new Error(`sftp spawn error: ${r.error.code || r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`sftp exited ${r.status}: ${(r.stderr || r.stdout || "").slice(0, 500)}`);
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

function parseSftpLs(stdout) {
  // sftp echoes `sftp> <cmd>` and various banners. Filter to plain filenames.
  const lines = stdout.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("sftp>")) continue;
    if (t.includes("Connected to")) continue;
    // ls -1 output is bare names; ignore any tabular columns.
    out.push(t);
  }
  return out;
}

function escSftp(s) {
  // sftp doesn't have rich quoting; we wrap in double quotes and only need
  // to escape backslash + double-quote.
  return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

// ==========================================================================
// CSV sampling
// ==========================================================================

function readCsvSample(path, maxRows) {
  let raw;
  try { raw = readFileSync(path, "utf-8"); }
  catch { return { headers: [], rows: [] }; }

  // Strip BOM
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  const lines = raw.split(/\r?\n/).filter(l => l.length > 0);
  if (!lines.length) return { headers: [], rows: [] };

  // Detect delimiter: comma vs tab vs semicolon.
  const first = lines[0];
  const delim = pickDelimiter(first);

  const parseLine = (line) => parseCsvLine(line, delim);
  const headers = parseLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length && rows.length < maxRows; i++) {
    const cells = parseLine(lines[i]);
    if (cells.length === 0) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cells[j] ?? "";
    rows.push(row);
  }
  return { headers, rows };
}

function pickDelimiter(line) {
  const counts = { ",": 0, "\t": 0, ";": 0, "|": 0 };
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (!inQuote && counts[c] !== undefined) counts[c]++;
  }
  let best = ",", bestCount = 0;
  for (const [d, n] of Object.entries(counts)) {
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

function parseCsvLine(line, delim = ",") {
  const out = [];
  let cur = "", inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === delim) { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ==========================================================================
// Role classification
// ==========================================================================

function classifyCsv(file) {
  // Returns { role, score, via }. via ∈ filename | columns | combined | unknown.
  const fname = file.filename.toLowerCase();
  const headersLc = file.headers.map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, "_"));

  const signals = ALIASES.role_classification_signals || {};
  const candidates = [];
  for (const role of Object.keys(signals)) {
    if (role.startsWith("_")) continue;
    const sig = signals[role];
    let score = 0;
    let matchedFilename = false;
    let matchedColumn = false;

    for (const pat of sig.filename_patterns || []) {
      if (fname.includes(pat)) { score += 0.6; matchedFilename = true; break; }
    }
    let colHits = 0;
    for (const colSig of sig.column_signals || []) {
      if (headersLc.some(h => h === colSig || h.includes(colSig))) {
        colHits++; matchedColumn = true;
      }
    }
    score += Math.min(0.4, colHits * 0.15);

    if (matchedFilename || matchedColumn) {
      candidates.push({
        role, score,
        via: matchedFilename && matchedColumn ? "combined"
          : matchedFilename ? "filename" : "columns",
      });
    }
  }

  // "multi" file: filename hints at users/people/all + has BOTH student_id AND employee_id-ish columns.
  if (/users|people|all|persons/.test(fname) &&
      headersLc.some(h => h.includes("student") && h.includes("id")) &&
      headersLc.some(h => h.includes("employee") || h.includes("staff"))) {
    candidates.push({ role: "multi", score: 0.7, via: "multi_heuristic" });
  }

  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) {
    return { role: null, score: 0, via: "unknown" };
  }
  return { ...candidates[0], via: "heuristic" };
}

// ==========================================================================
// Per-role column mapping (fuzzy)
// ==========================================================================

function mapRoleColumns(role, file, override = null) {
  // role: e.g. "student" | "teacher" | "classroom" | "enrollment" ...
  // file: { filename, headers }
  // override: optional { "<edlio_field>": { csv_column: "<colname>" | null } }
  // Person roles read from person_fields; classroom/enrollment read from
  // their own field sets.
  let fieldSet;
  if (role === "classroom") {
    fieldSet = ALIASES.classroom_fields || {};
  } else if (role === "enrollment") {
    fieldSet = ALIASES.enrollment_fields || {};
  } else {
    fieldSet = ALIASES.person_fields || {};
  }
  const required = (ALIASES.role_required_fields || {})[role] || [];

  const auto_mapped = {};            // edlioField → csvColumn
  const low_confidence = [];         // [{ field, label, top_guesses: [{column, score}] }]
  const missing_required = [];

  for (const [field, def] of Object.entries(fieldSet)) {
    if (override && Object.prototype.hasOwnProperty.call(override, field)) {
      const ov = override[field];
      if (ov?.csv_column) auto_mapped[field] = ov.csv_column;
      // If null → operator says "not present"; just leave unmapped.
      continue;
    }

    // The "fileName" pseudo-field is always present and equals the CSV
    // filename verbatim — it's how Edlio matches uploads to this sub-model.
    if (field === "fileName") {
      auto_mapped[field] = file.filename;
      continue;
    }

    const label = def.label || field;
    const aliases = def.aliases || [];
    const candidates = [];
    for (const header of file.headers) {
      const score = scoreHeaderMatch(header, label, aliases);
      if (score > 0) candidates.push({ column: header, score });
    }
    candidates.sort((a, b) => b.score - a.score);

    if (candidates.length && candidates[0].score >= ALIAS_AUTO_THRESHOLD) {
      auto_mapped[field] = candidates[0].column;
    } else if (candidates.length && candidates[0].score >= 0.5) {
      low_confidence.push({
        field, label,
        top_guesses: candidates.slice(0, 3).map(c => ({ column: c.column, score: Number(c.score.toFixed(2)) })),
      });
    }
  }

  for (const f of required) {
    if (!auto_mapped[f]) missing_required.push(f);
  }

  return {
    csv_file: file.filename,
    auto_mapped,
    low_confidence,
    missing_required,
  };
}

function scoreHeaderMatch(header, label, aliases) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const h = norm(header);
  const candidates = [norm(label), ...aliases.map(norm)];
  let best = 0;
  for (const c of candidates) {
    if (!c) continue;
    if (h === c) return 1.0;
    if (h.includes(c) || c.includes(h)) {
      // length-aware: longer overlaps score higher
      const ratio = Math.min(h.length, c.length) / Math.max(h.length, c.length);
      best = Math.max(best, 0.7 + 0.25 * ratio);
    } else {
      const j = jaroWinkler(h, c);
      if (j > best) best = j;
    }
  }
  return best;
}

function jaroWinkler(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = jaroDistance(a, b);
  if (m < 0.7) return m;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++; else break;
  }
  return m + prefix * 0.1 * (1 - m);
}

function jaroDistance(a, b) {
  if (a === b) return 1;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array(a.length).fill(false);
  const bMatch = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - range), end = Math.min(b.length, i + range + 1);
    for (let j = start; j < end; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true; bMatch[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let k = 0, transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

// ==========================================================================
// SchemaMapping payload construction
// ==========================================================================

function buildSchemaMappingPayload({ ticket, ftpAccount, csvs, roleMappings, presentRoles }) {
  const acceptedFileNames = csvs.map(c => c.filename);
  const hasMultipleFiles = acceptedFileNames.length > 1;

  // organizationIdentifierInFiles: true if the CSVs carry org/school IDs
  // per row (multi-org rollouts) — heuristic on column presence.
  const organizationIdentifierInFiles = csvs.some(c =>
    c.headers.some(h => /\b(school|org|building|site|campus)[_-]?(id|code|number)\b/i.test(h))
  );

  const payload = {
    $className: "SchemaMappingEditModel",
    name: ticket.schoolName || ftpAccount.userName,
    description: ticket.sisProvider || null,
    hasMultipleFiles,
    organizationIdentifierInFiles,
    acceptedFileNames,
  };

  // Per-role *Settings blocks holding the field→column mappings.
  // Edlio's CreateSchemaMapping validator requires a non-empty `fileName`
  // in EVERY role's settings block (it's how the importer matches an upload
  // to a role). `fileName` is not a CSV column and is not in the person-role
  // required-field list, so it never gets mapped from headers — fill it
  // deterministically from the role's source CSV. (Without this, every
  // person role fails with "File name is empty in <Role> settings.")
  for (const role of ACTIVE_ROLES) {
    const settingsKey = `${role}Settings`;
    const m = roleMappings[role];
    if (!m || !presentRoles.has(role)) {
      payload[settingsKey] = null;
      continue;
    }
    const block = { ...m.auto_mapped };
    if (!block.fileName) block.fileName = m.csv_file || null;
    payload[settingsKey] = block;
  }

  // Classroom sub-model: single object with {fileName, organizationIdField,
  // nameField, sourceIdField, descriptionField?, disabledField?, ...}.
  const cmap = roleMappings.classroom;
  if (cmap && presentRoles.has("classroom")) {
    payload.classroomSchemaModel = { ...cmap.auto_mapped };
    payload.hasClassroomMapping = true;
  } else {
    payload.classroomSchemaModel = null;
    payload.hasClassroomMapping = false;
  }

  // Enrollment sub-model: array, one per enrollments file (we only support
  // a single enrollments file in v0.1; if multiple, last wins for now and
  // we surface a note).
  const emap = roleMappings.enrollment;
  if (emap && presentRoles.has("enrollment")) {
    payload.enrollmentSchemaModels = [{ ...emap.auto_mapped }];
  } else {
    payload.enrollmentSchemaModels = [];
  }

  // Flags for grade/lineItem stay false in v0.1.
  payload.hasGradesMapping = false;
  payload.hasLineItemMapping = false;

  return payload;
}

// ==========================================================================
// Forge comment renderer
// ==========================================================================

function renderForgeComment({ ticket, ftpAccount, schemaMapping, csvs, roleMappings, appliedRoles, mode, prior }) {
  const lines = [];
  lines.push(`### App-SFTP sync configured`);
  lines.push("");
  lines.push(`**FTP account:** \`${ftpAccount.userName}\` (id ${ftpAccount.id})`);
  lines.push(`**District:** ${ftpAccount.districtName || "(unknown)"} (id ${ftpAccount.districtId || "?"})`);
  lines.push(`**Schema mapping:** \`${schemaMapping.name}\` (id ${schemaMapping.id}, **${schemaMapping.action}**)`);
  lines.push(`**Sync mode:** ${mode.toUpperCase()}`);
  lines.push(`**FTP enabled:** ${ftpAccount.enabled ? "✅ live" : "⏸ left disabled — operator review"}`);
  lines.push("");
  lines.push(`**CSVs detected (${csvs.length}):**`);
  for (const f of csvs) {
    lines.push(`- \`${f.filename}\` → ${f.classified_role || "—"} (${f.column_count} cols, ${f.rows_sampled} rows sampled)`);
  }
  lines.push("");
  lines.push(`**Roles applied (${appliedRoles.length}):**`);
  for (const role of appliedRoles) {
    const m = roleMappings[role];
    const auto = Object.keys(m.auto_mapped).length;
    const low = m.low_confidence.length;
    lines.push(`- **${role}** — ${auto} field${auto === 1 ? "" : "s"} mapped${low ? `, ${low} low-confidence` : ""}`);
  }
  lines.push("");
  lines.push(`_Operator: review the FTP-account mappings tab and the new SchemaMapping in the Edlio dashboard. Schema mapping is linked but FTP account is **${ftpAccount.enabled ? "ENABLED" : "DISABLED"}**; turn it on to start syncing._`);
  lines.push("");
  lines.push(`---`);
  if (triggeredBy) lines.push(`_${triggeredBy} (via Edith) configured this sync._`);
  lines.push(`${MARKER_TAG} ${MARKER_EVENT} run_id=${ctx.runId} ts=${new Date().toISOString()} skill_version=${SKILL_VERSION}`);
  return lines.join("\n");
}

// ==========================================================================
// Helpers
// ==========================================================================

function deriveFileMageUsername(schoolName) {
  // Diana convention: edlio_<lowercase_underscore_school_name>
  const slug = (schoolName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return `edlio_${slug}`;
}

function ticketSummary(t) {
  return {
    key: t.key,
    title: t.title || null,
    schoolName: t.schoolName || null,
    sisProvider: t.sisProvider || null,
    dashboard: t.dashboard || null,
    pocEmail: t.pocEmail || null,
  };
}

function ftpAccountSummary(ftp) {
  return {
    id: ftp.id,
    userName: ftp.userName,
    districtId: ftp.districtId || null,
    districtName: ftp.districtName || null,
    schemaMappingId: ftp.syncSchema?.id || null,
    enabled: !!ftp.enabled,
    rolesApplied: [],
  };
}

function csvSummary(f) {
  return {
    filename: f.filename,
    size_bytes: f.size_bytes || 0,
    rows_sampled: f.rows_sampled || 0,
    column_count: f.column_count || 0,
    headers: f.headers || [],
    classified_role: f.classified_role || null,
    confidence: Number((f.confidence || 0).toFixed(2)),
    skipped: !!f.skipped,
    skip_reason: f.skip_reason || null,
  };
}

// 1Password env helper (for op CLI subprocess)
function opEnv() {
  const tok = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!tok) throw new Error("OP_SERVICE_ACCOUNT_TOKEN not in env");
  return { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: tok };
}

// ==========================================================================
// Stdin / Envelope
// ==========================================================================

function readInputsFromStdin() {
  try {
    const raw = readFileSync(0, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`failed to read inputs: ${e.message}`);
  }
}

function recordAction(a) { ctx.actions.push({ ts: new Date().toISOString(), ...a }); }
function recordNote(message, type = "observation", severity = "info") {
  ctx.notes.push({ type, message, severity });
}
function recordError(where, err) {
  ctx.errors.push({
    at: new Date().toISOString(),
    code: where.includes(".") ? where : `appsftpconfig.${where}`,
    message: err.message,
    retryable: false,
    details: { stack: err.stack || null },
  });
}

function done(dataPayload, outerStatus) {
  emitResult(dataPayload, outerStatus);
  process.exit(0);
}

function emitResult(dataPayload, outerStatusHint = null) {
  const dataWithMeta = {
    ...dataPayload,
    skill_version: SKILL_VERSION,
    triggered_by: triggeredBy,
    mode: ctx.mode,
  };

  const failed = ctx.actions.filter(a => a.status === "failed").length;
  let outerStatus;
  if (outerStatusHint) outerStatus = outerStatusHint;
  else if (dataPayload.status_reason === "error" || failed > 0) outerStatus = "error";
  else if (dataPayload.status_reason === "needs_input" || dataPayload.status_reason === "awaiting_mapping_approval" || dataPayload.status_reason === "no_files") outerStatus = "needs-input";
  else if (dataPayload.status_reason === "wrong_type") outerStatus = "declined";
  else outerStatus = "ok";

  const envelope = {
    status: outerStatus,
    taskName: TASK_NAME,
    taskVersion: SKILL_VERSION,
    runId: ctx.runId,
    startedAt: ctx._startedAt,
    finishedAt: new Date().toISOString(),
    inputs,
    actions: ctx.actions,
    notes: ctx.notes,
    errors: ctx.errors,
    data: dataWithMeta,
  };

  process.stderr.write(
    `[${TASK_NAME}] status=${outerStatus} reason=${dataPayload.status_reason} ` +
    `actions=${ctx.actions.length} errors=${ctx.errors.length}\n`
  );
  process.stdout.write(`<<RESULT>>${JSON.stringify(envelope)}<<END>>\n`);
}
