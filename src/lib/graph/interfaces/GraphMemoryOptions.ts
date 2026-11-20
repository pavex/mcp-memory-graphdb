/** Where the memory lives. */
export interface GraphMemoryOptions {
    /** The DuckDB file, or ":memory:" (tests). */
    database: string
    /** The schema a fresh database starts with (schema.default.yaml). */
    defaultSchemaPath: string
    /** schema.yaml; next to the database file when omitted. */
    schemaPath?: string
}
