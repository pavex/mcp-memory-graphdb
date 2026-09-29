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

// Whole words of a hyphenated name, singularized; short words (ai, cli) and
// words with digits (vcl4) are ignored as too generic / deliberate versions.
function words(name) {
  return name.toLowerCase().split(/[-_]+/)
    .map((w) => (w.length > 4 ? w.replace(/s$/, '') : w))
    .filter((w) => w.length >= 4 && !/\d/.test(w));
}

// Weaker than isSimilar: the names share a whole word ("static-export" /
// "static-site", "framework-finding" / "finding"). Often just a related name
// in a family (schema-parser / schema-explorer), so it is reported apart.
export function isRelated(a, b) {
  const other = new Set(words(b));
  return words(a).some((w) => other.has(w));
}

const rank = (matches) => {
  return matches.sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, MAX_SIMILAR);
};

const formatList = (matches) => {
  return matches.map((e) => (e.count ? `${e.name} (${e.count})` : e.name)).join(', ');
};

// Warnings for names that do not exist yet but resemble existing ones.
// `existing` is [{ name, count? }]; matches are ranked by count (most used
// first). Names that already exist exactly, or resemble nothing, produce no
// warning - new, unrelated names are fine. With `related`, a name without a
// similar match also reports existing names sharing a whole word.
export function similarNameWarnings(kind, names, existing, { related = false } = {}) {
  const known = new Set(existing.map((e) => e.name));
  const warnings = [];
  for (const name of names) {
    if (known.has(name)) {
      continue;
    }
    const similar = rank(existing.filter((e) => isSimilar(name, e.name)));
    if (similar.length) {
      warnings.push(`${kind} "${name}" is new - similar existing: ${formatList(similar)}. Reuse one of them unless the new ${kind} is really different.`);
      continue;
    }
    const rel = related ? rank(existing.filter((e) => isRelated(name, e.name))) : [];
    if (rel.length) {
      warnings.push(`${kind} "${name}" is new - related existing: ${formatList(rel)}. Reuse one of them if it means the same.`);
    }
  }
  return warnings;
}
