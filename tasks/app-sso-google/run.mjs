#!/usr/bin/env node
// app-sso-google task skill — deterministic executable.
//
// Runs under repliclaw with `exec:` frontmatter. Reads task inputs from
// stdin as JSON, emits a Repliclaw <<RESULT>> envelope on stdout.
//
// Flow (see ./SKILL.md for full spec):
//   1. GET Forge ticket
//   2. Type guard (APP + APP_SSO)
//   2.5 SSO type guard — only GOOGLE_WORKSPACE_CLASSROOM and GOOGLE_SAML are in scope
//   3. Dup-send guard (scan comments for [app-sso-google] setup-sent marker)
//   4. Resolve recipients (pocEmail required; CC @edlio.com reporter+assignee + dataintegrations)
//   5. Render template
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

const SKILL_VERSION = "0.1.3";
const MARKER_TAG = "[app-sso-google]";
const MARKER_EVENT = "setup-sent";
const DATA_INTEGRATIONS_CC = "dataintegrations@edlio.com";

// The SSO types this skill handles. Both Google variants route to the
// same Google Workspace setup guide; treat them equivalently.
const IN_SCOPE_SSO_TYPES = new Set([
  "GOOGLE_SAML",
  "GOOGLE_WORKSPACE_CLASSROOM",
]);
// Canonical SSO type label the skill reports in the envelope. We surface
// GOOGLE_SAML as the canonical type even when the ticket says
// GOOGLE_WORKSPACE_CLASSROOM — the setup email is identical and GOOGLE_SAML
// is the more conventional name. The original ticket field is preserved
// in `outreach.sso_type_ticket` for audit.
const CANONICAL_SSO_TYPE = "GOOGLE_SAML";

// Per-call HTTP timeouts — Node's fetch has no default. Without these,
// a stuck TLS handshake or silent TCP drop can hang the whole replica
// run and block the bridge queue.
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_WRITE_TIMEOUT_MS = 60_000;

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

/**
 * Retry an async fn with exponential backoff. Use for critical writes
 * AFTER the real side-effect (email sent) has happened. Losing the
 * follow-up write costs us idempotency / audit trail, so we lean on
 * retries to survive transient Forge/Railway hiccups.
 */
