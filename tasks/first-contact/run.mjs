#!/usr/bin/env node
/**
 * first-contact — send the Data Integrations first-contact
 * acknowledgement for a Forge ticket, from di@edlio.com.
 *
 * This is the Edith-native replacement for Diana's `bard` skill (Tier 1 of
 * knowledge/diana-handover.md). It is an ACKNOWLEDGEMENT ONLY — it tells the
 * client we received their request and a human will follow up. It is NOT the
 * full provisioning email (that stays in app-sftp / app-api / app-sso-google,
 * which send from edith@edlio.com).
 *
 * Template, headers and subject shape were reverse-engineered verbatim from
 * di@edlio.com's Sent folder on 2026-08-03 — see knowledge/di-mailbox.md.
 * Do not "improve" the wording. Bard's copy is what clients already know.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SKILL_VERSION = "0.2.1";
const TASK_NAME = "first-contact";

const FROM_ADDRESS = "di@edlio.com";
const REPLY_TO = "dataintegrations@edlio.com";
const DATA_INTEGRATIONS_CC = "dataintegrations@edlio.com";

const MARKER_TAG = "[first-contact]";
const MARKER_EVENT = "ack-sent";

// If any of these markers is already on the ticket, a *full* setup email has
// already gone out. Sending a "we received your request" ack after that would
// look broken to the client, so we decline.
const DOWNSTREAM_MARKERS = ["[app-sftp]", "[app-api]", "[app-sso-google]"];

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_WRITE_TIMEOUT_MS = 60_000;

// Isolated gws profile holding di@edlio.com's OAuth credentials. gws stores
// exactly one credential set per HOME, so we must not use Edith's own HOME
// or we'd send as edith@edlio.com.
const GWS_DI_HOME = process.env.GWS_DI_HOME || "/home/edith/gws-di";

// integrationType -> the {TYPE} token Bard puts in subject + body.
const TYPE_TOKENS = {
  APP_SFTP: "SFTP",
  APP_API: "API",
  APP_SSO: "SSO",
  CMS_SSO: "SSO",
  CMS_SIS: "SIS",
  CMS_LDAP: "LDAP",
  PAY_SFTP: "SFTP",
};

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

const runId = process.env.REPLICLAW_RUN_ID || "run_unknown";
const inputs = readInputsFromStdin();
const dryRun = inputs.dry_run === true;
const triggeredBy =
  typeof inputs.triggered_by === "string" && inputs.triggered_by ? inputs.triggered_by : null;

// Gmail identifiers for the message we send, captured at send time. Module
// scope because buildCommentBody() folds them into the marker block.
let gmailThreadId = null;
let gmailMessageId = null;

const ctx = {
  runId,
  _startedAt: new Date().toISOString(),
  actions: [],
  notes: [],
  errors: [],
};

// ==========================================================================
// Main
// ==========================================================================

async function main() {
  const ticketKey = String(inputs.ticket_key || "").trim();
  if (!ticketKey) {
    recordError("missing.ticketkey", new Error("ticket_key input is required"));
    return done({ status: "error", ticket_key: null });
  }

  // --- 1. Read the ticket -------------------------------------------------
  let ticket;
  try {
    ticket = await forgeGetTicket(ticketKey);
  } catch (err) {
    recordError("forge.get", err);
    return done({ status: "error", ticket_key: ticketKey });
  }
  if (!ticket) {
    recordError("forge.notfound", new Error(`ticket ${ticketKey} not found`));
    return done({ status: "error", ticket_key: ticketKey });
  }
  recordAction({
    type: "forge.ticket.read",
    status: "success",
    details: {
      key: ticketKey,
      product: ticket.product ?? null,
      integration_type: ticket.integrationType ?? null,
      ticket_status: ticket.status ?? null,
    },
  });

  // --- 2. Resolve the {TYPE} token ---------------------------------------
  const type = TYPE_TOKENS[ticket.integrationType];
  if (!type) {
    recordNote(
      `integrationType ${ticket.integrationType ?? "(none)"} has no first-contact TYPE token; declining`,
      "guardrail",
      "warn"
    );
    return done({
      status: "declined",
      ticket_key: ticketKey,
      reason: `unsupported integrationType: ${ticket.integrationType ?? "(none)"}`,
    });
  }

  // --- 2b. Issue-class guard ---------------------------------------------
  // Bard only ever acked kind=NEW_INTEGRATION. Verified 8/3 against di@'s Sent
  // folder: all 13 acked backlog tickets are NEW_INTEGRATION, all 12 Issue-class
  // ones were skipped — and liveStatus is NOT the discriminator (LIVE
  // NEW_INTEGRATION tickets were acked). Acking an Issue on a live integration
  // sends "thanks for your new integration request" to a client reporting a
  // broken sync — the SS-449 failure mode. Issue tickets go to human triage.
  const kind = ticket.kind ?? null;
  if (kind !== "NEW_INTEGRATION") {
    recordNote(
      `ticket kind is ${kind ?? "(none)"}, not NEW_INTEGRATION; first contact is for new integrations only`,
      "guardrail",
      "info"
    );
    return done({
      status: "declined",
      ticket_key: ticketKey,
      reason: `kind ${kind ?? "(none)"} is not NEW_INTEGRATION — Issue-class tickets need human triage`,
    });
  }

  // --- 3. Dup-send / downstream guard ------------------------------------
  let comments = [];
  try {
    comments = await forgeGetComments(ticketKey);
  } catch (err) {
    // A comment-read failure must not let us send blind — that risks a
    // duplicate ack. Fail closed.
    recordError("forge.comments", err);
    return done({ status: "error", ticket_key: ticketKey });
  }

  const prior = findMarker(comments, MARKER_TAG, MARKER_EVENT);
  if (prior && inputs.force_rerun !== true) {
    recordNote(`prior ${MARKER_TAG} ${MARKER_EVENT} marker found; declining`, "idempotency", "info");
    return done({
      status: "already_sent",
      ticket_key: ticketKey,
      reason: "first-contact ack already sent",
      prior_marker_at: prior.createdAt ?? null,
    });
  }

  const downstream = DOWNSTREAM_MARKERS.map((tag) => findMarker(comments, tag, null)).filter(Boolean);
  if (downstream.length && inputs.force_rerun !== true) {
    recordNote(
      "a full setup email has already been sent on this ticket; an ack would confuse the client",
      "guardrail",
      "warn"
    );
    return done({
      status: "declined",
      ticket_key: ticketKey,
      reason: "downstream setup email already sent",
    });
  }

  // --- 3b. Mailbox-of-record guard ---------------------------------------
  // The Forge marker only exists for acks *this* skill sent. Diana's Bard
  // tracked state in watermark files, so every ticket she already acked looks
  // un-acked to us. di@'s Sent folder is the authoritative record for both
  // senders — check it. This also closes the marker-post-failure window: if a
  // prior run sent the mail but failed to comment, we still find the message.
  if (inputs.force_rerun !== true) {
    let priorSent = null;
    try {
      priorSent = findSentAck(ticketKey);
    } catch (err) {
      // Fail closed — an unverifiable mailbox means we cannot rule out a
      // duplicate, and duplicates are worse than delays.
      recordError("bardfc.sentcheck", err);
      recordNote(
        "could not search di@ Sent folder to rule out a prior ack; refusing to send",
        "guardrail",
        "error"
      );
      return done({ status: "error", ticket_key: ticketKey, reason: "sent-folder check failed" });
    }
    if (priorSent) {
      recordNote(
        `di@ Sent folder already contains a first-contact message for ${ticketKey} (likely Diana's Bard); declining`,
        "idempotency",
        "info"
      );
      return done({
        status: "already_sent",
        ticket_key: ticketKey,
        reason: "first-contact message already present in di@ Sent folder",
        prior_marker_at: priorSent,
      });
    }
  }

  // --- 4. Recipients ------------------------------------------------------
  const pocEmail = String(ticket.pocEmail || "").trim();
  if (!pocEmail || !isValidEmail(pocEmail)) {
    recordNote("ticket has no valid pocEmail; cannot send first contact", "missing-input", "warn");
    recordError("bardfc.missing.pocemail", new Error("ticket has no valid pocEmail"));
    return done({
      status: "needs_input",
      ticket_key: ticketKey,
      reason: "ticket has no valid pocEmail — a human must source the client contact",
      missing_fields: ["pocEmail"],
    });
  }

  const to = [pocEmail];
  const cc = [DATA_INTEGRATIONS_CC];
  // Forge returns the reporter as a nested object; older/flatter shapes are
  // tolerated so this keeps working if the API response is ever trimmed.
  const reporterEmail = String(
    ticket.reporter?.email || ticket.reporter_email || ticket.reporterEmail || ""
  ).trim();
  if (
    reporterEmail &&
    isValidEmail(reporterEmail) &&
    reporterEmail.toLowerCase() !== pocEmail.toLowerCase() &&
    reporterEmail.toLowerCase() !== FROM_ADDRESS &&
    reporterEmail.toLowerCase() !== DATA_INTEGRATIONS_CC
  ) {
    cc.push(reporterEmail);
  }

  // --- 5. Render ----------------------------------------------------------
  const pocName = String(ticket.pocName || "").trim();
  const greeting = pocName ? `Hello ${pocName},` : "Hello,";
  const title = String(ticket.title || ticket.schoolName || ticketKey).trim();
  const subject = `Edlio Data Integrations - New ${type} Integration for ${title} (${ticketKey})`;
  const body = renderTemplate("first-contact.txt", { GREETING: greeting, TYPE: type });

  // --- 6. Send ------------------------------------------------------------
  if (dryRun) {
    recordAction({
      type: "email.send",
      status: "skipped",
      details: { dry_run: true, from: FROM_ADDRESS, reply_to: REPLY_TO, to, cc, subject },
    });
  } else {
    try {
      const sent = gmailSendAsDi({ to, cc, subject, textBody: body });
      gmailThreadId = sent.threadId;
      gmailMessageId = sent.messageId;
      recordAction({
        type: "email.send",
        status: "success",
        details: {
          from: FROM_ADDRESS, reply_to: REPLY_TO, to, cc, subject,
          gmail_thread_id: gmailThreadId, gmail_message_id: gmailMessageId,
        },
      });
    } catch (err) {
      recordError("bardfc.email.send", err);
      recordAction({ type: "email.send", status: "failed", details: { to, cc, subject } });
      return done({ status: "error", ticket_key: ticketKey, reason: "email send failed" });
    }
  }

  // --- 7. Marker comment --------------------------------------------------
  // The email is already out. From here on, failures are audit-trail losses,
  // not client-facing — so retry hard and degrade to `partial`.
  const commentBody = buildCommentBody({ type, to, cc, subject, dryRun });
  let commentOk = false;
  if (dryRun) {
    recordAction({ type: "forge.comment.create", status: "skipped", details: { dry_run: true } });
    commentOk = true;
  } else {
    try {
      await withRetry("forge.comment", () => forgePostComment(ticketKey, commentBody));
      recordAction({ type: "forge.comment.create", status: "success", details: {} });
      commentOk = true;
    } catch (err) {
      recordError("bardfc.forge.comment", err);
      recordAction({ type: "forge.comment.create", status: "failed", details: {} });
      recordNote(
        "ack email WAS sent but the idempotency marker failed to post — a re-run could double-send",
        "idempotency",
        "error"
      );
    }
  }

  return done({
    status: commentOk ? "ok" : "partial",
    ticket_key: ticketKey,
    type,
    outreach: {
      from: FROM_ADDRESS,
      reply_to: REPLY_TO,
      to,
      cc,
      subject,
      greeting_name: pocName || null,
      gmail_thread_id: gmailThreadId,
      gmail_message_id: gmailMessageId,
    },
    forge: { marker_posted: commentOk },
  });
}

// ==========================================================================
// Forge
// ==========================================================================

function forgeHeaders() {
  const secret = process.env.FORGE_SHARED_SECRET;
  if (!secret) throw new Error("FORGE_SHARED_SECRET is not set");
  return {
    "content-type": "application/json",
    "x-forge-secret": secret,
    "x-forge-actor": triggeredBy || FROM_ADDRESS,
  };
}

function forgeUrl(path) {
  const base = (process.env.FORGE_URL || process.env.FORGE_BASE_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("FORGE_URL / FORGE_BASE_URL is not set");
  return `${base}${path}`;
}

async function forgeGetTicket(key) {
  const r = await fetchT(forgeUrl(`/api/tickets/${encodeURIComponent(key)}`), {
    headers: forgeHeaders(),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ticket ${key} -> ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.ticket || j;
}

async function forgeGetComments(key) {
  const r = await fetchT(forgeUrl(`/api/tickets/${encodeURIComponent(key)}/comments`), {
    headers: forgeHeaders(),
  });
  if (!r.ok) throw new Error(`GET comments ${key} -> ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.comments || j || [];
}

async function forgePostComment(key, body) {
  const r = await fetchT(
    forgeUrl(`/api/tickets/${encodeURIComponent(key)}/comments`),
    { method: "POST", headers: forgeHeaders(), body: JSON.stringify({ body }) },
    FETCH_WRITE_TIMEOUT_MS
  );
  if (!r.ok) throw new Error(`POST comment ${key} -> ${r.status} ${await r.text()}`);
  return r.json().catch(() => ({}));
}

function findMarker(comments, tag, event) {
  const list = Array.isArray(comments) ? comments : [];
  for (const c of list) {
    const body = String(c.body || c.content || "");
    if (!body.includes(tag)) continue;
    if (event && !body.includes(event)) continue;
    return c;
  }
  return null;
}

function buildCommentBody({ type, to, cc, subject, dryRun }) {
  const lines = [
    `${MARKER_TAG} ${MARKER_EVENT}${dryRun ? " (dry-run)" : ""}`,
    "",
    `First-contact acknowledgement sent for a new ${type} integration.`,
    "",
    `From: ${FROM_ADDRESS}`,
    `Reply-To: ${REPLY_TO}`,
    `To: ${to.join(", ")}`,
    `Cc: ${cc.join(", ")}`,
    `Subject: ${subject}`,
    "",
    "This is an acknowledgement only — no credentials were provisioned and no",
    "setup instructions were sent. Assign the ticket and run the matching",
    "provisioning skill to continue.",
  ];
  if (triggeredBy) lines.push("", `Triggered by: ${triggeredBy}`);
  if (gmailThreadId) {
    lines.push("", `gmail_thread_id=${gmailThreadId}${gmailMessageId ? ` gmail_message_id=${gmailMessageId}` : ""}`);
  }
  return lines.join("\n");
}

// ==========================================================================
// Gmail — send as di@edlio.com
// ==========================================================================

/**
 * gws has no --reply-to flag, and Gmail does NOT apply the sendAs
 * replyToAddress to API messages.send. So we build raw RFC-5322 MIME and
 * hand it to users.messages.send ourselves.
 */
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

