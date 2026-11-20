import type { ToolAnnotations } from '@modelcontextprotocol/server'
import type { z } from 'zod'


/** What McpServer.registerTool takes about a tool besides its name (the SDK has no name for this type). */
export interface ToolConfig {
    title: string
    description: string
    annotations: ToolAnnotations
    inputSchema: z.ZodObject
}
