'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { fork } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { initializeDesktopEngine } = require('../electron/veloDesktopEngine.cjs')
const { startDesktopBroker } = require('../electron/veloDesktopBroker.cjs')
test('actual desktop adapter, Node worker, native engine, MCP, wait, same chat resume: zero paid requests', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-desktop-flow-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = new EventEmitter(); app.getPath = () => root; app.isPackaged = false
  const api = initializeDesktopEngine(app, { createBroker: options => startDesktopBroker({ ...options,
    forkImpl: (file, args, opts) => fork(file, args, { ...opts, execArgv: ['--require', path.join(__dirname, 'fixtures/native-worker-fetch.cjs')] }) }) })
  let toolCalls = 0, waiting = 0
  const authority = new AbortController()
  const lease = { signal: authority.signal, assertCurrent() { assert.equal(authority.signal.aborted, false) },
    nativeEngineAuthority: () => ({ accountScope: 'synthetic-desktop', token: 'SYNTHETIC_ACCOUNT_ONLY',
      computerId: 'synthetic-computer', baseUrl: 'https://connect.velorn.ai/account/desktop/luna/native-test/v1' }) }
  const request = { conversationId: 'stable-chat', toolsEnabled: true, fullAccess: false, messages: [{ role: 'user', content: 'FIRST_NATIVE' }] }
  const options = { fundedLuna: lease, signal: new AbortController().signal,
    engineContext: { projectKey: 'synthetic-project', workspaceDir: root, assertCurrent: async () => true },
    assertBeforeSend: async () => lease.assertCurrent(), onWaiting: value => { if (value) waiting++ },
    toolSession: { listTools: async () => [{ name: 'receipt_probe', description: 'Synthetic once-only action.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
      callTool: async name => { assert.equal(name, 'receipt_probe'); toolCalls++; assert.equal(toolCalls, 1);
        return { content: [{ type: 'text', text: 'RECEIPT_ONCE' }] } } } }
  const first = await api.sendVelo(request, options)
  assert.equal(first.text, 'SHADOW_FIRST'); assert.equal(toolCalls, 1); assert.ok(waiting > 0)
  const accountDir = fs.readdirSync(path.join(root, 'velo-native'))[0]
  const threads = path.join(root, 'velo-native', accountDir, 'threads')
  const record = fs.readdirSync(threads).find(file => file.endsWith('.json'))
  const before = JSON.parse(fs.readFileSync(path.join(threads, record)))
  request.messages.push({ role: 'assistant', content: first.text }, { role: 'user', content: 'FOLLOWUP_NATIVE' })
  const followup = await api.sendVelo(request, options)
  assert.equal(followup.text, 'SHADOW_RETAINED'); assert.equal(toolCalls, 1)
  const after = JSON.parse(fs.readFileSync(path.join(threads, record)))
  assert.equal(after.threadId, before.threadId); assert.equal(after.status, 'completed')
  const full = await api.sendVelo({ ...request, conversationId: 'full-native-chat', fullAccess: true,
    messages: [{ role: 'user', content: 'FULL_NATIVE' }] }, { ...options, computerAccess: true })
  assert.equal(full.text, 'FULL_SHELL_FINISHED'); assert.equal(toolCalls, 1)
  app.emit('will-quit')
})
