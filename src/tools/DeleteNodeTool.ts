import { z } from 'zod'
import { Tool } from './Tool'


/** The tool delete_node: a node and all its edges. */
export class DeleteNodeTool extends Tool<{ id: string }> {

    protected readonly name = 'delete_node'
    protected readonly title = 'Delete node'
    protected readonly annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    protected readonly description = 'Delete a node by ID. All edges connected to it are deleted automatically.'


    protected inputSchema() {
        return z.object({
            id: z.string().min(1)
        })
    }


    protected async run({ id }: { id: string }): Promise<object> {
        await this.memory.deleteNode(id)
        return { success: true, id }
    }
}
