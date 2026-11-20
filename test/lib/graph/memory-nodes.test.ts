import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GraphError } from '../../../src/lib/graph'
import { tempMemory } from '../../support/graph'


// GraphMemory's node and edge operations over the default schema: types must
// be in the schema, nodes must exist, property keys resembling existing ones
// warn, and every operation runs in its own unit of work, one after another.


test('nodes: add, get, update with merged properties, delete with its edges', async t => {
    const { memory } = await tempMemory(t)

    const alice = await memory.addNode({ id: 'alice', type: 'person', properties: { name: 'Alice', age: 30 } })
    assert.equal(alice.node.id, 'alice')
    assert.deepEqual(alice.warnings, [], 'a new property unrelated to existing keys does not warn')
    await assert.rejects(memory.addNode({ type: 'spaceship', properties: { name: 'X' } }), /Unknown node type "spaceship"/)
    const bob = await memory.addNode({ type: 'person', properties: { name: 'Bob' } })
    assert.ok(bob.node.id)
    assert.equal((await memory.getNode('alice')).id, 'alice')
    await assert.rejects(memory.getNode('nobody'), (error: Error) => error instanceof GraphError && error.message === 'Node not found: nobody')
    assert.equal(await memory.findNode('nobody'), null)

    const updated = await memory.updateNode({ id: 'alice', properties: { age: 31, city: 'Praha' } })
    assert.deepEqual(updated.warnings, [], 'free-form properties do not warn')
    assert.deepEqual(updated.node.properties, { name: 'Alice', age: 31, city: 'Praha' })
    await assert.rejects(memory.updateNode({ id: 'nobody', labels: 'x' }), /Node not found: nobody/)

    await memory.addEdge({ source_id: 'alice', target_id: bob.node.id, type: 'knows' })
    await memory.deleteNode('alice')
    await assert.rejects(memory.getNode('alice'), /Node not found/)
    assert.equal((await memory.listEdges({ limit: 10 })).length, 0)
    await assert.rejects(memory.deleteNode('alice'), /Node not found: alice/)
})


test('property keys resembling declared or used keys warn', async t => {
    const { memory } = await tempMemory(t)
    await memory.addNode({ type: 'person', properties: { name: 'A', city: 'Praha' } })
    const first = await memory.addNode({ type: 'person', properties: { name: 'P', roles: 'dev', 'note-career': 'x' } })
    assert.deepEqual(first.warnings, ['property "roles" is new - similar existing: role. Reuse one of them unless the new property is really different.'])
    const second = await memory.updateNode({ id: first.node.id, properties: { note_career: 'y', citty: 'Brno' } })
    assert.equal(second.warnings.length, 2)
    assert.match(second.warnings[0], /property "note_career" is new - similar existing: note-career \(1\)/)
    assert.match(second.warnings[1], /property "citty" is new - similar existing: city \(1\)/)
})


test('edges: add between existing nodes of a known type, list, delete', async t => {
    const { memory } = await tempMemory(t)
    await memory.addNode({ id: 'alice', type: 'person' })
    await memory.addNode({ id: 'bob', type: 'person' })

    const knows = await memory.addEdge({ source_id: 'alice', target_id: 'bob', type: 'knows', properties: { since: 2024 } })
    const custom = await memory.addEdge({ id: 'e-rel', source_id: 'alice', target_id: 'bob', type: 'relates_to' })
    assert.equal(custom.id, 'e-rel')
    await assert.rejects(memory.addEdge({ source_id: 'alice', target_id: 'bob', type: 'colleague' }), /Unknown edge type "colleague"/)
    await assert.rejects(memory.addEdge({ source_id: 'alice', target_id: 'nobody', type: 'knows' }), /Node not found \(target_id\): nobody/)
    await assert.rejects(memory.addEdge({ source_id: 'nobody', target_id: 'alice', type: 'knows' }), /Node not found \(source_id\): nobody/)

    assert.equal((await memory.listEdges({ limit: 50 })).length, 2)
    assert.equal((await memory.listEdges({ source_id: 'alice', limit: 50 })).length, 2)
    assert.deepEqual((await memory.listEdges({ type: 'knows', limit: 50 })).map(edge => edge.id), [knows.id])
    assert.equal((await memory.listEdges({ limit: 1 })).length, 1)

    await memory.deleteEdge(knows.id)
    assert.equal((await memory.listEdges({ type: 'knows', limit: 50 })).length, 0)
    await assert.rejects(memory.deleteEdge(knows.id), /Edge not found/)
})


test('search: text inside properties, optional type, limit', async t => {
    const { memory } = await tempMemory(t)
    await memory.addNode({ id: 'alice', type: 'person', properties: { name: 'Alice' } })
    await memory.addNode({ id: 'bob', type: 'person', properties: { name: 'Bob' } })
    await memory.addNode({ id: 'note', type: 'note', properties: { title: 'about bob' } })
    assert.deepEqual((await memory.search({ query: 'alice', limit: 20 })).map(node => node.id), ['alice'])
    assert.deepEqual((await memory.search({ query: 'Bob', type: 'person', limit: 20 })).map(node => node.id), ['bob'])
    assert.equal((await memory.search({ query: 'bob', limit: 20 })).length, 2)
    assert.equal((await memory.search({ query: 'bob', limit: 1 })).length, 1)
    assert.equal((await memory.search({ query: 'xyz_nonexistent', limit: 20 })).length, 0)
})


test('operations started at once run one after another; a failure does not block the next', async t => {
    const { memory } = await tempMemory(t)
    const results = await Promise.allSettled([
        ...Array.from({ length: 10 }, (_, index) => memory.addNode({ id: `n${index}`, type: 'note' })),
        memory.addNode({ type: 'spaceship' }),
        memory.search({ query: 'x', limit: 5 })
    ])
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    assert.equal((await memory.dreaming(10, 0, 1)).total, 10)
})
