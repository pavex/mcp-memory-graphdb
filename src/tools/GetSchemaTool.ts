import { z } from 'zod'
import { Tool } from './Tool'


// Labels used once are left out to keep the answer small; new labels are
// checked against all of them on write anyway (add_node). Types found in the
// data but not in the schema (written before type validation existed) are
// listed with how to fix them - new writes of those types are rejected.
/** The tool get_schema: the schema as YAML and the vocabulary in use. */
export class GetSchemaTool extends Tool<Record<string, never>> {

    protected readonly name = 'get_schema'
    protected readonly title = 'Get schema'
    protected readonly annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    protected readonly description = 'Return the current schema as YAML string including revision number, node types and edge types, plus the vocabulary in use: node counts per type and labels used at least twice with their counts (labels_total = all distinct labels). Always call this before apply_schema to see the exact current state.'


    protected inputSchema() {
        return z.object({})
    }


    protected async run(): Promise<object> {
        const overview = await this.memory.schemaOverview()
        const result: Record<string, unknown> = {
            success: true,
            revision: overview.revision,
            yaml: overview.yaml,
            node_counts: overview.nodeCounts,
            labels: overview.labels.filter(label => label.count >= 2),
            labels_total: overview.labels.length
        }
        const { nodes, edges } = overview.unknownTypes
        if (nodes.length || edges.length) {
            result.unknown_types = {
                nodes,
                edges,
                hint: 'These types exist in the data but not in the schema. Add them under nodes:/edges: with apply_schema, or move their rows into an existing type with a migration { rename_node: { from, to, merge: true } }.'
            }
        }
        return result
    }
}
