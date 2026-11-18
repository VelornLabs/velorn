'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')

// Exercise the existing desktop handler and its actual embedded-frame scripts
// without starting Electron or replacing a user's live ComfyUI graph.
const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
const loaderStart = source.indexOf('async function loadWorkflowGraphInEmbeddedComfy(')
const loaderEnd = source.indexOf('// Converts a UI-format workflow', loaderStart)
const ipcStart = source.indexOf("ipcMain.handle('comfyui:loadWorkflowGraph'")
const ipcEnd = source.indexOf("ipcMain.handle('comfyui:convertWorkflowGraph'", ipcStart)
assert.ok(loaderStart >= 0 && loaderEnd > loaderStart, 'Native graph loader must be found')
assert.ok(ipcStart >= 0 && ipcEnd > ipcStart, 'Native graph IPC must be found')

function harness({ noFrame = false, loadError, afterPreparation, projectKey = null, timelineId = null } = {}) {
  const state = {
    context: { session: 'synthetic-renderer', projectKey, timelineId },
    contextReads: 0,
    loadCalls: 0,
    loaded: [],
    frameRequests: [],
  }
  const frameGlobals = {
    setTimeout,
    app: {
      canvasEl: { getBoundingClientRect: () => ({ width: 640, height: 480 }) },
      loadGraphData: async graph => {
        state.loadCalls += 1
        if (loadError) throw new Error(loadError)
        state.loaded.push(JSON.parse(JSON.stringify(graph)))
      },
    },
  }
  const frameContext = vm.createContext(frameGlobals)
  const frame = {
    executeJavaScript: async script => {
      const result = await vm.runInContext(script, frameContext)
      if (result?.prepared) afterPreparation?.(state)
      return result
    },
  }
  const loadWorkflowGraphInEmbeddedComfy = new Function('findEmbeddedComfyFrame', 'crypto',
    `${source.slice(loaderStart, loaderEnd)}; return loadWorkflowGraphInEmbeddedComfy`)(
    async (url, waitForMs) => {
      state.frameRequests.push({ url, waitForMs })
      return noFrame ? null : frame
    }, crypto)

  const mainFrame = {}
  const webContents = { mainFrame, isDestroyed: () => false }
  const mainWindow = { webContents, isDestroyed: () => false }
  const handlers = new Map()
  vm.runInNewContext(source.slice(ipcStart, ipcEnd), {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    mainWindow,
    exportJobs: { activeId: null },
    performMcpRendererAction: async request => {
      assert.equal(request.action, 'get_transport_state')
      state.contextReads += 1
      return { agentContext: { context: { ...state.context } } }
    },
    loadWorkflowGraphInEmbeddedComfy,
  })
  const invoke = payload => handlers.get('comfyui:loadWorkflowGraph')(
    { sender: webContents, senderFrame: mainFrame }, payload)
  const preparedKeys = () => Object.keys(frameGlobals).filter(key => key.startsWith('__velornPreparedWorkflow_'))
  return { state, invoke, preparedKeys }
}

const workflowGraph = { version: 1, nodes: [{ id: 1, type: 'SyntheticNode' }], links: [] }
const payload = fixture => ({ workflowGraph, expectedContext: { ...fixture.state.context },
  comfyBaseUrl: 'http://127.0.0.1:18189', waitForMs: 1234 })

test('native graph IPC opens in an empty project with its actual captured timeline identity', async () => {
  for (const timelineId of [null, 'default-timeline']) {
    const fixture = harness({ timelineId })
    const result = await fixture.invoke(payload(fixture))
    assert.equal(result.success, true)
    assert.equal(fixture.state.contextReads, 2, 'Identity is checked before preparation and before loading')
    assert.equal(fixture.state.loadCalls, 1)
    assert.deepEqual(fixture.state.loaded, [workflowGraph])
    assert.deepEqual(fixture.state.frameRequests, [{ url: 'http://127.0.0.1:18189', waitForMs: 1234 }])
    assert.deepEqual(fixture.preparedKeys(), [])
  }
})

test('native graph IPC reports frontend load rejection instead of claiming the workflow opened', async () => {
  const fixture = harness({ loadError: 'Synthetic graph load rejected' })
  const result = await fixture.invoke(payload(fixture))
  assert.equal(result.success, false)
  assert.match(result.error, /Synthetic graph load rejected/)
  assert.equal(fixture.state.loadCalls, 1)
  assert.deepEqual(fixture.state.loaded, [])
  assert.deepEqual(fixture.preparedKeys(), [])
})

test('native graph IPC reports a missing embedded frame without a graph load', async () => {
  const fixture = harness({ noFrame: true })
  const result = await fixture.invoke(payload(fixture))
  assert.equal(result.success, false)
  assert.match(result.error, /Could not locate the embedded ComfyUI tab/)
  assert.equal(fixture.state.contextReads, 1)
  assert.equal(fixture.state.loadCalls, 0)
  assert.deepEqual(fixture.preparedKeys(), [])
})

test('native graph IPC refuses identity changes after preparation and clears staged graph data', async () => {
  for (const field of ['session', 'projectKey', 'timelineId']) {
    const fixture = harness({ afterPreparation: state => {
      assert.equal(state.loadCalls, 0, 'Frontend preparation has not yet replaced the graph')
      state.context[field] = `changed-${field}`
    } })
    const result = await fixture.invoke(payload(fixture))
    assert.equal(result.success, false, field)
    assert.match(result.error, /project or timeline changed/)
    assert.equal(fixture.state.contextReads, 2)
    assert.equal(fixture.state.loadCalls, 0, field)
    assert.deepEqual(fixture.state.loaded, [])
    assert.deepEqual(fixture.preparedKeys(), [], 'Rejected preparation must not linger in the frame')
  }
})
