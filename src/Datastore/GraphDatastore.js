import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { InstallerDatastore } from './InstallerDatastore.js';
import { normalizeLabels } from '../Utils/Labels.js';

// ---------------------------------------------------------------------------
// Connection model
//
// DuckDB allows only one process to hold a database file open at a time.
// Every Claude session spawns its own MCP server process, so keeping the file
// open for the lifetime of the process locks out every other session.
//
// Instead, a file-backed datastore opens the database only for the duration
// of one unit of work (withConnection / transaction) and closes the instance
// right after, releasing the file lock. If another process currently holds
// the lock, opening is retried with backoff until LOCK_TIMEOUT_MS.
//
// ':memory:' databases (tests) keep one persistent instance - closing it
// would discard the data.
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS   = 10000;
const LOCK_RETRY_MIN_MS = 20;
const LOCK_RETRY_MAX_MS = 500;

const isLockError = (e) => /being used by another process|could not set lock|conflicting lock|already open/i.test(e?.message ?? '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------

const TS  = `strftime(created_at::TIMESTAMP, '%Y-%m-%dT%H:%M:%SZ')`;
const TSU = `strftime(updated_at::TIMESTAMP, '%Y-%m-%dT%H:%M:%SZ')`;

// Node name/title, lowercased, with whitespace, '-', '_' and '.' removed -
// cheap key for spotting duplicates like "DuckDB" / "duck-db" / "Duck DB".
const NORM_NAME = `lower(regexp_replace(coalesce(json_extract_string(properties, '$.name'), json_extract_string(properties, '$.title'), ''), '[\\s_.-]+', '', 'g'))`;

const parseRow = (row) => {
  if (row && typeof row.properties === 'string') {
    try {
      row.properties = JSON.parse(row.properties);
    } catch {
      // keep as-is
    }
  }
  return row;
};

export class GraphDatastore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.persistent = dbPath === ':memory:';
    this.instance = null;
    this.conn = null;
    this.depth = 0;         // nesting level of withConnection()
    this.inTransaction = false;
    this.installed = false;
  }

  // --- Lifecycle ------------------------------------------------------------

  // For a file database this only prepares the directory - the file itself is
  // opened lazily per unit of work. For ':memory:' the instance stays open.
  async open() {
    if (this.persistent) {
      this.instance = await DuckDBInstance.create(this.dbPath);
      this.conn = await this.instance.connect();
      return;
    }
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  close() {
    this._release();
  }

  // Run fn with an open connection. Nested calls reuse the outer connection,
  // so a whole tool call touches the file exactly once.
  async withConnection(fn) {
    if (this.conn && (this.persistent || this.depth > 0)) {
      this.depth++;
      try {
        return await fn();
      } finally {
        this.depth--;
      }
    }

    await this._acquire();
    this.depth++;
    try {
      if (!this.installed) {
        await new InstallerDatastore().install(this.conn);
        this.installed = true;
      }
      return await fn();
    } finally {
      this.depth--;
      if (this.depth === 0 && !this.persistent) {
        this._release();
      }
    }
  }

  // Run fn inside a single transaction - all changes commit together or not
  // at all. Nested calls join the outer transaction.
  async transaction(fn) {
    return this.withConnection(async () => {
      if (this.inTransaction) {
        return fn();
      }
      await this.conn.run('BEGIN TRANSACTION');
      this.inTransaction = true;
      try {
        const result = await fn();
        await this.conn.run('COMMIT');
        return result;
      } catch (e) {
        await this.conn.run('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        this.inTransaction = false;
      }
    });
  }

  async _acquire() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let delay = LOCK_RETRY_MIN_MS;

    for (;;) {
      try {
        this.instance = await DuckDBInstance.create(this.dbPath);
        this.conn = await this.instance.connect();
        return;
      } catch (e) {
        this._release();
        if (!isLockError(e) || Date.now() + delay > deadline) {
          if (isLockError(e)) {
            throw new Error(
              `Memory database is busy - another session kept it locked for more than ${LOCK_TIMEOUT_MS / 1000}s. ` +
              `Try again in a moment. (${this.dbPath})`
            );
          }
          throw e;
        }
        await sleep(delay + Math.random() * delay);
        delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
      }
    }
  }

  _release() {
    try {
      this.conn?.closeSync();
    } catch {
      // already closed
    }
    try {
      this.instance?.closeSync();
    } catch {
      // already closed
    }
    this.conn = null;
    this.instance = null;
  }

  // --- Helpers ----------------------------------------------------------------

  async _run(sql, params = []) {
    return this.withConnection(() => this.conn.run(sql, params));
  }

  async _all(sql, params = []) {
    return this.withConnection(async () => {
      const reader = await this.conn.runAndReadAll(sql, params);
      return reader.getRowObjects().map(parseRow);
    });
  }

  async _get(sql, params = []) {
    const rows = await this._all(sql, params);
    return rows[0] ?? null;
  }

  // --- Nodes --------------------------------------------------------------------

  async addNode({ id, type, labels, properties }) {
    const nodeId = id ?? crypto.randomUUID();
    await this._run(
      `INSERT INTO nodes (id, type, labels, properties)
       VALUES ($1, $2, $3, $4::json)`,
      [nodeId, type, normalizeLabels(labels), JSON.stringify(properties)]
    );
    return this.getNode(nodeId);
  }

  async updateNode({ id, labels, properties }) {
    const node = await this.getNode(id);
    if (!node) {
      return null;
    }

    const currentProps = typeof node.properties === 'string'
      ? JSON.parse(node.properties)
      : node.properties;

    const mergedProps = properties !== undefined
      ? { ...currentProps, ...properties }
      : currentProps;

    const newLabels = labels !== undefined ? normalizeLabels(labels) : node.labels;

    await this._run(
      `UPDATE nodes
       SET labels = $1, properties = $2::json, updated_at = now()
       WHERE id = $3`,
      [newLabels, JSON.stringify(mergedProps), id]
    );
    return this.getNode(id);
  }

  async deleteNode(id) {
    await this.transaction(async () => {
      await this._run(
        `DELETE FROM edges WHERE source_id = $1 OR target_id = $1`,
        [id]
      );
      await this._run(`DELETE FROM nodes WHERE id = $1`, [id]);
    });
  }

  // Merge duplicate nodes into keepId: redirect their edges onto keepId, drop
  // edges that become self-loops or exact duplicates (same type, source and
  // target) of an existing edge, then delete the merged nodes. Only edges that
  // were actually redirected are ever dropped. The caller composes the kept
  // node's properties - this is purely the mechanical part.
  async mergeNodes(keepId, mergeIds) {
    return this.transaction(async () => {
      const ph = mergeIds.map((_, i) => `$${i + 2}`).join(', '); // $1 = keepId
      const params = [keepId, ...mergeIds];
      const idsPh = mergeIds.map((_, i) => `$${i + 1}`).join(', ');

      const moved = await this._all(
        `SELECT id FROM edges WHERE source_id IN (${idsPh}) OR target_id IN (${idsPh})`,
        mergeIds
      );
      await this._run(`UPDATE edges SET source_id = $1 WHERE source_id IN (${ph})`, params);
      await this._run(`UPDATE edges SET target_id = $1 WHERE target_id IN (${ph})`, params);

      let droppedSelfLoops = 0;
      let droppedDuplicates = 0;

      if (moved.length) {
        const movedIds = moved.map((r) => r.id);
        const mph = movedIds.map((_, i) => `$${i + 1}`).join(', ');

        const loops = await this._all(
          `SELECT id FROM edges WHERE id IN (${mph}) AND source_id = target_id`,
          movedIds
        );
        if (loops.length) {
          await this._run(`DELETE FROM edges WHERE id IN (${loops.map((_, i) => `$${i + 1}`).join(', ')})`, loops.map((r) => r.id));
        }
        droppedSelfLoops = loops.length;

        // A redirected edge is a duplicate if another edge with the same
        // (type, source, target) exists that is either not redirected, or
        // redirected but older - so exactly one copy survives.
        const dups = await this._all(
          `SELECT e.id
           FROM   edges e
           WHERE  e.id IN (${mph})
             AND  EXISTS (
                    SELECT 1 FROM edges o
                    WHERE  o.id <> e.id
                      AND  o.type = e.type AND o.source_id = e.source_id AND o.target_id = e.target_id
                      AND  (o.id NOT IN (${mph}) OR o.created_at < e.created_at
                            OR (o.created_at = e.created_at AND o.id < e.id))
                  )`,
          movedIds
        );
        if (dups.length) {
          await this._run(`DELETE FROM edges WHERE id IN (${dups.map((_, i) => `$${i + 1}`).join(', ')})`, dups.map((r) => r.id));
        }
        droppedDuplicates = dups.length;
      }

      await this._run(`DELETE FROM nodes WHERE id IN (${idsPh})`, mergeIds);

      return {
        merged_ids: mergeIds,
        redirected_edges: moved.length - droppedSelfLoops - droppedDuplicates,
        dropped_duplicate_edges: droppedDuplicates,
        dropped_self_loops: droppedSelfLoops
      };
    });
  }

  async getNode(id) {
    return this._get(
      `SELECT id, type, labels, properties,
              ${TS}  AS created_at,
              ${TSU} AS updated_at
       FROM   nodes
       WHERE  id = $1`,
      [id]
    );
  }

  // --- Edges --------------------------------------------------------------------

  async addEdge({ id, type, source_id, target_id, properties }) {
    const edgeId = id ?? crypto.randomUUID();
    await this._run(
      `INSERT INTO edges (id, type, source_id, target_id, properties)
       VALUES ($1, $2, $3, $4, $5::json)`,
      [edgeId, type, source_id, target_id, JSON.stringify(properties)]
    );
    return this.getEdge(edgeId);
  }

  async deleteEdge(id) {
    await this._run(`DELETE FROM edges WHERE id = $1`, [id]);
  }

  async getEdge(id) {
    return this._get(
      `SELECT id, type, source_id, target_id, properties,
              ${TS} AS created_at
       FROM   edges
       WHERE  id = $1`,
      [id]
    );
  }

  async listEdges({ source_id, target_id, type, limit }) {
    const conditions = [];
    const params = [];

    if (source_id) {
      params.push(source_id);
      conditions.push(`source_id = $${params.length}`);
    }
    if (target_id) {
      params.push(target_id);
      conditions.push(`target_id = $${params.length}`);
    }
    if (type) {
      params.push(type);
      conditions.push(`type = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT id, type, source_id, target_id, properties,
             ${TS} AS created_at
      FROM   edges
      ${where}
      ORDER  BY created_at DESC
      LIMIT  ${parseInt(limit, 10)}
    `;
    return this._all(sql, params);
  }

  // --- Search -------------------------------------------------------------------

  async search({ query, type, limit }) {
    const params = [`%${query}%`];
    let sql = `
      SELECT id, type, labels, properties,
             ${TS}  AS created_at,
             ${TSU} AS updated_at
      FROM   nodes
      WHERE  properties::text ILIKE $1
    `;

    if (type) {
      params.push(type);
      sql += ` AND type = $${params.length}`;
    }

    sql += ` ORDER BY updated_at DESC LIMIT ${parseInt(limit, 10)}`;
    return this._all(sql, params);
  }

  // --- Vocabulary (returned by get_schema) ----------------------------------------

  async listLabels() {
    const rows = await this._all(
      `SELECT trim(l) AS label, count(*) AS n
       FROM   nodes, unnest(string_split(labels, ',')) AS t(l)
       WHERE  trim(l) <> ''
       GROUP  BY 1
       ORDER  BY n DESC, label`
    );
    return rows.map((r) => ({ label: r.label, count: Number(r.n) }));
  }

  async countNodesPerType() {
    const rows = await this._all(`SELECT type, count(*) AS n FROM nodes GROUP BY type ORDER BY type`);
    return Object.fromEntries(rows.map((r) => [r.type, Number(r.n)]));
  }

  // --- Schema migrations ----------------------------------------------------------

  async countNodesByType(type) {
    const row = await this._get(`SELECT count(*) AS n FROM nodes WHERE type = $1`, [type]);
    return Number(row?.n ?? 0);
  }

  async countEdgesByType(type) {
    const row = await this._get(`SELECT count(*) AS n FROM edges WHERE type = $1`, [type]);
    return Number(row?.n ?? 0);
  }

  async renameNodeType(from, to) {
    await this._run(`UPDATE nodes SET type = $1, updated_at = now() WHERE type = $2`, [to, from]);
  }

  async renameEdgeType(from, to) {
    await this._run(`UPDATE edges SET type = $1 WHERE type = $2`, [to, from]);
  }

  async deleteNodesByType(type) {
    await this._run(`DELETE FROM nodes WHERE type = $1`, [type]);
  }

  async deleteEdgesByType(type) {
    await this._run(`DELETE FROM edges WHERE type = $1`, [type]);
  }

  // --- Dreaming -------------------------------------------------------------------
  // Paginated review of the graph: a batch of nodes, ordered so that nodes of
  // the same type sit next to each other (easier to spot duplicates), plus a
  // capped 1-hop view of each node's edges (enough context to spot missing
  // relationships, without pulling in a hub node's entire edge list).

  async countAllNodes() {
    const row = await this._get(`SELECT count(*) AS n FROM nodes`);
    return Number(row?.n ?? 0);
  }

  // Ordered by type, then normalized name, so likely duplicates ("DuckDB",
  // "duckdb", "Duck DB") land next to each other in the same batch.
  async dreamingPage(limit, offset) {
    return this._all(
      `SELECT id, type, labels, properties,
              ${TS}  AS created_at,
              ${TSU} AS updated_at
       FROM   nodes
       ORDER  BY type, ${NORM_NAME}, created_at, id
       LIMIT  $1 OFFSET $2`,
      [parseInt(limit, 10), parseInt(offset, 10)]
    );
  }

  // For each given node id: other nodes of the same type with the same
  // normalized name/title. Returns { id: [duplicate ids] } for hits only.
  async findPossibleDuplicates(ids) {
    if (!ids.length) {
      return {};
    }
    const ph = ids.map((_, i) => `$${i + 1}`).join(', ');
    const rows = await this._all(
      `WITH n AS (SELECT id, type, ${NORM_NAME} AS k FROM nodes)
       SELECT a.id, list(b.id ORDER BY b.id) AS dup_ids
       FROM   n a
       JOIN   n b ON b.type = a.type AND b.k = a.k AND b.id <> a.id
       WHERE  a.id IN (${ph}) AND a.k <> ''
       GROUP  BY a.id`,
      ids
    );
    return Object.fromEntries(rows.map((r) => [r.id, [...r.dup_ids.items]]));
  }

  // Returns up to `cap` outgoing + `cap` incoming edges for a node, each
  // simplified to { direction, type, other_id, other_type }, plus the total
  // count actually found in each direction so the caller can tell when more
  // exist beyond the cap.
  async getNeighborEdges(nodeId, cap) {
    const outRows = await this._all(
      `SELECT e.type AS edge_type, n.id AS other_id, n.type AS other_type
       FROM   edges e
       JOIN   nodes n ON n.id = e.target_id
       WHERE  e.source_id = $1
       ORDER  BY e.created_at
       LIMIT  $2`,
      [nodeId, parseInt(cap, 10)]
    );
    const inRows = await this._all(
      `SELECT e.type AS edge_type, n.id AS other_id, n.type AS other_type
       FROM   edges e
       JOIN   nodes n ON n.id = e.source_id
       WHERE  e.target_id = $1
       ORDER  BY e.created_at
       LIMIT  $2`,
      [nodeId, parseInt(cap, 10)]
    );

    const outTotal = await this.countEdgesFrom(nodeId, 'source_id');
    const inTotal  = await this.countEdgesFrom(nodeId, 'target_id');

    const out = outRows.map((r) => ({
      direction: 'out',
      type: r.edge_type,
      other_id: r.other_id,
      other_type: r.other_type
    }));

    const inEdges = inRows.map((r) => ({
      direction: 'in',
      type: r.edge_type,
      other_id: r.other_id,
      other_type: r.other_type
    }));

    return {
      out,
      in: inEdges,
      out_more: Math.max(0, outTotal - outRows.length),
      in_more: Math.max(0, inTotal - inRows.length)
    };
  }

  async countEdgesFrom(nodeId, column) {
    if (column !== 'source_id' && column !== 'target_id') {
      throw new Error(`countEdgesFrom: invalid column "${column}"`);
    }
    const row = await this._get(`SELECT count(*) AS n FROM edges WHERE ${column} = $1`, [nodeId]);
    return Number(row?.n ?? 0);
  }
}