function gmailSendAsDi({ to, cc, subject, textBody }) {
  const mime = buildMime({ to, cc, subject, textBody });
  const raw = Buffer.from(mime, "utf-8").toString("base64url");

  const r = spawnSync(
    "gws",
    [
      "gmail",
      "users",
      "messages",
      "send",
      "--params",
      JSON.stringify({ userId: "me" }),
      "--json",
      JSON.stringify({ raw }),
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: GWS_DI_HOME,
        GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file",
      },
    }
  );
  if (r.status !== 0) {
    throw new Error(`gws messages.send failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  const parsed = parseGwsSendResult(r.stdout);
  if (parsed.error) {
    throw new Error(`gws gmail send returned an error body: ${JSON.stringify(parsed.error)}`);
  }
  return parsed;
}

/**
 * Search di@'s Sent folder for an existing first-contact message for this
 * ticket. Returns the message's internal date (ISO) or null.
 *
 * Matches on the ticket key in parentheses, which is the stable tail of every
 * Bard subject line: "... Integration for <title> (INT-123)".
 */
function findSentAck(ticketKey) {
  const q = `in:sent subject:"Data Integrations" subject:"(${ticketKey})"`;
  const r = spawnSync(
    "gws",
    [
      "gmail",
      "users",
      "messages",
      "list",
      "--params",
      JSON.stringify({ userId: "me", q, maxResults: 5 }),
    ],
    {
      encoding: "utf-8",
      env: { ...process.env, HOME: GWS_DI_HOME, GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file" },
    }
  );
  if (r.status !== 0) {
    throw new Error(`gws messages.list failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout || "{}");
  } catch {
    throw new Error(`gws messages.list returned non-JSON: ${(r.stdout || "").slice(0, 200)}`);
  }
  const msgs = parsed.messages || [];
  if (!msgs.length) return null;

  // Gmail's subject: operator tokenises, so "(INT-10)" can also match
  // "(INT-104)". Confirm the exact key against the real subject header.
  for (const m of msgs) {
    const g = spawnSync(
      "gws",
      [
        "gmail",
        "users",
        "messages",
        "get",
        "--params",
        JSON.stringify({ userId: "me", id: m.id, format: "metadata" }),
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, HOME: GWS_DI_HOME, GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file" },
      }
    );
    if (g.status !== 0) continue;
    let msg;
    try {
      msg = JSON.parse(g.stdout || "{}");
    } catch {
      continue;
    }
    const headers = msg?.payload?.headers || [];
    const subj = headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
    if (!subj.includes(`(${ticketKey})`)) continue;
    const internal = Number(msg.internalDate);
    return Number.isFinite(internal) ? new Date(internal).toISOString() : "unknown";
  }
  return null;
}

