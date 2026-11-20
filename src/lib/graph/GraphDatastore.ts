import { DuckDBConnection, DuckDBInstance, type DuckDBListValue, type DuckDBValue } from '@duckdb/node-api'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createTables } from './GraphDatastore/GraphTables'
import { GraphError } from './GraphError'
import type { EdgeFilter } from './interfaces/EdgeFilter'
import type { GraphEdge } from './interfaces/GraphEdge'
import type { GraphNode } from './interfaces/GraphNode'
import type { KeyCount } from './interfaces/KeyCount'
import type { LabelCount } from './interfaces/LabelCount'
import type { MergeResult } from './interfaces/MergeResult'
import type { NeighborEdge } from './interfaces/NeighborEdge'
import type { NeighborEdges } from './interfaces/NeighborEdges'
import type { NodeSearch } from './interfaces/NodeSearch'
import { normalizeLabels } from './Labels'
import { EdgeDirection } from './types/EdgeDirection'


/** The database that is never closed between units of work (tests). */
export const MEMORY_DATABASE = ':memory:'

const LOCK_TIMEOUT_MS = 10_000
const LOCK_RETRY_MIN_MS = 20
const LOCK_RETRY_MAX_MS = 500
const LOCK_ERROR = /being used by another process|could not set lock|conflicting lock|already open/i
const CREATED = 'strftime(created_at::TIMESTAMP, \'%Y-%m-%dT%H:%M:%SZ\')'
const UPDATED = 'strftime(updated_at::TIMESTAMP, \'%Y-%m-%dT%H:%M:%SZ\')'
const NODE_COLUMNS = `id, type, labels, properties, ${CREATED} AS created_at, ${UPDATED} AS updated_at`
const EDGE_COLUMNS = `id, type, source_id, target_id, properties, ${CREATED} AS created_at`
// Node name/title, lowercased, with whitespace, '-', '_' and '.' removed -
// a cheap key for spotting duplicates like "DuckDB" / "duck-db" / "Duck DB".
const NORMALIZED_NAME = 'lower(regexp_replace(coalesce(json_extract_string(properties, \'$.name\'), json_extract_string(properties, \'$.title\'), \'\'), \'[\\s_.-]+\', \'\', \'g\'))'


// DuckDB lets only one process hold a database file open at a time, and
// every session starts its own MCP server process. So a file database is
// opened only for one unit of work (withConnection / transaction) and closed
// right after, which releases the file lock; when another process holds the
// lock, opening is retried with backoff until LOCK_TIMEOUT_MS. Nested units
// of work reuse the outer connection, so one tool call opens the file once.
// ':memory:' keeps one instance open - closing it would discard the data.
// Concurrent units of work in one process are not supported: the caller
// serializes them (GraphMemory).
/** Nodes and edges in DuckDB: CRUD, search, vocabulary and the primitives of schema migrations. */
export class GraphDatastore {

    private instance: DuckDBInstance | null = null
    private connection: DuckDBConnection | null = null
    private depth = 0
    private inTransaction = false
    private tablesReady = false
    private keepOpen: boolean


    constructor(private path: string) {
        this.keepOpen = path === MEMORY_DATABASE
    }


    /** Prepares the folder of a database file (the file opens per unit of work), or opens ':memory:' with its tables. */
    async open(): Promise<void> {
        if (this.keepOpen) {
            this.instance = await DuckDBInstance.create(this.path)
            this.connection = await this.instance.connect()
            await createTables(this.connection)
            this.tablesReady = true
            return
        }
        const folder = dirname(this.path)
        if (!existsSync(folder)) {
            mkdirSync(folder, { recursive: true })
        }
    }


    close(): void {
        this.release()
    }


    /** Runs `work` with an open connection; nested calls reuse the outer one. */
    async withConnection<T>(work: () => Promise<T>): Promise<T> {
        if (this.connection && (this.keepOpen || this.depth > 0)) {
            this.depth++
            try {
                return await work()
            }
            finally {
                this.depth--
            }
        }
        await this.acquire()
        this.depth++
        try {
            if (!this.tablesReady) {
                await createTables(this.db())
                this.tablesReady = true
            }
            return await work()
        }
        finally {
            this.depth--
            if (this.depth === 0 && !this.keepOpen) {
                this.release()
            }
        }
    }


    /** Runs `work` in one transaction - all changes commit together or not at all; nested calls join the outer one. */
    async transaction<T>(work: () => Promise<T>): Promise<T> {
        return this.withConnection(async () => {
            if (this.inTransaction) {
                return work()
            }
            await this.db().run('BEGIN TRANSACTION')
            this.inTransaction = true
            try {
                const result = await work()
                await this.db().run('COMMIT')
                return result
            }
            catch (error) {
                await this.db().run('ROLLBACK').catch(() => undefined)
                throw error
            }
            finally {
                this.inTransaction = false
            }
        })
    }


