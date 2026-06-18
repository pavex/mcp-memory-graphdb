import assert from 'node:assert/strict';
import { InstallerDatastore } from '../src/Datastore/InstallerDatastore.js';
import { GraphDatastore } from '../src/Datastore/GraphDatastore.js';
import { ToolDefinitions } from '../src/Tools/ToolDefinitions.js';
import { SchemaManager } from '../src/Schema/SchemaManager.js';
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

  const repo    = await makeRepo();
  const context = { repo };
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

  // add_node — auto id
  console.log(' - add_node (auto id)...');
  const r2 = await add_node({ type: 'person', properties: { name: 'Bob' } }, context);
  assert.equal(r2.success, true);
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
  await update_node({ id: 'alice', properties: { age: 31, city: 'Praha' } }, context);
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
  const r6 = await add_edge({ id: 'e-lives', source_id: 'alice', target_id: bobId, type: 'colleague' }, context);
  assert.equal(r6.edge.id, 'e-lives');

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

  repo.close();
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

  const repo    = await makeRepo();
  const context = { repo };
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

  repo.close();
  console.log(' ✓ DreamingTool OK');
}


async function run() {
  console.log('Starting tests...\n');
  await testInstaller();
  await testDatastore();
  await testSchema();
  await testDreaming();
  console.log('\nAll tests passed!');
}

run().catch(err => { console.error(err); process.exit(1); });
