/** The validated startup config (loadConfig()): environment variables filled in, the database path absolute. */
export interface MemoryConfig {
    /** The DuckDB file; schema.yaml lives next to it. */
    database: string
    /** Put the _bootstrap node into the MCP instructions; false = they only point at the bootstrap tool. */
    bootstrapInInstructions: boolean
}
