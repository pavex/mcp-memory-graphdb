import type { GraphNode } from './GraphNode'


/** A node after add or update, with warnings about new labels or property keys resembling existing ones. */
export interface NodeWriteResult {
    node: GraphNode
    warnings: string[]
}
