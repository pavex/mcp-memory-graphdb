import { Schemas } from '../Utils/Schemas.js';

export const BootstrapTool = {
  name: 'bootstrap',
  description: 'Call this at the start of every session to load your identity, the user context and working rules. Returns the _bootstrap node created and maintained by the agent.',
  inputSchema: Schemas.bootstrap,
  handler: async (_args, { repo }) => {
    const node = await repo.getNode('_bootstrap');
    if (!node) {
      return {
        success: false,
        message: 'No bootstrap node found. Create one with add_node({ id: "_bootstrap", type: "concept", properties: { ... } }) containing identity, user context and working rules.'
      };
    }
    return { success: true, bootstrap: node };
  }
};
