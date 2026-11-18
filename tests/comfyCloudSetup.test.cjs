'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { createComfyCloudSetup, CHANNELS, REQUESTED, CHANGED, fingerprint, USER_WAIT_MS } = require('../electron/comfyCloudSetup.cjs')
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture(t, options = {}) {
  const handlers = new Map(), events = [], writes = [], waiting = [], abort = new AbortController()
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send: (...value) => events.push(value) })
  let window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  let key = options.key || '', busy = false, reads = 0
  const settings = { generationSpending: 'local-only', anotherPreference: 'preserved' }
  const scope = { signal: abort.signal, onWaiting: value => waiting.push(value) }
  const broker = createComfyCloudSetup({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) },
    app: new EventEmitter(), getMainWindow: () => window, getAgentScope: () => options.external ? null : scope,
    isExportBusy: () => busy, userWaitMs: options.userWaitMs || USER_WAIT_MS,
    assertAgentCurrent: async () => { await options.guard?.(); if (options.invalidContext) throw new Error('SECRET raw context failure') },
    readKey: async () => { reads++; await options.read?.(reads); return key },
    writeKey: async (value, control) => {
      await options.beforeCommit?.()
      control.assertCurrent()
      if (fingerprint(key) !== control.expectedDigest) throw new Error('SECRET raw concurrent write')
      if (options.failWrite) throw new Error('SECRET raw disk path or key')
      key = value; writes.push(value); control.onCommitted()
      await options.afterCommit?.()
    },
  })
  t.after(() => broker.dispose())
  const event = { sender: contents, senderFrame: contents.mainFrame }
  return { broker, abort, contents, handlers, events, waiting, writes, settings, event,
    call: (method, payload, from = event) => handlers.get(CHANNELS[method])(from, payload),
    setKey: value => { key = value }, key: () => key, reads: () => reads,
    setBusy: value => { busy = value; broker.exportChanged() },
    replace: () => { window = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} }), isDestroyed: () => false }) },
    async start() { const result = broker.api.request({}); await flush(); const current = await this.call('current'); return { result, requestId: current.request?.requestId } },
    save: (requestId, value = 'synthetic-user-entered-key', validation = 'valid', extra = {}) => handlers.get(CHANNELS.save)(event, { requestId, key: value, validation, ...extra }),
    cancel: requestId => handlers.get(CHANNELS.complete)(event, { requestId, outcome: 'cancelled', validation: 'unknown' }),
  }
}

test('fixed handoff is passive until explicitly requested and publishes no credential', async t => {
  const f = fixture(t)
  assert.deepEqual(await f.broker.api.status({}), { success: true, configured: false, validation: 'unknown', status: 'missing' })
  assert.deepEqual(f.events, []); assert.deepEqual(f.writes, [])
  const pending = await f.start()
  assert.match(pending.requestId, /^[a-f\d-]{36}$/)
  assert.deepEqual(f.events.find(([name]) => name === REQUESTED), [REQUESTED, { requestId: pending.requestId }])
  assert.ok(f.events.filter(([name]) => name === CHANGED).every(entry => entry.length === 1))
  const result = await f.save(pending.requestId)
  assert.deepEqual(result, { success: true, configured: true, validation: 'valid', status: 'verified', outcome: 'saved' })
  assert.deepEqual(await pending.result, result)
  assert.equal(f.key(), 'synthetic-user-entered-key')
  assert.deepEqual(f.waiting, [true, false])
  assert.deepEqual(f.settings, { generationSpending: 'local-only', anotherPreference: 'preserved' })
  assert.doesNotMatch(JSON.stringify([result, f.events, await f.broker.api.status({})]), /synthetic-user-entered|digest|fingerprint|apiKey/)
  assert.deepEqual((await f.call('current')).request, null)
})

test('configured is separate from verified and external changes invalidate cached validation', async t => {
  const f = fixture(t, { key: 'old-synthetic-key' })
  assert.equal((await f.broker.api.status({})).status, 'configured')
  const pending = await f.start()
  assert.equal((await f.save(pending.requestId, 'new-synthetic-key', 'unknown')).status, 'configured')
  await pending.result
  const next = await f.start()
  assert.equal((await f.save(next.requestId, 'new-synthetic-key', 'valid', { useExisting: true })).status, 'verified')
  await next.result
  assert.equal(f.writes.length, 1, 'Using the same saved key does not rewrite it')
  f.setKey('other-synthetic-key')
  assert.deepEqual(await f.broker.api.status({}), { success: true, configured: true, validation: 'unknown', status: 'configured' })
})

