import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { ApplicationContainer } from './ApplicationContainer'
import type { MemoryConfig } from './config/interfaces/MemoryConfig'
import { BOOTSTRAP_ID, SERVER_NAME, SERVER_VERSION } from './Consts'
import { buildInstructions } from './instructions/ServerInstructions'


// Boot prepares the database folder and schema.yaml, reads the bootstrap
// node for the instructions once (each session starts its own process), then
// serves MCP on stdio. The database file is not held open: the memory opens
// it per unit of work, so several sessions can share one file. A bootstrap
// read that outlives the startup timeout stays first in the memory's queue.
// serveStdio makes one McpServer per connection, for whichever protocol era
// the client speaks; all of them share the container, its memory, the tools
// and the instructions.
/** The running server: boot and serve. */
export class Application {

    private constructor(private container: ApplicationContainer, private instructions: string) {
    }


    /** Opens the memory of `config`, builds the instructions and serves stdio; `serverDir` is the folder of mcp.js. */
    static async start(config: MemoryConfig, serverDir: string): Promise<Application> {
        const container = new ApplicationContainer(config, serverDir)
        const memory = container.getGraphMemory()
        await memory.open()
        process.on('exit', () => memory.close())
        const instructions = await buildInstructions(config.bootstrapInInstructions ? memory.findNode(BOOTSTRAP_ID) : Promise.resolve(null))
        const application = new Application(container, instructions)
        application.logStartup()
        serveStdio(() => application.createServer())
        return application
    }


    /** A new MCP server with the tools, the prompt setup and the instructions. */
    createServer(): McpServer {
        const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: this.instructions })
        this.container.getMemoryTools().addTo(server)
        this.container.getMemoryPrompts().addTo(server)
        return server
    }


    // Which database and whether the bootstrap node is in the instructions.
    private logStartup(): void {
        const config = this.container.getConfig()
        this.container.getLogger().write(`${SERVER_NAME} ${SERVER_VERSION} started, database ${config.database}, bootstrap in instructions ${config.bootstrapInInstructions ? 'on' : 'off'}`)
    }
}
