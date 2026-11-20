/** Name of the server in initialize. */
export const SERVER_NAME = 'mcp-memory-graphdb'

/** Version of the server in initialize. */
export const SERVER_VERSION = '0.1.0'

/** The id of the node with the agent's identity, the user context and working rules. */
export const BOOTSTRAP_ID = '_bootstrap'

/** The schema a fresh database starts with, next to mcp.js. */
export const DEFAULT_SCHEMA_FILE = 'schema.default.yaml'

/** The database when the config gives none, relative to the config file's folder. */
export const DEFAULT_DATABASE = 'memory.duckdb'

/** The folder of named databases (`work` -> .var/work.duckdb), in the project folder. */
export const DATA_FOLDER = '.var'
