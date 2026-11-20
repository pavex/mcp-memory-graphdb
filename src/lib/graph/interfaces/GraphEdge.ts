/** A directed edge as stored. */
export interface GraphEdge {
    id: string
    type: string
    source_id: string
    target_id: string
    properties: Record<string, unknown>
    created_at: string
}
