import { Schemas } from '../Utils/Schemas.js';

// Attach warnings to a result only when there are some - keeps responses lean.
const withWarnings = (result, warnings) => {
  return warnings.length ? { ...result, warnings } : result;
};

export const NodeTools = [
  {
    name: 'add_node',
    description: 'Add a new node to the graph. The type must exist in the schema. Returns the created node (plus warnings for properties not declared in the schema).',
    inputSchema: Schemas.add_node,
    handler: async (args, { repo, schema }) => {
      const data = { labels: '', properties: {}, ...args };
      schema.assertNodeType(data.type);
      const node = await repo.addNode(data);
      return withWarnings({ success: true, node }, schema.propertyWarnings(data.type, data.properties));
    }
  },
  {
    name: 'update_node',
    description: 'Update labels and/or properties of an existing node. Properties are merged into existing ones.',
    inputSchema: Schemas.update_node,
    handler: async (args, { repo, schema }) => {
      const node = await repo.updateNode(args);
      if (!node) {
        throw new Error(`Node not found: ${args.id}`);
      }
      return withWarnings({ success: true, node }, schema.propertyWarnings(node.type, args.properties));
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
