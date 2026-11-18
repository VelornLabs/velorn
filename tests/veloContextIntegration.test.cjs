'use strict'

// LOCAL opt-in contract coverage. Imports the private validator without copying
// relay source/config or starting a service. Model replies are scripted; the only
// real mutation is an owned command writing a disposable fixture marker once.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { sendLuna, MODEL, lunaPromptWasNotSent } = require('../electron/connectedAgentLuna.cjs')
const { createVeloComputerTools } = require('../electron/veloComputerTools.cjs')
const { measureVeloContext, LIMITS } = require('../electron/veloContextBudget.cjs')
const relaySource = process.env.VELORN_TEST_RELAY_SOURCE
const integration = { skip: !relaySource && 'Private relay excluded; set VELORN_TEST_RELAY_SOURCE to its local src directory', timeout: 20000 }
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const toolCall = (id, name, args = {}) => [{ type: 'function_call', call_id: id, name: 'call_velorn_tool', arguments: JSON.stringify({ name, arguments: args }) }]
const answer = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const header = output => JSON.parse(output.split('\n')[0])
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const projectTool = { name: 'get_project', description: 'Inspect synthetic project data.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
const request = extra => ({ provider: 'luna', model: MODEL, reasoningEffort: 'max', context: '{}',
  messages: [{ role: 'user', content: 'Finish the synthetic maintenance task without replaying completed commands.' }],
  toolsEnabled: true, fullAccess: true, ...extra })
let relay
async function validator() {
  assert.ok(path.isAbsolute(relaySource))
  relay ||= import(pathToFileURL(path.join(relaySource, 'fundedLuna.mjs')).href)
  return relay
}
async function fixture(t, options = {}) {
  const { validateFundedLunaRequest, FUNDED_LUNA_LIMITS } = await validator()
  assert.equal(FUNDED_LUNA_LIMITS.contextBytes, LIMITS.contextBytes)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velo-context-integration-'))
  const marker = path.join(root, 'mutation-once.txt'), abort = new AbortController()
  const requests = [], calls = [], returned = [], originals = new Map()
  const native = createVeloComputerTools({ cwd: root, signal: abort.signal, assertCurrent: () => true,
    environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, limits: { termMs: 10, killMs: 20, treePollMs: 10 } })
  const toolSession = { listTools: async () => [...(options.editorServer?.tools || [projectTool]), ...native.tools], callTool: async (name, args) => {
    calls.push({ name, args })
    const value = options.editorServer && !native.has(name) ? options.editorServer.callTool(name, args)
      : name === 'get_project' ? options.inspection?.(calls.length) || result({ success: true, index: calls.length, exact: 'Synthetic Unicode 漢字🙂 ' + 'O'.repeat(9000) })
      : native.callTool(name, args)
    const completed = await value
    returned.push({ name, result: completed })
    return completed
  } }
  let script, providerError
  const fundedLuna = { assertCurrent: () => true, status: async () => ({ ok: true, available: true, model: MODEL, remainingMicroUsd: 1000000 }),
    respond: async payload => {
      try {
        assert.equal(payload.reasoningEffort, 'low')
        const checked = validateFundedLunaRequest({ computerId: 'synthetic_computer_context', ...payload })
        const measured = measureVeloContext(payload)
        if (!payload.input.some(item => Array.isArray(item.content) && item.content.some(part => part.type === 'input_image'))) {
          assert.equal(checked.maxInputTokens, measured.contextBytes + FUNDED_LUNA_LIMITS.inputTokenOverhead)
        }
        assert.equal(measured.fits, true)
        for (const item of payload.input) if (item.type === 'function_call_output' && !originals.has(item.call_id)) originals.set(item.call_id, item.output)
        requests.push(structuredClone(payload))
        return { ok: true, model: MODEL, remainingMicroUsd: 1000000, output: await script(requests.length, payload) }
      } catch (error) { providerError = error; throw error }
    } }
  const run = (reply, extra = {}) => {
    script = reply
    return sendLuna(request(extra), { fundedLuna, toolSession, computerAccess: true, signal: abort.signal }).catch(error => { throw providerError || error })
  }
  t.after(async () => { abort.abort(); await native.close(); await fs.rm(root, { recursive: true, force: true }) })
  return { root, marker, calls, requests, returned, originals, run, validate: validateFundedLunaRequest }
}

test('actual relay validator accepts multi-round context recovery, one real mutation and exact archived retrieval without replay', integration, async t => {
  const f = await fixture(t)
  const command = `${quote(process.execPath)} -e ${quote(`require('node:fs').appendFileSync(${JSON.stringify(f.marker)}, 'once\\n'); process.stdout.write('start\\n' + 'normal output\\n'.repeat(600) + 'warning: exact synthetic warning\\nend\\n')`)}`
  let archivedCommandId
  const completed = await f.run((round, payload) => {
    if (round === 1) return toolCall('mutation_once', 'run_computer_command', { command, cwd: f.root })
    if (round <= 33) return toolCall(`inspection_${round}`, 'get_project')
    if (round === 34) {
      const commandOutput = payload.input.find(item => item.type === 'function_call_output' && item.call_id === 'mutation_once')
      const metadata = header(commandOutput.output)
      assert.equal(metadata.kind, 'velo-command-output-reference')
      archivedCommandId = metadata.resultId
      const projection = JSON.parse(commandOutput.output.split('\n\n')[1])
      assert.equal(projection.commandReceipt.exitCode, 0)
      assert.equal(projection.commandReceipt.status, 'completed')
      assert.equal(projection.commandReceipt.possibleChanges, true)
      assert.ok(projection.outputExcerpts.some(part => part.text.includes('warning: exact synthetic warning')))
      assert.ok(payload.tools.some(tool => tool.name === 'read_velorn_tool_result'))
      const unarchived = structuredClone(payload)
      for (const item of unarchived.input) if (item.type === 'function_call_output') item.output = f.originals.get(item.call_id)
      assert.ok(measureVeloContext(unarchived).contextBytes > LIMITS.contextBytes, 'The same complete history would exceed the real relay ceiling')
      assert.throws(() => f.validate({ computerId: 'synthetic_computer_context', ...unarchived }), { code: 'invalid_request' })
      return [{ type: 'function_call', call_id: 'retrieve_not_replay', name: 'read_velorn_tool_result',
        arguments: JSON.stringify({ resultId: archivedCommandId, representation: 'original', position: 'start' }) }]
    }
    if (round === 35) {
      const page = payload.input.find(item => item.call_id === 'retrieve_not_replay' && item.type === 'function_call_output').output
      assert.equal(header(page).resultId, archivedCommandId)
      assert.equal(page.slice(page.indexOf('\n\n') + 2), JSON.stringify(f.returned.find(entry => entry.name === 'run_computer_command').result))
      return toolCall('verify_completed_effect', 'read_computer_file', { path: f.marker })
    }
    assert.equal(round, 36)
    assert.match(payload.input.at(-1).output, /once/)
    assert.equal(header(payload.input.at(-1).output).archived, undefined)
    return answer('The synthetic mutation and its exact retained result were verified without replay.')
  })
  assert.equal(completed.success, true)
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'once\n')
  assert.equal(f.calls.filter(call => call.name === 'run_computer_command').length, 1)
  assert.equal(f.calls.length, 34)
  assert.equal(f.requests.length, 36)
  assert.equal(new Set(f.requests.map(payload => payload.requestId)).size, 36)
})

