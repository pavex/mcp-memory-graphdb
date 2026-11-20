import type { LabelCount } from './LabelCount'


/** The schema and the vocabulary in use. */
export interface SchemaOverview {
    revision: number
    /** The schema as YAML. */
    yaml: string
    /** Nodes per type. */
    nodeCounts: Record<string, number>
    /** Every label in use, most used first. */
    labels: LabelCount[]
    /** Types present in the data but not in the schema. */
    unknownTypes: { nodes: string[], edges: string[] }
}
