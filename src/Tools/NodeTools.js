import { Schemas } from '../Utils/Schemas.js';
import { labelWarnings } from '../Utils/Labels.js';
import { similarNameWarnings } from '../Utils/Similarity.js';

// Attach warnings to a result only when there are some - keeps responses lean.
const withWarnings = (result, warnings) => {
  return warnings.length ? { ...result, warnings } : result;
};

// Hints must be computed before the write, so names introduced by this call
// count as new. Only new names resembling an existing one warn (typos,
// '-'/'_' or plural variants); new unrelated names are silently accepted.
const labelHints = async (repo, labels) => {
  return labels === undefined ? [] : labelWarnings(labels, await repo.listLabels());
};

// Existing keys = keys used by nodes of this type + keys declared in the schema.
const propertyHints = async (repo, schema, type, properties) => {
  const keys = Object.keys(properties ?? {});
  if (!keys.length) {
    return [];
  }
  const existing = new Map((await repo.listPropertyKeys(type)).map((k) => [k.key, k.count]));
  for (const key of schema.declaredProperties(type)) {
    if (!existing.has(key)) {
      existing.set(key, 0);
    }
  }
  return similarNameWarnings('property', keys, [...existing].map(([name, count]) => ({ name, count })));
};

export const NodeTools = [
  {
    name: 'add_node',
    description: 'Add a new node to the graph. The type must exist in the schema; properties are free-form. Returns the created node, plus warnings when a new label or property key resembles an existing one (likely typo or variant).',
    inputSchema: Schemas.add_node,
    handler: async (args, { repo, schema }) => {
      const data = { labels: '', properties: {}, ...args };
      schema.assertNodeType(data.type);
      const hints = [
        ...await propertyHints(repo, schema, data.type, data.properties),
        ...await labelHints(repo, data.labels)
      ];
      const node = await repo.addNode(data);
      return withWarnings({ success: true, node }, hints);
    }
  },
  {
    name: 'update_node',
    description: 'Update labels and/or properties of an existing node. Properties are merged into existing ones. Returns id, type, labels and only the properties you changed (use get_node for the full node), plus warnings like add_node. With merge_from, duplicate nodes are merged into this one (see dreaming for the workflow).',
    inputSchema: Schemas.update_node,
    handler: async (args, { repo, schema }) => {
      const existing = await repo.getNode(args.id);
      if (!existing) {
        throw new Error(`Node not found: ${args.id}`);
      }

      const mergeIds = [...new Set(args.merge_from ?? [])];
      if (mergeIds.includes(args.id)) {
        throw new Error(`merge_from must not contain the kept node itself: ${args.id}`);
      }
      for (const id of mergeIds) {
        if (!await repo.getNode(id)) {
          throw new Error(`Node not found (merge_from): ${id}`);
        }
      }

      const hints = [
        ...await propertyHints(repo, schema, existing.type, args.properties),
        ...await labelHints(repo, args.labels)
      ];

      let node = existing;
      if (args.labels !== undefined || args.properties !== undefined) {
        node = await repo.updateNode(args);
      }

      // Echo only what changed - the full node can be large (long summaries)
      // and the caller already knows the rest.
      const changed = {};
      for (const key of Object.keys(args.properties ?? {})) {
        changed[key] = node.properties[key];
      }
      const result = {
        success: true,
        node: { id: node.id, type: node.type, labels: node.labels, properties: changed, updated_at: node.updated_at }
      };
      if (mergeIds.length) {
        result.merge = await repo.mergeNodes(args.id, mergeIds);
      }
      return withWarnings(result, hints);
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
