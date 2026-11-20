import type { MergeResult } from './MergeResult'
import type { NodeWriteResult } from './NodeWriteResult'


/** A node after updateNode(), and what merging did when duplicates were merged into it. */
export interface NodeUpdateResult extends NodeWriteResult {
    merge?: MergeResult
}
