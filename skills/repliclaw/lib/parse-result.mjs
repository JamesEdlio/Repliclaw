// Extract a <<RESULT>>{json} payload from streaming assistant text.
// Handles the case where the JSON arrives in chunks split across SSE frames.

/**
 * @typedef {{kind:"ok", value:unknown}
 *          | {kind:"incomplete"}
 *          | {kind:"malformed", raw:string}} ExtractResult
 */

/**
 * @param {string} text
 * @returns {ExtractResult}
 */
export function tryExtractResult(text) {
  const idx = text.lastIndexOf("<<RESULT>>");
  if (idx === -1) return { kind: "incomplete" };
  const tail = text.slice(idx + "<<RESULT>>".length).trimStart();
  if (tail.length === 0) return { kind: "incomplete" };

  const first = tail[0];
  if (first !== "{" && first !== "[") {
    return { kind: "malformed", raw: tail.slice(0, 200) };
  }

  const open = first;
  const close = first === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const jsonStr = tail.slice(0, i + 1);
        try { return { kind: "ok", value: JSON.parse(jsonStr) }; }
        catch { return { kind: "malformed", raw: jsonStr.slice(0, 200) }; }
      }
    }
  }
  return { kind: "incomplete" };
}
