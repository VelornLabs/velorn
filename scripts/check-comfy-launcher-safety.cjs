// Real native lookup/guarded stop with disposable local HTTP processes only.
// Never reads normal Velorn settings/state or uses ComfyUI's configured port.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs/promises')
const os = require('node:os'), path = require('node:path')
const { ComfyLauncher } = require('../electron/comfyLauncher.js')

async function syntheticServer() {
  const source = `const http=require('node:http');const server=http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({system:{python_version:'synthetic-fixture'},devices:[]}))});server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'))`
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic server startup timed out')), 5000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Synthetic server exited before ready')) })
    child.stdout.on('data', data => {
      output += data
      if (output.includes('\n')) { clearTimeout(timer); resolve(Number(output.trim())) }
    })
  })
  return { child, base: `http://127.0.0.1:${port}`, port }
}

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-launcher-safety-'))
  const children = [], controllers = [], passed = []
  const makeController = (base, name) => {
    const launcher = new ComfyLauncher({ logDir: directory, stateFilePath: path.join(directory, `${name}.json`),
      getHttpBase: () => base, getConfig: () => ({ launcherMode: 'script', stopOnQuit: true }) })
    controllers.push(launcher)
    return launcher
  }
  try {
    const target = await syntheticServer(); children.push(target.child)
    const unrelated = await syntheticServer(); children.push(unrelated.child)
    const launcher = makeController(target.base, 'owned')
    const owner = await launcher.describePortOwner()
    assert.equal(owner.pid, target.child.pid)
    const other = await makeController(unrelated.base, 'unrelated').describePortOwner()
    assert.equal(other.pid, unrelated.child.pid)
    passed.push('Independent listening ports resolve to their exact synthetic child PIDs')

    const stale = makeController(target.base, 'stale')
    stale._readStateFile = async () => ({ pid: unrelated.child.pid, httpBase: target.base, port: target.port })
    assert.equal(await stale._tryReclaimFromStateFile(), false)
    assert.notEqual(stale.getState().ownership, 'ours')
    passed.push('A live but unrelated saved PID is not reclaimed')

    stale._pid = unrelated.child.pid
    stale._pidIdentity = await stale._readProcessIdentity(unrelated.child.pid)
    stale._ownedHttpBase = target.base
    stale._ownership = 'ours'; stale._state = 'running'
    assert.equal((await stale.stop()).success, false)
    assert.equal((await stale.shutdown()).stopped, false)
    assert.equal(unrelated.child.exitCode, null)
    assert.equal((await fetch(unrelated.base + '/system_stats')).status, 200)
    assert.equal((await fetch(target.base + '/system_stats')).status, 200)
    passed.push('Stale Stop and shutdown refuse to signal the unrelated server; both servers remain responsive')

    assert.equal(await launcher._tryAdoptExistingInstance(target.base), true)
    assert.equal(launcher.getState().pid, target.child.pid)
    assert.equal(launcher.getState().ownership, 'ours')
    const exited = once(target.child, 'exit')
    assert.equal((await launcher.stop()).success, true)
    await exited
    assert.equal(launcher.getState().state, 'stopped')
    assert.equal((await fetch(unrelated.base + '/system_stats')).status, 200)
    passed.push('Verified adopted-process Stop terminates only its disposable target')

    const result = { success: true, passed, directory }
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  } finally {
    for (const launcher of controllers) { launcher._stopProbing(); launcher._closeLogFile() }
    // These handles were created by this fixture, never discovered by PID.
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
