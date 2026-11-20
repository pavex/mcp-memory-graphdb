import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { DATA_FOLDER, DEFAULT_DATABASE } from '../Consts'
import type { MemoryConfig } from './interfaces/MemoryConfig'


const PLACEHOLDER = /\$?\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

const ConfigSchema = z.object({
    database: z.string().min(1).default(DEFAULT_DATABASE),
    bootstrapInInstructions: z.boolean().optional()
}).strict()


// The first argument of mcp.js can be:
//   (none)          -> <project>/.var/memory.duckdb
//   "work"          -> <project>/.var/work.duckdb  (a named, separate memory)
//   "/data/my.db"   -> that path                   (contains / or \)
//   "config.json"   -> a JSON config file          (ends with .json)
// The project folder is the parent of the folder of mcp.js. Without a config
// file the bootstrap switch comes from the environment variable
// BOOTSTRAP_IN_INSTRUCTIONS ("false" = off).
/** The startup config from the first argument of mcp.js; throws with a message that says what to fix. */
export function loadConfig(arg: string | undefined, projectDir: string, env: NodeJS.ProcessEnv = process.env): MemoryConfig {
    if (arg && arg.toLowerCase().endsWith('.json')) {
        return loadConfigFile(resolve(arg), env)
    }
    return { database: databasePath(arg, projectDir), bootstrapInInstructions: bootstrapFromEnv(env) }
}


// Strings may hold ${NAME} - an environment variable, as the hub passes
// ${DATA_DIR} on - and $${NAME} stays a literal ${NAME}. A relative database
// path is relative to the config file's folder. bootstrapInInstructions left
// out falls back to BOOTSTRAP_IN_INSTRUCTIONS.
/** Reads and validates a JSON config file - an error names the key and what is wrong. */
export function loadConfigFile(file: string, env: NodeJS.ProcessEnv = process.env): MemoryConfig {
    let source: string
    try {
        source = readFileSync(file, 'utf8')
    }
    catch (error) {
        throw new Error(`Unable to read config at ${file}: ${(error as Error).message}`)
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(source)
    }
    catch (error) {
        throw new Error(`Invalid JSON in ${file}: ${(error as Error).message}`)
    }
    return parseConfig(parsed, env, dirname(file))
}


/** Validates a parsed config; `baseDir` is where a relative database path starts. */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv, baseDir: string): MemoryConfig {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Config must be a JSON object')
    }
    const result = ConfigSchema.safeParse(interpolate(raw, env, 'config'))
    if (!result.success) {
        const issues = result.error.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ')
        throw new Error(`Invalid config: ${issues}`)
    }
    return {
        database: resolve(baseDir, result.data.database),
        bootstrapInInstructions: result.data.bootstrapInInstructions ?? bootstrapFromEnv(env)
    }
}


// The database path from a non-config argument, as described at loadConfig.
function databasePath(arg: string | undefined, projectDir: string): string {
    if (!arg) {
        return join(projectDir, DATA_FOLDER, DEFAULT_DATABASE)
    }
    if (arg.includes('/') || arg.includes('\\')) {
        return isAbsolute(arg) ? arg : resolve(process.cwd(), arg)
    }
    return join(projectDir, DATA_FOLDER, arg.endsWith('.duckdb') ? arg : `${arg}.duckdb`)
}


function bootstrapFromEnv(env: NodeJS.ProcessEnv): boolean {
    return env.BOOTSTRAP_IN_INSTRUCTIONS !== 'false'
}


// ${NAME} in every string of the value replaced by the environment variable.
function interpolate(value: unknown, env: NodeJS.ProcessEnv, where: string): unknown {
    if (typeof value === 'string') {
        return value.replace(PLACEHOLDER, (match, name: string) => {
            if (match.startsWith('$$')) {
                return match.slice(1)
            }
            const filled = env[name]
            if (filled === undefined) {
                throw new Error(`Environment variable ${name} is not set (used in ${where})`)
            }
            return filled
        })
    }
    if (Array.isArray(value)) {
        return value.map((item, index) => interpolate(item, env, `${where}[${index}]`))
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, env, `${where}.${key}`)]))
    }
    return value
}
