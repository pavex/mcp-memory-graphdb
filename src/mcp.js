import { Server }                from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport }   from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema,
         GetPromptRequestSchema,
         ListPromptsRequestSchema,
         ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema }        from 'zod-to-json-schema';
import { z }                      from 'zod';
import { InstallerDatastore }     from './Datastore/InstallerDatastore.js';
import { GraphDatastore }         from './Datastore/GraphDatastore.js';
import { SchemaManager }          from './Schema/SchemaManager.js';
import { ToolDefinitions }        from './Tools/ToolDefinitions.js';
import { SchemaTools }            from './Tools/SchemaTool.js';
import { buildOnboardingPrompt }  from './Prompts/OnboardingPrompt.js';
import { Config }                 from './Config.js';

// --- Bootstrap ---------------------------------------------------------------

const repo = new GraphDatastore(Config.DB_PATH);
await repo.open();
await new InstallerDatastore().install(repo.conn);

const schema = new SchemaManager(Config.DB_PATH, repo);
if (!schema.exists()) {
  schema.initDefault();
} else {
  schema.load();
}

const context = { repo, schema };

// --- All tools -----------------------------------------------------------------

const allTools = [...ToolDefinitions, ...SchemaTools];
const handlers = new Map(allTools.map(t => [t.name, t.handler]));

// --- Server ----------------------------------------------------------------------

const server = new Server(
  { name: Config.MCP_SERVER_NAME, version: Config.MCP_SERVER_VERSION },
  { capabilities: { tools: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools.map(t => ({
    name:        t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema)
  }))
}));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: 'setup', description: 'Review and customize the graph memory schema.' }]
}));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  if (req.params.name === 'setup') {
    return buildOnboardingPrompt(schema);
  }
  throw new Error(`Unknown prompt: ${req.params.name}`);
});

// Mutex -- DuckDB connection is not safe for concurrent async operations.
let queue = Promise.resolve();

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = handlers.get(name);

  if (!handler) {
    return {
      content: [{ type: 'text', text: `Error: Unknown tool ${name}` }],
      isError: true
    };
  }

  const result = await (queue = queue.then(async () => {
    try {
      const data = await handler(args, context);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      const message = e instanceof z.ZodError
        ? `Validation Error: ${e.message}`
        : `Error: ${e.message}`;
      return {
        content: [{ type: 'text', text: message }],
        isError: true
      };
    }
  }));

  return result;
});

process.on('exit', () => {
  repo.close();
});

await server.connect(new StdioServerTransport());
