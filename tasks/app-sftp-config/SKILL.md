---
name: app-sftp-config
version: 0.7.4
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
4. **Resolve Edlio FTP account (create if missing).** Look up by
   `userName` = FileMage username derived from the ticket. If no
   dashboard FTP account exists, self-provision it: resolve the
   district by `schoolName` (`GetAllDistricts`, orgs fallback) and
   `CreateFtpAccount` with `enabled=false`. Edlio won't enable sync
   until an org + schema mapping exist, so the account is left
   DISABLED for the operator to enable on apply. Only hard-fails
   (`needs_district`) if the district can't be resolved — create the
   district/org in the dashboard first, or pass a `filemage_username`
   override, then re-run.
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

### v0.7.4 — relationship config: student-side-only (CreateSchemaMapping 500 fix)
- ROOT CAUSE of the persistent CreateSchemaMapping 500 (NullReferenceException)
  on Woodbine SS-460, confirmed against Edlio's own `schema-mapping-automation`
  dev guide (§6 Validation) + the golden-146 fixture:
  the payload configured relationships from BOTH sides. The field-mapper
  alias-maps the family file's "Relationship ID" column onto EVERY block whose
  source file carries it — student, parent AND guardian — so parent/guardian
  ended up with `relationshipIdsFieldName` set while `relationshipType` was
  null. Per the guide: (a) "whenever RelationshipIdsFieldName is set, a
  relationship type must also be set, and vice versa (one without the other
  fails)", and (b) relationships must be "set up from one side only — either the
  student side or the parent side, not both." Doing both → backend null-deref →
  500. Golden 146 is student-side-only: student carries "Relationship ID" +
  relationshipType + adaptiveRelationship:true; parent/guardian carry null.
- FIX: after building the five role slots, normalize the relationship config —
  the adaptive (student) slot OWNS it (ensure `relationshipIdsFieldName` is set
  from its source file's relationship column, since the mapper sometimes lands
  it on a sibling); every non-adaptive slot has `relationshipIdsFieldName`,
  `relationshipType`, and `adaptiveRelationship` forced to null/false.
- VERIFIED: dry-run on SS-460 now produces field-for-field parity with golden
  146 (identical top-level keys, 46-key role blocks, 8-key classroom block, and
  student-side-only adaptive relationship). Ready to apply once re-run.

