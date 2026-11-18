const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { registerTextClipboardIpc, MAX_CLIPBOARD_TEXT_BYTES } = require('../electron/textClipboard.cjs')

function fixture() {
  const handlers = new Map(), writes = [], menus = []
  const frame = {}, sender = { mainFrame: frame, isDestroyed: () => false }
  let main = { webContents: sender, isDestroyed: () => false }
  const event = { sender, senderFrame: frame }
  registerTextClipboardIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getMainWindow: () => main, clipboard: { writeText: text => writes.push(text) },
    Menu: { buildFromTemplate: template => { const menu = { template, popup: options => { menu.options = options } }; menus.push(menu); return menu } } })
  return { handlers, writes, menus, event, main, replace: value => { main = value },
    invoke: (name, text, owner = event) => handlers.get(`text-clipboard:${name}`)(owner, text) }
}

test('clipboard UI exposes only bounded text write and Copy menu with exact main-frame ownership', () => {
  const f = fixture()
  assert.deepEqual([...f.handlers.keys()], ['text-clipboard:write', 'text-clipboard:menu'])
  assert.deepEqual(f.invoke('write', 'Velorn 🦋\nC:\\clips\\take 2.mov\n日本語'), { success: true })
  assert.deepEqual(f.writes, ['Velorn 🦋\nC:\\clips\\take 2.mov\n日本語'])
  for (const owner of [{ sender: {}, senderFrame: f.event.senderFrame }, { sender: f.event.sender, senderFrame: {} },
    { sender: f.event.sender }, {}]) {
    for (const operation of ['write', 'menu']) assert.throws(() => f.invoke(operation, 'No', owner), /main frame/)
  }
  for (const text of ['', null, {}, ['text'], 'a'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1), '🦋'.repeat(MAX_CLIPBOARD_TEXT_BYTES / 4 + 1)]) {
    for (const operation of ['write', 'menu']) assert.throws(() => f.invoke(operation, text), /at most 1 MiB/)
  }
  assert.equal(f.writes.length, 1)
  f.replace(null)
  assert.throws(() => f.invoke('write', 'stale'), /main frame/)
})

test('native Copy menu uses the selected snapshot only after its click and retires stale windows/frames', () => {
  const f = fixture()
  assert.deepEqual(f.invoke('menu', 'selected reply'), { success: true })
  const first = f.menus[0]
  assert.deepEqual(first.options, { window: f.main })
  assert.equal(first.template.length, 1)
  assert.equal(first.template[0].label, 'Copy')
  assert.deepEqual(f.writes, [])
  first.template[0].click()
  assert.deepEqual(f.writes, ['selected reply'])
  f.invoke('menu', 'stale frame')
  f.event.sender.mainFrame = {}
  f.menus[1].template[0].click()
  assert.equal(f.writes.length, 1)
  f.event.sender.mainFrame = f.event.senderFrame
  f.invoke('menu', 'stale window')
  f.replace({ ...f.main })
  f.menus[2].template[0].click()
  assert.equal(f.writes.length, 1)
})

test('real preload requires transient activation and exposes no clipboard read method', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const exposed = {}, calls = [], navigator = { userActivation: { isActive: false } }
    const context = vm.createContext({ process: { platform }, navigator, require: name => {
      assert.equal(name, 'electron')
      return { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } },
        ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ success: true }) } } }
    } })
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/preload.js'), 'utf8'), context)
    const api = exposed.electronAPI
    assert.deepEqual(Object.keys(api).filter(key => /clipboard|copytext/i.test(key)), ['writeClipboardText'])
    assert.equal(api.readClipboardText, undefined)
    await assert.rejects(api.writeClipboardText('No gesture'), /user gesture/)
    await assert.rejects(api.showTextCopyMenu('No gesture'), /user gesture/)
    assert.deepEqual(calls, [])
    navigator.userActivation.isActive = true
    await api.writeClipboardText('reply')
    await api.showTextCopyMenu('selection')
    assert.deepEqual(calls, [['text-clipboard:write', 'reply'], ['text-clipboard:menu', 'selection']])
  }
})
