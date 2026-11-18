// A separate Electron process, no BrowserWindow/MCP/user settings. Only files
// created in this fixture's own mkdtemp directory can reach the Trash helper.
const { app, shell } = require('electron')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createAssetTrash } = require('../../electron/assetTrash.cjs')

app.whenReady().then(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-trash-fixture-'))
  const candidate = path.join(root, 'disposable-asset.txt'), retained = path.join(root, 'retained-asset.txt')
  await fs.writeFile(candidate, 'Synthetic Velorn Trash verification. Not user media.\n')
  await fs.writeFile(retained, 'Synthetic file that must be retained.\n')
  const helper = createAssetTrash({ trashItem: target => {
    assert.equal(target, candidate, 'Only the newly created disposable file may be moved')
    return shell.trashItem(target)
  } })
  assert.equal((await helper.trashAssetFiles({ paths: [retained], protectedPaths: [retained] })).success, false)
  assert.equal((await helper.trashAssetFiles({ paths: [root] })).success, false)
  const moved = await helper.trashAssetFiles({ paths: [candidate], protectedPaths: [retained] })
  assert.equal(moved.success, true, JSON.stringify(moved))
  await assert.rejects(fs.stat(candidate), { code: 'ENOENT' })
  assert.equal(await fs.readFile(retained, 'utf8'), 'Synthetic file that must be retained.\n')
  assert.equal((await helper.trashAssetFiles({ paths: [candidate] })).results[0].missing, true)
  console.log(JSON.stringify({ success: true, root, checks: ['protected file retained', 'folder refused', 'native system Trash', 'missing file no-op'] }))
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
