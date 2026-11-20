/** A change of a node: labels replace, properties merge into the existing ones. */
export interface NodeUpdate {
    id: string
    labels?: string | string[]
    properties?: Record<string, unknown>
    /** Duplicates merged into this node: their edges are redirected here and they are deleted. */
    merge_from?: string[]
}
