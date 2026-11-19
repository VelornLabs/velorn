'use strict'

// Runs belong to the main editor window. Embedded ComfyUI and export workers
// must not acquire submission/import authority through this bridge.
const CHANNELS = Object.freeze({
  list: 'generation-runs:list', submit: 'generation-runs:submit',
  adopt: 'generation-runs:adopt', recipe: 'generation-runs:recipe',
  control: 'generation-runs:control', observe: 'generation-runs:observe',
  changed: 'generation-runs:changed',
})

function registerGenerationRunsIpc({ ipcMain, getMainWindow, getManager }) {
  let disposed = false
  const channels = []
  for (const method of ['list', 'submit', 'adopt', 'recipe', 'control', 'observe']) {
    const channel = CHANNELS[method]
    ipcMain.handle(channel, async (event, payload = {}) => {
      const window = getMainWindow()
      if (disposed || !window || window.isDestroyed() || !event?.sender || event.sender.isDestroyed()
        || event.sender !== window.webContents || !event.senderFrame
        || event.senderFrame !== window.webContents.mainFrame) {
        return { success: false, code: 'GENERATION_RUN_UNAUTHORIZED', error: 'Generation runs are available in the main Velorn window.' }
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { success: false, code: 'GENERATION_RUN_INVALID_REQUEST', error: 'Provide a generation run request.' }
      }
      try {
        const result = await getManager()[method](payload)
        if (disposed || getMainWindow() !== window || window.isDestroyed()
          || event.senderFrame !== window.webContents.mainFrame) {
          return { success: false, code: 'GENERATION_RUN_CONTEXT_CHANGED', error: 'The Velorn window changed. Inspect the queue before continuing.' }
        }
        return result
      } catch (error) {
        return { success: false, code: error?.code || 'GENERATION_RUN_FAILED',
          error: error?.publicMessage || 'The generation run request could not be completed. Inspect the queue before retrying.' }
      }
    })
    channels.push(channel)
  }
  return { dispose() {
    disposed = true
    for (const channel of channels) ipcMain.removeHandler?.(channel)
  } }
}

module.exports = { registerGenerationRunsIpc, CHANNELS }
