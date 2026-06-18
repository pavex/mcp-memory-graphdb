import { Schemas } from '../Utils/Schemas.js';

export const SearchTool = {
  name: 'search',
  description: 'Search nodes by text inside properties (case-insensitive). Optionally filter by node type.',
  inputSchema: Schemas.search,
  handler: async (args, { repo }) => {
    const data = { limit: 20, ...args };
    const nodes = await repo.search(data);
    return { success: true, count: nodes.length, nodes };
  }
};
