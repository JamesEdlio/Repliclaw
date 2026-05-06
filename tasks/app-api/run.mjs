#!/usr/bin/env node
// app-api task skill — deterministic executable.
//
// Runs under repliclaw with `exec:` frontmatter. Reads task inputs from
// stdin as JSON, emits a Repliclaw <<RESULT>> envelope on stdout.
//
// Flow (see ./SKILL.md for full spec):
//   1. GET Forge ticket
//   2. Resolve provider (input override > ticket.apiProvider)
//   2.5 Type guard (APP + APP_API)
//   3. Dup-send guard (scan comments for [app-api] setup-sent marker)
//   4. Resolve recipients (pocEmail required; CC @edlio.com reporter)
//   5. Render provider-specific template
//   6. Gmail send via edith@edlio.com
//   7. POST Forge comment with marker
//   8. PATCH Forge ticket BACKLOG -> INITIAL_CONTACT
//
// Everything is idempotent on re-run: dup-send guard short-circuits step 2
// if a prior successful run is detected.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SKILL_VERSION = "0.1.0";
const MARKER_TAG = "[app-api]";
const MARKER_EVENT = "setup-sent";

// ---- Provider registry --------------------------------------------------
//
// Canonical key -> { template file, display name, friendly aliases }.
// Templates live in ./templates/<file>.
// Providers that are recognized but not yet templated map to
// SUPPORTED_PROVIDERS but have templateFile=null — we emit needs_input.

const PROVIDER_REGISTRY = {
  powerschool: {
    displayName: "PowerSchool",
    templateFile: "powerschool.html",
    enumValues: ["POWERSCHOOL", "POWERSCHOOL_NC"],
    friendly: ["powerschool", "powerschool nc", "power school"],
  },
  clever: {
    displayName: "Clever",
    templateFile: "clever.html",
    enumValues: ["CLEVER"],
    friendly: ["clever"],
  },
  aeries: {
    displayName: "Aeries",
    templateFile: "aeries.html",
    enumValues: ["AERIES"],
    friendly: ["aeries"],
  },
  sylogist: {
    displayName: "Sylogist",
    templateFile: "sylogist.html",
    enumValues: ["SYLOGIST"],
    friendly: ["sylogist"],
  },
  skyward_qmlativ: {
    displayName: "Skyward Qmlativ",
    templateFile: "skyward_qmlativ.html",
    enumValues: ["SKYWARD_QMLATIV"],
    friendly: ["skyward qmlativ", "qmlativ"],
  },
  skyward_confirm: {
    displayName: "Skyward",
    templateFile: "skyward_confirm.html",
    enumValues: ["SKYWARD"],
    friendly: ["skyward"],
  },
  // Recognized but not templated — emit needs_input asking for human intervention.
  odbc: {
    displayName: "ODBC",
    templateFile: null,
    enumValues: ["ODBC"],
    friendly: ["odbc"],
  },
  veracross: {
    displayName: "Veracross",
    templateFile: null,
    enumValues: ["VERACROSS"],
    friendly: ["veracross"],
  },
  ats_doenyc: {
    displayName: "ATS (NYC DOE)",
    templateFile: null,
    enumValues: ["ATS_DOENYC"],
    friendly: ["ats", "ats_doenyc", "ats doenyc"],
  },
};

// Dashboard enum -> human display (for {dashboard_display} template var).
const DASHBOARD_DISPLAY = {
  EDLIO: "Edlio",
  SIA_US: "SIA US",
  SIA_CA: "SIA CA",
  SAE: "SAE",
  ESV: "eSV",
  REACH_US: "Reach US",
  REACH_CA: "Reach CA",
  REACH_AUS: "Reach AUS",
  CMS4SCHOOLS: "CMS4Schools",
  APPS_BY_SIA: "Apps by SIA",
  SYNTAX_NY: "SyntaxNY",
  SCHOOL_PLANNER: "SchoolPlanner",
  SCHOOL_WEBMASTERS: "SchoolWebmasters",
};

