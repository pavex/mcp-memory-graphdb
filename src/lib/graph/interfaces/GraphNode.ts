/** A node as stored: labels normalized, properties parsed, times as UTC ISO strings. */
export interface GraphNode {
    id: string
    type: string
    /** Space-separated labels ("ai duckdb schema-parser"). */
    labels: string
    properties: Record<string, unknown>
    created_at: string
    updated_at: string
}
