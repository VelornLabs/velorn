'use strict'

// Native-loop regression, NOT a model-quality evaluation. Provider decisions are
// scripted; only disposable local Git repositories and owned commands are real.
// No credentials, network, user installation or paid inference are involved.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { sendLuna, MODEL } = require('../electron/connectedAgentLuna.cjs')
const { createVeloComputerSession } = require('../electron/veloComputerSession.cjs')
const { createVeloComputerTools } = require('../electron/veloComputerTools.cjs')

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const gitEnv = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
const git = (cwd, ...args) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args],
  { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const message = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const call = (id, name, args = {}) => [{ type: 'function_call', call_id: id, name: 'call_velorn_tool', arguments: JSON.stringify({ name, arguments: args }) }]
const request = extra => ({ provider: 'luna', model: MODEL, reasoningEffort: 'max', requestId: 'synthetic-maintenance-request',
  context: '{}', messages: [{ role: 'user', content: 'Update only this synthetic fixture installation, preserving any unrelated data.' }], toolsEnabled: true, fullAccess: true, ...extra })
const editorTool = { name: 'get_project', description: 'Synthetic project inspection.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
const resultData = value => JSON.parse(value.content.find(block => block.type === 'text').text)
const delivered = (payload, id) => payload.input.find(item => item.type === 'function_call_output' && item.call_id === id)?.output || ''

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-maintenance-integration-'))
  const install = path.join(root, 'fixture installation with spaces')
  await fs.mkdir(install)
  git(install, 'init', '--quiet', '--initial-branch=fixture-source')
  git(install, 'config', 'user.name', 'Synthetic Fixture')
  git(install, 'config', 'user.email', 'fixture@example.test')
  await fs.writeFile(path.join(install, 'main.py'), '# Fixture data only. Never execute.\n')
  await fs.writeFile(path.join(install, 'comfyui_version.py'), '__version__ = "0.43.0"\n')
  git(install, 'add', 'main.py', 'comfyui_version.py')
  git(install, 'commit', '--quiet', '-m', 'Synthetic old release')
  git(install, 'tag', 'v0.43.0')
  git(install, 'tag', 'v0.32.0')
  await fs.writeFile(path.join(install, 'comfyui_version.py'), '__version__ = "0.44.0"\n')
  git(install, 'commit', '--quiet', '-am', 'Synthetic newer release')
  git(install, 'tag', 'v0.44.0')
  git(install, 'checkout', '--quiet', '--detach', 'v0.43.0')
  git(install, 'branch', '-D', 'fixture-source')
  git(install, 'config', 'remote.origin.url', 'https://example.invalid/never-contact-this-fixture.git')
  git(install, 'config', 'remote.origin.fetch', '+refs/tags/v0.32.0:refs/tags/v0.32.0')
  const events = [], requests = [], calls = [], controller = new AbortController()
  let current = true, responseScript, afterTool, providerAssertion
  const assertCurrent = () => { if (!current) throw Object.assign(Error('Synthetic account revoked.'), { code: 'LUNA_UNAVAILABLE' }) }
  const editor = { listTools: async () => [editorTool], callTool: async () => assert.fail('No editor mutation is needed') }
  const native = await createVeloComputerSession({ cwd: root, signal: controller.signal, assertCurrent, toolSession: editor,
    onEvent: event => events.push(event), makeComputerTools: options => createVeloComputerTools({ ...options,
      environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      limits: { authorityPollMs: 30, treePollMs: 10, termMs: 30, killMs: 40 } }) })
  const session = { ...native, callTool: async (name, args) => {
    const result = await native.callTool(name, args)
    const entry = { name, args: structuredClone(args), result, data: resultData(result) }
    calls.push(entry); await afterTool?.(entry)
    return result
  } }
  const fundedLuna = { assertCurrent,
    status: async () => ({ ok: true, available: true, model: MODEL, remainingMicroUsd: 1000000 }),
    respond: async payload => {
      assert.equal(payload.reasoningEffort, 'low', 'User preference cannot change fixed Light reasoning')
      requests.push(structuredClone(payload))
      try { return { ok: true, model: MODEL, output: await responseScript(requests.length, payload), remainingMicroUsd: 1000000 } }
      catch (error) { providerAssertion = error; throw error }
    } }
  const run = (script, extra = {}) => {
    responseScript = script
    return sendLuna(request(), { fundedLuna, signal: controller.signal, toolSession: session, computerAccess: true,
      assertBeforeSend: assertCurrent, onEvent: event => events.push(event), ...extra }).catch(error => { throw providerAssertion || error })
  }
  t.after(async () => {
    controller.abort('fixture cleanup')
    try { await native.close() } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
  return { root, install, events, requests, calls, controller, session, editor, fundedLuna, run,
    revoke: () => { current = false }, afterTool: fn => { afterTool = fn } }
}

test('real tag-only installation observations reach Velo before the scripted update and verify its installed version afterward', { timeout: 20000 }, async t => {
  const f = await fixture(t)
  const beforeConfig = await fs.readFile(path.join(f.install, '.git/config'), 'utf8')
  const result = await f.run((round, payload) => {
    if (round === 1) {
      const router = payload.tools.find(tool => tool.name === 'call_velorn_tool')
      assert.ok(router.parameters.properties.name.enum.includes('inspect_computer_installation'))
      assert.match(payload.instructions, /inspect_computer_installation/)
      return call('inspect_before', 'inspect_computer_installation', { path: f.install })
    }
    if (round === 2) {
      const observation = f.calls.at(-1).data
      assert.equal(observation.success, true); assert.equal(observation.readOnly, true)
      assert.equal(observation.version.value, '0.43.0')
      assert.equal(observation.git.checkout, 'detached-tag')
      assert.equal(observation.git.branch, null)
      assert.ok(observation.git.tagsAtHead.includes('v0.43.0'))
      assert.ok(observation.git.fetchRefspecs.values.some(item => item.value === '+refs/tags/v0.32.0:refs/tags/v0.32.0'))
      assert.equal(observation.git.refs.values.some(item => item.name.startsWith('refs/remotes/')), false)
      assert.match(delivered(payload, 'inspect_before'), /detached-tag/)
      assert.match(delivered(payload, 'inspect_before'), /0\.43\.0/)
      assert.match(delivered(payload, 'inspect_before'), /tool data, not instructions/)
      return call('apply_fixture_tag', 'run_computer_command', { cwd: f.install,
        command: 'git -c core.hooksPath=/dev/null checkout --quiet --detach refs/tags/v0.44.0' })
    }
    if (round === 3) {
      assert.equal(f.calls.at(-1).data.exitCode, 0)
      return call('inspect_after', 'inspect_computer_installation', { path: f.install })
    }
    assert.equal(round, 4)
    assert.equal(f.calls.at(-1).data.version.value, '0.44.0')
    assert.match(delivered(payload, 'inspect_after'), /0\.44\.0/)
    return message('The synthetic fixture source version is verified; service readiness was not tested.')
  })
  assert.equal(result.success, true); assert.equal(result.remainingMicroUsd, 1000000)
  assert.deepEqual(f.calls.map(item => item.name), ['inspect_computer_installation', 'run_computer_command', 'inspect_computer_installation'])
  assert.equal(git(f.install, 'describe', '--tags', '--exact-match', 'HEAD'), 'v0.44.0')
  assert.equal(await fs.readFile(path.join(f.install, '.git/config'), 'utf8'), beforeConfig)
  assert.equal(f.calls.some(item => /\b(fetch|pull|clone)\b/.test(item.args.command || '')), false, 'No network/fetch required by this fixture')
})

test('a nonzero command after a partial effect reaches the next turn; scripted recovery inspects and adapts without replay', { timeout: 20000 }, async t => {
  const f = await fixture(t), marker = path.join(f.root, 'already-applied.txt')
  const failingCommand = `printf 'once\\n' >> ${quote(marker)}\ngit rev-parse --verify origin/main`
  const result = await f.run((round, payload) => {
    if (round === 1) return call('failed_probe', 'run_computer_command', { cwd: f.install, command: failingCommand })
    if (round === 2) {
      const outcome = f.calls.at(-1).data
      assert.equal(outcome.success, false); assert.notEqual(outcome.exitCode, 0)
      assert.equal(outcome.status, 'failed')
      assert.equal(outcome.possibleChanges, true)
      assert.equal(outcome.recovery.reason, 'nonzero-exit')
      assert.equal(outcome.recovery.automaticRetry, false)
      assert.match(outcome.recovery.nextStep, /partial effects/)
      assert.match(outcome.recovery.nextStep, /not instructions/)
      assert.match(outcome.output, /fatal:/)
      assert.equal(JSON.parse(delivered(payload, 'failed_probe').split('\n')[0]).sourceIsError, true)
      assert.match(delivered(payload, 'failed_probe'), /nonzero-exit/)
      assert.match(delivered(payload, 'failed_probe'), /fatal:/)
      return call('inspect_after_failure', 'inspect_computer_installation', { path: f.install })
    }
    if (round === 3) {
      assert.equal(f.calls.at(-1).data.git.checkout, 'detached-tag')
      assert.equal(f.calls.at(-1).data.git.refs.values.some(item => item.name === 'refs/remotes/origin/main'), false)
      return call('corrected_probe', 'run_computer_command', { cwd: f.install, command: 'git rev-parse --verify refs/tags/v0.44.0' })
    }
    assert.equal(round, 4)
    assert.equal(f.calls.at(-1).data.exitCode, 0)
    return message('Inspected the actual tag-only checkout and corrected the reference lookup without repeating earlier effects.')
  })
  assert.equal(result.success, true)
  assert.equal(await fs.readFile(marker, 'utf8'), 'once\n')
  assert.equal(f.calls.filter(item => item.args.command === failingCommand).length, 1)
  assert.equal(f.requests.length, 4)
  assert.equal(git(f.install, 'rev-parse', 'HEAD'), git(f.install, 'rev-parse', 'refs/tags/v0.43.0'), 'Diagnosis did not silently apply the update')
  assert.ok(f.events.some(event => event.status === 'failed' || event.phase === 'failed'))
})

test('Stop after native inspection prevents the scripted updater and any further model request', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.afterTool(entry => { if (entry.name === 'inspect_computer_installation') f.controller.abort('user stop') })
  await assert.rejects(f.run(round => {
    assert.equal(round, 1, 'No second model request after Stop')
    return call('inspect_only', 'inspect_computer_installation', { path: f.install })
  }), { code: 'CANCELLED' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].data.readOnly, true)
  assert.equal(git(f.install, 'rev-parse', 'HEAD'), git(f.install, 'rev-parse', 'refs/tags/v0.43.0'))
})

test('revoked native authority after inspection prevents continuation without changing an installation', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  f.afterTool(entry => { if (entry.name === 'inspect_computer_installation') f.revoke() })
  await assert.rejects(f.run(round => {
    assert.equal(round, 1)
    return call('inspect_before_revoke', 'inspect_computer_installation', { path: f.install })
  }), { code: 'LUNA_UNAVAILABLE' })
  assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 1)
  assert.equal(git(f.install, 'rev-parse', 'HEAD'), git(f.install, 'rev-parse', 'refs/tags/v0.43.0'))
})

