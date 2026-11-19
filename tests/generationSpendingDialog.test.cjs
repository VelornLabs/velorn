'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Exercise the production main-process callback, not a parallel prompt copy.
const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
const spendingStart = source.indexOf('const generationSpending = registerGenerationSpendingIpc({')
assert.ok(spendingStart > 0)
const start = source.indexOf('  confirmSpend: async (', spendingStart)
const end = source.indexOf('\n})\n// Only the main Velorn renderer', start)
assert.ok(start > 0 && end > start)
const { approvalOnPhoneAndDesktop } = require('../electron/approvalOnPhoneAndDesktop.cjs')
// With a paired phone the computer's prompt opens too and nobody answers it
// here: it stays open until the phone's decision closes it.
function fixture({ answer = { response: 0 }, mobileAnswer } = {}) {
  const window = {}, dialogs = [], mobile = [], signal = new AbortController().signal
  const state = { closedByPhone: 0 }
  const confirm = vm.runInNewContext(`({${source.slice(start, end)}})`, {
    approvalOnPhoneAndDesktop, AbortController,
    dialog: { showMessageBox: async (owner, options) => {
      assert.equal(owner, window); dialogs.push(options)
      assert.ok(options.signal instanceof AbortSignal, 'The desktop prompt can be closed')
      if (mobileAnswer === undefined) return answer
      return new Promise(resolve => options.signal.addEventListener('abort', () => { state.closedByPhone++; resolve({ response: 0, checkboxChecked: false }) }, { once: true }))
    } },
    mobileCompanion: { confirm: options => { mobile.push(options); return mobileAnswer === undefined ? null : Promise.resolve(mobileAnswer) } },
  }).confirmSpend
  const input = { window, signal, endpoint: 'http://127.0.0.1:8188', fingerprint: 'abcdef1234567890abcdef',
    assessment: { risk: 'unknown', nodeCount: 12 }, localTrust: { eligible: true, title: 'Saved lip sync workflow' } }
  return { dialogs, mobile, window, signal, input, state, confirm: extra => confirm({ ...input, ...extra }) }
}

test('only eligible unknown saved workflows receive the local trust option on desktop and phone', async () => {
  for (const [risk, eligible, offered] of [['unknown', true, true], ['paid', true, false], ['local', true, false], ['unknown', false, false], ['unknown', 'true', false]]) {
    const f = fixture()
    assert.equal(await f.confirm({ assessment: { risk, nodeCount: 1 }, localTrust: { eligible, title: 'Saved workflow' } }), false)
    assert.equal(f.dialogs.length, 1)
    assert.equal(f.dialogs[0].buttons.includes('Trust as local and run'), offered)
    assert.equal(f.mobile[0].allowLocalTrust, offered)
    assert.equal(f.mobile[0].workflowTitle, offered ? 'Saved workflow' : undefined)
    assert.equal(f.mobile[0].requiresRiskAcknowledgement, true)
    assert.equal(f.mobile[0].window, f.window); assert.ok(f.mobile[0].signal instanceof AbortSignal)
    if (offered) {
      assert.match(f.dialogs[0].detail, /your choice, not independent verification/)
      assert.match(f.dialogs[0].detail, /unless its configuration changes/)
      assert.match(f.dialogs[0].detail, /Known paid nodes still follow Generation spending/)
    }
  }
})

test('unknown review names the actual unfamiliar nodes without claiming they are paid', async () => {
  const f = fixture()
  await f.confirm({ assessment: { risk: 'unknown', nodeCount: 3,
    unknownNodes: [{ classType: 'NewLocalSampler' }, { classType: 'NewLocalSampler' }, { classType: 'LocalVideoSave' }] } })
  const options = f.dialogs[0]
  assert.equal(options.title, 'Review unfamiliar workflow')
  assert.match(options.detail, /Unrecognized nodes: NewLocalSampler, LocalVideoSave/)
  assert.match(options.detail, /Unrecognized does not mean paid/)
  assert.match(options.detail, /own credentials/)
  assert.match(options.detail, /does not supply its saved cloud API key/)
  assert.match(options.detail, /Approve this submission may use your cloud API key/)
})

test('Local only offers trust or Cancel, never approve-cloud-once, and still needs acknowledgement', async () => {
  for (const [response, checked, trusted] of [[0, true, false], [1, true, true], [1, false, false], [1, 'true', false], [2, true, false]]) {
    const f = fixture({ answer: { response, checkboxChecked: checked } })
    const result = await f.confirm({ policy: 'local-only' })
    if (trusted) { assert.equal(result.approved, true); assert.equal(result.trustLocal, true) }
    else assert.equal(result, false)
    assert.deepEqual(Array.from(f.dialogs[0].buttons), ['Cancel', 'Trust as local and run'])
    assert.match(f.dialogs[0].detail, /Local only stays on/)
    assert.match(f.dialogs[0].detail, /cannot approve cloud spending/)
    assert.doesNotMatch(f.dialogs[0].detail, /Approve this submission covers/)
    assert.equal(f.dialogs[0].defaultId, 0)
  }
})

test('legacy mobile approve-only cannot unlock Local only; explicit saved trust works with existing contract', async () => {
  for (const decision of [{ approved: true }, { approved: true, trustLocal: false }, { approved: false, trustLocal: true }, { approved: true, trustLocal: 'true' }]) {
    const f = fixture({ mobileAnswer: decision })
    assert.equal(await f.confirm({ policy: 'local-only' }), false)
    assert.deepEqual([f.dialogs.length, f.state.closedByPhone], [1, 1])
  }
  const f = fixture({ mobileAnswer: { approved: true, trustLocal: true } })
  const result = await f.confirm({ policy: 'local-only' })
  assert.equal(result.trustLocal, true)
  assert.equal(f.mobile[0].allowLocalTrust, true)
  assert.match(f.mobile[0].detail, /Choose Trust as local and run/)
  assert.deepEqual([f.dialogs.length, f.state.closedByPhone], [1, 1])
})

