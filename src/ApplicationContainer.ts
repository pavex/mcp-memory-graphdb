import { join } from 'node:path'
import type { MemoryConfig } from './config/interfaces/MemoryConfig'
import { DEFAULT_SCHEMA_FILE } from './Consts'
import { GraphMemory } from './lib/graph'
import { Logger } from './log/Logger'
import { MemoryPrompts } from './prompts/MemoryPrompts'
import { MemoryTools } from './tools/MemoryTools'


// Services live as long as the process: lazy getters (`??=`), no DI
// library. The container gets the config, the folder of mcp.js (where the
// default schema is) and, in tests, a quiet logger; the rest it makes
// itself. The memory - and with it the queue that serializes its units of
// work - is shared by every MCP connection; so are the tools and prompts.
/** The server's services, wired together. */
export class ApplicationContainer {

    private memory?: GraphMemory
    private tools?: MemoryTools
    private prompts?: MemoryPrompts


    constructor(private config: MemoryConfig, private serverDir: string, private logger = new Logger()) {
    }


    getConfig(): MemoryConfig {
        return this.config
    }


    getLogger(): Logger {
        return this.logger
    }


    getGraphMemory(): GraphMemory {
        return this.memory ??= new GraphMemory({ database: this.config.database, defaultSchemaPath: join(this.serverDir, DEFAULT_SCHEMA_FILE) })
    }


    getMemoryTools(): MemoryTools {
        return this.tools ??= new MemoryTools(this.getGraphMemory(), this.logger)
    }


    getMemoryPrompts(): MemoryPrompts {
        return this.prompts ??= new MemoryPrompts(this.getGraphMemory())
    }
}
