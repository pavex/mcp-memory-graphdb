import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { tempFolder } from '../support/graph'
import { DIST_SERVER, type StdioServer, startStdioServer } from '../support/stdio'


// The built dist/mcp.js as clients run it: a process on stdio with a
// database in a temp folder. The handshake and the tool list, a round trip
// of every tool with the shape of its answers, input checked against the
// schemas, two sessions sharing one database file, both protocol eras, the
// instructions with and without the bootstrap node, a JSON config, a bad
// config stopping the start, and nothing but JSON-RPC on stdout.

const TOOLS = ['add_node', 'update_node', 'delete_node', 'get_node', 'add_edge', 'delete_edge', 'list_edges', 'search', 'dreaming', 'bootstrap', 'get_schema', 'apply_schema']


test('the build: mcp.js with DuckDB, the default schema and the config template', () => {
    for (const file of ['mcp.js', 'duckdb.node', 'schema.default.yaml', 'config.example.json']) {
        assert.ok(existsSync(join(DIST_SERVER, '..', file)), file)
    }
})


test('handshake, the twelve tools with titles and annotations, the prompt setup', async t => {
    const server = start(t, database(t))
    const answer = await server.initialize()
    assert.deepEqual(answer.result?.serverInfo, { name: 'mcp-memory-graphdb', version: '0.1.0' })
    assert.ok(answer.result?.capabilities.tools)
    assert.ok(answer.result?.capabilities.prompts)
    const tools = (await server.call('tools/list')).result?.tools as { name: string, title: string, inputSchema: any, annotations: any }[]
    assert.deepEqual(tools.map(tool => tool.name), TOOLS)
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
    assert.deepEqual(byName.add_node.inputSchema.required, ['type'], 'fields with defaults stay optional')
    assert.deepEqual(Object.keys(byName.add_node.inputSchema.properties), ['id', 'type', 'labels', 'properties'])
    assert.equal(byName.list_edges.inputSchema.properties.limit.maximum, 200)
    assert.equal(byName.add_node.title, 'Add node')
    assert.equal(byName.search.annotations.readOnlyHint, true)
    assert.equal(byName.delete_node.annotations.destructiveHint, true)
    const prompts = (await server.call('prompts/list')).result?.prompts
    assert.deepEqual(prompts.map((prompt: { name: string }) => prompt.name), ['setup'])
    const setup = await server.call('prompts/get', { name: 'setup' })
    assert.match(setup.result?.messages[0].content.text, /revision 0/)
    await server.stop()
    assert.match(server.stderr(), /mcp-memory-graphdb 0\.1\.0 started, database .+\.duckdb, bootstrap in instructions on/)
    assert.deepEqual(server.noise(), [])
})


