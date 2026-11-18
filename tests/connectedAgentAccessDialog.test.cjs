'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { confirmDesktopFullAccess, SUMMARY, BUNDLE, DETAILS, VELO_SUMMARY } = require('../electron/connectedAgentAccessDialog.cjs')
const { VELO_CONSENT } = require('../electron/connectedAgentAccessPreference.cjs')

const denied = { approved: false, shareImagesAndView: false, remember: false }
function fixture(replies = []) {
  const state = { windowClosed: false, rendererGone: false, current: true }, dialogs = []
  const window = { isDestroyed: () => state.windowClosed, webContents: { isDestroyed: () => state.rendererGone } }
  const dialog = { async showMessageBox(owner, options) {
    assert.equal(owner, window)
    dialogs.push(options)
    assert.ok(dialogs.length <= replies.length, 'Unexpected extra dialog')
    const next = replies[dialogs.length - 1]
    return typeof next === 'function' ? next({ state, dialogs, window }) : next
  } }
  return { state, window, dialog, dialogs,
    confirm: (extra = {}) => confirmDesktopFullAccess({ window, dialog, isCurrent: () => state.current, ...extra }) }
}

test('desktop opens one short question with Cancel default, image bundle, and checked optional Remember', async () => {
  const f = fixture([{ response: 0 }])
  assert.deepEqual(await f.confirm(), denied)
  assert.equal(f.dialogs.length, 1)
  const options = f.dialogs[0]
  assert.equal(options.type, 'question')
  assert.equal(options.defaultId, 0)
  assert.equal(options.cancelId, 0)
  assert.equal(options.noLink, true)
  assert.deepEqual(options.buttons, ['Cancel', 'Enable full access', 'Learn more'])
  assert.equal(options.checkboxLabel, 'Remember on this desktop')
  assert.equal(options.checkboxChecked, true)
  assert.equal(options.detail, `${SUMMARY}\n\n${BUNDLE}`)
  assert.ok(options.detail.length < 400, 'The first confirmation stays short')
  assert.match(options.detail, /commands/)
  assert.match(options.detail, /files/)
  assert.match(options.detail, /image sharing/)
  assert.match(options.detail, /current Velorn view/)
  assert.match(options.detail, /spending settings stay separate/)
})

test('LM Studio receives a short tools warning and never promises computer-command access', async () => {
  const f = fixture([{ response: 2, checkboxChecked: true }, { response: 0 }, { response: 1, checkboxChecked: true }])
  assert.deepEqual(await f.confirm({ provider: 'lmstudio' }), { approved: true, shareImagesAndView: true, remember: true })
  assert.equal(f.dialogs[0].message, 'Allow full access to Velorn tools?')
  assert.match(f.dialogs[0].detail, /use Velorn tools automatically/)
  assert.doesNotMatch(f.dialogs[0].detail, /run commands/)
  assert.match(f.dialogs[1].detail, /not arbitrary computer commands/)
  assert.match(f.dialogs[1].detail, /without mandatory previews, checkpoints or repeated approvals/)
  assert.match(f.dialogs[1].detail, /Normal editor Undo remains available/)
})

test('Velo explicitly confirms versioned computer access with short risk/sharing warning and detailed boundaries', async () => {
  const f = fixture([{ response: 2, checkboxChecked: false }, { response: 0 }, { response: 1, checkboxChecked: false }])
  assert.deepEqual(await f.confirm({ provider: 'luna' }), { approved: true, shareImagesAndView: true, remember: false, scope: VELO_CONSENT.scope, version: VELO_CONSENT.version })
  const [prompt, more, back] = f.dialogs
  assert.equal(prompt.message, 'Allow full computer access?')
  assert.equal(prompt.detail, VELO_SUMMARY)
  assert.ok(prompt.detail.length < 250)
  for (const detail of [/run commands/, /change files/, /network services/, /data loss or costs/, /file content and command output/, /Velorn to OpenAI/]) assert.match(prompt.detail, detail)
  assert.doesNotMatch(prompt.detail, /allowance|generation spending|LM Studio|Codex/)
  assert.deepEqual(prompt.buttons, ['Cancel', 'Enable full access', 'Learn more'])
  assert.equal(prompt.defaultId, 0); assert.equal(prompt.cancelId, 0)
  assert.equal(prompt.checkboxChecked, true)
  assert.deepEqual(more.buttons, ['Back'])
  for (const detail of [/local shell commands/, /read, change or delete accessible files/, /normal operating-system user permissions/, /not administrator\/root privileges/, /No Codex installation or Codex sign-in is required/, /without mandatory previews, checkpoints or repeated approvals/, /Undo/, /not reverse completed work/, /Remember on this desktop restores/, /Share images and Include current view/, /not continuous screen streaming/, /Velorn service to OpenAI/, /inference allowance still applies/, /does not add or refill/, /separate generation spending settings/, /third-party network services can bypass/, /not a global spending cap/, /tools-only approval is not sufficient/, /fresh confirmation/, /current window, project and chat/]) assert.match(more.detail, detail)
  assert.doesNotMatch(more.detail, /not arbitrary computer commands|does not give it.*computer-command/)
  assert.doesNotMatch(more.detail, /LM Studio/)
  assert.equal(back.detail, prompt.detail)
  assert.equal(back.checkboxChecked, false)
})

