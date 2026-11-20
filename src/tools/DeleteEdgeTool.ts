import { z } from 'zod'
import { Tool } from './Tool'


/** The tool delete_edge: one edge by id. */
export class DeleteEdgeTool extends Tool<{ id: string }> {

    protected readonly name = 'delete_edge'
    protected readonly title = 'Delete edge'
    protected readonly annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    protected readonly description = 'Delete an edge by ID.'


    protected inputSchema() {
        return z.object({
            id: z.string().min(1)
        })
    }


    protected async run({ id }: { id: string }): Promise<object> {
        await this.memory.deleteEdge(id)
        return { success: true, id }
    }
}
