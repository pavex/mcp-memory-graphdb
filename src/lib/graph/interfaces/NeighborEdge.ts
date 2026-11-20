import type { EdgeDirection } from '../types/EdgeDirection'


/** An edge seen from one node: its direction, its type and the node on the other end. */
export interface NeighborEdge {
    direction: EdgeDirection
    type: string
    other_id: string
    other_type: string
}
