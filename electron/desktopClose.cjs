'use strict'
const { randomUUID } = require('node:crypto')

// Closing is a transaction: prepare/save, resolve an embedded page's veto,
// then (and only then) stop or detach the launcher. Never destroy the window
// to get around unsaved work. Every cancelled/failed attempt can be retried.
function createDesktopClose({ app, ipcMain, dialog, getWindow, getOwnedLauncher,
  stopOnQuit, detach, shutdown, flush, platform = process.platform,
  timeoutMs = 30000, log = console }) {
  let current, pendingSave, quitRequested = false, quitting = false
  const channels = { prepare: 'window:prepareClose', saved: 'window:closePrepared', cancel: 'window:closeCancelled' }
  function bounded(promise, message) {
    let timer
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    })]).finally(() => clearTimeout(timer))
  }
  function cancel(state) {
    state.phase = 'idle'; state.action = null; quitRequested = false
    if (!state.win.isDestroyed()) state.win.webContents.send(channels.cancel)
  }
  function onSaved(event, result) {
    const pending = pendingSave
    if (!pending || event.sender !== pending.win.webContents
      || event.senderFrame !== pending.win.webContents.mainFrame
      || result?.id !== pending.id) return
    pending.resolve(result.ok === true)
  }
  ipcMain.on(channels.saved, onSaved)
  async function save(win) {
    const id = randomUUID()
    try {
      const reply = new Promise(resolve => { pendingSave = { win, id, resolve } })
      win.webContents.send(channels.prepare, { id })
      if (!await bounded(reply, 'The editor did not confirm that your project was saved.')) {
        throw new Error('Your project could not be saved.')
      }
    } finally { pendingSave = null }
  }
  async function prepare(state) {
    try {
      if (getOwnedLauncher()) {
        state.action = 'detach'
        if (stopOnQuit()) {
          const choice = await dialog.showMessageBox(state.win, {
            type: 'question', title: 'Quit Velorn?', message: 'ComfyUI is still running.',
            buttons: ['Stop ComfyUI & quit', 'Leave ComfyUI running', 'Cancel'], defaultId: 0, cancelId: 2,
            detail: 'Velorn started ComfyUI. Stopping it cancels any in-flight generations. Leaving it running keeps those jobs going. Nothing stops if you cancel closing Velorn.',
          })
          if (choice.response !== 0 && choice.response !== 1) { cancel(state); return }
          state.action = choice.response === 0 ? 'stop' : 'detach'
        }
      }
      await save(state.win)
      await bounded(Promise.resolve().then(flush), 'Pending project history could not finish saving.')
      if (state.win.isDestroyed()) return
      state.phase = 'closing'
      state.win.close()
    } catch (error) {
      log.warn('[desktopClose] Close cancelled:', error?.message || error)
      if (!state.win.isDestroyed()) {
        await dialog.showMessageBox(state.win, {
          type: 'warning', title: 'Velorn is still open', message: 'Could not finish saving before closing.',
          detail: 'Your window and ComfyUI have been left open. Save your project and try closing again. If the editor is still loading or busy, wait for it to finish first.',
          buttons: ['Keep Velorn open'], defaultId: 0, cancelId: 0,
        }).catch(() => {})
        cancel(state)
      }
    }
  }
  async function finish(state) {
    try {
      if (getOwnedLauncher() && state.action) {
        const result = await bounded(Promise.resolve().then(() => state.action === 'stop' ? shutdown() : detach()),
          'ComfyUI did not confirm the selected quit action.')
        if (result?.error || result?.success === false) throw new Error('ComfyUI could not complete the selected quit action.')
      }
    } catch (error) {
      log.warn('[desktopClose] Launcher quit action unconfirmed:', error?.message || error)
      await dialog.showMessageBox({ type: 'warning', title: 'Check ComfyUI',
        message: 'Velorn closed, but could not confirm ComfyUI’s status.',
        detail: 'ComfyUI may still be running. Check it before starting another copy. Velorn will not force-stop it or repeat the action.',
        buttons: ['Quit Velorn'], defaultId: 0, cancelId: 0 }).catch(() => {})
    } finally {
      state.phase = 'finished'
      if (quitRequested || platform !== 'darwin') { quitting = true; app.quit() }
    }
  }
  function attach(win) {
    const state = { win, phase: 'idle', action: null }
    current = state
    win.on('close', event => {
      if (state.phase === 'closing') return
      event.preventDefault()
      if (state.phase !== 'idle') return
      state.phase = 'preparing'
      void prepare(state)
    })
    win.webContents.on('will-prevent-unload', event => {
      // Do not turn unrelated navigation/reload vetoes into permission to exit.
      if (state.phase !== 'closing') return
      let choice = 0
      try {
        choice = dialog.showMessageBoxSync(win, {
          type: 'warning', title: 'Unsaved page changes',
          message: 'ComfyUI or another embedded page has unsaved changes.',
          detail: 'Your Velorn project has been saved. Keep Velorn open to save your workflow changes, or close without saving those page changes.',
          buttons: ['Keep Velorn open', 'Close without saving page changes'], defaultId: 0, cancelId: 0,
        })
      } catch (error) { log.warn('[desktopClose] Could not show unsaved-page confirmation:', error?.message) }
      // Electron requires a synchronous decision. This ignores the page's veto
      // only after the user explicitly approves; Cancel never stops ComfyUI.
      if (choice === 1) event.preventDefault()
      else cancel(state)
    })
    win.once('closed', () => {
      state.phase = 'finishing'
      void finish(state)
    })
  }
  app.on('before-quit', event => {
    if (quitting) return
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      event.preventDefault(); quitRequested = true; win.close()
    } else if (current && current.phase !== 'finished') {
      event.preventDefault(); quitRequested = true
    }
  })
  return { attach }
}
module.exports = { createDesktopClose }
