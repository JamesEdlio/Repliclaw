// model-mapper.mjs — LLM-driven CSV → Edlio schema mapping for app-sftp-config.
//
// Replaces the brittle alias/fuzzy matcher's "bail to needs-input" behaviour
// with a model that maps everything it can and attaches a per-field
// confidence + one-line rationale. Nothing here writes to Edlio; it only
// proposes. The caller (run.mjs) parks the proposal for human approval.
//
// Calls OpenRouter (OPENROUTER_API_KEY in the bridge env). On any failure
// (no key, network, bad JSON) the caller falls back to the deterministic
// alias matcher — the model is an enhancement, never a hard dependency.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL =
  process.env.APP_SFTP_MAP_MODEL || "anthropic/claude-sonnet-4.5";
const SAMPLE_ROWS_FOR_MODEL = 8; // headers + a few rows is plenty of signal
const MODEL_TIMEOUT_MS = 60_000;

/** Strip ```json … ``` (or ```` ``` ````) code fences some providers add. */
function stripFence(s) {
  const t = s.trim();
  if (t.startsWith("```")) {
    return t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  }
  return t;
}

/**
 * Build the compact schema spec the model maps against, derived from
 * aliases.json. We give the model the canonical field key, its human label,
 * whether it's required (and for which roles), and a couple of alias hints.
 */
function buildSchemaSpec(aliases) {
  const personFields = aliases.person_fields || {};
  const classroomFields = aliases.classroom_fields || {};
  const enrollmentFields = aliases.enrollment_fields || {};
  const roleRequired = aliases.role_required_fields || {};

  const fieldSpec = (set) =>
    Object.entries(set).map(([key, def]) => ({
      field: key,
      label: def.label || key,
      required: def.required === true,
      required_for: def.required_for || undefined,
      hints: (def.aliases || []).slice(0, 6),
    }));

  return {
    person_fields: fieldSpec(personFields),
    classroom_fields: fieldSpec(classroomFields),
    enrollment_fields: fieldSpec(enrollmentFields),
    role_required_fields: roleRequired,
  };
}

/**
 * Compact each CSV down to headers + a handful of sample rows so the prompt
 * stays small even for wide rosters.
 */
function compactCsvs(csvs) {
  return csvs.map((f) => ({
    filename: f.filename,
    headers: f.headers,
    sample_rows: (f.sampleRows || []).slice(0, SAMPLE_ROWS_FOR_MODEL),
  }));
}

function buildPrompt(csvs, schemaSpec, activeRoles, nonpersonRoles, aliases) {
  return [
    {
      role: "system",
      content:
        "You are a data-integration assistant for Edlio, a school CMS. You map " +
        "the columns of district-provided roster CSV files to Edlio's canonical " +
        "SchemaMapping fields. You are precise and never invent column names — " +
        "every csv_column you output MUST be an exact header from that file, or " +
        "null if no column fits. Output STRICT JSON only, no prose.",
    },
    {
      role: "user",
      content: JSON.stringify({
        task:
          "For each CSV file, (1) classify which roster role it represents, then " +
          "(2) map each Edlio field to the best-matching CSV column. Map " +
          "everything you reasonably can. For each mapped field give a confidence " +
          "0.0-1.0 and a one-line rationale. If a required field has no good " +
          "column, set csv_column=null and explain why in the rationale — do NOT " +
          "guess wildly. Use the sample row values, not just header names, to " +
          "decide (e.g. a column of 6-digit numbers labelled 'ID' that matches the " +
          "Employee ID pattern).",
        roles: {
          person_roles: activeRoles,
          nonperson_roles: nonpersonRoles,
          note:
            "A single CSV may serve multiple person roles (classify the FILE as " +
            "'multi'). When a file is 'multi', emit a SEPARATE mappings entry for " +
            "EACH person role it serves (all pointing at the same csv_file), and " +
            "map that role's full required field set. Different roles require " +
            "different fields — e.g. teacher/administrator require " +
            "employeeIdFieldName but student does not, so you must propose an " +
            "employee-id column (or null with a reason) specifically for the " +
            "teacher and administrator entries. classroom/enrollment are " +
            "non-person. Use null role to ignore a file.",
        },
        important_note:
          "NEVER emit a `fileName` field in your mappings — it is not a CSV " +
          "column. The system fills it automatically with the source filename. " +
          "Omit fileName entirely from every fields object.",
        role_required_fields: aliases.role_required_fields || {},
        edlio_schema: schemaSpec,
        csv_files: compactCsvs(csvs),
        output_format: {
          classifications: {
            "<filename>": "<role | 'multi' | null>",
          },
          mappings: {
            "<role>": {
              csv_file: "<filename the role was mapped from>",
              fields: {
                "<edlioFieldKey>": {
                  csv_column: "<exact header | null>",
                  confidence: 0.0,
                  rationale: "<short reason>",
                },
              },
            },
          },
        },
      }),
    },
  ];
}