function buildMime({ to, cc, subject, textBody }) {
  const headers = [
    `From: ${FROM_ADDRESS}`,
    `Reply-To: ${REPLY_TO}`,
    `To: ${to.join(", ")}`,
  ];
  if (cc.length) headers.push(`Cc: ${cc.join(", ")}`);
  headers.push(
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit"
  );
  return headers.join("\r\n") + "\r\n\r\n" + textBody.replace(/\r?\n/g, "\r\n");
}

/**
 * RFC 2047 encode a header value, only when it contains non-ASCII.
 *
 * Long headers are folded into multiple encoded-words so no physical line
 * exceeds RFC 5322's 78-char guidance. Gmail tolerates a single long line,
 * but stricter relays in the delivery path do not. Chunking is done on
 * *characters* then verified per chunk, so multi-byte characters (the em-dash
 * that appears in most ticket titles) never get split mid-sequence.
 */
function encodeHeader(v, name = "Subject") {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(v)) return v;

  const PREFIX = "=?UTF-8?B?";
  const SUFFIX = "?=";
  // RFC 2047: an encoded-word is at most 75 chars including delimiters.
  // RFC 5322: a physical line should stay within 78. The first line also
  // carries "Subject: ", and continuation lines carry one leading space.
  const wordBudget = (isFirst) =>
    Math.min(75, 78 - (isFirst ? name.length + 2 : 1)) - PREFIX.length - SUFFIX.length;

  // base64 emits 4 chars per 3 bytes, so round the byte budget down to a
  // multiple of 3 to avoid padding pushing us over.
  const byteBudget = (isFirst) => Math.max(3, Math.floor(wordBudget(isFirst) / 4) * 3);

  const words = [];
  let buf = "";
  let budget = byteBudget(true);
  // Iterate by code point so multi-byte characters — the em-dash present in
  // most ticket titles — are never split mid-sequence.
  for (const ch of v) {
    const next = buf + ch;
    if (Buffer.byteLength(next, "utf-8") > budget) {
      words.push(buf);
      buf = ch;
      budget = byteBudget(false);
    } else {
      buf = next;
    }
  }
  if (buf) words.push(buf);

  return words
    .map((w) => `${PREFIX}${Buffer.from(w, "utf-8").toString("base64")}${SUFFIX}`)
    .join("\r\n "); // continuation lines must begin with whitespace
}