// ---- Bootstrap -----------------------------------------------------------

const runId = process.env.REPLICLAW_RUN_ID || "run_unknown";
const inputs = readInputsFromStdin();
const dryRun = inputs.dry_run === true;
const triggeredBy = typeof inputs.triggered_by === "string" && inputs.triggered_by
  ? inputs.triggered_by
  : null;

const ctx = {
  runId,
  ticketKey: inputs.ticket_key,
  dryRun,
  triggeredBy,
  forceRerun: inputs.force_rerun === true,
  providerOverride: inputs.provider || null,
  actions: [],
  notes: [],
  errors: [],
  _startedAt: new Date().toISOString(),
};

try {
  await main();
} catch (err) {
  recordError("pipeline.exception", err);
  emitResult({
    status: "error",
    ticket_key: ctx.ticketKey || "unknown",
    provider: null,
    provider_source: null,
    note: `fatal: ${err.message}`,
    skill_version: SKILL_VERSION,
    dry_run: dryRun,
    triggered_by: triggeredBy,
  });
  process.exit(1);
}

// ==========================================================================
// Main pipeline
// ==========================================================================

async function main() {
  if (!ctx.ticketKey) throw new Error("ticket_key required in inputs");

  // Step 1: fetch Forge ticket
  const ticket = await forgeGetTicket(ctx.ticketKey);
  recordAction({
    type: "forge.ticket.read",
    status: "success",
    details: { ticket_key: ctx.ticketKey },
  });

  // Step 2: resolve provider (input override > ticket.apiProvider)
  const providerResolution = resolveProvider(ctx.providerOverride, ticket.apiProvider);
  if (!providerResolution.canonical) {
    recordNote(
      providerResolution.reason === "missing_provider"
        ? "No provider given as input and ticket.apiProvider is null — operator must pick one."
        : `Provider "${providerResolution.raw}" is recognized but no template is wired up yet.`,
      "observation",
      "warn"
    );
    return done({
      status: "needs_input",
      ticket_key: ctx.ticketKey,
      provider: null,
      provider_source: null,
      missing: providerResolution.reason === "missing_provider" ? ["apiProvider"] : ["templated_provider"],
      note: providerResolution.note,
      outreach: { reason: providerResolution.reason },
    });
  }
  const providerKey = providerResolution.canonical;
  const providerMeta = PROVIDER_REGISTRY[providerKey];

  // Step 2.5: type guard
  if (ticket.product !== "APP" || ticket.integrationType !== "APP_API") {
    recordNote(
      `Ticket is ${ticket.product || "?"}/${ticket.integrationType || "?"} — not APP/APP_API.`,
      "observation",
      "warn"
    );
    return done({
      status: "wrong_type",
      ticket_key: ctx.ticketKey,
      provider: providerKey,
      provider_source: providerResolution.source,
      declined_reason: `product=${ticket.product} integrationType=${ticket.integrationType}; app-api only handles APP+APP_API`,
      routing_suggestion: routingHint(ticket),
    });
  }

  // Step 3: dup-send guard
  const priorRun = findPriorRun(ticket.comments || []);
  if (priorRun && !ctx.forceRerun) {
    recordNote(
      `Prior run found at ${priorRun.ts} (run_id=${priorRun.run_id}). Use force_rerun=true to send again.`,
      "observation",
      "info"
    );
    return done({
      status: "already_sent",
      ticket_key: ctx.ticketKey,
      provider: providerKey,
      provider_source: providerResolution.source,
      prior_run: priorRun,
      outreach: { reason: "already_sent" },
    });
  }

  // Provider supported?
  if (!providerMeta.templateFile) {
    recordNote(
      `Provider "${providerMeta.displayName}" is recognized but no email template exists yet. A human needs to draft outreach or add a template.`,
      "observation",
      "warn"
    );
    return done({
      status: "needs_input",
      ticket_key: ctx.ticketKey,
      provider: providerKey,
      provider_source: providerResolution.source,
      missing: ["email_template"],
      note: `No template for ${providerMeta.displayName} yet.`,
      outreach: { reason: "provider_not_supported" },
    });
  }

  // Step 4: resolve recipients
  const { toList, ccList, missingReason } = resolveRecipients(ticket);
  if (missingReason) {
    return done({
      status: "needs_input",
      ticket_key: ctx.ticketKey,
      provider: providerKey,
      provider_source: providerResolution.source,
      missing: [missingReason],
      note:
        missingReason === "pocEmail"
          ? "Ticket has no POC email. Add pocEmail to the ticket (Jira-synced tickets often start null)."
          : `Missing required field: ${missingReason}`,
      outreach: { reason: "missing_poc_email" },
    });
  }

  // Step 5: render template
  const templateVars = buildTemplateVars(ticket, providerMeta);
  const htmlBody = renderEmailTemplate(providerMeta.templateFile, templateVars);
  const subject = `${ticket.schoolName || ctx.ticketKey} — ${providerMeta.displayName} API setup`;

  // Step 6: send email
  if (dryRun) {
    recordAction({
      type: "gmail.message.send",
      status: "skipped",
      details: {
        dry_run: true,
        to: toList,
        cc: ccList,
        subject,
        provider: providerKey,
        template: providerMeta.templateFile,
      },
    });
  } else {
    try {
      await gmailSend({ to: toList, cc: ccList, subject, htmlBody });
      recordAction({
        type: "gmail.message.send",
        status: "success",
        details: { to: toList, cc: ccList, subject, provider: providerKey, template: providerMeta.templateFile },
      });
    } catch (err) {
      recordAction({
        type: "gmail.message.send",
        status: "failed",
        details: { to: toList, cc: ccList, subject, provider: providerKey, error: err.message },
      });
      recordError("gmail.send_failed", err);
      return done({
        status: "error",
        ticket_key: ctx.ticketKey,
        provider: providerKey,
        provider_source: providerResolution.source,
        note: `gmail send failed: ${err.message}`,
        outreach: {
          email_to: toList,
          email_cc: ccList,
          email_subject: subject,
          template: providerMeta.templateFile,
          reason: "email_send_failed",
        },
      });
    }
  }
  const emailSentAt = new Date().toISOString();

  // Step 7: post Forge comment with marker
  const commentBody = buildCommentBody({
    providerDisplay: providerMeta.displayName,
    to: toList,
    cc: ccList,
    dryRun,
  });
  let commentId = null;
  let commentFailed = false;
  if (dryRun) {
    recordAction({
      type: "forge.comment.create",
      status: "skipped",
      details: { dry_run: true, ticket_key: ctx.ticketKey, preview: commentBody.slice(0, 120) },
    });
  } else {
    try {
      const c = await forgePostComment(ctx.ticketKey, commentBody);
      commentId = c?.id || null;
      recordAction({
        type: "forge.comment.create",
        status: "success",
        details: { ticket_key: ctx.ticketKey, comment_id: commentId },
      });
    } catch (err) {
      recordAction({
        type: "forge.comment.create",
        status: "failed",
        details: { ticket_key: ctx.ticketKey, error: err.message },
      });
      recordError("forge.comment_failed", err);
      commentFailed = true;
    }
  }

  // Step 8: transition to INITIAL_CONTACT if currently BACKLOG
  let transitioned = null;
  let transitionFailed = false;
  const currentStatus = ticket.status;
  const shouldTransition = currentStatus === "BACKLOG";
  if (shouldTransition) {
    if (dryRun) {
      recordAction({
        type: "forge.ticket.transition",
        status: "skipped",
        details: { dry_run: true, ticket_key: ctx.ticketKey, from: "BACKLOG", to: "INITIAL_CONTACT" },
      });
      transitioned = { from: "BACKLOG", to: "INITIAL_CONTACT" };
    } else {
      try {
        await forgePatchStatus(ctx.ticketKey, "INITIAL_CONTACT");
        recordAction({
          type: "forge.ticket.transition",
          status: "success",
          details: { ticket_key: ctx.ticketKey, from: "BACKLOG", to: "INITIAL_CONTACT" },
        });
        transitioned = { from: "BACKLOG", to: "INITIAL_CONTACT" };
      } catch (err) {
        recordAction({
          type: "forge.ticket.transition",
          status: "failed",
          details: { ticket_key: ctx.ticketKey, from: "BACKLOG", to: "INITIAL_CONTACT", error: err.message },
        });
        recordError("forge.transition_failed", err);
        transitionFailed = true;
      }
    }
  } else {
    recordNote(
      `Ticket already at status=${currentStatus}; not transitioning.`,
      "observation",
      "info"
    );
  }

  // Final status decision
  let finalStatus;
  let reason = null;
  if (dryRun) {
    finalStatus = "ok";
  } else if (commentFailed) {
    finalStatus = "partial";
    reason = "comment_failed_after_send";
  } else if (transitionFailed) {
    finalStatus = "partial";
    reason = "transition_failed_after_send";
  } else {
    finalStatus = "ok";
  }

  return done({
    status: finalStatus,
    ticket_key: ctx.ticketKey,
    provider: providerKey,
    provider_source: providerResolution.source,
    outreach: {
      email_to: toList,
      email_cc: ccList,
      email_subject: subject,
      email_sent_at: dryRun ? null : emailSentAt,
      template: providerMeta.templateFile,
      ...(reason ? { reason } : {}),
    },
    forge: {
      comment_posted: !dryRun && !commentFailed,
      comment_id: commentId,
      status_transition: transitioned,
    },
  });
}

