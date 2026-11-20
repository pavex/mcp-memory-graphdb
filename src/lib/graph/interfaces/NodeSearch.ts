/** A search of nodes by text inside their properties, case-insensitive, most recently updated first. */
export interface NodeSearch {
    query: string
    type?: string
    limit: number
}
