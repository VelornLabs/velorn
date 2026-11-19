const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
test('asset Trash is restricted to the editor main frame', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const block = source.slice(source.indexOf("ipcMain.handle('fs:trashAssetFiles'"), source.indexOf("ipcMain.handle('fs:deleteFile'"))
  const frame = {}, contents = { mainFrame: frame }, calls = []
  let handler
  vm.runInNewContext(block, { ipcMain: { handle: (_, fn) => { handler = fn } }, mainWindow: { isDestroyed: () => false, webContents: contents }, mediaPreparation: { runExclusiveWhenIdle: operation => operation() }, assetTrash: { trashAssetFiles: payload => { calls.push(payload); return { success: true } } } })
  const payload = { paths: ['/synthetic/a.png'] }
  for (const event of [{ sender: {} }, { sender: contents }, { sender: contents, senderFrame: {} }]) assert.equal((await handler(event, payload)).success, false)
  assert.equal(calls.length, 0)
  assert.equal((await handler({ sender: contents, senderFrame: frame }, payload)).success, true)
  assert.deepEqual(calls, [payload])
})
test('preload exposes the bounded operation separately from legacy cache cleanup', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8')
  assert.match(source, /trashAssetFiles: \(payload\) => ipcRenderer.invoke\('fs:trashAssetFiles', payload\)/)
  assert.match(source, /deleteFile:.*'fs:deleteFile'/)
})
