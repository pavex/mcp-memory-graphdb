import { load } from 'js-yaml';
import { Schemas } from '../Utils/Schemas.js';

export const SchemaTools = [
  {
    name: 'get_schema',
    description: 'Return the current schema as YAML string including revision number, node types and edge types, plus the vocabulary in use: node counts per type and labels used at least twice with their counts (labels_total = all distinct labels). Always call this before apply_schema to see the exact current state.',
    inputSchema: Schemas.get_schema,
    handler: async (_args, { schema, repo }) => {
      const s = schema.get();
      if (!s) {
        throw new Error('Schema not loaded.');
      }
      const nodeCounts = await repo.countNodesPerType();
      const edgeCounts = await repo.countEdgesPerType();
      const allLabels = await repo.listLabels();
      // Single-use labels are left out to keep the response small; new labels
      // are checked against all of them on write anyway (see add_node).
      const result = {
        success: true,
        revision: s.revision,
        yaml: schema.toYaml(),
        node_counts: nodeCounts,
        labels: allLabels.filter((l) => l.count >= 2),
        labels_total: allLabels.length
      };

      // Types present in the data but missing from the schema (written before
      // type validation existed) - new writes of these types are rejected.
      const unknownNodes = Object.keys(nodeCounts).filter((t) => !s.nodes?.[t]);
      const unknownEdges = Object.keys(edgeCounts).filter((t) => !s.edges?.[t]);
      if (unknownNodes.length || unknownEdges.length) {
        result.unknown_types = {
          nodes: unknownNodes,
          edges: unknownEdges,
          hint: 'These types exist in the data but not in the schema. Add them under nodes:/edges: with apply_schema, or move their rows into an existing type with a migration { rename_node: { from, to, merge: true } }.'
        };
      }
      return result;
    }
  },

  {
    name: 'apply_schema',
    description: [
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
    ].join('\n'),
    inputSchema: Schemas.apply_schema,
    handler: async (args, { schema }) => {
      const input = Schemas.apply_schema.parse(args);
      const incoming = load(input.yaml);
      const result = await schema.apply(incoming);

      return {
        success: true,
        revision: result.schema.revision,
        added_nodes: result.diff.addedNodes,
        added_edges: result.diff.addedEdges,
        updated_nodes: result.diff.updatedNodes,
        updated_edges: result.diff.updatedEdges,
        renamed_nodes: result.diff.renamedNodes,
        renamed_edges: result.diff.renamedEdges,
        removed_nodes: result.diff.removedNodes,
        removed_edges: result.diff.removedEdges,
        total_nodes: Object.keys(result.schema.nodes ?? {}).length,
        total_edges: Object.keys(result.schema.edges ?? {}).length
      };
    }
  }
];
