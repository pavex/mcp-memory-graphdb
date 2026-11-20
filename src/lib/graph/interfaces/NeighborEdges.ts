import type { NeighborEdge } from './NeighborEdge'


/** Up to a cap of edges in each direction, and how many more there are beyond the cap. */
export interface NeighborEdges {
    out: NeighborEdge[]
    in: NeighborEdge[]
    out_more: number
    in_more: number
}
