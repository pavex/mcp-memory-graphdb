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

// ---------------------------------------------------------------------------
// Similar-label hints. Purely textual (no semantics): catches plural/singular
// forms, hyphen variants, short prefixes/suffixes and one-character typos -
// "fixes" ~ "fix" ~ "bugfix", "code-review" ~ "review". Synonyms such as
// "confirmed" / "final" are out of reach by design and left to dreaming.
// ---------------------------------------------------------------------------

const MAX_SIMILAR = 3;
const MAX_EXTRA_CHARS = 4; // "fix" in "bugfix", but not "schema" in "schema-parser"

function similarityKey(label) {
  const key = label.toLowerCase().replace(/[-_]/g, '');
  return key.length > 3 ? key.replace(/(es|s)$/, '') : key;
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function isSimilarLabel(a, b) {
  const x = similarityKey(a);
  const y = similarityKey(b);
  if (x === y) {
    return true;
  }
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 3 && long.length - short.length <= MAX_EXTRA_CHARS && long.includes(short)) {
    return true;
  }
  return short.length >= 4 && Math.abs(x.length - y.length) <= 1 && editDistance(x, y) === 1;
}

// Warnings for labels in `labels` that do not exist yet but resemble existing
// ones. `existing` is [{ label, count }] (see GraphDatastore.listLabels).
// Returns [] when every label is known or nothing similar exists.
export function labelWarnings(labels, existing) {
  const known = new Set(existing.map((e) => e.label.toLowerCase()));
  const warnings = [];
  for (const label of normalizeLabels(labels).split(' ').filter(Boolean)) {
    if (known.has(label.toLowerCase())) {
      continue;
    }
    const similar = existing
      .filter((e) => isSimilarLabel(label, e.label))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_SIMILAR);
    if (similar.length) {
      const list = similar.map((e) => `${e.label} (${e.count})`).join(', ');
      warnings.push(`label "${label}" is new - similar existing: ${list}. Reuse one of them unless the new label is really different.`);
    }
  }
  return warnings;
}
