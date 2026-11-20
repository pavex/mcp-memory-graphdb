import type { TypeRename } from './TypeRename'


/** One migration entry: exactly one of its keys is set. */
export interface Migration {
    rename_node?: TypeRename
    rename_edge?: TypeRename
    remove_node?: { type: string }
    remove_edge?: { type: string }
}
