import { Schemas } from '../Utils/Schemas.js';

export const EdgeTools = [
  {
    name: 'add_edge',
    description: 'Add a directed edge between two existing nodes. The type must exist in the schema. Returns the created edge.',
    inputSchema: Schemas.add_edge,
    handler: async (args, { repo, schema }) => {
      const data = { properties: {}, ...args };
      schema.assertEdgeType(data.type);
      for (const [field, id] of [['source_id', data.source_id], ['target_id', data.target_id]]) {
        if (!await repo.getNode(id)) {
          throw new Error(`Node not found (${field}): ${id}`);
        }
      }
      const edge = await repo.addEdge(data);
      return { success: true, edge };
    }
  },
  {
    name: 'delete_edge',
    description: 'Delete an edge by ID.',
    inputSchema: Schemas.delete_edge,
    handler: async (args, { repo }) => {
      const existing = await repo.getEdge(args.id);
      if (!existing) {
        throw new Error(`Edge not found: ${args.id}`);
      }
      await repo.deleteEdge(args.id);
      return { success: true, id: args.id };
    }
  },
  {
    name: 'list_edges',
    description: 'List edges. Filter by source_id, target_id and/or type.',
    inputSchema: Schemas.list_edges,
    handler: async (args, { repo }) => {
      const data = { limit: 50, ...args };
      const edges = await repo.listEdges(data);
      return { success: true, count: edges.length, edges };
    }
  }
];
