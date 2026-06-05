---
name: pammy
version: 0.1.0
description: PM-board demo stub. Echoes ticket + operator inputs in a valid envelope so the dispatch pipeline can be validated end-to-end before the real Pammy lands.
repliclawEnvelopeVersion: 0.2.0
runtimes:
  - kern
exec: ./run.mjs
requires: []
inputs:
  ticket_key:
    type: string
    required: true
    description: Forge ticket key (e.g. PM-001).
  mode:
    type: string
    required: false
    description: triage | recap | plan
  dry_run:
    type: boolean
    required: false
  triggered_by:
    type: string
    required: false
outputs_schema: ./schema.json
---

# pammy

PM board demo stub. Emits a structured envelope describing what the real
Pammy *would* do, given the ticket key and the operator's selected mode.

This skill performs no side-effects. It's here purely so the multi-board
demo can prove the full dispatch path works on the PM board:

1. Operator drags Pammy onto a card on `/b/pm`.
2. RunModal shows the mode selector (triage / recap / plan).
3. Forge POSTs `/dispatch` to the bridge with `task: "pammy"`.
4. Bridge spawns this `exec:` script.
5. Script emits a valid envelope.
6. Bridge persists the run; UI shows the envelope in the History tab.

When the real Pammy ships, this file gets replaced — the contract (mode
field, ticket payload) stays stable.