async function withRetry(label, fn, { attempts = 4, baseMs = 100 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const wait = baseMs * Math.pow(4, i);
      process.stderr.write(`[retry] ${label} attempt ${i + 1}/${attempts} failed: ${err.message}; sleeping ${wait}ms\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

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

// Gmail identifiers for the message we send, captured at send time. Module
// scope because buildCommentBody() folds them into the marker line.
let gmailThreadId = null;
let gmailMessageId = null;
// Gmail ids are mailbox-scoped (see fetchRfc822MessageId). Record BOTH which
// mailbox they belong to and the globally-unique RFC822 Message-ID.
// The mailbox the send actually left from. Persisted alongside the ids because
// Gmail ids are mailbox-scoped (see fetchRfc822MessageId) — a consumer sweeping a
// different mailbox needs to know which mailbox a persisted id belongs to.
// Derived from GMAIL_FROM rather than hardcoded so it cannot drift from the
// address gmailSend() actually uses.
const GMAIL_MAILBOX = (/<([^>]+)>/.exec(process.env.GMAIL_FROM || "")?.[1]
  || process.env.GMAIL_FROM || "edith@edlio.com").trim();
let gmailRfc822Id = null;

const ctx = {
  runId,
  ticketKey: inputs.ticket_key,
  dryRun,
  triggeredBy,
  forceRerun: inputs.force_rerun === true,
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
    sso_type: null,
    sso_type_source: null,
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

  // Step 2: type guard (APP + APP_SSO)
  if (ticket.product !== "APP" || ticket.integrationType !== "APP_SSO") {
    recordNote(
      `Ticket is ${ticket.product || "?"}/${ticket.integrationType || "?"} — not APP/APP_SSO.`,
      "observation",
      "warn"
    );
    return done({
      status: "wrong_type",
      ticket_key: ctx.ticketKey,
      sso_type: null,
      sso_type_source: null,
      declined_reason: `product=${ticket.product} integrationType=${ticket.integrationType}; app-sso-google only handles APP+APP_SSO with Google SSO`,
      routing_suggestion: routingHint(ticket),
    });
  }

  // Step 2.5: SSO type guard. Need ssoTypeApp set, and it must be one of the
  // Google variants this skill covers.
  const ticketSsoType = ticket.ssoTypeApp;
  if (!ticketSsoType) {
    recordNote(
      "Ticket has no ssoTypeApp set. Set the SSO type to a Google variant (GOOGLE_SAML or GOOGLE_WORKSPACE_CLASSROOM) and re-dispatch.",
      "observation",
      "warn"
    );
    return done({
      status: "needs_input",
      ticket_key: ctx.ticketKey,
      sso_type: null,
      sso_type_source: null,
      missing: ["ssoTypeApp"],
      note: "Ticket has no ssoTypeApp set. Set the SSO type to a Google variant on the ticket.",
      outreach: { reason: "missing_sso_type" },
    });
  }
  if (!IN_SCOPE_SSO_TYPES.has(ticketSsoType)) {
    recordNote(
      `Ticket ssoTypeApp="${ticketSsoType}" is not a Google variant. app-sso-google only handles Google Workspace SSO.`,
      "observation",
      "warn"
    );
    return done({
      status: "declined",
      ticket_key: ctx.ticketKey,
      sso_type: ticketSsoType,
      sso_type_source: "ticket_field",
      declined_reason: `ssoTypeApp=${ticketSsoType}; app-sso-google only handles GOOGLE_SAML / GOOGLE_WORKSPACE_CLASSROOM`,
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
      sso_type: CANONICAL_SSO_TYPE,
      sso_type_source: "skill_default",
      prior_run: priorRun,
      outreach: { reason: "already_sent" },
    });
  }

  // Step 4: resolve recipients
  const { toList, ccList, missingReason } = resolveRecipients(ticket);
  if (missingReason) {
    return done({
      status: "needs_input",
      ticket_key: ctx.ticketKey,
      sso_type: CANONICAL_SSO_TYPE,
      sso_type_source: "skill_default",
      missing: [missingReason],
      note:
        missingReason === "pocEmail"
          ? "Ticket has no POC email. Add pocEmail to the ticket (Jira-synced tickets often start null)."
          : `Missing required field: ${missingReason}`,
      outreach: { reason: "missing_poc_email" },
    });
  }

  // Step 5: render template
  const templateFile = "google_workspace.html";
  const templateVars = buildTemplateVars(ticket);
  const htmlBody = renderEmailTemplate(templateFile, templateVars);
  const subject = `${ticket.schoolName || ctx.ticketKey} — Google Workspace SSO setup`;

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
        sso_type: CANONICAL_SSO_TYPE,
        template: templateFile,
      },
    });
  } else {
    try {
      const sent = await gmailSend({ to: toList, cc: ccList, subject, htmlBody });
      gmailThreadId = sent.threadId;
      gmailMessageId = sent.messageId;
      gmailRfc822Id = fetchRfc822MessageId(gmailMessageId);
      recordAction({
        type: "gmail.message.send",
        status: "success",
        details: {
          to: toList, cc: ccList, subject,
          sso_type: CANONICAL_SSO_TYPE, template: templateFile,
          gmail_thread_id: gmailThreadId, gmail_message_id: gmailMessageId,
          gmail_mailbox: GMAIL_MAILBOX, rfc822_message_id: gmailRfc822Id,
        },
      });
    } catch (err) {
      recordAction({
        type: "gmail.message.send",
        status: "failed",
        details: { to: toList, cc: ccList, subject, sso_type: CANONICAL_SSO_TYPE, error: err.message },
      });
      recordError("gmail.send_failed", err);
      return done({
        status: "error",
        ticket_key: ctx.ticketKey,
        sso_type: CANONICAL_SSO_TYPE,
        sso_type_source: "skill_default",
        note: `gmail send failed: ${err.message}`,
        outreach: {
          email_to: toList,
          email_cc: ccList,
          email_subject: subject,
          template: templateFile,
          reason: "email_send_failed",
        },
      });
    }
  }
  const emailSentAt = new Date().toISOString();

  // Step 7: post Forge comment with marker
  const commentBody = buildCommentBody({
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
      const c = await withRetry(
        "forge.comment.create",
        () => forgePostComment(ctx.ticketKey, commentBody),
      );
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
        await withRetry(
          "forge.ticket.transition",
          () => forgePatchStatus(ctx.ticketKey, "INITIAL_CONTACT"),
        );
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
    sso_type: CANONICAL_SSO_TYPE,
    sso_type_source: "skill_default",
    outreach: {
      email_to: toList,
      email_cc: ccList,
      email_subject: subject,
      email_sent_at: dryRun ? null : emailSentAt,
      template: templateFile,
      sso_type_ticket: ticketSsoType,
      gmail_thread_id: gmailThreadId,
      gmail_message_id: gmailMessageId,
      gmail_mailbox: GMAIL_MAILBOX,
      rfc822_message_id: gmailRfc822Id,
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
// Forge API
// ==========================================================================

function forgeHeaders() {
  const secret = process.env.FORGE_SHARED_SECRET;
  if (!secret) throw new Error("FORGE_SHARED_SECRET not in env");
  return {
    "x-forge-secret": secret,
    "x-forge-actor": "app-sso-google",
    "content-type": "application/json",
  };
}

function forgeUrl(path) {
  const base = process.env.FORGE_URL || process.env.FORGE_BASE_URL;
  if (!base) throw new Error("FORGE_URL (or FORGE_BASE_URL) not in env");
  return `${base.replace(/\/$/, "")}${path}`;
}

async function forgeGetTicket(key) {
  const res = await fetchT(forgeUrl(`/api/tickets/${encodeURIComponent(key)}`), {
    headers: forgeHeaders(),
  });
  if (!res.ok) {
    throw new Error(`forge GET /api/tickets/${key} -> HTTP ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return body.ticket;
}

async function forgePostComment(key, body) {
  const res = await fetchT(forgeUrl(`/api/tickets/${encodeURIComponent(key)}/comments`), {
    method: "POST",
    headers: forgeHeaders(),
    body: JSON.stringify({ body }),
  }, FETCH_WRITE_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`forge POST comment -> HTTP ${res.status}: ${await res.text()}`);
  }
  const j = await res.json();
  return j.comment;
}

async function forgePatchStatus(key, status) {
  const res = await fetchT(forgeUrl(`/api/tickets/${encodeURIComponent(key)}`), {
    method: "PATCH",
    headers: forgeHeaders(),
    body: JSON.stringify({ status }),
  }, FETCH_WRITE_TIMEOUT_MS);
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
  const senderEmail = (process.env.GMAIL_FROM || "edith@edlio.com").match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase() || "edith@edlio.com";
  const pocLower = pocEmail.toLowerCase();

  // CC both reporter and assignee — the team that owns the ticket and
  // needs to follow the thread. Skip if either is the POC, the sender
  // (edith), or already in CC.
  const ccList = [];
  const seen = new Set([pocLower, senderEmail]);
  for (const person of [ticket.reporter, ticket.assignee]) {
    const email = person?.email?.trim();
    if (!email || !isValidEmail(email)) continue;
    const lower = email.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    ccList.push(email);
  }

  // Mandatory: every client email from this agent CCs the data-integrations
  // distro so the team always has the thread. Deduped against POC/sender.
  if (!seen.has(DATA_INTEGRATIONS_CC)) {
    seen.add(DATA_INTEGRATIONS_CC);
    ccList.push(DATA_INTEGRATIONS_CC);
  }

  return { toList, ccList, missingReason: null };
}

// ==========================================================================
// Template rendering
// ==========================================================================

function buildTemplateVars(ticket) {
  return {
    poc_first_name: derivePocFirstName(ticket),
    reporter_intro: buildReporterIntro(ticket),
    dashboard_display: DASHBOARD_DISPLAY[ticket.dashboard] || "Edlio",
    school_name: ticket.schoolName || "",
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

function buildCommentBody({ to, cc, dryRun }) {
  const lines = [];
  const actor = triggeredBy ? `${triggeredBy} (via Edith)` : "Edith";
  const verb = dryRun ? "would send" : "sent";
  lines.push(`${actor} ${verb} Google Workspace SSO setup email to ${to.join(", ")}${cc.length ? ` (cc ${cc.join(", ")})` : ""}.`);
  lines.push("");
  lines.push(`${MARKER_TAG} ${MARKER_EVENT} run_id=${ctx.runId} ts=${new Date().toISOString()} skill_version=${SKILL_VERSION}${triggeredBy ? ` triggered_by=${triggeredBy}` : ""}${gmailThreadId ? ` gmail_thread_id=${gmailThreadId}` : ""}${gmailMessageId ? ` gmail_message_id=${gmailMessageId}` : ""}${gmailThreadId || gmailMessageId ? ` gmail_mailbox=${GMAIL_MAILBOX}` : ""}${gmailRfc822Id ? ` rfc822_message_id=${gmailRfc822Id}` : ""}`);
  return lines.join("\n");
}

// ==========================================================================
// Gmail (gws CLI)
// ==========================================================================


/**
 * gws wraps its JSON in a keyring preamble and sometimes a trailing `Tip:`
 * line, so JSON.parse on the raw stdout fails with "Unexpected token". Slice
 * from the first `{` to the last `}`.
 *
 * Returns { messageId, threadId }. Gmail's threadId is the durable join key
 * between a ticket and every message in its conversation — including replies
 * from addresses that are not the ticket's pocEmail. Persisting it is what
 * lets the inbound matcher do an exact lookup instead of guessing by domain.
 * Never throw from here: the email is already sent by the time we parse, so a
 * parse failure must degrade to nulls, not lose the send.
 */
function parseGwsSendResult(stdout) {
  try {
    const s = String(stdout || "");
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a === -1 || b <= a) return { messageId: null, threadId: null };
    const o = JSON.parse(s.slice(a, b + 1));
    // Gmail can exit 0 and still hand back an error-shaped body. Treating that
    // as "sent, ids unknown" would record a success for a message that never
    // left, so surface it instead of degrading.
    if (o && o.error) return { messageId: null, threadId: null, error: o.error };
    return { messageId: o.id || null, threadId: o.threadId || null };
  } catch {
    return { messageId: null, threadId: null };
  }
}

/**
 * Fetch the RFC822 Message-ID of a message we just sent.
 *
 * WHY: Gmail's `threadId` (and `id`) are MAILBOX-SCOPED. Verified 2026-08-07 —
 * the identical conversation, same RFC822 Message-IDs, carries different
 * threadIds in edith@ and di@:
 *     edith@  thread=19faa8392042b8ed
 *     di@     thread=19faa83a14d8bdbf
 * So a threadId persisted from THIS mailbox's send cannot be matched against an
 * inbound message seen in the OTHER mailbox — which is exactly what the inbound
 * consumer does (it sweeps di@, while app-* setup mail is sent from edith@).
 * The RFC822 Message-ID is globally unique and mailbox/provider independent, so
 * it is the join key that actually works: inbound In-Reply-To / References
 * point at it.
 *
 * Fails SOFT and returns null. The mail has already been sent by the time this
 * runs; throwing here would report a failure for a message the client received.
 */
function fetchRfc822MessageId(gmailId) {
  if (!gmailId) return null;
  try {
    const params = JSON.stringify({
      userId: "me",
      id: gmailId,
      format: "metadata",
      metadataHeaders: ["Message-ID"],
    });
    const r = spawnSync("gws", ["gmail", "users", "messages", "get", "--params", params], {
      encoding: "utf-8",
      env: { ...process.env },
    });
    if (r.status !== 0) return null;
    const s = String(r.stdout || "");
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a === -1 || b <= a) return null;
    const o = JSON.parse(s.slice(a, b + 1));
    if (o.error) return null;
    const h = (o.payload?.headers || []).find((x) => x.name.toLowerCase() === "message-id");
    // Store the BARE id (no angle brackets). Verified 2026-08-07: Gmail returns
    // the header with brackets, `<CAMexL4Z...@mail.gmail.com>`, but (a) DSN
    // parsing already normalises to bare, and (b) a `<...>` inside a marker line
    // in a Forge comment body risks being eaten as an HTML tag on render. Bare
    // form is the only representation both producer and consumer agree on.
    return h ? h.value.trim().replace(/^</, "").replace(/>$/, "") : null;
  } catch {
    return null;
  }
}

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
  const parsed = parseGwsSendResult(r.stdout);
  if (parsed.error) {
    throw new Error(`gws gmail send returned an error body: ${JSON.stringify(parsed.error)}`);
  }
  return parsed;
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
  if (ticket.product === "CMS") return "CMS SSO ticket — route to Raul (CMS SSO lane)";
  if (ticket.integrationType === "APP_SFTP") return "SFTP ticket — drop app-sftp instead";
  if (ticket.integrationType === "APP_API") return "API ticket — drop app-api instead";
  if (ticket.integrationType === "APP_SSO") {
    const t = ticket.ssoTypeApp;
    if (t === "MICROSOFT365_SAML") return "Microsoft SSO — no skill yet; manual outreach required";
    if (t === "CLEVER_SSO") return "Clever SSO — no skill yet; manual outreach required";
    if (t === "CUSTOM_SAML") return "Custom SAML — no skill yet; manual outreach required";
    return "App SSO — pick the appropriate SSO skill for the ticket's ssoTypeApp";
  }
  return "not an App-SSO Google ticket";
}

function recordAction(a) { ctx.actions.push({ ts: new Date().toISOString(), ...a }); }
function recordNote(message, type = "observation", severity = "info") {
  // Coerce to the schema enum: ["info","warn","error"]. "warning" -> "warn", unknown -> "info".
  const SEV = { info: "info", warn: "warn", warning: "warn", error: "error" };
  severity = SEV[String(severity).toLowerCase()] || "info";
  ctx.notes.push({ type, message, severity });
}
function recordError(where, err) {
  ctx.errors.push({
    at: new Date().toISOString(),
    code: where.includes(".") ? where : `apsssogoogle.${where}`,
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
    taskName: "app-sso-google",
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

  process.stderr.write(`[app-sso-google] status=${outerStatus} dataStatus=${dataStatus} actions=${ctx.actions.length} errors=${ctx.errors.length}\n`);
  process.stdout.write(`<<RESULT>>${JSON.stringify(envelope)}<<END>>\n`);
}
