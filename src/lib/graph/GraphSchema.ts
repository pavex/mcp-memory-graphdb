import { dump, load } from 'js-yaml'
import { existsSync, readFileSync } from 'node:fs'
import type { GraphDatastore } from './GraphDatastore'
import { GraphError } from './GraphError'
import { writeFileAtomic } from './GraphSchema/AtomicFile'
import { validateSchemaChange } from './GraphSchema/SchemaValidator'
import type { EdgeTypeDefinition } from './interfaces/EdgeTypeDefinition'
import type { NodeTypeDefinition } from './interfaces/NodeTypeDefinition'
import type { SchemaApplyResult } from './interfaces/SchemaApplyResult'
import type { SchemaDocument } from './interfaces/SchemaDocument'
import type { TypeRename } from './interfaces/TypeRename'


const DUMP_OPTIONS = { lineWidth: 120, quoteStyle: 'double' } as const


// schema.yaml next to the database is the source of truth; a fresh database
// starts from the default schema (revision 0). Every change goes through
// apply(), deterministically: validate -> check migrations -> run them on
// the database -> merge -> diff -> save. Nothing is guessed: `nodes:` and
// `edges:` are patches (types not mentioned stay as they are), and the only
// way to rename or remove a type is an explicit `migrations` entry. Several
// sessions (processes) share the file, so reload() re-reads it when another
// one changed it; callers hold the database lock while they do that. The
// file is replaced atomically, so a reader without the lock (a session
// starting) sees the old schema or the new one, never a part.
/** The schema of the graph: node and edge types, and their migrations. */
export class GraphSchema {

    private schema: SchemaDocument | undefined = undefined
    // The last schema.yaml content seen or written, for reload() and restore().
    private raw: string | null = null


    constructor(readonly path: string, private defaultPath: string, private datastore: GraphDatastore) {
    }


    exists(): boolean {
        return existsSync(this.path)
    }


    /** Loads schema.yaml, or writes the default schema when there is none yet. */
    async ensure(): Promise<void> {
        if (this.exists()) {
            this.load()
        }
        else {
            await this.initDefault()
        }
    }


    /** The schema.yaml content as last seen or written, for restore(). */
    snapshot(): string | null {
        return this.raw
    }


    // apply() saves before its transaction commits, so a failed save rolls
    // the migrations back; this undoes the save when the commit fails.
    /** Writes back a snapshot when schema.yaml changed since it was taken. */
    async restore(snapshot: string | null): Promise<void> {
        if (snapshot === null || snapshot === this.raw) {
            return
        }
        await writeFileAtomic(this.path, snapshot)
        this.schema = parse(snapshot)
        this.raw = snapshot
    }


    /** Reads schema.yaml; an empty file gives undefined. */
    load(): SchemaDocument | undefined {
        const raw = readFileSync(this.path, 'utf8')
        this.schema = parse(raw)
        this.raw = raw
        return this.schema
    }


    /** Re-reads schema.yaml when another session changed it since. */
    reload(): SchemaDocument | undefined {
        if (!this.exists()) {
            return this.schema
        }
        const raw = readFileSync(this.path, 'utf8')
        if (raw !== this.raw) {
            this.schema = parse(raw)
            this.raw = raw
        }
        return this.schema
    }


    /** Writes the default schema (schema.default.yaml) as schema.yaml. */
    async initDefault(): Promise<SchemaDocument> {
        const schema = parse(readFileSync(this.defaultPath, 'utf8'))
        if (!schema) {
            throw new Error(`The default schema is empty: ${this.defaultPath}`)
        }
        await this.save(schema)
        return schema
    }


    get(): SchemaDocument | undefined {
        return this.schema
    }


    toYaml(): string {
        return dump(this.schema, DUMP_OPTIONS)
    }


