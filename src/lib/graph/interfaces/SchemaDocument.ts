import type { EdgeTypeDefinition } from './EdgeTypeDefinition'
import type { NodeTypeDefinition } from './NodeTypeDefinition'


/** The content of schema.yaml. */
export interface SchemaDocument {
    revision: number
    nodes: Record<string, NodeTypeDefinition>
    edges: Record<string, EdgeTypeDefinition>
}
