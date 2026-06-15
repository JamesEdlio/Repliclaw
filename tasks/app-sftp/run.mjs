#!/usr/bin/env node
// app-sftp task skill — deterministic executable.
//
// Runs under repliclaw with `exec:` frontmatter. Reads task inputs from
// stdin as JSON, emits a Repliclaw <<RESULT>> envelope on stdout.
//
// Flow (see ../SKILL.md for full spec):
//   1. GET Forge ticket
//   2. Type guard (APP + SFTP only)
//   3. Dup-send guard (scan comments for [app-sftp] setup-sent marker)
//   4. Collect POC emails
//   5. FileMage user provision (or reuse)
//   5b. Edlio dashboard FTP account provision (create if missing, DISABLED)
//   6. 1Password item create + 7-day share
//   7. Gmail send via edith@edlio.com
//   8. POST Forge comment with marker
//   9. PATCH Forge ticket BACKLOG -> INITIAL_CONTACT
//
// Everything is idempotent on re-run: dup-send guard short-circuits step 2
// if a prior successful run is detected.

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomFillSync } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SKILL_VERSION = "0.3.1";
const DATA_INTEGRATIONS_CC = "dataintegrations@edlio.com";
const SFTP_HOST = "52.165.175.27";
const SFTP_PORT = 22;
const ONEPASSWORD_VAULT = "Agent: DI-Ana - SFTP";
const SHARE_EXPIRES_IN = "7d";
const MARKER_TAG = "[app-sftp]";
const MARKER_EVENT = "setup-sent";

// Per-call HTTP timeouts. Node's fetch has no default; without these, a
// stuck TLS handshake or silent TCP drop can hang the whole replica run
// and block the bridge queue.
const FETCH_TIMEOUT_MS = 30_000;  // reads
const FETCH_WRITE_TIMEOUT_MS = 60_000;  // writes (FileMage user create, etc.)

// Edlio dashboard API. Used to self-provision the app-dashboard FTP account at
// intake (Step 5b). Constants hoisted here so the helpers below can reach them.
const EDLIO_API = "https://edlio-connect.schoolinfo.app";
const EDLIO_CLIENT_ID = "schoolinfoapp_dashboard";

