'use strict'
// The host's own choices for the Velorn network, and what this computer could
// offer right now. Sharing is OFF until the person switches it on, and even then
// nothing here accepts a job: this module only keeps the settings and answers
// "what would I offer, and am I idle?". The connection to the network's queue is
// a later step and will read these settings; it cannot widen them.
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { listApproved, getApproved } = require('./gpuShareWorkflows.cjs')

const LIMITS = Object.freeze({ invited: 50, email: 254, displayName: 40, everyoneTotalMax: 200, dailyMin: 1, dailyMax: 10, fileBytes: 64 * 1024 })
// The memory sizes graphics cards are sold in.
const GPU_SIZES = Object.freeze([2, 4, 6, 8, 10, 11, 12, 16, 20, 24, 32, 48, 80])
const DEFAULTS = Object.freeze({ version: 1, enabled: false, allowedWorkflows: Object.freeze([]), invited: Object.freeze([]), askBeforeEach: true, dailyLimitPerPerson: 2, displayName: '',
  // Open to everyone: off until the owner switches it on, with a limit per person and for the whole computer per day.
  everyone: Object.freeze({ enabled: false, perPerson: 2, total: 20 }) })
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = message => Object.assign(new Error(message), { code: 'GPU_SHARE_SETTINGS_INVALID', publicMessage: message })
// An invited person is named by the email of their Velorn account.
const email = value => typeof value === 'string' && value.length <= LIMITS.email && /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[A-Za-z]{2,}$/.test(value)

// Returns a complete, checked settings object. Unknown keys and values are refused, not ignored.
function normalizeSettings(input) {
  if (!plain(input)) throw invalid('The sharing settings could not be read.')
  const keys = ['version', 'enabled', 'allowedWorkflows', 'invited', 'askBeforeEach', 'dailyLimitPerPerson', 'displayName', 'everyone']
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw invalid('The sharing settings hold something this Velorn does not know.')
  const value = { ...DEFAULTS, ...input }
  if (value.version !== 1 || typeof value.enabled !== 'boolean' || typeof value.askBeforeEach !== 'boolean') throw invalid('The sharing settings could not be read.')
  if (!Array.isArray(value.allowedWorkflows) || value.allowedWorkflows.some(id => !getApproved(id))) throw invalid('Only workflows on the Velorn network list can be shared.')
  if (!Array.isArray(value.invited) || value.invited.length > LIMITS.invited) throw invalid(`Up to ${LIMITS.invited} people can be invited.`)
  const invited = [...new Set(value.invited.map(item => typeof item === 'string' ? item.trim().toLowerCase() : item))]
  if (invited.some(item => !email(item))) throw invalid('Invite people by the email of their Velorn account.')
  if (!Number.isInteger(value.dailyLimitPerPerson) || value.dailyLimitPerPerson < LIMITS.dailyMin || value.dailyLimitPerPerson > LIMITS.dailyMax) throw invalid(`The daily limit is ${LIMITS.dailyMin} to ${LIMITS.dailyMax} jobs per person.`)
  // The name people see on this owner's own workflows. Their choice; never the account's email or the computer's name.
  if (typeof value.displayName !== 'string' || value.displayName.length > 200) throw invalid('That name could not be saved.')
  const displayName = value.displayName.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.displayName)
  const everyone = { ...DEFAULTS.everyone, ...(plain(value.everyone) ? value.everyone : { bad: true }) }
  if (Object.keys(everyone).length !== 3 || typeof everyone.enabled !== 'boolean' || !Number.isInteger(everyone.perPerson) || everyone.perPerson < LIMITS.dailyMin || everyone.perPerson > LIMITS.dailyMax
    || !Number.isInteger(everyone.total) || everyone.total < 1 || everyone.total > LIMITS.everyoneTotalMax) throw invalid('The choices for opening to everyone could not be read.')
  return { version: 1, enabled: value.enabled, allowedWorkflows: [...new Set(value.allowedWorkflows)].sort(), invited: invited.sort(),
    askBeforeEach: value.askBeforeEach, dailyLimitPerPerson: value.dailyLimitPerPerson, displayName, everyone: { enabled: everyone.enabled, perPerson: everyone.perPerson, total: everyone.total } }
}