test('only a fresh explicit Velo Enable returns the computer scope, with independent remembered and session-only choices', async () => {
  for (const checkboxChecked of [true, false, undefined, 'true']) {
    const f = fixture([{ response: 1, checkboxChecked }])
    assert.deepEqual(await f.confirm({ provider: 'luna', remembered: true }), {
      approved: true, shareImagesAndView: true, remember: checkboxChecked === true,
      scope: VELO_CONSENT.scope, version: VELO_CONSENT.version,
    })
    assert.equal(f.dialogs.length, 1)
  }
  const cancelled = fixture([{ response: 0, checkboxChecked: true }])
  assert.deepEqual(await cancelled.confirm({ provider: 'luna', remembered: true }), denied)
})

test('Velo Learn more is informational only; Cancel and stale owners cannot grant access', async () => {
  for (const end of [{ response: 0, checkboxChecked: true }, ({ state }) => { state.current = false; return { response: 1, checkboxChecked: true } }]) {
    const f = fixture([{ response: 2, checkboxChecked: true }, { response: 1 }, end])
    assert.deepEqual(await f.confirm({ provider: 'luna' }), denied)
  }
})

test('only explicit Enable grants the bundled images; Remember requires literal checked true', async () => {
  for (const checkboxChecked of [true, false, undefined, 'true', 1, null]) {
    const f = fixture([{ response: 1, checkboxChecked }])
    assert.deepEqual(await f.confirm(), { approved: true, shareImagesAndView: true, remember: checkboxChecked === true })
    assert.equal(f.dialogs[0].checkboxChecked, true)
  }
})

test('Remember defaults on; explicitly unchecking still makes access session-only', async () => {
  for (const remembered of [true, false, undefined, null, 'true', 1, {}, []]) {
    const f = fixture([{ response: 1, checkboxChecked: false }])
    assert.deepEqual(await f.confirm({ remembered }), { approved: true, shareImagesAndView: true, remember: false })
    assert.equal(f.dialogs[0].checkboxChecked, true)
  }
})

test('Learn more preserves a change away from previously remembered native consent', async () => {
  const f = fixture([{ response: 2, checkboxChecked: false }, { response: 0 }, { response: 1, checkboxChecked: false }])
  assert.deepEqual(await f.confirm({ remembered: true }), { approved: true, shareImagesAndView: true, remember: false })
  assert.equal(f.dialogs[0].checkboxChecked, true)
  assert.equal(f.dialogs[2].checkboxChecked, false)
})

test('Cancel never grants or remembers even if the checkbox was checked', async () => {
  const f = fixture([{ response: 0, checkboxChecked: true }])
  assert.deepEqual(await f.confirm(), denied)
})

test('malformed or unsupported native responses fail closed', async () => {
  for (const reply of [undefined, null, false, true, 'Enable', {}, { response: '1', checkboxChecked: true },
    { response: -1, checkboxChecked: true }, { response: 3, checkboxChecked: true }, { response: NaN, checkboxChecked: true }]) {
    const f = fixture([reply])
    assert.deepEqual(await f.confirm(), denied)
    assert.equal(f.dialogs.length, 1)
  }
})

