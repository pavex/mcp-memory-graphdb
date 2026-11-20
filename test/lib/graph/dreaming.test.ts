import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tempMemory } from '../../support/graph'


// GraphMemory.dreaming(): pages that cover every node once, nodes grouped by
// type, each node's nearest edges in both directions capped at edgeCap with
// the rest counted.


test('an empty graph gives an empty page', async t => {
    const { memory } = await tempMemory(t)
    assert.deepEqual(await memory.dreaming(10, 0, 10), { total: 0, nodes: [] })
})


test('pages cover every node exactly once, grouped by type', async t => {
    const { memory } = await tempMemory(t)
    for (let index = 0; index < 5; index++) {
        await memory.addNode({ type: 'person', properties: { name: `Person ${index}` } })
    }
    await memory.addNode({ type: 'project', properties: { name: 'Solo Project' } })
    const first = await memory.dreaming(2, 0, 10)
    assert.equal(first.total, 6)
    assert.equal(first.nodes.length, 2)

    const seen = new Set<string>()
    for (let offset = 0; offset < 6; offset += 2) {
        for (const node of (await memory.dreaming(2, offset, 10)).nodes) {
            seen.add(node.id)
        }
    }
    assert.equal(seen.size, 6)

    const types = (await memory.dreaming(10, 0, 10)).nodes.map(node => node.type)
    assert.ok(types.indexOf('project') > types.lastIndexOf('person'), 'nodes of one type are grouped, ordered by type')
})


test('each node carries its edges both ways, capped, with the rest counted', async t => {
    const { memory } = await tempMemory(t)
    await memory.addNode({ id: 'person', type: 'person', properties: { name: 'P' } })
    await memory.addNode({ id: 'project', type: 'project', properties: { name: 'X' } })
    await memory.addEdge({ source_id: 'person', target_id: 'project', type: 'works_on' })

    const page = await memory.dreaming(10, 0, 10)
    const person = page.nodes.find(node => node.id === 'person')!
    assert.deepEqual(person.edges, { out: [{ direction: 'out', type: 'works_on', other_id: 'project', other_type: 'project' }], in: [], out_more: 0, in_more: 0 })
    const project = page.nodes.find(node => node.id === 'project')!
    assert.deepEqual(project.edges.in, [{ direction: 'in', type: 'works_on', other_id: 'person', other_type: 'person' }])

    for (let index = 0; index < 4; index++) {
        const note = await memory.addNode({ type: 'note', properties: { title: `Note ${index}` } })
        await memory.addEdge({ source_id: 'person', target_id: note.node.id, type: 'relates_to' })
    }
    const capped = (await memory.dreaming(10, 0, 3)).nodes.find(node => node.id === 'person')!
    assert.equal(capped.edges.out.length, 3)
    assert.equal(capped.edges.out_more, 2)
})
