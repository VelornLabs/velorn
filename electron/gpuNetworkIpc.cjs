'use strict'
// "Run on Velorn network" for the main Velorn window: list the computers this
// account may use, send one job, follow it, bring the clip back. The window
// names a computer, a workflow from Velorn's own list, the choices and a
// picture; it never names an address, a path or a credential.
//
// The one job in flight is remembered in a small file so it can still be
// collected after Velorn restarts.
const fs = require('node:fs/promises')
const path = require('node:path')

const CHANNELS = ['gpu-network:hosts', 'gpu-network:send', 'gpu-network:current', 'gpu-network:cancel', 'gpu-network:collect', 'gpu-network:forget', 'gpu-network:report-workflow']
const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// How the window wants to name a job it sent (an owner's own workflow has no name Velorn knows): display only.
const shownAs = value => ({ ...(/^[a-f0-9]{32}$/.test(value?.hostId || '') ? { hostId: value.hostId } : {}), ...(typeof value?.label === 'string' && value.label.trim() ? { label: value.label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) } : {}),
  ...(['image', 'video', 'music'].includes(value?.kind) ? { kind: value.kind } : {}) })

// The one job this account has on the network, for whoever sends and follows it: the main window
// (through the channels below) and the paired phone (mobileCompanionSharedGpu.cjs). `on(listener)`
// tells what happened to it: { type: 'sent' | 'state' | 'collected' | 'forgotten' | 'lost', ... }.
function createGpuNetworkJobs({ client, jobPath, now = Date.now }) {
  if (!path.isAbsolute(jobPath || '')) throw new TypeError('The Velorn network needs a place to remember its job.')
  let active, sending = false // undefined until read; then { jobId, hostName, workflowId, prompt, sentAt } or null
  const listeners = new Set()
  const tell = event => { for (const listener of [...listeners]) { try { listener(event) } catch { /* A listener's own trouble. */ } } }
  async function read() {
    if (active !== undefined) return active
    try {
      const value = JSON.parse(await fs.readFile(jobPath, 'utf8'))
      // A job older than the queue keeps anything is forgotten here too.
      active = plain(value) && JOB_ID.test(value.jobId || '') && Number.isFinite(value.sentAt) && now() - value.sentAt < 70 * 60_000
        ? { jobId: value.jobId, hostName: String(value.hostName || 'A Velorn computer').slice(0, 80), workflowId: String(value.workflowId || '').slice(0, 41), prompt: String(value.prompt || '').slice(0, 2000), sentAt: value.sentAt, ...shownAs(value),
          ...(value.fromPhone === true ? { fromPhone: true } : {}) } : null
    } catch { active = null }
    return active
  }
  async function remember(value) {
    active = value
    try {
      if (value) { await fs.mkdir(path.dirname(jobPath), { recursive: true, mode: 0o700 }); await fs.writeFile(jobPath, `${JSON.stringify(value)}\n`, { mode: 0o600 }) }
      else await fs.unlink(jobPath)
    } catch { /* Remembered for this run of Velorn at least. */ }
  }
  return {
    on(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    hosts: () => client.listHosts(),
    // `fromPhone` marks a job the paired phone asked for, so the phone can be shown how it ends.
    async send({ hostId, hostName, workflowId, choices, image, label, kind, fromPhone } = {}) {
      if (sending || await read()) throw Object.assign(new Error('busy'), { code: 'GPU_NETWORK_ONE_AT_A_TIME', publicMessage: 'You already have a job on the Velorn network. Wait for it to finish.' })
      // A text to picture job comes without a picture; whether one is needed is the workflow's own rule, checked when it is sent.
      if (image != null && (!plain(image) || typeof image.mimeType !== 'string' || !(image.bytes instanceof Uint8Array) || image.bytes.byteLength > 10 * 1024 * 1024)) throw Object.assign(new Error('picture'), { publicMessage: 'Choose a PNG, JPEG or WebP picture up to 10 MB.' })
      sending = true
      try {
        const sent = await client.submit({ hostId, workflowId, choices, image: image == null ? null : { mimeType: image.mimeType, bytes: Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength) } })
        await remember({ jobId: sent.jobId, hostId, hostName: String(hostName || 'A Velorn computer').slice(0, 80), workflowId, prompt: String(choices?.prompt || '').slice(0, 2000), sentAt: now(), ...shownAs({ label, kind }),
          ...(fromPhone === true ? { fromPhone: true } : {}) })
        tell({ type: 'sent', job: active })
        return { job: active }
      } finally { sending = false }
    },
    // The job in flight and where it stands, or { job: null }.
    async current() {
      const job = await read()
      if (!job) return { job: null }
      try { const state = await client.jobStatus(job.jobId); tell({ type: 'state', job, state }); return { job, state } }
      catch (error) {
        // The queue no longer knows it: nothing left to wait for.
        if (error?.code === 'GPU_NETWORK_NOT_FOUND') { await remember(null); tell({ type: 'lost', job }); return { job: null, lost: job } }
        throw error
      }
    },
    async cancel() {
      const job = await read()
      if (!job) return { job: null }
      return { job, ...(await client.cancel(job.jobId)) }
    },
    // The finished clip or picture. The job stays on the network until forget().
    async collect() {
      const job = await read()
      if (!job) throw Object.assign(new Error('none'), { publicMessage: 'There is no finished job to collect.' })
      const clip = await client.collect(job.jobId, { keep: true })
      tell({ type: 'collected', job, clip })
      return { job, filename: clip.filename, mimeType: clip.mimeType, bytes: new Uint8Array(clip.bytes) }
    },
    // Called once the clip is safely in the project, or to dismiss a job that failed.
    async forget() {
      const job = await read()
      if (job) { await client.forget(job.jobId); await remember(null); tell({ type: 'forgotten', job }) }
      return { job: null }
    },
    reportWorkflow: ({ hostId, workflowId } = {}) => client.reportWorkflow({ hostId, workflowId }),
  }
}