test('Local only refuses paid and ineligible reviews even if called directly', async () => {
  for (const extra of [{ assessment: { risk: 'paid' } }, { localTrust: { eligible: false } }, { localTrust: undefined }]) {
    const f = fixture({ answer: { response: 1, checkboxChecked: true }, mobileAnswer: { approved: true, trustLocal: true } })
    assert.equal(await f.confirm({ policy: 'local-only', ...extra }), false)
    assert.equal(f.dialogs.length, 0); assert.equal(f.mobile.length, 0)
  }
})

test('desktop local trust needs both the explicit third action and checked risk acknowledgement', async () => {
  for (const [response, checked, expected] of [[2, true, 'trust'], [2, false, false], [2, 'true', false], [1, true, true], [1, false, false], [0, true, false], ['2', true, false]]) {
    const f = fixture({ answer: { response, checkboxChecked: checked } })
    const result = await f.confirm()
    if (expected === 'trust') { assert.equal(result.approved, true); assert.equal(result.trustLocal, true) }
    else assert.equal(result, expected)
    assert.equal(f.dialogs[0].defaultId, 0); assert.equal(f.dialogs[0].cancelId, 0); assert.equal(f.dialogs[0].checkboxChecked, false)
  }
})

test('paid or ineligible desktop workflows can only receive one-submission approval', async () => {
  for (const extra of [{ assessment: { risk: 'paid', nodeCount: 12 } }, { localTrust: { eligible: false } }, { localTrust: undefined }]) {
    const forgedTrust = fixture({ answer: { response: 2, checkboxChecked: true } })
    assert.equal(await forgedTrust.confirm(extra), false)
    const approved = fixture({ answer: { response: 1, checkboxChecked: true } })
    assert.equal(await approved.confirm(extra), true)
    assert.equal(approved.dialogs[0].buttons.length, 2)
    assert.match(approved.dialogs[0].detail, /Approve ONE submission/)
    assert.match(approved.dialogs[0].detail, /does not authorize buying more credits, retries, or future generations/)
  }
})

test('mobile local trust is returned only for literal approved and trusted eligible receipts', async () => {
  for (const [approved, trustLocal, expected] of [[true, true, 'trust'], [true, false, true], [true, undefined, true], [true, 'true', true], [false, true, false], ['true', true, false]]) {
    const f = fixture({ mobileAnswer: { approved, trustLocal } })
    const result = await f.confirm()
    if (expected === 'trust') { assert.equal(result.approved, true); assert.equal(result.trustLocal, true) }
    else assert.equal(result, expected)
    assert.deepEqual([f.dialogs.length, f.state.closedByPhone], [1, 1], 'A phone decision closes the desktop prompt; it is never answered twice')
    assert.equal(f.mobile[0].kind, 'generation-spending')
  }
})

test('a paid or ineligible mobile approval cannot acquire remembered local trust', async () => {
  for (const extra of [{ assessment: { risk: 'paid', nodeCount: 12 } }, { localTrust: { eligible: false } }, { localTrust: undefined }]) {
    const f = fixture({ mobileAnswer: { approved: true, trustLocal: true } })
    assert.equal(await f.confirm(extra), true, 'Only the current submission is approved')
    assert.equal(f.mobile[0].allowLocalTrust, false)
    assert.equal(f.mobile[0].workflowTitle, undefined)
    assert.deepEqual([f.dialogs.length, f.state.closedByPhone], [1, 1])
  }
})

test('several waiting generations add one clearly worded batch button for paid workflows only', async () => {
  const paid = { risk: 'paid', nodeCount: 8, providers: ['OpenAI'], models: ['gpt-image-2.6-flare'] }
  const offered = fixture({ answer: { response: 2, checkboxChecked: true } })
  assert.deepEqual({ ...(await offered.confirm({ assessment: paid, localTrust: { eligible: false }, policy: 'ask-cloud', batchCount: 161 })) }, { approved: true, batchCount: 161 })
  assert.deepEqual(Array.from(offered.dialogs[0].buttons), ['Cancel', 'Approve this submission', 'Approve all 161'])
  assert.match(offered.dialogs[0].detail, /161 generations with this same model and settings are waiting/)
  assert.match(offered.dialogs[0].detail, /each at an unknown cost/)

  // Without the tick, the batch button approves nothing.
  const unticked = fixture({ answer: { response: 2, checkboxChecked: false } })
  assert.equal(await unticked.confirm({ assessment: paid, localTrust: { eligible: false }, policy: 'ask-cloud', batchCount: 161 }), false)

  // The ordinary button still approves only one.
  const single = fixture({ answer: { response: 1, checkboxChecked: true } })
  assert.equal(await single.confirm({ assessment: paid, localTrust: { eligible: false }, policy: 'ask-cloud', batchCount: 161 }), true)

  // One waiting, an unfamiliar workflow, or Local only: no batch button.
  for (const extra of [{ assessment: paid, batchCount: 1 }, { assessment: paid }, { assessment: { risk: 'unknown', nodeCount: 3 }, batchCount: 9 }]) {
    const none = fixture()
    await none.confirm({ localTrust: { eligible: false }, policy: 'ask-cloud', ...extra })
    assert.equal(none.dialogs[0].buttons.some(label => /Approve all/.test(label)), false)
  }

  // A paired phone approves one submission only.
  const phone = fixture({ mobileAnswer: { approved: true } })
  assert.equal(await phone.confirm({ assessment: paid, localTrust: { eligible: false }, policy: 'ask-cloud', batchCount: 161 }), true)
})
