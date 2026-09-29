import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { InstallerDatastore } from './InstallerDatastore.js';

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
      [nodeId, type, labels, JSON.stringify(properties)]
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

    const newLabels = labels !== undefined ? labels : node.labels;

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

  async dreamingPage(limit, offset) {
    return this._all(
      `SELECT id, type, labels, properties,
              ${TS}  AS created_at,
              ${TSU} AS updated_at
       FROM   nodes
       ORDER  BY type, created_at
       LIMIT  $1 OFFSET $2`,
      [parseInt(limit, 10), parseInt(offset, 10)]
    );
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
