'use strict'

const { randomUUID } = require('node:crypto')
const { createCodexSetupInstaller } = require('./codexSetupInstaller.cjs')
const METHODS = ['plan', 'install', 'status', 'cancel']
const CHANNELS = Object.freeze(Object.fromEntries(METHODS.map(name => [name, `codex-setup-installer:${name}`])))
const failure = () => ({ success: false, code: 'UNAUTHORIZED', error: 'Reopen Codex setup in the main Velorn window.' })

// Desktop-only authority. No URL/path/owner accepted from renderer or tools.
function registerCodexSetupInstallerIpc({ ipcMain, app, dialog, getMainWindow, inspectExisting,
  isBusy = () => false, createManager = createCodexSetupInstaller } = {}) {
  let record, disposed = false, confirming = false
  const current = r => !disposed && r?.valid && getMainWindow() === r.window && !r.window.isDestroyed()
    && !r.contents.isDestroyed() && r.window.webContents === r.contents && r.contents.mainFrame === r.frame
  const invalidate = r => {
    if (!r?.valid) return
    r.valid = false
    for (const [target, name, listener] of r.listeners) target.removeListener?.(name, listener)
    r.listeners.length = 0; manager.cancelOwner(r.owner)
    if (record === r) record = null
  }
  const assertCurrent = async (owner, action) => {
    if (!current(record) || record.owner !== owner) throw Error('Setup document changed')
    if (!['status', 'cancel'].includes(action) && await isBusy()) throw Object.assign(new Error('Wait for the current export to finish before installing Codex.'), { codexInstall: true, code: 'BUSY' })
    if (!current(record) || record.owner !== owner) throw Error('Setup document changed')
  }
  const manager = createManager({ getHomeDirectory: () => app.getPath('home'), inspectExisting, assertCurrent,
    confirm: async plan => {
      await assertCurrent(plan.owner, 'install')
      if (confirming) throw Error('A native approval is already open')
      const r = record; confirming = true
      try {
        const choice = await dialog.showMessageBox(r.window, {
          type: 'question', title: 'Install Codex', message: `Download and install Codex ${plan.version}?`,
          detail: `Official OpenAI release\n${plan.source}\n\nDownload: ${(plan.bytes / 1048576).toFixed(1)} MB\nInstall only for this user:\n${plan.destination}\n\nThe download must match its reviewed SHA-256 checksum. No administrator access, existing installation replacement, sign-in, account changes or AI requests. Sign-in is a separate step.`,
          buttons: ['Cancel', 'Download and install'], defaultId: 0, cancelId: 0, noLink: true,
        })
        await assertCurrent(plan.owner, 'install')
        return current(r) && choice.response === 1
      } finally { confirming = false }
    },
  })
  function context(event) {
    const window = getMainWindow(), contents = window?.webContents
    if (disposed || !window || window.isDestroyed() || !contents || contents.isDestroyed() || !contents.mainFrame
      || event?.sender !== contents || event?.senderFrame !== contents.mainFrame) return null
    if (record && !current(record)) invalidate(record)
    if (!record) {
      const r = { window, contents, frame: contents.mainFrame, owner: randomUUID(), valid: true, listeners: [] }; record = r
      const listen = (target, name, listener) => { target.on?.(name, listener); r.listeners.push([target, name, listener]) }
      listen(contents, 'did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) invalidate(r) })
      listen(contents, 'render-process-gone', () => invalidate(r)); listen(contents, 'destroyed', () => invalidate(r)); listen(window, 'closed', () => invalidate(r))
    }
    return record
  }
  for (const method of METHODS) ipcMain.handle(CHANNELS[method], async (event, args) => {
    const r = context(event)
    if (!r) return failure()
    try {
      await assertCurrent(r.owner, method)
      const result = await manager[method](args, r.owner)
      return current(r) ? result : failure()
    } catch (error) {
      return error?.codexInstall ? { success: false, code: error.code, error: error.message } : failure()
    }
  })
  const dispose = () => { if (disposed) return; invalidate(record); disposed = true; manager.dispose(); for (const channel of Object.values(CHANNELS)) ipcMain.removeHandler(channel); app.removeListener?.('will-quit', dispose) }
  app.on?.('will-quit', dispose)
  return { dispose }
}

module.exports = { registerCodexSetupInstallerIpc, CHANNELS }
