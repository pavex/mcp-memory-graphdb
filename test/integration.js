/**
 * Raw JSON-RPC integration test for mcp-memory-graphdb.
 * No SDK on the client side — pure stdio piping.
 *
 * Requests are sent sequentially — each waits for a response before
 * sending the next. DuckDB is async and parallel writes corrupt data.
 *
 * Shutdown strategy: close stdin → server gets EOF → exits cleanly →
 * DuckDB connection closed via process.on('exit') in mcp.js.
 * We wait for the 'close' event before deleting the DB file.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runTest(serverPath, label) {
  const dbPath = path.resolve(__dirname, `integration_test_${label}.duckdb`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  return new Promise((resolve, reject) => {
    const server = spawn('node', [serverPath, dbPath]);
    let errorOutput = '';
    let buffer = '';
    const pending = new Map(); // id → { resolve, reject }
    const notifications = [];

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
            const { resolve } = pending.get(msg.id);
            pending.delete(msg.id);
            resolve(msg);
          } else {
            notifications.push(msg);
          }
        } catch (e) { /* ignore parse errors */ }
      }
    });

    server.stderr.on('data', (data) => { errorOutput += data.toString(); });

    server.on('close', () => {
      for (const f of [dbPath, `${dbPath}.wal`, path.join(path.dirname(dbPath), 'schema.yaml')]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    });

    // Send a request and wait for the response
    let nextId = 1;
    const call = (method, params = {}) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { resolve: res, reject: rej });
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

    const notify = (method, params = {}) => {
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    };

    const shutdown = () => new Promise((res) => {
      server.on('close', res);
      server.stdin.end();
    });

    const text = (resp) => resp?.result?.content?.[0]?.text ?? '';
    const ok   = (resp) => text(resp).includes('"success": true');

    async function run() {
      // 1. Handshake
      const init = await call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '1.0.0' }
      });
      if (!init?.result?.protocolVersion) throw new Error('Handshake failed');
      notify('notifications/initialized');

      // 2. add_node alice
      const r2 = await call('tools/call', { name: 'add_node', arguments: { id: 'alice', type: 'person', properties: { name: 'Alice' } } });
      if (!ok(r2) || !text(r2).includes('"alice"')) throw new Error('add_node alice failed');

      // 3. add_node bob
      const r3 = await call('tools/call', { name: 'add_node', arguments: { id: 'bob', type: 'person', properties: { name: 'Bob' } } });
      if (!ok(r3) || !text(r3).includes('"bob"')) throw new Error('add_node bob failed');

      // 4. add_edge
      const r4 = await call('tools/call', { name: 'add_edge', arguments: { source_id: 'alice', target_id: 'bob', type: 'knows' } });
      if (!ok(r4) || !text(r4).includes('"knows"')) throw new Error('add_edge failed');

      // 5. search
      const r5 = await call('tools/call', { name: 'search', arguments: { query: 'Alice' } });
      if (!ok(r5) || !text(r5).includes('"alice"')) throw new Error('search failed');

      // 6. list_edges
      const r6 = await call('tools/call', { name: 'list_edges', arguments: {} });
      if (!ok(r6) || !text(r6).includes('"knows"')) throw new Error('list_edges failed');

      // 7. get_schema — default schema must be present (revision 0, fresh DB)
      const r7 = await call('tools/call', { name: 'get_schema', arguments: {} });
      if (!ok(r7) || !text(r7).includes('"revision": 0')) throw new Error('get_schema failed (expected revision 0)');

      // 8. apply_schema — add a brand new node type
      const r8 = await call('tools/call', {
        name: 'apply_schema',
        arguments: { yaml: 'nodes:\n  event:\n    description: "Test event type"\n    properties:\n      name: string\n' }
      });
      if (!ok(r8) || !text(r8).includes('"revision": 1') || !text(r8).includes('"event"')) {
        throw new Error('apply_schema (add node) failed');
      }

      // 9. get_schema again — must reflect revision 1 and the new type, on a fresh read
      const r9 = await call('tools/call', { name: 'get_schema', arguments: {} });
      if (!ok(r9) || !text(r9).includes('"revision": 1') || !text(r9).includes('event:')) {
        throw new Error('get_schema after apply_schema did not reflect new state');
      }

      await shutdown();
      console.log(` ✓ Integration test (${label}) OK`);
    }

    run().then(resolve).catch(async (err) => {
      console.error(` ✗ Integration test (${label}) FAILED: ${err.message}`);
      if (errorOutput) console.error('--- STDERR ---\n', errorOutput);
      await shutdown().catch(() => {});
      reject(err);
    });
  });
}

const target     = process.argv[2] || 'src';
const serverFile = target === 'dist' ? '../dist/mcp.js' : '../src/mcp.js';
const serverPath = path.resolve(__dirname, serverFile);

runTest(serverPath, target).catch(() => process.exit(1));
