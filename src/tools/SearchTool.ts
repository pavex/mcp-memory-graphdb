import { z } from 'zod'
import type { NodeSearch } from '../lib/graph'
import { Tool } from './Tool'


/** The tool search: nodes by text inside their properties. */
export class SearchTool extends Tool<NodeSearch> {

    protected readonly name = 'search'
    protected readonly title = 'Search nodes'
    protected readonly annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    protected readonly description = 'Search nodes by text inside properties (case-insensitive). Optionally filter by node type.'


    protected inputSchema() {
        return z.object({
            query: z.string().min(1, 'query must not be empty'),
            type: z.string().optional(),
            limit: z.number().int().min(1).max(100).default(20)
        })
    }


    protected async run(search: NodeSearch): Promise<object> {
        const nodes = await this.memory.search(search)
        return { success: true, count: nodes.length, nodes }
    }
}