test('removal uses the same guarded native write and never changes spending policy', async t => {
  const f = fixture(t, { key: 'old-synthetic-key' }), pending = await f.start()
  assert.deepEqual(await f.save(pending.requestId, '', 'unknown'), { success: true, configured: false, validation: 'unknown', status: 'missing', outcome: 'removed' })
  assert.equal((await pending.result).outcome, 'removed'); assert.equal(f.key(), '')
  assert.equal(f.settings.generationSpending, 'local-only')
})

test('agent arguments never accept secrets, URLs, owners, approval or renderer completion', async t => {
  const f = fixture(t)
  for (const args of [{ key: 'secret' }, { url: 'https://example.test' }, { owner: 'a' }, { approved: true }, { outcome: 'saved' }, [], null]) {
    assert.equal((await f.broker.api.request(args)).success, false)
    assert.equal((await f.broker.api.status(args)).success, false)
  }
  assert.deepEqual(f.events, []); assert.equal(f.reads(), 0)
})

test('only the exact main document can current/save/complete, including guessed real ID', async t => {
  const f = fixture(t), pending = await f.start()
  for (const bad of [{ sender: {}, senderFrame: f.event.senderFrame }, { sender: f.contents, senderFrame: {} }, {}]) {
    assert.equal((await f.call('current', undefined, bad)).code, 'COMFY_CLOUD_SETUP_UNAUTHORIZED')
    assert.equal((await f.call('save', { requestId: pending.requestId, key: 'secret', validation: 'valid' }, bad)).code, 'COMFY_CLOUD_SETUP_UNAUTHORIZED')
    assert.equal((await f.call('complete', { requestId: pending.requestId, outcome: 'cancelled', validation: 'unknown' }, bad)).code, 'COMFY_CLOUD_SETUP_UNAUTHORIZED')
  }
  assert.deepEqual(f.writes, [])
  await f.cancel(pending.requestId); assert.equal((await pending.result).outcome, 'cancelled')
})

test('unknown fields, forged saved completion, invalid validation and duplicate replies cannot attest success', async t => {
  const f = fixture(t), pending = await f.start()
  for (const payload of [
    { requestId: pending.requestId, outcome: 'saved', validation: 'valid' },
    { requestId: pending.requestId, outcome: 'removed', validation: 'unknown' },
    { requestId: pending.requestId, outcome: 'cancelled', validation: 'valid', secret: 'x' },
  ]) assert.equal((await f.call('complete', payload)).success, false)
  assert.equal((await f.save(pending.requestId, 'secret', 'invalid')).code, 'COMFY_CLOUD_SETUP_INVALID_KEY')
  assert.equal((await f.save(pending.requestId, 'secret\nsecond', 'valid')).success, false)
  assert.equal((await f.save(pending.requestId, 'secret', 'valid', { approved: true })).success, false)
  assert.equal((await f.save('invented-id')).code, 'COMFY_CLOUD_SETUP_STALE')
  assert.equal((await f.save(pending.requestId)).success, true); await pending.result
  assert.equal((await f.save(pending.requestId)).code, 'COMFY_CLOUD_SETUP_STALE')
  assert.equal((await f.cancel(pending.requestId)).code, 'COMFY_CLOUD_SETUP_STALE')
  assert.equal(f.writes.length, 1)
})

test('concurrent request reservation remains held across async inspection and busy failures', async t => {
  const gate = defer(), f = fixture(t, { read: () => gate.promise })
  const pending = f.broker.api.request({})
  await flush()
  for (let i = 0; i < 3; i++) assert.equal((await f.broker.api.request({})).code, 'COMFY_CLOUD_SETUP_BUSY')
  assert.equal(f.reads(), 1)
  gate.resolve(); await flush()
  const current = await f.call('current'); await f.cancel(current.request.requestId); await pending
})

test('window reload, replacement, crash, shutdown and agent Stop revoke the request and late save', async t => {
  for (const action of ['navigation', 'replace', 'crash', 'stop', 'dispose']) {
    await t.test(action, async t => {
      const f = fixture(t), pending = await f.start()
      if (action === 'navigation') f.contents.emit('did-start-navigation', {}, 'file:///new', false, true)
      else if (action === 'replace') { f.replace(); await f.broker.api.status({}) }
      else if (action === 'crash') f.contents.emit('render-process-gone')
      else if (action === 'stop') f.abort.abort('Stop')
      else f.broker.dispose()
      assert.equal((await pending.result).status, 'cancelled')
      if (action !== 'dispose') assert.equal((await f.save(pending.requestId)).success, false)
      assert.deepEqual(f.writes, []); assert.deepEqual(f.waiting, [true, false])
    })
  }
})

