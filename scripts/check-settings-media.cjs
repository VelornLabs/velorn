// Real Settings/Assets UI, isolated Chromium profile, synthetic media and a
// mocked native bridge. Never opens App, MCP, actual settings or user files.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5198')
if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') throw new Error('Fixture requires a loopback Vite server')
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-settings-media-'))
const allIds = ['fixture-alpha', 'fixture-beta', 'fixture-gamma']
const alphaPaths = ['/fixture-only/project/assets/cache/alpha-playback.mp4',
  '/fixture-only/project/assets/images/alpha.png', '/fixture-only/project/assets/proxies/alpha-proxy.mp4']
const colorLuminance = color => {
  const values = color.match(/[\d.]+/g)?.map(Number) || []
  assert.ok(values.length >= 3 && (values.length < 4 || values[3] === 1), `Expected an opaque computed color: ${color}`)
  const channels = values.slice(0, 3).map(value => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
const contrast = (foreground, background) => {
  const values = [colorLuminance(foreground), colorLuminance(background)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const groups = [], snapshots = [], errors = [], blockedRequests = []
  let context, page
  const pass = label => { groups.push(label); console.log(`PASS ${groups.length}: ${label}`) }
  const snapshot = () => page.evaluate(() => window.settingsMediaTest.snapshot())
  const load = async ({ surface = 'assets', scenario = 'normal', section = '', platform = 'linux', width = 1300 } = {}) => {
    await context?.close()
    context = await browser.newContext({ viewport: { width, height: 950 }, locale: 'en-US' })
    page = await context.newPage(); page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === base.origin) return route.continue()
      blockedRequests.push({ url: url.href, resourceType: request.resourceType() })
      return route.abort()
    })
    await page.routeWebSocket(() => true, socket => socket.close())
    const url = new URL('/tests/fixtures/settings-media.html', base)
    for (const [key, value] of Object.entries({ surface, scenario, section, platform })) url.searchParams.set(key, value)
    await page.goto(url.href)
    await page.waitForFunction(() => window.settingsMediaTest?.ready)
    await page.locator('[data-asset-id="fixture-alpha"]').waitFor({ state: 'attached' })
  }
  const safe = state => assert.deepEqual(state.forbiddenCalls, [], 'Never fall back to permanent deletion, filesystem writes or process actions')
  const capture = async name => {
    const state = await snapshot(); safe(state); snapshots.push({ name, ...state })
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
    return state
  }
  const row = id => page.locator(`[data-asset-id="fixture-${id}"]`)
  const openSettings = async section => {
    await page.evaluate(() => window.settingsMediaTest.closeSettings())
    await page.evaluate(value => window.settingsMediaTest.openSettings(value), section)
    await page.getByLabel('Search settings', { exact: true }).waitFor()
  }
  const preference = () => page.getByLabel('Default asset removal', { exact: true })
  const openTrash = async id => {
    await row(id).click({ button: 'right' })
    await page.getByRole('button', { name: 'Remove and move files to Trash…', exact: true }).click()
    await page.getByRole('button', { name: 'Move files to Trash', exact: true }).waitFor()
  }
  const confirmTrash = () => page.getByRole('button', { name: 'Move files to Trash', exact: true }).click()
  const settleTabs = tablist => tablist.evaluate(async node => {
    // Color transitions are intentional affordances; inspect their settled
    // values, not the first frame after moving selection or changing themes.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})))
  })
  try {
    await load({ surface: 'settings' })
    const titles = ['General', 'Editing', 'Media & Storage', 'Playback & Export', 'Connections', 'New Project Defaults']
    assert.equal(await page.getByRole('navigation', { name: 'Settings categories', exact: true }).getByRole('button').count(), 6)
    for (const title of titles) {
      await page.getByRole('button', { name: title, exact: true }).first().click()
      assert.equal(await page.getByRole('button', { name: title, exact: true }).first().getAttribute('aria-current'), 'page')
    }
    let state = await capture('six-settings-groups')
    assert.deepEqual(state.settingWrites, [])
    pass('Six Settings groups are navigable without changing preferences')

    const search = page.getByLabel('Search settings', { exact: true })
    await search.fill('trash')
    await page.getByRole('button', { name: /Import & removal/ }).click()
    await preference().waitFor()
    assert.equal(await preference().inputValue(), 'project-only')
    state = await capture('search-removal-default')
    assert.equal(state.legacyMode, 'disk'); assert.equal(state.removalMode, null)
    assert.deepEqual(state.settingWrites, [])
    pass('Search finds Import & removal; a legacy disk preference still defaults to project-only')

    const links = [
      ['storage', 'Media & Storage', 'Projects & autosave'], ['paths', 'Media & Storage', 'Media folders'],
      ['stock', 'Connections', 'Stock media (Pexels)'], ['agents', 'Connections', 'Agents (MCP)'],
      ['connection', 'Connections', 'ComfyUI'], ['launcher', 'Connections', 'ComfyUI'],
      ['workflow-setup', 'Connections', 'Generation tools'], ['language', 'General', 'Language'],
      ['appearance', 'General', 'Appearance & navigation'], ['notifications', 'General', 'Sounds & notifications'],
      ['hotkeys', 'Editing', 'Keyboard shortcuts'], ['project', 'New Project Defaults', 'New Project Defaults'],
    ]
    for (const [section, group, title] of links) {
      await openSettings(section)
      const pageId = ['connection', 'launcher'].includes(section) ? 'comfy' : section
      await page.locator(`[data-settings-page="${pageId}"]`).waitFor()
      assert.equal(await page.getByRole('button', { name: group, exact: true }).first().getAttribute('aria-current'), 'page', section)
      if (pageId === 'comfy') assert.equal(await page.locator('section[aria-label="Connect ComfyUI"]').count(), 1, 'Each legacy Comfy link shows one shared setup')
    }
    await openSettings('feedback')
    await page.getByRole('heading', { name: /feedback/i }).last().waitFor()
    state = await capture('legacy-deep-links')
    assert.deepEqual(state.settingWrites, [])
    pass('Existing section deep links and Feedback still resolve to the correct destination')

    for (const width of [1200, 900]) {
      await load({ surface: 'settings', section: 'connection', width })
      const tablist = page.getByRole('tablist', { name: 'Settings sections', exact: true })
      await tablist.waitFor()
      const sections = [
        ['comfy', 'ComfyUI'], ['cloud', 'Cloud generation'], ['stock', 'Stock media (Pexels)'],
        ['workflow-setup', 'Generation tools'], ['agents', 'Agents (MCP)'],
      ]
      const tabs = tablist.getByRole('tab')
      assert.equal(await tabs.count(), sections.length)
      const selected = async (id, title, focused = false) => {
        const tab = tablist.getByRole('tab', { name: title, exact: true })
        await page.waitForFunction(expected => document.querySelector(`[data-settings-page="${expected}"]`), id)
        assert.equal(await tab.getAttribute('aria-selected'), 'true')
        assert.equal(await tab.getAttribute('tabindex'), '0')
        assert.equal(await tablist.locator('[role="tab"][aria-selected="true"]').count(), 1)
        assert.equal(await tablist.locator('[role="tab"][tabindex="0"]').count(), 1)
        assert.equal(await tablist.locator('[role="tab"][tabindex="-1"]').count(), sections.length - 1)
        const panel = page.getByRole('tabpanel')
        assert.equal(await panel.count(), 1)
        assert.equal(await tab.getAttribute('aria-controls'), await panel.getAttribute('id'))
        assert.equal(await panel.getAttribute('aria-labelledby'), await tab.getAttribute('id'))
        assert.ok((await tabs.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-controls'))))
          .every(id => id === 'settings-section-panel'), 'Inactive tabs also point to the existing shared panel')
        if (focused) assert.equal(await tab.evaluate(node => node === document.activeElement), true)
      }
      for (const [id, title] of sections) {
        await tablist.getByRole('tab', { name: title, exact: true }).click()
        await selected(id, title)
      }
      await tablist.getByRole('tab', { name: 'ComfyUI', exact: true }).click()
      await settleTabs(tablist)
      const geometry = await tablist.evaluate(node => {
        const bounds = node.getBoundingClientRect()
        return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
          clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
          tabs: [...node.querySelectorAll('[role="tab"]')].map(tab => {
            const rect = tab.getBoundingClientRect(), style = getComputedStyle(tab)
            return { label: tab.textContent.trim(), selected: tab.getAttribute('aria-selected'),
              left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height,
              borderWidth: parseFloat(style.borderTopWidth), background: style.backgroundColor,
              clipped: tab.scrollWidth > tab.clientWidth + 1 || [...tab.querySelectorAll('span')].some(span => span.scrollWidth > span.clientWidth + 1) }
          }) }
      })
      assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, 'Tab strip must not horizontally overflow')
      for (const tab of geometry.tabs) {
        assert.ok(tab.left >= geometry.left - 1 && tab.right <= geometry.right + 1, `${tab.label}: visible within strip`)
        assert.ok(tab.top >= geometry.top - 1 && tab.bottom <= geometry.bottom + 1, `${tab.label}: visible within wrapped rows`)
        assert.ok(tab.height >= 36, `${tab.label}: clear, comfortably clickable tab target`)
        assert.ok(tab.borderWidth >= 1, `${tab.label}: visibly bordered tab`)
        assert.equal(tab.clipped, false, `${tab.label}: complete label is visible`)
      }
      const active = geometry.tabs.find(tab => tab.selected === 'true')
      assert.ok(geometry.tabs.filter(tab => tab.selected !== 'true').every(tab => tab.background !== active.background), 'Selected tab has distinct solid treatment')
      await capture(`connections-tabs-${width}`)
      snapshots.push({ name: `connections-tab-geometry-${width}`, ...geometry })

      await tablist.getByRole('tab', { name: 'ComfyUI', exact: true }).focus()
      await page.keyboard.press('ArrowLeft'); await selected('agents', 'Agents (MCP)', true)
      await page.keyboard.press('Home'); await selected('comfy', 'ComfyUI', true)
      await page.keyboard.press('ArrowRight'); await selected('cloud', 'Cloud generation', true)
      await page.keyboard.press('End'); await selected('agents', 'Agents (MCP)', true)
      await page.keyboard.press('ArrowRight'); await selected('comfy', 'ComfyUI', true)
      await capture(`connections-tab-keyboard-focus-${width}`)
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'tab'), false, 'Tab exits the tab strip rather than visiting every inactive tab')
      if (width === 900) {
        await tablist.evaluate(node => node.setAttribute('dir', 'rtl'))
        await tablist.getByRole('tab', { name: 'ComfyUI', exact: true }).focus()
        await page.keyboard.press('ArrowRight'); await selected('agents', 'Agents (MCP)', true)
        await page.keyboard.press('ArrowLeft'); await selected('comfy', 'ComfyUI', true)
        await tablist.evaluate(node => node.removeAttribute('dir'))
        await page.evaluate(() => window.settingsMediaTest.applyTheme('midnight'))
        await capture('connections-tabs-900-midnight')
        const themeContrasts = []
        for (const theme of ['velorn', 'midnight', 'soft-dark', 'high-contrast', 'arctic', 'ember']) {
          await page.evaluate(value => window.settingsMediaTest.applyTheme(value), theme)
          await settleTabs(tablist)
          const samples = await tabs.evaluateAll(nodes => nodes.map(node => ({
            label: node.textContent.trim(), selected: node.getAttribute('aria-selected') === 'true',
            color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor,
          })))
          for (const sample of samples) {
            sample.ratio = contrast(sample.color, sample.background)
            assert.ok(sample.ratio >= 4.5, `${theme}/${sample.label}: text contrast ${sample.ratio.toFixed(2)} must be at least 4.5:1`)
          }
          themeContrasts.push({ theme, samples })
        }
        snapshots.push({ name: 'tab-theme-contrast', themes: themeContrasts })
        pass('All six themes retain at least 4.5:1 selected and unselected tab text contrast')
      }
      state = await snapshot()
      assert.deepEqual(state.settingWrites, [])
      assert.deepEqual(state.trashCalls, [])
      safe(state)
      pass(`${width}px: all five Connections tabs are visible, clickable, clearly selected and keyboard-linked to their panels without saving settings`)
    }

    await load()
    const assetPanel = page.locator('#fixture-assets')
    assert.equal(await assetPanel.getByText('Delete:', { exact: true }).count(), 0)
    assert.equal(await assetPanel.getByRole('button', { name: 'Delete Disk', exact: true }).count(), 0)
    await row('alpha').click(); await row('beta').click({ modifiers: ['Control'] })
    await page.keyboard.press('Delete')
    await page.getByRole('button', { name: 'Remove from project', exact: true }).waitFor()
    state = await capture('project-only-confirmation')
    assert.match(state.text, /All files on disk will be kept/)
    assert.deepEqual(state.assetIds, allIds); assert.deepEqual(state.trashCalls, [])
    await page.getByRole('button', { name: 'Remove from project', exact: true }).click()
    await page.waitForFunction(() => window.settingsMediaTest.snapshot().assetIds.length === 1)
    state = await capture('project-only-selected-removed')
    assert.deepEqual(state.assetIds, ['fixture-gamma']); assert.deepEqual(state.trashCalls, [])
    assert.equal(state.legacyMode, 'disk'); assert.equal(state.removalMode, null)
    pass('No Delete toolbar; selected-asset Delete confirms project-only removal and never touches disk')

    await load()
    await openTrash('alpha')
    state = await capture('exact-trash-path-confirmation')
    for (const path of alphaPaths) assert.ok(state.text.includes(path), `Confirmation must list ${path}`)
    assert.ok(!state.text.includes('/fixture-only/external/beta.png'), 'Unselected paths must not be listed for removal')
    assert.deepEqual(state.trashCalls, []); assert.deepEqual(state.assetIds, allIds)
    await page.getByRole('button', { name: 'Keep', exact: true }).click()
    state = await snapshot(); assert.deepEqual(state.trashCalls, []); assert.deepEqual(state.assetIds, allIds)
    await openTrash('alpha'); await confirmTrash()
    await page.waitForFunction(() => window.settingsMediaTest.snapshot().assetIds.length === 2)
    state = await capture('explicit-trash-complete')
    assert.deepEqual(state.trashCalls.map(call => call.paths), [alphaPaths])
    assert.deepEqual(state.assetIds, ['fixture-beta', 'fixture-gamma'])
    assert.equal(state.removalMode, null, 'Explicit Trash must not alter the default preference')
    pass('Explicit Remove & Trash previews exact media/cache paths, supports cancellation and only removes confirmed files')

    await load()
    await openTrash('beta')
    state = await capture('external-file-warning')
    assert.match(state.text, /OUTSIDE the project folder/)
    assert.ok(state.text.includes('[EXTERNAL] /fixture-only/external/beta.png'))
    await confirmTrash()
    await page.waitForFunction(() => !window.settingsMediaTest.snapshot().assetIds.includes('fixture-beta'))
    assert.deepEqual((await snapshot()).trashCalls.map(call => call.paths), [['/fixture-only/external/beta.png']])
    pass('External-source Trash explicitly identifies the original file and its outside-project risk')

    await load()
    await openSettings('assets')
    await preference().selectOption('trash')
    await page.waitForFunction(() => window.settingsMediaTest.snapshot().removalMode === 'trash')
    await page.evaluate(() => window.settingsMediaTest.closeSettings())
    await row('alpha').click(); await page.keyboard.press('Backspace')
    await page.getByRole('button', { name: 'Move files to Trash', exact: true }).waitFor()
    state = await capture('settings-preference-live-keyboard')
    assert.deepEqual(state.removalEvents, [{ mode: 'trash' }]); assert.deepEqual(state.trashCalls, [])
    await confirmTrash()
    await page.waitForFunction(() => !window.settingsMediaTest.snapshot().assetIds.includes('fixture-alpha'))
    assert.deepEqual((await snapshot()).trashCalls.map(call => call.paths), [alphaPaths])
    pass('An explicit Settings preference takes effect in the already-mounted Assets keyboard handler')

    await load(); await openTrash('alpha')
    await page.evaluate(() => window.settingsMediaTest.switchProject())
    await confirmTrash()
    await page.getByRole('heading', { name: 'Asset removal stopped', exact: true }).waitFor()
    state = await capture('project-changed-during-confirmation')
    assert.deepEqual(state.assetIds, allIds); assert.deepEqual(state.trashCalls, [])
    assert.match(state.text, /project or selection changed/)
    pass('Changing projects while confirmation is open cancels removal before any native Trash call')

    for (const scenario of ['trash-failure', 'trash-partial', 'no-native']) {
      await load({ scenario }); await openTrash('alpha'); await confirmTrash()
      await page.getByRole('heading', { name: 'Asset removal stopped', exact: true }).waitFor()
      state = await capture(scenario)
      assert.deepEqual(state.assetIds, allIds)
      assert.match(state.text, scenario !== 'no-native' ? /Fixture Trash is unavailable/ : /Safe Trash is unavailable/)
      assert.equal(state.trashCalls.length, scenario !== 'no-native' ? 1 : 0)
      if (scenario === 'trash-partial') assert.match(state.text, /1 file\(s\) were moved to Trash; you can restore them there/)
      safe(state)
      pass(`${scenario}: keep project assets, show an actionable error and never fall back to permanent deletion`)
    }

    await load({ scenario: 'large-selection' })
    await row('long-0').click()
    for (let index = 1; index < 16; index++) await row(`long-${index}`).click({ modifiers: ['Control'] })
    await openTrash('long-0')
    const confirmButton = page.getByRole('button', { name: 'Move files to Trash', exact: true })
    const buttonBox = await confirmButton.boundingBox()
    assert.ok(buttonBox && buttonBox.y >= 0 && buttonBox.y + buttonBox.height <= 950, 'Confirmation action stays inside the viewport')
    const dialogBody = page.locator('.whitespace-pre-line').filter({ hasText: 'Files to move:' })
    const scroll = await dialogBody.evaluate(node => ({ height: node.clientHeight, scrollHeight: node.scrollHeight,
      width: node.clientWidth, scrollWidth: node.scrollWidth }))
    assert.ok(scroll.scrollHeight > scroll.height, 'Large path inventory must be independently scrollable')
    assert.ok(scroll.scrollWidth <= scroll.width + 1, 'Long paths wrap without horizontal clipping')
    state = await capture('large-selection-scrollable-confirmation')
    assert.match(state.text, /move 16 files/); assert.deepEqual(state.trashCalls, [])
    await page.getByRole('button', { name: 'Keep', exact: true }).click()
    pass('A large selection wraps long file paths, scrolls the inventory and keeps confirmation buttons accessible')

    await load({ platform: 'win32' })
    await openTrash('beta')
    state = await capture('windows-path-confirmation')
    assert.ok(state.text.includes('C:/fixture-only/external/beta.png'))
    await confirmTrash()
    await page.waitForFunction(() => !window.settingsMediaTest.snapshot().assetIds.includes('fixture-beta'))
    state = await capture('windows-native-acknowledgement')
    assert.deepEqual(state.trashCalls.map(call => call.paths), [['C:/fixture-only/external/beta.png']])
    pass('Windows backslash native acknowledgements match the reviewed file and safely remove its project entry')

    await load({ scenario: 'trash-pending' }); await openTrash('alpha'); await confirmTrash()
    await page.waitForFunction(() => window.settingsMediaTest.snapshot().trashPending)
    await page.locator('[aria-busy="true"]').first().waitFor()
    await page.evaluate(() => { window.settingsMediaTest.switchProject(); window.settingsMediaTest.unmountAssets() })
    await page.evaluate(() => window.settingsMediaTest.completeTrash())
    await page.waitForFunction(() => window.settingsMediaTest.snapshot().alerts.length > 0)
    state = await capture('post-trash-project-change-unmounted')
    assert.deepEqual(state.assetIds, allIds)
    assert.equal(state.trashCalls.length, 1)
    assert.match(state.alerts.join('\n'), /3 file\(s\) were already moved to Trash/)
    assert.match(state.alerts.join('\n'), /files?.*(?:moved|Trash)/i)
    assert.match(state.alerts.join('\n'), /(?:recover|restore)/i)
    assert.match(state.alerts.join('\n'), /(?:entries|assets).*(?:kept|retained)/i)
    await page.evaluate(() => window.settingsMediaTest.remountAssets())
    await row('beta').click(); await page.keyboard.press('Delete')
    await page.getByRole('button', { name: 'Remove from project', exact: true }).click()
    await page.waitForFunction(() => !window.settingsMediaTest.snapshot().assetIds.includes('fixture-beta'))
    state = await capture('post-trash-guard-released-after-remount')
    assert.deepEqual(state.assetIds, ['fixture-alpha', 'fixture-gamma'])
    assert.equal(state.trashCalls.length, 1)
    pass('Pending Trash shows busy state; project/panel changes retain entries, report recovery and release guards for the next removal')

    await load({ scenario: 'folder-race' })
    await page.locator('[data-is-folder]').filter({ hasText: 'Fixture bin' }).click({ button: 'right' })
    await page.getByRole('button', { name: 'Remove folder and move files to Trash…', exact: true }).waitFor()
    await page.evaluate(() => window.settingsMediaTest.addFolderAssetAndClickRemoval())
    await page.getByRole('button', { name: 'Move files to Trash', exact: true }).waitFor()
    state = await capture('folder-current-store-review')
    assert.ok(state.text.includes('/fixture-only/project/assets/images/late-folder.png'))
    assert.match(state.text, /move 1 file/)
    assert.deepEqual(state.trashCalls, [])
    await confirmTrash()
    await page.waitForFunction(() => !window.settingsMediaTest.snapshot().folderIds.includes('fixture-bin'))
    state = await capture('folder-current-store-complete')
    assert.deepEqual(state.assetIds, allIds)
    assert.deepEqual(state.trashCalls.map(call => call.paths), [['/fixture-only/project/assets/images/late-folder.png']])
    pass('Folder removal reviews the current store inventory, including media added before React rerenders')

    assert.deepEqual(errors, [], 'Renderer exceptions')
    assert.deepEqual(blockedRequests.filter(request => request.resourceType !== 'image'), [], 'No real external API calls')
    const result = { success: true, groups, output, blockedRequests, snapshots }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
    console.log('SETTINGS_MEDIA_RESULT ' + JSON.stringify({ success: true, groups, output }))
  } catch (error) {
    await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {})
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, errors, blockedRequests,
      snapshot: await snapshot().catch(() => null), groups, snapshots }, null, 2))
    console.error('SETTINGS_MEDIA_FAILURE ' + output); throw error
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
