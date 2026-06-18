import { load } from 'js-yaml';
import { Schemas } from '../Utils/Schemas.js';

export const SchemaTools = [
  {
    name: 'get_schema',
    description: 'Return the current schema as YAML string including revision number, node types and edge types. Always call this before apply_schema to see the exact current state.',
    inputSchema: Schemas.get_schema,
    handler: async (_args, { schema }) => {
      const s = schema.get();
      if (!s) {
        throw new Error('Schema not loaded.');
      }
      return {
        success: true,
        revision: s.revision,
        yaml: schema.toYaml()
      };
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
