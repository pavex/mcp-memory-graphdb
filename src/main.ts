import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Application } from './Application'
import { loadConfig } from './config/Config'


// Entry point of mcp.js: node mcp.js [database | name | config.json] - see
// config/Config.ts. The folder of mcp.js holds the default schema; its parent
// is the project folder with .var/. A problem at startup stops the server
// with exit code 1 and one line on stderr that says what to fix.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url))

try {
    await Application.start(loadConfig(process.argv[2], resolve(SERVER_DIR, '..')), SERVER_DIR)
}
catch (error) {
    process.stderr.write(`ERROR: ${(error as Error).message}\n`)
    process.exit(1)
}