test('Learn more shows information without granting and reopens the short prompt preserving Remember', async () => {
  const f = fixture([{ response: 2, checkboxChecked: true }, { response: 1 }, { response: 1, checkboxChecked: true }])
  assert.deepEqual(await f.confirm(), { approved: true, shareImagesAndView: true, remember: true })
  assert.equal(f.dialogs.length, 3)
  assert.equal(f.dialogs[1].type, 'info')
  assert.equal(f.dialogs[1].detail, DETAILS)
  assert.deepEqual(f.dialogs[1].buttons, ['Back'])
  assert.equal(f.dialogs[1].checkboxLabel, undefined)
  assert.equal(f.dialogs[2].type, 'question')
  assert.equal(f.dialogs[2].checkboxChecked, true)
  assert.equal(f.dialogs[2].detail, f.dialogs[0].detail)
})

test('an information-modal response cannot approve access or persist Remember by itself', async () => {
  const f = fixture([{ response: 2, checkboxChecked: true }, { response: 1, checkboxChecked: true }, { response: 0, checkboxChecked: true }])
  assert.deepEqual(await f.confirm(), denied)
  assert.equal(f.dialogs.length, 3)
})

test('repeated Learn more keeps the latest native checkbox choice without carrying it to a new request', async () => {
  const f = fixture([{ response: 2, checkboxChecked: true }, { response: 0 },
    { response: 2, checkboxChecked: false }, { response: 0 }, { response: 1, checkboxChecked: false }])
  assert.deepEqual(await f.confirm(), { approved: true, shareImagesAndView: true, remember: false })
  assert.equal(f.dialogs[2].checkboxChecked, true)
  assert.equal(f.dialogs[4].checkboxChecked, false)
  const next = fixture([{ response: 0 }])
  await next.confirm()
  assert.equal(next.dialogs[0].checkboxChecked, true)
})

test('Learn more retains concrete computer, spending, Undo, image and desktop-remember boundaries', () => {
  assert.match(DETAILS, /read, change or delete accessible files/)
  assert.match(DETAILS, /network services/)
  assert.match(DETAILS, /not administrator\/root privileges/)
  assert.match(DETAILS, /Undo remain where supported/)
  assert.match(DETAILS, /not guaranteed to be undoable/)
  assert.match(DETAILS, /Stop.*does not reverse/)
  assert.match(DETAILS, /can bypass those gates and may spend money/)
  assert.match(DETAILS, /not a global spending cap/)
  assert.match(DETAILS, /not continuous screen streaming/)
  assert.match(DETAILS, /full access can still read files independently/)
  assert.match(DETAILS, /Phone sharing and pairing remain separate/)
  assert.match(DETAILS, /Remember on this desktop is optional/)
  assert.match(DETAILS, /this installation after restarting/)
  assert.match(DETAILS, /Turning Full access off clears/)
  assert.match(DETAILS, /changed permission scope requires confirmation again/)
  assert.match(DETAILS, /LM Studio.*does not give it Codex computer-command access/)
})

test('closed or stale owners never open the initial native prompt', async () => {
  for (const key of ['windowClosed', 'rendererGone', 'current']) {
    const f = fixture()
    f.state[key] = key !== 'current'
    assert.deepEqual(await f.confirm(), denied)
    assert.equal(f.dialogs.length, 0)
  }
  const f = fixture()
  for (const isCurrent of [() => false, () => undefined, () => 1, () => { throw new Error('disposed') }]) {
    assert.deepEqual(await f.confirm({ isCurrent }), denied)
  }
  assert.deepEqual(await f.confirm({ window: undefined }), denied)
  assert.deepEqual(await f.confirm({ window: {} }), denied)
})

test('a late Enable response cannot grant after window destruction, renderer loss, or consent invalidation', async () => {
  for (const key of ['windowClosed', 'rendererGone', 'current']) {
    const f = fixture([({ state }) => { state[key] = key !== 'current'; return { response: 1, checkboxChecked: true } }])
    assert.deepEqual(await f.confirm(), denied)
    assert.equal(f.dialogs.length, 1)
  }
})

test('staleness after Learn more selection prevents opening the information modal', async () => {
  const f = fixture([({ state }) => { state.current = false; return { response: 2, checkboxChecked: true } }])
  assert.deepEqual(await f.confirm(), denied)
  assert.equal(f.dialogs.length, 1)
})