/**
 * fetch with a hard AbortController timeout. Throws a readable error on
 * timeout instead of hanging forever.
 */
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
 * Retry an async fn with exponential backoff. Use for critical mutations
 * AFTER the real side-effect (email sent) has happened, where losing the
 * follow-up write means losing idempotency / audit trail.
 *
 * Defaults: 4 attempts, ~100ms/400ms/1600ms waits between.
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
      // Don't spam recordNote — just stderr for log trail.
      process.stderr.write(`[retry] ${label} attempt ${i + 1}/${attempts} failed: ${err.message}; sleeping ${wait}ms\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

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
  actions: [],
  notes: [],
  errors: [],
  _startedAt: new Date().toISOString(),
};

try {
  await main();
} catch (err) {
  recordError("pipeline", err);
  emitResult({
    status: "error",
    ticket_key: ctx.ticketKey || "unknown",
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
    ref: ticket.key,
    details: {
      product: ticket.product,
      integrationType: ticket.integrationType,
      status: ticket.status,
      source: ticket.source,
    },
  });

  // Step 2: type guard
  if (ticket.product !== "APP" || ticket.integrationType !== "APP_SFTP") {
    return done({
      status: "wrong_type",
      ticket_key: ticket.key,
      declined_reason: `ticket is ${ticket.product} / ${ticket.integrationType}, not APP / APP_SFTP`,
      routing_suggestion: routingHint(ticket),
    });
  }

  // Step 3: dup-send guard
  const priorRun = ctx.forceRerun ? null : findPriorRun(ticket.comments || []);
  if (priorRun) {
    recordNote("dup-send guard: prior setup-sent marker found, short-circuiting");
    return done({
      status: "already_sent",
      ticket_key: ticket.key,
      prior_run: priorRun,
      note: `Prior run ${priorRun.run_id} sent setup email at ${priorRun.ts}. Pass force_rerun=true to bypass.`,
    });
  }

  // Step 4: collect POC emails
  const to = [];
  if (ticket.pocEmail && isValidEmail(ticket.pocEmail)) {
    to.push(ticket.pocEmail.trim().toLowerCase());
  }
  if (to.length === 0) {
    const reason = ticket.source === "JIRA"
      ? "Jira-synced ticket has no structured POC email. Edit the Forge ticket to add pocEmail, then rerun."
      : "Ticket has no pocEmail. Edit the ticket and retry.";
    recordNote(`needs_input: missing pocEmail — ${reason}`);
    recordError("missingpocemail", new Error(reason));
    return done({
      status: "needs_input",
      ticket_key: ticket.key,
      missing: ["pocEmail"],
      note: reason,
      reason,
    });
  }

  // Build CC list: reporter + assignee — the team that owns the ticket
  // and needs to follow the thread. Skip if either is the POC, the
  // sender (edith), or already on the list.
  const senderEmail = (process.env.GMAIL_FROM || "edith@edlio.com").match(/[\w.+-]+@[\w.-]+/)?.[0]?.toLowerCase() || "edith@edlio.com";
  const toLower = to.map((e) => e.toLowerCase());
  const cc = [];
  const seen = new Set([senderEmail, ...toLower]);
  for (const person of [ticket.reporter, ticket.assignee]) {
    const email = person?.email?.trim();
    if (!email) continue;
    const lower = email.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    cc.push(email);
  }

  // Mandatory: every client email from this agent CCs the data-integrations
  // distro so the team always has the thread. Deduped against POC/sender.
  if (!seen.has(DATA_INTEGRATIONS_CC)) {
    seen.add(DATA_INTEGRATIONS_CC);
    cc.push(DATA_INTEGRATIONS_CC);
  }

  // Step 5: FileMage user provision / reuse
  const schoolName = ticket.schoolName;
  const username = deriveFileMageUsername(schoolName);
  const dashboardLabel = dashboardToFileMageEndpoint(ticket.dashboard);
  const existing = await fileMageFindUser(username);

  let fmUserId, fmProvisionedNow = false, fmEndpointName;

  if (existing) {
    fmUserId = existing.id;
    fmEndpointName = existing.endpoint?.name || dashboardLabel || "unknown";
    recordAction({
      type: "filemage.user.read",
      status: "success",
      ref: `filemage:user:${existing.id}`,
      details: { username, existing: true },
    });
  } else {
    if (dryRun) {
      recordAction({
        type: "filemage.user.create",
        status: "skipped",
        details: { dry_run: true, username, endpoint: dashboardLabel },
      });
      fmUserId = null;
      fmEndpointName = dashboardLabel;
    } else {
      const created = await fileMageCreateUser({ username, endpointName: dashboardLabel });
      fmUserId = created.id;
      fmEndpointName = created.endpoint?.name || dashboardLabel;
      fmProvisionedNow = true;
      recordAction({
        type: "filemage.user.create",
        status: "success",
        ref: `filemage:user:${created.id}`,
        details: { username, endpoint: fmEndpointName },
      });
    }
  }

  // Step 5b: Edlio app-dashboard FTP account (create if missing).
  // FileMage holds the SFTP user, but nothing ingests into Edlio until a
  // dashboard FTP account exists for that username. Create it here at intake
  // so the account is present from day one. Created DISABLED on purpose —
  // Edlio won't let sync enable until an org + schema mapping exist (those are
  // built later by the app-sftp-config skill, and the operator enables on
  // apply). Resolve the district by the ticket's school name.
  const dashFtp = {
    account_id: null,
    district_id: null,
    district_name: null,
    enabled: false,
    created_now: false,
    existing: false,
  };
  try {
    const existingDash = await edlioFindFtpAccount(username);
    if (existingDash) {
      dashFtp.account_id = existingDash.id;
      dashFtp.district_id = existingDash.districtId ?? null;
      dashFtp.enabled = !!existingDash.enabled;
      dashFtp.existing = true;
      recordAction({
        type: "edlio.ftp.read",
        status: "success",
        ref: `edlio:ftp:${existingDash.id}`,
        details: { userName: username, existing: true, enabled: dashFtp.enabled },
      });
    } else if (dryRun) {
      const resolved = await edlioResolveDistrictId(schoolName);
      dashFtp.district_id = resolved?.districtId ?? null;
      dashFtp.district_name = resolved?.districtName ?? null;
      recordAction({
        type: "edlio.ftp.create",
        status: "skipped",
        details: {
          dry_run: true, userName: username,
          district_id: dashFtp.district_id, district_name: dashFtp.district_name,
        },
      });
      if (!resolved) {
        recordNote(
          `dry-run: could not resolve an Edlio district for schoolName=` +
          `${JSON.stringify(schoolName)}; live run would skip dashboard FTP create`,
          "provision", "warning");
      }
    } else {
      const resolved = await edlioResolveDistrictId(schoolName);
      if (!resolved) {
        // Non-fatal: intake (FileMage + outreach) is the primary job. Record a
        // warning so the operator can create the district/org and let the
        // later app-sftp-config run self-provision the account.
        recordAction({
          type: "edlio.ftp.create",
          status: "skipped",
          details: { userName: username, reason: "district_unresolved", school: schoolName },
        });
        recordNote(
          `could not resolve an Edlio district for schoolName=${JSON.stringify(schoolName)}; ` +
          `dashboard FTP account NOT created. Create the district/org in the ` +
          `dashboard, then re-run or let app-sftp-config provision it on apply.`,
          "provision", "warning");
      } else {
        const acct = await edlioCreateFtpAccount({
          userName: username, districtId: resolved.districtId,
        });
        dashFtp.account_id = acct.id;
        dashFtp.district_id = resolved.districtId;
        dashFtp.district_name = resolved.districtName;
        dashFtp.created_now = true;
        recordAction({
          type: "edlio.ftp.create",
          status: "success",
          ref: `edlio:ftp:${acct.id}`,
          details: {
            userName: username,
            district_id: resolved.districtId,
            district_name: resolved.districtName,
            enabled: false,
          },
        });
        recordNote(
          `created Edlio dashboard FTP account ${username} (id=${acct.id}) for ` +
          `district ${resolved.districtName} (id=${resolved.districtId}); left ` +
          `DISABLED until a schema mapping is applied (app-sftp-config).`,
          "provision", "info");
      }
    }
  } catch (err) {
    // Never fail the intake run over the dashboard step — FileMage + outreach
    // already succeeded. Surface it as a recorded error/note for the operator.
    recordAction({
      type: "edlio.ftp.create",
      status: "error",
      details: { userName: username, error: err.message },
    });
    recordNote(
      `dashboard FTP account step failed (non-fatal): ${err.message}. FileMage ` +
      `user + outreach completed; app-sftp-config will self-provision on apply.`,
      "provision", "warning");
  }

  // Step 6: 1Password item create + share
  const itemTitle = `${ticket.key} - ${schoolName}`;
  const password = generatePassword();
  const opMeta = {
    item_id: null,
    share_url: null,
    share_expires_at: null,
  };

  if (dryRun) {
    recordAction({
      type: "op.item.create",
      status: "skipped",
      details: { dry_run: true, vault: ONEPASSWORD_VAULT, title: itemTitle },
    });
    recordAction({
      type: "op.item.share",
      status: "skipped",
      details: { dry_run: true, emails: [...to, ...cc], expires_in: SHARE_EXPIRES_IN },
    });
    opMeta.share_url = "https://share.1password.com/DRY-RUN-PLACEHOLDER";
  } else {
    const item = await opItemCreate({
      title: itemTitle,
      username,
      password,
      host: SFTP_HOST,
      port: SFTP_PORT,
      schoolName,
      ticketKey: ticket.key,
    });
    opMeta.item_id = item.id;
    recordAction({
      type: "op.item.create",
      status: "success",
      ref: `op:item:${item.id}`,
      details: { vault: ONEPASSWORD_VAULT, title: itemTitle },
    });

    const shareRecipients = [...to, ...cc];
    const share = await opItemShare({
      itemId: item.id,
      emails: shareRecipients,
      expiresIn: SHARE_EXPIRES_IN,
    });
    opMeta.share_url = share.url;
    opMeta.share_expires_at = isoPlusDays(7);
    recordAction({
      type: "op.item.share",
      status: "success",
      ref: share.url,
      details: { emails: shareRecipients, expires_in: SHARE_EXPIRES_IN },
    });
  }

  // Step 7: Gmail send
  const pocFirstName = (ticket.pocName || "").trim().split(/\s+/)[0] || "there";
  const reporterName = ticket.reporter?.name || "a member of the Edlio team";
  const sisProvider = ticket.sisProvider?.trim() || "your SIS";
  const emailBody = renderEmailTemplate({
    poc_first_name: pocFirstName,
    reporter_name: reporterName,
    sis_provider: sisProvider,
    onepassword_link: opMeta.share_url || "PENDING",
  });
  const emailSubject = `SFTP Setup — ${schoolName}`;
  const sentAt = new Date().toISOString();

  if (dryRun) {
    recordAction({
      type: "gmail.message.send",
      status: "skipped",
      details: {
        dry_run: true,
        to,
        cc,
        subject: emailSubject,
        body_bytes: emailBody.length,
      },
    });
  } else {
    await gmailSend({
      to,
      cc,
      subject: emailSubject,
      htmlBody: emailBody,
    });
    recordAction({
      type: "gmail.message.send",
      status: "success",
      details: { to, cc, subject: emailSubject },
    });
  }

  // Step 8: POST Forge comment with marker
  const markerLine = `${MARKER_TAG} ${MARKER_EVENT} run_id=${ctx.runId} ts=${sentAt} skill_version=${SKILL_VERSION}${triggeredBy ? ` triggered_by=${triggeredBy}` : ""}`;
  const attribution = triggeredBy
    ? `${triggeredBy} (via Edith) sent the SFTP setup email.`
    : `Edith sent the SFTP setup email.`;
  const commentBody = [
    attribution,
    ``,
    `**To:** ${to.join(", ")}`,
    cc.length ? `**CC:** ${cc.join(", ")}` : null,
    `**FileMage user:** \`${username}\` (${fmEndpointName})`,
    opMeta.share_url ? `**1Password share:** expires in ${SHARE_EXPIRES_IN}` : null,
    ``,
    `---`,
    markerLine,
  ].filter(Boolean).join("\n");

  let commentId = null;
  if (dryRun) {
    recordAction({
      type: "forge.comment.create",
      status: "skipped",
      details: { dry_run: true, ticket_key: ticket.key, marker: MARKER_EVENT },
    });
  } else {
    // Critical post-send write: retry aggressively. If we fail to persist
    // the marker, the next run will re-send the email.
    const c = await withRetry(
      "forge.comment.create",
      () => forgePostComment(ticket.key, commentBody),
    );
    commentId = c.id;
    recordAction({
      type: "forge.comment.create",
      status: "success",
      ref: `forge:comment:${c.id}`,
      details: { ticket_key: ticket.key, marker: MARKER_EVENT },
    });
  }

  // Step 9: PATCH Forge ticket status
  const fromStatus = ticket.status;
  const toStatus = "INITIAL_CONTACT";
  let transitioned = null;
  if (fromStatus === toStatus) {
    recordNote(`ticket already in ${toStatus}; no transition needed`);
  } else if (dryRun) {
    recordAction({
      type: "forge.ticket.transition",
      status: "skipped",
      details: { dry_run: true, from: fromStatus, to: toStatus },
    });
    transitioned = { from: fromStatus, to: toStatus };
  } else {
    await withRetry(
      "forge.ticket.transition",
      () => forgePatchStatus(ticket.key, toStatus),
    );
    recordAction({
      type: "forge.ticket.transition",
      status: "success",
      details: { from: fromStatus, to: toStatus },
    });
    transitioned = { from: fromStatus, to: toStatus };
  }

  // Emit final envelope
  return done({
    status: "ok",
    ticket_key: ticket.key,
    filemage_user: {
      user_id: fmUserId,
      username,
      endpoint_name: fmEndpointName,
      provisioned_now: fmProvisionedNow,
    },
    dashboard_ftp_account: {
      account_id: dashFtp.account_id,
      district_id: dashFtp.district_id,
      district_name: dashFtp.district_name,
      enabled: dashFtp.enabled,
      created_now: dashFtp.created_now,
      existing: dashFtp.existing,
    },
    outreach: {
      email_to: to,
      email_cc: cc,
      email_subject: emailSubject,
      email_sent_at: dryRun ? null : sentAt,
      op_item_id: opMeta.item_id,
      op_share_url: opMeta.share_url,
      op_share_expires_at: opMeta.share_expires_at,
    },
    forge: {
      comment_posted: !dryRun,
      comment_id: commentId,
      status_transition: transitioned,
    },
  });
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

