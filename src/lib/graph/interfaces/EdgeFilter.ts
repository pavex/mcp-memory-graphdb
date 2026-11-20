/** Which edges listEdges() returns, newest first. */
export interface EdgeFilter {
    source_id?: string
    target_id?: string
    type?: string
    limit: number
}
