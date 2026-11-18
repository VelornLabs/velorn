'use strict'
// Run only through runtime/run-isolated.cjs. Real bundled app-server + native
// bridge + MCP + sidecar; provider responses remain deterministic fixtures.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const { initializeCandidate, assertIsolation } = require('../electron/veloEngineCandidate.cjs')
assertIsolation()
const engineModule = require('../electron/veloCodexEngine.cjs')
const realCreate = engineModule.createVeloCodexEngine
const nativeEvents = []
let mode, hostCalls = 0
engineModule.createVeloCodexEngine = options => realCreate({ ...options, onEvent: event => {
  if (event.params?.item) nativeEvents.push({ mode, method: event.method, type: event.params.item.type })
  options.onEvent?.(event)
} })
const app = new EventEmitter()
app.isPackaged = false; app.setName = () => {}; app.setPath = () => {}
const candidate = initializeCandidate(app)
const tools = [{ name: 'fixture_probe', description: 'Harmless native integration fixture.', inputSchema: { type: 'object', properties: { probe: { type: 'string' } }, required: ['probe'], additionalProperties: false } }]
const toolSession = {
  listTools: async () => tools,
  callTool: async (name, args) => {
    assert.equal(name, 'fixture_probe'); assert.equal(args.probe, 'SCRIPTED_OFFLINE_PROBE')
    hostCalls++
    return { content: [{ type: 'text', text: 'VELORN_REAL_MCP_FIXTURE_OK' }] }
  },
}
const outputs = [], uiEvents = []
async function turn(nextMode, prompt, chatId = 'native-integration-chat') {
  mode = nextMode
  const controller = new AbortController()
  const request = {
    ...(mode === 'full' ? { workingDirectory: '/workspace' } : {}), conversationId: chatId,
    ...(mode !== 'chat' ? { expectedContext: { projectKey: 'native-integration-project' } } : {}), context: 'Synthetic offline project only.',
    messages: [{ role: 'user', content: prompt }], toolsEnabled: mode !== 'chat', fullAccess: mode === 'full',
    images: [], documents: [],
  }
  const result = await candidate.sendVelo(request, {
    fundedLuna: await candidate.fundedLuna.beginTurn(), signal: controller.signal,
    instructions: 'Use the scripted offline fixture tools only. No real provider or user account exists.',
    engineContext: { projectKey: 'native-integration-project', workspaceDir: '/workspace' },
    toolSession, computerAccess: mode === 'full', assertBeforeSend: () => true,
    onEvent: event => uiEvents.push({ mode, ...event }),
  })
  assert.equal(result.success, true); assert.equal(result.model, 'gpt-6-luna'); assert.equal(result.reasoningEffort, 'low')
  assert.equal(result.fixtureOnly, true)
  outputs.push({ mode, prompt, text: result.text })
  return result
}
async function main() {
  const before = await candidate.fundedLuna.status()
  assert.equal(before.fixtureOnly, true); assert.equal(before.available, true)
  await turn('chat', 'Hello offline fixture')
  const initialMap = JSON.parse(fs.readFileSync('/state/engine/' + fs.readdirSync('/state/engine').find(name => name.endsWith('.json')), 'utf8'))
  const shell = await turn('full', 'fixture native shell')
  assert.match(shell.text, /VELORN_BUNDLED_NATIVE_OK/)
  assert.ok(nativeEvents.some(e => e.mode === 'full' && e.type === 'commandExecution' && e.method === 'item/completed'))
  const probe = await turn('velorn', 'fixture probe')
  assert.equal(hostCalls, 1, 'The actual native MCP gateway must dispatch exactly one harmless probe')
  assert.match(probe.text, /VELORN_REAL_MCP_FIXTURE_OK/)
  await turn('velorn', 'fixture native shell')
  await turn('chat', 'fixture probe')
  assert.equal(hostCalls, 1, 'Chat only must not retain the preceding MCP capability')
  assert.equal(nativeEvents.some(e => e.mode !== 'full' && e.type === 'commandExecution'), false, 'Downgrading access must disable native shell')
  const restored = await turn('full', 'fixture native shell')
  assert.match(restored.text, /VELORN_BUNDLED_NATIVE_OK/)
  const files = fs.readdirSync('/state/engine').filter(name => name.endsWith('.json'))
  assert.equal(files.length, 1)
  const finalMap = JSON.parse(fs.readFileSync('/state/engine/' + files[0], 'utf8'))
  assert.equal(finalMap.threadId, initialMap.threadId, 'Access changes must preserve the existing engine thread')
  await turn('chat', 'A different isolated chat', 'second-native-integration-chat')
  assert.equal(fs.readdirSync('/state/engine').filter(name => name.endsWith('.json')).length, 2)
  const after = await candidate.fundedLuna.status()
  const result = { passed: true, fixtureOnly: true, liveProviderUsed: false, hostCalls, turnCount: outputs.length, sameThreadAcrossModes: true, model: 'gpt-6-luna', effort: 'low', before, after, outputs, nativeEvents, uiEventCount: uiEvents.length }
  fs.writeFileSync('/state/native-integration-result.json', JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ passed: true, fixtureOnly: true, hostCalls, turns: outputs.length, sameThreadAcrossModes: true }))
}
main().then(() => { app.emit('will-quit'); setTimeout(() => process.exit(0), 250) }, error => {
  fs.writeFileSync('/state/native-integration-failure.json', JSON.stringify({ code: error.code, message: error.message, outputs, nativeEvents, hostCalls }, null, 2), { mode: 0o600 })
  process.exitCode = 1
  app.emit('will-quit'); console.error(error.code || 'Error', error.message); setTimeout(() => process.exit(1), 250)
})
