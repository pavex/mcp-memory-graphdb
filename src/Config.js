import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// --- DB path resolution -------------------------------------------------------
// argv[2] can be:
//   (none)        -> .var/memory.duckdb  (default)
//   "work"        -> .var/work.duckdb    (named prefix)
//   "/data/my.db" -> direct path         (contains / or \)

const arg = process.argv[2];
let dbPath = path.join(rootDir, '.var/memory.duckdb');

if (arg) {
  if (arg.includes('/') || arg.includes('\\')) {
    dbPath = path.isAbsolute(arg)
      ? arg
      : path.resolve(process.cwd(), arg);
  } else {
    const filename = arg.endsWith('.duckdb') ? arg : `${arg}.duckdb`;
    dbPath = path.join(rootDir, `.var/${filename}`);
  }
}

export const Config = {
  DB_PATH: dbPath,
  MCP_SERVER_NAME: 'mcp-memory-graphdb',
  MCP_SERVER_VERSION: '0.1.0'
};