function registerGpuNetworkIpc({ ipcMain, getMainWindow, client, jobPath, now = Date.now, jobs = createGpuNetworkJobs({ client, jobPath, now }) }) {
  const allowed = event => {
    const window = getMainWindow()
    return Boolean(window && !window.isDestroyed() && event?.sender === window.webContents && event.senderFrame === window.webContents.mainFrame)
  }
  const failed = (error, fallback) => ({ success: false, code: typeof error?.code === 'string' ? error.code : 'GPU_NETWORK_FAILED', error: error?.publicMessage || fallback })
  const handle = (channel, fallback, action) => ipcMain.handle(channel, async (event, payload) => {
    if (!allowed(event)) return { success: false, error: 'Open the Velorn network in the main Velorn window.' }
    try { return { success: true, ...(await action(plain(payload) ? payload : {})) } } catch (error) { return failed(error, fallback) }
  })
  // A job the phone sent is followed and saved by the window like any other: tell it there is one.
  const stop = jobs.on(event => {
    if (event.type !== 'sent' || event.job?.fromPhone !== true) return
    const window = getMainWindow()
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('gpu-network:changed')
  })

  handle('gpu-network:hosts', 'The Velorn network could not be reached.', () => jobs.hosts())
  // The window never marks a job as the phone's.
  handle('gpu-network:send', 'The job could not be sent.', ({ hostId, hostName, workflowId, choices, image, label, kind }) => jobs.send({ hostId, hostName, workflowId, choices, image, label, kind }))
  handle('gpu-network:current', 'The job could not be followed.', () => jobs.current())
  handle('gpu-network:cancel', 'The job could not be cancelled.', () => jobs.cancel())
  // Hands the finished clip to the window, which saves it into the open project.
  handle('gpu-network:collect', 'The clip could not be collected.', () => jobs.collect())
  handle('gpu-network:forget', 'The job could not be cleared.', () => jobs.forget())
  // The person who used a creator's workflow says it is not what it claims.
  handle('gpu-network:report-workflow', 'That could not be reported.', ({ hostId, workflowId }) => jobs.reportWorkflow({ hostId, workflowId }))
  return { dispose() { stop(); for (const channel of CHANNELS) ipcMain.removeHandler?.(channel) } }
}

module.exports = { registerGpuNetworkIpc, createGpuNetworkJobs, CHANNELS }