    // Each step can throw and abort everything after it:
    //   1. structural validation (SchemaValidator) - unknown shapes rejected,
    //   2. pre-flight check of migrations - every `from` must exist; remove_*
    //      needs the type to have no rows (rename it first),
    //   3. migrations run against the database (rename/delete by type),
    //   4. the new node/edge maps: incoming nodes/edges patch the current ones,
    //   5. schema.yaml saved with the next revision - the only file write.
    /** Applies additions, renames and removals; returns the new schema and what changed. */
    async apply(rawIncoming: unknown): Promise<SchemaApplyResult> {
        if (!this.schema) {
            throw new GraphError('Schema not loaded.')
        }
        const incoming = validateSchemaChange(rawIncoming)
        const current = this.schema
        const migrations = incoming.migrations ?? []
        const renamedFromNodes = new Set<string>()
        const renamedFromEdges = new Set<string>()
        const removedNodes = new Set<string>()
        const removedEdges = new Set<string>()

        for (const migration of migrations) {
            if (migration.rename_node) {
                await this.checkRename('rename_node', migration.rename_node, current.nodes, incoming.nodes, type => this.datastore.countNodesByType(type))
                renamedFromNodes.add(migration.rename_node.from)
            }
            if (migration.rename_edge) {
                await this.checkRename('rename_edge', migration.rename_edge, current.edges, incoming.edges, type => this.datastore.countEdgesByType(type))
                renamedFromEdges.add(migration.rename_edge.from)
            }
            if (migration.remove_node) {
                await this.checkRemoval('remove_node', migration.remove_node.type, current.nodes, 'node', type => this.datastore.countNodesByType(type))
                removedNodes.add(migration.remove_node.type)
            }
            if (migration.remove_edge) {
                await this.checkRemoval('remove_edge', migration.remove_edge.type, current.edges, 'edge', type => this.datastore.countEdgesByType(type))
                removedEdges.add(migration.remove_edge.type)
            }
        }

        // Only after every migration passed, so a bad list never touches the
        // database. A removed type has no rows (checked above).
        for (const migration of migrations) {
            if (migration.rename_node) {
                await this.datastore.renameNodeType(migration.rename_node.from, migration.rename_node.to)
            }
            if (migration.rename_edge) {
                await this.datastore.renameEdgeType(migration.rename_edge.from, migration.rename_edge.to)
            }
        }

        const baseNodes: Record<string, NodeTypeDefinition> = { ...current.nodes }
        const baseEdges: Record<string, EdgeTypeDefinition> = { ...current.edges }
        for (const type of [...renamedFromNodes, ...removedNodes]) {
            delete baseNodes[type]
        }
        for (const type of [...renamedFromEdges, ...removedEdges]) {
            delete baseEdges[type]
        }
        // A renamed definition moves under its new name, unless incoming
        // redefines that name (incoming wins, layered below). On a merge into
        // an existing target, the target keeps its own definition.
        for (const migration of migrations) {
            if (migration.rename_node && !incoming.nodes?.[migration.rename_node.to] && !current.nodes?.[migration.rename_node.to]) {
                baseNodes[migration.rename_node.to] = current.nodes[migration.rename_node.from]
            }
            if (migration.rename_edge && !incoming.edges?.[migration.rename_edge.to] && !current.edges?.[migration.rename_edge.to]) {
                baseEdges[migration.rename_edge.to] = current.edges[migration.rename_edge.from]
            }
        }
        const nextNodes = { ...baseNodes, ...incoming.nodes }
        const nextEdges = { ...baseEdges, ...incoming.edges }

        const renamedNodes = migrations.flatMap(migration => (migration.rename_node ? [migration.rename_node] : []))
        const renamedEdges = migrations.flatMap(migration => (migration.rename_edge ? [migration.rename_edge] : []))
        const next: SchemaDocument = { revision: (current.revision ?? 0) + 1, nodes: nextNodes, edges: nextEdges }
        await this.save(next)
        return {
            schema: next,
            diff: {
                addedNodes: added(nextNodes, current.nodes, renamedFromNodes, renamedNodes),
                updatedNodes: updated(nextNodes, current.nodes),
                addedEdges: added(nextEdges, current.edges, renamedFromEdges, renamedEdges),
                updatedEdges: updated(nextEdges, current.edges),
                renamedNodes,
                renamedEdges,
                removedNodes: [...removedNodes],
                removedEdges: [...removedEdges]
            }
        }
    }


