import assert from 'node:assert/strict';
import { InstallerDatastore } from '../src/Datastore/InstallerDatastore.js';
import { GraphDatastore } from '../src/Datastore/GraphDatastore.js';
import { ToolDefinitions } from '../src/Tools/ToolDefinitions.js';
import { SchemaManager } from '../src/Schema/SchemaManager.js';
import { SchemaTools } from '../src/Tools/SchemaTool.js';
import { normalizeLabels } from '../src/Utils/Labels.js';
import { isSimilar } from '../src/Utils/Similarity.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helper: in-memory repo with schema installed
// ---------------------------------------------------------------------------

async function makeRepo() {
  const repo = new GraphDatastore(':memory:');
  await repo.open();
  await new InstallerDatastore().install(repo.conn);
  return repo;
}

// Tool context: in-memory repo + default schema (schema.yaml in a temp dir).
async function makeContext() {
  const repo = await makeRepo();
  const tmpDir = mkdtempSync(join(tmpdir(), 'graphdb-tools-test-'));
  const schema = new SchemaManager(join(tmpDir, 'memory.duckdb'), repo);
  schema.initDefault();
  const dispose = () => {
    repo.close();
    rmSync(tmpDir, { recursive: true, force: true });
  };
  return { repo, schema, dispose };
}

// ---------------------------------------------------------------------------
// Test: InstallerDatastore — tables exist after install
// ---------------------------------------------------------------------------

