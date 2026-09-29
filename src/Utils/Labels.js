// ---------------------------------------------------------------------------
// Labels are stored as one space-separated string ("ai duckdb memory") -
// single labels use '-' instead of spaces ("schema-parser"). Input may be a
// string separated by spaces and/or commas, or an array; every write goes
// through normalizeLabels so the stored form is always consistent: no empty
// entries, no duplicates (case-insensitive, first spelling wins).
// ---------------------------------------------------------------------------

export const LABEL_SEPARATOR = /[\s,]+/;

export function normalizeLabels(input) {
  const parts = Array.isArray(input) ? input : String(input ?? '').split(LABEL_SEPARATOR);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const label = String(part).trim().replace(/\s+/g, '-');
    const key = label.toLowerCase();
    if (label && !seen.has(key)) {
      seen.add(key);
      out.push(label);
    }
  }
  return out.join(' ');
}
