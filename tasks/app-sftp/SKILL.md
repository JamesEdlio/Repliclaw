---
name: app-sftp
version: 0.2.0
description: Send the App-SFTP setup email for a Forge ticket. Provisions a FileMage user (or reuses an existing one), stores credentials in 1Password, shares a 7-day credential link to the client POC, sends a setup email from edith@edlio.com, posts a confirmation comment on the Forge ticket, and transitions the ticket to INITIAL_CONTACT. Forge-native — reads and writes through Forge's API, never touches Jira.
repliclawEnvelopeVersion: 0.2.0
exec: ./run.mjs
requires:
  - FORGE_URL
  - FORGE_BASE_URL
  - FORGE_SHARED_SECRET
  - FILEMAGE_API_URL
  - FILEMAGE_API_KEY
  - OP_SERVICE_ACCOUNT_TOKEN
  - GMAIL_FROM
inputs:
  ticket_key:
    type: string
    required: true
    description: Forge ticket key (INT-### for Forge-native, SS-### for Jira-mirrored). Treated as an opaque string.
  dry_run:
    type: boolean
    required: false
    description: If true, take no external actions (no FileMage provisioning, no 1Password share, no email, no Forge mutations). Emit the envelope that *would* have been produced, with every action marked status=skipped and details.dry_run=true.
  force_rerun:
    type: boolean
    required: false
    description: If true, bypass the dup-send guard and send the setup email even if a prior [app-sftp] setup-sent marker is found in ticket comments. Use with care.
outputs:
  status:
    type: string
  ticket_key:
    type: string
  filemage_user:
    type: object
  outreach:
    type: object
  forge:
    type: object
outputs_schema: ./schema.json
---

# app-sftp — Send SFTP setup email (Forge-native)

> **Implementation note (v0.1.0):** This task is deterministic and runs via
> the `exec:` frontmatter — repliclaw executes `./run.mjs` directly as a
> child process instead of spawning an LLM-driven replica. The SKILL.md
> below is the spec, not a playbook. To change behavior, edit `run.mjs`.

Runs in a Repliclaw replica spawned by the Edith bridge when a user drops the `app-sftp` agent on a Forge ticket.

One job: **send the SFTP setup email and record that we did**. No classification tree, no follow-up logic, no file inspection. If the ticket isn't an App-SFTP new-integration, or if it's already been sent, this task declines cleanly and emits a structured envelope explaining why.

Every external mutation must be recorded with `result.action()` using canonical action types from Repliclaw's ACTION-TYPES registry. Every non-success path must emit a valid envelope with `status` set accordingly.

## Source of truth

- **Ticket data**: Forge (`GET $FORGE_URL/api/tickets/<ticket_key>` with `x-forge-secret`). Never Jira.
- **SFTP provisioning**: FileMage API.
- **Credentials store**: 1Password vault `Agent: DI-Ana - SFTP` (shared between Diana and Edith).
- **Email channel**: Gmail API as `edith@edlio.com`, sig "Edith, Data Integrations, edith@edlio.com".

## Inputs

- `ticket_key` (string, required) — e.g. `INT-042` or `SS-381`
- `dry_run` (boolean, optional, default false)

## Outputs (`data` in the envelope)

See `schema.json` for the full contract. Key fields:

- `status` — `ok | wrong_type | already_sent | needs_input | declined | error`
- `ticket_key`
- `filemage_user` — `{ user_id, username, endpoint_name, provisioned_now }`
- `outreach` — `{ email_to[], email_cc[], email_sent_at, email_subject, op_share_url, op_share_expires_at, op_item_id }`
- `forge` — `{ comment_posted, status_transition: { from, to } | null }`

## Flow

### Step 1 — Fetch ticket from Forge

```
GET  $FORGE_URL/api/tickets/<ticket_key>
Header: x-forge-secret: $FORGE_SHARED_SECRET
```

Parse the returned `ticket` object. Needed fields:

- `key`, `product`, `integrationType`, `kind`, `status`
- `schoolName`, `dashboard` (EDLIO / SIA_US / ...), `sisProvider` (free-text)
- `pocName`, `pocEmail`, `pocPhone`
- `reporter` (object with `email`, `name`, `role` if present)
- `comments` (array of `{ id, body, createdAt, author: { email } }`)

**Guard — wrong type.** If `product != "APP"` or `integrationType != "APP_SFTP"` or `kind != "NEW_INTEGRATION"`:

- Emit `status: "wrong_type"` with `data.declined_reason` and `data.routing_suggestion` (e.g. "App-API tickets → Cody" for `integrationType == "APP_API"`).
- No action recording except a single `result.note()`.
- Set envelope `status: "declined"`.

### Step 2 — Duplicate-send guard

Scan the `ticket.comments` array returned by Forge. Look for any comment where the body contains the marker:

```
[app-sftp] setup-sent
```

**Guard — already sent.** If found:

- Extract `run_id=`, `ts=`, and `skill_version=` from the marker line if present.
- Emit `status: "already_sent"` with `data.prior_run = { run_id, ts, skill_version, comment_id, author }`.
- No actions. Envelope `status: "declined"`.

### Step 3 — POC emails sanity check

Collect recipient list:

- `to` = `[pocEmail]` if non-empty, lowercased, trimmed, and matching a basic email regex
- Currently Forge stores only one POC email per ticket. If/when multi-POC arrives (via a `pocAdditional` relation or comma-separated field), the skill should be updated to union those into `to`.

**Guard — needs input.** If `to` is empty:

- Emit `status: "needs_input"` with `data.missing = ["pocEmail"]` and `data.note` explaining what's needed.
- No actions. Envelope `status: "needs-input"`.

**Note on Jira-mirrored tickets:** tickets with `source = "JIRA"` (SS-###) often have `pocEmail = null` because Jira lacks structured POC fields — POC info is buried in the free-text `description`. We deliberately do **not** attempt to parse descriptions. If pocEmail is null, the human operator must either fill it in on the Forge ticket (via the detail view / edit) or run the skill only on Forge-native tickets with proper form data. This keeps the skill predictable and forces Forge forms to do the job they were introduced for.

**CC list:**

- If `ticket.reporter?.email` is non-empty AND the address ends with `@edlio.com`, add it to `cc` (all Forge User rows with @edlio.com addresses are active Edlio accounts).
- Otherwise, do not CC the reporter (external reporters don't get CC'd).

### Step 4 — FileMage provision

`GET $FILEMAGE_API_URL/users/` with `X-Auth: $FILEMAGE_API_KEY`.

The FileMage `/users/` endpoint ignores query filters — fetch the full list and filter client-side.

Username = `<dashboard_lower>_<school_snake>` where:

- `dashboard_lower` = `ticket.dashboard.toLowerCase()` (e.g. `EDLIO` → `edlio`)
- `school_snake` = `ticket.schoolName` lowercased, non-alphanumeric → `_`, collapsed `_`, trimmed

Match on exact username. If found:

- `provisioned_now = false`
- Record action type `filemage.user.search` (status `success`) with `details.matched_user_id = <id>`.
- Proceed to Step 5 with the existing user.

If not found and `dry_run == false`:

- `POST $FILEMAGE_API_URL/users/` with body:
  ```json
  {
    "username": "<username>",
    "password": "<random 20-char password>",
    "endpoint": 10,
    "home_dir": "/",
    "read_only": false
  }
  ```
  (Confirm endpoint 10 is "Edlio" on your tenant — read it from `ticket.dashboard` mapping if needed. For the MVP, only `EDLIO` dashboard is supported; any other dashboard → emit `status: "declined"` with `declined_reason = "non-Edlio dashboard not yet supported by this skill"`.)
- `provisioned_now = true`
- Record `filemage.user.create` (status `success`) with `details.user_id`, `details.username`.

If not found and `dry_run == true`:

- Record `filemage.user.create` (status `skipped`, `details.dry_run = true`).

**Failure**: if FileMage returns non-2xx:

- Record the attempted action with status `failed`, `details.error_code`, `details.error_body`.
- Continue to emit envelope with top-level `status: "error"`.

### Step 5 — 1Password share

Create (or reuse) the 1Password item:

- Vault: `Agent: DI-Ana - SFTP`
- Item title: `<ticket_key> - <schoolName>` (e.g. `SS-381 - Mercy High School`)
- Fields:
  - `username` = FileMage username
  - `password` = generated password (from Step 4)
  - `website` (not set — FileMage is SFTP, not web)
  - `notes`:
    ```
    Host: 52.165.175.27
    Port: 22
    Username: <username>
    Dashboard: <ticket.dashboard>
    School: <ticket.schoolName>
    Ticket: <ticket_key>
    Provisioned: <iso timestamp>
    ```

Use `op item create` with `OP_SERVICE_ACCOUNT_TOKEN`. If an item with this title already exists in the vault, fetch it via `op item get` instead of creating a duplicate.

Then share:

- `op item share --item-id <item_id> --emails <comma-separated> --expires-in 7d`
- Recipients: the `to` email list from Step 3 only (not CC).

Record actions:

- `op.item.create` (or `op.item.get` if reusing) — `status: success`, `details.item_id`, `details.vault`
- `op.item.share` — `status: success`, `details.emails`, `details.expires_at`, `payload.share_url` (redact not needed — the URL is the deliverable)

Under `dry_run`, record both actions with `status: skipped` and skip all `op` CLI calls.

### Step 6 — Send email

Template: `templates/sftp_setup_email.html` (bundled with this task).

Substitutions:

- `{poc_first_name}` = first token of `ticket.pocName`, or "there" if blank
- `{reporter_name}` = `ticket.reporter.name` if present, else "a member of the Edlio team"
- `{sis_provider}` = `ticket.sisProvider` as-is (free-text field; already human-readable). If unset, use "your SIS".
- `{onepassword_link}` = the share URL from Step 5

Email envelope:

- `From`: `Edith <edith@edlio.com>` (explicit RFC-5322 display name override — the Gmail account-level name may read bare `edith@edlio.com`, but the `From` header wins per-message)
- `To`: the Step-3 recipient list
- `Cc`: Step-3 CC list — reporter email only if it's an @edlio.com address (i.e. the reporter is an internal Edlio user). External reporters are not CC'd.
- `Subject`: `SFTP Setup — <schoolName>`
- `Body`: rendered template HTML, followed by sig:
  ```
  —
  Edith
  Data Integrations
  edith@edlio.com
  ```
- Content-Type: `text/html`

Send via Gmail API using `$GMAIL_CLIENT_SECRET_JSON` + `$GMAIL_TOKEN_JSON` credentials. Record action `gmail.message.send` with `status: success`, `details.message_id`, `details.thread_id`, `details.to`, `details.cc`, `details.subject`.

Under `dry_run`, record `status: skipped` with `details.dry_run: true` and `details.rendered_body_preview` (first 500 chars).

### Step 7 — Post comment to Forge

```
POST $FORGE_URL/api/tickets/<ticket_key>/comments
Header: x-forge-secret: $FORGE_SHARED_SECRET
Header: x-forge-actor: app-sftp
Body: { "body": "<comment markdown>" }
```

Comment body format:

```
📧 SFTP setup email sent.

**To:** <poc emails joined>
**CC:** <cc emails joined, or "—">
**FileMage user:** `<username>` (<newly provisioned | existing account>)
**1Password link:** shared, expires <YYYY-MM-DD>

[app-sftp] setup-sent run_id=<REPLICLAW_RUN_ID> skill_version=0.1.0 ts=<iso>
```

The marker line must be present verbatim — Step 2 relies on it.

Record `forge.comment.create` (status `success`, `details.comment_id`, `details.ticket_key`).

Non-fatal: if the comment POST fails, record status `failed` but continue.

### Step 8 — Transition ticket

If `ticket.status == "BACKLOG"`:

```
PATCH $FORGE_URL/api/tickets/<ticket_key>
Header: x-forge-secret
Body: { "status": "INITIAL_CONTACT" }
```

Record `forge.ticket.transition` (status `success`, `details.from`, `details.to`).

If `ticket.status != "BACKLOG"`, skip silently (record with status `skipped`, `details.reason = "status not BACKLOG"`).

Non-fatal on failure.

### Step 9 — Emit envelope

Use the Repliclaw result helper:

```js
import { createResult } from "#result";
const R = await createResult();

// ... record actions via R.action()/R.plan()/R.note() throughout the flow ...

R.setData({
  status: /* ok | wrong_type | already_sent | needs_input | declined | error */,
  ticket_key,
  filemage_user: { user_id, username, endpoint_name, provisioned_now },
  outreach: {
    email_to, email_cc, email_sent_at, email_subject,
    op_share_url, op_share_expires_at, op_item_id
  },
  forge: {
    comment_posted: boolean,
    status_transition: from === to ? null : { from, to }
  }
});

R.emit();  // prints <<RESULT>>{...}<<END>> and exits cleanly
```

The envelope `status` is derived automatically from recorded actions:

- Any `failed` action with a required step → `partial` or `error`
- All `success` or `skipped` → `ok`
- Explicit guards in Steps 1–3 → the helper's `declineWith()` / `needsInput()` shortcuts should be used if available; otherwise set via `R.setStatus(...)`.

## Idempotency

Step 2 is the guard. The marker format is stable and grep-able. Rerunning on an already-sent ticket returns `status: "already_sent"` without side effects.

**Known gap:** partial failure mid-flow (e.g. FileMage user created, Gmail send failed) leaves the system in an inconsistent state. On rerun, Step 2 won't fire (no comment yet — comment is Step 7), Step 4 sees the existing FileMage user and skips creation, Step 5 may create a second 1Password share. Future work: move the marker comment earlier, or add a "in-progress" marker at step start and replace with "setup-sent" at step end.

## Credentials

Every env var listed in `requires:` is passed by Repliclaw into the replica. `SLACK_*` and `TELEGRAM_*` are hard-stripped at the runtime boundary — this skill cannot post to Slack. Slack notification, if desired, is the parent's responsibility via a `slack.message.send` planned action (not yet wired in this version).

## Failure modes and envelope status

| What went wrong | Envelope `status` | `data.status` |
|---|---|---|
| All steps clean | `ok` | `ok` |
| Wrong integration type guard fired | `declined` | `wrong_type` |
| Already sent (dup guard) | `declined` | `already_sent` |
| No POC email (pocEmail empty) | `needs-input` | `needs_input` |
| Unsupported dashboard (non-Edlio) | `declined` | `declined` |
| FileMage POST failed | `error` | `error` |
| Gmail send failed | `partial` | `error` |
| Forge comment POST failed (but email sent) | `partial` | `ok` (sic — client was actually emailed; the comment is bookkeeping) |
| Forge status transition failed (but email sent) | `partial` | `ok` |

## Editing this skill

See Repliclaw's `docs/AUTHORING.md`. Bump `version` on any behavior change. Add fixtures to this task's `tests/` directory before shipping.
