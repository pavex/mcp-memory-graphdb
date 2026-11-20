/** A rename_node / rename_edge migration; merge allows a target that already exists. */
export interface TypeRename {
    from: string
    to: string
    merge?: boolean
}
