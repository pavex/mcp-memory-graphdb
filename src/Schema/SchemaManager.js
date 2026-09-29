import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dump, load } from 'js-yaml';
import { loadDefaultSchema } from './DefaultSchema.js';
import { validateIncomingSchema } from './SchemaValidator.js';

// ---------------------------------------------------------------------------
// SchemaManager - owns schema.yaml lifecycle and the deterministic apply()
// process: validate -> run migrations against the live DB -> merge -> diff -> save.
//
// Nothing is written (file or DB) unless every step succeeds. No guessing:
// every change must be explicit (either a new node/edge type, or an explicit
// migration entry telling the server exactly what to rename or remove).
//
// `nodes:` / `edges:` in the incoming payload is always a PATCH, never a
// full replacement - existing types you don't mention are left untouched.
// The only way to rename or remove a type is an explicit `migrations` entry;
// there is no other path, so nothing about intent is ever inferred from
// what's simply absent.
// ---------------------------------------------------------------------------

export class SchemaManager {
  constructor(dbPath, repo) {
    this.schemaPath = join(dirname(dbPath), 'schema.yaml');
    this.repo = repo; // GraphDatastore - needed for migrations
    this.schema = null;
    this.raw = null; // last schema.yaml content seen, for reload()
  }

  exists() {
    return existsSync(this.schemaPath);
  }

  load() {
    const raw = readFileSync(this.schemaPath, 'utf8');
    this.schema = load(raw);
    this.raw = raw;
    return this.schema;
  }

  // Another MCP server process (another session) may have applied a schema
  // change since we last looked - re-read schema.yaml if its content differs.
  // Callers run this while holding the database lock, so the check-then-apply
  // sequence is serialized across processes.
  reload() {
    if (!this.exists()) {
      return this.schema;
    }
    const raw = readFileSync(this.schemaPath, 'utf8');
    if (raw !== this.raw) {
      this.schema = load(raw);
      this.raw = raw;
    }
    return this.schema;
  }

  save(schema) {
    const yaml = dump(schema, { lineWidth: 120, quotingType: '"' });
    writeFileSync(this.schemaPath, yaml, 'utf8');
    this.schema = schema;
    this.raw = yaml;
  }

  toYaml() {
    return dump(this.schema, { lineWidth: 120, quotingType: '"' });
  }

  getDefault() {
    return loadDefaultSchema();
  }

  get() {
    return this.schema;
  }

  initDefault() {
    const schema = this.getDefault();
    this.save(schema);
    return schema;
  }

  // ---------------------------------------------------------------------------
  // apply() - the single deterministic entry point for all schema changes.
  //
  // Steps, in order, each of which can throw and abort everything before it:
  //   1. Structural validation (SchemaValidator) - reject unknown shapes.
  //   2. Pre-flight check on migrations - every `from` must currently exist;
  //      remove_* requires the type to have zero rows (use rename first).
  //   3. Execute migrations against the live DB (rename/delete by type).
  //   4. Compute the new node/edge maps: incoming nodes/edges is a PATCH, not
  //      a replacement - existing types not mentioned are kept untouched.
  //      Only an explicit migrations entry can rename or remove a type.
  //   5. Save schema.yaml with incremented revision. Only this step writes.
  // ---------------------------------------------------------------------------

