---
name: first-contact
version: 0.2.1
description: Send the Data Integrations first-contact acknowledgement for a Forge ticket, from di@edlio.com with Reply-To dataintegrations@edlio.com. Edith-native replacement for Diana's `bard` skill. Acknowledgement only — tells the client we received their request and a human will follow up. Does NOT provision credentials or send setup instructions. Works across all products and integration types (App / CMS / Pay).
repliclawEnvelopeVersion: 0.2.0
exec: ./run.mjs
requires:
  - FORGE_URL
  - FORGE_BASE_URL
  - FORGE_SHARED_SECRET
  - GWS_DI_HOME
inputs:
  ticket_key:
    type: string
    required: true
    description: Forge ticket key (INT-### for Forge-native, SS-### for Jira-mirrored). Treated as an opaque string.
  dry_run:
    type: boolean
    required: false
    description: If true, take no external actions (no email, no Forge mutations). Emit the envelope that *would* have been produced, with every action marked status=skipped.
  force_rerun:
    type: boolean
    required: false
    description: If true, bypass BOTH the dup-send guard and the downstream-setup-email guard. Use with extreme care — this is how you double-mail a client.
  triggered_by:
    type: string
    required: false
    description: Email of the human or scheduler that dispatched this run. Recorded in the marker comment and the envelope.
outputs:
  status:
    type: string
  ticket_key:
    type: string
  type:
    type: string
  outreach:
    type: object
  forge:
    type: object
outputs_schema: ./schema.json
---

# first-contact — Data Integrations acknowledgement email

> **Implementation note:** deterministic task, run via `exec:`. Repliclaw
> executes `./run.mjs` directly rather than spawning an LLM replica. This
> SKILL.md is the spec, not a playbook — to change behavior, edit `run.mjs`.

## What this is

When a new integration ticket lands in Forge, the client should hear something
within minutes, not whenever a human next opens the board. Diana's `bard` skill
did that. This is its Edith-native replacement (Tier 1 of
`knowledge/diana-handover.md`).

It sends exactly one short email: *we received your request, a human will reach
out.* That's it.

## What this is NOT

- **Not** the setup email. No SFTP credentials, no API instructions, no
  1Password share. Those stay in `app-sftp` / `app-api` / `app-sso-google`,
  which send from `edith@edlio.com`.
- **Not** a triage decision. It does not judge whether a ticket is
  Issue-class vs New-Integration. The caller decides eligibility; this task
  only refuses cases that would be actively wrong (see Guardrails).

## Identity

| Header | Value |
|---|---|
| `From` | `di@edlio.com` |
| `Reply-To` | `dataintegrations@edlio.com` |
| `To` | `ticket.pocEmail` |
| `Cc` | `dataintegrations@edlio.com`, ticket reporter (if a distinct Edlio address) |

`di@edlio.com` is Diana's outreach identity. Clients already have threads with
it, so continuing to send from it keeps history intact. Credentials live in an
isolated `gws` profile at `$GWS_DI_HOME` (default `/home/edith/gws-di`) —
`gws` stores exactly one credential set per `HOME`, so the child process gets
`HOME` overridden. Do not run this with Edith's own `HOME` or it sends as
`edith@edlio.com`. See `knowledge/di-mailbox.md`.

**Reply-To gotcha:** `gws gmail +send` has no `--reply-to`, and Gmail does
*not* apply the sendAs `replyToAddress` to API `messages.send`. So this task
builds raw RFC-5322 MIME and posts it to `users.messages.send`.

## Subject and body

Reverse-engineered verbatim from `di@`'s Sent folder on 2026-08-03. **Do not
reword.** Clients recognise this copy.

```
Subject: Edlio Data Integrations - New {TYPE} Integration for {ticket.title} ({KEY})
```

Note the subject uses `ticket.title` **as-is**, not a reconstruction. Titles
are inconsistent in the wild (`App API — Preston School District 201` vs
`Mt. Pulaski CUSD #23 — CMS SSO`) and Bard reproduced whatever the title said.
Matching that behaviour keeps subject lines stable across the handover.

Body (`text/plain`, from `templates/first-contact.txt`):

```
Hello {POC name},

We have received your request to integrate {TYPE} with your Edlio app dashboard. A Data Integration team member will reach out as soon as possible.

Thank you!
Edlio Data Integrations
```

With no `pocName` the greeting degrades to a bare `Hello,`.

The body says "app dashboard" even on CMS and Pay tickets. That is Bard's
existing behaviour and it is deliberate — not a bug to fix here.

### `{TYPE}` mapping

| `integrationType` | `{TYPE}` |
|---|---|
| `APP_SFTP` | `SFTP` |
| `APP_API` | `API` |
| `APP_SSO` | `SSO` |
| `CMS_SSO` | `SSO` |
| `CMS_SIS` | `SIS` |
| `CMS_LDAP` | `LDAP` |
| `PAY_SFTP` | `SFTP` |

An `integrationType` outside this table yields `status=declined` rather than a
guessed email.

## Guardrails

The task declines rather than sends when:

1. **Already acked** — a `[first-contact] ack-sent` marker comment exists
   → `already_sent`.
2. **Setup email already out** — an `[app-sftp]`, `[app-api]` or
   `[app-sso-google]` marker exists. Acking *after* full instructions have
   gone out reads as broken to the client → `declined`.
3. **No POC email** → `needs_input` with `missing_fields: ["pocEmail"]`. A
   human must source the contact.
4. **Unknown `integrationType`** → `declined`.
5. **`kind` is not `NEW_INTEGRATION`** → `declined`. First contact is an
   acknowledgement of a *new integration request*; sending it to a client who
   filed an Issue about a broken live sync reads as if nobody read the ticket
   (the SS-449 failure mode). Issue-class tickets go to human triage.
   Verified against `di@`'s Sent folder on 8/3: of the backlog tickets Bard
   acked, **all** were `NEW_INTEGRATION` and **none** were `ISSUE`.
   `liveStatus` is *not* the discriminator — Bard acked LIVE
   `NEW_INTEGRATION` tickets (INT-080/082/087).

Comment-read failure is **fail-closed**: if we can't verify the marker, we do
not send, because the downside of a duplicate client email is worse than the
downside of a delayed one.

`force_rerun: true` bypasses guards 1 and 2. It exists for operator recovery
after a partial run, not for routine use.

## Idempotency

State lives in a **Forge ticket comment marker**, not a watermark file. Diana's
Ranger used `.state` files on disk, which desynced across restarts and clock
changes. The marker travels with the ticket, so it survives host rebuilds and
is visible to humans in the Discussion tab.

Marker first line:

```
[first-contact] ack-sent
```

**Known window:** if the email sends but the marker POST fails after all
retries, the task returns `partial` with `forge.marker_posted: false` and an
`error`-severity note. A later re-run would double-send. Read the envelope
before re-running.

## Status values

| `data.status` | envelope `status` | meaning |
|---|---|---|
| `ok` | `ok` | email sent, marker posted |
| `partial` | `partial` | email sent, marker failed — see warning above |
| `already_sent` | `ok` | no-op, prior marker found |
| `declined` | `declined` | guardrail refused (setup already sent / unknown type) |
| `needs_input` | `needs-input` | missing `pocEmail` |
| `error` | `error` | ticket unreadable, send failed, or unhandled |

## Environment

| Var | Purpose |
|---|---|
| `FORGE_URL` / `FORGE_BASE_URL` | Forge base URL (either accepted) |
| `FORGE_SHARED_SECRET` | service-auth for Forge API |
| `GWS_DI_HOME` | isolated `gws` profile holding `di@edlio.com` OAuth (default `/home/edith/gws-di`) |

No 1Password or FileMage access needed — this task provisions nothing.

## Changelog

### 0.2.0 — 2026-08-03
Added the **Issue-class guard** (`kind != NEW_INTEGRATION` → `declined`).
Found while building `scan-first-contact.mjs`: the pre-filter surfaced 19
apparently-eligible BACKLOG tickets, 12 of which were `ISSUE` on live
integrations. Without this guard a cutover scan would have mailed
"thanks for your new integration request" to a dozen clients reporting broken
syncs. Confirmed Bard's real rule by diffing acked vs un-acked tickets against
`di@`'s Sent folder.

### 0.1.0 — 2026-08-03
Initial release. Ports Diana's `bard` first-contact behaviour: verbatim
template and subject shape captured from `di@`'s Sent folder, raw-MIME send
for the `Reply-To` header, comment-marker idempotency replacing Ranger's
watermark files, and a new downstream-marker guard Bard did not have.


### Gmail thread id (inbound reply matching)

On a successful send the task captures Gmail's `id` and `threadId` from the send
response and records them in three places:

- the `gmail.message.send` action details,
- `data.outreach.gmail_thread_id` / `gmail_message_id`,
- the marker comment line, as `gmail_thread_id=<id> gmail_message_id=<id>`.

`threadId` is the durable join key between a ticket and every message in its
conversation, **including replies from addresses that are not the ticket's
`pocEmail`**. Persisting it lets the inbound matcher do an exact lookup instead
of guessing from subject text or sender domain. It does not help with a *fresh*
thread started from an unknown address — that still needs a separate rule.

Parsing degrades to `null` rather than throwing: by the time we read the
response the mail has already left, so a parse failure must not fail the run.
An error-shaped body (Gmail can exit 0 and still return `{"error":...}`) is the
one exception — that means the send did **not** happen and is raised.
