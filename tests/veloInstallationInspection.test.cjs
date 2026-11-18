'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { EventEmitter } = require('node:events')
const { inspectInstallation, MAC_GITS } = require('../electron/veloInstallationInspection.cjs')

async function temp(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-install-inspect-'))) // macOS: /var is a link to /private/var
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
function git(root, ...args) { return execFileSync('/usr/bin/git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
async function repository(root, branch = 'main') {
  await fs.mkdir(root, { recursive: true }); git(root, 'init', '-b', branch)
  await fs.writeFile(path.join(root, 'comfyui_version.py'), '__version__ = "0.43.0"\n')
  await fs.writeFile(path.join(root, 'main.py'), '# Synthetic fixture, never executed.\n')
  await fs.writeFile(path.join(root, 'requirements.txt'), '# No packages.\n')
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture'); git(root, 'tag', 'v0.43.0')
  return root
}
async function inspect(root, options = {}) { return inspectInstallation({ path: root, assertCurrent: () => true, ...options }) }
async function snapshot(root) {
  const records = []
  async function walk(directory, relative = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(directory, entry.name), name = path.join(relative, entry.name)
      if (entry.isDirectory()) await walk(child, name)
      else if (entry.isFile()) records.push([name, createHash('sha256').update(await fs.readFile(child)).digest('hex'), (await fs.stat(child)).mtimeMs])
      else if (entry.isSymbolicLink()) records.push([name, await fs.readlink(child)])
    }
  }
  await walk(root); return records
}

test('tag-only release checkout: no invented branch, no fetch, exact read-only snapshot', async t => {
  const root = await temp(t), upstream = await repository(path.join(root, 'upstream')), checkout = path.join(root, 'Installed ComfyUI')
  git(upstream, 'tag', 'v0.32.0')
  git(root, 'clone', '--no-local', '--depth=1', '--single-branch', '--branch=v0.43.0', `file://${upstream}`, checkout)
  git(checkout, 'config', 'remote.origin.fetch', '+refs/tags/v0.32.0:refs/tags/v0.32.0')
  git(checkout, 'config', 'remote.origin.url', 'https://example.invalid/private.git?token=do-not-leak')
  const before = await snapshot(checkout), result = await inspect(checkout)
  assert.equal(result.success, true); assert.equal(result.readOnly, true)
  assert.equal(result.git.checkout, 'detached-tag'); assert.equal(result.git.branch, null); assert.equal(result.git.upstream, null)
  assert.equal(result.git.shallow, true); assert.equal(result.version.value, '0.43.0')
  assert.ok(result.git.tagsAtHead.includes('v0.43.0'))
  assert.equal(result.git.refs.values.some(ref => ref.name.startsWith('refs/remotes/')), false)
  assert.equal(result.git.fetchRefspecs.values[0].value, '+refs/tags/v0.32.0:refs/tags/v0.32.0')
  assert.match(result.guidance.join(' '), /pinned tags/)
  assert.equal(JSON.stringify(result).includes('do-not-leak'), false)
  assert.deepEqual(await snapshot(checkout), before)
})

for (const branch of ['main', 'master', 'release/custom-branch']) test(`existing ${branch} branch/upstream is observed rather than guessed`, async t => {
  const root = await temp(t), repo = await repository(path.join(root, 'repo'), branch)
  git(repo, 'remote', 'add', 'upstream', '/nonexistent/offline-source')
  git(repo, 'update-ref', `refs/remotes/upstream/${branch}`, 'HEAD')
  git(repo, 'branch', `--set-upstream-to=upstream/${branch}`)
  const result = await inspect(repo)
  assert.equal(result.git.branch, branch); assert.equal(result.git.upstream, `refs/remotes/upstream/${branch}`)
  assert.equal(result.git.checkout, 'branch'); assert.equal(result.git.changes.state, 'clean')
  assert.equal(result.git.networkChecked, false)
})

test('dirty/untracked state is preserved and precisely observed', async t => {
  const root = await temp(t), repo = await repository(path.join(root, 'repo'))
  await fs.appendFile(path.join(repo, 'main.py'), '# user edit\n')
  await fs.writeFile(path.join(repo, 'run-local.sh'), '# custom launcher\n')
  const before = await snapshot(repo), result = await inspect(repo)
  assert.equal(result.git.changes.state, 'dirty'); assert.equal(result.git.changes.trackedCount, 1); assert.equal(result.git.changes.untrackedCount, 1)
  assert.match(result.guidance.join(' '), /Preserve local edits/)
  assert.deepEqual(await snapshot(repo), before)
})

test('worktree .git file and symlinked installation resolve to the actual worktree', async t => {
  const root = await temp(t), repo = await repository(path.join(root, 'repo')), worktree = path.join(root, 'linked tree'), link = path.join(root, 'alias')
  git(repo, 'worktree', 'add', '--detach', worktree, 'v0.43.0'); await fs.symlink(worktree, link)
  const result = await inspect(link)
  assert.equal(result.path, worktree); assert.equal(result.git.root, worktree); assert.equal(result.git.rootMatchesTarget, true)
  assert.equal(result.git.checkout, 'detached-tag'); assert.ok(result.observations.markers.some(entry => entry.path === '.git' && entry.type === 'file'))
})

test('nested software folder does not borrow its parent repository as updater', async t => {
  const root = await temp(t), repo = await repository(path.join(root, 'parent')), nested = path.join(repo, 'ComfyUI')
  await fs.mkdir(nested); await fs.writeFile(path.join(nested, 'comfyui_version.py'), '__version__ = "1.2.3"\n')
  const result = await inspect(nested)
  assert.equal(result.git.state, 'parent-repository'); assert.equal(result.git.rootMatchesTarget, false)
  assert.match(result.guidance.join(' '), /Do not update the parent/)
})

test('non-Git archive, portable, desktop and container markers remain observations, never executed', async t => {
  const root = await temp(t), repo = path.join(root, 'archive'); await fs.mkdir(repo)
  for (const name of ['.venv/bin', 'python_embeded', 'update', 'Contents/Resources']) await fs.mkdir(path.join(repo, name), { recursive: true })
  for (const name of ['.venv/bin/python', 'python_embeded/python.exe', 'update/update_comfyui.bat', 'Dockerfile', 'uv.lock']) await fs.writeFile(path.join(repo, name), 'never run this\n')
  await fs.writeFile(path.join(repo, 'comfyui_version.py'), '__version__ = "0.43.2"\nraise RuntimeError("must not import")\n')
  const before = await snapshot(repo), result = await inspect(repo)
  assert.equal(result.git.state, 'not-worktree-or-unreadable'); assert.equal(result.version.value, '0.43.2')
  assert.equal(result.observations.pythonCandidates.length, 2)
  assert.ok(result.observations.pythonCandidates.every(value => value.executed === false))
  assert.deepEqual(await snapshot(repo), before)
})

test('unknown version expression and absent Python are not evaluated or guessed', async t => {
  const root = await temp(t)
  await fs.writeFile(path.join(root, 'comfyui_version.py'), '__version__ = __import__("os").system("touch sentinel")\n')
  const result = await inspect(root)
  assert.equal(result.version.state, 'not-literal'); assert.deepEqual(result.observations.pythonCandidates, [])
  await assert.rejects(fs.stat(path.join(root, 'sentinel')), { code: 'ENOENT' })
})

test('unborn repository is distinct from a detached release', async t => {
  const root = await temp(t); git(root, 'init', '-b', 'future')
  const result = await inspect(root)
  assert.equal(result.git.checkout, 'unborn'); assert.equal(result.git.head, null); assert.deepEqual(result.git.tagsAtHead, [])
})

test('annotated release tags are resolved to the commit', async t => {
  const root = await temp(t), repo = await repository(path.join(root, 'repo'))
  git(repo, 'tag', '-a', 'release-annotated', '-m', 'fixture'); git(repo, 'checkout', '--detach', 'release-annotated')
  const result = await inspect(repo)
  assert.equal(result.git.checkout, 'detached-tag'); assert.ok(result.git.tagsAtHead.includes('release-annotated'))
})

test('Git fsmonitor and untrusted config values cannot execute or leak', async t => {
  const root = await temp(t), repo = await repository(path.join(root, 'repo')), script = path.join(root, 'monitor.sh'), marker = path.join(root, 'executed')
  await fs.writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 })
  git(repo, 'config', 'core.fsmonitor', script)
  git(repo, 'config', 'remote.origin.url', 'https://secret:credential@example.invalid/repo')
  git(repo, 'config', 'remote.evil.fetch', 'secret=do-not-return-me')
  const before = await snapshot(repo), result = await inspect(repo)
  assert.equal(JSON.stringify(result).includes('credential'), false); assert.equal(JSON.stringify(result).includes('do-not-return-me'), false)
  assert.equal(result.git.fetchRefspecs.values[0].value, '[nonstandard-refspec]')
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }); assert.deepEqual(await snapshot(repo), before)
})