  async apply(rawIncoming) {
    if (!this.schema) {
      throw new Error('Schema not loaded. Call load() or initDefault() first.');
    }

    const incoming = validateIncomingSchema(rawIncoming);
    const current = this.schema;

    const migrations = incoming.migrations ?? [];
    const renamedFromNodes = new Set();
    const renamedFromEdges = new Set();
    const removedNodes = new Set();
    const removedEdges = new Set();

    // --- Step 2: pre-flight validation of every migration entry ---------------

    for (const m of migrations) {
      if (m.rename_node) {
        await this.checkRename('rename_node', m.rename_node, current.nodes, incoming.nodes,
          (type) => this.repo.countNodesByType(type));
        renamedFromNodes.add(m.rename_node.from);
      }

      if (m.rename_edge) {
        await this.checkRename('rename_edge', m.rename_edge, current.edges, incoming.edges,
          (type) => this.repo.countEdgesByType(type));
        renamedFromEdges.add(m.rename_edge.from);
      }

      if (m.remove_node) {
        const { type } = m.remove_node;
        if (!current.nodes?.[type]) {
          throw new Error(`remove_node: type "${type}" does not exist in current schema.`);
        }
        const count = await this.repo.countNodesByType(type);
        if (count > 0) {
          throw new Error(
            `remove_node: type "${type}" still has ${count} node(s). ` +
            `Use rename_node to migrate them to another type first, or delete them individually.`
          );
        }
        removedNodes.add(type);
      }

      if (m.remove_edge) {
        const { type } = m.remove_edge;
        if (!current.edges?.[type]) {
          throw new Error(`remove_edge: type "${type}" does not exist in current schema.`);
        }
        const count = await this.repo.countEdgesByType(type);
        if (count > 0) {
          throw new Error(
            `remove_edge: type "${type}" still has ${count} edge(s). ` +
            `Use rename_edge to migrate them to another type first, or delete them individually.`
          );
        }
        removedEdges.add(type);
      }
    }

    // --- Step 3: execute migrations against the live DB ------------------------
    // Done after full pre-flight validation so a bad migration list never
    // touches the database.

    for (const m of migrations) {
      if (m.rename_node) {
        await this.repo.renameNodeType(m.rename_node.from, m.rename_node.to);
      }
      if (m.rename_edge) {
        await this.repo.renameEdgeType(m.rename_edge.from, m.rename_edge.to);
      }
      if (m.remove_node) {
        // count was already confirmed to be 0 in the pre-flight check above;
        // this delete is a no-op safety net, not the actual guard.
        await this.repo.deleteNodesByType(m.remove_node.type);
      }
      if (m.remove_edge) {
        await this.repo.deleteEdgesByType(m.remove_edge.type);
      }
    }

    // --- Step 4: compute new node/edge maps ---------------------------------------
    // `nodes:` / `edges:` in incoming is always a patch, never a full replacement.
    // Any type not mentioned is left exactly as-is. The ONLY way to remove or
    // rename a type is an explicit migrations entry - there is no other path,
    // so there is nothing to "guess" here: a key simply missing from incoming
    // is never interpreted as an intent to delete it.

    const baseNodes = { ...current.nodes };
    const baseEdges = { ...current.edges };

    for (const type of renamedFromNodes) {
      delete baseNodes[type];
    }
    for (const type of renamedFromEdges) {
      delete baseEdges[type];
    }
    for (const type of removedNodes) {
      delete baseNodes[type];
    }
    for (const type of removedEdges) {
      delete baseEdges[type];
    }

    // Carry over renamed definitions under their new name, unless incoming
    // also redefines that name explicitly (then incoming wins, layered below).
    // On merge into an existing target, the target's own definition is kept.
    for (const m of migrations) {
      if (m.rename_node && !incoming.nodes?.[m.rename_node.to] && !current.nodes?.[m.rename_node.to]) {
        baseNodes[m.rename_node.to] = current.nodes[m.rename_node.from];
      }
      if (m.rename_edge && !incoming.edges?.[m.rename_edge.to] && !current.edges?.[m.rename_edge.to]) {
        baseEdges[m.rename_edge.to] = current.edges[m.rename_edge.from];
      }
    }

    const nextNodes = { ...baseNodes, ...(incoming.nodes ?? {}) };
    const nextEdges = { ...baseEdges, ...(incoming.edges ?? {}) };

    // --- Step 5: diff + save -----------------------------------------------------

    const renamedToNodes = new Set(
      migrations.filter((m) => m.rename_node).map((m) => m.rename_node.to)
    );
    const renamedToEdges = new Set(
      migrations.filter((m) => m.rename_edge).map((m) => m.rename_edge.to)
    );

    const addedNodes = Object.keys(nextNodes).filter((k) => {
      return !current.nodes?.[k] && !renamedFromNodes.has(k) && !renamedToNodes.has(k);
    });

    const addedEdges = Object.keys(nextEdges).filter((k) => {
      return !current.edges?.[k] && !renamedFromEdges.has(k) && !renamedToEdges.has(k);
    });

    const updatedNodes = Object.keys(nextNodes).filter((k) => {
      if (!current.nodes?.[k]) {
        return false;
      }
      return JSON.stringify(current.nodes[k]) !== JSON.stringify(nextNodes[k]);
    });

    const updatedEdges = Object.keys(nextEdges).filter((k) => {
      if (!current.edges?.[k]) {
        return false;
      }
      return JSON.stringify(current.edges[k]) !== JSON.stringify(nextEdges[k]);
    });

    const renamedNodes = migrations.filter((m) => m.rename_node).map((m) => m.rename_node);
    const renamedEdges = migrations.filter((m) => m.rename_edge).map((m) => m.rename_edge);
    const removedNodeList = [...removedNodes];
    const removedEdgeList = [...removedEdges];

    const next = {
      revision: (current.revision ?? 0) + 1,
      nodes: nextNodes,
      edges: nextEdges
    };

    this.save(next);

    return {
      schema: next,
      diff: {
        addedNodes,
        updatedNodes,
        addedEdges,
        updatedEdges,
        renamedNodes,
        renamedEdges,
        removedNodes: removedNodeList,
        removedEdges: removedEdgeList
      }
    };
  }

