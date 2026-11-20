import type { EdgeTypeDefinition } from './EdgeTypeDefinition'
import type { Migration } from './Migration'
import type { NodeTypeDefinition } from './NodeTypeDefinition'


/** A validated apply() payload: nodes and edges are patches, migrations rename or remove types. */
export interface SchemaChange {
    /** Accepted and ignored - the revision is always computed. */
    revision?: number
    migrations?: Migration[]
    nodes?: Record<string, NodeTypeDefinition>
    edges?: Record<string, EdgeTypeDefinition>
}