// Resolve a districtId from a school/district name. Tries the districts list
// first (exact, then loose contains), then falls back to the organizations
// list (orgs carry districtId). Returns { districtId, districtName } or null.
async function edlioResolveDistrictId(schoolName) {
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const target = norm(schoolName);
  if (!target) return null;

  const dl = await edlioApiCall("GetAllDistricts");
  const dists = Array.isArray(dl) ? dl : (dl?.items || []);
  // exact normalized match, then "district name contains the school name or
  // vice-versa" (handles "Woodbine" ↔ "Woodbine School District").
  let d = dists.find(x => norm(x.name) === target)
       || dists.find(x => norm(x.name).includes(target) || target.includes(norm(x.name)));
  if (d) return { districtId: d.id, districtName: d.name };

  // Fall back to organizations (they carry districtId).
  const ol = await edlioApiCall("GetAllOrganizations", { includeDisabled: true, includeCanceled: true });
  const orgs = Array.isArray(ol) ? ol : (ol?.items || ol?.organizations || []);
  const o = orgs.find(x => norm(x.name) === target)
         || orgs.find(x => norm(x.name).includes(target) || target.includes(norm(x.name)));
  if (o && o.districtId) {
    const dm = dists.find(x => x.id === o.districtId);
    return { districtId: o.districtId, districtName: dm?.name || o.name };
  }
  return null;
}

