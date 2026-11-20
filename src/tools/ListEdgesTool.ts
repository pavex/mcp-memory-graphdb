import { z } from 'zod'
import type { EdgeFilter } from '../lib/graph'
import { Tool } from './Tool'


/** The tool list_edges: edges by source, target and/or type, newest first. */
export class ListEdgesTool extends Tool<EdgeFilter> {

    protected readonly name = 'list_edges'
    protected readonly title = 'List edges'
    protected readonly annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    protected readonly description = 'List edges. Filter by source_id, target_id and/or type.'


    protected inputSchema() {
        return z.object({
            source_id: z.string().optional(),
            target_id: z.string().optional(),
            type: z.string().optional(),
            limit: z.number().int().min(1).max(200).default(50)
        })
    }


    protected async run(filter: EdgeFilter): Promise<object> {
        const edges = await this.memory.listEdges(filter)
        return { success: true, count: edges.length, edges }
    }
}
