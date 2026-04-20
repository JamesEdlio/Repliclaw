# Repliclaw

Clone an agent. Run one skill. Terminate.

Repliclaw is a fleet-wide primitive for spawning disposable replica agents. Any agent (kern or openclaw) can call Repliclaw to spin up a clean copy of itself with a single skill and a task, get the result, move on.

## Why

Stateful agents are great for ongoing work, bad at parallel sub-tasks. You don't want your primary agent's context polluted by a 20-step SFTP setup, and you definitely don't want two employees asking the same agent to do the same thing at once.

The answer is cloning. Spin up a fresh copy of the agent with the creds and knowledge it needs, run the skill end-to-end, return the result, kill the process. No shared state, no context bleed, trivially parallel.

Repliclaw is that spawner.

## What it does

```
POST /spawn
  {
    parentAgent: "edith",
    skill: "app-sftp-case",
    inputs: { ticket: "SS-445" },
    timeoutSec: 600
  }
→ { runId: "r_abc123" }

GET /runs/r_abc123
→ {
    status: "completed",
    result: { ... },
    transcript: "...",
    startedAt, endedAt
  }
```

A replica is:
- a fresh process (kern or openclaw) in a scratch workspace
- seeded with a stripped-down copy of the parent's workspace template
- given scoped credentials from the parent's vault
- handed a single task: "run skill X with inputs Y, emit result, exit"
- killed when done, workspace destroyed, transcript archived

## Runtime-agnostic

Repliclaw doesn't care whether the parent is kern or openclaw. The registry tells it how to spawn each one:

```json
{
  "edith": {
    "runtime": "kern",
    "workspaceTemplate": "git@github.com:edlio/edith-workspace.git#replica-template",
    "credsVault": "op://Agent: Edith",
    "model": "openrouter/anthropic/claude-opus-4.7"
  },
  "diana": {
    "runtime": "openclaw",
    "workspaceTemplate": "...",
    ...
  }
}
```

Skills are portable because both runtimes honor the [AgentSkills](https://agentskills.io) spec.

## Status

**v0 prototype.** Single runtime (kern), no auth, single-machine. See [DESIGN.md](./DESIGN.md) for the full architecture and open questions.

## License

TBD.
