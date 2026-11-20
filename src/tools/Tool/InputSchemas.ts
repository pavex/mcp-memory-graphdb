import { z } from 'zod'


/** Labels as add_node and update_node take them. */
export function labelsInput() {
    return z.union([z.string(), z.array(z.string())])
        .describe('Space-separated labels ("ai duckdb schema-parser") or an array. Reuse existing labels listed by get_schema.')
}


/** Free-form properties of a node or an edge. */
export function propertiesInput() {
    return z.record(z.string(), z.unknown())
}
