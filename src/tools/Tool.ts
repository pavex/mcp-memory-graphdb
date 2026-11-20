import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server'
import type { z } from 'zod'
import { GraphError, type GraphMemory } from '../lib/graph'
import type { Logger } from '../log/Logger'
import type { ToolConfig } from './interfaces/ToolConfig'


// A tool says what it is (name, title, description, annotations, input
// schema) and does its work in run(), which returns the data for the agent;
// the answer is that data as indented JSON. It knows no server: MemoryTools
// hands getName(), getConfig() and getCallback() to McpServer.registerTool,
// which checks the input against the schema first. Every error goes to the
// agent as "Error: <message>"; one that is not a GraphError (the database,
// the disk) is a fault of the server and goes to the log in full too.
/** A tool of the server: made once, registered on every MCP server. */
export abstract class Tool<Input> {

    protected abstract readonly name: string
    protected abstract readonly title: string
    protected abstract readonly description: string
    protected abstract readonly annotations: ToolAnnotations


    constructor(protected memory: GraphMemory, protected logger: Logger) {
    }


    getName(): string {
        return this.name
    }


    getConfig(): ToolConfig {
        return { title: this.title, description: this.description, annotations: this.annotations, inputSchema: this.inputSchema() }
    }


    /** Answers a call: the data from run() as JSON, or the error; the SDK has checked the input against the schema. */
    getCallback(): (input: unknown) => Promise<CallToolResult> {
        return input => this.answer(input as Input)
    }


    /** The input schema; a method, so it can use what the constructor got. */
    protected abstract inputSchema(): z.ZodObject & z.ZodType<Input>


    /** Does the work and returns the data for the agent; throws on failure. */
    protected abstract run(input: Input): Promise<object>


    /** The result with its warnings, only when there are some - keeps responses lean. */
    protected withWarnings(result: object, warnings: string[]): object {
        return warnings.length ? { ...result, warnings } : result
    }


    private async answer(input: Input): Promise<CallToolResult> {
        try {
            return { content: [{ type: 'text', text: JSON.stringify(await this.run(input), null, 2) }] }
        }
        catch (error) {
            return this.failure(error)
        }
    }


    private failure(error: unknown): CallToolResult {
        if (!(error instanceof GraphError)) {
            this.logger.write(`${this.name} failed: ${(error as Error).stack ?? error}`)
        }
        return { content: [{ type: 'text', text: `Error: ${(error as Error).message ?? error}` }], isError: true }
    }
}