test('every tool end to end, with the shape of its answer', async t => {
    const folder = tempFolder(t)
    const server = start(t, join(folder, 'memory.duckdb'))
    await server.initialize()

    const bootstrapMissing = await server.tool('bootstrap')
    assert.equal(bootstrapMissing.data.success, false)
    assert.match(bootstrapMissing.data.message, /No bootstrap node found/)

    const alice = await server.tool('add_node', { id: 'alice', type: 'person', properties: { name: 'Alice' } })
    assert.deepEqual(Object.keys(alice.data), ['success', 'node'], 'no warnings key without warnings')
    assert.equal(alice.data.node.labels, '')
    await server.tool('add_node', { id: 'bob', type: 'person', labels: 'friend', properties: { name: 'Bob' } })
    const warned = await server.tool('add_node', { type: 'person', labels: 'friends', properties: { name: 'C', roles: 'x' } })
    assert.equal(warned.data.warnings.length, 2)

    const edge = await server.tool('add_edge', { source_id: 'alice', target_id: 'bob', type: 'knows' })
    assert.equal(edge.data.edge.type, 'knows')
    assert.deepEqual(edge.data.edge.properties, {})
    assert.equal((await server.tool('list_edges')).data.count, 1)
    assert.equal((await server.tool('search', { query: 'Alice' })).data.nodes[0].id, 'alice')
    assert.equal((await server.tool('get_node', { id: 'bob' })).data.node.labels, 'friend')

    const updated = await server.tool('update_node', { id: 'alice', properties: { city: 'Praha' } })
    assert.deepEqual(updated.data.node.properties, { city: 'Praha' }, 'only the properties sent are echoed')
    assert.deepEqual(Object.keys(updated.data.node), ['id', 'type', 'labels', 'properties', 'updated_at'])

    const schema = await server.tool('get_schema')
    assert.equal(schema.data.revision, 0)
    assert.deepEqual(schema.data.labels, [], 'labels used once are left out')
    assert.equal(schema.data.labels_total, 2)
    assert.equal(schema.data.unknown_types, undefined)
    const applied = await server.tool('apply_schema', { yaml: 'nodes:\n  event:\n    description: "Test event type"\n' })
    assert.equal(applied.data.revision, 1)
    assert.deepEqual(applied.data.added_nodes, ['event'])
    assert.match((await server.tool('get_schema')).data.yaml, /event:/)

    const dreaming = await server.tool('dreaming', { limit: 2 })
    assert.equal(dreaming.data.total, 3)
    assert.equal(dreaming.data.has_more, true)
    assert.equal(dreaming.data.next_offset, 2)
    assert.match(dreaming.data.instructions, /^DREAMING WORKFLOW \(Batch 1\):/)
    const last = await server.tool('dreaming', { limit: 2, offset: 2 })
    assert.equal(last.data.has_more, false)
    assert.equal(last.data.next_offset, null)
    assert.match(last.data.instructions, /Batch 2[\s\S]*dreaming pass complete/)

    assert.deepEqual((await server.tool('delete_edge', { id: edge.data.edge.id })).data, { success: true, id: edge.data.edge.id })
    assert.deepEqual((await server.tool('delete_node', { id: 'bob' })).data, { success: true, id: 'bob' })
    await server.tool('add_node', { id: '_bootstrap', type: 'concept', properties: { text: 'I am Krab.' } })
    assert.equal((await server.tool('bootstrap')).data.bootstrap.properties.text, 'I am Krab.')
    await server.stop()
    assert.ok(existsSync(join(folder, 'schema.yaml')), 'schema.yaml next to the database')
    assert.deepEqual(server.noise(), [])
})


test('errors: input checked against the schema, rules of the graph, unknown tools; the server keeps running', async t => {
    const server = start(t, database(t))
    await server.initialize()
    for (const [name, args] of [['search', {}], ['search', { query: 'x', limit: 'abc' }], ['dreaming', { limit: 0 }], ['get_node', {}], ['list_edges', { limit: 1000 }], ['update_node', { id: 'x' }], ['add_node', { type: 'note', properties: 'oops' }]] as const) {
        const answer = await server.tool(name, args)
        assert.equal(answer.isError, true, `${name} ${JSON.stringify(args)}`)
        assert.match(answer.text, new RegExp(`^Input validation error: Invalid arguments for tool ${name}: `))
    }
    const unknownType = await server.tool('add_node', { type: 'spaceship' })
    assert.equal(unknownType.isError, true)
    assert.match(unknownType.text, /^Error: Unknown node type "spaceship"\. Known types: /)
    assert.equal((await server.tool('get_node', { id: 'nobody' })).text, 'Error: Node not found: nobody')
    assert.equal((await server.tool('add_node', { id: 'dup', type: 'note' })).isError, false)
    assert.match((await server.tool('add_node', { id: 'dup', type: 'note' })).text, /^Error: Node already exists: dup\. /)
    assert.match((await server.tool('apply_schema', { yaml: 'bogus: 1' })).text, /^Error: Invalid schema: /)
    const unknown = await server.call('tools/call', { name: 'no_such_tool', arguments: {} })
    assert.equal(unknown.error?.code, -32602)
    assert.match(unknown.error?.message ?? '', /Tool no_such_tool not found/)
    assert.equal((await server.tool('add_node', { type: 'note' })).isError, false)
    await server.stop()
    assert.doesNotMatch(server.stderr(), /failed:/, 'errors meant for the agent are not logged as server faults')
})