test('protected failure overflow fails locally after the once-only partial mutation, without replay or another provider call', integration, async t => {
  const f = await fixture(t, { inspection: () => result({ success: false, error: 'exact synthetic failure evidence', detail: 'F'.repeat(9000) }) })
  const command = `${quote(process.execPath)} -e ${quote(`require('node:fs').appendFileSync(${JSON.stringify(f.marker)}, 'once\\n'); process.stderr.write('fatal: preserve exact partial-effect evidence\\n'); process.exitCode = 17`)}`
  await assert.rejects(f.run((round, payload) => {
    if (round === 1) return toolCall('partial_once', 'run_computer_command', { command, cwd: f.root })
    const mutation = payload.input.find(item => item.type === 'function_call_output' && item.call_id === 'partial_once')
    assert.equal(header(mutation.output).sourceIsError, true)
    assert.match(mutation.output, /fatal: preserve exact partial-effect evidence/)
    assert.match(mutation.output, /nonzero-exit/)
    return toolCall(`protected_${round}`, 'get_project')
  }), error => error.code === 'LUNA_REQUEST_LIMIT' && !lunaPromptWasNotSent(error))
  assert.equal(await fs.readFile(f.marker, 'utf8'), 'once\n')
  assert.equal(f.calls.filter(call => call.name === 'run_computer_command').length, 1)
  assert.equal(f.calls.length, f.requests.length)
  assert.ok(f.requests.length > 10 && f.requests.length < 30)
})

test('256-item boundary stops locally with all existing call-output pairs unchanged and no replay', integration, async t => {
  const f = await fixture(t, { inspection: () => result({ success: true, text: 'small exact observation' }) })
  await assert.rejects(f.run(round => toolCall(`read_${round}`, 'get_project')), { code: 'LUNA_REQUEST_LIMIT' })
  assert.equal(f.calls.length, 128)
  assert.equal(f.requests.length, 128)
  const last = f.requests.at(-1)
  assert.equal(last.input.length, 255)
  assert.equal(last.input.filter(item => item.type === 'function_call').length, 127)
  assert.equal(last.input.filter(item => item.type === 'function_call_output').length, 127)
  assert.equal(new Set(f.calls.map(call => call.name)).size, 1)
})

