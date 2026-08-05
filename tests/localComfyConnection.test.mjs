import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// The app deliberately remains a CommonJS Electron package while renderer
// services use ESM syntax through Vite. Load this dependency-free service as
// a data URL so the focused Node test does not need a package-wide module-mode
// flag (removed in newer Node releases).
const serviceSource = await readFile(
  new URL('../src/services/localComfyConnection.js', import.meta.url),
  'utf8',
)
const {
  getLocalComfyConnectionSync,
} = await import(`data:text/javascript;base64,${Buffer.from(serviceSource).toString('base64')}`)

function withWindow(value, callback) {
  const previous = globalThis.window
  globalThis.window = value
  try {
    callback()
  } finally {
    if (previous === undefined) {
      delete globalThis.window
    } else {
      globalThis.window = previous
    }
  }
}

test('uses loopback outside a browser', () => {
  const connection = getLocalComfyConnectionSync()
  assert.equal(connection.host, '127.0.0.1')
  assert.equal(connection.httpBase, 'http://127.0.0.1:8188')
  assert.equal(connection.wsBase, 'ws://127.0.0.1:8188')
})

test('uses the page hostname in LAN browser mode', () => {
  withWindow({ location: { hostname: '192.168.1.20' } }, () => {
    const connection = getLocalComfyConnectionSync()
    assert.equal(connection.host, '192.168.1.20')
    assert.equal(connection.httpBase, 'http://192.168.1.20:8188')
    assert.equal(connection.wsBase, 'ws://192.168.1.20:8188')
  })
})

test('keeps Electron on loopback even when its page has a LAN hostname', () => {
  withWindow({
    electronAPI: { isElectron: true },
    location: { hostname: '192.168.1.20' },
  }, () => {
    const connection = getLocalComfyConnectionSync()
    assert.equal(connection.host, '127.0.0.1')
    assert.equal(connection.httpBase, 'http://127.0.0.1:8188')
  })
})

test('formats IPv6 browser hostnames for URLs', () => {
  withWindow({ location: { hostname: '[fd00::20]' } }, () => {
    const connection = getLocalComfyConnectionSync()
    assert.equal(connection.host, 'fd00::20')
    assert.equal(connection.httpBase, 'http://[fd00::20]:8188')
    assert.equal(connection.wsBase, 'ws://[fd00::20]:8188')
  })
})
