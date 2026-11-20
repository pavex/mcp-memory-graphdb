import type { McpServer } from '@modelcontextprotocol/server'
import type { GraphMemory } from '../lib/graph'
import type { Logger } from '../log/Logger'
import { AddEdgeTool } from './AddEdgeTool'
import { AddNodeTool } from './AddNodeTool'
import { ApplySchemaTool } from './ApplySchemaTool'
import { BootstrapTool } from './BootstrapTool'
import { DeleteEdgeTool } from './DeleteEdgeTool'
import { DeleteNodeTool } from './DeleteNodeTool'
import { DreamingTool } from './DreamingTool'
import { GetNodeTool } from './GetNodeTool'
import { GetSchemaTool } from './GetSchemaTool'
import { ListEdgesTool } from './ListEdgesTool'
import { SearchTool } from './SearchTool'
import type { Tool } from './Tool'
import { UpdateNodeTool } from './UpdateNodeTool'


// The one place that knows which tools there are and hands each to
// McpServer.registerTool; the tools themselves know no server. Made once
// (ApplicationContainer), added to every MCP server - one per connection.
// The order is the order of tools/list.
/** The twelve tools of the graph memory, added to an MCP server. */
export class MemoryTools {

    private tools: Tool<unknown>[]


    constructor(memory: GraphMemory, logger: Logger) {
        this.tools = [
            new AddNodeTool(memory, logger),
            new UpdateNodeTool(memory, logger),
            new DeleteNodeTool(memory, logger),
            new GetNodeTool(memory, logger),
            new AddEdgeTool(memory, logger),
            new DeleteEdgeTool(memory, logger),
            new ListEdgesTool(memory, logger),
            new SearchTool(memory, logger),
            new DreamingTool(memory, logger),
            new BootstrapTool(memory, logger),
            new GetSchemaTool(memory, logger),
            new ApplySchemaTool(memory, logger)
        ]
    }


    /** Registers every tool on the server. */
    addTo(server: McpServer): void {
        for (const tool of this.tools) {
            server.registerTool(tool.getName(), tool.getConfig(), tool.getCallback())
        }
    }
}
