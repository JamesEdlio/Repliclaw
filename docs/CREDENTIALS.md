# Credentials contract

## The rule

A replica receives **only** the credentials its task skill explicitly declares in `requires:`, plus a small set of always-passed runtime vars.

This is the security boundary. It lives in exactly one place: `skills/repliclaw/lib/scope-creds.mjs`. Do not duplicate cred-scoping logic anywhere else.

## Always passed

These go to every replica, because without them no replica can function:

| Variable | Why |
|---|---|
| `PATH` | Replica needs to find `kern-ai`, `node`, etc. |
| `HOME` | Any tool that writes to `~/.config` or `~/.cache`. |
| `LANG` | Unicode handling. |
| `OPENROUTER_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` | Replica must talk to a model. |
| `KERN_PROVIDER` | Which provider config to use. |
| `KERN_MODEL` | Which model to use. |
| `PYTHON_KEYRING_BACKEND` | Prevents Python libs from hanging on OS keyring prompts. |

## Always stripped

These are hard-blocked regardless of what the task declares. If a task skill tries to declare one of these, it gets silently ignored.

| Prefix / name | Reason |
|---|---|
| `SLACK_*` | Replica must not message humans on Slack. |
| `TELEGRAM_*` | Same. |
| `MATRIX_*` | Same. |
| `DISCORD_*` | Same. |
| `TWILIO_*` | SMS / voice channels. |
| `KERN_AUTH_TOKEN` | Parent's token; replica generates its own. |
| `KERN_INTERFACE_*` | Per-interface kern tokens. |

**Why no escape hatch?** If a replica needs to message a human, it should return the message in its result and let the parent agent send it. The parent is the one with persistent identity, operator relationship, and message history. The replica is stateless and should stay that way.

## Task-declared requires

Everything else is opt-in. Task skill frontmatter:

```yaml
requires:
  - JIRA_EMAIL
  - JIRA_API_TOKEN
  - FILEMAGE_API_KEY
  - OP_SERVICE_ACCOUNT_TOKEN
```

Exact-match only. `JIRA_EMAIL` declares `JIRA_EMAIL`, nothing else.

### Prefix form

End a requires entry with `_` to match a prefix:

```yaml
requires:
  - GWS_        # passes GWS_CLIENT_SECRET, GWS_REFRESH_TOKEN, etc.
  - EMAIL_      # passes EMAIL_HOST, EMAIL_USER, etc.
```

Useful when a tool expects a whole family of env vars and enumerating is tedious.

### If a required var is missing

The replica just won't have it. The task skill should handle this gracefully and emit `{"status":"error","reason":"missing credential: JIRA_API_TOKEN"}`.

Repliclaw does not enforce presence at spawn time. Missing creds are the task's concern.

## Auditing

Every audit log includes:

```json
{
  "scopedEnvKeys": ["FILEMAGE_API_KEY", "JIRA_API_TOKEN", "JIRA_EMAIL", "KERN_MODEL", "KERN_PROVIDER", "OPENROUTER_API_KEY"],
  "strippedPrefixes": ["SLACK_", "TELEGRAM_", "MATRIX_", "DISCORD_", "TWILIO_", "KERN_AUTH_TOKEN", "KERN_INTERFACE_"]
}
```

Values are never logged. Just the key names. This lets you verify after the fact what the replica had access to, without leaking secrets into audit logs.

## Threat model

What Repliclaw protects against:

- ✅ **Replica leaking creds it didn't need.** The scope list is explicit.
- ✅ **Replica posting in Slack/Telegram as the parent.** Interface tokens are hard-stripped.
- ✅ **Replica inheriting the parent's kern auth token.** Stripped.
- ✅ **Audit logs leaking secret values.** Only keys are logged.

What Repliclaw does **not** protect against:

- ❌ **Malicious task skill.** If you activate a task skill that declares `requires: [OPENROUTER_API_KEY]` and exfiltrates it, that's on you. Review skills before use.
- ❌ **Model prompt injection.** If the inputs contain attacker-controlled text that convinces the model to misbehave, Repliclaw doesn't detect that. Standard LLM-agent hygiene applies.
- ❌ **Host-level escape.** The replica runs as the same OS user as the parent. OS-level sandboxing (containers, VMs) is out of scope.
- ❌ **Network isolation.** The replica can reach everything the parent can reach.

For higher-isolation use cases (untrusted skills, untrusted inputs), wrap Repliclaw in a container runtime and pass creds via mounted files instead of env. That's a future enhancement.

## Adding to the stripped list

If you find an interface token prefix we missed, add it to `STRIPPED_PREFIXES` in `scope-creds.mjs` and open a PR. Err on the side of stripping — false positives (a task can't find the cred it needs) are loud and safe; false negatives (a replica leaks) are silent and bad.
