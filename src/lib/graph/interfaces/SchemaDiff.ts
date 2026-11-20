import type { TypeRename } from './TypeRename'


/** What apply() changed in the schema. */
export interface SchemaDiff {
    addedNodes: string[]
    updatedNodes: string[]
    addedEdges: string[]
    updatedEdges: string[]
    renamedNodes: TypeRename[]
    renamedEdges: TypeRename[]
    removedNodes: string[]
    removedEdges: string[]
}
