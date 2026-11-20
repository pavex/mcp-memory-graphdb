import { z } from 'zod'
import type { NewEdge } from '../lib/graph'
import { Tool } from './Tool'
import { propertiesInput } from './Tool/InputSchemas'


/** The tool add_edge: a directed edge of a type from the schema between two existing nodes. */
export class AddEdgeTool extends Tool<NewEdge> {

    protected readonly name = 'add_edge'
    protected readonly title = 'Add edge'
    protected readonly annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    protected readonly description = 'Add a directed edge between two existing nodes. The type must exist in the schema. Returns the created edge.'


    protected inputSchema() {
        return z.object({
            id: z.string().optional(),
            type: z.string().min(1, 'type must not be empty'),
            source_id: z.string().min(1),
            target_id: z.string().min(1),
            properties: propertiesInput().default({})
        })
    }


    protected async run(input: NewEdge): Promise<object> {
        return { success: true, edge: await this.memory.addEdge(input) }
    }
}
