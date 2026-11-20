import type { GraphNode } from './GraphNode'
import type { NeighborEdges } from './NeighborEdges'


/** A node of a dreaming page with its nearest edges and, when its name matches others of its type, their ids. */
export interface DreamingNode extends GraphNode {
    edges: NeighborEdges
    possible_duplicates?: string[]
}
