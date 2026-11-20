import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setupPrompt } from '../../src/prompts/SetupPrompt'


// The setup prompt: a fresh schema asks whether to keep it, a later revision
// what to change; both carry the schema summary and the rules of apply_schema.


test('revision 0 asks whether to keep the default schema', () => {
    const prompt = setupPrompt({ revision: 0, summary: 'Schema revision 0' })
    assert.equal(prompt.messages.length, 1)
    assert.equal(prompt.messages[0].role, 'user')
    assert.match(prompt.messages[0].content.text, /initialized with a default schema \(revision 0\)/)
    assert.match(prompt.messages[0].content.text, /use it as-is/)
    assert.match(prompt.messages[0].content.text, /```\nSchema revision 0\n```/)
})


test('a later revision asks what to add or change', () => {
    const text = setupPrompt({ revision: 3, summary: 'S' }).messages[0].content.text
    assert.match(text, /running schema revision 3/)
    assert.match(text, /what they would like to add or change/)
    assert.match(text, /merge: true/)
})
