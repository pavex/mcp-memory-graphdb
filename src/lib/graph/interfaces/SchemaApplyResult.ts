import type { SchemaDiff } from './SchemaDiff'
import type { SchemaDocument } from './SchemaDocument'


/** The schema after apply() and what changed. */
export interface SchemaApplyResult {
    schema: SchemaDocument
    diff: SchemaDiff
}
