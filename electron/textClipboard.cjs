// UI-only, write-only clipboard boundary. This is deliberately not a connected
// agent tool and never provides clipboard reads or arbitrary native commands.
const MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024

function registerTextClipboardIpc({ ipcMain, getMainWindow, clipboard, Menu }) {
  const authorizedText = (event, text) => {
    const window = getMainWindow()
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Only the Velorn editor main frame may copy text.')
    }
    if (typeof text !== 'string' || !text.length || Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_TEXT_BYTES) {
      throw new TypeError('Copy requires non-empty text of at most 1 MiB.')
    }
    return window
  }
  ipcMain.handle('text-clipboard:write', (event, text) => {
    authorizedText(event, text)
    clipboard.writeText(text)
    return { success: true }
  })
  ipcMain.handle('text-clipboard:menu', (event, text) => {
    const window = authorizedText(event, text)
    const sender = event.sender, frame = event.senderFrame
    const menu = Menu.buildFromTemplate([{ label: 'Copy', click: () => {
      // A delayed menu action must not cross a window/frame replacement.
      if (getMainWindow() !== window || window.isDestroyed() || sender.isDestroyed()
        || sender.mainFrame !== frame) return
      clipboard.writeText(text)
    } }])
    menu.popup({ window })
    return { success: true }
  })
}

module.exports = { registerTextClipboardIpc, MAX_CLIPBOARD_TEXT_BYTES }