test('bounded refs and status cannot falsely establish a fully inspected clean checkout', async t => {
  const root = await temp(t), repo = await repository(path.join(root, 'repo'))
  for (let index = 0; index < 5; index++) git(repo, 'tag', `extra-${index}`)
  const result = await inspect(repo, { limits: { entries: 2 } })
  assert.equal(result.git.refs.values.length, 2); assert.equal(result.git.refs.complete, false)
  const limited = await inspect(repo, { limits: { outputBytes: 4 } })
  assert.equal(limited.git.state, 'inspection-incomplete')
})

for (const included of [false, true]) test(`Git content filters${included ? ' from included config' : ''} are not executed during inspection`, async t => {
  const root = await temp(t), repo = await repository(path.join(root, 'repo')), marker = path.join(root, 'filter-ran')
  await fs.writeFile(path.join(repo, '.gitattributes'), '*.txt filter=fixture\n')
  await fs.writeFile(path.join(repo, 'filter.txt'), 'before\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'filter fixture before configuration')
  const filterScript = path.join(root, 'filter.sh')
  await fs.writeFile(filterScript, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 })
  if (included) {
    const config = path.join(root, 'included.gitconfig')
    await fs.writeFile(config, `[filter "fixture"]\nclean = '${filterScript}'\n`)
    git(repo, 'config', 'include.path', config)
  } else git(repo, 'config', 'filter.fixture.clean', `'${filterScript}'`)
  await fs.writeFile(path.join(repo, 'filter.txt'), 'after!\n')
  const before = await snapshot(repo), result = await inspect(repo)
  assert.equal(result.git.changes.state, 'unknown')
  assert.equal(result.git.changes.inspectionSkipped, 'content-filters-or-unknown-config')
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' })
  assert.deepEqual(await snapshot(repo), before)
})

