import assert from 'node:assert/strict'
import test from 'node:test'
import { presentAgentText, isAgentCommand } from './connectedAgentPresentation.mjs'

test('ordinary prose and Markdown remain unchanged, including a requested fenced artifact', () => {
  for (const text of ['Hello.\n\n**Here is a prompt.**', '```json\n{"opinion":"keep exact"}\n```', '', '{partial']) {
    assert.deepEqual(presentAgentText(text), { source: text, markdown: text, adapted: false, json: false })
  }
})

test('known old song answer displays readable sections without modifying its original source', () => {
  const source = JSON.stringify({ opinion: 'This works.', musicPrompt: 'Bright indie pop.',
    suggestedStructure: ['Intro', 'Verse\nwith two lines'], importantNote: 'Use separate lyrics.' }, null, 2)
  const display = presentAgentText(source)
  assert.equal(display.source, source)
  assert.equal(display.adapted, true)
  assert.equal(display.json, false)
  assert.equal(display.markdown, 'This works.\n\n### Music prompt\n\nBright indie pop.\n\n### Suggested structure\n\n- Intro\n- Verse\n  with two lines\n\n### Note\n\nUse separate lyrics.')
})

test('only the exact known flat envelope adapts; workflow/configuration/nested fields are literal JSON', () => {
  const known = { opinion: 'Yes', musicPrompt: 'Music', suggestedStructure: ['Intro'], importantNote: 'Note' }
  for (const object of [[], { '12': { class_type: 'LoadImage' } }, { message: 'A legitimate config value' },
    { ...known, node: 1 }, { ...known, suggestedStructure: [1] }, { ...known, opinion: { text: 'Nested' } },
    { ...known, importantNote: null }, { opinion: 'One field' }]) {
    const source = JSON.stringify(object)
    assert.deepEqual(presentAgentText(source), { source, markdown: source, adapted: false, json: true })
  }
})

test('public progress displays only message for exact status/message wrapper; never strips unknown metadata', () => {
  const source = '{"status":"analyzing","message":"Checking the song."}'
  assert.deepEqual(presentAgentText(source, { progress: true }), { source, markdown: 'Checking the song.', adapted: true, json: false })
  assert.equal(presentAgentText(source).json, true, 'same object in a final JSON artifact remains JSON')
  for (const value of [{ status: 'analyzing', message: 'Hello', error: 'Do not lose me' }, { status: false, message: 'Hello' }]) {
    const text = JSON.stringify(value)
    assert.deepEqual(presentAgentText(text, { progress: true }), { source: text, markdown: text, adapted: false, json: true })
  }
})

test('untrusted source is never executed or guessed from surrounding text', () => {
  for (const source of ['<img src=x onerror=alert(1)>', 'Here is {"status":"analyzing","message":"hello"}', '{"__proto__":{"danger":true}}']) {
    assert.equal(presentAgentText(source).markdown, source)
    assert.equal(presentAgentText(source).adapted, false)
  }
  const large = `{${' '.repeat(96000)}}`
  assert.equal(presentAgentText(large).source, large)
  assert.equal(presentAgentText(large).adapted, false)
  assert.equal(presentAgentText(null).markdown, '')
})

test('only known command activity is collapsed as commands; errors/results keep their original metadata', () => {
  for (const name of ['Shell command', 'run_command', 'exec_command', 'commandExecution']) assert.equal(isAgentCommand(name), true)
  for (const name of ['get_timeline', 'fileChange', 'install_workflow_setup', undefined, 'not-a-command']) assert.equal(isAgentCommand(name), false)
})
