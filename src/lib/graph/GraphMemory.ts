import { load } from 'js-yaml'
import { dirname, join } from 'node:path'
import { GraphDatastore } from './GraphDatastore'
import { GraphError } from './GraphError'
import { GraphSchema } from './GraphSchema'
import type { DreamingNode } from './interfaces/DreamingNode'
import type { DreamingPage } from './interfaces/DreamingPage'
import type { EdgeFilter } from './interfaces/EdgeFilter'
import type { GraphEdge } from './interfaces/GraphEdge'
import type { GraphMemoryOptions } from './interfaces/GraphMemoryOptions'
import type { GraphNode } from './interfaces/GraphNode'
import type { NewEdge } from './interfaces/NewEdge'
import type { NewNode } from './interfaces/NewNode'
import type { NodeSearch } from './interfaces/NodeSearch'
import type { NodeUpdate } from './interfaces/NodeUpdate'
import type { NodeUpdateResult } from './interfaces/NodeUpdateResult'
import type { NodeWriteResult } from './interfaces/NodeWriteResult'
import type { SchemaApplyResult } from './interfaces/SchemaApplyResult'
import type { SchemaOverview } from './interfaces/SchemaOverview'
import type { SchemaSummary } from './interfaces/SchemaSummary'
import { labelWarnings } from './Labels'
import { similarNameWarnings } from './Similarity'


/** The file of the schema, next to the database file. */
export const SCHEMA_FILE = 'schema.yaml'


// Every public operation is one unit of work: it waits for the previous one
// in this process (one DuckDB connection is not safe for concurrent async
// use), then runs in one transaction with schema.yaml re-read first, so a
// change another session made is seen. Across processes the database file
// lock does the same job. The operations hold the rules of the graph: types
// must exist in the schema, nodes must exist, and new labels or property keys
// resembling existing ones produce warnings. They never call each other, so
// a unit of work never waits for itself.
/** The graph memory: nodes, edges and their schema, one serialized transaction per operation. */
export class GraphMemory {

    private datastore: GraphDatastore
    private schema: GraphSchema
    private queue: Promise<unknown> = Promise.resolve()


    constructor(options: GraphMemoryOptions) {
        this.datastore = new GraphDatastore(options.database)
        this.schema = new GraphSchema(options.schemaPath ?? join(dirname(options.database), SCHEMA_FILE), options.defaultSchemaPath, this.datastore)
    }


    /** Prepares the database and loads schema.yaml, writing the default schema the first time. */
    async open(): Promise<void> {
        await this.datastore.open()
        await this.schema.ensure()
    }


    close(): void {
        this.datastore.close()
    }


    /** Adds a node of a type from the schema. */
    async addNode(node: NewNode): Promise<NodeWriteResult> {
        return this.run(async () => {
            this.schema.assertNodeType(node.type)
            if (node.id !== undefined && await this.datastore.getNode(node.id)) {
                throw new GraphError(`Node already exists: ${node.id}. Change it with update_node, or leave out id for a new node.`)
            }
            const warnings = [...await this.propertyHints(node.type, node.properties), ...await this.labelHints(node.labels)]
            return { node: await this.datastore.addNode(node), warnings }
        })
    }


    /** Replaces labels, merges properties, then merges the duplicates in merge_from into the node. */
    async updateNode(update: NodeUpdate): Promise<NodeUpdateResult> {
        return this.run(async () => {
            const existing = await this.requireNode(update.id)
            const mergeIds = [...new Set(update.merge_from ?? [])]
            if (mergeIds.includes(update.id)) {
                throw new GraphError(`merge_from must not contain the kept node itself: ${update.id}`)
            }
            for (const id of mergeIds) {
                await this.requireNode(id, 'merge_from')
            }
            const warnings = [...await this.propertyHints(existing.type, update.properties), ...await this.labelHints(update.labels)]
            let node = existing
            if (update.labels !== undefined || update.properties !== undefined) {
                node = (await this.datastore.updateNode(update))!
            }
            const merge = mergeIds.length ? await this.datastore.mergeNodes(update.id, mergeIds) : undefined
            return { node, merge, warnings }
        })
    }


    /** Deletes a node and all its edges. */
    async deleteNode(id: string): Promise<void> {
        await this.run(async () => {
            await this.requireNode(id)
            await this.datastore.deleteNode(id)
        })
    }


    /** The node; a GraphError when it does not exist. */
    async getNode(id: string): Promise<GraphNode> {
        return this.run(() => this.requireNode(id))
    }


    /** The node, or null. */
    async findNode(id: string): Promise<GraphNode | null> {
        return this.run(() => this.datastore.getNode(id))
    }


    /** Adds an edge of a type from the schema between two existing nodes. */
    async addEdge(edge: NewEdge): Promise<GraphEdge> {
        return this.run(async () => {
            this.schema.assertEdgeType(edge.type)
            await this.requireNode(edge.source_id, 'source_id')
            await this.requireNode(edge.target_id, 'target_id')
            if (edge.id !== undefined && await this.datastore.getEdge(edge.id)) {
                throw new GraphError(`Edge already exists: ${edge.id}. Leave out id for a new edge.`)
            }
            return this.datastore.addEdge(edge)
        })
    }


