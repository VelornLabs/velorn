// Native window changes for the existing viewer, separate from app fullscreen.
// In particular, macOS simple fullscreen stays on the current desktop.
function createViewerPresentation({ window, platform = process.platform, onChange = () => {}, onRestored = () => {}, onError = () => {}, transitionTimeoutMs = 2000 }) {
  let desired = false
  let active = false
  let revision = 0
  let saved = null
  let ownedMode = null
  let restoring = false
  let restoreFailed = false
  let nativeEntryPending = false
  let disposed = false
  let queue = Promise.resolve()
  const listeners = []

  const available = () => !disposed && !window.isDestroyed()
  const state = () => ({ active, revision })
  const publish = (reason) => {
    try { onChange({ ...state(), reason }) } catch (error) { onError(error) }
  }
  const listen = (target, name, listener) => {
    target.on(name, listener)
    listeners.push(() => target.removeListener(name, listener))
  }
  const capture = () => ({
    bounds: { ...(window.getNormalBounds?.() || window.getBounds()) },
    isMaximized: window.isMaximized(),
    isFullScreen: window.isFullScreen(),
    isSimpleFullScreen: platform === 'darwin' && window.isSimpleFullScreen(),
  })

  // Native fullscreen transitions can be asynchronous. Keep entry and exit in
  // order, including Escape/navigation arriving while entry is still in flight.
  const setNativeFullscreen = (enabled) => {
    // A timed-out entry may still be queued in the window manager. Explicitly
    // cancel it even when isFullScreen() has not become true yet.
    if (!available() || (window.isFullScreen() === enabled && !(nativeEntryPending && !enabled))) return Promise.resolve()
    if (enabled) nativeEntryPending = true
    return new Promise((resolve, reject) => {
      const eventName = enabled ? 'enter-full-screen' : 'leave-full-screen'
      let timer
      const finish = (error) => {
        clearTimeout(timer)
        window.removeListener(eventName, changed)
        window.removeListener('closed', closed)
        if (!error) nativeEntryPending = false
        error ? reject(error) : resolve()
      }
      const changed = () => finish()
      const closed = () => finish()
      window.once(eventName, changed)
      window.once('closed', closed)
      timer = setTimeout(() => {
        if (!available() || window.isFullScreen() === enabled) finish()
        else finish(new Error('Timed out changing viewer fullscreen.'))
      }, transitionTimeoutMs)
      try { window.setFullScreen(enabled) } catch (error) { finish(error) }
    })
  }

  const restore = async () => {
    if (!saved) return
    if (!available()) { saved = null; ownedMode = null; return }
    restoring = true
    try {
      const previous = saved
      if (ownedMode === 'simple') window.setSimpleFullScreen(false)
      if (ownedMode === 'native') await setNativeFullscreen(false)
      if (!available()) { saved = null; ownedMode = null; return }
      // When the app was already fullscreen we never own its native state and
      // must not resize it or leave the user's existing fullscreen Space.
      if (ownedMode) {
        if (window.isMaximized()) window.unmaximize()
        window.setBounds(previous.bounds)
        if (previous.isMaximized) window.maximize()
      }
      saved = null
      ownedMode = null
      restoreFailed = false
      onRestored()
    } catch (error) {
      restoreFailed = true
      throw error
    } finally {
      restoring = false
    }
  }

  function setEnabled(enabled, reason = 'renderer') {
    if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('Viewer presentation requires a boolean enabled value.'))
    if (!available()) return Promise.resolve(state())
    // A repeat disable retries a failed restoration; a repeat enable waits for
    // the current transition instead of creating a second native operation.
    if (desired === enabled && !restoreFailed) return queue.then(state, (error) => {
      // The failed entry may already have rolled back completely. Its rejected
      // promise must not make every subsequent renderer cleanup fail forever.
      if (!desired && !saved) return state()
      throw error
    })
    desired = enabled
    const requestRevision = ++revision
    if (!enabled) {
      active = false
      publish(reason)
    }
    queue = queue.catch(() => {}).then(async () => {
      if (!available() || requestRevision !== revision) return state()
      if (!enabled) {
        await restore()
        return state()
      }
      try {
        saved ||= capture()
        if (!saved.isFullScreen && !saved.isSimpleFullScreen) {
          if (platform === 'darwin') {
            ownedMode = 'simple'
            window.setSimpleFullScreen(true)
          } else {
            ownedMode = 'native'
            await setNativeFullscreen(true)
          }
        }
        if (available() && desired && requestRevision === revision) {
          active = true
          publish(reason)
        }
      } catch (error) {
        if (requestRevision === revision) {
          desired = false
          active = false
          ++revision
          publish('error')
        }
        try { await restore() } catch (restoreError) { onError(restoreError) }
        throw error
      }
      return state()
    })
    return queue
  }

  const cleanup = (reason) => { void setEnabled(false, reason).catch(onError) }
  listen(window.webContents, 'leave-html-full-screen', () => cleanup('html-exit'))
  listen(window.webContents, 'did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) cleanup('navigation')
  })
  listen(window.webContents, 'render-process-gone', () => cleanup('renderer-gone'))
  listen(window.webContents, 'destroyed', () => cleanup('renderer-destroyed'))
  listen(window.webContents, 'before-input-event', (event, input) => {
    if (desired && input.key === 'Escape' && input.type === 'keyDown') {
      event.preventDefault()
      cleanup('escape')
    }
  })
  listen(window, 'leave-full-screen', () => {
    if (desired && !restoring) cleanup('native-exit')
  })
  listen(window, 'close', () => cleanup('close'))
  listen(window, 'closed', () => {
    desired = false
    active = false
    disposed = true
    saved = null
    ownedMode = null
    ++revision
    publish('closed')
    for (const remove of listeners.splice(0)) remove()
  })

  return {
    window,
    setEnabled,
    getState: state,
    // The normal geometry remains authoritative even during async transitions
    // or a cancelled close. Never persist screen-filling presentation bounds.
    getPersistentWindowState: () => saved ? { bounds: { ...saved.bounds }, isMaximized: saved.isMaximized } : null,
  }
}

function registerViewerPresentationIpc(ipcMain, getController) {
  const authorized = (event) => {
    const controller = getController()
    const window = controller?.window
    if (!window || window.isDestroyed() || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Only the Velorn editor main frame may control viewer presentation.')
    }
    return controller
  }
  ipcMain.handle('viewer:setPresentation', (event, request) => {
    const controller = authorized(event)
    if (!request || typeof request.enabled !== 'boolean') throw new TypeError('Viewer presentation requires a boolean enabled value.')
    return controller.setEnabled(request.enabled)
  })
  ipcMain.handle('viewer:getPresentation', (event) => authorized(event).getState())
}

module.exports = { createViewerPresentation, registerViewerPresentationIpc }