function createGpuShareHost({ settingsPath, runner, getEndpoint, isExportBusy = () => false, fetchImpl = globalThis.fetch, getOwn = () => null } = {}) {
  if (!path.isAbsolute(settingsPath || '') || typeof runner?.capability !== 'function' || typeof getEndpoint !== 'function') throw new TypeError('GPU sharing needs a settings file, the job runner and the ComfyUI address.')
  let cached = null, writing = Promise.resolve()

  async function getSettings() {
    if (cached) return { ...cached, allowedWorkflows: [...cached.allowedWorkflows], invited: [...cached.invited], everyone: { ...cached.everyone } }
    try {
      const raw = await fs.readFile(settingsPath, 'utf8')
      if (Buffer.byteLength(raw) > LIMITS.fileBytes) throw new Error('too large')
      cached = normalizeSettings(JSON.parse(raw))
    } catch (error) {
      // No file is the normal first run. A damaged file never switches sharing on.
      cached = normalizeSettings({})
      if (error?.code !== 'ENOENT') cached.unreadable = true
    }
    return getSettings()
  }
  // `patch` holds only what changes. The result is checked as a whole before it is saved.
  function updateSettings(patch) {
    const run = writing.then(async () => {
      if (!plain(patch)) throw invalid('The sharing settings could not be read.')
      const { unreadable, ...current } = await getSettings()
      const next = normalizeSettings({ ...current, ...patch })
      await fs.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 })
      const temporary = `${settingsPath}.${randomBytes(6).toString('hex')}.tmp`
      try { await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, settingsPath) }
      catch (error) { await fs.unlink(temporary).catch(() => {}); throw error }
      cached = next
      return getSettings()
    })
    writing = run.catch(() => {})
    return run
  }

  // Is the GPU free for someone else's job right now? Every reason it is not is listed.
  async function idle() {
    const reasons = []
    if (isExportBusy()) reasons.push('An export is running.')
    let comfy = false
    try {
      const base = new URL(await getEndpoint()).origin
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000)
      try {
        const response = await fetchImpl(`${base}/queue`, { signal: controller.signal, redirect: 'error' })
        const queue = response.ok ? await response.json() : null
        comfy = plain(queue)
        if (comfy && ((queue.queue_running?.length || 0) + (queue.queue_pending?.length || 0)) > 0) reasons.push('ComfyUI is working on something.')
      } finally { clearTimeout(timer) }
    } catch { comfy = false }
    if (!comfy) reasons.push('ComfyUI is not running.')
    return { idle: reasons.length === 0, comfyRunning: comfy, reasons }
  }

  // This computer's graphics card as ComfyUI sees it, with its memory as the size
  // it is sold as (a "32 GB" card reports a little less). null when ComfyUI is not running.
  async function gpu() {
    try {
      const base = new URL(await getEndpoint()).origin
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000)
      try {
        const response = await fetchImpl(`${base}/system_stats`, { signal: controller.signal, redirect: 'error' })
        const device = response.ok ? (await response.json())?.devices?.find(item => plain(item) && Number.isFinite(item.vram_total) && item.vram_total > 0) : null
        if (!device) return null
        const gib = device.vram_total / 2 ** 30
        const memoryGb = GPU_SIZES.reduce((best, size) => Math.abs(size - gib) < Math.abs(best - gib) ? size : best)
        const name = String(device.name || '').replace(/^[a-z]+:\d+\s+/i, '').replace(/\s+:\s+.*$/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
        return { name: name || 'Graphics card', memoryGb }
      } finally { clearTimeout(timer) }
    } catch { return null }
  }

  async function status() {
    const settings = await getSettings()
    const state = await idle()
    const card = state.comfyRunning ? await gpu() : null
    // Velorn no longer offers workflows of its own (Jaime, 2026-11-16): owners share the ones they add themselves.
    // The built-in bindings in gpuShareWorkflows.cjs stay for a job that names one, but none is listed or offered here.
    const offers = []
    // The owner's own workflows they chose to share, as far as they still run here.
    const ownOffering = []
    const own = settings.enabled && state.comfyRunning ? getOwn() : null
    if (own) for (const item of await own.offered().catch(() => [])) if ((await runner.capability(item.id)).ok === true) ownOffering.push({ id: item.id, name: item.name, shape: item.shape, ...(item.fingerprint ? { fingerprint: item.fingerprint } : {}) })
    return { success: true, settings, ...state, gpu: card, offers, ownOffering,
      // What would be offered to the network: switched on, allowed by the person, and runnable here.
      offering: settings.enabled ? ownOffering.map(item => item.id) : [],
      // Replaced by the live connection's own account when there is one.
      network: { connected: false, note: 'Not connected to the Velorn network.' } }
  }

  return { getSettings, updateSettings, status, idle }
}

