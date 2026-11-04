/**
 * Raw JSON-RPC integration test for mcp-memory-graphdb.
 * No SDK on the client side — pure stdio piping.
 *
 * Requests are sent sequentially — each waits for a response before
 * sending the next. DuckDB is async and parallel writes corrupt data.
 *
 * Shutdown strategy: close stdin → server gets EOF → exits cleanly.
 * We wait for the 'close' event before deleting the DB file.
 *
 * The multi-session test starts two server processes against the SAME
 * database file — exactly what happens when two Claude sessions use the
 * same memory. Both must be able to read and write, and see each other's
 * changes (data and schema).
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'integration-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {}
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanup(dbPath) {
  for (const f of [dbPath, `${dbPath}.wal`, path.join(path.dirname(dbPath), 'schema.yaml')]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function startServer(serverPath, dbPath, env = {}) {
  const server = spawn('node', [serverPath, dbPath], { env: { ...process.env, ...env } });
  let buffer = '';
  const pending = new Map(); // id → resolve
  const client = { stderr: '' };

  // Parse newline-delimited JSON from stdout
  server.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete last line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch (e) { /* ignore parse errors */ }
    }
  });

  server.stderr.on('data', (data) => { client.stderr += data.toString(); });

  const closed = new Promise((res) => server.on('close', res));

  // Send a request and wait for the response
  let nextId = 1;
  client.call = (method, params = {}) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  client.notify = (method, params = {}) => {
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  client.tool = (name, args = {}) => client.call('tools/call', { name, arguments: args });

  // 2026-07-28 era: no handshake, every request carries the _meta envelope
  client.modern = (method, params = {}) => client.call(method, { ...params, _meta: MODERN_META });
  client.modernTool = (name, args = {}) => client.modern('tools/call', { name, arguments: args });

  client.init = async () => {
    const init = await client.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' }
    });
    if (!init?.result?.protocolVersion) throw new Error('Handshake failed');
    client.notify('notifications/initialized');
  };

  client.shutdown = () => {
    server.stdin.end();
    return closed;
  };

  return client;
}

const text = (resp) => resp?.result?.content?.[0]?.text ?? '';
const ok   = (resp) => text(resp).includes('"success": true');

// ---------------------------------------------------------------------------
// Test: single session — basic tool round-trip
// ---------------------------------------------------------------------------

async function runSingleSession(serverPath, label) {
  const dbPath = path.resolve(__dirname, `integration_test_${label}.duckdb`);
  cleanup(dbPath);
  const s = startServer(serverPath, dbPath);

  try {
    // 1. Handshake
    await s.init();

    // 2. add_node alice
    const r2 = await s.tool('add_node', { id: 'alice', type: 'person', properties: { name: 'Alice' } });
    if (!ok(r2) || !text(r2).includes('"alice"')) throw new Error('add_node alice failed');

    // 3. add_node bob
    const r3 = await s.tool('add_node', { id: 'bob', type: 'person', properties: { name: 'Bob' } });
    if (!ok(r3) || !text(r3).includes('"bob"')) throw new Error('add_node bob failed');

    // 4. add_edge
    const r4 = await s.tool('add_edge', { source_id: 'alice', target_id: 'bob', type: 'knows' });
    if (!ok(r4) || !text(r4).includes('"knows"')) throw new Error('add_edge failed');

    // 5. search
    const r5 = await s.tool('search', { query: 'Alice' });
    if (!ok(r5) || !text(r5).includes('"alice"')) throw new Error('search failed');

    // 6. list_edges
    const r6 = await s.tool('list_edges', {});
    if (!ok(r6) || !text(r6).includes('"knows"')) throw new Error('list_edges failed');

    // 7. get_schema — default schema must be present (revision 0, fresh DB)
    const r7 = await s.tool('get_schema', {});
    if (!ok(r7) || !text(r7).includes('"revision": 0')) throw new Error('get_schema failed (expected revision 0)');

    // 8. apply_schema — add a brand new node type
    const r8 = await s.tool('apply_schema', {
      yaml: 'nodes:\n  event:\n    description: "Test event type"\n    properties:\n      name: string\n'
    });
    if (!ok(r8) || !text(r8).includes('"revision": 1') || !text(r8).includes('"event"')) {
      throw new Error('apply_schema (add node) failed');
    }

    // 9. get_schema again — must reflect revision 1 and the new type, on a fresh read
    const r9 = await s.tool('get_schema', {});
    if (!ok(r9) || !text(r9).includes('"revision": 1') || !text(r9).includes('event:')) {
      throw new Error('get_schema after apply_schema did not reflect new state');
    }

    console.log(` ✓ Integration test (${label}) OK`);
  } catch (err) {
    console.error(` ✗ Integration test (${label}) FAILED: ${err.message}`);
    if (s.stderr) console.error('--- STDERR ---\n', s.stderr);
    throw err;
  } finally {
    await s.shutdown();
    cleanup(dbPath);
  }
}

