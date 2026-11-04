import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z }                      from 'zod';
import { GraphDatastore }         from './Datastore/GraphDatastore.js';
import { SchemaManager }          from './Schema/SchemaManager.js';
import { ToolDefinitions }        from './Tools/ToolDefinitions.js';
import { SchemaTools }            from './Tools/SchemaTool.js';
import { buildOnboardingPrompt }  from './Prompts/OnboardingPrompt.js';
import { Config }                 from './Config.js';

// --- Bootstrap ---------------------------------------------------------------
// The database file is NOT held open here - GraphDatastore opens it per tool
// call, so several sessions (processes) can share one memory file.

const repo = new GraphDatastore(Config.DB_PATH);
await repo.open();

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

// Mutex -- DuckDB connection is not safe for concurrent async operations.
// Across processes, the DuckDB file lock taken by repo.transaction() does the
// same job; each tool call is one transaction (all-or-nothing).
let queue = Promise.resolve();

// --- Server ----------------------------------------------------------------------
// serveStdio calls the factory once per connection, for whichever protocol era
// the client opens with. Everything stateful above stays shared.

const createServer = () => {
  const server = new Server(
    { name: Config.MCP_SERVER_NAME, version: Config.MCP_SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {} } }
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: allTools.map(t => ({
      name:        t.name,
      description: t.description,
      // io: 'input' - fields with .default() must stay optional for clients
      inputSchema: z.toJSONSchema(t.inputSchema, { io: 'input' })
    }))
  }));

  server.setRequestHandler('prompts/list', async () => ({
    prompts: [{ name: 'setup', description: 'Review and customize the graph memory schema.' }]
  }));

  server.setRequestHandler('prompts/get', async (req) => {
    if (req.params.name === 'setup') {
      schema.reload();
      return buildOnboardingPrompt(schema);
    }
    throw new Error(`Unknown prompt: ${req.params.name}`);
  });

  server.setRequestHandler('tools/call', async (req) => {
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
        const data = await repo.transaction(() => {
          schema.reload();
          return handler(args, context);
        });
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

  return server;
};

process.on('exit', () => {
  repo.close();
});

serveStdio(createServer);
