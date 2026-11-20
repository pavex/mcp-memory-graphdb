import { z } from 'zod'
import { Tool } from './Tool'


// Guided graph review and cleanup: a batch of nodes ordered by type and
// normalized name (likely duplicates sit next to each other), a capped 1-hop
// view of each node's edges, and possible_duplicates on nodes whose name
// matches another node of the same type. The server decides nothing and
// changes nothing here; the answer carries the workflow for the agent.
// Merging happens through update_node(merge_from), other changes through the
// node/edge tools and, where a type itself needs renaming or removal, through
// apply_schema.
/** The tool dreaming: one page of the graph review with instructions. */
export class DreamingTool extends Tool<{ limit: number, offset: number, edge_cap: number }> {

    protected readonly name = 'dreaming'
    protected readonly title = 'Dreaming'
    protected readonly annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    protected readonly description = [
        'Get a batch of nodes (with their immediate edges) for memory cleanup and reorganization.',
        'Use this to find and merge duplicate nodes, and to spot relationships that should exist but do not.',
        'Returns nodes ordered by type and name so similar entries sit next to each other; nodes whose name matches another node of the same type carry possible_duplicates.',
        'Call again with the returned next_offset to continue through the whole graph.'
    ].join(' ')


    protected inputSchema() {
        return z.object({
            limit: z.number().int().min(1).max(10).default(10),
            offset: z.number().int().min(0).default(0),
            edge_cap: z.number().int().min(1).max(20).default(10)
        })
    }


    protected async run({ limit, offset, edge_cap }: { limit: number, offset: number, edge_cap: number }): Promise<object> {
        const { total, nodes } = await this.memory.dreaming(limit, offset, edge_cap)
        const hasMore = offset + nodes.length < total
        return {
            success: true,
            total,
            nodes,
            has_more: hasMore,
            next_offset: hasMore ? offset + limit : null,
            instructions: this.instructions(Math.floor(offset / limit) + 1, hasMore ? `Call dreaming(offset=${offset + limit}) for the next batch.` : 'This was the last batch - dreaming pass complete.')
        }
    }


    private instructions(batch: number, nextStep: string): string {
        const duplicates = [
            'Check nodes with possible_duplicates first (same type, same normalized name - may live outside this batch,',
            'get_node them), but also look for duplicates the name match cannot see (different spelling, alias, abbreviation).',
            'If nodes clearly represent the same thing, pick one to keep and read all of them. Compose the merged properties',
            'yourself: extract and reconcile the information (keep the more precise/recent value, combine complementary facts',
            'into coherent text) - do not just concatenate. Then call',
            'update_node({ id: <kept>, properties: <merged>, labels: <merged>, merge_from: [<duplicate ids>] }).',
            'The server redirects all edges of the duplicates onto the kept node, drops edges that would become exact',
            'duplicates or self-loops, and deletes the duplicates - all in one transaction.',
            'properties are merged into the kept node\'s existing ones, so send every key whose value should change.'
        ].join(' ')
        const edgesField = [
            'Each node\'s "edges" field lists up to the edge_cap most recent edges in each direction as',
            '{ direction, type, other_id, other_type }, plus out_more / in_more counts if there are more beyond',
            'the cap. Edges beyond the cap are still redirected by merge_from; before a plain delete_node, check',
            'out_more/in_more so nothing important gets silently dropped.'
        ].join(' ')
        return [
            `DREAMING WORKFLOW (Batch ${batch}):`,
            '1. REVIEW: Look at the nodes in this batch and their edges. Nodes of the same type are grouped together to make duplicates easy to compare.',
            `2. DUPLICATES: ${duplicates}`,
            '3. MISSING LINKS: If two nodes in this batch (or one in this batch and one you already know about) clearly should be connected but have no edge between them, add it with add_edge using an edge type that already exists in the schema. If no suitable edge type exists yet, propose one via apply_schema first.',
            '4. REPORT: Briefly tell the user what you found and what you changed (or propose it before acting, if the user prefers confirmation first).',
            `5. NEXT: ${nextStep}`,
            '',
            edgesField,
            '',
            'Be conservative: when unsure whether two nodes are really duplicates, leave them as-is rather than merging incorrectly - a merge cannot be undone. A name match alone is only a hint.'
        ].join('\n')
    }
}
