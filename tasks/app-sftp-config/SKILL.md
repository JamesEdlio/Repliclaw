---
name: app-sftp-config
version: 0.3.6
description: |
  Configure an Edlio dashboard FTP account end-to-end after the client has
  uploaded their first batch of CSVs. Fetches the Forge ticket, finds the
  matching Edlio FTP account, downloads sample CSV rows over SFTP,
  classifies each file by role, fuzzy-matches columns to Edlio's internal
  schema, upserts a SchemaMapping on the Edlio dashboard, applies the
  V3-default per-role sync config, and links the SchemaMapping to the FTP
  account. Leaves the FTP account `enabled=false` for operator review.
exec: ./run.mjs
repliclawEnvelopeVersion: 0.2.0
outputs_schema: ./schema.json
requires:
  - FORGE_BASE_URL
  - FORGE_URL
  - FORGE_SHARED_SECRET
  - FILEMAGE_API_URL
  - FILEMAGE_API_KEY
  - EDLIOAPP_USER
  - EDLIOAPP_OP_ITEM_ID
  - EDLIOAPP_OP_VAULT
  - EDLIO_TOKEN_CACHE_PATH
  - OP_SERVICE_ACCOUNT_TOKEN
  - HOME
inputs:
  ticket_key:
    type: string
    required: true
  triggered_by:
    type: string
    description: Email of the operator who dragged the agent onto the ticket.
    required: false
  mode:
    type: string
    enum: [v3, v2]
    default: v3
    description: Per-role sync config flavor. V3 is the default.
  schema_mapping_id:
    type: integer
    required: false
    description: |
      If supplied, reuse the existing Edlio SchemaMapping with this ID
      instead of creating/updating one. Skill still applies role config
      and links the mapping to the FTP account.
  filemage_username:
    type: string
    required: false
    description: |
      Override for the Edlio FTP-account `userName` lookup. Default is
      derived from `ticket.schoolName` via the `edlio_<slug>` Diana
      convention; supply this when the actual FTP account uses an
      abbreviated form (e.g. `edlio_franklinton_hs`).
  field_overrides:
    type: object
    required: false
    description: |
      Resolution input for needs-input retry. Shape:
        { "<role>": { "<edlio_field>": { "csv_column": "<colname>" | null } } }
      where role ∈ {student,teacher,staff,parent,guardian,relative,
      administrator}, edlio_field is the SchemaMapping field key (e.g.
      firstNameFieldName), and csv_column null means "not present in CSVs".
  role_assignments:
    type: object
    required: false
    description: |
      Resolution input for needs-input retry when CSV→role classification
      is ambiguous. Shape: { "<csv_filename>": "student|teacher|staff|parent|administrator|relative|null" }.
      null means "ignore this file".
  force_rerun:
    type: boolean
    default: false
    description: Bypass idempotency guard (`[app-sftp-config]` marker).
---

# app-sftp-config

End-to-end Edlio FTP-account configuration. Runs **after** `app-sftp` has
provisioned the FileMage user, sent the setup email, and the client has
uploaded their first sync batch.

## Phases

1. **Read Forge ticket.** Validate APP_SFTP and that the ticket has
   `pocEmail` set (proxy for "client engagement happened"). Pull
   `schoolName`, `sisProvider`, `dashboard`.
2. **Idempotency guard.** Scan Forge comments for the
   `[app-sftp-config skill_version=…]` marker. If present and not
   `force_rerun`, return `already_done`.
3. **Edlio auth.** Try cached refresh-token. Fall back to
   password+TOTP via `EDLIOAPP_OP_ITEM_ID` (1Password item with
   password + TOTP secret). Cache new refresh token.
4. **Resolve Edlio FTP account.** Look up by `userName` =
   FileMage username derived from the ticket. Hard-fail with
   `needs_filemage` if the FTP account doesn't exist.
5. **FileMage SSH-key preflight.** Fetch the FileMage user record
   via `GET /users/{id}/` and inspect `keys[]`. If Edith's
   fingerprint (`28:bd:3d:21:…`) is missing, `POST /users/{id}/keys/`
   to attach `~/.ssh/filemage_ed25519.pub` so the next-step `sftp`
   connect succeeds. Idempotent: skipped if already authorized.
   Hard-fail with `filemage_key_failed` on POST failure.
6. **List + sample CSVs over SFTP.** Connect to the FileMage user
   (now authorized), list files in the user's home, download first
   ~50 rows of each `.csv` to a scratch dir. Skip files that are
   empty or non-CSV.
