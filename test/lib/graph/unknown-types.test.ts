import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tempMemory } from '../../support/graph'


// Types found only in the data (written before type validation existed):
// schemaOverview() lists them, and a rename with merge: true moves their
// rows into an existing type, or a rename with a definition adopts them.


test('unknown types are listed and migrated by rename, with merge into an existing type', async t => {
    const { memory, direct } = await tempMemory(t)
    await direct.addNode({ id: 'ad1', type: 'architecture-decision', properties: { name: 'AD 1' } })
    await direct.addNode({ id: 'ad2', type: 'architecture-decision', properties: { name: 'AD 2' } })
    await direct.addNode({ id: 's1', type: 'session_summary', properties: { name: 'S 1' } })
    await direct.addEdge({ id: 'le', type: 'legacy_link', source_id: 'ad1', target_id: 's1' })
    await memory.applySchema('nodes:\n  decision:\n    description: A decision\n')

    assert.deepEqual((await memory.schemaOverview()).unknownTypes, { nodes: ['architecture-decision', 'session_summary'], edges: ['legacy_link'] })

    await assert.rejects(memory.applySchema('migrations:\n  - rename_node: { from: architecture-decision, to: decision }\n'), /already exists\. Add merge: true/)
    await assert.rejects(memory.applySchema('migrations:\n  - rename_node: { from: architecture-decision, to: adr }\n'), /define "adr" in the same call/)

    const merged = await memory.applySchema('migrations:\n  - rename_node: { from: architecture-decision, to: decision, merge: true }\n')
    assert.deepEqual(merged.schema.nodes.decision, { description: 'A decision' }, 'the merge target keeps its definition')
    assert.equal(merged.schema.nodes['architecture-decision'], undefined)
    assert.equal(await direct.countNodesByType('architecture-decision'), 0)
    assert.equal(await direct.countNodesByType('decision'), 2)

    await memory.applySchema([
        'migrations:',
        '  - rename_edge: { from: legacy_link, to: summarizes }',
        'nodes:',
        '  session_summary: { description: Summary of a work session }',
        'edges:',
        '  summarizes: { description: Summary covers something }'
    ].join('\n'))
    assert.deepEqual((await memory.schemaOverview()).unknownTypes, { nodes: [], edges: [] })
    assert.equal((await direct.getEdge('le'))?.type, 'summarizes')

    await assert.rejects(memory.applySchema('migrations:\n  - rename_node: { from: ghost, to: decision, merge: true }\n'), /does not exist in current schema or data/)
    await assert.rejects(memory.applySchema('nodes: [unclosed'), /unexpected end|flow collection|missed comma/i, 'a YAML error is reported as it is')
})
