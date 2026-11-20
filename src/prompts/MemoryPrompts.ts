import type { McpServer } from '@modelcontextprotocol/server'
import type { GraphMemory } from '../lib/graph'
import { SETUP_DESCRIPTION, SETUP_PROMPT, setupPrompt } from './SetupPrompt'


// The one place that hands prompts to McpServer.registerPrompt. Made once
// (ApplicationContainer), added to every MCP server - one per connection.
// The schema is read in a unit of work of the memory, so it is current.
/** The prompt setup, added to an MCP server. */
export class MemoryPrompts {

    constructor(private memory: GraphMemory) {
    }


    /** Registers every prompt on the server. */
    addTo(server: McpServer): void {
        server.registerPrompt(SETUP_PROMPT, { description: SETUP_DESCRIPTION }, async () => setupPrompt(await this.memory.schemaSummary()))
    }
}
