import { Schemas } from '../Utils/Schemas.js';

// ---------------------------------------------------------------------------
// dreaming - guided graph review and cleanup.
//
// Returns a batch of nodes (ordered type, created_at - same types sit next
// to each other, making duplicates easy to spot side by side) plus a capped
// 1-hop view of each node's edges. The server makes no decisions and changes
// nothing by itself; this tool only surfaces data and instructions. All
// actual changes happen through the normal node/edge tools (add_node,
// update_node, delete_node, add_edge, delete_edge) and, where a type itself
// needs renaming/removal as part of cleanup, through apply_schema.
// ---------------------------------------------------------------------------

export const DreamingTool = {
  name: 'dreaming',
  description: [
    'Get a batch of nodes (with their immediate edges) for memory cleanup and reorganization.',
    'Use this to find and merge duplicate nodes, and to spot relationships that should exist but do not.',
    'Returns nodes ordered by type so similar entries sit next to each other.',
    'Call again with the returned next_offset to continue through the whole graph.'
  ].join(' '),
  inputSchema: Schemas.dreaming,
  handler: async (args, { repo }) => {
    const d = { limit: 10, offset: 0, edge_cap: 10, ...args };

    const total = await repo.countAllNodes();
    const nodes = await repo.dreamingPage(d.limit, d.offset);

    const enriched = [];
    for (const node of nodes) {
      const edges = await repo.getNeighborEdges(node.id, d.edge_cap);
      enriched.push({ ...node, edges });
    }

    const seenSoFar = d.offset + nodes.length;
    const has_more = seenSoFar < total;
    const batchNumber = Math.floor(d.offset / d.limit) + 1;

    const nextStep = has_more
      ? `Call dreaming(offset=${d.offset + d.limit}) for the next batch.`
      : 'This was the last batch - dreaming pass complete.';

    const duplicatesNote = [
      `If two nodes clearly represent the same thing (same identity, overlapping properties), pick one to keep.`,
      `Move its missing properties over with update_node, redirect the other node's edges onto the kept node`,
      `with add_edge, then delete_edge the old edges and delete_node the duplicate.`
    ].join(' ');

    const edgesFieldNote = [
      `Each node's "edges" field lists up to the edge_cap most recent edges in each direction as`,
      `{ direction, type, other_id, other_type }, plus out_more / in_more counts if there are more beyond`,
      `the cap. A high out_more/in_more on a node you are about to delete is a sign to double-check nothing`,
      `important gets silently dropped - redirect those edges first.`
    ].join(' ');

    const instructions = [
      `DREAMING WORKFLOW (Batch ${batchNumber}):`,
      '1. REVIEW: Look at the nodes in this batch and their edges. Nodes of the same type are grouped together to make duplicates easy to compare.',
      `2. DUPLICATES: ${duplicatesNote}`,
      '3. MISSING LINKS: If two nodes in this batch (or one in this batch and one you already know about) clearly should be connected but have no edge between them, add it with add_edge using an edge type that already exists in the schema. If no suitable edge type exists yet, propose one via apply_schema first.',
      '4. REPORT: Briefly tell the user what you found and what you changed (or propose it before acting, if the user prefers confirmation first).',
      `5. NEXT: ${nextStep}`,
      '',
      edgesFieldNote,
      '',
      'Be conservative: when unsure whether two nodes are really duplicates, leave them as-is rather than merging incorrectly. Merging is one-way in practice - only delete a node once its edges have been safely redirected.'
    ].join('\n');

    return {
      success: true,
      total,
      nodes: enriched,
      has_more,
      next_offset: has_more ? d.offset + d.limit : null,
      instructions
    };
  }
};
