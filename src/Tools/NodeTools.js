import { Schemas } from '../Utils/Schemas.js';

export const NodeTools = [
  {
    name: 'add_node',
    description: 'Add a new node to the graph. Returns the created node.',
    inputSchema: Schemas.add_node,
    handler: async (args, { repo }) => {
      const data = { labels: '', properties: {}, ...args };
      const node = await repo.addNode(data);
      return { success: true, node };
    }
  },
  {
    name: 'update_node',
    description: 'Update labels and/or properties of an existing node. Properties are merged into existing ones.',
    inputSchema: Schemas.update_node,
    handler: async (args, { repo }) => {
      const node = await repo.updateNode(args);
      if (!node) {
        throw new Error(`Node not found: ${args.id}`);
      }
      return { success: true, node };
    }
  },
  {
    name: 'delete_node',
    description: 'Delete a node by ID. All edges connected to it are deleted automatically.',
    inputSchema: Schemas.delete_node,
    handler: async (args, { repo }) => {
      const existing = await repo.getNode(args.id);
      if (!existing) {
        throw new Error(`Node not found: ${args.id}`);
      }
      await repo.deleteNode(args.id);
      return { success: true, id: args.id };
    }
  },
  {
    name: 'get_node',
    description: 'Fetch a single node by ID.',
    inputSchema: Schemas.get_node,
    handler: async (args, { repo }) => {
      const node = await repo.getNode(args.id);
      if (!node) {
        throw new Error(`Node not found: ${args.id}`);
      }
      return { success: true, node };
    }
  }
];
