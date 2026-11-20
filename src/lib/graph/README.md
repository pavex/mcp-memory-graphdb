# lib/graph

Persistent graph memory in one DuckDB file: nodes and edges with free-form JSON properties, typed by a schema in `schema.yaml` next to the database, with validated schema migrations, duplicate merging, a paginated review ("dreaming") and warnings for labels and property keys that resemble existing ones. It knows nothing of MCP or of the server that uses it.

Depends on Node.js built-ins, `@duckdb/node-api`, `js-yaml` (schema.yaml) and `zod` (validation of schema changes).

## API

The public API is `index.ts`: `import { GraphMemory } from './lib/graph'`. Files of the package import each other directly.

### `GraphMemory`

`new GraphMemory({ database, defaultSchemaPath, schemaPath? })` (`GraphMemoryOptions`), then `await open()`; `close()` at the end.

| Option | |
|---|---|
| `database` | the DuckDB file (its folder is created), or `":memory:"` |
| `defaultSchemaPath` | `schema.default.yaml`: what a database without `schema.yaml` starts with (revision 0) |
| `schemaPath` | `schema.yaml`; next to the database file when omitted |

Every operation is **one unit of work**: it waits for the previous one of this `GraphMemory` (one DuckDB connection is not safe for concurrent use), re-reads `schema.yaml` when another process changed it, and runs in one transaction - all its changes commit together or not at all. Across processes the database file lock serializes the same way: the file is opened only for a unit of work and closed right after, so several processes (sessions) can share one file; a file held by another process is retried for up to 10 s, then `GraphError` "Memory database is busy".

- `addNode({ id?, type, labels?, properties? })` → `{ node, warnings }`: the type must be in the schema; the id is a UUID when omitted.
- `updateNode({ id, labels?, properties?, merge_from? })` → `{ node, merge?, warnings }`: labels replace, properties merge into the existing ones. `merge_from` merges duplicates into the node: their edges are redirected to it, edges that became self-loops or exact duplicates (same type, source and target) are dropped, the duplicates are deleted (`MergeResult`).
- `deleteNode(id)`: with all its edges. `getNode(id)` (throws when missing), `findNode(id)` (null).
- `addEdge({ id?, type, source_id, target_id, properties? })`: the type must be in the schema, both nodes must exist. `deleteEdge(id)`, `listEdges({ source_id?, target_id?, type?, limit })` newest first.
- `search({ query, type?, limit })`: nodes whose properties contain the text (case-insensitive, `ILIKE`), most recently updated first.
- `schemaOverview()` → `{ revision, yaml, nodeCounts, labels, unknownTypes }`: `labels` are all labels in use with their counts, `unknownTypes` the node and edge types found in the data but not in the schema.
- `applySchema(yaml)` → `{ schema, diff }`: see `GraphSchema.apply`.
- `schemaSummary()` → `{ revision, summary }`: the types one line each, for people.
- `dreaming(limit, offset, edgeCap)` → `{ total, nodes }`: a page of all nodes ordered by type and normalized name (`name` or `title`, lowercased, without spaces, `-`, `_`, `.`), each with up to `edgeCap` edges each way (`out_more`/`in_more` count the rest) and `possible_duplicates` - other nodes of the same type with the same normalized name.

Warnings are computed before the write: a new label or property key that resembles an existing one (plural, `-`/`_` variant, short prefix or suffix, one typo - `isSimilar`) warns; a new label sharing a whole word with an existing one (`isRelated`) warns as related. Known and unrelated names do not.

Errors meant for the caller are `GraphError` with a message that says what to do; anything else (DuckDB, the disk) is a plain `Error`.

### `GraphSchema`

`schema.yaml`: `revision`, `nodes` (`description`, optional `properties` as a hint `name: type`), `edges` (`description`). `apply(change)` is deterministic: the change is validated strictly (`validateSchemaChange`), `nodes:` and `edges:` are **patches** (types not mentioned stay), and the only way to rename or remove a type is a `migrations` entry:

- `rename_node: { from, to, merge? }` / `rename_edge`: moves every row in the database; the definition moves along unless the change redefines `to`. An existing `to` needs `merge: true` (the rows move in, `to` keeps its definition). A `from` found only in the data needs `to` defined in the same change.
- `remove_node: { type }` / `remove_edge`: only for a type without rows.

Migrations run only after all of them passed their checks; then `schema.yaml` is saved with the next revision. `reload()` re-reads the file when its content changed; an empty file (another process mid-write) loads as no schema.

### `GraphDatastore`

The DuckDB layer under `GraphMemory`: tables `nodes` (`id`, `type`, `labels` - space-separated, `properties` JSON, `created_at`, `updated_at`) and `edges` (`id`, `type`, `source_id`, `target_id`, `properties`, `created_at`), created on first use; times are returned as UTC ISO strings. `withConnection(work)` and `transaction(work)` nest (the inner one joins the outer). It does not serialize concurrent calls itself - `GraphMemory` does.

### Labels and similarity

- `normalizeLabels(input)`: a string separated by spaces and/or commas, or an array → one space-separated string, spaces inside a label become `-`, duplicates (ignoring case) dropped, the first spelling kept.
- `labelWarnings(labels, existing)`, `similarNameWarnings(kind, names, existing, { related })`, `isSimilar(a, b)`, `isRelated(a, b)`.

## Example

```ts
const memory = new GraphMemory({ database: '/data/memory.duckdb', defaultSchemaPath: '/app/schema.default.yaml' })
await memory.open()
await memory.addNode({ id: 'duckdb', type: 'technology', labels: 'database embedded', properties: { name: 'DuckDB' } })
const { node, warnings } = await memory.addNode({ type: 'technology', labels: 'databases', properties: { name: 'duck-db' } })
// warnings: ['label "databases" is new - similar existing: database (1). ...']
await memory.updateNode({ id: 'duckdb', properties: { note: 'Embedded analytics' }, merge_from: [node.id] })
memory.close()
```
