import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildInstructions, MAX_LENGTH, renderInstructions } from '../../src/instructions/ServerInstructions'


// The MCP instructions: a pointer to the bootstrap tool without a node, the
// node's text inlined otherwise, cut at MAX_LENGTH, and a read that fails or
// hangs never holding up the start.


test('without a node the instructions point at the bootstrap tool', () => {
    assert.match(renderInstructions(null), /call `bootstrap`/)
})


test('the node is inlined: its text trimmed, other properties as JSON', () => {
    const inline = renderInstructions({ properties: { text: '  I am Krab.  ' } })
    assert.ok(inline.endsWith('I am Krab.'))
    assert.match(inline, /No `bootstrap` call is needed/)
    assert.match(renderInstructions({ properties: { role: 'helper' } }), /"role": "helper"/)
})


test('cut at MAX_LENGTH with a note, only when needed', () => {
    const exact = renderInstructions({ properties: { text: 'x' } })
    const fits = 'y'.repeat(MAX_LENGTH - exact.length + 1)
    assert.equal(renderInstructions({ properties: { text: fits } }).length, MAX_LENGTH)
    assert.doesNotMatch(renderInstructions({ properties: { text: fits } }), /Truncated/)
    const cut = renderInstructions({ properties: { text: 'y'.repeat(MAX_LENGTH * 2) } })
    assert.equal(cut.length, MAX_LENGTH)
    assert.ok(cut.endsWith('Call `bootstrap` for the full text.]'))
})


test('a missing node, a failed read or a hung read give the pointer', async () => {
    const pointer = renderInstructions(null)
    assert.equal(await buildInstructions(Promise.resolve(null)), pointer)
    assert.equal(await buildInstructions(Promise.reject(new Error('locked'))), pointer)
    assert.equal(await buildInstructions(new Promise(() => undefined), 10), pointer)
})
