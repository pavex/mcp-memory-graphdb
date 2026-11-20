const MAX_SIMILAR = 3
// "fix" in "bugfix", but not "schema" in "schema-parser"
const MAX_EXTRA_CHARS = 4


// Textual similarity of short names (labels, property keys). No semantics:
// catches plural/singular forms, '-' / '_' variants, short prefixes/suffixes
// and one-character typos - "fixes" ~ "fix" ~ "bugfix", "code-review" ~
// "review", "note_career" ~ "note-career", "desciption" ~ "description".
// Synonyms ("confirmed" / "final") are out of reach by design.
/** Whether two names are likely variants of each other. */
export function isSimilar(a: string, b: string): boolean {
    const x = similarityKey(a)
    const y = similarityKey(b)
    if (x === y) {
        return true
    }
    // Names with digits are deliberate series/versions (status_update_2,
    // vcl4_status, schema3) - only an exact normalized match counts for them.
    if (/\d/.test(x) || /\d/.test(y)) {
        return false
    }
    const [short, long] = x.length <= y.length ? [x, y] : [y, x]
    if (short.length >= 3 && long.length - short.length <= MAX_EXTRA_CHARS && long.includes(short)) {
        return true
    }
    return short.length >= 4 && Math.abs(x.length - y.length) <= 1 && editDistance(x, y) === 1
}


// Weaker than isSimilar: the names share a whole word ("static-export" /
// "static-site", "framework-finding" / "finding"). Often just a related name
// in a family (schema-parser / schema-explorer), so it is reported apart.
/** Whether two names share a whole word. */
export function isRelated(a: string, b: string): boolean {
    const other = new Set(words(b))
    return words(a).some(word => other.has(word))
}


// Matches are ranked by count (most used first). Names that already exist
// exactly, or resemble nothing, produce no warning - new, unrelated names are
// fine. With `related`, a name without a similar match also reports existing
// names sharing a whole word.
/** Warnings for names that do not exist yet but resemble existing ones. */
export function similarNameWarnings(kind: string, names: string[], existing: { name: string, count?: number }[], { related = false } = {}): string[] {
    const known = new Set(existing.map(entry => entry.name))
    const warnings: string[] = []
    for (const name of names) {
        if (known.has(name)) {
            continue
        }
        const similar = rank(existing.filter(entry => isSimilar(name, entry.name)))
        if (similar.length) {
            warnings.push(`${kind} "${name}" is new - similar existing: ${formatList(similar)}. Reuse one of them unless the new ${kind} is really different.`)
            continue
        }
        const relatedNames = related ? rank(existing.filter(entry => isRelated(name, entry.name))) : []
        if (relatedNames.length) {
            warnings.push(`${kind} "${name}" is new - related existing: ${formatList(relatedNames)}. Reuse one of them if it means the same.`)
        }
    }
    return warnings
}


function similarityKey(name: string): string {
    const key = name.toLowerCase().replace(/[-_]/g, '')
    return key.length > 3 ? key.replace(/(es|s)$/, '') : key
}


function editDistance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
    for (let i = 1; i <= a.length; i++) {
        const current = [i]
        for (let j = 1; j <= b.length; j++) {
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
        }
        previous = current
    }
    return previous[b.length]
}


// Whole words of a hyphenated name, singularized; short words (ai, cli) and
// words with digits (vcl4) are ignored as too generic / deliberate versions.
function words(name: string): string[] {
    return name.toLowerCase().split(/[-_]+/)
        .map(word => (word.length > 4 ? word.replace(/s$/, '') : word))
        .filter(word => word.length >= 4 && !/\d/.test(word))
}


function rank<T extends { count?: number }>(matches: T[]): T[] {
    return matches.sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, MAX_SIMILAR)
}


function formatList(matches: { name: string, count?: number }[]): string {
    return matches.map(entry => (entry.count ? `${entry.name} (${entry.count})` : entry.name)).join(', ')
}
