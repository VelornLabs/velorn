import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_PROJECT_STARTERS, CONTINUE_PROJECT_STARTER, hasExistingAgentProjectWork, stageAgentProjectStarter } from './agentProjectStarters.mjs'
import { createProduction } from './production.mjs'

test('six optional starters have unique IDs and plain conversational prompts', () => {
  assert.deepEqual(AGENT_PROJECT_STARTERS.map(item => item.label), ['Music video', 'UGC', 'Commercial', 'Short film', 'Edit my project', 'Freeform'])
  assert.equal(new Set(AGENT_PROJECT_STARTERS.map(item => item.id)).size, 6)
  for (const starter of [...AGENT_PROJECT_STARTERS, CONTINUE_PROJECT_STARTER]) {
    const result = stageAgentProjectStarter({ id: starter.id })
    assert.deepEqual(result, { success: true, text: starter.prompt, starterText: starter.prompt })
    assert.ok(starter.prompt.length < 400)
    assert.deepEqual(Object.keys(result), ['success', 'text', 'starterText'])
  }
})
test('Freeform invites open-ended work without a chat-only restriction or permission flags', () => {
  const starter = AGENT_PROJECT_STARTERS.find(item => item.id === 'chat')
  assert.equal(starter.hint, 'Generate, edit, or explore—your way.')
  assert.deepEqual(stageAgentProjectStarter({ id: starter.id }), {
    success: true,
    text: "Let's work freely. I'll tell you what I need as we go.",
    starterText: "Let's work freely. I'll tell you what I need as we go.",
  })
})
test('switching an untouched starter replaces only its generated draft', () => {
  const first = stageAgentProjectStarter({ id: 'music-video' })
  const second = stageAgentProjectStarter({ id: 'short-film', draft: first.text, previousStarterText: first.starterText })
  assert.equal(second.text, AGENT_PROJECT_STARTERS.find(item => item.id === 'short-film').prompt)
})
test('edited or unrelated draft text is preserved exactly and duplicate clicks do not append again', () => {
  const first = stageAgentProjectStarter({ id: 'music-video' })
  const draft = `${first.text}\nI want local generation only.  `
  const second = stageAgentProjectStarter({ id: 'short-film', draft, previousStarterText: first.text })
  assert.ok(second.text.startsWith(`${draft}\n\n`)); assert.equal(second.starterText, '')
  assert.equal(stageAgentProjectStarter({ id: 'short-film', draft: second.text }).text, second.text)
})
test('unknown IDs and oversized drafts are rejected rather than truncated', () => {
  assert.equal(stageAgentProjectStarter({ id: 'allow-full-access' }).success, false)
  assert.equal(stageAgentProjectStarter({ id: 'edit', draft: 'x'.repeat(11999) }).success, false)
})
test('a named but empty new project does not imply existing creative work', () => {
  const project = { name: 'My new film', timelines: [{ id: 'default', clips: [] }] }
  assert.equal(hasExistingAgentProjectWork({ project }), false)
  assert.equal(hasExistingAgentProjectWork({}), false)
})
test('existing media, clips, extra timelines and authored storyboards show a project-aware welcome', () => {
  assert.equal(hasExistingAgentProjectWork({ project: {}, assets: [{ id: 'song' }] }), true)
  assert.equal(hasExistingAgentProjectWork({ project: {}, clips: [{ id: 'clip' }] }), true)
  assert.equal(hasExistingAgentProjectWork({ project: { timelines: [{}, {}] } }), true)
  assert.equal(hasExistingAgentProjectWork({ project: { storyboard: { version: 1, title: 'My story', shots: [] } } }), true)
})
test('old default production fields alone do not turn a new project into an existing production', () => {
  const project = { storyboard: { version: 1, title: 'Storyboard', production: createProduction('music-video'), shots: [] } }
  const before = JSON.stringify(project)
  assert.equal(hasExistingAgentProjectWork({ project }), false)
  assert.equal(JSON.stringify(project), before)
})
