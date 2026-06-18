// ---------------------------------------------------------------------------

export class InstallerDatastore {
  async install(conn) {
    await conn.run(`
      CREATE TABLE IF NOT EXISTS nodes (
        id         VARCHAR PRIMARY KEY,
        type       VARCHAR     NOT NULL,
        labels     VARCHAR     NOT NULL DEFAULT '',
        properties JSON        NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await conn.run(`
      CREATE TABLE IF NOT EXISTS edges (
        id         VARCHAR PRIMARY KEY,
        type       VARCHAR     NOT NULL,
        source_id  VARCHAR     NOT NULL,
        target_id  VARCHAR     NOT NULL,
        properties JSON        NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }
}