/**
 * Run the model mapping. Returns:
 *   { ok: true, model, classifications, mappings }
 *   { ok: false, reason }   // caller falls back to alias matcher
 */
export async function modelMapAll(csvs, aliases, opts = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: false, reason: "no OPENROUTER_API_KEY" };
  if (!csvs || !csvs.length) return { ok: false, reason: "no csvs" };

  const activeRoles = opts.activeRoles || [];
  const nonpersonRoles = opts.nonpersonRoles || [];
  const model = opts.model || DEFAULT_MODEL;
  const schemaSpec = buildSchemaSpec(aliases);
  const messages = buildPrompt(csvs, schemaSpec, activeRoles, nonpersonRoles, aliases);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-title": "edlio-app-sftp-config",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages,
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, reason: `request failed: ${err.message}` };
  }
  clearTimeout(timer);

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, reason: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
  }

  let json;
  try {
    json = await resp.json();
  } catch (err) {
    return { ok: false, reason: `bad response json: ${err.message}` };
  }

  const content = json?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, reason: "empty model content" };

  let parsed;
  try {
    parsed = typeof content === "string" ? JSON.parse(stripFence(content)) : content;
  } catch (err) {
    return { ok: false, reason: `model did not return valid JSON: ${err.message}` };
  }

  const classifications = parsed.classifications || {};
  const mappings = parsed.mappings || {};

  // Defensive validation: every csv_column the model picked must be a real
  // header in the file it claims to map from. Drop hallucinated columns.
  const headersByFile = Object.fromEntries(
    csvs.map((f) => [f.filename, new Set(f.headers)])
  );
  let dropped = 0;
  for (const [role, m] of Object.entries(mappings)) {
    const headers = headersByFile[m.csv_file] || new Set();
    const fields = m.fields || {};
    for (const [field, info] of Object.entries(fields)) {
      if (
        info.csv_column != null &&
        info.csv_column !== "" &&
        !headers.has(info.csv_column)
      ) {
        // Model invented a column; null it out and mark low confidence.
        info.csv_column = null;
        info.confidence = 0;
        info.rationale =
          `(dropped: "${info.csv_column}" not a real header) ` +
          (info.rationale || "");
        dropped++;
      }
    }
  }

  return {
    ok: true,
    model,
    dropped_hallucinated_columns: dropped,
    classifications,
    mappings,
  };
}

/**
 * Flatten a model `mappings` entry into the same shape mapRoleColumns()
 * returns, so the rest of run.mjs is agnostic to the source. Also produces a
 * review-friendly proposal block (per field: column, confidence, rationale).
 */
export function modelMappingToRoleMapping(role, modelEntry, aliases, sampleRowsByFile) {
  const required = (aliases.role_required_fields || {})[role] || [];
  const fields = modelEntry?.fields || {};
  const csv_file = modelEntry?.csv_file || null;

  const auto_mapped = {};
  const proposal = []; // [{ field, label, csv_column, confidence, rationale, sample }]
  const low_confidence = [];

  const labelFor = (field) => {
    const sets = [
      aliases.person_fields,
      aliases.classroom_fields,
      aliases.enrollment_fields,
    ];
    for (const s of sets) if (s && s[field]) return s[field].label || field;
    return field;
  };

  const sampleRows = (sampleRowsByFile && sampleRowsByFile[csv_file]) || [];
  const sampleFor = (col) => {
    if (!col) return null;
    for (const r of sampleRows) {
      const v = r?.[col];
      if (v != null && String(v).trim() !== "") return String(v).slice(0, 40);
    }
    return null;
  };

  for (const [field, info] of Object.entries(fields)) {
    // `fileName` is a pseudo-field: it is the literal source CSV filename, NOT
    // a column to map. The model often hallucinates it (emits "null" or a
    // header), which then gets dropped as a non-header — and it would show up
    // as an "unmapped" required field. Force it to csv_file and keep it out of
    // the proposal table entirely.
    if (field === "fileName") continue;
    const col = info?.csv_column || null;
    const conf = typeof info?.confidence === "number" ? info.confidence : 0;
    if (col) auto_mapped[field] = col;
    proposal.push({
      field,
      label: labelFor(field),
      csv_column: col,
      confidence: Number(conf.toFixed(2)),
      rationale: info?.rationale || "",
      sample: sampleFor(col),
      required: required.includes(field),
    });
    if (col && conf < 0.6) {
      low_confidence.push({ field, label: labelFor(field), column: col, confidence: conf });
    }
  }

  // Always set fileName to the literal source CSV — deterministic, never mapped.
  if (csv_file) auto_mapped.fileName = csv_file;

  const missing_required = required.filter((f) => f !== "fileName" && !auto_mapped[f]);

  return {
    csv_file,
    auto_mapped,
    low_confidence,
    missing_required,
    proposal,
    source: "model",
  };
}