test('deadline is bounded and does not leave late callbacks or waiting state', async t => {
  assert.equal(USER_WAIT_MS, 300000)
  const f = fixture(t, { userWaitMs: 20 }), pending = await f.start()
  assert.equal((await pending.result).code, 'COMFY_CLOUD_SETUP_EXPIRED')
  assert.equal((await f.save(pending.requestId)).code, 'COMFY_CLOUD_SETUP_STALE')
  assert.deepEqual(f.waiting, [true, false]); assert.deepEqual(f.writes, [])
})

test('export rejects request, cancels active dialog and guards the final write', async t => {
  const f = fixture(t)
  f.setBusy(true); assert.equal((await f.broker.api.request({})).success, false)
  assert.equal((await f.broker.api.status({})).success, true)
  f.setBusy(false); const pending = await f.start()
  f.setBusy(true)
  assert.equal((await pending.result).code, 'COMFY_CLOUD_SETUP_EXPORT_BUSY')
  assert.equal((await f.save(pending.requestId)).success, false); assert.deepEqual(f.writes, [])
})

test('Stop/cancel/export after queued Save but before atomic commit leave old key untouched', async t => {
  for (const action of ['stop', 'cancel', 'export']) await t.test(action, async t => {
    const gate = defer(), f = fixture(t, { key: 'original', beforeCommit: () => gate.promise }), pending = await f.start()
    const saving = f.save(pending.requestId); await flush()
    assert.equal((await f.save(pending.requestId)).code, 'COMFY_CLOUD_SETUP_BUSY')
    if (action === 'stop') f.abort.abort()
    else if (action === 'export') f.setBusy(true)
    else await f.cancel(pending.requestId)
    gate.resolve()
    assert.equal((await saving).success, false); assert.equal((await pending.result).status, 'cancelled')
    assert.equal(f.key(), 'original'); assert.deepEqual(f.writes, [])
  })
})

test('atomic commit settles saved BEFORE post-commit Stop, close, read failure or native cleanup failure', async t => {
  for (const action of ['stop', 'cancel', 'error']) await t.test(action, async t => {
    const gate = defer(), f = fixture(t, { key: 'original', read: count => { if (count > 2) throw new Error('Postcommit read must not be necessary') },
      afterCommit: async () => { await gate.promise; if (action === 'error') throw new Error('Raw postcommit failure') } }), pending = await f.start()
    const saving = f.save(pending.requestId); await flush()
    assert.equal(f.key(), 'synthetic-user-entered-key')
    const receipt = await pending.result
    assert.equal(receipt.outcome, 'saved'); assert.equal(receipt.status, 'verified')
    if (action === 'stop') f.abort.abort()
    else if (action === 'cancel') assert.equal((await f.cancel(pending.requestId)).code, 'COMFY_CLOUD_SETUP_STALE')
    gate.resolve(); assert.deepEqual(await saving, receipt); assert.equal(f.reads(), 2)
  })
})

test('changed stored key cannot be overwritten or validated using stale UI state', async t => {
  for (const useExisting of [false, true]) await t.test(String(useExisting), async t => {
    const f = fixture(t, { key: 'original' }), pending = await f.start()
    f.setKey('changed-outside-dialog')
    assert.equal((await f.save(pending.requestId, 'original', 'valid', { useExisting })).code, 'COMFY_CLOUD_SETUP_KEY_CHANGED')
    assert.equal(f.key(), 'changed-outside-dialog'); assert.deepEqual(f.writes, [])
    assert.equal((await f.broker.api.status({})).validation, 'unknown')
    await f.cancel(pending.requestId); await pending.result
  })
})

test('read/write/context errors are sanitized and failure cannot silently settle saved', async t => {
  const f = fixture(t, { failWrite: true }), pending = await f.start()
  const failed = await f.save(pending.requestId)
  assert.equal(failed.success, false); assert.doesNotMatch(JSON.stringify(failed), /SECRET|disk path|synthetic-user/)
  assert.equal((await f.call('current')).request.requestId, pending.requestId)
  await f.cancel(pending.requestId); assert.equal((await pending.result).outcome, 'cancelled')
  assert.equal(f.key(), '')
  const broken = fixture(t, { invalidContext: true })
  assert.doesNotMatch(JSON.stringify(await broken.broker.api.request({})), /SECRET/)
})

test('invalid tested key can be reported on cancellation without attesting any saved key', async t => {
  const f = fixture(t, { key: 'existing-unverified' }), pending = await f.start()
  const result = await f.call('complete', { requestId: pending.requestId, outcome: 'cancelled', validation: 'invalid' })
  assert.deepEqual(await pending.result, result); assert.equal(result.status, 'invalid'); assert.equal(result.configured, undefined)
  assert.equal((await f.broker.api.status({})).validation, 'unknown')
})
