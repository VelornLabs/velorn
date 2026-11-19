const test = require('node:test')
const assert = require('node:assert/strict')
const { createCaptionEngineSetup } = require('../electron/captionEngineSetup.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
function fixture(options = {}) {
  const state = { models: [], binaryPath: null, vadModelInstalled: false }
  let installs = 0, listener
  const service = { getStatus: () => state, onProgress: fn => { listener = fn; return () => { listener = null } },
    install: async ({ modelId }) => { installs++; listener?.({ phase: 'download-model', percent: 50 });
      state.binaryPath = '/fake/engine'; state.models = [{ id: modelId }]; return { success: true } } }
  const api = createCaptionEngineSetup({ service, platform: 'linux', arch: 'x64', confirmInstall: async () => true, ...options })
  return { api, state, service, count: () => installs }
}
async function settle(api, jobId) {
  for (let i = 0; i < 30; i++) {
    const result = api.status({ jobId })
    if (['completed', 'declined', 'failed'].includes(result.job.state)) return result
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('Job did not settle')
}
test('preview is inert and rejects arbitrary downloads and model IDs', async () => {
  const f = fixture()
  const p = await f.api.install({ modelId: 'small' })
  assert.equal(p.previewOnly, true); assert.equal(f.count(), 0)
  assert.ok(p.plan.knownApproxDownloadBytes >= 466000000)
  assert.equal(p.plan.hasUnknownDownloadSize, true)
  assert.equal((await f.api.install({ url: 'https://example.com' })).success, false)
  assert.equal((await f.api.install({ modelId: 'unknown' })).success, false)
  assert.equal((await f.api.install({ previewOnly: false })).code, 'CAPTION_SETUP_STALE')
})
test('approved background job installs exact model once and read polling is repeatable', async () => {
  const f = fixture(), p = await f.api.install({ modelId: 'small' })
  const receipt = await f.api.install(p.suggestedApplyPayload)
  const result = await settle(f.api, receipt.jobId)
  assert.equal(result.job.state, 'completed'); assert.equal(result.modelId, 'small')
  assert.equal(result.ready, true); assert.equal(f.count(), 1)
  for (let i = 0; i < 5; i++) assert.equal(f.api.status({ jobId: receipt.jobId }).job.state, 'completed')
  assert.equal((await f.api.install(p.suggestedApplyPayload)).success, false)
  assert.equal(f.count(), 1)
})
test('denied confirmation and canceled context never download', async () => {
  for (const options of [{ confirmInstall: async () => false }, { assertCurrent: async () => { throw Error('Canceled') } }]) {
    const f = fixture(options), p = await f.api.install(), r = await f.api.install(p.suggestedApplyPayload)
    assert.ok(['declined', 'failed'].includes((await settle(f.api, r.jobId)).job.state))
    assert.equal(f.count(), 0)
  }
})
test('stale, changed-model and expired preview tokens reject', async () => {
  let now = 0
  const f = fixture({ now: () => now }), p = await f.api.install()
  assert.equal((await f.api.install({ ...p.suggestedApplyPayload, modelId: 'tiny' })).success, false)
  now = 300001
  assert.equal((await f.api.install(p.suggestedApplyPayload)).success, false)
  const next = await f.api.install(); f.state.binaryPath = '/fake/new'
  assert.equal((await f.api.install(next.suggestedApplyPayload)).success, false)
  assert.equal(f.count(), 0)
})
test('platform plans support shipped platforms and reject unsupported fresh architectures', async () => {
  for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']]) {
    assert.equal((await fixture({ platform, arch }).api.install()).plan.supported, true)
  }
  assert.equal((await fixture({ platform: 'linux', arch: 'arm64' }).api.install()).code, 'CAPTION_SETUP_UNSUPPORTED')
})
test('busy service and false success cannot cause another install or false completion', async () => {
  const f = fixture(); f.state.transcribeInFlight = true
  const p = await f.api.install()
  assert.equal((await f.api.install(p.suggestedApplyPayload)).code, 'CAPTION_SETUP_BUSY')
  f.state.transcribeInFlight = false
  f.service.install = async () => ({ success: true })
  const next = await f.api.install(), r = await f.api.install(next.suggestedApplyPayload)
  assert.equal((await settle(f.api, r.jobId)).job.state, 'failed')
  assert.equal(f.api.status({ jobId: 'previous-session' }).code, 'CAPTION_SETUP_UNKNOWN_JOB')
})
test('native MCP routes setup without requiring a project or renderer action', async () => {
  const f = fixture(), server = createComfyStudioMcpServer({ captionEngineSetup: f.api,
    performAction: async () => { throw Error('Unexpected renderer action') } })
  const parse = result => JSON.parse(result.content[0].text)
  for (let i = 0; i < 3; i++) assert.equal(parse(await server.callTool('get_caption_engine_status', {})).success, true)
  assert.equal(parse(await server.callTool('install_caption_engine', {})).previewOnly, true)
  assert.equal(f.count(), 0)
})
