const test = require('node:test')
const assert = require('node:assert/strict')
const { registerGenerationRunsIpc, CHANNELS } = require('../electron/generationRunsIpc.cjs')

function fixture() {
  const handlers = new Map(), calls = []
  const frame = {}, contents = { mainFrame: frame, isDestroyed: () => false }
  let window = { webContents: contents, isDestroyed: () => false }
  const methods = ['list', 'submit', 'adopt', 'recipe', 'control', 'observe']
  const manager = Object.fromEntries(methods.map(method => [method, async payload => {
    calls.push({ method, payload }); return { success: true, method }
  }]))
  const registration = registerGenerationRunsIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
    getMainWindow: () => window, getManager: () => manager,
  })
  const event = { sender: contents, senderFrame: frame }
  return { handlers, calls, manager, methods, registration, event, setWindow: value => { window = value },
    invoke: (method, payload, sender = event) => handlers.get(CHANNELS[method])(sender, payload) }
}

test('Runs IPC accepts only the current main frame for every read and mutation', async () => {
  const f = fixture()
  for (const method of f.methods) {
    for (const event of [undefined, {}, { sender: f.event.sender },
      { ...f.event, senderFrame: {} },
      { sender: { isDestroyed: () => false, mainFrame: f.event.senderFrame }, senderFrame: f.event.senderFrame },
      { sender: { isDestroyed: () => true }, senderFrame: f.event.senderFrame }]) {
      const result = await f.handlers.get(CHANNELS[method])(event, {})
      assert.equal(result.code, 'GENERATION_RUN_UNAUTHORIZED')
    }
  }
  assert.equal(f.calls.length, 0)
  for (const method of f.methods) assert.equal((await f.invoke(method, {})).success, true)
  assert.deepEqual(f.calls.map(call => call.method), f.methods)
})

test('Runs IPC rejects malformed arguments before calling a native service', async () => {
  const f = fixture()
  for (const payload of [null, 42, 'prompt-1', []]) {
    assert.equal((await f.invoke('submit', payload)).code, 'GENERATION_RUN_INVALID_REQUEST')
  }
  assert.equal(f.calls.length, 0)
})

test('Runs IPC checks window replacement after a pending native operation', async () => {
  const f = fixture()
  let finish
  f.manager.recipe = () => new Promise(resolve => { finish = resolve })
  const pending = f.invoke('recipe', { runId: 'synthetic' })
  f.setWindow(null)
  finish({ success: true, workflow: { secret: 'must not reach a replaced window' } })
  const result = await pending
  assert.equal(result.code, 'GENERATION_RUN_CONTEXT_CHANGED')
  assert.equal(result.workflow, undefined)
})

test('Runs IPC does not expose unexpected native exception contents', async () => {
  const f = fixture()
  f.manager.submit = () => { throw new Error('secret-value and private-path') }
  const result = await f.invoke('submit', {})
  assert.equal(result.code, 'GENERATION_RUN_FAILED')
  assert.doesNotMatch(JSON.stringify(result), /secret-value|private-path/)
  f.registration.dispose()
  assert.equal(f.handlers.size, 0)
})
