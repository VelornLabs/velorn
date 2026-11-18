// Actual browser MCP action/store; all projects, queue records and storage are
// synthetic and in RAM. Never mount Generate, App, Electron or ComfyUI here.
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright')
const base = new URL(process.env.VELORN_TEST_URL || 'http://127.0.0.1:5199')
if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('Loopback fixture only')

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true })
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage(), errors = [], blocked = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === base.origin && !/^\/(prompt|queue|history|upload|view|ws|api|v1)(\/|$)/.test(url.pathname)) return route.continue()
    blocked.push(url.href); return route.abort()
  })
  await page.routeWebSocket(() => true, socket => socket.close())
  try {
    await page.goto(new URL('/tests/fixtures/storyboard-workspace.html', base).href)
    await page.waitForFunction(() => window.storyboardWorkspaceTest?.ready)
    const result = await page.evaluate(async () => {
      const { default: monitor } = await import('/src/stores/generationMonitorStore.js')
      const { default: project } = await import('/src/stores/projectStore.js')
      const { generationQueueOwner } = await import('/src/services/generationQueueStatus.mjs')
      const { default: exportActivity } = await import('/src/stores/exportActivityStore.js')
      const owner = generationQueueOwner(project.getState().currentProjectHandle, project.getState().currentProject)
      const api = window.storyboardWorkspaceTest
      const before = api.snapshot(), tab = api.workspace()
      const badEvents = []
      for (const name of ['comfystudio-open-generate-tab', 'comfystudio-mcp-music-video-keyframe-probe', 'comfystudio-mcp-get-generation-queue-status']) {
        window.addEventListener(name, () => badEvents.push(name))
      }
      const read = args => api.runMcpAction('get_generation_queue_status', args)
      monitor.getState().reset()
      const cold = await read({})
      const stored = JSON.stringify([{ id: 'saved', workflowId: 'fixture', status: 'running', progress: 37,
        promptId: 'fixture-prompt', originProject: { path: '/fixture-only/other' } }])
      localStorage.setItem('generate-workspace-generation-queue', stored)
      const persisted = await read({})
      const progress = []
      for (const value of [10, 45, 95, 100]) {
        monitor.getState().publishQueue({ jobs: [{ id: 'live', workflowId: 'fixture', status: value === 100 ? 'done' : 'running',
          progress: value, resultAssetIds: value === 100 ? ['fixture-result'] : [] }], isConnected: true, owner })
        progress.push(await read({ jobIds: ['live'] }))
      }
      const detached = await read({})
      detached.jobs[0].resultAssetIds.push('must-not-change-store')
      const afterMutation = await read({})
      exportActivity.setState({ activeJob: { jobId: 'synthetic-export', status: 'running' } })
      const duringExport = await read({})
      exportActivity.setState({ activeJob: null })
      monitor.getState().publishQueue({ jobs: [], isConnected: false, owner })
      const emptyLive = await read({})
      const unchangedStorage = localStorage.getItem('generate-workspace-generation-queue') === stored
      const after = api.snapshot(), finalTab = api.workspace()
      return { cold, persisted, progress, afterMutation, duringExport, emptyLive, unchangedStorage,
        badEvents, before, after, tab, finalTab }
    })
    assert.equal(result.cold.source, 'unavailable'); assert.equal(result.cold.activeCount, null)
    assert.equal(result.persisted.live, false); assert.equal(result.persisted.jobs[0].status, 'unknown')
    assert.equal(result.persisted.jobs[0].lastKnownProgress, 37)
    assert.deepEqual(result.progress.map(value => value.jobs[0].progress), [10, 45, 95, 100])
    assert.ok(result.progress.every(value => value.source === 'live'))
    assert.deepEqual(result.afterMutation.jobs[0].resultAssetIds, ['fixture-result'])
    assert.equal(result.duringExport.success, true)
    assert.equal(result.emptyLive.source, 'live'); assert.deepEqual(result.emptyLive.jobs, [])
    assert.equal(result.unchangedStorage, true); assert.deepEqual(result.badEvents, [])
    assert.deepEqual(result.finalTab, result.tab); assert.deepEqual(result.after, result.before)
    assert.deepEqual(errors, []); assert.deepEqual(blocked, [])
    console.log('PASS: cold/saved/live/repeated/detached/export/empty status, no navigation, no project or storage changes, no service calls')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
