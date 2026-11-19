'use strict'

// Native-only, read-only observations for the authorized computer session.
// Never imports Python/package code, runs update scripts, or contacts a remote.
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { abortable, checkAbort } = require('./connectedAgentMcpGateway.cjs')

const LIMITS = Object.freeze({ commandMs: 5000, outputBytes: 48 * 1024, fileBytes: 64 * 1024, entries: 128 })
const MARKERS = Object.freeze(['main.py', 'comfyui_version.py', 'requirements.txt', 'pyproject.toml', 'uv.lock',
  '.git', '.venv/pyvenv.cfg', 'venv/pyvenv.cfg', 'environment.yml', 'comfy', 'custom_nodes', 'models', 'user',
  'python_embeded/python.exe', 'python_embedded/python.exe', 'run_nvidia_gpu.bat', 'update/update_comfyui.bat',
  'ComfyUI', 'resources/ComfyUI', 'Contents/Resources', 'Dockerfile', 'compose.yaml', 'docker-compose.yml', '.dockerenv'])
const PYTHONS = Object.freeze(['.venv/bin/python', '.venv/bin/python3', 'venv/bin/python', 'venv/bin/python3',
  '.venv/Scripts/python.exe', 'venv/Scripts/python.exe', 'python_embeded/python.exe', 'python_embedded/python.exe'])