async function testInstaller() {
  console.log('--- InstallerDatastore ---');

  const repo = new GraphDatastore(':memory:');
  await repo.open();
  await new InstallerDatastore().install(repo.conn);

  const tables = await repo._all(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name`
  );
  const names = tables.map(r => r.table_name);

  assert.ok(names.includes('nodes'), 'table nodes missing');
  assert.ok(names.includes('edges'), 'table edges missing');

  repo.close();
  console.log(' ✓ InstallerDatastore OK');
}

// ---------------------------------------------------------------------------
// Test: GraphDatastore + Tools
// ---------------------------------------------------------------------------

async function testDatastore() {
  console.log('--- GraphDatastore + Tools ---');

  const context = await makeContext();
  const handlers = new Map(ToolDefinitions.map(t => [t.name, t.handler]));

  const add_node    = handlers.get('add_node');
  const get_node    = handlers.get('get_node');
  const update_node = handlers.get('update_node');
  const delete_node = handlers.get('delete_node');
  const add_edge    = handlers.get('add_edge');
  const delete_edge = handlers.get('delete_edge');
  const list_edges  = handlers.get('list_edges');
  const search      = handlers.get('search');

  // add_node — custom id
  console.log(' - add_node (custom id)...');
  const r1 = await add_node({ id: 'alice', type: 'person', properties: { name: 'Alice', age: 30 } }, context);
  assert.equal(r1.success, true);
  assert.equal(r1.node.id, 'alice');
  assert.equal(r1.node.type, 'person');
  assert.equal(r1.warnings, undefined, 'a new property unrelated to existing keys must not warn');

  // add_node — unknown type rejected
  console.log(' - add_node (unknown type rejected)...');
  await assert.rejects(
    () => add_node({ type: 'spaceship', properties: { name: 'X' } }, context),
    /Unknown node type "spaceship"/
  );

  // add_node — auto id
  console.log(' - add_node (auto id)...');
  const r2 = await add_node({ type: 'person', properties: { name: 'Bob' } }, context);
  assert.equal(r2.success, true);
  assert.equal(r2.warnings, undefined, 'no warnings expected when all properties are declared');
  assert.ok(r2.node.id, 'auto id missing');
  const bobId = r2.node.id;

  // get_node
  console.log(' - get_node...');
  const r3 = await get_node({ id: 'alice' }, context);
  assert.equal(r3.node.id, 'alice');

  // get_node — not found
  console.log(' - get_node (not found)...');
  await assert.rejects(() => get_node({ id: 'nobody' }, context));

  // update_node — merge properties
  console.log(' - update_node...');
  const u1 = await update_node({ id: 'alice', properties: { age: 31, city: 'Praha' } }, context);
  assert.equal(u1.warnings, undefined, 'free-form properties (age, city) must not warn');

  // property keys resembling declared or already used keys warn
  console.log(' - property key variants warn...');
  const pw1 = await add_node({ type: 'person', properties: { name: 'P', roles: 'dev', 'note-career': 'x' } }, context);
  assert.deepEqual(pw1.warnings, [
    'property "roles" is new - similar existing: role. Reuse one of them unless the new property is really different.'
  ], 'plural of a declared key warns; unrelated new key (note-career) does not');
  const pw2 = await update_node({ id: pw1.node.id, properties: { note_career: 'y', citty: 'Brno' } }, context);
  assert.equal(pw2.warnings.length, 2);
  assert.match(pw2.warnings[0], /property "note_career" is new - similar existing: note-career \(1\)/);
  assert.match(pw2.warnings[1], /property "citty" is new - similar existing: city \(1\)/);
  const r4 = await get_node({ id: 'alice' }, context);
  const props = r4.node.properties;
  assert.equal(props.name, 'Alice', 'original property lost after merge');
  assert.equal(props.age, 31,       'updated property incorrect');
  assert.equal(props.city, 'Praha', 'new property missing');

  // add_edge
  console.log(' - add_edge...');
  const r5 = await add_edge({ source_id: 'alice', target_id: bobId, type: 'knows', properties: { since: 2024 } }, context);
  assert.equal(r5.success, true);
  const edgeId = r5.edge.id;

  // add_edge — custom id
  console.log(' - add_edge (custom id)...');
  const r6 = await add_edge({ id: 'e-lives', source_id: 'alice', target_id: bobId, type: 'relates_to' }, context);
  assert.equal(r6.edge.id, 'e-lives');

  // add_edge — unknown type rejected
  console.log(' - add_edge (unknown type rejected)...');
  await assert.rejects(
    () => add_edge({ source_id: 'alice', target_id: bobId, type: 'colleague' }, context),
    /Unknown edge type "colleague"/
  );

  // add_edge — both endpoints must exist
  console.log(' - add_edge (missing endpoint rejected)...');
  await assert.rejects(
    () => add_edge({ source_id: 'alice', target_id: 'nobody', type: 'knows' }, context),
    /Node not found \(target_id\): nobody/
  );
  await assert.rejects(
    () => add_edge({ source_id: 'nobody', target_id: 'alice', type: 'knows' }, context),
    /Node not found \(source_id\): nobody/
  );

  // list_edges — all
  console.log(' - list_edges (all)...');
  const r7 = await list_edges({}, context);
  assert.equal(r7.count, 2);

  // list_edges — by source
  console.log(' - list_edges (by source_id)...');
  const r8 = await list_edges({ source_id: 'alice' }, context);
  assert.equal(r8.count, 2);

  // list_edges — by type
  console.log(' - list_edges (by type)...');
  const r9 = await list_edges({ type: 'knows' }, context);
  assert.equal(r9.count, 1);
  assert.equal(r9.edges[0].id, edgeId);

  // search
  console.log(' - search...');
  const r10 = await search({ query: 'Alice' }, context);
  assert.equal(r10.count, 1);
  assert.equal(r10.nodes[0].id, 'alice');

  // search — by type filter
  console.log(' - search (type filter)...');
  const r11 = await search({ query: 'Bob', type: 'person' }, context);
  assert.equal(r11.count, 1);

  // search — no results
  console.log(' - search (no results)...');
  const r12 = await search({ query: 'xyz_nonexistent' }, context);
  assert.equal(r12.count, 0);

  // delete_edge
  console.log(' - delete_edge...');
  await delete_edge({ id: edgeId }, context);
  const r13 = await list_edges({ type: 'knows' }, context);
  assert.equal(r13.count, 0);

  // delete_edge — not found
  console.log(' - delete_edge (not found)...');
  await assert.rejects(() => delete_edge({ id: edgeId }, context));

  // delete_node — cascades edges
  console.log(' - delete_node (cascades edges)...');
  await delete_node({ id: 'alice' }, context);
  const r14 = await list_edges({}, context);
  assert.equal(r14.count, 0, 'edges not deleted after node delete');
  await assert.rejects(() => get_node({ id: 'alice' }, context));

  context.dispose();
  console.log(' ✓ GraphDatastore + Tools OK');
}

// ---------------------------------------------------------------------------
// Test: SchemaManager — validate, add, rename, remove, guards
// ---------------------------------------------------------------------------

async function testSchema() {
  console.log('--- SchemaManager ---');

  const repo = await makeRepo();
  // schema.yaml is written next to dbPath's directory — use a temp dir
  const tmpDir = mkdtempSync(join(tmpdir(), 'graphdb-schema-test-'));
  const fakeDbPath = join(tmpDir, 'memory.duckdb');

  const schema = new SchemaManager(fakeDbPath, repo);

  // initDefault — writes schema.yaml, revision 0
  console.log(' - initDefault...');
  assert.equal(schema.exists(), false);
  const def = schema.initDefault();
  assert.equal(def.revision, 0);
  assert.equal(schema.exists(), true);
  assert.ok(existsSync(schema.schemaPath), 'schema.yaml not written to disk');

  // apply — reject invalid structure (unknown top-level key)
  console.log(' - apply (reject unknown key)...');
  await assert.rejects(
    () => schema.apply({ bogus_key: true }),
    /Invalid schema/
  );

  // apply — reject node type missing description
  console.log(' - apply (reject missing description)...');
  await assert.rejects(
    () => schema.apply({ nodes: { widget: {} } }),
    /Invalid schema/
  );

  // apply — add a new node type
  console.log(' - apply (add node type)...');
  const r1 = await schema.apply({
    nodes: { widget: { description: 'A test widget', properties: { name: 'string' } } }
  });
  assert.equal(r1.schema.revision, 1);
  assert.deepEqual(r1.diff.addedNodes, ['widget']);
  assert.ok(r1.schema.nodes.project, 'existing types must survive untouched');
  assert.ok(r1.schema.nodes.widget);

  // apply — patch semantics: omitting an existing type from `nodes:` leaves
  // it fully untouched. The only way to remove anything is `migrations`.
  console.log(' - apply (omitted type stays untouched, no error)...');
  const r1b = await schema.apply({
    nodes: { another_widget: { description: 'Yet another test type' } }
    // note: "project" is not mentioned here at all — must survive unharmed
  });
  assert.equal(r1b.schema.revision, 2);
  assert.ok(r1b.schema.nodes.project, 'omitting a type from nodes: must never remove it');
  assert.ok(r1b.schema.nodes.widget, 'previously added type must also survive');
  assert.ok(r1b.schema.nodes.another_widget);

  // apply — rename_node on a type with zero rows (no DB data yet)
  console.log(' - apply (rename_node)...');
  const r2 = await schema.apply({
    migrations: [{ rename_node: { from: 'widget', to: 'gadget' } }]
  });
  assert.equal(r2.schema.revision, 3);
  assert.ok(!r2.schema.nodes.widget, 'old name must be gone');
  assert.ok(r2.schema.nodes.gadget, 'new name must exist');
  assert.deepEqual(r2.diff.renamedNodes, [{ from: 'widget', to: 'gadget' }]);
  assert.deepEqual(r2.diff.addedNodes, [], 'a rename target must never be reported as "added"');

  // rename_node on nonexistent source — rejected
  console.log(' - apply (rename_node unknown source rejected)...');
  await assert.rejects(
    () => schema.apply({ migrations: [{ rename_node: { from: 'nope', to: 'whatever' } }] }),
    /does not exist/
  );

  // Create actual data of type "gadget", then try remove_node — must be rejected
  console.log(' - apply (remove_node blocked by existing data)...');
  await repo.addNode({ type: 'gadget', labels: '', properties: { name: 'Test Gadget' } });
  await assert.rejects(
    () => schema.apply({ migrations: [{ remove_node: { type: 'gadget' } }] }),
    /still has \d+ node/
  );

  // rename_node away from the data-bearing type, THEN remove succeeds
  console.log(' - apply (rename then remove_node succeeds)...');
  const r3 = await schema.apply({
    migrations: [{ rename_node: { from: 'gadget', to: 'thingamajig' } }]
  });
  assert.ok(r3.schema.nodes.thingamajig);
  const gadgetCountAfterRename = await repo.countNodesByType('gadget');
  const thingCountAfterRename  = await repo.countNodesByType('thingamajig');
  assert.equal(gadgetCountAfterRename, 0, 'rename must move all rows to the new type');
  assert.equal(thingCountAfterRename, 1, 'renamed row must appear under the new type');

  // remove_node still requires zero rows — renaming moved the data, it did
  // not delete it, so the type must still be emptied out before removal.
  console.log(' - apply (remove_node still blocked after rename, data just moved)...');
  await assert.rejects(
    () => schema.apply({ migrations: [{ remove_node: { type: 'thingamajig' } }] }),
    /still has \d+ node/
  );

  // Delete the actual node so the type becomes empty, then remove_node succeeds
  const thingamajigNodes = await repo._all(`SELECT id FROM nodes WHERE type = $1`, ['thingamajig']);
  for (const n of thingamajigNodes) await repo.deleteNode(n.id);
  assert.equal(await repo.countNodesByType('thingamajig'), 0, 'test setup: type must be empty before remove_node');

  const r4 = await schema.apply({
    migrations: [{ remove_node: { type: 'thingamajig' } }]
  });
  assert.ok(!r4.schema.nodes.thingamajig, 'removed type must be gone from schema');
  assert.deepEqual(r4.diff.removedNodes, ['thingamajig']);

  // rename_edge — same pattern, lighter check
  console.log(' - apply (rename_edge)...');
  const r5 = await schema.apply({
    migrations: [{ rename_edge: { from: 'uses', to: 'utilizes' } }]
  });
  assert.ok(!r5.schema.edges.uses);
  assert.ok(r5.schema.edges.utilizes);

  // toYaml — round trips through js-yaml without throwing
  console.log(' - toYaml...');
  const yamlStr = schema.toYaml();
  assert.ok(yamlStr.includes('revision:'), 'yaml must include revision');
  assert.ok(yamlStr.includes('utilizes'), 'yaml must reflect latest state');

  // summarize — human readable, no throw
  console.log(' - summarize...');
  const summary = schema.summarize();
  assert.ok(summary.includes('Schema revision'));

  repo.close();
  rmSync(tmpDir, { recursive: true, force: true });
  console.log(' ✓ SchemaManager OK');
}

// ---------------------------------------------------------------------------
// Test: DreamingTool — pagination, edge enrichment, edge_cap overflow
// ---------------------------------------------------------------------------

async function testDreaming() {
  console.log('--- DreamingTool ---');

  const context = await makeContext();
  const handlers = new Map(ToolDefinitions.map(t => [t.name, t.handler]));
  const dreaming = handlers.get('dreaming');
  const add_node = handlers.get('add_node');
  const add_edge = handlers.get('add_edge');

  // Empty graph — must not throw, must report zero total and no further pages
  console.log(' - dreaming (empty graph)...');
  const e1 = await dreaming({}, context);
  assert.equal(e1.success, true);
  assert.equal(e1.total, 0);
  assert.deepEqual(e1.nodes, []);
  assert.equal(e1.has_more, false);
  assert.equal(e1.next_offset, null);

  // Seed 5 nodes — request a page of 2, expect has_more true and next_offset 2
  console.log(' - dreaming (pagination, has_more true)...');
  for (let i = 0; i < 5; i++) {
    await add_node({ type: 'person', properties: { name: `Person ${i}` } }, context);
  }
  const p1 = await dreaming({ limit: 2, offset: 0 }, context);
  assert.equal(p1.total, 5);
  assert.equal(p1.nodes.length, 2);
  assert.equal(p1.has_more, true);
  assert.equal(p1.next_offset, 2);

  // Walk all pages via next_offset and confirm we see exactly 5 distinct nodes
  console.log(' - dreaming (walking full pagination)...');
  const seenIds = new Set();
  let offset = 0;
  let guard  = 0; // safety against an infinite loop if has_more logic regresses
  while (true) {
    const page = await dreaming({ limit: 2, offset }, context);
    for (const n of page.nodes) seenIds.add(n.id);
    if (!page.has_more) break;
    offset = page.next_offset;
    guard++;
    assert.ok(guard < 20, 'pagination did not terminate — has_more/next_offset logic is broken');
  }
  assert.equal(seenIds.size, 5, 'pagination must cover every node exactly once across pages');

  // Type-grouped ordering: add a different-typed node, confirm same-type nodes
  // still come back contiguous within a single full-graph page.
  console.log(' - dreaming (type-grouped ordering)...');
  await add_node({ type: 'project', properties: { name: 'Solo Project' } }, context);
  const full = await dreaming({ limit: 10, offset: 0 }, context);
  const types = full.nodes.map(n => n.type);
  const firstProjectIdx = types.indexOf('project');
  const lastPersonIdx   = types.lastIndexOf('person');
  // every 'person' must appear, contiguously, before the single 'project'
  // (alphabetically 'person' < 'project', so this also pins down ORDER BY type)
  assert.ok(firstProjectIdx > lastPersonIdx, 'nodes of the same type must be grouped together by ORDER BY type');

  // Edge enrichment — a node's "edges" field must reflect real connections
  console.log(' - dreaming (edge enrichment)...');
  const personNode = full.nodes.find(n => n.type === 'person');
  const projectNode = full.nodes.find(n => n.type === 'project');
  await add_edge({ source_id: personNode.id, target_id: projectNode.id, type: 'works_on' }, context);

  const withEdge = await dreaming({ limit: 10, offset: 0 }, context);
  const enrichedPerson = withEdge.nodes.find(n => n.id === personNode.id);
  assert.ok(enrichedPerson.edges, 'node must carry an edges field');
  assert.equal(enrichedPerson.edges.out.length, 1, 'one outgoing edge expected');
  assert.equal(enrichedPerson.edges.out[0].type, 'works_on');
  assert.equal(enrichedPerson.edges.out[0].other_id, projectNode.id);
  assert.equal(enrichedPerson.edges.out[0].other_type, 'project');
  assert.equal(enrichedPerson.edges.in.length, 0, 'no incoming edges expected on this node');

  const enrichedProject = withEdge.nodes.find(n => n.id === projectNode.id);
  assert.equal(enrichedProject.edges.in.length, 1, 'one incoming edge expected on the target node');
  assert.equal(enrichedProject.edges.in[0].direction, 'in');
  assert.equal(enrichedProject.edges.in[0].other_id, personNode.id);

  // edge_cap overflow — create more outgoing edges than the cap and confirm
  // out_more correctly reports how many were left out of the capped list.
  console.log(' - dreaming (edge_cap overflow reporting)...');
  for (let i = 0; i < 4; i++) {
    const extra = await add_node({ type: 'note', properties: { title: `Note ${i}` } }, context);
    await add_edge({ source_id: personNode.id, target_id: extra.node.id, type: 'relates_to' }, context);
  }
  // personNode now has 1 (works_on) + 4 (relates_to) = 5 outgoing edges total
  const capped = await dreaming({ limit: 10, offset: 0, edge_cap: 3 }, context);
  const cappedPerson = capped.nodes.find(n => n.id === personNode.id);
  assert.equal(cappedPerson.edges.out.length, 3, 'edge list must be capped at edge_cap');
  assert.equal(cappedPerson.edges.out_more, 2, 'out_more must report the remaining count beyond the cap');

  context.dispose();
  console.log(' ✓ DreamingTool OK');
}

// ---------------------------------------------------------------------------
// Test: merging duplicates — dreaming hints + update_node(merge_from)
// ---------------------------------------------------------------------------

async function testMerge() {
  console.log('--- Merge (update_node merge_from) ---');

  const context  = await makeContext();
  const { repo } = context;
  const handlers = new Map(ToolDefinitions.map(t => [t.name, t.handler]));
  const add_node    = handlers.get('add_node');
  const add_edge    = handlers.get('add_edge');
  const update_node = handlers.get('update_node');
  const dreaming    = handlers.get('dreaming');

  await add_node({ id: 'k',  type: 'technology', properties: { name: 'DuckDB', version: '1.5' } }, context);
  await add_node({ id: 'd1', type: 'technology', properties: { name: 'duck-db', note: 'embedded' } }, context);
  await add_node({ id: 'd2', type: 'technology', properties: { name: 'Duck DB' } }, context);
  await add_node({ id: 'x',  type: 'project',    properties: { name: 'Memory' } }, context);
  await add_node({ id: 'y',  type: 'person',     properties: { name: 'Pavel' } }, context);
  await add_node({ id: 'z',  type: 'person',     properties: { name: 'Other' } }, context);

  await add_edge({ source_id: 'x',  target_id: 'k',  type: 'uses' }, context);
  await add_edge({ source_id: 'x',  target_id: 'd1', type: 'uses' }, context);       // → duplicate of x-uses-k
  await add_edge({ source_id: 'y',  target_id: 'd1', type: 'knows' }, context);      // → redirected
  await add_edge({ source_id: 'd1', target_id: 'k',  type: 'relates_to' }, context); // → self-loop
  await add_edge({ source_id: 'd2', target_id: 'd1', type: 'relates_to' }, context); // → self-loop
  await add_edge({ source_id: 'd2', target_id: 'x',  type: 'part_of' }, context);    // → redirected

  // dreaming — name-normalized duplicates are adjacent and hinted
  console.log(' - dreaming (possible_duplicates + name ordering)...');
  const page = await dreaming({ limit: 10 }, context);
  const techIds = page.nodes.filter(n => n.type === 'technology').map(n => n.id);
  assert.equal(techIds.length, 3);
  const byId = Object.fromEntries(page.nodes.map(n => [n.id, n]));
  assert.deepEqual(byId.k.possible_duplicates, ['d1', 'd2']);
  assert.deepEqual(byId.d1.possible_duplicates, ['d2', 'k']);
  assert.equal(byId.y.possible_duplicates, undefined, 'different names must not be hinted');
  assert.equal(byId.x.possible_duplicates, undefined);
  assert.ok(page.instructions.includes('merge_from'), 'dreaming must explain merge_from');

  // update_node merge_from — guards
  console.log(' - update_node merge_from (guards)...');
  await assert.rejects(() => update_node({ id: 'k', merge_from: ['k'] }, context), /must not contain the kept node/);
  await assert.rejects(() => update_node({ id: 'k', merge_from: ['nope'] }, context), /Node not found \(merge_from\): nope/);
  await assert.rejects(() => update_node({ id: 'nope', merge_from: ['d1'] }, context), /Node not found: nope/);

  // update_node merge_from — the merge itself
  console.log(' - update_node merge_from (merge)...');
  const m = await update_node({
    id: 'k',
    properties: { note: 'Embedded analytical database' },
    merge_from: ['d1', 'd2']
  }, context);
  assert.equal(m.success, true);
  assert.deepEqual(m.node.properties, { note: 'Embedded analytical database' }, 'update_node echoes only changed properties');
  assert.equal((await repo.getNode('k')).properties.version, '1.5', 'existing properties must be kept');
  assert.deepEqual(m.merge, {
    merged_ids: ['d1', 'd2'],
    redirected_edges: 2,
    dropped_duplicate_edges: 1,
    dropped_self_loops: 2
  });

  assert.equal(await repo.getNode('d1'), null, 'merged node d1 must be deleted');
  assert.equal(await repo.getNode('d2'), null, 'merged node d2 must be deleted');

  const edges = (await repo.listEdges({ limit: 100 }))
    .map(e => `${e.source_id}-${e.type}-${e.target_id}`)
    .sort();
  assert.deepEqual(edges, ['k-part_of-x', 'x-uses-k', 'y-knows-k']);

  context.dispose();
  console.log(' ✓ Merge OK');
}

// ---------------------------------------------------------------------------
// Test: labels normalization + vocabulary in get_schema
// ---------------------------------------------------------------------------

async function testVocabulary() {
  console.log('--- Labels + get_schema vocabulary ---');

  console.log(' - normalizeLabels...');
  assert.equal(normalizeLabels(' ai, DuckDB ,,ai , AI,memory '), 'ai DuckDB memory');
  assert.equal(normalizeLabels('reabr  schema3\tfix reabr'), 'reabr schema3 fix');
  assert.equal(normalizeLabels(['x', ' y ', '', 'X', 'two words']), 'x y two-words');
  assert.equal(normalizeLabels(''), '');
  assert.equal(normalizeLabels(undefined), '');

  const context  = await makeContext();
  const handlers = new Map([...ToolDefinitions, ...SchemaTools].map(t => [t.name, t.handler]));
  const add_node    = handlers.get('add_node');
  const update_node = handlers.get('update_node');
  const get_schema  = handlers.get('get_schema');

  console.log(' - labels normalized on write...');
  const a = await add_node({ id: 'a', type: 'topic', labels: 'ai, memory ,ai', properties: { name: 'A' } }, context);
  assert.equal(a.node.labels, 'ai memory');
  const b = await add_node({ id: 'b', type: 'topic', labels: ['ai', 'graph'], properties: { name: 'B' } }, context);
  assert.equal(b.node.labels, 'ai graph');
  await add_node({ id: 'c', type: 'note', properties: { title: 'C' } }, context);
  const u = await update_node({ id: 'c', labels: ' graph ' }, context);
  assert.equal(u.node.labels, 'graph');

  console.log(' - get_schema returns node_counts + labels used twice or more...');
  const s = await get_schema({}, context);
  assert.deepEqual(s.node_counts, { note: 1, topic: 2 });
  assert.deepEqual(s.labels, [
    { label: 'ai', count: 2 },
    { label: 'graph', count: 2 }
  ]);
  assert.equal(s.labels_total, 3);

  console.log(' - isSimilar...');
  const similar = [['fixes', 'fix'], ['fix', 'bugfix'], ['bugs', 'bugfix'], ['agent', 'agents'], ['code-review', 'review'],
    ['findings', 'finding'], ['pavel-ines-cz', 'pavel-ines'], ['renaming', 'naming'], ['archtecture', 'architecture']];
  for (const [a, b] of similar) assert.ok(isSimilar(a, b), `${a} ~ ${b} expected similar`);
  const different = [['schema', 'schema-parser'], ['encoder', 'decoder'], ['web', 'website-tools'], ['mcp', 'mcp-google-gemini'],
    ['php', 'pdo'], ['ai', 'api'], ['schema', 'schema3'], ['status_update_5', 'status_update_4'],
    ['status_update_2', 'status_update'], ['vcl4_status', 'status'], ['vcl1_history', 'history']];
  for (const [a, b] of different) assert.ok(!isSimilar(a, b), `${a} ~ ${b} expected different`);

  console.log(' - new labels similar to existing ones warn on write...');
  const w1 = await add_node({ type: 'note', labels: 'graphs memory brand-new', properties: { title: 'W' } }, context);
  assert.equal(w1.warnings.length, 1, 'only the similar new label warns (memory is known, brand-new has no match)');
  assert.match(w1.warnings[0], /label "graphs" is new - similar existing: graph \(2\)/);
  const w2 = await add_node({ type: 'note', labels: 'ai graph', properties: { title: 'W2' } }, context);
  assert.equal(w2.warnings, undefined, 'known labels must not warn');
  const w3 = await update_node({ id: 'c', labels: 'graph memorys' }, context);
  assert.match(w3.warnings[0], /label "memorys" is new - similar existing: memory/);
  assert.deepEqual(w3.node.properties, {}, 'labels-only update echoes no properties');

  context.dispose();
  console.log(' ✓ Labels + vocabulary OK');
}

// ---------------------------------------------------------------------------
// Test: types present only in data — unknown_types + rename with merge
// ---------------------------------------------------------------------------

async function testTypeMerge() {
  console.log('--- Unknown types + rename merge ---');

  const context  = await makeContext();
  const { repo, schema } = context;
  const get_schema = SchemaTools.find(t => t.name === 'get_schema').handler;

  // Legacy rows written before type validation existed (repo bypasses the tools)
  await repo.addNode({ id: 'ad1', type: 'architecture-decision', labels: '', properties: { name: 'AD 1' } });
  await repo.addNode({ id: 'ad2', type: 'architecture-decision', labels: '', properties: { name: 'AD 2' } });
  await repo.addNode({ id: 's1', type: 'session_summary', labels: '', properties: { name: 'S 1' } });
  await repo.addEdge({ id: 'le', type: 'legacy_link', source_id: 'ad1', target_id: 's1', properties: {} });
  await schema.apply({ nodes: { decision: { description: 'A decision' } } });

  console.log(' - get_schema lists unknown_types...');
  const s1 = await get_schema({}, context);
  assert.deepEqual(s1.unknown_types.nodes, ['architecture-decision', 'session_summary']);
  assert.deepEqual(s1.unknown_types.edges, ['legacy_link']);

  console.log(' - rename onto existing type without merge rejected...');
  await assert.rejects(
    () => schema.apply({ migrations: [{ rename_node: { from: 'architecture-decision', to: 'decision' } }] }),
    /already exists\. Add merge: true/
  );

  console.log(' - data-only source without definition for new target rejected...');
  await assert.rejects(
    () => schema.apply({ migrations: [{ rename_node: { from: 'architecture-decision', to: 'adr' } }] }),
    /define "adr" in the same call/
  );

  console.log(' - rename with merge: true from data-only type...');
  const before = schema.get().nodes.decision;
  await schema.apply({ migrations: [{ rename_node: { from: 'architecture-decision', to: 'decision', merge: true } }] });
  assert.equal(await repo.countNodesByType('architecture-decision'), 0);
  assert.equal(await repo.countNodesByType('decision'), 2);
  assert.deepEqual(schema.get().nodes.decision, before, 'merge target must keep its definition');
  assert.equal(schema.get().nodes['architecture-decision'], undefined);

  console.log(' - data-only types added / renamed with definition...');
  await schema.apply({
    migrations: [{ rename_edge: { from: 'legacy_link', to: 'summarizes' } }],
    nodes: { session_summary: { description: 'Summary of a work session' } },
    edges: { summarizes: { description: 'Summary covers something' } }
  });
  const s2 = await get_schema({}, context);
  assert.equal(s2.unknown_types, undefined, 'no unknown types expected after cleanup');
  assert.equal((await repo.getEdge('le')).type, 'summarizes');

  console.log(' - unknown source (not in schema nor data) still rejected...');
  await assert.rejects(
    () => schema.apply({ migrations: [{ rename_node: { from: 'ghost', to: 'decision', merge: true } }] }),
    /does not exist in current schema or data/
  );

  context.dispose();
  console.log(' ✓ Unknown types + rename merge OK');
}

async function run() {
  console.log('Starting tests...\n');
  await testInstaller();
  await testDatastore();
  await testSchema();
  await testDreaming();
  await testMerge();
  await testVocabulary();
  await testTypeMerge();
  console.log('\nAll tests passed!');
}

run().catch(err => { console.error(err); process.exit(1); });
