import { z } from 'zod'
import { Tool } from './Tool'


/** The tool get_node: one node by id. */
export class GetNodeTool extends Tool<{ id: string }> {

    protected readonly name = 'get_node'
    protected readonly title = 'Get node'
    protected readonly annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    protected readonly description = 'Fetch a single node by ID.'


    protected inputSchema() {
        return z.object({
            id: z.string().min(1)
        })
    }


    protected async run({ id }: { id: string }): Promise<object> {
        return { success: true, node: await this.memory.getNode(id) }
    }
}
