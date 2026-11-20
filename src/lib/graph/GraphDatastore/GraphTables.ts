import type { DuckDBConnection } from '@duckdb/node-api'


/** Creates the tables nodes and edges when they do not exist yet. */
export async function createTables(connection: DuckDBConnection): Promise<void> {
    await connection.run(`
        CREATE TABLE IF NOT EXISTS nodes (
            id VARCHAR PRIMARY KEY,
            type VARCHAR NOT NULL,
            labels VARCHAR NOT NULL DEFAULT '',
            properties JSON NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
    await connection.run(`
        CREATE TABLE IF NOT EXISTS edges (
            id VARCHAR PRIMARY KEY,
            type VARCHAR NOT NULL,
            source_id VARCHAR NOT NULL,
            target_id VARCHAR NOT NULL,
            properties JSON NOT NULL DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `)
}
