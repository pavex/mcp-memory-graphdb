import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { GraphSchema } from '../../../src/lib/graph'
import { DEFAULT_SCHEMA, tempFolder, tempSchema } from '../../support/graph'


// GraphSchema.apply(): validation, additions as patches, renames that move
// the rows, removals only of empty types, the YAML on disk replaced
// atomically, restore() of a snapshot, an empty file, and reload() picking
// up another session's change.


test('the default schema is written as revision 0', async t => {
    const { schema } = await tempSchema(t)
    assert.equal(schema.exists(), false)
    assert.equal((await schema.initDefault()).revision, 0)
    assert.ok(existsSync(schema.path))
    assert.ok(schema.get()?.nodes.person)
})


test('apply: invalid shapes rejected, additions patch, renames move rows, removals need an empty type', async t => {
    const { datastore, schema } = await tempSchema(t)
    await schema.initDefault()

    await assert.rejects(schema.apply({ bogus_key: true }), /Invalid schema/)
    await assert.rejects(schema.apply({ nodes: { widget: {} } }), /Invalid schema/)
    await assert.rejects(schema.apply({}), /at least one of: nodes, edges, migrations/)

    const added = await schema.apply({ nodes: { widget: { description: 'A test widget', properties: { name: 'string' } } } })
    assert.equal(added.schema.revision, 1)
    assert.deepEqual(added.diff.addedNodes, ['widget'])
    assert.ok(added.schema.nodes.project, 'existing types survive untouched')

    const patched = await schema.apply({ nodes: { another_widget: { description: 'Yet another test type' } } })
    assert.equal(patched.schema.revision, 2)
    assert.ok(patched.schema.nodes.project, 'omitting a type from nodes: never removes it')
    assert.ok(patched.schema.nodes.widget)

    const renamed = await schema.apply({ migrations: [{ rename_node: { from: 'widget', to: 'gadget' } }] })
    assert.equal(renamed.schema.revision, 3)
    assert.ok(!renamed.schema.nodes.widget)
    assert.deepEqual(renamed.schema.nodes.gadget, { description: 'A test widget', properties: { name: 'string' } })
    assert.deepEqual(renamed.diff.renamedNodes, [{ from: 'widget', to: 'gadget' }])
    assert.deepEqual(renamed.diff.addedNodes, [], 'a rename target is never reported as added')
    await assert.rejects(schema.apply({ migrations: [{ rename_node: { from: 'nope', to: 'whatever' } }] }), /does not exist/)

    const gadget = await datastore.addNode({ type: 'gadget', properties: { name: 'Test Gadget' } })
    await assert.rejects(schema.apply({ migrations: [{ remove_node: { type: 'gadget' } }] }), /still has 1 node\(s\)/)
    await schema.apply({ migrations: [{ rename_node: { from: 'gadget', to: 'thingamajig' } }] })
    assert.equal(await datastore.countNodesByType('gadget'), 0)
    assert.equal(await datastore.countNodesByType('thingamajig'), 1)
    await assert.rejects(schema.apply({ migrations: [{ remove_node: { type: 'thingamajig' } }] }), /still has 1 node\(s\)/, 'a rename moves the rows, it does not delete them')
    await datastore.deleteNode(gadget.id)
    const removed = await schema.apply({ migrations: [{ remove_node: { type: 'thingamajig' } }] })
    assert.ok(!removed.schema.nodes.thingamajig)
    assert.deepEqual(removed.diff.removedNodes, ['thingamajig'])

    const edge = await schema.apply({ migrations: [{ rename_edge: { from: 'uses', to: 'utilizes' } }] })
    assert.ok(!edge.schema.edges.uses)
    assert.ok(edge.schema.edges.utilizes)

    assert.match(schema.toYaml(), /revision:/)
    assert.match(schema.toYaml(), /utilizes/)
    await schema.apply({ nodes: { quoted: { description: 'needs: quotes' } } })
    assert.match(schema.toYaml(), /"needs: quotes"/, 'strings that need quoting are double-quoted')
    assert.match(schema.summarize(), /^Schema revision \d+\n\nNode types:\n {2}project: /)
})


test('a rename onto itself is refused and leaves the schema as it was', async t => {
    const { datastore, schema } = await tempSchema(t)
    await schema.initDefault()
    await datastore.addNode({ type: 'concept' })
    for (const migration of [{ rename_node: { from: 'concept', to: 'concept' } }, { rename_node: { from: 'concept', to: 'concept', merge: true } }, { rename_edge: { from: 'uses', to: 'uses' } }]) {
        await assert.rejects(schema.apply({ migrations: [migration] }), /"from" and "to" are the same type/)
    }
    assert.equal(schema.get()?.revision, 0)
    assert.ok(schema.get()?.nodes.concept)
    assert.equal(await datastore.countNodesByType('concept'), 1)
})


test('schema.yaml is replaced atomically - no temporary files are left - and restore() puts a snapshot back', async t => {
    const { schema } = await tempSchema(t)
    await schema.initDefault()
    const snapshot = schema.snapshot()
    await schema.apply({ nodes: { widget: { description: 'A widget' } } })
    assert.deepEqual(readdirSync(dirname(schema.path)), ['schema.yaml'])
    assert.match(readFileSync(schema.path, 'utf8'), /^revision: 1\n/)

    await schema.restore(snapshot)
    assert.equal(readFileSync(schema.path, 'utf8'), snapshot)
    assert.equal(schema.get()?.revision, 0)
    assert.equal(schema.get()?.nodes.widget, undefined)
    await schema.restore(schema.snapshot())
    assert.equal(schema.reload()?.revision, 0, 'an unchanged snapshot writes nothing')
})


test('an empty schema.yaml loads as no schema', async t => {
    const { datastore } = await tempSchema(t)
    const path = join(tempFolder(t), 'schema.yaml')
    writeFileSync(path, '')
    assert.equal(new GraphSchema(path, DEFAULT_SCHEMA, datastore).load(), undefined)
})


test('reload() picks up a change another session saved', async t => {
    const { datastore, schema } = await tempSchema(t)
    await schema.initDefault()
    const other = new GraphSchema(schema.path, DEFAULT_SCHEMA, datastore)
    other.load()
    await other.apply({ edges: { mentors: { description: 'Test edge type' } } })
    assert.equal(schema.get()?.revision, 0)
    assert.equal(schema.reload()?.revision, 1)
    assert.ok(schema.get()?.edges.mentors)
})