// ==========================================================================
// Provider resolution
// ==========================================================================

function resolveProvider(override, ticketApiProvider) {
  // 1) Explicit override from modal.
  if (override) {
    const canonical = canonicalizeProvider(override);
    if (canonical) {
      return { canonical, raw: override, source: "input_override", note: null };
    }
    // Unknown string — treat as missing template.
    return {
      canonical: null,
      raw: override,
      source: "input_override",
      reason: "unknown_provider",
      note: `Provider "${override}" isn't in the registry. Accepted: ${Object.keys(PROVIDER_REGISTRY).join(", ")}.`,
    };
  }

  // 2) Ticket field.
  if (ticketApiProvider) {
    const canonical = canonicalizeProvider(ticketApiProvider);
    if (canonical) {
      return { canonical, raw: ticketApiProvider, source: "ticket_field", note: null };
    }
    return {
      canonical: null,
      raw: ticketApiProvider,
      source: "ticket_field",
      reason: "unknown_provider",
      note: `ticket.apiProvider "${ticketApiProvider}" isn't in the registry.`,
    };
  }

  // 3) Nothing.
  return {
    canonical: null,
    raw: null,
    source: null,
    reason: "missing_provider",
    note: "No provider given in inputs and ticket.apiProvider is null. Pick a provider in the run modal.",
  };
}

