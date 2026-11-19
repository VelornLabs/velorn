// Actual desktop renderer with synthetic Velo events; no account, tools or model IO.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5204')
assert.equal(base.hostname, '127.0.0.1'); assert.equal(base.protocol, 'http:')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-stellar-wave-'))
async function main() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 920 }, reducedMotion: 'no-preference', serviceWorkers: 'block' })
  await page.addInitScript(() => { window.__connectedAgentFixtureStorage = {} })
  page.setDefaultTimeout(12000)
  const errors = [], blocked = [], groups = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === base.origin && !/^\/(api|v1|prompt|queue|history|view|upload|system_stats)(\/|$)/.test(url.pathname)) return route.continue()
    blocked.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  const button = name => page.getByRole('button', { name, exact: true })
  const activity = () => page.getByTestId('agent-activity')
  const input = () => page.getByRole('textbox', { name: 'Message your agent', exact: true })
  const snapshot = () => page.evaluate(() => window.connectedAgentTest.snapshot())
  try {
    await page.goto(new URL('/tests/fixtures/connected-agent.html?dock=1', base).href)
    await page.waitForFunction(() => window.connectedAgentTest?.ready)
    const authored = (await snapshot()).authored
    await button('Assistant').click(); await button('Choose Velo').click()
    await page.getByText('Velo ready', { exact: true }).waitFor()
    const before = await snapshot()
    await input().fill('Synthetic working-indicator test; do not execute any tools.')
    await button('Send message').click()
    await page.waitForFunction(() => window.connectedAgentTest.snapshot().requests.length === 1)
    const request = (await snapshot()).requests[0]
    assert.equal(request.provider, 'luna'); assert.equal(request.reasoningEffort, 'low')
    await activity().waitFor()
    assert.equal(await activity().getAttribute('data-state'), 'working')
    assert.equal(await activity().getAttribute('role'), 'status')
    assert.equal(await activity().getAttribute('aria-live'), 'polite')
    assert.equal(await activity().getAttribute('aria-atomic'), 'true')
    assert.equal(await page.locator('.ca-stellar-wave').count(), 1)
    assert.equal(await activity().locator('.ca-stellar-wave').getAttribute('aria-hidden'), 'true')
    assert.equal(await page.getByText('Velo ready', { exact: true }).count(), 0, 'No idle-ready label during work')
    const placement = await activity().evaluate(node => {
      const input = document.querySelector('textarea[aria-label="Message your agent"]')
      const wave = node.querySelector('.ca-stellar-wave')
      const css = getComputedStyle(wave), dot = getComputedStyle(wave.firstElementChild)
      const rect = node.getBoundingClientRect(), box = input.getBoundingClientRect()
      return { inComposer: Boolean(node.closest('.ca-compose')), nextIsInput: node.nextElementSibling === input,
        gap: box.top - rect.bottom, left: rect.left - box.left, width: parseFloat(css.width), height: parseFloat(css.height),
        dot: parseFloat(dot.width), glow: dot.boxShadow, duration: parseFloat(dot.animationDuration), y: rect.y }
    })
    assert.equal(placement.inComposer, true); assert.equal(placement.nextIsInput, true)
    assert.ok(placement.gap >= 0 && placement.gap <= 8); assert.equal(placement.left, 0)
    assert.equal(placement.width, 34 * 1.5); assert.equal(placement.height, 32 * 1.5)
    assert.ok(Math.abs(placement.dot - 2.04 * 1.5) < .02); assert.match(placement.glow, /8\.16px/)
    assert.ok(Math.abs(placement.duration - 1.9 / 1.5) < .0001, 'Speed unchanged, only size enlarged')
    assert.equal(await page.locator('.connected-agent-panel > .ca-activity, .ca-header .ca-activity').count(), 0)
    const phases = await activity().evaluate(node => {
      const animations = node.querySelector('.ca-stellar-wave').getAnimations({ subtree: true })
      const points = []
      for (const time of [0, 220, 440, 660, 880, 1100]) {
        for (const animation of animations) { animation.pause(); animation.currentTime = time }
        const box = node.getBoundingClientRect()
        points.push({ width: box.width, height: box.height, dots: [...node.querySelectorAll('.ca-stellar-wave > i')].map(dot => {
          const r = dot.getBoundingClientRect(); return { x: r.x, y: r.y, height: r.height }
        }) })
      }
      for (const animation of animations) animation.play()
      return { animations: animations.length, points }
    })
    assert.equal(phases.animations, 5)
    assert.equal(new Set(phases.points.map(p => `${p.width}/${p.height}`)).size, 1, 'No layout bounce as stars move')
    assert.ok(new Set(phases.points.map(p => p.dots[0].y)).size > 1, 'Actual vertical motion')
    assert.ok(new Set(phases.points[0].dots.map(p => p.y)).size > 1, 'Staggered wave, not synchronized blinking')
    groups.push('One accessible wave directly above input, exactly 1.5x larger, same speed/glow style, no top duplicate or idle-ready label')
    await page.screenshot({ path: path.join(output, 'working-desktop.png') })
    await activity().screenshot({ path: path.join(output, 'stellar-wave-status.png') })
    await input().fill('My next draft stays here.')
    await page.evaluate(id => window.connectedAgentTest.emitEvent({ requestId: id, type: 'delta',
      text: Array.from({ length: 70 }, (_, i) => `Synthetic history line ${i + 1}.`).join('\n\n') }), request.requestId)
    await page.waitForFunction(() => { const n = document.querySelector('.ca-messages'); return n.scrollHeight > n.clientHeight + 500 })
    const beforeScroll = await activity().boundingBox()
    await page.locator('.ca-messages').evaluate(node => { node.scrollTop = 0 })
    await page.waitForFunction(() => document.querySelector('.ca-messages').scrollTop === 0)
    assert.deepEqual(await activity().boundingBox(), beforeScroll, 'Conversation scrolling never moves the footer status')
    assert.equal(await activity().isVisible(), true)
    assert.equal(await button('Stop response').isEnabled(), true)
    await button('Assistant settings').click()
    assert.equal(await activity().count(), 1)
    assert.equal(await activity().evaluate(node => Boolean(node.closest('.ca-settings-running'))), true)
    assert.equal(await activity().isVisible(), true)
    await page.locator('.ca-settings-scroll').evaluate(node => { node.scrollTop = node.scrollHeight })
    assert.equal(await activity().isVisible(), true)
    await button('Back to chat').click()
    assert.equal(await activity().evaluate(node => node.nextElementSibling === document.querySelector('textarea[aria-label="Message your agent"]')), true)
    assert.equal(await input().inputValue(), 'My next draft stays here.')
    groups.push('Status stays by composer while history scrolls; settings use one footer status with Stop; draft and request survive navigation')
    await page.evaluate(id => window.connectedAgentTest.emitEvent({ requestId: id, type: 'status', waitingFor: 'velo-service', text: 'Synthetic service wait; continuing when available.' }), request.requestId)
    await page.waitForFunction(() => document.querySelector('[data-testid=agent-activity]')?.dataset.state === 'service-wait')
    assert.match(await activity().innerText(), /Waiting for Velo/)
    assert.equal(await activity().locator('.ca-stellar-wave > i').count(), 5)
    assert.equal(await button('Stop response').isEnabled(), true)
    await page.evaluate(id => window.connectedAgentTest.emitEvent({ requestId: id, type: 'status', text: 'Synthetic continuation.' }), request.requestId)
    await page.waitForFunction(() => document.querySelector('[data-testid=agent-activity]')?.dataset.state === 'working')
    groups.push('Velo wait and resume retain truthful labels and a working Stop control')
    for (const width of [760, 540]) {
      await page.setViewportSize({ width, height: 760 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      assert.equal(await activity().evaluate(node => {
        const box = node.getBoundingClientRect()
        return [...node.querySelectorAll('.ca-stellar-wave > i')].every(dot => {
          const r = dot.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom
        })
      }), true)
    }
    await page.screenshot({ path: path.join(output, 'working-narrow.png') })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ca-stellar-wave > i')).animationName === 'none')
    assert.equal(await activity().evaluate(node => node.getAnimations({ subtree: true }).length), 0)
    assert.equal(await activity().locator('.ca-stellar-wave > i').count(), 5)
    groups.push('Narrow docks do not overflow; reduced motion shows static stars, not animation')
    assert.equal(await input().inputValue(), 'My next draft stays here.')
    await button('Stop response').click(); await activity().waitFor({ state: 'detached' })
    await page.evaluate(id => window.connectedAgentTest.settle(id, { success: true, text: 'Late synthetic completion must not restart activity.' }), request.requestId)
    assert.equal(await page.locator('.ca-stellar-wave').count(), 0)
    const after = await snapshot()
    assert.deepEqual(after.authored, authored)
    assert.equal(after.requests.length, 1)
    assert.deepEqual(after.fullAccessGrant, before.fullAccessGrant)
    assert.deepEqual(after.forbiddenCalls, []); assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    groups.push('Stop removes the wave; drafts, permissions and authored project remain unchanged; no real IO')
    await page.getByText('Velo ready', { exact: true }).waitFor()
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, groups, placement, phases, errors, blocked, output }, null, 2))
    console.log(JSON.stringify({ passed: true, groups, output }, null, 2))
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
    console.error('Evidence:', output); throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
