import { z } from 'zod'
import { BOOTSTRAP_ID } from '../Consts'
import { Tool } from './Tool'


// The node is created and maintained by the agent; without it the answer
// says how to create one.
/** The tool bootstrap: the agent's identity, the user context and working rules. */
export class BootstrapTool extends Tool<Record<string, never>> {

    protected readonly name = 'bootstrap'
    protected readonly title = 'Bootstrap'
    protected readonly annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    protected readonly description = 'Call this at the start of every session to load your identity, the user context and working rules. Returns the _bootstrap node created and maintained by the agent.'


    protected inputSchema() {
        return z.object({})
    }


    protected async run(): Promise<object> {
        const node = await this.memory.findNode(BOOTSTRAP_ID)
        if (!node) {
            return {
                success: false,
                message: `No bootstrap node found. Create one with add_node({ id: "${BOOTSTRAP_ID}", type: "concept", properties: { ... } }) (any node type from the schema works) containing identity, user context and working rules.`
            }
        }
        return { success: true, bootstrap: node }
    }
}
