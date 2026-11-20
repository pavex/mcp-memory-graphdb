/** A node to add; the id is generated when omitted. */
export interface NewNode {
    id?: string
    type: string
    /** A string separated by spaces and/or commas, or an array (see normalizeLabels). */
    labels?: string | string[]
    properties?: Record<string, unknown>
}