// ---------------------------------------------------------------------------
// Test: two sessions (processes) sharing one database file
// ---------------------------------------------------------------------------

async function runMultiSession(serverPath, label) {
  const dbPath = path.resolve(__dirname, `integration_test_${label}_multi.duckdb`);
  cleanup(dbPath);
  const a = startServer(serverPath, dbPath);
  const b = startServer(serverPath, dbPath);

  try {
    // 1. Both sessions start and connect while the other one is running
    await Promise.all([a.init(), b.init()]);

    // 2. Interleaved writes from both sessions
    const r2 = await a.tool('add_node', { id: 'a1', type: 'person', properties: { name: 'From A' } });
    if (!ok(r2)) throw new Error(`session A add_node failed: ${text(r2)}`);

    const r3 = await b.tool('add_node', { id: 'b1', type: 'person', properties: { name: 'From B' } });
    if (!ok(r3)) throw new Error(`session B add_node failed: ${text(r3)}`);

    // 3. Each session sees the other one's data
    const r4 = await a.tool('get_node', { id: 'b1' });
    if (!ok(r4)) throw new Error(`session A cannot see B's node: ${text(r4)}`);

    const r5 = await b.tool('add_edge', { source_id: 'b1', target_id: 'a1', type: 'knows' });
    if (!ok(r5)) throw new Error(`session B add_edge to A's node failed: ${text(r5)}`);

    // 4. Concurrent writes — both sessions fire at once, the file lock
    //    serializes them; every write must land.
    const burst = [];
    for (let i = 0; i < 10; i++) {
      burst.push(a.tool('add_node', { id: `a_burst_${i}`, type: 'note', properties: { title: `A ${i}` } }));
      burst.push(b.tool('add_node', { id: `b_burst_${i}`, type: 'note', properties: { title: `B ${i}` } }));
    }
    const results = await Promise.all(burst);
    const failed = results.filter((r) => !ok(r));
    if (failed.length) throw new Error(`concurrent writes failed: ${text(failed[0])}`);

    const r6 = await b.tool('search', { query: 'A ', type: 'note', limit: 100 });
    if (!text(r6).includes('"count": 10')) throw new Error(`session B does not see all of A's burst writes: ${text(r6)}`);

    // 5. Schema change in A is visible in B
    const r7 = await a.tool('apply_schema', { yaml: 'edges:\n  mentors:\n    description: "Test edge type"\n' });
    if (!ok(r7) || !text(r7).includes('"revision": 1')) throw new Error(`session A apply_schema failed: ${text(r7)}`);

    const r8 = await b.tool('get_schema', {});
    if (!text(r8).includes('"revision": 1') || !text(r8).includes('mentors')) {
      throw new Error(`session B does not see A's schema change: ${text(r8)}`);
    }

    // 6. B builds on A's schema revision (not its own stale copy)
    const r9 = await b.tool('apply_schema', { yaml: 'edges:\n  mentored_by:\n    description: "Another test edge type"\n' });
    if (!ok(r9) || !text(r9).includes('"revision": 2')) throw new Error(`session B apply_schema on top of A failed: ${text(r9)}`);

    const r10 = await a.tool('get_schema', {});
    if (!text(r10).includes('mentors') || !text(r10).includes('mentored_by')) {
      throw new Error(`schema lost an edge type across sessions: ${text(r10)}`);
    }

    console.log(` ✓ Multi-session integration test (${label}) OK`);
  } catch (err) {
    console.error(` ✗ Multi-session integration test (${label}) FAILED: ${err.message}`);
    if (a.stderr) console.error('--- STDERR A ---\n', a.stderr);
    if (b.stderr) console.error('--- STDERR B ---\n', b.stderr);
    throw err;
  } finally {
    await Promise.all([a.shutdown(), b.shutdown()]);
    cleanup(dbPath);
  }
}

// ---------------------------------------------------------------------------
// Test: both protocol eras served from one server, against one database file
// ---------------------------------------------------------------------------

function assertToolList(resp, era) {
  const addNode = resp?.result?.tools?.find((t) => t.name === 'add_node');
  if (!addNode) throw new Error(`${era}: tools/list has no add_node: ${JSON.stringify(resp)}`);
  if (JSON.stringify(addNode.inputSchema.required) !== '["type"]') {
    throw new Error(`${era}: fields with defaults must stay optional: ${JSON.stringify(addNode.inputSchema.required)}`);
  }
}

