#!/usr/bin/env node
// pammy — PM-board demo stub task.
//
// Reads JSON inputs on stdin, emits a single <<RESULT>>{envelope} line on
// stdout, exits 0. No side effects. Used to prove the dispatch pipeline
// works on a non-integrations board.
//
// Inputs (all optional except ticket_key):
//   - ticket_key: string   Forge ticket key
//   - mode:       string   triage | recap | plan
//   - dry_run:    bool     ignored — this stub never has real side effects
//   - triggered_by: string operator email (for audit)

import { readFileSync } from "node:fs";

const SKILL_VERSION = "0.1.0";
const STARTED_AT = new Date().toISOString();

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  raw = "";
}

let inputs = {};
try {
  inputs = raw.trim() ? JSON.parse(raw) : {};
} catch {
  inputs = {};
}

const ticketKey = String(inputs.ticket_key ?? "unknown");
const mode = String(inputs.mode ?? "triage");
const triggeredBy = inputs.triggered_by ?? null;
const dryRun = inputs.dry_run === true;
const runId = process.env.REPLICLAW_RUN_ID ?? `pammy-${Date.now()}`;

const validModes = ["triage", "recap", "plan"];
if (!validModes.includes(mode)) {
  const envelope = {
    status: "needs-input",
    taskName: "pammy",
    taskVersion: SKILL_VERSION,
    runId,
    startedAt: STARTED_AT,
    finishedAt: new Date().toISOString(),
    inputs,
    actions: [],
    notes: [
      { severity: "warn", message: `Invalid mode "${mode}". Expected one of: ${validModes.join(", ")}.` },
    ],
    errors: [],
    data: {
      ticket_key: ticketKey,
      mode,
      would_have_done: `Unknown mode "${mode}" — operator needs to pick one of ${validModes.join(", ")}.`,
      skill_version: SKILL_VERSION,
      dry_run: dryRun,
      triggered_by: triggeredBy,
      status: "needs_input",
    },
  };
  process.stdout.write("<<RESULT>>" + JSON.stringify(envelope) + "\n");
  process.exit(0);
}

const wouldHaveDone =
  mode === "triage"
    ? `Triage ${ticketKey}: re-read recent activity, surface stale-for-7d signals, and propose a status nudge to the assignee.`
    : mode === "recap"
      ? `Weekly recap for ${ticketKey}: summarize last week of activity (comments, runs, status moves) into a one-paragraph update for the operator.`
      : `Sprint plan for ${ticketKey}: estimate scope, propose next 3 sub-tasks, and flag dependencies on other tickets.`;

const envelope = {
  status: "ok",
  taskName: "pammy",
  taskVersion: SKILL_VERSION,
  runId,
  startedAt: STARTED_AT,
  finishedAt: new Date().toISOString(),
  inputs,
  actions: [
    {
      type: "pammy.echo",
      status: "ok",
      details: {
        ticket_key: ticketKey,
        mode,
        message: wouldHaveDone,
      },
    },
  ],
  notes: [
    {
      severity: "info",
      message: `Pammy stub: this is the demo build. No side effects taken. The real Pammy will replace this skill.`,
    },
  ],
  errors: [],
  data: {
    ticket_key: ticketKey,
    mode,
    would_have_done: wouldHaveDone,
    skill_version: SKILL_VERSION,
    dry_run: dryRun,
    triggered_by: triggeredBy,
    status: "ok",
  },
};

process.stdout.write("<<RESULT>>" + JSON.stringify(envelope) + "\n");
process.exit(0);