const fault = (code, message) => Object.assign(Error(message), { code, publicMessage: message })
const present = value => value && value.code === 0 && !value.truncated && !value.timedOut && !value.unavailable
const lines = value => String(value || '').split('\n').filter(Boolean)
const refName = value => typeof value === 'string' && value.length <= 4096 && /^refs\/[^\x00-\x20\x7f~^:?*\[\\]+$/u.test(value) ? value : null
const objectId = value => /^[a-f0-9]{40,64}$/.test(value || '') ? value : null

// On macOS /usr/bin/git is only a placeholder until Apple's developer tools
// are installed, and running it opens an "install developer tools" window.
// Use a real Git program there, or report Git as unavailable without a popup.
const MAC_GITS = Object.freeze(['/Library/Developer/CommandLineTools/usr/bin/git',
  '/Applications/Xcode.app/Contents/Developer/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'])
async function gitProgram(platform, fsImpl) {
  // Windows: Git details are not read yet (its Git lives in other places and
  // needs its own safe settings). Folder, version and Python facts still are.
  if (platform === 'win32') return null
  if (platform !== 'darwin') return '/usr/bin/git'
  for (const candidate of MAC_GITS) {
    try { await fsImpl.access(candidate, constants.X_OK); return candidate } catch { /* Try the next known location. */ }
  }
  return null
}

async function inspectInstallation({ path: requestedPath, signal, assertCurrent, fsImpl = fs, spawnImpl = spawn, platform = process.platform, limits: overrides = {} }) {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath) || requestedPath.includes('\0')) {
    throw fault('INVALID_ARGUMENTS', 'Inspect an absolute installation directory obtained from setup or the user; do not guess a path.')
  }
  if (typeof assertCurrent !== 'function') throw new TypeError('Native computer authority is required for installation inspection.')
  const limits = { ...LIMITS, ...overrides }
  const authorize = async () => {
    checkAbort(signal)
    if (await abortable(Promise.resolve().then(assertCurrent), signal) === false) throw fault('UNAUTHORIZED', 'Computer access is no longer authorized.')
    checkAbort(signal)
  }
  await authorize()
  let root
  try { root = await fsImpl.realpath(requestedPath) }
  catch (error) {
    await authorize()
    return { success: true, readOnly: true, path: requestedPath, state: error.code === 'ENOENT' ? 'missing' : 'unreadable',
      guidance: ['The installation directory could not be inspected. Confirm its actual location; do not update a guessed directory.'] }
  }
  await authorize()
  if (!(await fsImpl.stat(root)).isDirectory()) {
    return { success: true, readOnly: true, path: root, state: 'not-directory', guidance: ['Inspect the containing installation directory, not an executable or launcher file.'] }
  }

  // Fixed Git argv, never shell text. Override features which could execute
  // repository-supplied helpers; ignore global/system config and environment
  // injection. No network operation and no optional index/ref lock writes.
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_ATTR_NOSYSTEM: '1' }
  let gitPath
  const git = async args => {
    await authorize()
    if (gitPath === undefined) gitPath = await gitProgram(platform, fsImpl)
    const result = await new Promise((resolve, reject) => {
      let child, timer, output = Buffer.alloc(0), truncated = false, timedOut = false, unavailable = false, stopped = false
      const abort = () => { stopped = true; child?.kill('SIGKILL') }
      const finish = code => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort)
        if (stopped || signal?.aborted) { try { checkAbort(signal) } catch (error) { reject(error); return } }
        resolve({ code, stdout: output.toString('utf8'), truncated, timedOut, unavailable })
      }
      try {
        if (!gitPath) throw Error('No Git program is installed.')
        child = spawnImpl(gitPath, ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false',
          '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', '-c', 'core.preloadIndex=false',
          '-c', 'core.attributesFile=/dev/null', '-c', 'color.ui=false', '-C', root, ...args],
        { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false })
      } catch { unavailable = true; finish(null); return }
      child.stdout.on('data', chunk => {
        const remaining = limits.outputBytes - output.length
        if (chunk.length > remaining) { truncated = true; child.kill('SIGKILL') }
        if (remaining > 0) output = Buffer.concat([output, chunk.subarray(0, remaining)])
      })
      child.stdout.on('error', () => { unavailable = true; child.kill('SIGKILL') })
      child.on('error', () => { unavailable = true })
      child.once('close', finish)
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, limits.commandMs)
      if (signal?.aborted) abort()
    })
    await authorize()
    return result
  }
  const markers = []
  const unreadableMarkers = []
  for (const relative of MARKERS) {
    await authorize()
    try {
      const value = await fsImpl.lstat(path.join(root, relative))
      markers.push({ path: relative, type: value.isDirectory() ? 'directory' : value.isSymbolicLink() ? 'symlink' : value.isFile() ? 'file' : 'other' })
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) unreadableMarkers.push(relative) }
  }
  const pythonCandidates = []
  for (const relative of PYTHONS) {
    await authorize()
    try { if ((await fsImpl.stat(path.join(root, relative))).isFile()) pythonCandidates.push({ path: path.join(root, relative), executed: false }) }
    catch { /* Presence is not usability; absence does not prove no external environment. */ }
  }
  let version = { state: 'not-observed', source: 'comfyui_version.py' }
  let handle
  try {
    await authorize()
    const versionPath = await fsImpl.realpath(path.join(root, 'comfyui_version.py'))
    if (!(await fsImpl.lstat(versionPath)).isFile()) throw Object.assign(Error('Not a regular version file.'), { code: 'NOT_REGULAR' })
    handle = await fsImpl.open(versionPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (stat.isFile() && stat.size <= limits.fileBytes) {
      const bytes = Buffer.alloc(limits.fileBytes + 1)
      const read = await handle.read(bytes, 0, bytes.length, 0)
      const match = read.bytesRead <= limits.fileBytes && bytes.subarray(0, read.bytesRead).toString('utf8').match(/^__version__\s*=\s*(['"])([A-Za-z0-9][A-Za-z0-9.+_-]{0,79})\1\s*(?:#.*)?$/m)
      version = match ? { state: 'observed', value: match[2], source: 'comfyui_version.py', method: 'literal-data-only' }
        : { state: 'not-literal', source: 'comfyui_version.py' }
    } else version = { state: 'unreadable-or-oversize', source: 'comfyui_version.py' }
  } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) version.state = 'unreadable' }
  finally { await handle?.close() }
  await authorize()
  const observations = { markers, unreadableMarkers, pythonCandidates,
    pythonNote: 'Paths were observed, not executed. An external Conda/uv/system environment may be configured in the launcher; do not assume an active shell environment.' }
  const result = { success: true, readOnly: true, path: root, state: 'directory', version, observations, git: {}, guidance: [] }
  const workTree = await git(['rev-parse', '--is-inside-work-tree'])
  if (!present(workTree) || workTree.stdout.trim() !== 'true') {
    const bare = present(workTree) && await git(['rev-parse', '--is-bare-repository'])
    result.git = { state: bare && present(bare) && bare.stdout.trim() === 'true' ? 'bare-repository'
      : workTree.unavailable ? 'git-unavailable' : workTree.timedOut || workTree.truncated ? 'inspection-incomplete' : 'not-worktree-or-unreadable' }
    result.guidance.push('No usable Git worktree was established. This may be an archive, managed desktop/portable/container installation, or an inaccessible repository. Inspect the launcher/install method; do not run git pull or initialize a replacement repository.')
    return result
  }
  const top = await git(['rev-parse', '--show-toplevel'])
  let gitRoot = present(top) ? top.stdout.trim() : null
  try { if (gitRoot) gitRoot = await fsImpl.realpath(gitRoot) } catch { gitRoot = null }
  result.git = { state: 'repository', root: gitRoot, rootMatchesTarget: gitRoot === root }
  if (gitRoot !== root) {
    result.git.state = gitRoot ? 'parent-repository' : 'inspection-incomplete'
    result.guidance.push('The inspected directory is not the repository root. Do not update the parent project as if it were this installation. Locate the actual software root or its managed updater.')
    return result
  }
  const head = await git(['rev-parse', '--verify', 'HEAD'])
  const branch = await git(['symbolic-ref', '-q', 'HEAD'])
  const shallow = await git(['rev-parse', '--is-shallow-repository'])
  const refs = await git(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(*objectname)%09%(upstream)%09%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags'])
  const config = await git(['config', '--local', '--no-includes', '--get-regexp', '^remote[.].*[.]fetch$'])
  const headTags = present(head) ? await git(['for-each-ref', '--points-at=HEAD', '--format=%(refname)', 'refs/tags']) : null
  const upstream = present(branch) ? await git(['rev-parse', '--symbolic-full-name', '@{upstream}']) : null
  // Even porcelain status can invoke clean/process filters from .gitattributes.
  // Inspect effective CONFIG NAMES only (including local includes), never their
  // values. If any filter exists, or detection is uncertain, leave changes
  // unknown rather than execute installation-supplied code for an inspection.
  const filters = await git(['config', '--includes', '--name-only', '--get-regexp', '^filter[.].*[.](clean|smudge|process)$'])
  const filtersAbsent = filters.code === 1 && !filters.truncated && !filters.timedOut && !filters.unavailable
  const status = filtersAbsent ? await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'])
    : { code: null, stdout: '', skipped: 'content-filters-or-unknown-config' }
  const refLines = lines(refs.stdout)
  const refValues = refLines.slice(0, limits.entries).map(line => {
    const [name, sha, peeled, upstream, symbolicTarget] = line.split('\t')
    return { name: refName(name), objectId: objectId(sha), peeledObjectId: objectId(peeled), upstream: refName(upstream), symbolicTarget: refName(symbolicTarget) }
  }).filter(value => value.name && value.objectId)
  const headId = present(head) ? objectId(head.stdout.trim()) : null
  const branchValue = present(branch) ? refName(branch.stdout.trim()) : null
  const branchRef = branchValue?.startsWith('refs/heads/') ? branchValue : null
  const detached = branch.code === 1 && !branch.timedOut && !branch.truncated && !branch.unavailable
  const configLines = lines(config.stdout)
  const fetchValues = configLines.slice(0, limits.entries).map(line => {
    const split = line.indexOf(' '), key = line.slice(0, split), value = line.slice(split + 1)
    // Return only actual refspec syntax, never arbitrary local config values,
    // URLs, credentials, helper commands or included configuration contents.
    return { key: /^remote\.[A-Za-z0-9_.-]+\.fetch$/.test(key) ? key : 'remote.[nonstandard-name].fetch',
      value: /^\+?refs\/[A-Za-z0-9_.*\/-]+:refs\/[A-Za-z0-9_.*\/-]+$/.test(value) || /^\^refs\/[A-Za-z0-9_.*\/-]+$/.test(value) ? value : '[nonstandard-refspec]' }
  })
  const tokens = status.stdout.split('\0').filter(Boolean)
  const samples = []; let trackedCount = 0, untrackedCount = 0
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], code = token.slice(0, 2)
    if (code === '??') untrackedCount++; else trackedCount++
    if (samples.length < limits.entries) samples.push({ code, path: token.slice(3) })
    if (/[RC]/.test(code)) index++ // Porcelain -z rename/copy has a second path.
  }
  const statusComplete = present(status)
  const tagLines = lines(headTags?.stdout)
  const tagsAtHead = tagLines.slice(0, limits.entries).filter(value => refName(value) && value.startsWith('refs/tags/')).map(value => value.slice(10))
  const refsComplete = present(refs) && refLines.length <= limits.entries && refValues.length === refLines.length
  const unborn = branchRef && head.code === 128 && !head.timedOut && !head.truncated && refsComplete && !refValues.some(value => value.name === branchRef)
  Object.assign(result.git, { head: headId, branch: branchRef && branchRef.slice('refs/heads/'.length),
    checkout: headId ? branchRef ? 'branch' : detached ? tagsAtHead.length ? 'detached-tag' : 'detached' : 'unknown' : unborn ? 'unborn' : 'unknown',
    tagsAtHead, tagsAtHeadComplete: Boolean(present(headTags) && tagLines.length <= limits.entries && tagsAtHead.length === tagLines.length),
    upstream: present(upstream) ? refName(upstream.stdout.trim()) : null,
    shallow: present(shallow) ? shallow.stdout.trim() === 'true' : null,
    refs: { values: refValues, complete: refsComplete },
    fetchRefspecs: { values: fetchValues, complete: (present(config) || config.code === 1 && !config.truncated && !config.timedOut) && configLines.length <= limits.entries,
      includesRead: false, scope: 'direct-local-config-only', effectiveConfigurationVerified: false },
    changes: { state: !statusComplete ? 'unknown' : tokens.length ? 'dirty' : 'clean', trackedCount, untrackedCount,
      samples, complete: statusComplete && trackedCount + untrackedCount <= limits.entries, submodulesInspected: false,
      ...(status.skipped ? { inspectionSkipped: status.skipped } : {}) },
    networkChecked: false })
  if (!headId) result.guidance.push('No verified HEAD commit. Do not choose a pull/checkout/reset command until the repository state is understood.')
  if (detached) result.guidance.push('Detached/release checkout: do not assume main, master, origin/HEAD or a tracking branch exists. Identify the intended release/channel and verified remote before fetching a specific ref.')
  else if (!branchRef) result.guidance.push('The current branch could not be established. Do not treat an incomplete branch check as proof of a detached checkout.')
  if (!result.git.upstream) result.guidance.push('No upstream was observed. A plain git pull is not an established update method here.')
  if (fetchValues.length && fetchValues.every(value => value.value !== '[nonstandard-refspec]') && !fetchValues.some(value => /refs\/heads\//.test(value.value))) result.guidance.push('The direct local fetch entries shown here do not include branch refs. A plain git fetch may only refresh pinned tags; it does not prove newer releases were discovered.')
  result.guidance.push('Fetch refspecs above are direct local entries only; included configuration was not expanded for their values. Verify the effective mapping and remote identity before selecting an update source.')
  if (result.git.changes.state !== 'clean') result.guidance.push('Preserve local edits, untracked files and custom nodes. An incomplete check is not proof of a clean checkout; do not reset/clean/stash blindly.')
  if (status.skipped) result.guidance.push('Worktree content inspection was skipped because Git content filters are configured or their absence could not be verified. Such filters can execute installation code. Changes remain unknown; this does not restrict the separately authorized computer tools.')
  result.guidance.push('These are local observations, not a selected update plan or proof of latest release/runtime health. Verify remote identity/release compatibility and the configured Python/launcher before changes; afterwards verify source version, dependencies and running server independently.')
  await authorize()
  return result
}

module.exports = { MAC_GITS, LIMITS, MARKERS, PYTHONS, inspectInstallation }