### v0.7.3 — doc accuracy: Step 4 auto-creates the dashboard FTP account
- No behavior change to FTP provisioning (that shipped in v0.6.0): Step 4
  already self-provisions a DISABLED Edlio dashboard FTP account when none
  exists, resolving the district by school name. SKILL.md Step 4 still
  described the pre-v0.6.0 hard-fail (`needs_filemage`); updated it to document
  the create-if-missing flow and the only remaining hard-fail (`needs_district`,
  when the district can't be resolved). Verified live 2026-06-15 by creating
  the Pierre School District 32-2 account (district 595 → FTP acct 199).
- Also banks the Woodbine "Other"-role context fix: `canonicalRoleFromValue`
  now takes an `isFamilyFile` flag. A bare "Other" role value means an
  extended-family relative ONLY in a family file (one carrying a Relationship
  ID column); in an employee/staff roster "Other" is non-teaching staff and
  must not be routed into the guardian/relative family slot. Fixes the bogus
  `guardianSettings`-from-Staff.csv block seen on Woodbine SS-460.
- CORRECTION to the v0.7.2 note below: there was no Edlio "write-tier outage."
  The 500 NullReferenceException on writes came from sending the model FLAT;
  command writes require it wrapped as `{ $className, model: {...} }`. The
  skill already wraps correctly; a standalone probe did not, which produced the
  false outage signal. See knowledge/edlioapp.md.

### v0.7.2 — collapse unsupported role slots onto the 5 Edlio supports
- Edlio's CreateSchemaMapping supports exactly five person role-settings slots:
  student, teacher, staff, parent, guardian. (Verified by sampling 19 real
  accepted multi-file mappings — `administratorSettings` and `relativeSettings`
  are never populated.) Our internal classification is richer (administrator,
  relative), so the payload builder now collapses:
    administrator -> staff,  relative -> guardian
  When two internal roles land in the same slot, keep the richer block and
  union the `roleName` filter strings (e.g. "Staff, Administrator") so a single
  shared file still selects rows for both. adaptiveRelationship marker is
  preserved across the merge.
- NOTE: banked but NOT live-verified. As of 2026-06-12 ~20:09 UTC the Edlio
  write tier (CreateSchemaMapping / EditSchemaMapping / EditFtpAccount) is
  500ing with NullReferenceException on ALL known-good payloads — including a
  no-op round-trip of golden-146 and a no-op EditFtpAccount. Reads are 200.
  This is a platform-side regression (these writes worked earlier the same
  day). SS-460 is blocked on Edlio, not on this skill. Re-verify v0.7.2 once
  Edlio restores the command tier.

### v0.7.1 — drop phantom top-level booleans + full classroom block (500 fix)
- v0.7.0 still 500'd CreateSchemaMapping on Woodbine (SS-460). Captured the
  exact failing payload via dry-run and diffed it field-for-field against the
  golden-146 fixture. Two residual structural defects, both the same class of
  bug v0.7.0 fixed for role blocks but missed for the classroom/top-level:
    1. Injected three phantom top-level booleans — `hasClassroomMapping`,
       `hasGradesMapping`, `hasLineItemMapping` — that golden 146 does NOT
       carry (golden has only `hasMultipleFiles`). Now stripped; the live
       create-template supplies whatever grade/lineItem defaults Edlio wants.
    2. `classroomSchemaModel` was emitted SPARSE (4 keys) where golden carries
       the full 8-key block (with nulls for unmapped). Now built via
       `fullClassroomModel()` skeleton + overlay, same pattern as role blocks.
- After fix: dry-run payload top-level key set is IDENTICAL to golden 146, and
  every populated *Settings + classroom + enrollment block matches golden's key
  shape exactly. Remaining set/null differences are data-only (Woodbine roster
  has administrator/relative roles; Saline had staff/guardian).
- Lesson: when overlaying on a fetched template, never re-add keys the template
  doesn't define — diff the built payload against a known-good golden before
  shipping.

### v0.7.0 — build SchemaMapping payload from Edlio's blank create template
- Root-causes the residual `CreateSchemaMapping` / `EditSchemaMapping` 500s:
  hand-building the payload from scratch produced a structurally incomplete
  envelope. Edlio's deserializer requires every field present — both the
  top-level scalars (`withoutHeader`, `characterEncoding`, `availableParentTypes`,
  `imageLinkOrFileGuid`, `selected`, all the unused `*Settings` blocks) and the
  full ~46-key set inside each role-settings block (null when unmapped). A
  sparse block 500s with a generic ApplicationException.
- New approach: fetch `GetCreateSchemaMappingModel` (verified live → 200; returns
  the exact blank shape) and overlay only the fields we control. Role-settings
  blocks are built via `fullRoleSettings()` (skeleton of all keys, null-filled,
  overlaid with mapped fields); `relationshipType` is populated as a sub-object
  only on the single adaptive-relationship role.
- Org fields are now **nulled** (not `delete`d) on single-org accounts so the
  block keeps its full shape.
- `buildSchemaMappingPayload` is now `async` (it fetches the template);
  the caller awaits it.
- Validated field-for-field against James's golden Saline mapping 146: the live
  template supplies exactly the scalars/shape golden 146 carries.

### v0.6.0 — auto-provision Edlio FTP account when missing
- Step 4 no longer errors when an SFTP user exists on FileMage but has no
  Edlio dashboard FTP account (the classic "files arrive but nothing shows up
  in the app / Mass Comms" symptom). It now self-provisions: resolve the
  district by school name (`GetAllDistricts`, falling back to
  `GetAllOrganizations`), then `CreateFtpAccount` **disabled** (Edlio refuses
  to enable sync until an org mapping + schema mapping exist; those get built
  by the schema-mapping step and enabled on apply).
- New helpers: `edlioResolveDistrictId(schoolName)`,
  `edlioCreateFtpAccount({userName, districtId})`. Creation is surfaced in the
  result envelope (`edlio.ftp.create` action + `created_this_run: true`).
- If the district can't be resolved, returns `needs_district` (create the
  district/org in the dashboard first, or pass a `filemage_username` override).

### v0.5.0 — correct Edlio edit command names (THE real SS-273 blocker)
- The write commands were mis-named: `UpdateSchemaMapping` / `UpdateFtpAccount`
  do not exist on the backend, so it threw a generic 500 ApplicationException.
  Per Edlio dev, the correct commands are **`EditSchemaMapping`** and
  **`EditFtpAccount`** (the read index is `GetFtpAccountIndex`). Verified live:
  `Edit*` → 200, `Update*` → 500. There was NO Edlio write/token outage; that
  diagnosis was wrong (it came from probing the wrong `/connect/token`
  artifact + calling nonexistent command names).
- Removed the create-on-500 "(auto)" fallback that was built on the false
  outage premise — it masked real errors and spawned duplicate mappings. A
  failed edit now surfaces as a real error.

### v0.4.0 — golden mapping 146 (James-validated) payload shape
Schema-mapping payload builder rebuilt to reproduce Saline mapping id 146,
which James manually created in the Edlio dashboard and we read back via API
(fixture: research/edlioapp-recon/golden-schema-mapping-146-saline.json).
Validated offline field-for-field against the golden:
- `fileName` is bare — NO extension ("users", "staff", "classes", "enrollments").
- `acceptedFileNames` is always `[]`; `hasMultipleFiles` derived from distinct
  mapped-file count. (Populated acceptedFileNames was a 500 trigger.)
- `organizationIdentifierInFiles` driven by the FTP account's
  `organizationIdMappings` (non-empty = multi-org). Single school = false, and
  every role's `organizationIdFieldName` is stripped when false.
- Combined family file wins: a file with a Role column + Relationship ID is the
  family file; it supplies student + parent + guardian and beats a thin
  student-only file. (Prevents dropping parents/guardians.)
- `roleName` filter string built from the distinct raw Role values in the
  source file (parent -> "Mother, Father").
- `adaptiveRelationship` true on exactly one role — the one whose source file
  carries the Relationship ID (preference: student, parent, guardian, ...).
NOTE: golden 146 had a guardian `fileName` typo of "user"; the builder emits the
correct "users".

### v0.3.4 — fileName pseudo-field + multi-promotion
- `fileName` is never a model-mappable column. It is set deterministically to
  the role's source CSV filename in the proposal AND the payload. The model is
  told to omit it. (Fixes Edlio "File name is empty in <Role> settings." 400s.)
- Multi-promotion guard: a person file single-classified as ONE role (model
  non-determinism) is promoted to "multi" if it has a Role/UserType column or
  both student-id + employee-id columns. Then only the person roles actually
  present in the Role column values are mapped — so a students-only users.csv
  doesn't force empty teacher/administrator mappings that re-gate.