test('non-ASCII Git branch names are preserved as observations', async t => {
  const root = await temp(t), repo = await repository(path.join(root, 'repo'), 'rélease/生产')
  const result = await inspect(repo)
  assert.equal(result.git.branch, 'rélease/生产'); assert.equal(result.git.checkout, 'branch'); assert.equal(result.git.refs.complete, true)
})

test('current release identity is retained even when the all-refs list is bounded', async t => {
  const root = await temp(t), repo = await repository(path.join(root, 'repo'))
  for (let index = 0; index < 5; index++) git(repo, 'branch', `early-${index}`)
  git(repo, 'checkout', '--detach', 'v0.43.0')
  const result = await inspect(repo, { limits: { entries: 2 } })
  assert.equal(result.git.refs.complete, false); assert.equal(result.git.checkout, 'detached-tag')
  assert.deepEqual(result.git.tagsAtHead, ['v0.43.0']); assert.equal(result.git.tagsAtHeadComplete, true)
})

test('version file FIFO is rejected without blocking or executing', async t => {
  const root = await temp(t)
  execFileSync('/usr/bin/mkfifo', [path.join(root, 'comfyui_version.py')])
  const result = await inspect(root)
  assert.equal(result.version.state, 'unreadable')
})

test('missing path and file target produce observations without executing anything', async t => {
  const root = await temp(t), file = path.join(root, 'launcher.sh'); await fs.writeFile(file, '# no execute')
  const noSpawn = () => { throw Error('unexpected spawn') }
  assert.equal((await inspect(path.join(root, 'missing'), { spawnImpl: noSpawn })).state, 'missing')
  assert.equal((await inspect(file, { spawnImpl: noSpawn })).state, 'not-directory')
})