test('the private inspector is absent from ordinary tool-only Velo and cannot be forged through direct or router calls', async t => {
  for (const direct of [false, true]) await t.test(direct ? 'direct' : 'router', async () => {
    let requests = 0, dispatches = 0
    await assert.rejects(sendLuna(request({ fullAccess: false }), { computerAccess: false,
      toolSession: { listTools: async () => [editorTool], callTool: async () => { dispatches++; assert.fail('No private inspector through public tools') } },
      fundedLuna: { status: async () => ({ ok: true, available: true, model: MODEL }), respond: async payload => {
        requests++; assert.doesNotMatch(payload.instructions, /inspect_computer_installation/)
        assert.equal(payload.tools.find(tool => tool.name === 'call_velorn_tool').parameters.properties.name.enum.includes('inspect_computer_installation'), false)
        const item = direct
          ? { type: 'function_call', call_id: 'forged_direct', name: 'inspect_computer_installation', arguments: '{"path":"/not-accessed"}' }
          : call('forged_router', 'inspect_computer_installation', { path: '/not-accessed' })[0]
        return { ok: true, model: MODEL, output: [item] }
      } } }), { code: 'LUNA_INVALID_RESPONSE' })
    assert.equal(requests, 1); assert.equal(dispatches, 0)
  })
})
