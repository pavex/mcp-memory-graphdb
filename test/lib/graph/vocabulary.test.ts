import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRelated, isSimilar, normalizeLabels } from '../../../src/lib/graph'
import { tempMemory } from '../../support/graph'


// Labels and the vocabulary: normalization on every write, the similarity of
// names (variants, not synonyms), warnings for new labels resembling existing
// ones, and the counts schemaOverview() returns.


test('normalizeLabels: separators, duplicates ignoring case, spaces inside a label', () => {
    assert.equal(normalizeLabels(' ai, DuckDB ,,ai , AI,memory '), 'ai DuckDB memory')
    assert.equal(normalizeLabels('reabr  schema3\tfix reabr'), 'reabr schema3 fix')
    assert.equal(normalizeLabels(['x', ' y ', '', 'X', 'two words']), 'x y two-words')
    assert.equal(normalizeLabels(''), '')
    assert.equal(normalizeLabels(undefined), '')
})


test('isSimilar: plural, prefix/suffix and one-typo variants; not deliberate versions', () => {
    const similar = [['fixes', 'fix'], ['fix', 'bugfix'], ['bugs', 'bugfix'], ['agent', 'agents'], ['code-review', 'review'],
    ['findings', 'finding'], ['pavel-ines-cz', 'pavel-ines'], ['renaming', 'naming'], ['archtecture', 'architecture']]
    for (const [a, b] of similar) {
        assert.ok(isSimilar(a, b), `${a} ~ ${b} expected similar`)
    }
    const different = [['schema', 'schema-parser'], ['encoder', 'decoder'], ['web', 'website-tools'], ['mcp', 'mcp-google-gemini'],
    ['php', 'pdo'], ['ai', 'api'], ['schema', 'schema3'], ['status_update_5', 'status_update_4'],
    ['status_update_2', 'status_update'], ['vcl4_status', 'status'], ['vcl1_history', 'history']]
    for (const [a, b] of different) {
        assert.ok(!isSimilar(a, b), `${a} ~ ${b} expected different`)
    }
})


test('isRelated: a shared whole word', () => {
    for (const [a, b] of [['static-export', 'static-site'], ['framework-finding', 'findings'], ['schema-foo', 'schema-parser'], ['ines', 'pavel-ines']]) {
        assert.ok(isRelated(a, b), `${a} ~ ${b} expected related`)
    }
    for (const [a, b] of [['vcl4-status', 'vcl4-history'], ['ai-tools', 'ai'], ['static', 'dynamic']]) {
        assert.ok(!isRelated(a, b), `${a} ~ ${b} expected unrelated`)
    }
})


test('labels normalized on write, counted by schemaOverview, new similar or related labels warn', async t => {
    const { memory } = await tempMemory(t)
    assert.equal((await memory.addNode({ id: 'a', type: 'topic', labels: 'ai, memory ,ai', properties: { name: 'A' } })).node.labels, 'ai memory')
    assert.equal((await memory.addNode({ id: 'b', type: 'topic', labels: ['ai', 'graph'], properties: { name: 'B' } })).node.labels, 'ai graph')
    await memory.addNode({ id: 'c', type: 'note', properties: { title: 'C' } })
    assert.equal((await memory.updateNode({ id: 'c', labels: ' graph ' })).node.labels, 'graph')

    const overview = await memory.schemaOverview()
    assert.deepEqual(overview.nodeCounts, { note: 1, topic: 2 })
    assert.deepEqual(overview.labels, [{ label: 'ai', count: 2 }, { label: 'graph', count: 2 }, { label: 'memory', count: 1 }])
    assert.equal(overview.revision, 0)
    assert.match(overview.yaml, /^revision: 0\n/)

    const similar = await memory.addNode({ type: 'note', labels: 'graphs memory brand-new', properties: { title: 'W' } })
    assert.equal(similar.warnings.length, 1, 'only the similar new label warns (memory is known, brand-new has no match)')
    assert.match(similar.warnings[0], /label "graphs" is new - similar existing: graph \(2\)/)
    assert.deepEqual((await memory.addNode({ type: 'note', labels: 'ai graph', properties: { title: 'W2' } })).warnings, [])
    assert.match((await memory.updateNode({ id: 'c', labels: 'graph memorys' })).warnings[0], /label "memorys" is new - similar existing: memory/)

    await memory.addNode({ type: 'note', labels: 'static-site', properties: { title: 'R1' } })
    assert.deepEqual((await memory.addNode({ type: 'note', labels: 'static-export', properties: { title: 'R2' } })).warnings, [
        'label "static-export" is new - related existing: static-site (1). Reuse one of them if it means the same.'
    ])
    assert.match((await memory.addNode({ type: 'note', labels: 'static-sites', properties: { title: 'R3' } })).warnings[0], /label "static-sites" is new - similar existing: static-site/, 'similar wins over related')
})
