import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { GraphDatastore, MEMORY_DATABASE } from '../../../src/lib/graph'
import { tempFolder } from '../../support/graph'


// GraphDatastore on its own: the tables, node and edge rows, normalized
// labels, the cascade of deleteNode, transactions, and two datastores sharing
// one file the way two sessions do (the file opens per unit of work).


test('an in-memory database has its tables right after open', async t => {
    const datastore = new GraphDatastore(MEMORY_DATABASE)
    await datastore.open()
    t.after(() => datastore.close())
    assert.equal(await datastore.countAllNodes(), 0)
    assert.deepEqual(await datastore.listEdges({ limit: 10 }), [])
})


test('nodes and edges: add, get, update, delete with cascade', async t => {
    const datastore = new GraphDatastore(MEMORY_DATABASE)
    await datastore.open()
    t.after(() => datastore.close())

    const alice = await datastore.addNode({ id: 'alice', type: 'person', labels: 'ai, memory ,ai', properties: { name: 'Alice' } })
    assert.equal(alice.labels, 'ai memory')
    assert.deepEqual(alice.properties, { name: 'Alice' })
    assert.match(alice.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    const bob = await datastore.addNode({ type: 'person' })
    assert.ok(bob.id)
    assert.deepEqual(bob.properties, {})

    const updated = await datastore.updateNode({ id: 'alice', properties: { age: 31 } })
    assert.deepEqual(updated?.properties, { name: 'Alice', age: 31 })
    assert.equal(updated?.labels, 'ai memory', 'labels left out stay')
    assert.equal(await datastore.updateNode({ id: 'nobody', labels: 'x' }), null)

    const edge = await datastore.addEdge({ type: 'knows', source_id: 'alice', target_id: bob.id, properties: { since: 2024 } })
    assert.deepEqual((await datastore.getEdge(edge.id))?.properties, { since: 2024 })
    assert.equal((await datastore.listEdges({ source_id: 'alice', limit: 10 })).length, 1)
    assert.equal((await datastore.listEdges({ type: 'other', limit: 10 })).length, 0)

    await datastore.deleteNode('alice')
    assert.equal(await datastore.getNode('alice'), null)
    assert.equal((await datastore.listEdges({ limit: 10 })).length, 0, 'edges of a deleted node go too')
})


test('a failing transaction leaves nothing behind', async t => {
    const datastore = new GraphDatastore(MEMORY_DATABASE)
    await datastore.open()
    t.after(() => datastore.close())
    await assert.rejects(datastore.transaction(async () => {
        await datastore.addNode({ id: 'a', type: 'note' })
        throw new Error('stop')
    }), /stop/)
    assert.equal(await datastore.getNode('a'), null)
})


test('two datastores on one file see each other\'s writes', async t => {
    const database = join(tempFolder(t), 'deep', 'shared.duckdb')
    const first = new GraphDatastore(database)
    const second = new GraphDatastore(database)
    await first.open()
    await second.open()
    await first.addNode({ id: 'a', type: 'note' })
    await second.addNode({ id: 'b', type: 'note' })
    assert.equal((await first.getNode('b'))?.id, 'b')
    assert.equal(await second.countAllNodes(), 2)
})
