import { similarNameWarnings } from './Similarity.js';

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

// Warnings for new labels that resemble existing ones (see Similarity.js).
// `existing` is [{ label, count }] (see GraphDatastore.listLabels). A label
// that differs from an existing one only in case counts as known.
export function labelWarnings(labels, existing) {
  const known = new Set(existing.map((e) => e.label.toLowerCase()));
  const fresh = normalizeLabels(labels).split(' ').filter((l) => l && !known.has(l.toLowerCase()));
  return similarNameWarnings('label', fresh, existing.map((e) => ({ name: e.label, count: e.count })), { related: true });
}
