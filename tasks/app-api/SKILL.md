---
name: app-api
version: 0.1.0
description: Send the App-API setup email for a Forge ticket. Provider-aware — renders the right setup-guide email per API provider (PowerSchool, Clever, Aeries, Sylogist, etc.), sends from edith@edlio.com, posts a confirmation comment on the Forge ticket, and transitions to INITIAL_CONTACT. No credentials are provisioned at this stage — step 1 of the integration is outreach only. Forge-native — reads and writes through Forge's API, never touches Jira.
repliclawEnvelopeVersion: 0.2.0
exec: ./run.mjs
requires:
  - FORGE_URL
  - FORGE_BASE_URL
  - FORGE_SHARED_SECRET
  - GMAIL_FROM
inputs:
  ticket_key:
    type: string
    required: true
    description: Forge ticket key (INT-### for Forge-native, SS-### for Jira-mirrored). Treated as an opaque string.
  provider:
    type: string
    required: false
    description: |
      API provider override. Accepts either the Prisma enum value
      (POWERSCHOOL, POWERSCHOOL_NC, CLEVER, AERIES, SKYWARD, SKYWARD_QMLATIV,
      SYLOGIST, VERACROSS, ODBC, ATS_DOENYC) or a friendly name
      (PowerSchool, Clever, Aeries, ...). Case-insensitive.
      If omitted, the skill reads `ticket.apiProvider` from Forge. If the
      ticket also has no apiProvider set, the skill emits status=needs_input.
  dry_run:
    type: boolean
    required: false
    description: If true, take no external actions (no email, no Forge mutations). Emit the envelope that *would* have been produced, with every action marked status=skipped and details.dry_run=true.
  force_rerun:
    type: boolean
    required: false
    description: If true, bypass the dup-send guard and send the setup email even if a prior [app-api] setup-sent marker is found in ticket comments. Use with care.
outputs:
  status:
    type: string
  ticket_key:
    type: string
  provider:
    type: string
  outreach:
    type: object
  forge:
    type: object
outputs_schema: ./schema.json
---

# app-api — Send API setup email (Forge-native)

> **Implementation note:** This task is deterministic and runs via the
> `exec:` frontmatter — repliclaw executes `./run.mjs` directly as a child
> process instead of spawning an LLM-driven replica. The SKILL.md below is
> the spec, not a playbook. To change behavior, edit `run.mjs`.

Runs in a Repliclaw replica spawned by the Edith bridge when a user drops the `app-api` agent on a Forge ticket.

One job: **send the right API setup-guide email for the ticket's API provider, and record that we did**. No credential provisioning (that happens after the client replies with URLs/keys). No classification tree, no follow-up logic. If the ticket isn't an App-API integration, or the provider is unknown, or it's already been sent, this task declines cleanly and emits a structured envelope explaining why.

Every external mutation is recorded with `result.action()` using canonical action types from Repliclaw's ACTION-TYPES registry.

## Source of truth

- **Ticket data**: Forge (`GET $FORGE_URL/api/tickets/<ticket_key>` with `x-forge-secret`). Never Jira.
- **Email channel**: Gmail via `gws` CLI as `edith@edlio.com`. Header: `Edith <edith@edlio.com>`.
- **Templates**: `./templates/<provider>.html` — ported verbatim from Diana's `app_api_<provider>_email.html`.

## Flow

### Step 1 — Read the Forge ticket
`GET /api/tickets/<key>` returns the ticket with `comments` and `attachments` inlined. Used for both content (POC name/email, reporter, school name, dashboard, apiProvider) and idempotency scan.

### Step 2 — Provider resolution
Order of precedence:
1. `inputs.provider` — explicit override from the modal (case-insensitive, friendly or enum form).
2. `ticket.apiProvider` — Prisma enum value from the ticket record.
3. Neither — emit `status=needs_input`, ask the operator to pick a provider.

Once a value is in hand it's normalized to a canonical key used to pick the template:
| Input (any case) | Canonical key | Template file |
|------------------|---------------|---------------|
| `POWERSCHOOL`, `PowerSchool`, `powerschool` | `powerschool` | `powerschool.html` |
| `POWERSCHOOL_NC`, `PowerSchool NC` | `powerschool` | `powerschool.html` (same template) |
| `CLEVER`, `Clever` | `clever` | `clever.html` |
| `AERIES`, `Aeries` | `aeries` | `aeries.html` |
| `SYLOGIST`, `Sylogist` | `sylogist` | `sylogist.html` |
| `SKYWARD_QMLATIV`, `Skyward Qmlativ` | `skyward_qmlativ` | `skyward_qmlativ.html` |
| `SKYWARD`, `Skyward` | `skyward_confirm` | `skyward_confirm.html` *(asks which Skyward variant)* |

Providers not listed (`ODBC`, `ATS_DOENYC`, `VERACROSS`) currently emit `status=needs_input` — no template yet.

### Step 2.5 — Type guard
Ticket must have `product == "APP"` and `integrationType == "APP_API"`. Otherwise emit `status=declined` with a routing hint (e.g. "CMS ticket — route to Raul").

### Step 3 — Dup-send guard
Scan `ticket.comments` (newest-first) for a comment body matching:
```
[app-api] setup-sent run_id=<id> ts=<iso> skill_version=<v>
```
If found and `force_rerun !== true`, emit `status=skipped` with `outreach.prior_run` populated. No mutations.

### Step 4 — Resolve recipients
- **TO**: `ticket.pocEmail`. If missing, emit `status=needs_input` with `missing: ["pocEmail"]`.
- **CC**: `ticket.reporter.email` if the reporter is `@edlio.com`. Never CC a non-Edlio reporter (they may be the POC already). Never CC Sharon unless she is the reporter.

All recipients pass `isValidEmail()` sanity check.

### Step 5 — Render the template
Variables:
- `{poc_first_name}` — first token of `ticket.pocName`, else the portion before `@` in `ticket.pocEmail`.
- `{reporter_intro}` — matches Diana's logic:
  - If the reporter is `@edlio.com` **and** has a real name → `<strong>Name</strong> asked me to reach out to you about`
  - Otherwise → `You've asked us to reach out about`
- `{dashboard_display}` — human label for `ticket.dashboard` enum. If null, falls back to `Edlio`.
- Provider-specific template-only variables (e.g. `{clever_api_link}`) — currently hardcoded in the rendered template; no per-ticket customization in v0.1.

### Step 6 — Send email via `gws gmail +send`
Subject: `<School Name> — <Provider Display> API setup`
  e.g. `Cathedral School of Saint Matthew — PowerSchool API setup`.
Plain `--html` send. On failure, the action is recorded with `status=failed` and the task emits `status=error` — no Forge mutations are attempted after a send failure.

### Step 7 — Post Forge comment with marker
Body:
```
Sent PowerSchool API setup email to poc@example.com (cc reporter@edlio.com).

[app-api] setup-sent run_id=<runId> ts=<iso> skill_version=0.1.0
```
The marker line is what Step 3 greps for on the next run.

### Step 8 — Transition BACKLOG → INITIAL_CONTACT
Only if `ticket.status == "BACKLOG"`. Any other starting status is left alone (we don't re-transition).

## Canonical action vocabulary

| Step | Action type | Notes |
|------|-------------|-------|
| 1 | `forge.ticket.read` | `details.ticket_key` |
| 6 | `gmail.message.send` | `details.to`, `details.cc`, `details.subject`, `details.provider` |
| 7 | `forge.comment.create` | `details.ticket_key`, `details.comment_id` |
| 8 | `forge.ticket.transition` | `details.from`, `details.to` |

Each records `status=skipped` + `details.dry_run=true` when `dry_run=true`.

## Failure modes

| Condition | Status | `data.outreach.reason` |
|-----------|--------|------------------------|
| Ticket not APP + APP_API | `declined` | `wrong_ticket_type` |
| `pocEmail` missing | `needs_input` | `missing_poc_email` |
| Provider missing from both input and ticket | `needs_input` | `missing_provider` |
| Provider recognized but not yet templated (ODBC, ATS_DOENYC, Veracross) | `needs_input` | `provider_not_supported` |
| Prior `[app-api] setup-sent` marker found | `skipped` | `already_sent` |
| Gmail send failure | `error` | `email_send_failed` |
| Forge comment post failure after email sent | `partial` | `comment_failed_after_send` — email is out, Forge bookkeeping lagging |
| Forge status transition failure after comment | `partial` | `transition_failed_after_send` |
| Any unhandled exception | `error` | `pipeline_exception` |

## Idempotency

- Dup-send guard is the primary defense. Marker is appended to the Step-7 comment on every successful live send.
- `force_rerun=true` bypasses the guard — only use when the first send was lost or the client asked for a resend.
- Partial completion (email sent, comment failed) leaves the email in the wild but no marker — a re-run will re-send unless the operator posts a marker comment manually. Documented trade-off.

## Out of scope for v0.1

- **Custom PowerSchool plugin** (Artificer flow). A different skill.
- **API credential ingestion** (when the client replies with URL / client ID / secret). Separate follow-up skill, triggered when the ticket moves to `DATA_CLEANUP` or similar.
- **SFTP fallback** for districts that can't install plugins. Handled by re-categorizing the ticket to App-SFTP and dragging `app-sftp` onto it.
