/** What merging duplicates did to their edges. */
export interface MergeResult {
    merged_ids: string[]
    redirected_edges: number
    dropped_duplicate_edges: number
    dropped_self_loops: number
}