test('staleness while information is displayed prevents reopening a confirmation', async () => {
  for (const key of ['windowClosed', 'rendererGone', 'current']) {
    const f = fixture([{ response: 2, checkboxChecked: true }, ({ state }) => { state[key] = key !== 'current'; return { response: 0 } }])
    assert.deepEqual(await f.confirm(), denied)
    assert.equal(f.dialogs.length, 2)
  }
})

test('optional current callback defaults to checking the actual native window', async () => {
  const f = fixture([{ response: 1 }])
  assert.deepEqual(await confirmDesktopFullAccess({ window: f.window, dialog: f.dialog }), { approved: true, shareImagesAndView: true, remember: false })
})

test('native dialog failure does not become approval or an automatic retry', async () => {
  const f = fixture([() => { throw new Error('native dialog failed') }])
  await assert.rejects(f.confirm(), /native dialog failed/)
  assert.equal(f.dialogs.length, 1)
})

function mainConfirmation(dependencies) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf('  confirmFullAccess: async (')
  const end = source.indexOf('  getComfyRoot:', start)
  assert.ok(start > 0 && end > start)
  return vm.runInNewContext(`({${source.slice(start, end)}})`, {
    FULL_ACCESS_SUMMARY: SUMMARY, FULL_ACCESS_BUNDLE: BUNDLE, ...dependencies,
  }).confirmFullAccess
}

test('main uses the desktop helper for desktop actions even while a phone is paired', async () => {
  const window = {}, dialog = {}, isCurrent = () => true, calls = []
  const confirm = mainConfirmation({ dialog,
    mobileCompanion: { confirm: () => assert.fail('Desktop actions must not be diverted to the phone') },
    confirmDesktopFullAccess: args => { calls.push(args); return Promise.resolve({ approved: true, shareImagesAndView: true, remember: true }) },
  })
  for (const [fromPhone, remembered] of [[false, true], [undefined, false], [undefined, undefined]]) {
    const result = await confirm({ window, isCurrent, fromPhone, remembered })
    assert.equal(result.remember, true)
    assert.equal(calls.at(-1).window, window)
    assert.equal(calls.at(-1).dialog, dialog)
    assert.equal(calls.at(-1).isCurrent, isCurrent)
    assert.equal(calls.at(-1).remembered, remembered)
  }
})

test('main phone confirmation keeps sharing binding, forces Remember off, and needs no extra risk checkbox', async () => {
  const window = {}, calls = [], mobileBinding = { isCurrent: () => true }
  let approved = false
  const confirm = mainConfirmation({
    confirmDesktopFullAccess: () => assert.fail('Phone actions must not open the desktop Remember prompt'),
    mobileCompanion: { confirm: args => { calls.push(args); return Promise.resolve({ approved, mobileBinding, remember: true }) } },
  })
  for (approved of [false, true]) {
    const result = await confirm({ window, fromPhone: true })
    assert.equal(result.approved, approved)
    assert.equal(result.shareImagesAndView, approved)
    assert.equal(result.mobileBinding, mobileBinding)
    assert.equal(result.remember, false)
    assert.equal(calls.at(-1).window, window)
    assert.equal(calls.at(-1).kind, 'full-access')
    assert.equal(calls.at(-1).requiresRiskAcknowledgement, false)
    assert.match(calls.at(-1).detail, /image sharing/)
    assert.match(calls.at(-1).detail, /spending settings stay separate/)
    assert.doesNotMatch(calls.at(-1).detail, /Remember on this desktop/)
  }
})

test('unavailable phone confirmation cannot fall back to a desktop grant', async () => {
  for (const mobileCompanion of [null, { confirm: () => null }]) {
    const confirm = mainConfirmation({ mobileCompanion,
      confirmDesktopFullAccess: () => assert.fail('No desktop fallback for an unbound phone command'),
    })
    const result = await confirm({ window: {}, fromPhone: true })
    assert.equal(result.approved, false)
    assert.equal(result.shareImagesAndView, false)
    assert.equal(result.remember, false)
  }
})

