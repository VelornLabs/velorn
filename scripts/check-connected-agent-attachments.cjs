// RAM-only renderer regression; no model calls, workflow imports or project edits.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Loopback fixture only')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-agent-attachments-'))
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, serviceWorkers: 'block' })
  const page = await context.newPage(), errors = [], blocked = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === base.origin && !/^\/(prompt|queue|history|upload|view|ws|v1|api)(\/|$)/.test(url.pathname)) return route.continue()
    blocked.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  const button = name => page.getByRole('button', { name, exact: true })
  const openSettings = async () => {
    if (await button('Assistant settings').getAttribute('aria-expanded') !== 'true') await button('Assistant settings').click()
    // Attachment regressions also exercise individual permission controls.
    const advanced = page.locator('summary').filter({ hasText: /^Access options$/ })
    if (!(await advanced.evaluate(node => node.parentElement.open))) await advanced.click()
  }
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  const composer = page.getByRole('textbox', { name: 'Message your agent', exact: true })
  // Approval policy now lives in settings, while its chat status remains visible.
  const ask = page.getByRole('radio', { name: 'Ask first', exact: true, includeHidden: true })
  const auto = page.getByRole('radio', { name: 'Auto-approve editing', exact: true, includeHidden: true })
  const files = page.getByLabel('Attach files', { exact: true })
  const file = (name, text, mimeType = 'application/json') => ({ name, mimeType, buffer: Buffer.from(text) })
  let groups = 0
  const pass = label => console.log(`PASS ${++groups}: ${label}`)
  const send = async text => {
    const before = (await snapshot()).requests.length
    if (text !== undefined) await composer.fill(text)
    await button('Send message').click()
    await page.waitForFunction(count => window.connectedAgentTest.snapshot().requests.length > count, before)
    return (await snapshot()).requests.at(-1)
  }
  const settle = async request => {
    await page.evaluate(id => window.connectedAgentTest.settle(id, { success: true, text: 'Synthetic response only.' }), request.requestId)
    await button('Send message').waitFor()
  }
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    const baseline = (await snapshot()).authored
    await button('Assistant').click(); await composer.waitFor()
    assert.equal(await ask.isChecked(), true); assert.equal(await auto.isDisabled(), true)
    await openSettings(); await page.getByRole('checkbox', { name: 'Velorn tools', exact: true }).check()
    await auto.check(); await button('Back to chat').click()
    const initialChat = await page.getByRole('combobox', { name: 'Conversation', exact: true }).inputValue()
    const workflow = '{"1":{"class_type":"Fixture","inputs":{"text":"PRIVATE_JSON_CONTENT_7391"}}}'
    await files.setInputFiles(file('workflow.json', workflow))
    await button('Remove attachment workflow.json').waitFor()
    assert.equal((await snapshot()).requests.length, 0)
    assert.equal(JSON.stringify((await snapshot()).storage).includes('PRIVATE_JSON_CONTENT_7391'), false)
    pass('File picker stages exact JSON locally, with no sending or persisted contents')

    await composer.evaluate(node => {
      const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 30
      canvas.getContext('2d').fillRect(0, 0, 30, 30)
      const bytes = Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), char => char.charCodeAt(0))
      const clipboardData = new DataTransfer(); clipboardData.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    })
    await button('Remove attachment pasted.png').waitFor()
    assert.equal(await page.getByRole('img', { name: 'Attachment: pasted.png' }).count(), 1)
    await page.getByRole('navigation', { name: 'Fixture workspace modes' }).getByRole('button', { name: 'Generate', exact: true }).click()
    assert.equal(await auto.isChecked(), true); await button('Remove attachment pasted.png').waitFor()
    pass('Pasted image previews and approval mode survive workspace changes')
    await page.screenshot({ path: path.join(output, 'chat-attachments-and-approvals.png'), fullPage: true })

    await button('New chat').click(); assert.equal(await ask.isChecked(), true)
    assert.equal(await page.getByLabel('Message attachments', { exact: true }).count(), 0)
    await page.getByRole('combobox', { name: 'Conversation', exact: true }).selectOption(initialChat)
    await button('Remove attachment workflow.json').waitFor(); assert.equal(await auto.isChecked(), true)
    pass('New chats default to Ask first; drafts and session permissions are isolated per conversation')

    const first = await send('Inspect these only; do not import or generate.')
    assert.equal(first.autoApproveEdits, true)
    assert.deepEqual(first.documents, [{ name: 'workflow.json', text: workflow }])
    assert.equal(first.images.length, 1); assert.match(first.images[0].dataUrl, /^data:image\/jpeg;base64,/)
    assert.equal(first.allowToolImages, false, 'Explicit attachments do not opt into automatic project image sharing')
    assert.equal(await auto.isDisabled(), true)
    assert.equal(JSON.stringify((await snapshot()).storage).includes('PRIVATE_JSON_CONTENT_7391'), false)
    await settle(first)
    const second = await send('Continue the discussion.')
    assert.deepEqual(second.documents, []); assert.equal(second.images.length, 0)
    assert.equal(JSON.stringify(second.messages).includes('PRIVATE_JSON_CONTENT_7391'), false)
    await settle(second)
    pass('Send includes explicit files once; history stores receipts only and busy turns freeze approval policy')

    await files.setInputFiles(file('broken.json', '{broken'))
    await page.getByRole('alert').filter({ hasText: 'valid JSON' }).waitFor()
    await files.setInputFiles(file('bad.svg', '<svg/>', 'image/svg+xml'))
    await page.getByRole('alert').filter({ hasText: 'not supported' }).waitFor()
    await files.setInputFiles(file('large.json', JSON.stringify({ value: 'x'.repeat(140000) })))
    await page.getByRole('alert').filter({ hasText: '128 KiB' }).waitFor()
    assert.equal((await snapshot()).requests.length, 2)
    pass('Invalid, oversized and unsupported files are refused before provider calls')

    await page.locator('.ca-compose').evaluate(node => {
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(['{"hello":"world"}'], 'dropped.json', { type: 'application/json' }))
      node.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }))
    })
    await button('Remove attachment dropped.json').waitFor(); await button('Remove attachment dropped.json').click()
    assert.equal(await page.getByLabel('Message attachments', { exact: true }).count(), 0)
    const third = await send('Ordinary pasted text remains ordinary text.')
    assert.equal(third.messages.at(-1).content, 'Ordinary pasted text remains ordinary text.')
    await settle(third)
    pass('Dropped JSON can be removed; ordinary text stays editable')

    await openSettings(); await page.getByRole('checkbox', { name: 'Velorn tools', exact: true }).uncheck()
    await button('Back to chat').click(); assert.equal(await ask.isChecked(), true)
    await button('Assistant settings').click(); await page.getByLabel('Assistant selection', { exact: true }).selectOption('lmstudio'); if (await page.getByRole('group', { name: 'Confirm assistant switch' }).count()) await page.getByRole('group', { name: 'Confirm assistant switch' }).getByRole('button', { name: /^Start .* chat$/ }).click()
    // Provider changes start a fresh chat and close settings. Reopen the new
    // provider's picker, then explicitly commit its custom model selection.
    await openSettings()
    await page.getByLabel('Model', { exact: true }).selectOption('__custom__')
    await page.getByLabel('Custom model ID', { exact: true }).fill('local-text-model')
    await button('Use model').click()
    // Reuse a real decoded thumbnail, not a fabricated byte payload.
    await files.setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQWQAAAAASUVORK5CYII=', 'base64') })
    await button('Remove attachment local.png').waitFor()
    await composer.fill('Look at this'); await button('Send message').click()
    await page.getByRole('alert').filter({ hasText: 'vision-capable' }).waitFor()
    assert.equal((await snapshot()).requests.length, 3)
    await button('Remove attachment local.png').click()
    pass('Disabling tools revokes auto-approval; text-only LM Studio never silently receives images or falls back to cloud')

    assert.deepEqual((await snapshot()).authored, baseline)
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    assert.deepEqual((await snapshot()).forbiddenCalls, [])
    pass('All tests preserve authored project, assets, timeline and undo history, with no external requests')
    console.log(`Artifacts: ${output}`)
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
