import { z } from 'zod'
import type { NewNode } from '../lib/graph'
import { Tool } from './Tool'
import { labelsInput, propertiesInput } from './Tool/InputSchemas'


/** The tool add_node: a node of a type from the schema. */
export class AddNodeTool extends Tool<NewNode> {

    protected readonly name = 'add_node'
    protected readonly title = 'Add node'
    protected readonly annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    protected readonly description = 'Add a new node to the graph. The type must exist in the schema; properties are free-form. Returns the created node, plus warnings when a new label or property key resembles an existing one (likely typo or variant).'


    protected inputSchema() {
        return z.object({
            id: z.string().optional(),
            type: z.string().min(1, 'type must not be empty'),
            labels: labelsInput().default(''),
            properties: propertiesInput().default({})
        })
    }


    protected async run(input: NewNode): Promise<object> {
        const { node, warnings } = await this.memory.addNode(input)
        return this.withWarnings({ success: true, node }, warnings)
    }
}