// Only the main Velorn window may read or change these. A change needs a real click (checked in the preload).
function registerGpuShareIpc({ ipcMain, getMainWindow, host, getNetworkState = null, onUpdated = () => {}, report = null, openJob = null }) {
  // Once this computer is connected to the queue, say what is really happening there.
  const withNetwork = result => { const live = typeof getNetworkState === 'function' ? getNetworkState() : null; return live && result?.success ? { ...result, network: live } : result }
  const channels = ['gpu-share:status', 'gpu-share:update', 'gpu-share:report', 'gpu-share:open-job']
  const allowed = event => {
    const window = getMainWindow()
    return Boolean(window && !window.isDestroyed() && event?.sender === window.webContents && event.senderFrame === window.webContents.mainFrame)
  }
  ipcMain.handle('gpu-share:status', async event => {
    if (!allowed(event)) return { success: false, error: 'Open GPU sharing in the main Velorn window.' }
    try { return withNetwork(await host.status()) } catch { return { success: false, error: 'GPU sharing could not be read.' } }
  })
  ipcMain.handle('gpu-share:update', async (event, patch) => {
    if (!allowed(event)) return { success: false, error: 'Open GPU sharing in the main Velorn window.' }
    try { await host.updateSettings(patch); try { await onUpdated() } catch { /* The next heartbeat catches up. */ } return withNetwork(await host.status()) }
    catch (error) { return { success: false, error: error?.publicMessage || 'That change could not be saved.' } }
  })
  // Report a job someone else sent to this computer. The window names only the job.
  ipcMain.handle('gpu-share:report', async (event, payload) => {
    if (!allowed(event)) return { success: false, error: 'Open GPU sharing in the main Velorn window.' }
    const jobId = payload && typeof payload === 'object' ? payload.jobId : null
    if (typeof report !== 'function' || typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(jobId)) return { success: false, error: 'That job could not be reported.' }
    try { await report(jobId); return withNetwork(await host.status()) }
    catch (error) { return { success: false, error: error?.publicMessage || 'That job could not be reported.' } }
  })
  // Show the picture and clip this computer kept of a job. The window names only the job.
  ipcMain.handle('gpu-share:open-job', async (event, payload) => {
    if (!allowed(event)) return { success: false, error: 'Open GPU sharing in the main Velorn window.' }
    const jobId = payload && typeof payload === 'object' ? payload.jobId : null
    if (typeof openJob !== 'function' || typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(jobId)) return { success: false, error: 'That job\'s files could not be opened.' }
    try { return (await openJob(jobId)) === true ? { success: true } : { success: false, error: 'This computer no longer has that job\'s files.' } }
    catch { return { success: false, error: 'That job\'s files could not be opened.' } }
  })
  return { dispose() { for (const channel of channels) ipcMain.removeHandler?.(channel) } }
}

module.exports = { createGpuShareHost, registerGpuShareIpc, normalizeSettings, DEFAULTS, LIMITS }