test('authority refusal and Stop do not start inspection commands', async t => {
  const root = await temp(t), controller = new AbortController(); controller.abort()
  let spawns = 0; const spawnImpl = () => { spawns++; throw Error('unexpected') }
  await assert.rejects(inspect(root, { assertCurrent: () => false, spawnImpl }), { code: 'UNAUTHORIZED' })
  await assert.rejects(inspect(root, { signal: controller.signal, spawnImpl }))
  assert.equal(spawns, 0)
})

for (const kind of ['timeout', 'abort']) test(`${kind} kills the owned inspection process and waits for close`, async t => {
  const root = await temp(t), controller = new AbortController(); let kills = 0, closed = false
  const spawnImpl = (_file, args, options) => {
    assert.ok(args.includes('core.fsmonitor=false')); assert.equal(options.shell, false); assert.equal(options.env.NODE_OPTIONS, undefined)
    const child = new EventEmitter(); child.stdout = new EventEmitter()
    child.kill = signal => { assert.equal(signal, 'SIGKILL'); kills++; setImmediate(() => { closed = true; child.emit('close', null) }) }
    if (kind === 'abort') setImmediate(() => controller.abort())
    return child
  }
  const pending = inspect(root, { signal: controller.signal, spawnImpl, limits: { commandMs: 10 } })
  if (kind === 'abort') await assert.rejects(pending)
  else assert.equal((await pending).git.state, 'inspection-incomplete')
  assert.equal(kills, 1); assert.equal(closed, true)
})

test('macOS never runs the /usr/bin/git placeholder that opens an install window', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-inspection-mac-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, '.git'))
  const spawned = []
  const spawnImpl = file => { spawned.push(file); throw Error('synthetic: stop before running anything') }
  const fsFor = present => ({ ...fs, access: async (target, mode) => MAC_GITS.includes(target)
    ? (target === present ? undefined : Promise.reject(Object.assign(Error('absent'), { code: 'ENOENT' }))) : fs.access(target, mode) })
  const none = await inspect(root, { platform: 'darwin', spawnImpl, fsImpl: fsFor(null) })
  assert.equal(none.success, true); assert.deepEqual(spawned, [], 'With no real Git installed, nothing is started')
  await inspect(root, { platform: 'darwin', spawnImpl, fsImpl: fsFor('/opt/homebrew/bin/git') })
  assert.ok(spawned.length > 0); assert.ok(spawned.every(file => file === '/opt/homebrew/bin/git'))
  spawned.length = 0
  const windows = await inspect(root, { platform: 'win32', spawnImpl })
  assert.equal(windows.success, true); assert.deepEqual(spawned, [], 'Windows reads no Git details yet and starts nothing')
  spawned.length = 0
  await inspect(root, { platform: 'linux', spawnImpl })
  assert.ok(spawned.length > 0); assert.ok(spawned.every(file => file === '/usr/bin/git'), 'Linux is unchanged')
})
