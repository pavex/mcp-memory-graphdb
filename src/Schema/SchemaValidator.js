import { z } from 'zod';

// ---------------------------------------------------------------------------
// Strict structural validation for schema.yaml content.
// No guessing - anything that doesn't match this shape is rejected with
// a clear error before any database change happens.
// ---------------------------------------------------------------------------

const NodeTypeSchema = z.object({
  description: z.string().min(1, 'description is required'),
  properties: z.record(z.string()).optional()
}).strict();

const EdgeTypeSchema = z.object({
  description: z.string().min(1, 'description is required')
}).strict();

const RenameNodeMigration = z.object({
  rename_node: z.object({
    from: z.string().min(1),
    to: z.string().min(1)
  }).strict()
}).strict();

const RenameEdgeMigration = z.object({
  rename_edge: z.object({
    from: z.string().min(1),
    to: z.string().min(1)
  }).strict()
}).strict();

const RemoveNodeMigration = z.object({
  remove_node: z.object({
    type: z.string().min(1)
  }).strict()
}).strict();

const RemoveEdgeMigration = z.object({
  remove_edge: z.object({
    type: z.string().min(1)
  }).strict()
}).strict();

const MigrationSchema = z.union([
  RenameNodeMigration,
  RenameEdgeMigration,
  RemoveNodeMigration,
  RemoveEdgeMigration
]);

export const IncomingSchemaShape = z.object({
  // revision is accepted but ignored - the server always recomputes it
  revision: z.number().int().min(0).optional(),
  migrations: z.array(MigrationSchema).optional(),
  nodes: z.record(NodeTypeSchema).optional(),
  edges: z.record(EdgeTypeSchema).optional()
}).strict().refine(
  (d) => {
    return d.nodes !== undefined || d.edges !== undefined || d.migrations !== undefined;
  },
  { message: 'Schema must contain at least one of: nodes, edges, migrations.' }
);

// Validate and return parsed result, or throw with a clear Zod-derived message.
export function validateIncomingSchema(raw) {
  const result = IncomingSchemaShape.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid schema: ${issues}`);
  }

  return result.data;
}
