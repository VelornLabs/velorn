'use strict'

// Normal desktop setup is independent of experimental setup chat, provider
// requests and installer/model management. Only fixed native app controls exist.
const CHANNEL = 'lm-studio-app:perform-action'
const failure = (code, error) => ({ success: false, code, error })
const cancelled = () => failure('LM_STUDIO_APP_CANCELLED', 'The setup window changed. No further app action was started.')
const validPayload = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 1 && Object.hasOwn(value, 'action') && ['open', 'choose'].includes(value.action)

function registerLmStudioAppIpc({ ipcMain, app, getMainWindow, installedApps } = {}) {
  let disposed = false, record = null, busy = false
  const current = value => {
    try {
      return !disposed && value?.valid === true && getMainWindow() === value.window
        && !value.window.isDestroyed() && !value.contents.isDestroyed()
        && value.window.webContents === value.contents && value.contents.mainFrame === value.frame
    } catch { return false }
  }
  const invalidate = value => {
    if (!value?.valid) return
    value.valid = false
    for (const [target, name, listener] of value.listeners) target.removeListener?.(name, listener)
    value.listeners = []
    if (record === value) record = null
  }
  function authorize(event) {
    const window = getMainWindow(), contents = window?.webContents
    if (disposed || !window || window.isDestroyed() || !contents || contents.isDestroyed() || !contents.mainFrame
      || event?.sender !== contents || event.senderFrame !== contents.mainFrame) return null
    if (record && !current(record)) invalidate(record)
    if (!record) {
      const value = { window, contents, frame: contents.mainFrame, valid: true, listeners: [] }
      record = value
      const listen = (target, name, listener) => {
        target.on?.(name, listener); value.listeners.push([target, name, listener])
      }
      listen(contents, 'did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) invalidate(value) })
      listen(contents, 'render-process-gone', () => invalidate(value))
      listen(contents, 'destroyed', () => invalidate(value))
      listen(window, 'closed', () => invalidate(value))
    }
    return record
  }
  ipcMain.handle(CHANNEL, async (event, payload) => {
    let value, ownsAction = false
    try {
      value = authorize(event)
      if (!value) return failure('LM_STUDIO_APP_UNAUTHORIZED', 'LM Studio app controls are available only in the main Velorn window.')
      if (!validPayload(payload)) return failure('LM_STUDIO_APP_INVALID_REQUEST', 'Choose only Open LM Studio or Choose its location.')
      if (busy) return failure('LM_STUDIO_APP_BUSY', 'Finish the current LM Studio app action before starting another.')
      if (typeof installedApps?.[payload.action] !== 'function') return failure('LM_STUDIO_APP_UNAVAILABLE', 'Fully quit and reopen Velorn to enable LM Studio app controls.')
      busy = true; ownsAction = true
      // Existing discovery, exact-target native approval and selection guards
      // remain authoritative. No URL, path, model or launch flags cross IPC.
      const outcome = await installedApps[payload.action]({ integration: 'lmstudio' }, { isCurrent: () => current(value) })
      if (!current(value)) return cancelled()
      if (outcome?.status === 'cancelled' && outcome.ok === false) return { success: true, opened: false, cancelled: true,
        summary: 'Cancelled. No app was opened or selected.' }
      if (outcome?.ok === true && outcome.status === (payload.action === 'open' ? 'opened' : 'selected')) {
        return { success: true, opened: payload.action === 'open', cancelled: false,
          summary: payload.action === 'open'
            ? 'LM Studio was opened. Its saved startup preferences may apply. Check its local server next; Velorn did not request a model download, load or prompt.'
            : 'LM Studio was selected for this Velorn session. It has not been opened or connected.' }
      }
      if (outcome?.status === 'stale') return cancelled()
      if (outcome?.status === 'busy') return failure('LM_STUDIO_APP_BUSY', 'Finish the current LM Studio app action before starting another.')
      if (outcome?.status === 'changed') return failure('LM_STUDIO_APP_CHANGED', 'The LM Studio app changed before opening. Choose its location again; nothing was opened.')
      return failure('LM_STUDIO_APP_FAILED', 'LM Studio could not be opened or located safely. Choose your existing app or use its normal desktop launcher. No model or server command was sent.')
    } catch {
      return value && !current(value) ? cancelled()
        : failure('LM_STUDIO_APP_FAILED', 'The LM Studio app action could not finish. No automatic retry was made; check the app before trying again.')
    } finally { if (ownsAction) busy = false }
  })
  function dispose() {
    if (disposed) return
    disposed = true; invalidate(record)
    ipcMain.removeHandler(CHANNEL)
    app?.removeListener?.('will-quit', dispose)
  }
  app?.on?.('will-quit', dispose)
  return { dispose }
}

module.exports = { CHANNEL, registerLmStudioAppIpc }
