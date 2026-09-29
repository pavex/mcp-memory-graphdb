// ---------------------------------------------------------------------------
// Labels are stored as one comma-separated string ("ai,duckdb,memory").
// Input may be that string or an array; every write goes through
// normalizeLabels so the stored form is always consistent: trimmed, no
// empty entries, no duplicates (case-insensitive, first spelling wins).
// ---------------------------------------------------------------------------

export function normalizeLabels(input) {
  const parts = Array.isArray(input) ? input : String(input ?? '').split(',');
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const label = String(part).trim();
    const key = label.toLowerCase();
    if (label && !seen.has(key)) {
      seen.add(key);
      out.push(label);
    }
  }
  return out.join(',');
}