  // Pre-flight rules for rename_node / rename_edge:
  // - source must be in the schema, or at least have rows in the DB (types
  //   written before type validation existed can be migrated this way);
  // - an existing target is only allowed with an explicit merge: true - the
  //   rows move into it and the target's definition is kept;
  // - a source that is not in the schema has no definition to carry over, so a
  //   new target must be defined in the same call.
  async checkRename(op, { from, to, merge }, currentTypes, incomingTypes, countRows) {
    if (!currentTypes?.[from] && await countRows(from) === 0) {
      throw new Error(`${op}: source type "${from}" does not exist in current schema or data.`);
    }
    if (currentTypes?.[to] && to !== from && !merge) {
      throw new Error(`${op}: target type "${to}" already exists. Add merge: true to move all "${from}" rows into it, or choose a different name.`);
    }
    if (!currentTypes?.[from] && !currentTypes?.[to] && !incomingTypes?.[to]) {
      throw new Error(`${op}: "${from}" has no schema definition to carry over - define "${to}" in the same call.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Write validation - node/edge types must exist in the schema (strict);
  // properties not declared for the node type only produce warnings, so the
  // agent can still store ad-hoc facts.
  // ---------------------------------------------------------------------------

  assertNodeType(type) {
    if (!this.schema?.nodes?.[type]) {
      const known = Object.keys(this.schema?.nodes ?? {}).join(', ');
      throw new Error(`Unknown node type "${type}". Known types: ${known}. Add a new type with apply_schema first.`);
    }
  }

  assertEdgeType(type) {
    if (!this.schema?.edges?.[type]) {
      const known = Object.keys(this.schema?.edges ?? {}).join(', ');
      throw new Error(`Unknown edge type "${type}". Known types: ${known}. Add a new type with apply_schema first.`);
    }
  }

  propertyWarnings(type, properties) {
    const declared = this.schema?.nodes?.[type]?.properties;
    if (!declared || !properties) {
      return [];
    }
    return Object.keys(properties)
      .filter((key) => !(key in declared))
      .map((key) => `property "${key}" is not declared for type "${type}"`);
  }

  summarize() {
    const s = this.schema;
    if (!s) {
      return '(no schema loaded)';
    }

    const nodes = Object.entries(s.nodes ?? {})
      .map(([k, v]) => `  ${k}: ${v.description}`)
      .join('\n');

    const edges = Object.entries(s.edges ?? {})
      .map(([k, v]) => `  ${k}: ${v.description}`)
      .join('\n');

    return `Schema revision ${s.revision}\n\nNode types:\n${nodes}\n\nEdge types:\n${edges}`;
  }
}