    /** Throws unless the node type is in the schema. */
    assertNodeType(type: string): void {
        if (!this.schema?.nodes?.[type]) {
            const known = Object.keys(this.schema?.nodes ?? {}).join(', ')
            throw new GraphError(`Unknown node type "${type}". Known types: ${known}. Add a new type with apply_schema first.`)
        }
    }


    /** Throws unless the edge type is in the schema. */
    assertEdgeType(type: string): void {
        if (!this.schema?.edges?.[type]) {
            const known = Object.keys(this.schema?.edges ?? {}).join(', ')
            throw new GraphError(`Unknown edge type "${type}". Known types: ${known}. Add a new type with apply_schema first.`)
        }
    }


    /** The property keys the schema declares for a node type. */
    declaredProperties(type: string): string[] {
        return Object.keys(this.schema?.nodes?.[type]?.properties ?? {})
    }


    /** The revision and every type with its description, for people. */
    summarize(): string {
        const schema = this.schema
        if (!schema) {
            return '(no schema loaded)'
        }
        const nodes = Object.entries(schema.nodes ?? {}).map(([name, type]) => `  ${name}: ${type.description}`).join('\n')
        const edges = Object.entries(schema.edges ?? {}).map(([name, type]) => `  ${name}: ${type.description}`).join('\n')
        return `Schema revision ${schema.revision}\n\nNode types:\n${nodes}\n\nEdge types:\n${edges}`
    }


    private async save(schema: SchemaDocument): Promise<void> {
        const yaml = dump(schema, DUMP_OPTIONS)
        await writeFileAtomic(this.path, yaml)
        this.schema = schema
        this.raw = yaml
    }


    // The source must be in the schema, or at least have rows (types written
    // before type validation existed can be migrated this way); an existing
    // target only with merge: true (rows move in, the target keeps its
    // definition); a source without a definition needs the new target
    // defined in the same call. A rename onto itself is refused: the type
    // would leave the schema while its rows stay.
    private async checkRename(op: string, { from, to, merge }: TypeRename, currentTypes: Record<string, unknown>, incomingTypes: Record<string, unknown> | undefined, countRows: (type: string) => Promise<number>): Promise<void> {
        if (from === to) {
            throw new GraphError(`${op}: "from" and "to" are the same type "${from}" - nothing to rename. To change its description or properties, send it under nodes:/edges: without a migration.`)
        }
        if (!currentTypes?.[from] && await countRows(from) === 0) {
            throw new GraphError(`${op}: source type "${from}" does not exist in current schema or data.`)
        }
        if (currentTypes?.[to] && !merge) {
            throw new GraphError(`${op}: target type "${to}" already exists. Add merge: true to move all "${from}" rows into it, or choose a different name.`)
        }
        if (!currentTypes?.[from] && !currentTypes?.[to] && !incomingTypes?.[to]) {
            throw new GraphError(`${op}: "${from}" has no schema definition to carry over - define "${to}" in the same call.`)
        }
    }


    private async checkRemoval(op: string, type: string, currentTypes: Record<string, unknown>, kind: string, countRows: (type: string) => Promise<number>): Promise<void> {
        if (!currentTypes?.[type]) {
            throw new GraphError(`${op}: type "${type}" does not exist in current schema.`)
        }
        const count = await countRows(type)
        if (count > 0) {
            throw new GraphError(`${op}: type "${type}" still has ${count} ${kind}(s). Use rename_${kind} to migrate them to another type first, or delete them individually.`)
        }
    }
}


// load() throws on an empty document; an empty file (written by hand, or by
// a version that did not write atomically) counts as no schema.
function parse(raw: string): SchemaDocument | undefined {
    return raw.trim() ? load(raw) as SchemaDocument : undefined
}


// New types: not in the current schema and not the target of a rename.
function added(next: Record<string, unknown>, current: Record<string, unknown>, renamedFrom: Set<string>, renames: TypeRename[]): string[] {
    const renamedTo = new Set(renames.map(rename => rename.to))
    return Object.keys(next).filter(type => !current?.[type] && !renamedFrom.has(type) && !renamedTo.has(type))
}


function updated(next: Record<string, unknown>, current: Record<string, unknown>): string[] {
    return Object.keys(next).filter(type => current?.[type] && JSON.stringify(current[type]) !== JSON.stringify(next[type]))
}