function canonicalizeProvider(raw) {
  if (!raw) return null;
  const upper = String(raw).trim().toUpperCase();
  const lower = String(raw).trim().toLowerCase();
  for (const [key, meta] of Object.entries(PROVIDER_REGISTRY)) {
    if (meta.enumValues.includes(upper)) return key;
    if (meta.friendly.includes(lower)) return key;
    if (key === lower) return key;
  }
  return null;
}

// ==========================================================================
// Forge API
// ==========================================================================

function forgeHeaders() {
  const secret = process.env.FORGE_SHARED_SECRET;
  if (!secret) throw new Error("FORGE_SHARED_SECRET not in env");
  return {
    "x-forge-secret": secret,
    "x-forge-actor": "app-api",
    "content-type": "application/json",
  };
}

function forgeUrl(path) {
  const base = process.env.FORGE_URL || process.env.FORGE_BASE_URL;
  if (!base) throw new Error("FORGE_URL (or FORGE_BASE_URL) not in env");
  return `${base.replace(/\/$/, "")}${path}`;
}

async function forgeGetTicket(key) {
  const res = await fetch(forgeUrl(`/api/tickets/${encodeURIComponent(key)}`), {
    headers: forgeHeaders(),
  });
  if (!res.ok) {
    throw new Error(`forge GET /api/tickets/${key} -> HTTP ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return body.ticket;
}

async function forgePostComment(key, body) {
  const res = await fetch(forgeUrl(`/api/tickets/${encodeURIComponent(key)}/comments`), {
    method: "POST",
    headers: forgeHeaders(),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`forge POST comment -> HTTP ${res.status}: ${await res.text()}`);
  }
  const j = await res.json();
  return j.comment;
}

async function forgePatchStatus(key, status) {
  const res = await fetch(forgeUrl(`/api/tickets/${encodeURIComponent(key)}`), {
    method: "PATCH",
    headers: forgeHeaders(),
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    throw new Error(`forge PATCH status -> HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function findPriorRun(comments) {
  const sorted = [...comments].sort((a, b) =>
    new Date(b.createdAt) - new Date(a.createdAt)
  );
  const re = new RegExp(
    `\\${MARKER_TAG}\\s+${MARKER_EVENT}\\s+run_id=(\\S+)\\s+ts=(\\S+)\\s+skill_version=(\\S+)`,
  );
  for (const c of sorted) {
    const m = c.body?.match(re);
    if (m) {
      return {
        run_id: m[1],
        ts: m[2],
        skill_version: m[3],
        comment_id: c.id,
        author: c.author?.email || null,
      };
    }
  }
  return null;
}

// ==========================================================================
// Recipients
// ==========================================================================

function resolveRecipients(ticket) {
  const pocEmail = (ticket.pocEmail || "").trim();
  if (!pocEmail || !isValidEmail(pocEmail)) {
    return { toList: [], ccList: [], missingReason: "pocEmail" };
  }
  const toList = [pocEmail];
  const ccList = [];
  const reporterEmail = ticket.reporter?.email?.trim();
  const senderEmail = (process.env.GMAIL_FROM || "edith@edlio.com").match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase() || "edith@edlio.com";
  if (reporterEmail && isValidEmail(reporterEmail) && reporterEmail.toLowerCase().endsWith("@edlio.com")) {
    // Avoid self-CC if POC is the reporter, and never CC the sender (edith).
    const lower = reporterEmail.toLowerCase();
    if (lower !== pocEmail.toLowerCase() && lower !== senderEmail) {
      ccList.push(reporterEmail);
    }
  }
  return { toList, ccList, missingReason: null };
}

// ==========================================================================
// Template rendering
// ==========================================================================

function buildTemplateVars(ticket, providerMeta) {
  return {
    poc_first_name: derivePocFirstName(ticket),
    reporter_intro: buildReporterIntro(ticket),
    dashboard_display: DASHBOARD_DISPLAY[ticket.dashboard] || "Edlio",
    school_name: ticket.schoolName || "",
    provider_display: providerMeta.displayName,
  };
}

function derivePocFirstName(ticket) {
  const pocName = (ticket.pocName || "").trim();
  if (pocName) {
    return pocName.split(/\s+/)[0];
  }
  const email = (ticket.pocEmail || "").trim();
  if (email.includes("@")) {
    const local = email.split("@")[0];
    // Capitalize first letter if it looks like a first name (no digits, no punctuation).
    return local.charAt(0).toUpperCase() + local.slice(1);
  }
  return "there";
}

function buildReporterIntro(ticket) {
  // Mirror Diana's format_reporter_intro: only @edlio.com reporters get named.
  const reporter = ticket.reporter;
  const email = reporter?.email?.trim().toLowerCase();
  const name = reporter?.name?.trim();
  if (name && email && email.endsWith("@edlio.com")) {
    return `<strong>${name}</strong> asked me to reach out to you about`;
  }
  return "You've asked us to reach out about";
}

function renderEmailTemplate(templateFile, vars) {
  const tmplPath = resolve(__dirname, "templates", templateFile);
  let body = readFileSync(tmplPath, "utf-8");
  for (const [k, v] of Object.entries(vars)) {
    body = body.replaceAll(`{${k}}`, String(v));
  }
  return body;
}

// ==========================================================================
// Comment body
// ==========================================================================

function buildCommentBody({ providerDisplay, to, cc, dryRun }) {
  const lines = [];
  const actor = triggeredBy ? `${triggeredBy} (via Edith)` : "Edith";
  const verb = dryRun ? "would send" : "sent";
  lines.push(`${actor} ${verb} ${providerDisplay} API setup email to ${to.join(", ")}${cc.length ? ` (cc ${cc.join(", ")})` : ""}.`);
  lines.push("");
  lines.push(`${MARKER_TAG} ${MARKER_EVENT} run_id=${ctx.runId} ts=${new Date().toISOString()} skill_version=${SKILL_VERSION}${triggeredBy ? ` triggered_by=${triggeredBy}` : ""}`);
  return lines.join("\n");
}

// ==========================================================================
// Gmail (gws CLI)
// ==========================================================================

async function gmailSend({ to, cc, subject, htmlBody }) {
  const from = process.env.GMAIL_FROM || "Edith <edith@edlio.com>";
  const args = [
    "gmail", "+send",
    "--from", from,
    "--to", to.join(","),
    "--subject", subject,
    "--body", htmlBody,
    "--html",
  ];
  if (cc.length) args.push("--cc", cc.join(","));

  const r = spawnSync("gws", args, { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`gws gmail send failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

// ==========================================================================
// Utilities
// ==========================================================================

function readInputsFromStdin() {
  try {
    const raw = readFileSync(0, "utf-8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`failed to read inputs from stdin: ${e.message}`);
  }
}

function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function routingHint(ticket) {
  if (ticket.product === "CMS") return "CMS ticket — route to Raul";
  if (ticket.integrationType === "APP_SFTP") return "SFTP ticket — drop app-sftp instead";
  if (ticket.integrationType?.includes("SSO")) return "SSO ticket — route to Cody";
  return "not an App-API ticket";
}

function recordAction(a) { ctx.actions.push({ ts: new Date().toISOString(), ...a }); }
function recordNote(message, type = "observation", severity = "info") {
  ctx.notes.push({ type, message, severity });
}
function recordError(where, err) {
  ctx.errors.push({
    at: new Date().toISOString(),
    code: where.includes(".") ? where : `appapi.${where}`,
    message: err.message,
    retryable: false,
    details: { stack: err.stack || null },
  });
}

function done(dataPayload) {
  emitResult({ ...dataPayload, skill_version: SKILL_VERSION, dry_run: dryRun, triggered_by: triggeredBy });
  process.exit(0);
}

function emitResult(dataPayload) {
  const failed = ctx.actions.filter(a => a.status === "failed").length;
  const dataStatus = dataPayload.status;
  const isError = dataStatus === "error" || (failed > 0 && dataStatus !== "partial");
  const isPartial = dataStatus === "partial";
  const isNeedsInput = dataStatus === "needs_input";
  const isDeclined = dataStatus === "declined" || dataStatus === "wrong_type";
  const outerStatus = isError
    ? "error"
    : isPartial ? "partial"
    : isNeedsInput ? "needs-input"
    : isDeclined ? "declined"
    : "ok"; // covers ok and already_sent

  const envelope = {
    status: outerStatus,
    taskName: "app-api",
    taskVersion: SKILL_VERSION,
    runId: ctx.runId,
    startedAt: ctx._startedAt,
    finishedAt: new Date().toISOString(),
    inputs: inputs,
    actions: ctx.actions,
    notes: ctx.notes,
    errors: ctx.errors,
    data: dataPayload,
  };

  process.stderr.write(`[app-api] status=${outerStatus} dataStatus=${dataStatus} actions=${ctx.actions.length} errors=${ctx.errors.length}\n`);
  process.stdout.write(`<<RESULT>>${JSON.stringify(envelope)}<<END>>\n`);
}