7. **Classify each CSV by role.** Heuristic on filename + column
   profile (e.g. presence of `Student ID`, `Employee ID`, `Role`,
   `Relationship ID`). Multi-role files (single Users.csv with all
   people) are tagged `multi`. If any file is unclassified or
   ambiguous, return `needs_input` with `unclassified_files` and
   best-guess role.
   - **Employee-family fan-out:** `staff`, `teacher`, and
     `administrator` share one source schema (Employee ID + a Role
     column). A roster often ships ONE employee/staff file serving all
     three, but the classifier may label it as just `staff`. When a
     file is single-classified as any employee role, it is also offered
     (coverage-aware) to the other employee roles, so teacher/admin pull
     `employeeIdFieldName` from the employee file instead of re-gating on
     a person-multi file (e.g. users.csv) that has no Employee ID. The
     file only wins a sibling role where it actually covers more required
     fields. (Fixes the SS-273 Apply-loop where teacher/administrator
     fell to users.csv and re-parked on employeeIdFieldName.)
8. **Per-role column mapping.** For each active role, fuzzy-match
   CSV column headers against the canonical Edlio field aliases
   (`assets/aliases.json`). Confidence ≥ 0.85 = auto-accept,
   anything lower needs review. Required-field misses on an active
   role return `needs_input` with `unmapped_fields` and best
   guesses.
9. **Build SchemaMapping payload.** Per-role `*Settings` blocks
   with field-name → CSV-column mappings. `name = ticket.schoolName`,
   `description = ticket.sisProvider`. `hasMultipleFiles` derived
   from CSV file count. `acceptedFileNames` = list of filenames
   actually present.
10. **Upsert SchemaMapping.**
    - If `schema_mapping_id` input was provided → fetch + update.
    - Else search by `name` in `GetIndexListSchemaMappingModel` →
      update if found.
    - Else `CreateSchemaMapping`.
11. **Apply per-role sync config to FTP account.** Overlay V3 (or
    V2 if `mode=v2`) spec from `assets/role-config.json` onto FTP
    account `*Settings` blocks. If a `classes`/`classrooms` CSV is
    present, also flip `classroomSyncEnabled=true` +
    `deleteMissingClassrooms=true` on the FTP account; enrollments
    ride along automatically (no separate FTP-side toggle). Grade
    and lineItem syncs stay off in v0.1. Leave FTP `enabled` as-is.
12. **Link SchemaMapping to FTP account.** Set `syncSchema = {id: …}`
    on the FTP account.
13. **Save FTP account** via `UpdateFtpAccount`.
14. **Post Forge comment** with marker, list of mapped roles,
    SchemaMapping ID, dashboard link. Do **not** transition ticket.

## Statuses

- `ok` — schema mapping upserted, role config applied, FTP account
  linked. Comment posted with `[app-sftp-config]` marker.
- `already_done` — marker found, no `force_rerun`. No-op.
- `needs_input` — unclassified files, missing required fields, or
  district resolution failed. Envelope `data.needs_input` lists what
  the operator must supply via `field_overrides`/`role_assignments`.
- `error` — unexpected failure (auth, SFTP, FileMage key attach,
  Edlio API). No mutations rolled back; SchemaMapping/FTP-account
  changes are independent steps and may be partially applied.
  `status_reason` distinguishes: `auth_failed`, `sftp_failed`,
  `filemage_key_failed`, `edlio_failed`.

## Hard rules

- Never set `enabled=true` on the FTP account. Operator review only.
- Never `sendInvite=true` on any role.
- `relativeSettings.skipWithMissingSourceId = true` (per spec).
- Aide and Other-Parent/Alumni/Member/Volunteer/Other-Community →
  `syncEnabled=false`.
- Don't touch `organizationIdMappings`. Operator wires the school
  list manually.

## Outputs

See `schema.json`. Notable fields:
- `data.schema_mapping.{id, name, action}` — `created` | `updated` | `reused`
- `data.ftp_account.{id, userName, district_name, schemaMappingId, enabled}`
- `data.csvs[]` — per-file classification + column count
- `data.role_mappings.<role>.{auto, low_confidence, missing_required}`
- `data.needs_input` (only when status=needs_input)

### v0.3.4 — fileName pseudo-field + multi-promotion
- `fileName` is never a model-mappable column. It is set deterministically to
  the role's source CSV filename in the proposal AND the payload. The model is
  told to omit it. (Fixes Edlio "File name is empty in <Role> settings." 400s.)
- Multi-promotion guard: a person file single-classified as ONE role (model
  non-determinism) is promoted to "multi" if it has a Role/UserType column or
  both student-id + employee-id columns. Then only the person roles actually
  present in the Role column values are mapped — so a students-only users.csv
  doesn't force empty teacher/administrator mappings that re-gate.
