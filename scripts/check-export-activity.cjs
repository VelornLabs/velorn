const { spawnSync } = require('node:child_process')
const path = require('node:path')
// Direct launch retains Electron's sandbox; no real application profile loads.
const child = spawnSync(require('electron'), [path.resolve(__dirname, '../tests/fixtures/export-activity-electron.cjs')], {
  stdio: 'inherit', timeout: 40000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
})
if (child.error) console.error(child.error.message)
process.exitCode = child.status === 0 ? 0 : 1
