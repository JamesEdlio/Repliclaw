# Patterns

Conventions and recipes for building Repliclaw task skills that interoperate cleanly with a parent orchestrator.

These are patterns, not mandates — the envelope contract ([`AUTHORING.md`](./AUTHORING.md), [`../skills/repliclaw/schemas/envelope.schema.json`](../skills/repliclaw/schemas/envelope.schema.json)) is the only thing every task must honor. Everything below is a specific shape within that contract, proven useful across real tasks.

---

## 1. Actions-through-parent (parent-executed side effects)

**Problem.** Some side effects are dangerous to grant to a disposable replica:

- **Human-channel interfaces** (Slack, Telegram, Matrix, Discord, Twilio). A compromised task prompt on a replica with your Slack bot token can social-engineer your team.
- **Shared-state writes** against the parent's authoritative data (orchestrator DB, inbox queue, etc.).

**Solution.** The replica declares *intent*; the parent executes.

**Mechanics.**

1. Replica emits an action with `status: "planned"`, required `details` (addressable shape — channel, recipient, subject), and `payload` (the content — body, HTML, blocks).
2. Parent reads the planned action from the envelope.
3. Parent executes using its own interface token / DB handle.
4. Parent writes its own audit entry (or extends the replica's) with `status: "success"` and the external result reference in `ref` (message TS, row ID).

**Enforcement today.** Repliclaw's credential scoper ([`scope-creds.mjs`](../skills/repliclaw/lib/scope-creds.mjs)) **hard-blocks** `SLACK_*`, `TELEGRAM_*`, `MATRIX_*`, `DISCORD_*`, `TWILIO_*`, and kern interface tokens regardless of the task's `requires:` list. A replica that tries to post directly will fail at the token boundary. This makes the pattern enforceable by construction, not by review.

**Example — Slack post from a ticket-triage task:**

```js
// replica
import { run } from "./repliclaw-result.mjs";

await run({
  taskName: "ticket-triage",
  taskVersion: "0.1.0",
  inputs,
  async work(ctx) {
    const ticket = await jira.get(inputs.ticketKey);
    ctx.action("jira.issue.read", ticket.key);

    if (ticket.priority === "high") {
      ctx.plan(
        "slack.message.send",
        "C0AH1SEB08G",
        { channel: "C0AH1SEB08G" },
        { body: `:rotating_light: High-priority ticket ${ticket.key} — ${ticket.summary}` }
      );
    }

    return { ticketKey: ticket.key, priority: ticket.priority };
  }
});
```

Parent orchestrator reads the envelope, sees the `planned` Slack action, and posts it with its own bot token. It may batch, deduplicate, or rate-limit across multiple replicas converging on the same channel.

**When NOT to use it.** If a task legitimately needs to *read* Slack threads or react in real time, provision a scoped read-only bot token and pass it explicitly via `requires:`. This is rare — most "send a notification" tasks don't need real-time Slack access.

---

## 2. Plan mode (dry-run / operator review)

**Problem.** Some mutating actions should be reviewed before they ship:

- Client-facing emails — the operator wants to see the HTML before it goes out.
- Large artifacts (data-transformation XMLs, LDAP filters, configs) — the operator needs to review the payload before applying it upstream.

**Solution.** Tasks that support it honor `inputs.mode: "plan"` and emit all mutating actions with `status: "planned"` instead of executing.

**Contract.**

- Task declares `supports_plan_mode: true` in SKILL.md frontmatter. (Parsed by runtime, surfaced in the audit's `taskMeta`.)
- Parent passes `mode: "plan"` in the seed inputs.
- Replica runs all its read-side work normally (Jira reads, FileMage lookups, etc.), but short-circuits mutating actions into `ctx.plan(...)` instead of `ctx.action(...)`.
- Parent reviews the returned envelope. If approved, the parent either applies the actions itself or re-invokes the same task with `mode: "execute"` (default).

**Guardrail.** If `mode: "plan"` is passed to a task that does NOT declare `supports_plan_mode: true`, the parent SHOULD warn and abort rather than run the task in normal mode silently (data loss risk — operator thought it was a dry run).

**Status today.** Frontmatter key is accepted and recorded in audit. Runtime does not yet enforce the guardrail — callers should check `audit.taskMeta.supports_plan_mode` before trusting a plan-mode invocation. Will tighten once the first task uses it.

---

## 3. Artifact copy-back (`outputs_files`)

**Problem.** Tasks that generate large artifacts (XML plugins, configs, filter files) need those files persisted somewhere the parent controls. Base64-stuffing them into `data{}` is ugly and inflates audits.

**Solution.** Task declares artifact globs; parent declares a destination; Repliclaw copies on success.

**Contract.**

```yaml
# SKILL.md frontmatter
outputs_files:
  - "*.xml"
  - "ldap-filter.conf"
  - "oauth-client.json"
```

```json
// inputs
{ "artifacts_dir": "/home/parent/.workspace/tickets/SS-410/artifacts" }
```

On successful exit (`status: ok` or `partial`), before cleanup, Repliclaw globs the declared patterns under the replica workspace root and copies matches to `artifacts_dir`. Filenames are recorded in the audit under `artifacts: [...]`. On error/timeout, nothing is copied.

**Security.** Only files produced or modified by the replica are eligible for copy-back — Repliclaw snapshots the workspace after scaffolding and diffs at exit. Scaffold files (AGENTS.md, task skill dir) are excluded even if they match a pattern.

**Status today.** Frontmatter key accepted and recorded in audit. Copy-back is **not yet implemented** in the runtime — tasks that declare it today should also embed artifacts in `data{}` as a fallback until the runtime supports it. Will land when the first task needs it (likely a data-transformation task producing multi-KB XML).

---

## 4. Idempotency markers

**Problem.** Replicas are disposable and the orchestrator may re-spawn the same task against the same resource. Without a guard, a task that creates a FileMage user or sends a client email can do so twice.

**Solution.** The replica checks for a prior-run marker early (after reading the resource but before any mutations). If found, it short-circuits with a dedicated classification and emits no mutating actions.

**Pattern.**

1. Replica reads the target resource (e.g. Jira ticket comments).
2. Replica greps for a marker string it knows it would have left:
   ```
   [<task-name>] run_id=<id> skill_version=<ver> ts=<iso>
   ```
3. If found and `inputs.force_rerun !== true`, replica emits `status: "ok"` with a task-specific classification (`ALREADY-PROCESSED` in `app-sftp-case`) and `data.prior_run: {...}`.
4. Every mutating Jira comment the task posts ends with this marker, making the guard self-reinforcing.

**Reference.** See [`app-sftp-case` SKILL.md](https://github.com/edlio/edith-workspace/blob/main/skills/app-sftp-case/SKILL.md) (Phase 1.5) for a real implementation.

---

## 5. Parent-side concurrency control (not Repliclaw's job)

**Stated for clarity, not as a Repliclaw feature.** If a parent orchestrator spawns two replicas that mutate the same external resource (same Jira ticket, same FileMage user, same 1Password item), Repliclaw will not serialize them — both replicas will run, both will attempt the mutation, and the second may see the first's effects mid-flight.

**Orchestrator responsibilities:**

- **In-flight map** keyed by resource (e.g. `ticket:SS-410`, `vault:<school>-sftp`) — don't spawn a replica that would touch a resource currently locked by another replica.
- **Per-task-type queues** where genuine parallelism is unsafe (inbox processors, anything with uniqueness constraints against a shared upstream).
- **Dedup windows** on expensive outward mutations (don't send the same subject+recipient email within N minutes).
- **Idempotency markers** (pattern 4) as a second line of defense — they catch cases the in-flight map can't see (e.g. operator manually re-spawned after a crash).

Repliclaw's clones have **isolated workspaces** — there's no shared-filesystem race to worry about. All race conditions in practice are on external APIs, and that's the orchestrator's surface to control.
