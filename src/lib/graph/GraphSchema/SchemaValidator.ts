import { z } from 'zod'
import { GraphError } from '../GraphError'
import type { SchemaChange } from '../interfaces/SchemaChange'


const NodeTypeSchema = z.object({
    description: z.string().min(1, 'description is required'),
    properties: z.record(z.string(), z.string()).optional()
}).strict()

const EdgeTypeSchema = z.object({
    description: z.string().min(1, 'description is required')
}).strict()

// merge: true allows renaming into a type that already exists (rows move into it).
const TypeRenameSchema = z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    merge: z.boolean().optional()
}).strict()

const TypeRemovalSchema = z.object({
    type: z.string().min(1)
}).strict()

const MigrationSchema = z.union([
    z.object({ rename_node: TypeRenameSchema }).strict(),
    z.object({ rename_edge: TypeRenameSchema }).strict(),
    z.object({ remove_node: TypeRemovalSchema }).strict(),
    z.object({ remove_edge: TypeRemovalSchema }).strict()
])

const SchemaChangeSchema = z.object({
    revision: z.number().int().min(0).optional(),
    migrations: z.array(MigrationSchema).optional(),
    nodes: z.record(z.string(), NodeTypeSchema).optional(),
    edges: z.record(z.string(), EdgeTypeSchema).optional()
}).strict().refine(change => change.nodes !== undefined || change.edges !== undefined || change.migrations !== undefined, {
    message: 'Schema must contain at least one of: nodes, edges, migrations.'
})


// No guessing: anything that does not match this shape is rejected with a
// clear error before any database change happens.
/** The payload of apply() checked strictly; throws a GraphError listing every problem. */
export function validateSchemaChange(raw: unknown): SchemaChange {
    const result = SchemaChangeSchema.safeParse(raw)
    if (!result.success) {
        const issues = result.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
        throw new GraphError(`Invalid schema: ${issues}`)
    }
    return result.data
}