    /** Inserts a node with normalized labels; returns it as stored. */
    async addNode({ id, type, labels, properties }: { id?: string, type: string, labels?: string | string[], properties?: Record<string, unknown> }): Promise<GraphNode> {
        const nodeId = id ?? crypto.randomUUID()
        await this.run('INSERT INTO nodes (id, type, labels, properties) VALUES ($1, $2, $3, $4::json)', [nodeId, type, normalizeLabels(labels), JSON.stringify(properties ?? {})])
        return (await this.getNode(nodeId))!
    }


    /** Replaces the labels and merges the properties given; null when the node does not exist. */
    async updateNode({ id, labels, properties }: { id: string, labels?: string | string[], properties?: Record<string, unknown> }): Promise<GraphNode | null> {
        const node = await this.getNode(id)
        if (!node) {
            return null
        }
        const merged = properties !== undefined ? { ...node.properties, ...properties } : node.properties
        const newLabels = labels !== undefined ? normalizeLabels(labels) : node.labels
        await this.run('UPDATE nodes SET labels = $1, properties = $2::json, updated_at = now() WHERE id = $3', [newLabels, JSON.stringify(merged), id])
        return this.getNode(id)
    }


    /** Deletes a node and every edge connected to it. */
    async deleteNode(id: string): Promise<void> {
        await this.transaction(async () => {
            await this.run('DELETE FROM edges WHERE source_id = $1 OR target_id = $1', [id])
            await this.run('DELETE FROM nodes WHERE id = $1', [id])
        })
    }


    // Only edges that were actually redirected are ever dropped. The caller
    // composes the kept node's properties - this is the mechanical part.
    /** Merges duplicates into keepId: redirects their edges, drops edges that became self-loops or exact duplicates, deletes the duplicates. */
    async mergeNodes(keepId: string, mergeIds: string[]): Promise<MergeResult> {
        return this.transaction(async () => {
            const ids = placeholders(mergeIds)
            const afterKeep = placeholders(mergeIds, 2)
            const moved = await this.all<{ id: string }>(`SELECT id FROM edges WHERE source_id IN (${ids}) OR target_id IN (${ids})`, mergeIds)
            await this.run(`UPDATE edges SET source_id = $1 WHERE source_id IN (${afterKeep})`, [keepId, ...mergeIds])
            await this.run(`UPDATE edges SET target_id = $1 WHERE target_id IN (${afterKeep})`, [keepId, ...mergeIds])

            let droppedSelfLoops = 0
            let droppedDuplicates = 0
            if (moved.length) {
                const movedIds = moved.map(row => row.id)
                const movedList = placeholders(movedIds)
                const loops = await this.all<{ id: string }>(`SELECT id FROM edges WHERE id IN (${movedList}) AND source_id = target_id`, movedIds)
                await this.deleteEdges(loops.map(row => row.id))
                droppedSelfLoops = loops.length

                // A redirected edge is a duplicate if another edge with the
                // same (type, source, target) exists that is either not
                // redirected, or redirected but older - so exactly one copy
                // survives.
                const duplicates = await this.all<{ id: string }>(`
                    SELECT e.id
                    FROM edges e
                    WHERE e.id IN (${movedList})
                        AND EXISTS (
                            SELECT 1 FROM edges o
                            WHERE o.id <> e.id
                                AND o.type = e.type AND o.source_id = e.source_id AND o.target_id = e.target_id
                                AND (o.id NOT IN (${movedList}) OR o.created_at < e.created_at OR (o.created_at = e.created_at AND o.id < e.id))
                        )`, movedIds)
                await this.deleteEdges(duplicates.map(row => row.id))
                droppedDuplicates = duplicates.length
            }
            await this.run(`DELETE FROM nodes WHERE id IN (${ids})`, mergeIds)
            return {
                merged_ids: mergeIds,
                redirected_edges: moved.length - droppedSelfLoops - droppedDuplicates,
                dropped_duplicate_edges: droppedDuplicates,
                dropped_self_loops: droppedSelfLoops
            }
        })
    }


    async getNode(id: string): Promise<GraphNode | null> {
        return this.get<GraphNode>(`SELECT ${NODE_COLUMNS} FROM nodes WHERE id = $1`, [id])
    }


    /** Inserts an edge; returns it as stored. */
    async addEdge({ id, type, source_id, target_id, properties }: { id?: string, type: string, source_id: string, target_id: string, properties?: Record<string, unknown> }): Promise<GraphEdge> {
        const edgeId = id ?? crypto.randomUUID()
        await this.run('INSERT INTO edges (id, type, source_id, target_id, properties) VALUES ($1, $2, $3, $4, $5::json)', [edgeId, type, source_id, target_id, JSON.stringify(properties ?? {})])
        return (await this.getEdge(edgeId))!
    }


