import { z } from 'zod'
import { Tool } from './Tool'


// destructiveHint: migrations rename and remove types in the database.
/** The tool apply_schema: additions, renames and removals of node and edge types. */
export class ApplySchemaTool extends Tool<{ yaml: string }> {

    protected readonly name = 'apply_schema'
    protected readonly title = 'Apply schema'
    protected readonly annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    protected readonly description = [
        'Apply schema changes to the graph database. This is a deterministic, validated process — nothing is guessed.',
        '',
        'WORKFLOW: 1) call get_schema to see the current state, 2) build the new YAML, 3) call apply_schema.',
        '',
        'ADDING a new node or edge type: include it under nodes: or edges: with a description (and optional properties for nodes). Existing types do not need to be repeated — only send what changes plus any migrations.',
        '',
        'RENAMING a node type: add a migrations entry { rename_node: { from: "old_name", to: "new_name" } }. This updates every existing node of that type in the database, then renames the schema entry. You may also redefine the new name under nodes: in the same call if its description/properties should change too.',
        '',
        'RENAMING an edge type: same pattern with { rename_edge: { from, to } }.',
        '',
        'MERGING a type into another existing type: { rename_node: { from, to, merge: true } } (or rename_edge). All rows of "from" move to "to", "to" keeps its definition, "from" disappears from the schema. Without merge: true an existing target is rejected. The source may also be a type that exists only in the data (see unknown_types in get_schema).',
        '',
        'REMOVING a node or edge type: add { remove_node: { type: "name" } } or { remove_edge: { type: "name" } }. This is REJECTED if any node/edge of that type still exists — rename it elsewhere first, or delete the individual nodes/edges, then remove the now-empty type.',
        '',
        'IMPORTANT: nodes: and edges: are PATCHES, not full replacements. Existing types you do not mention are left completely untouched — there is no need to repeat the whole schema back. The only way to rename or remove a type is an explicit migrations entry; simply omitting a type from the YAML never deletes or changes it.',
        '',
        'Example YAML body (adding one node type, renaming one edge type):',
        'migrations:',
        '  - rename_edge: { from: created_by, to: authored_by }',
        'nodes:',
        '  event:',
        '    description: "A dated occurrence or milestone"',
        '    properties:',
        '      name: string',
        '      date: string'
    ].join('\n')


    protected inputSchema() {
        return z.object({
            yaml: z.string().min(1)
                .describe('Complete new schema YAML. Server compares with current, applies changes, writes schema.yaml.')
        })
    }


    protected async run({ yaml }: { yaml: string }): Promise<object> {
        const { schema, diff } = await this.memory.applySchema(yaml)
        return {
            success: true,
            revision: schema.revision,
            added_nodes: diff.addedNodes,
            added_edges: diff.addedEdges,
            updated_nodes: diff.updatedNodes,
            updated_edges: diff.updatedEdges,
            renamed_nodes: diff.renamedNodes,
            renamed_edges: diff.renamedEdges,
            removed_nodes: diff.removedNodes,
            removed_edges: diff.removedEdges,
            total_nodes: Object.keys(schema.nodes ?? {}).length,
            total_edges: Object.keys(schema.edges ?? {}).length
        }
    }
}
