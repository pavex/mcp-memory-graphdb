import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tempMemory } from '../../support/graph'


// Merging duplicates: dreaming hints names that match after normalization,
// updateNode(merge_from) checks its ids, redirects the edges of the
// duplicates, drops edges that became self-loops or exact duplicates, and
// deletes the duplicates - all in one unit of work.


test('possible duplicates, guards and the merge itself', async t => {
    const { memory, direct } = await tempMemory(t)
    await memory.addNode({ id: 'k', type: 'technology', properties: { name: 'DuckDB', version: '1.5' } })
    await memory.addNode({ id: 'd1', type: 'technology', properties: { name: 'duck-db', note: 'embedded' } })
    await memory.addNode({ id: 'd2', type: 'technology', properties: { name: 'Duck DB' } })
    await memory.addNode({ id: 'x', type: 'project', properties: { name: 'Memory' } })
    await memory.addNode({ id: 'y', type: 'person', properties: { name: 'Pavel' } })
    await memory.addNode({ id: 'z', type: 'person', properties: { name: 'Other' } })
    await memory.addEdge({ source_id: 'x', target_id: 'k', type: 'uses' })
    await memory.addEdge({ source_id: 'x', target_id: 'd1', type: 'uses' }) // a duplicate of x-uses-k
    await memory.addEdge({ source_id: 'y', target_id: 'd1', type: 'knows' }) // redirected
    await memory.addEdge({ source_id: 'd1', target_id: 'k', type: 'relates_to' }) // a self-loop
    await memory.addEdge({ source_id: 'd2', target_id: 'd1', type: 'relates_to' }) // a self-loop
    await memory.addEdge({ source_id: 'd2', target_id: 'x', type: 'part_of' }) // redirected

    const page = await memory.dreaming(10, 0, 10)
    const byId = Object.fromEntries(page.nodes.map(node => [node.id, node]))
    assert.deepEqual(byId.k.possible_duplicates, ['d1', 'd2'])
    assert.deepEqual(byId.d1.possible_duplicates, ['d2', 'k'])
    assert.equal(byId.y.possible_duplicates, undefined, 'different names are not hinted')
    assert.equal(byId.x.possible_duplicates, undefined)

    await assert.rejects(memory.updateNode({ id: 'k', merge_from: ['k'] }), /must not contain the kept node/)
    await assert.rejects(memory.updateNode({ id: 'k', merge_from: ['nope'] }), /Node not found \(merge_from\): nope/)
    await assert.rejects(memory.updateNode({ id: 'nope', merge_from: ['d1'] }), /Node not found: nope/)

    const merged = await memory.updateNode({ id: 'k', properties: { note: 'Embedded analytical database' }, merge_from: ['d1', 'd2', 'd1'] })
    assert.equal(merged.node.properties.version, '1.5', 'existing properties are kept')
    assert.equal(merged.node.properties.note, 'Embedded analytical database')
    assert.deepEqual(merged.merge, { merged_ids: ['d1', 'd2'], redirected_edges: 2, dropped_duplicate_edges: 1, dropped_self_loops: 2 })
    assert.equal(await memory.findNode('d1'), null)
    assert.equal(await memory.findNode('d2'), null)
    const edges = (await direct.listEdges({ limit: 100 })).map(edge => `${edge.source_id}-${edge.type}-${edge.target_id}`).sort()
    assert.deepEqual(edges, ['k-part_of-x', 'x-uses-k', 'y-knows-k'])
})