test('two sessions share one database file: interleaved and concurrent writes, schema changes', async t => {
    const path = database(t)
    const a = start(t, path)
    const b = start(t, path)
    await Promise.all([a.initialize(), b.initialize()])

    assert.equal((await a.tool('add_node', { id: 'a1', type: 'person', properties: { name: 'From A' } })).isError, false)
    assert.equal((await b.tool('add_node', { id: 'b1', type: 'person', properties: { name: 'From B' } })).isError, false)
    assert.equal((await a.tool('get_node', { id: 'b1' })).data.node.id, 'b1')
    assert.equal((await b.tool('add_edge', { source_id: 'b1', target_id: 'a1', type: 'knows' })).isError, false)

    const burst = []
    for (let index = 0; index < 10; index++) {
        burst.push(a.tool('add_node', { id: `a_burst_${index}`, type: 'note', properties: { title: `A ${index}` } }))
        burst.push(b.tool('add_node', { id: `b_burst_${index}`, type: 'note', properties: { title: `B ${index}` } }))
    }
    const failed = (await Promise.all(burst)).filter(answer => answer.isError)
    assert.deepEqual(failed.map(answer => answer.text), [])
    assert.equal((await b.tool('search', { query: 'A ', type: 'note', limit: 100 })).data.count, 10)

    assert.equal((await a.tool('apply_schema', { yaml: 'edges:\n  mentors:\n    description: "Test edge type"\n' })).data.revision, 1)
    const seen = await b.tool('get_schema')
    assert.equal(seen.data.revision, 1)
    assert.match(seen.data.yaml, /mentors/)
    assert.equal((await b.tool('apply_schema', { yaml: 'edges:\n  mentored_by:\n    description: "Another test edge type"\n' })).data.revision, 2)
    assert.match((await a.tool('get_schema')).data.yaml, /mentors[\s\S]*mentored_by/)
})


test('both protocol eras from one server build, against one database file', async t => {
    const path = database(t)
    const legacy = start(t, path)
    const modern = start(t, path)
    await legacy.initialize('2024-11-05')
    assert.deepEqual((await legacy.call('tools/list')).result?.tools.map((tool: { name: string }) => tool.name), TOOLS)
    assert.equal((await legacy.tool('add_node', { id: 'legacy', type: 'person' })).isError, false)

    const discover = await modern.modern('server/discover')
    assert.ok(discover.result?.supportedVersions.includes('2026-07-28'))
    assert.ok(discover.result?.capabilities.tools)
    assert.deepEqual((await modern.modern('tools/list')).result?.tools.find((tool: { name: string }) => tool.name === 'add_node').inputSchema.required, ['type'])
    const added = await modern.modern('tools/call', { name: 'add_node', arguments: { id: 'modern', type: 'person' } })
    assert.equal(added.result?.isError, undefined)
    const seen = await modern.modern('tools/call', { name: 'get_node', arguments: { id: 'legacy' } })
    assert.match(seen.result?.content[0].text, /"id": "legacy"/)
    assert.equal((await legacy.tool('get_node', { id: 'modern' })).isError, false)
    assert.ok((await modern.modern('prompts/get', { name: 'setup' })).result?.messages.length)
})


