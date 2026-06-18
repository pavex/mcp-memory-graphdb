import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
    this.instance = null;
    this.conn = null;
  }

  // --- Lifecycle ------------------------------------------------------------

  async open() {
    if (this.dbPath !== ':memory:') {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.instance = await DuckDBInstance.create(this.dbPath);
    this.conn = await this.instance.connect();
  }

  close() {
    this.conn.closeSync();
  }

  // --- Helpers ----------------------------------------------------------------

  async _run(sql, params = []) {
    return this.conn.run(sql, params);
  }

  async _all(sql, params = []) {
    const reader = await this.conn.runAndReadAll(sql, params);
    return reader.getRowObjects().map(parseRow);
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
    await this._run(
      `DELETE FROM edges WHERE source_id = $1 OR target_id = $1`,
      [id]
    );
    await this._run(`DELETE FROM nodes WHERE id = $1`, [id]);
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
