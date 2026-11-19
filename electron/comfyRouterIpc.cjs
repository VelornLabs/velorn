'use strict'

const METHODS = ['status', 'connect', 'clear', 'preview', 'submit', 'list', 'refresh', 'cancel', 'output', 'markImported',
  // Create tab. `submitCreate` may skip the native confirmation for a small priced
  // request, so the preload only forwards it during a live user gesture and it is
  // never offered to agent tools.
  'models', 'previewCreate', 'previewCreateBatch', 'submitCreate',
  // Read only: the account's credit balance as a number, for the figure at the top of the window.
  'balance']
const GUIDE = 'https://platform.comfy.org/profile/api-keys?onboarding=router'

// No Router authority is exposed to embedded ComfyUI, other windows or workers.
function registerComfyRouterIpc({ ipcMain, getMainWindow, getManager, openExternal, isBusy = () => false }) {
  let disposed = false
  const watched = new WeakSet()
  const cleanups = []
  const channels = []
  const failure = () => ({ success: false, code: 'ROUTER_UNAUTHORIZED', error: 'Open Cloud image in the main Velorn window.' })
  for (const method of [...METHODS, 'openGuide']) {
    const channel = `comfy-router:${method}`
    ipcMain.handle(channel, async (event, payload = {}) => {
      const window = getMainWindow()
      const current = () => !disposed && window && getMainWindow() === window && !window.isDestroyed()
        && event?.sender === window.webContents && !event.sender.isDestroyed()
        && event.senderFrame && event.senderFrame === window.webContents.mainFrame
      if (!current()) return failure()
      if (isBusy() && !['status', 'list', 'clear', 'cancel'].includes(method)) return {
        success: false, code: 'ROUTER_EXPORT_BUSY', error: 'Wait for export to finish before using Cloud image.' }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return failure()
      if (!watched.has(window.webContents)) {
        watched.add(window.webContents)
        const cancelCurrent = () => {
          if (!disposed && getMainWindow() === window) getManager().cancelPending()
        }
        const navigate = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancelCurrent() }
        window.webContents.on?.('did-start-navigation', navigate)
        window.webContents.on?.('render-process-gone', cancelCurrent)
        cleanups.push(() => {
          // On quit the window is already gone, and touching it then throws.
          if (window.isDestroyed?.()) return
          window.webContents.removeListener?.('did-start-navigation', navigate)
          window.webContents.removeListener?.('render-process-gone', cancelCurrent)
        })
      }
      try {
        if (method === 'openGuide') {
          await openExternal(GUIDE)
          return current() ? { success: true } : failure()
        }
        const result = await getManager()[method](payload)
        return current() ? result : { success: false, code: 'ROUTER_CONTEXT_CHANGED', error: 'The Velorn window changed. Inspect Cloud image jobs before trying again.' }
      } catch {
        // Never surface provider exceptions, signed result URLs or credentials.
        return { success: false, code: 'ROUTER_FAILED', error: 'The Router request could not finish. Inspect Cloud image jobs before trying again.' }
      }
    })
    channels.push(channel)
  }
  return { dispose() {
    disposed = true
    for (const cleanup of cleanups) cleanup()
    for (const channel of channels) ipcMain.removeHandler?.(channel)
  } }
}

module.exports = { registerComfyRouterIpc, METHODS, GUIDE }
