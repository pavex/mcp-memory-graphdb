import { z } from 'zod'
import type { NodeUpdate } from '../lib/graph'
import { Tool } from './Tool'
import { labelsInput, propertiesInput } from './Tool/InputSchemas'


// The answer echoes only the properties sent - the full node can be large
// (long summaries) and the caller already knows the rest. destructiveHint:
// merge_from deletes the merged duplicates.
/** The tool update_node: labels, properties, and merging duplicates into the node. */
export class UpdateNodeTool extends Tool<NodeUpdate> {

    protected readonly name = 'update_node'
    protected readonly title = 'Update node'
    protected readonly annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    protected readonly description = 'Update labels and/or properties of an existing node. Properties are merged into existing ones. Returns id, type, labels and only the properties you changed (use get_node for the full node), plus warnings like add_node. With merge_from, duplicate nodes are merged into this one (see dreaming for the workflow).'


    protected inputSchema() {
        return z.object({
            id: z.string().min(1),
            labels: labelsInput().optional(),
            properties: propertiesInput().optional(),
            merge_from: z.array(z.string().min(1)).min(1).optional()
                .describe('IDs of duplicate nodes to merge into this one: their edges are redirected here and they are deleted. Send the merged properties you composed from all of them in the same call.')
        }).refine(update => update.labels !== undefined || update.properties !== undefined || update.merge_from !== undefined, {
            message: 'Provide at least one of: labels, properties, merge_from.'
        })
    }


    protected async run(input: NodeUpdate): Promise<object> {
        const { node, merge, warnings } = await this.memory.updateNode(input)
        const changed: Record<string, unknown> = {}
        for (const key of Object.keys(input.properties ?? {})) {
            changed[key] = node.properties[key]
        }
        const result: Record<string, unknown> = {
            success: true,
            node: { id: node.id, type: node.type, labels: node.labels, properties: changed, updated_at: node.updated_at }
        }
        if (merge) {
            result.merge = merge
        }
        return this.withWarnings(result, warnings)
    }
}