test('protected Unicode text, per-field and image-content-item limits fail pre-dispatch, while valid image bytes pass actual validator', integration, async t => {
  for (const extra of [
    { messages: [{ role: 'user', content: '字'.repeat(70000) }] },
    { messages: [{ role: 'user', content: 'x'.repeat(96 * 1024 + 1) }] },
    { vision: true, images: Array.from({ length: 17 }, (_, i) => ({ label: `image${i}`, dataUrl: 'data:image/png;base64,abcd' })) },
  ]) {
    const f = await fixture(t)
    await assert.rejects(f.run(() => assert.fail('No provider dispatch'), extra), error => error.code === 'LUNA_REQUEST_LIMIT' && lunaPromptWasNotSent(error))
    assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0)
  }
  const valid = await fixture(t)
  const response = await valid.run(() => answer('Synthetic image accepted.'), { vision: true,
    images: [{ label: 'Only a synthetic image', dataUrl: `data:image/png;base64,${'abcd'.repeat(260000)}` }] })
  assert.equal(response.success, true)
  assert.ok(measureVeloContext(valid.requests[0]).wireBytes > 1000000)
  assert.ok(measureVeloContext(valid.requests[0]).contextBytes < 100000)
})

test('actual native catalog and healthy maintenance observations compact while launcher warnings and pending jobs remain exact', integration, async t => {
  const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
  const { createOptionalSetup } = require('../electron/optionalSetup.cjs')
  const { archivePolicy } = require('../electron/veloContextBudget.cjs')
  const diagnosis = { summary: 'The synthetic local ComfyUI API is reachable.',
    connection: { ok: true, port: 8188, httpBase: 'http://127.0.0.1:8188', systemStats: { ok: true, status: 200, error: '', timedOut: false } },
    api: { systemStats: { ok: true, status: 200, system: { os: 'linux', python_version: '3.12', pytorch_version: 'synthetic' }, devices: [] },
      objectInfo: { ok: true, status: 200, nodeClassCount: 123, error: '' }, queue: { ok: true, status: 200, running: 0, pending: 0, error: '' } },
    launcher: { state: { state: 'running', ownership: 'ours', httpBase: 'http://127.0.0.1:8188' },
      config: { launcherMode: 'script', launcherScript: '/synthetic/ComfyUI/start.sh', extraArgs: '', stopOnQuit: true, disableAutoLaunch: true },
      hasLauncherTarget: true, configuredPortHint: 8188,
      detectedLaunchers: Array.from({ length: 45 }, (_, i) => ({ path: `/synthetic/ComfyUI/launchers/${i}-${'nested-directory-'.repeat(6)}/start.sh`, kind: 'shell' })) },
    comfyRootPath: '/synthetic/ComfyUI', installMode: { mode: 'manual' }, portOwner: { pid: 12345, name: 'synthetic-python', port: 8188 },
    generatedAt: '2030-01-01T00:00:00.000Z', recommendations: [] }
  const logs = { success: true, logs: [{ stream: 'stderr', text: 'WARNING: three synthetic packages need attention; do not infer installation success.' }],
    issues: [{ kind: 'missing-packages', message: 'Synthetic packages alpha, beta, gamma need review.' }] }
  const setup = createOptionalSetup({ getConfiguredPort: async () => 8188,
    comfySetup: { discoverRunning: async () => [{ port: 8188, deviceNames: ['Synthetic GPU; no inference'] }] } })
  const server = createComfyStudioMcpServer({ optionalSetup: setup,
    diagnoseComfyUIConnection: async () => structuredClone(diagnosis), getComfyLauncherLogs: async () => structuredClone(logs) })
  const setupResult = await server.callTool('get_setup_status', { integration: 'comfyui' })
  assert.ok(archivePolicy('get_setup_status', setupResult))
  assert.ok(archivePolicy('diagnose_comfyui_connection', result(diagnosis)))
  for (const unsafe of [
    { ...diagnosis, api: { ...diagnosis.api, queue: { ...diagnosis.api.queue, running: 1 } } },
    { ...diagnosis, api: { ...diagnosis.api, queue: { ...diagnosis.api.queue, pending: 1 } } },
    { ...diagnosis, warnings: ['exact package warning'] },
    { ...diagnosis, connection: { ...diagnosis.connection, ok: false } },
  ]) assert.equal(archivePolicy('diagnose_comfyui_connection', result(unsafe)), null)
  const f = await fixture(t, { editorServer: server })
  await f.run((round, payload) => {
    if (round === 1) return toolCall('setup_before', 'get_setup_status', { integration: 'comfyui' })
    if (round === 2) return toolCall('warning_logs', 'get_comfyui_launcher_logs')
    if (round < 29) return toolCall(`diagnosis_${round}`, 'diagnose_comfyui_connection')
    const outputs = payload.input.filter(item => item.type === 'function_call_output')
    assert.ok(outputs.some(item => item.call_id.startsWith('diagnosis_') && header(item.output).archived))
    assert.equal(outputs.find(item => item.call_id === 'warning_logs').output, f.originals.get('warning_logs'))
    assert.match(outputs.find(item => item.call_id === 'warning_logs').output, /three synthetic packages/)
    assert.equal(header(outputs.at(-1).output).archived, undefined)
    assert.ok(payload.instructions.includes('diagnose_comfyui_connection'))
    return answer('Synthetic healthy state was retained and unresolved launcher warnings remained visible.')
  })
  assert.equal(f.requests.length, 29)
  assert.equal(f.calls.some(call => call.name === 'run_computer_command'), false)
})
