import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const MCP_SERVER_NAME = 'mcp-memory-graphdb';
const MCP_SERVER_VERSION = '0.1.0';
const PLACEHOLDER = /\$?\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const ConfigSchema = z.object({
  database: z.string().min(1).default('memory.duckdb'),
  bootstrapInInstructions: z.boolean().optional()
}).strict();

// --- Startup config -----------------------------------------------------------
// argv[2] (the first argument of mcp.js) can be:
//   (none)          -> .var/memory.duckdb  (default)
//   "work"          -> .var/work.duckdb    (named prefix)
//   "/data/my.db"   -> direct path         (contains / or \)
//   "config.json"   -> a JSON config file  (ends with .json, see loadConfigFile)
// Without a config file the bootstrap switch comes from the environment
// variable BOOTSTRAP_IN_INSTRUCTIONS ("false" = off).

/** The startup config from the first argument of mcp.js; throws with a message that says what to fix. */
export function loadConfig(arg, env = process.env) {
  if (arg && arg.toLowerCase().endsWith('.json')) {
    return loadConfigFile(path.resolve(arg), env);
  }
  return startupConfig(databasePath(arg), bootstrapFromEnv(env));
}

// Strings may hold ${NAME} - an environment variable, as the hub passes
// ${DATA_DIR} on - and $${NAME} stays a literal ${NAME}. A relative database
// path is relative to the config file's folder. bootstrapInInstructions left
// out falls back to BOOTSTRAP_IN_INSTRUCTIONS.
/** Reads and validates a JSON config file - an error names the key and what is wrong. */
export function loadConfigFile(file, env = process.env) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read config at ${file}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error.message}`);
  }
  return parseConfig(parsed, env, path.dirname(file));
}

/** Validates a parsed config; `baseDir` is where a relative database path starts. */
export function parseConfig(raw, env, baseDir) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Config must be a JSON object');
  }
  const result = ConfigSchema.safeParse(interpolate(raw, env, 'config'));
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid config: ${issues}`);
  }
  const config = result.data;
  return startupConfig(
    path.resolve(baseDir, config.database),
    config.bootstrapInInstructions ?? bootstrapFromEnv(env)
  );
}

function startupConfig(dbPath, bootstrapInInstructions) {
  return {
    DB_PATH: dbPath,
    MCP_SERVER_NAME,
    MCP_SERVER_VERSION,
    // false -> instructions only point at the bootstrap tool
    BOOTSTRAP_IN_INSTRUCTIONS: bootstrapInInstructions
  };
}

// The database path from a non-config argument, as described above.
function databasePath(arg) {
  if (!arg) {
    return path.join(rootDir, '.var/memory.duckdb');
  }
  if (arg.includes('/') || arg.includes('\\')) {
    return path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  }
  const filename = arg.endsWith('.duckdb') ? arg : `${arg}.duckdb`;
  return path.join(rootDir, `.var/${filename}`);
}

function bootstrapFromEnv(env) {
  return env.BOOTSTRAP_IN_INSTRUCTIONS !== 'false';
}

// ${NAME} in every string of the value replaced by the environment variable.
function interpolate(value, env, where) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (match, name) => {
      if (match.startsWith('$$')) {
        return match.slice(1);
      }
      const filled = env[name];
      if (filled === undefined) {
        throw new Error(`Environment variable ${name} is not set (used in ${where})`);
      }
      return filled;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => interpolate(item, env, `${where}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolate(item, env, `${where}.${key}`)])
    );
  }
  return value;
}
