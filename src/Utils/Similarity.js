// ---------------------------------------------------------------------------
// Textual similarity of short names (labels, property keys). No semantics:
// catches plural/singular forms, '-' / '_' variants, short prefixes/suffixes
// and one-character typos - "fixes" ~ "fix" ~ "bugfix", "code-review" ~
// "review", "note_career" ~ "note-career", "desciption" ~ "description".
// Synonyms ("confirmed" / "final") are out of reach by design.
// ---------------------------------------------------------------------------

const MAX_SIMILAR = 3;
const MAX_EXTRA_CHARS = 4; // "fix" in "bugfix", but not "schema" in "schema-parser"

function similarityKey(name) {
  const key = name.toLowerCase().replace(/[-_]/g, '');
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

export function isSimilar(a, b) {
  const x = similarityKey(a);
  const y = similarityKey(b);
  if (x === y) {
    return true;
  }
  // Names with digits are deliberate series/versions (status_update_2,
  // vcl4_status, schema3) - only an exact normalized match counts for them.
  if (/\d/.test(x) || /\d/.test(y)) {
    return false;
  }
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 3 && long.length - short.length <= MAX_EXTRA_CHARS && long.includes(short)) {
    return true;
  }
  return short.length >= 4 && Math.abs(x.length - y.length) <= 1 && editDistance(x, y) === 1;
}

// Warnings for names that do not exist yet but resemble existing ones.
// `existing` is [{ name, count? }]; matches are ranked by count (most used
// first). Names that already exist exactly, or resemble nothing, produce no
// warning - new, unrelated names are fine.
export function similarNameWarnings(kind, names, existing) {
  const known = new Set(existing.map((e) => e.name));
  const warnings = [];
  for (const name of names) {
    if (known.has(name)) {
      continue;
    }
    const similar = existing
      .filter((e) => isSimilar(name, e.name))
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
      .slice(0, MAX_SIMILAR);
    if (similar.length) {
      const list = similar.map((e) => (e.count ? `${e.name} (${e.count})` : e.name)).join(', ');
      warnings.push(`${kind} "${name}" is new - similar existing: ${list}. Reuse one of them unless the new ${kind} is really different.`);
    }
  }
  return warnings;
}