// Create a dashboard FTP account for an SFTP user that exists on FileMage but
// has no Edlio FTP account yet. Created DISABLED on purpose: Edlio refuses to
// enable sync until an org mapping + schema mapping exist (those are built by
// the schema-mapping step later in this run / on apply). Returns the full
// edit model of the created account, or throws with the validation errors.
async function edlioCreateFtpAccount({ userName, districtId }) {
  const model = await edlioApiCall("GetCreateFtpAccountModel");
  const base = model?.model || model;
  base.userName = userName;
  base.districtId = districtId;
  base.enabled = false;
  const created = await edlioApiCall("CreateFtpAccount", { model: base }, { write: true });
  const newId = created?.id || created?.model?.id;
  if (!newId) throw new Error(`CreateFtpAccount returned no id: ${JSON.stringify(created).slice(0, 200)}`);
  // Re-fetch the full edit model so downstream steps get per-role settings etc.
  const edit = await edlioApiCall("GetEditFtpAccountModel", { id: newId });
  return edit?.model || edit;
}

// ==========================================================================
// Forge API
// ==========================================================================

function forgeHeaders() {
  const secret = process.env.FORGE_SHARED_SECRET;
  if (!secret) throw new Error("FORGE_SHARED_SECRET not in env");
  return {
    "x-forge-secret": secret,
    "x-forge-actor": "app-sftp",
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
  // Scan newest-first for [app-sftp] setup-sent marker.
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
// FileMage API
// ==========================================================================

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
  // API ignores query filters; fetch all then filter client-side.
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

async function fileMageCreateUser({ username, endpointName }) {
  // Resolve endpoint name -> ID
  const endpointsRes = await fetchT(fileMageUrl(`/endpoints/?limit=100`), {
    headers: fileMageHeaders(),
  });
  if (!endpointsRes.ok) {
    throw new Error(`filemage GET /endpoints -> HTTP ${endpointsRes.status}`);
  }
  const endpointsBody = await endpointsRes.json();
  const endpoints = Array.isArray(endpointsBody) ? endpointsBody : endpointsBody.results || [];
  const endpoint = endpoints.find(e =>
    e.name === endpointName || e.name?.toLowerCase() === endpointName?.toLowerCase()
  );
  if (!endpoint) {
    throw new Error(`filemage endpoint not found: ${endpointName}. Available: ${endpoints.map(e => e.name).join(", ")}`);
  }

  const payload = {
    username,
    endpointId: endpoint.id,
    home: {
      path: `/${username}`,
      grants: "full",
      sub: true,
    },
    // No password — SSH-key-only users. Keys attached separately later
    // via filemage.key.attach action (handled by operator or follow-up skill).
  };
  const res = await fetchT(fileMageUrl(`/users/`), {
    method: "POST",
    headers: fileMageHeaders(),
    body: JSON.stringify(payload),
  }, FETCH_WRITE_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`filemage POST /users -> HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function dashboardToFileMageEndpoint(dashboard) {
  // Map Forge Dashboard enum -> FileMage endpoint name.
  // The canonical SFTP endpoint names follow the dashboard brand.
  const map = {
    EDLIO: "Edlio",
    SIA_US: "SIA-US",
    SIA_CA: "SIA-CA",
    SAE: "SAE",
    ESV: "eSV",
    REACH_US: "Reach-US",
    REACH_CA: "Reach-CA",
    REACH_AUS: "Reach-AUS",
    CMS4SCHOOLS: "CMS4Schools",
    APPS_BY_SIA: "APPS by SIA",
    SYNTAXNY: "SyntaxNY",
    SCHOOLPLANNER: "SchoolPlanner",
    SCHOOLWEBMASTERS: "SchoolWebmasters",
  };
  return map[dashboard] || "Edlio"; // safe default
}

function deriveFileMageUsername(schoolName) {
  // Diana convention: edlio_<lowercase_underscore_school_name>
  // No _ct suffix. Truncate aggressively to 50 chars total.
  const slug = schoolName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return `edlio_${slug}`;
}

// ==========================================================================
// 1Password (via `op` CLI — service account token)
// ==========================================================================

function opEnv() {
  const tok = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!tok) throw new Error("OP_SERVICE_ACCOUNT_TOKEN not in env");
  return { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: tok };
}

async function opItemCreate({ title, username, password, host, port, schoolName, ticketKey }) {
  // Build template via `op item template get login`, inject fields, then
  // `op item create --vault=...`.
  const args = [
    "item", "create",
    `--vault=${ONEPASSWORD_VAULT}`,
    "--category=login",
    `--title=${title}`,
    `username=${username}`,
    `password=${password}`,
    `hostname=${host}`,
    `port=${port}`,
    `school=${schoolName}`,
    `ticket=${ticketKey}`,
    "--format=json",
  ];
  const r = spawnSync("op", args, { env: opEnv(), encoding: "utf-8" });
  if (r.error) throw new Error(`op item create spawn error: ${r.error.code || r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`op item create failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

async function opItemShare({ itemId, emails, expiresIn }) {
  const args = [
    "item", "share", itemId,
    `--emails=${emails.join(",")}`,
    `--expires-in=${expiresIn}`,
  ];
  const r = spawnSync("op", args, { env: opEnv(), encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`op item share failed: ${r.stderr || r.stdout}`);
  }
  // op item share prints the share URL on stdout as plain text.
  const url = r.stdout.trim().split("\n").find(l => l.startsWith("http"));
  if (!url) {
    throw new Error(`op item share returned no URL: ${r.stdout}`);
  }
  return { url };
}

// ==========================================================================
// Gmail send (via gws CLI — shared fleet OAuth client)
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
// Email template
// ==========================================================================

function renderEmailTemplate(vars) {
  const tmplPath = resolve(__dirname, "templates", "sftp_setup_email.html");
  let body = readFileSync(tmplPath, "utf-8");
  for (const [k, v] of Object.entries(vars)) {
    body = body.replaceAll(`{${k}}`, String(v));
  }
  return body;
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

function generatePassword(len = 24) {
  // Printable ASCII, exclude ambiguous chars.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*-_=+";
  const out = [];
  const buf = new Uint8Array(len);
  randomFillSync(buf);
  for (let i = 0; i < len; i++) {
    out.push(alphabet[buf[i] % alphabet.length]);
  }
  return out.join("");
}

function isoPlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function routingHint(ticket) {
  if (ticket.product === "CMS") return "CMS ticket — route to Raul";
  if (ticket.integrationType?.includes("API")) return "API ticket — route to Cody";
  if (ticket.integrationType?.includes("SSO")) return "SSO ticket — route to Cody";
  return "not an App-SFTP ticket";
}

// ==========================================================================
// Envelope helpers
// ==========================================================================

function recordAction(a) { ctx.actions.push({ ts: new Date().toISOString(), ...a }); }
function recordNote(message, type = "observation", severity = "info") {
  ctx.notes.push({ type, message, severity });
}
function recordError(where, err) {
  ctx.errors.push({
    at: new Date().toISOString(),
    // Canonical error codes: <namespace>.<slug>, lowercase+digits only (no hyphens).
    code: where.includes(".") ? where : `appsftp.${where}`,
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
  // Derive outer status from actions + data.status
  const failed = ctx.actions.filter(a => a.status === "failed").length;
  const isError = dataPayload.status === "error" || failed > 0;
  const isNeedsInput = dataPayload.status === "needs_input";
  const isDeclined = dataPayload.status === "declined" || dataPayload.status === "wrong_type";
  const outerStatus = isError
    ? "error"
    : isNeedsInput ? "needs-input"
    : isDeclined ? "declined"
    : "ok"; // covers ok and already_sent

  const envelope = {
    status: outerStatus,
    taskName: "app-sftp",
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

  process.stderr.write(`[app-sftp] status=${outerStatus} dataStatus=${dataPayload.status} actions=${ctx.actions.length} errors=${ctx.errors.length}\n`);
  process.stdout.write(`<<RESULT>>${JSON.stringify(envelope)}<<END>>\n`);
}

// Record a startedAt once, at module-load.
ctx._startedAt = new Date().toISOString();
