import { z } from 'zod';

export const Schemas = {
  add_node: z.object({
    id: z.string().optional(),
    type: z.string().min(1, 'type must not be empty'),
    labels: z.string().default(''),
    properties: z.record(z.unknown()).default({})
  }),

  update_node: z.object({
    id: z.string().min(1),
    labels: z.string().optional(),
    properties: z.record(z.unknown()).optional()
  }).refine(
    (d) => d.labels !== undefined || d.properties !== undefined,
    { message: 'Provide at least one of: labels, properties.' }
  ),

  delete_node: z.object({
    id: z.string().min(1)
  }),

  get_node: z.object({
    id: z.string().min(1)
  }),

  add_edge: z.object({
    id: z.string().optional(),
    type: z.string().min(1, 'type must not be empty'),
    source_id: z.string().min(1),
    target_id: z.string().min(1),
    properties: z.record(z.unknown()).default({})
  }),

  delete_edge: z.object({
    id: z.string().min(1)
  }),

  list_edges: z.object({
    source_id: z.string().optional(),
    target_id: z.string().optional(),
    type: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50)
  }),

  search: z.object({
    query: z.string().min(1, 'query must not be empty'),
    type: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(20)
  }),

  get_schema: z.object({}),

  apply_schema: z.object({
    yaml: z.string().min(1)
      .describe('Complete new schema YAML. Server compares with current, applies changes, writes schema.yaml.')
  }),

  dreaming: z.object({
    limit: z.number().int().min(1).max(10).default(10),
    offset: z.number().int().min(0).default(0),
    edge_cap: z.number().int().min(1).max(20).default(10)
  })
};
