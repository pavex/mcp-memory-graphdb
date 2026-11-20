/** An edge to add; the id is generated when omitted. */
export interface NewEdge {
    id?: string
    type: string
    source_id: string
    target_id: string
    properties?: Record<string, unknown>
}
