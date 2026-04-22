# Action type vocabulary

Every entry in `actions[]` must use a `type` of the form `<service>.<resource>.<verb>`. This page lists the canonical types so that audit logs are queryable across tasks ("show me every `gmail.message.send` from the last week").

If you need a type that isn't here, add it in your task PR — don't invent silently.

## Convention

```
<service>.<resource>.<verb>
```

- **service** — short identifier of the external system (`jira`, `filemage`, `gmail`, `op`, `slack`, `notion`).
- **resource** — what was touched (`comment`, `user`, `message`, `item`, `issue`).
- **verb** — what was done (`create`, `update`, `delete`, `transition`, `send`, `read`, `get`, `list`, `search`, `fetch`).

Read-style verbs (`read`, `get`, `list`, `search`, `fetch`) MAY omit `details`. Anything else MUST include `details`.

## Action `status`

- `success` — replica performed the action successfully. (Default.)
- `failed` — replica attempted and failed. `details` should explain.
- `skipped` — replica deliberately did not perform (dry-run, idempotency guard hit, policy).
- `planned` — replica is declaring intent; parent will execute. Used for parent-executed action types (Slack, anything gated by the credential hard-block) and for `mode: "plan"` runs. `details` is required; `payload` carries the content the parent needs to ship.

## Standard types

### Jira

| type | required `details` |
|------|--------------------|
| `jira.issue.read` | — |
| `jira.issue.create` | `{ projectKey, summary, issueType, ... }` |
| `jira.issue.update` | `{ fields: {...} }` |
| `jira.issue.transition` | `{ from, to, transitionId }` |
| `jira.comment.create` | `{ body }` |
| `jira.attachment.fetch` | — |
| `jira.search` | — |

### FileMage

| type | required `details` |
|------|--------------------|
| `filemage.user.read` | — |
| `filemage.user.create` | `{ username, endpointId, accountType }` |
| `filemage.user.update` | `{ username, patch: {...} }` |
| `filemage.user.delete` | `{ username }` |
| `filemage.key.add` | `{ username, fingerprint }` |
| `filemage.key.remove` | `{ username, fingerprint }` |
| `filemage.audit.read` | — |

### Gmail / Google Workspace

| type | required `details` |
|------|--------------------|
| `gmail.message.send` | `{ to, from, subject, threadId? }` |
| `gmail.message.read` | — |
| `gmail.draft.create` | `{ to, subject }` |
| `gws.calendar.event.create` | `{ summary, start, end, attendees }` |
| `gws.drive.file.upload` | `{ name, mimeType }` |

### 1Password

| type | required `details` |
|------|--------------------|
| `op.item.create` | `{ vault, title, category }` (NEVER include the secret) |
| `op.item.read` | — |
| `op.item.share` | `{ vault, title, expiresIn }` |

### SFTP (direct file ops)

| type | required `details` |
|------|--------------------|
| `sftp.connect` | `{ host, user }` |
| `sftp.file.list` | — |
| `sftp.file.fetch` | `{ remotePath, sizeBytes }` |
| `sftp.file.put` | `{ remotePath, sizeBytes }` |

### Slack (parent-executed)

Slack action types are **parent-executed**. Replicas MUST NOT call Slack APIs directly — their scoped creds are stripped of `SLACK_*` by the runtime as a hard block. Instead, emit the action with `status: "planned"` and include `payload.body` (plus any blocks/attachments). The parent orchestrator reads the planned action from the envelope, posts it using its own interface token, and writes its own audit entry with `status: "success"` and the resulting message TS in `ref`.

This preserves a clean property: a compromised task prompt cannot reach humans through Slack, because the replica physically cannot post.

| type | required `details` | `payload` |
|------|--------------------|-----------|
| `slack.message.send` | `{ channel, threadTs? }` | `{ body, blocks?, attachments? }` |
| `slack.dm.send` | `{ userId }` | `{ body, blocks? }` |
| `slack.react` | `{ channel, messageTs, emoji }` | — |
| `slack.message.read` | — | — (read-only, replica can do directly if it has a scoped read-only token — uncommon) |

Example of a replica emitting a planned Slack post via the result helper:

```js
ctx.plan(
  "slack.message.send",
  "C0AH1SEB08G",
  { channel: "C0AH1SEB08G" },
  { body: "Ranger: new ticket SS-501 — PowerSchool SFTP" }
);
```

### Internal

| type | required `details` |
|------|--------------------|
| `internal.audit.write` | `{ path }` |
| `internal.workspace.create` | `{ path }` |

## What goes in `details`

Enough to **replay** the action mentally without reading the message body or fetching the resource. Counts, IDs, recipient addresses, subject lines — yes. Full email bodies, file contents, secret values — no. The audit log is meant to be readable; payloads are kept elsewhere (Jira, Gmail, 1Password) and referenced via `ref`.

## What `ref` should be

The most useful single-string handle for the resource: Jira issue key, Gmail message-id, 1Password item title, FileMage username, etc. If multiple are equally useful, pick the one most likely to be searched for and put others under `details`.
