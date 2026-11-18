'use strict'

// Opt-in LOCAL integration with the actual private relay implementation. Never
// copy relay source into this snapshot, load production config, or use a real
// provider: the service receives synthetic accounts and an injected fake fetch.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { spawn } = require('node:child_process')
const { sendLuna, MODEL } = require('../electron/connectedAgentLuna.cjs')
const { requestFundedLuna } = require('../electron/fundedLunaTransport.cjs')
const { createVeloComputerSession } = require('../electron/veloComputerSession.cjs')
const { createVeloComputerTools } = require('../electron/veloComputerTools.cjs')

const relaySource = process.env.VELORN_TEST_RELAY_SOURCE
const integration = { skip: !relaySource && 'Private relay excluded; set VELORN_TEST_RELAY_SOURCE to its local src directory', timeout: 20000 }
const accountId = 'synthetic-continuation-account'
const computerId = 'synthetic_computer_123456'
const bearer = 's'.repeat(43)
const providerKey = 'synthetic-no-network-provider-key'
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const command = code => `${quote(process.execPath)} -e ${quote(code)}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const answer = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const toolCall = (id, name, args = {}) => [{ type: 'function_call', call_id: id, name: 'call_velorn_tool', arguments: JSON.stringify({ name, arguments: args }) }]
const request = extra => ({ provider: 'luna', model: MODEL, reasoningEffort: 'max', requestId: 'synthetic_native_request',
  context: '{}', messages: [{ role: 'user', content: 'CONTINUATION_MAIN: complete the synthetic test task.' }], toolsEnabled: true, ...extra })
const raw = id => ({ requestId: id, instructions: 'Synthetic test, never real inference.', reasoningEffort: 'low',
  input: [{ type: 'message', role: 'user', content: 'Synthetic prefill.' }], tools: [] })
const editorTools = [{ name: 'get_project', description: 'Read synthetic project state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }]
let modules
async function actualRelay() {
  assert.ok(path.isAbsolute(relaySource), 'The opt-in relay source directory must be absolute')
  modules ||= Promise.all(['fundedLuna.mjs', 'fundedLunaInitialize.mjs', 'veeLaunchPolicy.mjs'].map(name => import(pathToFileURL(path.join(relaySource, name)).href)))
  const [service, initialization, launch] = await modules
  assert.equal(launch.VEE_STARTER_MICRO_USD, 1000000)
  assert.equal(launch.VEE_LAUNCH_MICRO_USD, 50000000)
  assert.equal(service.FUNDED_LUNA_REASONING, 'low')
  assert.equal(service.FUNDED_LUNA_LIMITS.accountConcurrency, 1)
  assert.equal(service.FUNDED_LUNA_LIMITS.globalConcurrency, 2)
  return { ...service, ...initialization, ...launch }
}

async function fixture(t, options = {}) {
  const relay = await actualRelay()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velo-continuation-integration-'))
  const state = { now: 1900000000000, active: true, computerActive: true, nativeCurrent: true, sleeps: [], sleepHook: null }
  const calls = [], attempts = [], events = [], waiting = [], tools = [], spawns = [], sessions = []
  const config = { enabled: true, apiKey: providerKey, ledgerPath: path.join(root, 'synthetic-ledger.json'), globalAllowanceMicroUsd: 50000000,
    grants: [], automaticAccess: { enabled: true, allowanceMicroUsd: 1000000 } }
  await relay.initializeFundedLunaLedger({ path: config.ledgerPath, confirmFirstInitialization: true, now: () => state.now })
  const service = await relay.createFundedLunaService({ config, now: () => state.now,
    authenticate: async (req, body) => req.headers.authorization === `Bearer ${bearer}` && body.computerId === computerId
      ? { accountId, computerId, isActive: () => state.computerActive } : null,
    accountActive: () => state.active,
    verifiedProfileForAccount: id => id === accountId ? { email: 'synthetic-continuation@example.test', emailVerified: options.verified !== false } : null,
    fetchImpl: async (url, init) => {
      // No forwarding to fetch: every potential paid request is handled here.
      assert.equal(url, 'https://api.openai.com/v1/responses')
      assert.equal(init.headers.authorization, `Bearer ${providerKey}`)
      const body = JSON.parse(init.body)
      assert.equal(body.model, MODEL); assert.deepEqual(body.reasoning, { effort: 'low' })
      assert.equal(body.service_tier, 'default'); assert.equal(body.store, false)
      assert.equal(body.parallel_tool_calls, false); assert.equal(body.max_output_tokens, 4096)
      calls.push(body)
      const output = await (options.reply?.(calls.length, body, state) ?? answer('Synthetic task complete.'))
      return Response.json({ status: 'completed', output, usage: options.usage || { input_tokens: 100, output_tokens: 10 } })
    } })
  let respondCount = 0
  const server = createServer(async (req, res) => {
    const record = { route: req.url, body: null, status: null }; attempts.push(record)
    let body = ''
    req.on('data', bytes => { body += bytes.toString('utf8') })
    req.on('end', () => { record.body = JSON.parse(body) })
    res.on('finish', () => { record.status = res.statusCode })
    if (req.url.endsWith('/respond') && ++respondCount === options.dropResponseAt) {
      // Lose an actual relay response AFTER dispatch/settlement. This is not
      // a pre-dispatch refusal and cannot authorize any automatic retry.
      res.end = () => { record.status = 'connection-lost'; res.destroy(); return res }
    }
    try {
      if (!await service.handle(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end() }
    } catch { res.destroy() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const transport = (route, body, signal) => requestFundedLuna({ url: new URL(`${origin}/account/desktop/luna/${route}`),
    token: bearer, body: { computerId, ...body }, signal, allowLocalTest: true })
  const assertCurrent = () => { if (!state.nativeCurrent) throw Object.assign(new Error('Synthetic native authority ended.'), { code: 'LUNA_UNAVAILABLE' }) }
  const fundedLuna = { assertCurrent, status: ({ signal } = {}) => transport('status', {}, signal),
    respond: (body, { signal } = {}) => transport('respond', body, signal) }
  const recoveryTiming = { now: () => state.now, sleep: async (milliseconds, signal) => {
    assert.ok(milliseconds > 0 && milliseconds <= 1000)
    state.sleeps.push(milliseconds)
    await state.sleepHook?.(milliseconds, signal)
    state.now += milliseconds
    await new Promise(resolve => setImmediate(resolve))
  } }
  const editor = { listTools: async () => editorTools, callTool: async (name, args) => {
    assert.equal(name, 'get_project'); tools.push([name, args]); return { content: [{ type: 'text', text: '{"synthetic":true}' }] }
  } }
  const deps = extra => ({ fundedLuna, toolSession: editor, recoveryTiming, onEvent: event => events.push(event), onWaiting: value => waiting.push(value), ...extra })
  const nativeSession = async (controller, onNativeEvent = () => {}) => {
    const session = await createVeloComputerSession({ toolSession: editor, cwd: root, signal: controller.signal, assertCurrent,
      onEvent: event => { events.push(event); onNativeEvent(event) }, makeComputerTools: args => createVeloComputerTools({ ...args,
        environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        spawnImpl: (...args) => { spawns.push(args); return spawn(...args) },
        limits: { termMs: 20, killMs: 30, treePollMs: 10, authorityPollMs: 30, outputProgressMs: 25, silentProgressMs: 40 } }) })
    sessions.push({ session, controller }); return session
  }
  t.after(async () => {
    try {
      for (const { session, controller } of sessions) { controller.abort('fixture-cleanup'); await session.close() }
    } finally {
      await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
      await fs.rm(root, { recursive: true, force: true })
    }
  })
  const journal = async () => JSON.parse(await fs.readFile(config.ledgerPath, 'utf8'))
  const status = () => fundedLuna.status()
  assert.equal((await status()).remainingMicroUsd, options.verified === false ? 0 : 1000000)
  return { root, state, calls, attempts, events, waiting, tools, spawns, deps, nativeSession, fundedLuna, journal, status, service,
    respondAttempts: () => attempts.filter(item => item.route.endsWith('/respond')),
    warm: async count => { for (let index = 0; index < count; index++) await fundedLuna.respond(raw(`synthetic_warm_request_${index}`)) } }
}

test('actual relay allows many continuation rounds across rate windows without replaying a completed command', integration, async t => {
  const marker = 'exactly-once.txt'
  const f = await fixture(t, { reply: index => index <= 35
    ? toolCall(`step_${index}`, index === 12 ? 'run_computer_command' : 'get_project', index === 12
      ? { command: command(`require('node:fs').appendFileSync(${JSON.stringify(marker)},'once\\n')`) } : {})
    : answer('All 35 synthetic actions completed.') })
  const controller = new AbortController(), session = await f.nativeSession(controller)
  const result = await sendLuna(request({ fullAccess: true }), f.deps({ signal: controller.signal, toolSession: session, computerAccess: true }))
  assert.equal(result.success, true); assert.equal(f.calls.length, 36)
  assert.equal(f.spawns.length, 1); assert.equal(f.tools.length, 34)
  assert.equal(await fs.readFile(path.join(f.root, marker), 'utf8'), 'once\n')
  const attempts = f.respondAttempts(), refusals = attempts.filter(item => item.status === 429)
  assert.equal(refusals.length, 2); assert.equal(attempts.length, 38)
  for (const refusal of refusals) {
    const retried = attempts.filter(item => item.body.requestId === refusal.body.requestId)
    assert.equal(retried.length, 2); assert.deepEqual(retried[0].body, retried[1].body)
    assert.equal(retried[1].status, 200)
  }
  assert.equal(f.state.sleeps.reduce((n, value) => n + value, 0), 120000)
  const ledger = await f.journal()
  assert.equal(ledger.version, 3); assert.equal(ledger.requests.length, 36)
  assert.ok(ledger.requests.every(item => item.state === 'settled'))
  assert.equal(ledger.spentMicroUsd, 36 * 18); assert.equal(ledger.launchCommittedMicroUsd, 1000000)
  assert.equal(ledger.accounts[0].grant.allowanceMicroUsd, 1000000)
  assert.equal((await f.status()).remainingMicroUsd, 1000000 - 36 * 18)
  assert.ok(f.events.some(event => event.waitingFor === 'velo-service' && event.remainingSeconds === 60))
  assert.equal(f.waiting.at(-1), false)
  f.state.now += 7 * 24 * 60 * 60 * 1000
  assert.equal((await f.status()).remainingMicroUsd, 1000000 - 36 * 18, 'No daily refill or allowance reset')
})

test('actual busy refusal precedes reservation and retries only that model request after the slot clears', integration, async t => {
  const held = defer(), started = defer()
  const f = await fixture(t, { reply: async index => { if (index === 1) { started.resolve(); await held.promise } return answer('Synthetic response.') } })
  const blocker = f.fundedLuna.respond(raw('synthetic_blocking_request_0001')); await started.promise
  const before = await f.journal(); assert.equal(before.requests.length, 1); assert.equal(before.requests[0].state, 'reserved')
  f.state.sleepHook = async () => {
    assert.equal((await f.journal()).requests.length, 1, 'Busy attempt must not reserve')
    held.resolve(); await blocker; f.state.sleepHook = null
  }
  const result = await sendLuna(request({ toolsEnabled: false }), f.deps())
  assert.equal(result.success, true); assert.equal(f.calls.length, 2)
  const attempts = f.respondAttempts(); assert.equal(attempts.length, 3); assert.equal(attempts[1].status, 429)
  assert.deepEqual(attempts[1].body, attempts[2].body)
  assert.equal((await f.journal()).requests.length, 2); assert.equal((await f.journal()).spentMicroUsd, 36)
  assert.ok(f.state.sleeps.length > 0); assert.equal(f.waiting.at(-1), false)
})

test('ambiguous provider failure retains its reservation and never retries or repeats the completed command', integration, async t => {
  const f = await fixture(t, { reply: index => {
    if (index === 1) return toolCall('write_once', 'run_computer_command', { command: command("require('node:fs').appendFileSync('mutation.txt','once')") })
    throw new Error('Synthetic uncertain upstream result after reservation')
  } })
  const controller = new AbortController(), session = await f.nativeSession(controller)
  await assert.rejects(sendLuna(request({ fullAccess: true }), f.deps({ signal: controller.signal, toolSession: session, computerAccess: true })), { code: 'LUNA_SERVICE_UNAVAILABLE' })
  assert.equal(f.calls.length, 2); assert.equal(f.respondAttempts().length, 2); assert.equal(f.state.sleeps.length, 0)
  assert.equal(f.spawns.length, 1); assert.equal(await fs.readFile(path.join(f.root, 'mutation.txt'), 'utf8'), 'once')
  const ledger = await f.journal(); assert.equal(ledger.requests.length, 2)
  assert.equal(ledger.requests[0].state, 'settled'); assert.equal(ledger.requests[1].state, 'reserved')
  const reserved = ledger.requests[1].chargedMicroUsd; assert.ok(reserved > 18)
  assert.equal(ledger.spentMicroUsd, 18 + reserved)
  await assert.rejects(f.fundedLuna.respond(f.respondAttempts()[1].body), { code: 'LUNA_RESPONSE_UNCERTAIN' })
  assert.equal(f.calls.length, 2, 'Even an explicit duplicate cannot redispatch the charged request')
  assert.deepEqual(await f.journal(), ledger)
})

test('lost network response after actual settlement is never treated as retry proof', integration, async t => {
  const f = await fixture(t, { dropResponseAt: 1 })
  await assert.rejects(sendLuna(request({ toolsEnabled: false }), f.deps()), { code: 'LUNA_RESPONSE_UNCERTAIN' })
  assert.equal(f.calls.length, 1); assert.equal(f.respondAttempts().length, 1); assert.equal(f.state.sleeps.length, 0)
  const ledger = await f.journal(); assert.equal(ledger.requests.length, 1); assert.equal(ledger.requests[0].state, 'settled')
  assert.equal(ledger.spentMicroUsd, 18)
})

test('Stop during an actual rate-limit wait dispatches no further model request or charge', integration, async t => {
  const f = await fixture(t); await f.warm(12)
  const before = await f.journal(), controller = new AbortController()
  f.state.sleepHook = () => controller.abort('stopped')
  await assert.rejects(sendLuna(request({ toolsEnabled: false }), f.deps({ signal: controller.signal })), { code: 'CANCELLED' })
  assert.equal(f.calls.length, 12); assert.equal(f.respondAttempts().length, 13)
  assert.deepEqual(await f.journal(), before); assert.equal(f.waiting.at(-1), false)
})

test('native account authority is rechecked during the wait before any retry', integration, async t => {
  const f = await fixture(t); await f.warm(12)
  const before = await f.journal()
  f.state.sleepHook = () => { f.state.nativeCurrent = false; f.state.active = false; f.service.refreshAuthority() }
  await assert.rejects(sendLuna(request({ toolsEnabled: false }), f.deps()), { code: 'LUNA_UNAVAILABLE' })
  assert.equal(f.calls.length, 12); assert.equal(f.respondAttempts().length, 13); assert.deepEqual(await f.journal(), before)
  assert.equal((await f.status()).reason, 'not_eligible'); assert.equal(f.waiting.at(-1), false)
})

test('actual conservative reservations cannot cross the unchanged $1 allowance and insufficient budget never retries', integration, async t => {
  const f = await fixture(t, { usage: { input_tokens: 1050000, output_tokens: 4096 }, reply: index => toolCall(`budget_step_${index}`, 'get_project') })
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII='
  await assert.rejects(sendLuna(request({ vision: true, images: [{ label: 'Synthetic one-pixel test image', dataUrl: `data:image/png;base64,${png}` }] }), f.deps()), { code: 'LUNA_EXHAUSTED' })
  assert.equal(f.calls.length, 3); assert.equal(f.respondAttempts().length, 4)
  assert.equal(f.respondAttempts().at(-1).status, 402); assert.equal(f.state.sleeps.length, 0)
  const ledger = await f.journal()
  assert.equal(ledger.requests.length, 3); assert.equal(ledger.spentMicroUsd, 3 * 265572)
  assert.ok(ledger.spentMicroUsd < 1000000); assert.equal(ledger.accounts[0].grant.allowanceMicroUsd, 1000000)
  assert.equal(ledger.launchCommittedMicroUsd, 1000000)
  assert.equal((await f.status()).remainingMicroUsd, 1000000 - 3 * 265572)
})

test('an unverified account receives no automatic allowance or model request', integration, async t => {
  const f = await fixture(t, { verified: false })
  await assert.rejects(sendLuna(request({ toolsEnabled: false }), f.deps()), { code: 'LUNA_NOT_ELIGIBLE' })
  assert.equal(f.calls.length, 0); assert.equal(f.respondAttempts().length, 0); assert.equal(f.state.sleeps.length, 0)
  const ledger = await f.journal(); assert.equal(ledger.spentMicroUsd, 0); assert.equal(ledger.launchCommittedMicroUsd, 0)
  assert.equal(ledger.accounts.length, 0); assert.equal(ledger.requests.length, 0)
})

test('a long native command waits locally and completes with only two model requests', integration, async t => {
  const started = defer()
  const f = await fixture(t, { reply: index => index === 1
    ? toolCall('long_command', 'run_computer_command', { command: command("setTimeout(()=>process.stdout.write('completed-locally'),2200)") })
    : answer('The local command completed.') })
  const controller = new AbortController(), session = await f.nativeSession(controller, event => {
    if (event.type === 'tool' && event.status === 'running') started.resolve()
  })
  const turn = sendLuna(request({ fullAccess: true }), f.deps({ signal: controller.signal, toolSession: session, computerAccess: true }))
  turn.catch(() => {}) // Preserve the primary assertion if fixture cleanup cancels a failing test.
  await started.promise; await pause(1200)
  assert.equal(f.calls.length, 1, 'No model polling while the native command is running')
  assert.equal((await turn).success, true); assert.equal(f.calls.length, 2); assert.equal(f.spawns.length, 1)
  const output = f.calls[1].input.find(item => item.type === 'function_call_output')
  assert.match(output.output, /completed-locally/); assert.match(output.output, /completed/)
  assert.equal((await f.journal()).requests.length, 2)
})

test('Stop interrupts a long native command with no model poll or automatic rerun', integration, async t => {
  const started = defer()
  const f = await fixture(t, { reply: index => index === 1
    ? toolCall('running_command', 'run_computer_command', { command: command("require('node:fs').appendFileSync('started.txt','once');setInterval(()=>{},1000)") })
    : answer('Unexpected model poll.') })
  const controller = new AbortController(), session = await f.nativeSession(controller, event => {
    if (event.type === 'tool' && event.status === 'running') started.resolve()
  })
  const turn = sendLuna(request({ fullAccess: true }), f.deps({ signal: controller.signal, toolSession: session, computerAccess: true }))
  const stopped = assert.rejects(turn, { code: 'CANCELLED' })
  await started.promise; await pause(1200)
  assert.equal(f.calls.length, 1); controller.abort('stopped'); await stopped
  await session.close()
  assert.equal(f.calls.length, 1); assert.equal(f.spawns.length, 1); assert.equal(f.respondAttempts().length, 1)
  assert.equal(await fs.readFile(path.join(f.root, 'started.txt'), 'utf8'), 'once')
  assert.equal((await f.journal()).requests.length, 1)
})
