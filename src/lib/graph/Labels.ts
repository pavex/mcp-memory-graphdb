import type { LabelCount } from './interfaces/LabelCount'
import { similarNameWarnings } from './Similarity'


const LABEL_SEPARATOR = /[\s,]+/


// Labels are stored as one space-separated string ("ai duckdb memory"); a
// single label uses '-' instead of spaces ("schema-parser"). Input may be a
// string separated by spaces and/or commas, or an array; every write goes
// through normalizeLabels, so the stored form is always the same: no empty
// entries, no duplicates (case-insensitive, the first spelling wins).
/** The stored form of labels given as a string or an array. */
export function normalizeLabels(input: string | string[] | null | undefined): string {
    const parts = Array.isArray(input) ? input : String(input ?? '').split(LABEL_SEPARATOR)
    const seen = new Set<string>()
    const out: string[] = []
    for (const part of parts) {
        const label = String(part).trim().replace(/\s+/g, '-')
        const key = label.toLowerCase()
        if (label && !seen.has(key)) {
            seen.add(key)
            out.push(label)
        }
    }
    return out.join(' ')
}


/** Warnings for new labels that resemble existing ones (see Similarity); a label differing only in case counts as known. */
export function labelWarnings(labels: string | string[], existing: LabelCount[]): string[] {
    const known = new Set(existing.map(entry => entry.label.toLowerCase()))
    const fresh = normalizeLabels(labels).split(' ').filter(label => label && !known.has(label.toLowerCase()))
    return similarNameWarnings('label', fresh, existing.map(entry => ({ name: entry.label, count: entry.count })), { related: true })
}
