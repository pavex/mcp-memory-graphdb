import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TestContext } from 'node:test'
import { GraphDatastore, GraphMemory, GraphSchema, MEMORY_DATABASE } from '../../src/lib/graph'


/** schema.default.yaml of the project. */
export const DEFAULT_SCHEMA = resolve(import.meta.dirname, '..', '..', 'schema.default.yaml')


/** A new temp folder, removed after the test. */
export function tempFolder(t: TestContext, prefix = 'graphdb-test-'): string {
    const folder = mkdtempSync(join(tmpdir(), prefix))
    t.after(() => rmSync(folder, { recursive: true, force: true }))
    return folder
}


// A file database in a temp folder, so `direct` - a second datastore on the
// same file - can write what the memory would refuse (types written before
// type validation existed), as another session would.
/** An opened memory with the default schema, and a datastore on the same file. */
export async function tempMemory(t: TestContext): Promise<{ memory: GraphMemory, direct: GraphDatastore, database: string }> {
    const database = join(tempFolder(t), 'memory.duckdb')
    const memory = new GraphMemory({ database, defaultSchemaPath: DEFAULT_SCHEMA })
    await memory.open()
    const direct = new GraphDatastore(database)
    await direct.open()
    t.after(() => {
        memory.close()
        direct.close()
    })
    return { memory, direct, database }
}


/** An in-memory datastore with its tables and a schema.yaml in a temp folder, not yet written. */
export async function tempSchema(t: TestContext): Promise<{ datastore: GraphDatastore, schema: GraphSchema }> {
    const datastore = new GraphDatastore(MEMORY_DATABASE)
    await datastore.open()
    t.after(() => datastore.close())
    return { datastore, schema: new GraphSchema(join(tempFolder(t), 'schema.yaml'), DEFAULT_SCHEMA, datastore) }
}