test('main consumes a native phone bundle receipt once and enables ask-cloud without another confirmation', async () => {
  for (const provider of ['codex', 'lmstudio']) {
    const window = {}, claims = [], spending = [], legacy = []
    const consent = { approved: true, shareImagesAndView: true, remember: true, phoneBundleVersion: 1, mobileBinding: { isCurrent: () => true } }
    let claimed = false
    const confirm = mainConfirmation({
      confirmDesktopFullAccess: () => assert.fail('The phone button is already explicit consent'),
      mobileCompanion: {
        claimFullAccess: args => { claims.push(args); if (claimed) return null; claimed = true; return consent },
        confirm: args => { legacy.push(args); return Promise.resolve({ approved: false }) },
      },
      generationSpending: { enableAskCloudFromConsent: async args => { spending.push(args); assert.equal(args.isCurrent(), true); return { success: true, policy: 'ask-cloud' } } },
    })
    const result = await confirm({ window, provider, fromPhone: true, isCurrent: () => true })
    assert.equal(result, consent)
    assert.equal(result.remember, true)
    assert.equal(result.phoneBundleVersion, 1)
    assert.equal(claims.length, 1); assert.equal(claims[0].window, window); assert.equal(claims[0].provider, provider)
    assert.equal(spending.length, 1); assert.equal(spending[0].window, window)
    assert.equal(legacy.length, 0)
    const repeated = await confirm({ window, provider, fromPhone: true, isCurrent: () => true })
    assert.equal(repeated.approved, false)
    assert.equal(repeated.remember, false)
    assert.equal(legacy.length, 1, 'No claimed receipt remains to reuse')
    assert.equal(spending.length, 1, 'A repeated request cannot reuse the one-use bundle consent')
  }
})

test('main rejects expired native phone consent before applying any bundle permission', async () => {
  for (const stale of ['owner', 'binding', 'missing-binding']) {
    const consent = { approved: true, shareImagesAndView: true, remember: true, phoneBundleVersion: 1,
      ...(stale === 'missing-binding' ? {} : { mobileBinding: { isCurrent: () => stale !== 'binding' } }) }
    const confirm = mainConfirmation({
      mobileCompanion: { claimFullAccess: () => consent, confirm: () => assert.fail('Stale consent must not open another confirmation') },
      generationSpending: { enableAskCloudFromConsent: () => assert.fail('Stale consent must not change spending policy') },
      confirmDesktopFullAccess: () => assert.fail('No desktop fallback'),
    })
    const result = await confirm({ window: {}, fromPhone: true, isCurrent: () => stale !== 'owner' })
    assert.equal(result.approved, false); assert.equal(result.remember, false); assert.equal(result.shareImagesAndView, false)
  }
})

test('main cannot return a grant after a spending-save failure or consent expiry during saving', async () => {
  for (const failure of ['save-failed', 'wrong-policy', 'throw', 'owner-expired', 'binding-expired']) {
    let ownerCurrent = true, bindingCurrent = true, calls = 0
    const confirm = mainConfirmation({
      mobileCompanion: {
        claimFullAccess: () => ({ approved: true, shareImagesAndView: true, remember: true, phoneBundleVersion: 1, mobileBinding: { isCurrent: () => bindingCurrent } }),
        confirm: () => assert.fail('A failed bundle must not be silently reapproved'),
      },
      generationSpending: { enableAskCloudFromConsent: async args => {
        calls++; assert.equal(args.isCurrent(), true)
        if (failure === 'throw') throw Error('Storage failed')
        if (failure === 'owner-expired') ownerCurrent = false
        if (failure === 'binding-expired') bindingCurrent = false
        return failure === 'save-failed' ? { success: false, error: { message: 'Storage failed' } }
          : { success: true, policy: failure === 'wrong-policy' ? 'local-only' : 'ask-cloud' }
      } },
      confirmDesktopFullAccess: () => assert.fail('No desktop fallback'),
    })
    await assert.rejects(confirm({ window: {}, fromPhone: true, isCurrent: () => ownerCurrent }), /Storage failed|setup could not finish/)
    assert.equal(calls, 1)
  }
})

test('native spending confirmations retain their separate risk acknowledgement', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const spending = source.slice(source.indexOf('  confirmPolicyChange:'), source.indexOf('// Only the main Velorn renderer'))
  assert.equal((spending.match(/requiresRiskAcknowledgement: true/g) || []).length, 2)
})
