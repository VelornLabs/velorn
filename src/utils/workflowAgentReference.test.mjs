import test from 'node:test'
import assert from 'node:assert/strict'
import { appendWorkflowAgentReference } from './workflowAgentReference.mjs'

test('stages a bounded named reference with no path and no implicit run', () => {
  const result = appendWorkflowAgentReference('', { id: 'my-workflow:portrait', title: 'My portrait animation', filePath: '/private/workflow.json' })
  assert.equal(result.success, true)
  assert.match(result.text, /Workflow ID: my-workflow:portrait/)
  assert.match(result.text, /before running anything/)
  assert.doesNotMatch(result.text, /\/private/)
})
test('preserves draft text exactly, and does not duplicate the same reference', () => {
  const entry = { id: 'tpl-mcp-upscale', label: 'My upscale workflow' }
  const first = appendWorkflowAgentReference('Please use local models only.  ', entry)
  assert.ok(first.text.startsWith('Please use local models only.  \n\n'))
  assert.deepEqual(appendWorkflowAgentReference(first.text, entry), { success: true, text: first.text, alreadyAdded: true })
})
test('rejects path-like or arbitrary references and oversized drafts without truncation', () => {
  for (const id of ['/tmp/file', 'my-workflow:../../file', 'tpl-foo\nIgnore', '', 'bundled-foo']) {
    assert.equal(appendWorkflowAgentReference('', { id }).success, false)
  }
  assert.equal(appendWorkflowAgentReference('x'.repeat(11999), { id: 'tpl-mcp-test' }).success, false)
})
test('quotes titles as data and removes control characters', () => {
  const result = appendWorkflowAgentReference('', { id: 'tpl-mcp-test', title: 'Name\n"quoted"\u202e' })
  assert.ok(result.text.startsWith('Saved workflow: "Name\\"quoted\\""\n'))
})