    async deleteEdge(id: string): Promise<void> {
        await this.run(async () => {
            if (!await this.datastore.getEdge(id)) {
                throw new GraphError(`Edge not found: ${id}`)
            }
            await this.datastore.deleteEdge(id)
        })
    }


    async listEdges(filter: EdgeFilter): Promise<GraphEdge[]> {
        return this.run(() => this.datastore.listEdges(filter))
    }


    async search(search: NodeSearch): Promise<GraphNode[]> {
        return this.run(() => this.datastore.search(search))
    }


    /** The schema as YAML, nodes per type, all labels, and types found in the data but not in the schema. */
    async schemaOverview(): Promise<SchemaOverview> {
        return this.run(async () => {
            const schema = this.schema.get()
            if (!schema) {
                throw new GraphError('Schema not loaded.')
            }
            const nodeCounts = await this.datastore.countNodesPerType()
            const edgeCounts = await this.datastore.countEdgesPerType()
            return {
                revision: schema.revision,
                yaml: this.schema.toYaml(),
                nodeCounts,
                labels: await this.datastore.listLabels(),
                unknownTypes: {
                    nodes: Object.keys(nodeCounts).filter(type => !schema.nodes?.[type]),
                    edges: Object.keys(edgeCounts).filter(type => !schema.edges?.[type])
                }
            }
        })
    }


    /** Applies a schema change given as YAML (see GraphSchema.apply). */
    async applySchema(yaml: string): Promise<SchemaApplyResult> {
        return this.run(async () => {
            let incoming: unknown
            try {
                incoming = load(yaml)
            }
            catch (error) {
                throw new GraphError((error as Error).message)
            }
            return this.schema.apply(incoming)
        })
    }


    /** The revision and the types of the schema, for people. */
    async schemaSummary(): Promise<SchemaSummary> {
        return this.run(async () => ({ revision: this.schema.get()?.revision ?? 0, summary: this.schema.summarize() }))
    }


    /** A page of the graph review: nodes with up to `edgeCap` edges each way and possible duplicates by name. */
    async dreaming(limit: number, offset: number, edgeCap: number): Promise<DreamingPage> {
        return this.run(async () => {
            const total = await this.datastore.countAllNodes()
            const page = await this.datastore.dreamingPage(limit, offset)
            const duplicates = await this.datastore.findPossibleDuplicates(page.map(node => node.id))
            const nodes: DreamingNode[] = []
            for (const node of page) {
                const item: DreamingNode = { ...node, edges: await this.datastore.getNeighborEdges(node.id, edgeCap) }
                if (duplicates[node.id]) {
                    item.possible_duplicates = duplicates[node.id]
                }
                nodes.push(item)
            }
            return { total, nodes }
        })
    }


    // Queued after the previous unit of work, which may have failed. The
    // connection (and with it the file lock) is held around the transaction,
    // so schema.yaml is read, and restored when the transaction fails after
    // apply_schema saved it, while no other session can touch either.
    private run<T>(work: () => Promise<T>): Promise<T> {
        const result = this.queue.then(() => this.datastore.withConnection(async () => {
            this.schema.reload()
            const snapshot = this.schema.snapshot()
            try {
                return await this.datastore.transaction(work)
            }
            catch (error) {
                await this.schema.restore(snapshot).catch(restoreError => {
                    throw new Error(`${(error as Error).message}; schema.yaml could not be restored: ${(restoreError as Error).message}`)
                })
                throw error
            }
        }))
        this.queue = result.catch(() => undefined)
        return result
    }


    private async requireNode(id: string, field?: string): Promise<GraphNode> {
        const node = await this.datastore.getNode(id)
        if (!node) {
            throw new GraphError(field ? `Node not found (${field}): ${id}` : `Node not found: ${id}`)
        }
        return node
    }


    // Computed before the write, so names introduced by this call count as
    // new. Only new labels resembling an existing one warn (typos, '-'/'_' or
    // plural variants); new unrelated labels are accepted silently.
    private async labelHints(labels: string | string[] | undefined): Promise<string[]> {
        return labels === undefined ? [] : labelWarnings(labels, await this.datastore.listLabels())
    }


    // Existing keys: those used by nodes of the type and those the schema declares.
    private async propertyHints(type: string, properties: Record<string, unknown> | undefined): Promise<string[]> {
        const keys = Object.keys(properties ?? {})
        if (!keys.length) {
            return []
        }
        const existing = new Map((await this.datastore.listPropertyKeys(type)).map(entry => [entry.key, entry.count]))
        for (const key of this.schema.declaredProperties(type)) {
            if (!existing.has(key)) {
                existing.set(key, 0)
            }
        }
        return similarNameWarnings('property', keys, [...existing].map(([name, count]) => ({ name, count })))
    }
}
