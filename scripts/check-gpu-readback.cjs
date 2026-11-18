// Requires an isolated Vite server through VELORN_TEST_URL (default 5198).
// The fixture imports only the compositor, never the app or any project.
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const child = spawnSync(require('electron'), [path.resolve(__dirname, '../tests/fixtures/gpu-readback-electron.cjs')], {
  stdio: 'inherit', timeout: 30000,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
})
if (child.error) console.error(child.error.message)
process.exitCode = child.status === 0 ? 0 : 1