test('instructions: a pointer without the node, the node by default in both eras, a pointer when switched off', async t => {
    const path = database(t)
    const secret = 'Bootstrap text for the test'
    assert.match(await instructions(t, path), /call `bootstrap`/)

    const writer = start(t, path)
    await writer.initialize()
    await writer.tool('add_node', { id: '_bootstrap', type: 'concept', properties: { text: secret } })
    await writer.stop()

    assert.match(await instructions(t, path), new RegExp(secret))
    const modern = start(t, path)
    assert.match((await modern.modern('server/discover')).result?.instructions, new RegExp(secret))
    const off = await instructions(t, path, { BOOTSTRAP_IN_INSTRUCTIONS: 'false' })
    assert.doesNotMatch(off, new RegExp(secret))
    assert.match(off, /call `bootstrap`/)
})


test('a .json config: the database next to it, ${NAME}, the bootstrap key over the environment', async t => {
    const folder = tempFolder(t)
    const config = join(folder, 'config.json')
    const env = { GRAPHDB_TEST_DATA: 'data' }
    const secret = 'Bootstrap text from the config test'
    const writeConfig = (bootstrapInInstructions?: boolean) => writeFileSync(config, JSON.stringify({ database: '${GRAPHDB_TEST_DATA}/from-config.duckdb', bootstrapInInstructions }))

    writeConfig(true)
    const server = start(t, config, env)
    await server.initialize()
    assert.equal((await server.tool('add_node', { id: '_bootstrap', type: 'concept', properties: { text: secret } })).isError, false)
    await server.stop()
    assert.ok(existsSync(join(folder, 'data', 'from-config.duckdb')))
    assert.ok(existsSync(join(folder, 'data', 'schema.yaml')))

    assert.match(await instructions(t, config, { ...env, BOOTSTRAP_IN_INSTRUCTIONS: 'false' }), new RegExp(secret))
    writeConfig(false)
    assert.doesNotMatch(await instructions(t, config, env), new RegExp(secret))
    writeConfig(undefined)
    assert.doesNotMatch(await instructions(t, config, { ...env, BOOTSTRAP_IN_INSTRUCTIONS: 'false' }), new RegExp(secret))
})


test('a bad config stops the server with exit code 1 and one line on stderr', t => {
    const folder = tempFolder(t)
    const env = { ...process.env }
    delete env.GRAPHDB_TEST_UNSET
    const cases = [
        ['unset.json', '{ "database": "${GRAPHDB_TEST_UNSET}/memory.duckdb" }', 'ERROR: Environment variable GRAPHDB_TEST_UNSET is not set (used in config.database)'],
        ['unknown.json', '{ "dbPath": "memory.duckdb" }', 'ERROR: Invalid config: '],
        ['type.json', '{ "bootstrapInInstructions": "no" }', 'ERROR: Invalid config: bootstrapInInstructions: '],
        ['broken.json', '{ "database": ', 'ERROR: Invalid JSON in '],
        ['missing.json', null, 'ERROR: Unable to read config at ']
    ]
    for (const [file, content, expected] of cases) {
        const config = join(folder, file!)
        if (content !== null) {
            writeFileSync(config, content)
        }
        const run = spawnSync(process.execPath, [DIST_SERVER, config], { env, encoding: 'utf8', timeout: 15_000 })
        assert.equal(run.status, 1, file!)
        assert.ok(run.stderr.startsWith(expected!), `${file}: ${run.stderr}`)
        assert.equal(run.stderr.trim().split('\n').length, 1, file!)
    }
})


// A database path in a temp folder.
function database(t: TestContext): string {
    return join(tempFolder(t), 'memory.duckdb')
}


// A server on `arg`, stopped after the test.
function start(t: TestContext, arg: string, env: NodeJS.ProcessEnv = {}): StdioServer {
    const server = startStdioServer(DIST_SERVER, [arg], { env: { ...process.env, ...env } })
    t.after(() => server.stop())
    return server
}


// The instructions of a server started on `arg`, through initialize.
async function instructions(t: TestContext, arg: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
    const server = start(t, arg, env)
    const answer = await server.initialize()
    await server.stop()
    return answer.result?.instructions ?? ''
}
