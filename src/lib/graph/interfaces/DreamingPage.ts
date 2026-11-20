import type { DreamingNode } from './DreamingNode'


/** One page of the graph review: all nodes counted, a batch ordered by type and normalized name. */
export interface DreamingPage {
    total: number
    nodes: DreamingNode[]
}