async function runProtocolEras(serverPath, label) {
  const dbPath = path.resolve(__dirname, `integration_test_${label}_eras.duckdb`);
  cleanup(dbPath);
  const legacy = startServer(serverPath, dbPath);
  const modern = startServer(serverPath, dbPath);

  try {
    // Legacy: initialize, tools/list, tools/call
    await legacy.init();
    assertToolList(await legacy.call('tools/list'), 'legacy');
    const r1 = await legacy.tool('add_node', { id: 'legacy', type: 'person', properties: { name: 'Legacy' } });
    if (!ok(r1)) throw new Error(`legacy add_node failed: ${text(r1)}`);

    // Modern: server/discover, tools/list, tools/call
    const r2 = await modern.modern('server/discover');
    if (!r2?.result?.supportedVersions?.includes('2026-07-28') || !r2.result.capabilities?.tools) {
      throw new Error(`server/discover failed: ${JSON.stringify(r2)}`);
    }
    assertToolList(await modern.modern('tools/list'), 'modern');
    const r3 = await modern.modernTool('add_node', { id: 'modern', type: 'person', properties: { name: 'Modern' } });
    if (!ok(r3)) throw new Error(`modern add_node failed: ${text(r3)}`);

    // Same behaviour in both: data is shared, errors are tool results
    const r4 = await modern.modernTool('get_node', { id: 'legacy' });
    if (!ok(r4)) throw new Error(`modern cannot see legacy node: ${text(r4)}`);

    const r5 = await legacy.tool('get_node', { id: 'modern' });
    if (!ok(r5)) throw new Error(`legacy cannot see modern node: ${text(r5)}`);

    for (const r of [await legacy.tool('no_such_tool'), await modern.modernTool('no_such_tool')]) {
      if (!r?.result?.isError || !text(r).includes('Unknown tool')) throw new Error(`unknown tool: ${JSON.stringify(r)}`);
    }

    const r6 = await modern.modern('prompts/get', { name: 'setup' });
    if (!r6?.result?.messages?.length) throw new Error(`modern prompts/get failed: ${JSON.stringify(r6)}`);

    console.log(` ✓ Protocol eras integration test (${label}) OK`);
  } catch (err) {
    console.error(` ✗ Protocol eras integration test (${label}) FAILED: ${err.message}`);
    if (legacy.stderr) console.error('--- STDERR LEGACY ---\n', legacy.stderr);
    if (modern.stderr) console.error('--- STDERR MODERN ---\n', modern.stderr);
    throw err;
  } finally {
    await Promise.all([legacy.shutdown(), modern.shutdown()]);
    cleanup(dbPath);
  }
}

async function runInstructions(serverPath, label) {
  const dbPath = path.resolve(__dirname, `integration_test_${label}_instructions.duckdb`);
  cleanup(dbPath);

  const legacyInstructions = async (env) => {
    const client = startServer(serverPath, dbPath, env);
    const r = await client.call('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' }
    });
    await client.shutdown();
    return r?.result?.instructions ?? '';
  };

  const modernInstructions = async (env) => {
    const client = startServer(serverPath, dbPath, env);
    const r = await client.modern('server/discover');
    await client.shutdown();
    return r?.result?.instructions ?? '';
  };

  const secret = 'Bootstrap text for the test';

  try {
    // No node yet: point at the tool, even with the switch on
    if (!(await legacyInstructions()).includes('call `bootstrap`')) {
      throw new Error('instructions must point at bootstrap while the node is missing');
    }

    const writer = startServer(serverPath, dbPath);
    await writer.init();
    const r = await writer.tool('add_node', { id: '_bootstrap', type: 'concept', properties: { text: secret } });
    if (!ok(r)) throw new Error(`add_node failed: ${text(r)}`);
    await writer.shutdown();

    // Default: on, in both eras
    for (const read of [legacyInstructions, modernInstructions]) {
      if (!(await read()).includes(secret)) throw new Error('default instructions must contain the node');
    }

    // Off: the node stays out, in both eras
    for (const read of [legacyInstructions, modernInstructions]) {
      const body = await read({ BOOTSTRAP_IN_INSTRUCTIONS: 'false' });
      if (body.includes(secret) || !body.includes('call `bootstrap`')) {
        throw new Error(`switched off instructions are wrong: ${body}`);
      }
    }

    console.log(` ✓ Instructions integration test (${label}) OK`);
  } catch (err) {
    console.error(` ✗ Instructions integration test (${label}) FAILED: ${err.message}`);
    throw err;
  } finally {
    cleanup(dbPath);
  }
}

// ---------------------------------------------------------------------------

const target     = process.argv[2] || 'src';
const serverFile = target === 'dist' ? '../dist/mcp.js' : '../src/mcp.js';
const serverPath = path.resolve(__dirname, serverFile);

try {
  await runSingleSession(serverPath, target);
  await runMultiSession(serverPath, target);
  await runProtocolEras(serverPath, target);
  await runInstructions(serverPath, target);
} catch {
  process.exit(1);
}