    async deleteEdge(id: string): Promise<void> {
        await this.run('DELETE FROM edges WHERE id = $1', [id])
    }


    async getEdge(id: string): Promise<GraphEdge | null> {
        return this.get<GraphEdge>(`SELECT ${EDGE_COLUMNS} FROM edges WHERE id = $1`, [id])
    }


    /** Edges matching every filter given, newest first. */
    async listEdges({ source_id, target_id, type, limit }: EdgeFilter): Promise<GraphEdge[]> {
        const conditions: string[] = []
        const params: DuckDBValue[] = []
        for (const [column, value] of [['source_id', source_id], ['target_id', target_id], ['type', type]]) {
            if (value) {
                params.push(value)
                conditions.push(`${column} = $${params.length}`)
            }
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
        params.push(limit)
        return this.all<GraphEdge>(`SELECT ${EDGE_COLUMNS} FROM edges ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params)
    }


    /** Nodes whose properties contain the query (case-insensitive), most recently updated first. */
    async search({ query, type, limit }: NodeSearch): Promise<GraphNode[]> {
        const params: DuckDBValue[] = [`%${query}%`]
        let sql = `SELECT ${NODE_COLUMNS} FROM nodes WHERE properties::text ILIKE $1`
        if (type) {
            params.push(type)
            sql += ` AND type = $${params.length}`
        }
        params.push(limit)
        return this.all<GraphNode>(`${sql} ORDER BY updated_at DESC LIMIT $${params.length}`, params)
    }


    /** Every label in use with the number of nodes carrying it, most used first. */
    async listLabels(): Promise<LabelCount[]> {
        const rows = await this.all<{ label: string, n: bigint }>(`
            SELECT l AS label, count(*) AS n
            FROM nodes, unnest(regexp_split_to_array(labels, '[\\s,]+')) AS t(l)
            WHERE l <> ''
            GROUP BY 1
            ORDER BY n DESC, label`)
        return rows.map(row => ({ label: row.label, count: Number(row.n) }))
    }


    /** Property keys used by nodes of a type, with how many nodes use each. */
    async listPropertyKeys(type: string): Promise<KeyCount[]> {
        const rows = await this.all<{ key: string, n: bigint }>('SELECT k AS key, count(*) AS n FROM nodes, unnest(json_keys(properties)) AS t(k) WHERE type = $1 GROUP BY 1', [type])
        return rows.map(row => ({ key: row.key, count: Number(row.n) }))
    }


    async countNodesPerType(): Promise<Record<string, number>> {
        return this.countPerType('nodes')
    }


    async countEdgesPerType(): Promise<Record<string, number>> {
        return this.countPerType('edges')
    }


    async countNodesByType(type: string): Promise<number> {
        return this.count('SELECT count(*) AS n FROM nodes WHERE type = $1', [type])
    }


    async countEdgesByType(type: string): Promise<number> {
        return this.count('SELECT count(*) AS n FROM edges WHERE type = $1', [type])
    }


    async countAllNodes(): Promise<number> {
        return this.count('SELECT count(*) AS n FROM nodes')
    }


    async renameNodeType(from: string, to: string): Promise<void> {
        await this.run('UPDATE nodes SET type = $1, updated_at = now() WHERE type = $2', [to, from])
    }


    async renameEdgeType(from: string, to: string): Promise<void> {
        await this.run('UPDATE edges SET type = $1 WHERE type = $2', [to, from])
    }


    // Nodes of the same type sit next to each other and, within a type, the
    // same normalized name ("DuckDB", "duckdb", "Duck DB") - likely
    // duplicates land in the same batch.
    /** A page of all nodes for the graph review, ordered by type and normalized name. */
    async dreamingPage(limit: number, offset: number): Promise<GraphNode[]> {
        return this.all<GraphNode>(`SELECT ${NODE_COLUMNS} FROM nodes ORDER BY type, ${NORMALIZED_NAME}, created_at, id LIMIT $1 OFFSET $2`, [limit, offset])
    }


    /** For each given id: other nodes of the same type with the same normalized name or title - only ids with hits. */
    async findPossibleDuplicates(ids: string[]): Promise<Record<string, string[]>> {
        if (!ids.length) {
            return {}
        }
        const rows = await this.all<{ id: string, dup_ids: DuckDBListValue }>(`
            WITH n AS (SELECT id, type, ${NORMALIZED_NAME} AS k FROM nodes)
            SELECT a.id, list(b.id ORDER BY b.id) AS dup_ids
            FROM n a
            JOIN n b ON b.type = a.type AND b.k = a.k AND b.id <> a.id
            WHERE a.id IN (${placeholders(ids)}) AND a.k <> ''
            GROUP BY a.id`, ids)
        return Object.fromEntries(rows.map(row => [row.id, row.dup_ids.items.map(String)]))
    }


    /** Up to `cap` outgoing and `cap` incoming edges of a node, and how many more there are in each direction. */
    async getNeighborEdges(nodeId: string, cap: number): Promise<NeighborEdges> {
        const out = await this.neighbors(nodeId, cap, EdgeDirection.Out)
        const incoming = await this.neighbors(nodeId, cap, EdgeDirection.In)
        const outTotal = await this.count('SELECT count(*) AS n FROM edges WHERE source_id = $1', [nodeId])
        const inTotal = await this.count('SELECT count(*) AS n FROM edges WHERE target_id = $1', [nodeId])
        return {
            out,
            in: incoming,
            out_more: Math.max(0, outTotal - out.length),
            in_more: Math.max(0, inTotal - incoming.length)
        }
    }


    private async neighbors(nodeId: string, cap: number, direction: EdgeDirection): Promise<NeighborEdge[]> {
        const [own, other] = direction === EdgeDirection.Out ? ['source_id', 'target_id'] : ['target_id', 'source_id']
        const rows = await this.all<{ edge_type: string, other_id: string, other_type: string }>(`
            SELECT e.type AS edge_type, n.id AS other_id, n.type AS other_type
            FROM edges e
            JOIN nodes n ON n.id = e.${other}
            WHERE e.${own} = $1
            ORDER BY e.created_at
            LIMIT $2`, [nodeId, cap])
        return rows.map(row => ({ direction, type: row.edge_type, other_id: row.other_id, other_type: row.other_type }))
    }


    private async countPerType(table: 'nodes' | 'edges'): Promise<Record<string, number>> {
        const rows = await this.all<{ type: string, n: bigint }>(`SELECT type, count(*) AS n FROM ${table} GROUP BY type ORDER BY type`)
        return Object.fromEntries(rows.map(row => [row.type, Number(row.n)]))
    }


    private async deleteEdges(ids: string[]): Promise<void> {
        if (ids.length) {
            await this.run(`DELETE FROM edges WHERE id IN (${placeholders(ids)})`, ids)
        }
    }


    private async acquire(): Promise<void> {
        const deadline = Date.now() + LOCK_TIMEOUT_MS
        let delay = LOCK_RETRY_MIN_MS
        for (; ;) {
            try {
                this.instance = await DuckDBInstance.create(this.path)
                this.connection = await this.instance.connect()
                return
            }
            catch (error) {
                this.release()
                const locked = LOCK_ERROR.test((error as Error)?.message ?? '')
                if (locked && Date.now() + delay <= deadline) {
                    await sleep(delay + Math.random() * delay)
                    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
                    continue
                }
                if (locked) {
                    throw new GraphError(`Memory database is busy - another session kept it locked for more than ${LOCK_TIMEOUT_MS / 1000}s. Try again in a moment. (${this.path})`)
                }
                throw error
            }
        }
    }


    private release(): void {
        try {
            this.connection?.closeSync()
        }
        catch {
            // already closed
        }
        try {
            this.instance?.closeSync()
        }
        catch {
            // already closed
        }
        this.connection = null
        this.instance = null
    }


    private db(): DuckDBConnection {
        if (!this.connection) {
            throw new Error('GraphDatastore: no open connection')
        }
        return this.connection
    }


    private async run(sql: string, params: DuckDBValue[] = []): Promise<void> {
        await this.withConnection(() => this.db().run(sql, params))
    }


    private async all<T>(sql: string, params: DuckDBValue[] = []): Promise<T[]> {
        return this.withConnection(async () => {
            const reader = await this.db().runAndReadAll(sql, params)
            return reader.getRowObjects().map(row => parseProperties(row) as T)
        })
    }


    private async get<T>(sql: string, params: DuckDBValue[] = []): Promise<T | null> {
        return (await this.all<T>(sql, params))[0] ?? null
    }


    private async count(sql: string, params: DuckDBValue[] = []): Promise<number> {
        const row = await this.get<{ n: bigint }>(sql, params)
        return Number(row?.n ?? 0)
    }
}


// $1, $2, ... for a list of values, numbered from `first`.
function placeholders(values: unknown[], first = 1): string {
    return values.map((_, index) => `$${index + first}`).join(', ')
}


// The JSON column comes back as text.
function parseProperties(row: Record<string, unknown>): Record<string, unknown> {
    if (typeof row.properties === 'string') {
        try {
            row.properties = JSON.parse(row.properties)
        }
        catch {
            // kept as text
        }
    }
    return row
}


function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
