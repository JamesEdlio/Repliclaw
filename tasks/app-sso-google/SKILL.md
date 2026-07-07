---
name: app-sso-google
version: 0.1.1
description: Send the Google Workspace SSO setup email for a Forge ticket. Renders the Google Workspace SSO setup guide email, sends from edith@edlio.com, posts a confirmation comment on the Forge ticket, and transitions to INITIAL_CONTACT. No credentials are provisioned at this stage — step 1 of the integration is outreach only. Forge-native — reads and writes through Forge's API, never touches Jira. Modeled on app-api with the provider dimension collapsed to the single SSO type this skill handles.
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
  dry_run:
    type: boolean
    required: false
    description: If true, take no external actions (no email, no Forge mutations). Emit the envelope that *would* have been produced, with every action marked status=skipped and details.dry_run=true.
  force_rerun:
    type: boolean
    required: false
    description: If true, bypass the dup-send guard and send the setup email even if a prior [app-sso-google] setup-sent marker is found in ticket comments. Use with care.
outputs:
  status:
    type: string
  ticket_key:
    type: string
  sso_type:
    type: string
  sso_type_source:
    type: string
  outreach:
    type: object
  forge:
    type: object
outputs_schema: ./schema.json
---

# app-sso-google — Send Google Workspace SSO setup email (Forge-native)

## What this skill does

For a Forge ticket whose `product=APP` and `integrationType=APP_SSO`, this
skill:

1. Fetches the Forge ticket.
2. Verifies the ticket is APP + APP_SSO. The skill assumes Google Workspace
   as the SSO type (see "SSO type resolution" below for how it's chosen).
3. Scans prior comments for an `[app-sso-google] setup-sent` marker. If
   one exists and `force_rerun` is not set, the skill short-circuits with
   `status=already_sent`.
4. Resolves recipients: `to` is the ticket POC email (required), `cc` is
   the ticket reporter + assignee (any `@edlio.com` ones), plus
   `dataintegrations@edlio.com` for the team thread. The POC, the sender
   (edith@edlio.com), and duplicates are skipped.
5. Renders the Google Workspace SSO template (`templates/google_workspace.html`).
6. Sends the email from `edith@edlio.com` via the `gws` CLI (Gmail API).
7. Posts a Forge comment with the `[app-sso-google] setup-sent` marker
   (idempotency trail).
8. PATCHes the ticket BACKLOG → INITIAL_CONTACT (only if currently BACKLOG).

Every action is recorded in the envelope's `actions[]` array. A failed
critical write after the email has been sent is retried with exponential
backoff (`withRetry`). If the comment or transition still fails after
retries, the envelope status is `partial` — the email went out, the audit
trail is incomplete. A subsequent run with `force_rerun=true` will resend
the email; without `force_rerun`, the dup-send guard will short-circuit
even though the comment may be missing. (The skill does not attempt to
reconcile this — operators should manually inspect the ticket if they see
a `partial` envelope.)

## SSO type resolution

This skill only sends the Google Workspace SSO setup guide. The SSO type
in the Forge ticket field `ssoTypeApp` is one of `GOOGLE_WORKSPACE_CLASSROOM`,
`GOOGLE_SAML`, `MICROSOFT365_SAML`, `CLEVER_SSO`, `CUSTOM_SAML`. This skill
treats both `GOOGLE_WORKSPACE_CLASSROOM` and `GOOGLE_SAML` as in-scope and
sends the same Google Workspace setup email for either. Other SSO types
cause the skill to emit `status=declined` with a routing hint so the
operator drops the appropriate SSO skill (e.g. an `app-sso-microsoft`
variant once built) instead.

If `ssoTypeApp` is null on the ticket, the skill emits
`status=needs_input` with `missing=["ssoTypeApp"]`. The operator must set
the SSO type on the ticket first.

## Idempotency

The dup-send guard scans ticket comments for the marker:

```
[app-sso-google] setup-sent run_id=... ts=... skill_version=...
```

If found and `force_rerun` is false, the skill returns
`status=already_sent` with the prior run's metadata. No email is sent, no
comment is posted, no transition is attempted.

## Inputs

| field         | type    | required | description                                     |
|---------------|---------|----------|-------------------------------------------------|
| `ticket_key`  | string  | yes      | Forge ticket key (e.g. `INT-007` or `SS-450`).   |
| `dry_run`     | boolean | no       | If true, emit envelope with no side effects.    |
| `force_rerun` | boolean | no       | If true, bypass the dup-send guard.             |
| `triggered_by`| string  | no       | Operator email. Set by the bridge automatically. |

## Outputs (envelope `data` payload)

| field             | type    | description                                                |
|-------------------|---------|------------------------------------------------------------|
| `status`          | string  | `ok` / `wrong_type` / `already_sent` / `needs_input` / `declined` / `error` / `partial` |
| `ticket_key`      | string  | The ticket the skill ran against.                          |
| `sso_type`        | string  | `GOOGLE_SAML` (the canonical SSO type this skill targets). |
| `sso_type_source` | string  | `skill_default` (or `ticket_field` when ticket drives it). |
| `outreach`        | object  | `email_to`, `email_cc`, `email_subject`, `email_sent_at`, `template`, `reason` |
| `forge`           | object  | `comment_posted`, `comment_id`, `status_transition`        |
| `prior_run`       | object  | Present when `status=already_sent`.                        |
| `note`            | string  | Free-form explanation for non-ok statuses.                 |
| `missing`         | array   | Field names that need operator input when `needs_input`.   |
| `routing_suggestion` | string | Hint for the operator when `declined`/`wrong_type`.       |

## Failure modes

- **Missing pocEmail** → `needs_input`, `missing=["pocEmail"]`. Add the
  POC email to the ticket and re-dispatch.
- **Missing ssoTypeApp** → `needs_input`, `missing=["ssoTypeApp"]`. Set
  the SSO type on the ticket.
- **Wrong SSO type** (e.g. Microsoft) → `declined` with a routing hint.
- **Wrong product/type** (e.g. CMS_SSO) → `wrong_type` with a routing hint.
- **Gmail send failure** → `status=error`, `outreach.reason="email_send_failed"`.
  No comment or transition attempted.
- **Forge comment failure after send** → `status=partial`, `forge.comment_posted=false`.
  Operator should manually check the ticket thread.
- **Forge transition failure after send+comment** → `status=partial`,
  `forge.status_transition=null`. Operator should manually advance the ticket.

## Environment

Required (declared in `requires:` so repliclaw's credential scoper keeps them):

- `FORGE_URL` (or `FORGE_BASE_URL`) — Forge base URL.
- `FORGE_SHARED_SECRET` — service-auth secret for the Forge API.
- `GMAIL_FROM` — usually `Edith <edith@edlio.com>`.

## Versioning

This skill follows the app-api conventions. Bump the `version` field in
frontmatter and the `SKILL_VERSION` constant in `run.mjs` together. The
audit marker includes `skill_version=` so the dup-send guard can reason
about prior runs from older versions.