// ==========================================================================
// Utilities
// ==========================================================================

function renderTemplate(file, vars) {
  const raw = readFileSync(resolve(__dirname, "templates", file), "utf-8");
  return raw.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : ""));
}

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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
}

function recordAction(a) {
  ctx.actions.push({ ts: new Date().toISOString(), details: {}, ...a });
}

function recordNote(message, type = "observation", severity = "info") {
  const SEV = { info: "info", warn: "warn", warning: "warn", error: "error" };
  severity = SEV[String(severity).toLowerCase()] || "info";
  ctx.notes.push({ type, message, severity });
}

function recordError(where, err) {
  ctx.errors.push({
    at: new Date().toISOString(),
    code: where.includes(".") ? where : `bardfc.${where}`,
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
  const failed = ctx.actions.filter((a) => a.status === "failed").length;
  const s = dataPayload.status;
  const outerStatus =
    s === "error" || (failed > 0 && s !== "partial")
      ? "error"
      : s === "partial"
        ? "partial"
        : s === "needs_input"
          ? "needs-input"
          : s === "declined"
            ? "declined"
            : "ok"; // ok | already_sent

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
    data: dataPayload,
  };
  process.stdout.write(`<<RESULT>>${JSON.stringify(envelope)}<</RESULT>>\n`);
}

main().catch((err) => {
  recordError("bardfc.unhandled", err);
  emitResult({ status: "error", skill_version: SKILL_VERSION, dry_run: dryRun, triggered_by: triggeredBy });
  process.exit(0);
});
