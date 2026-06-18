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
  }

  exists() {
    return existsSync(this.schemaPath);
  }

  load() {
    const raw = readFileSync(this.schemaPath, 'utf8');
    this.schema = load(raw);
    return this.schema;
  }

  save(schema) {
    const yaml = dump(schema, { lineWidth: 120, quotingType: '"' });
    writeFileSync(this.schemaPath, yaml, 'utf8');
    this.schema = schema;
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
        const { from, to } = m.rename_node;
        if (!current.nodes?.[from]) {
          throw new Error(`rename_node: source type "${from}" does not exist in current schema.`);
        }
        if (current.nodes?.[to] && to !== from) {
          throw new Error(`rename_node: target type "${to}" already exists. Choose a different name or remove it first.`);
        }
        renamedFromNodes.add(from);
      }

      if (m.rename_edge) {
        const { from, to } = m.rename_edge;
        if (!current.edges?.[from]) {
          throw new Error(`rename_edge: source type "${from}" does not exist in current schema.`);
        }
        if (current.edges?.[to] && to !== from) {
          throw new Error(`rename_edge: target type "${to}" already exists. Choose a different name or remove it first.`);
        }
        renamedFromEdges.add(from);
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
    for (const m of migrations) {
      if (m.rename_node && !incoming.nodes?.[m.rename_node.to]) {
        baseNodes[m.rename_node.to] = current.nodes[m.rename_node.from];
      }
      if (m.rename_edge && !incoming.edges?.[m.rename_edge.to]) {
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
