'use strict'
// PAID check of Create's voice, sound and music models against the real Comfy Router.
//
// It prices every request on its list, prints the list and the total, and sends
// NOTHING that costs credits until you type "yes". Then it sends each request
// once (no retries), waits for it, saves the audio so you can listen, and
// records what Comfy charged. It stops at the first unclear outcome.
//
// It also notes WHERE a queued audio result is stored (host and first folder
// only, never the signed link), which Velorn needs before it will collect one.
//
// The key is read from a hidden prompt, kept in memory, and never written.
//   node scripts/check-create-audio.cjs <results.json> <output-folder>
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { createComfyRouter, RESULT_STORAGE, AUDIO_MAX, audioHeader } = require('../electron/comfyRouter.cjs')
const { getModel, listVoices } = require('../electron/createModels.cjs')

const [RESULTS, OUT_DIR] = process.argv.slice(2)
const BUDGET_USD = 0.5
const SHORT = 'Hello, this is a voice check for Velorn.'
const LONGER = 'Welcome back. Here is what changed while you were away, and what is ready for you to review.'
const PLAN = [
  ...listVoices({ unverified: true }).map(voice => ({ id: 'eleven-v4-turbo', choices: { prompt: SHORT, voice: voice.id }, note: `voice ${voice.name}` })),
  { id: 'eleven-v4', choices: { prompt: LONGER, voice: 'rachel' } },
  { id: 'eleven-sfx-v2', choices: { prompt: 'a wooden door creaking open', seconds: 3 } },
]
const SYNC_PATH = /^\/v2\/models\/elevenlabs\/[a-z0-9_]+$/
const RESULT_PATH = /^\/v2\/models\/[a-z0-9-]+\/[a-z0-9._-]+\/requests\/[^/]+$/

function ask(question, hidden) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    if (!input.isTTY) return reject(new Error('Run this in a terminal.'))
    if (!hidden) { const rl = readline.createInterface({ input, output: process.stdout }); return rl.question(question, answer => { rl.close(); resolve(answer.trim()) }) }
    process.stdout.write(question); input.setRawMode(true); input.resume(); input.setEncoding('utf8')
    let value = ''
    const onData = chunk => { for (const char of chunk) {
      if (char === '\r' || char === '\n') { input.setRawMode(false); input.pause(); input.removeListener('data', onData); process.stdout.write('\n'); return resolve(value.trim()) }
      if (char === '\u0003') { input.setRawMode(false); process.stdout.write('\n'); process.exit(130) }
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1); else value += char
    } }
    input.on('data', onData)
  })
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const label = item => `${getModel(item.id).name}${item.choices.seconds ? ` ${item.choices.seconds}s` : ''}${item.note ? ` (${item.note})` : ''}`

async function main() {
  if (!RESULTS || !OUT_DIR) throw new Error('Usage: check-create-audio.cjs <results.json> <output-folder>')
  await fs.mkdir(OUT_DIR, { recursive: true })
  const key = await ask('Paste your Comfy key (it will not show), then Enter: ', true)
  if (!key) { console.log('No key entered. Nothing was sent.'); return }
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-create-audio-'))
  let armed = false, paidPosts = 0, lastResultLink = null
  const sent = []
  const router = createComfyRouter({ storageDir, allowPending: true, getPolicy: async () => 'ask-cloud',
    getContext: async () => ({ session: 'audio-check', projectKey: path.join(storageDir, 'project') }),
    // The person approves the whole list once, in this terminal, before `armed` is set.
    confirmSpend: async () => armed,
    fetchImpl: async (url, options) => {
      const method = options.method || 'GET', target = new URL(url)
      const comfy = target.origin === 'https://api.comfy.org'
      const storage = target.origin === `https://${RESULT_STORAGE.host}` && target.pathname.startsWith(RESULT_STORAGE.prefix)
      const paid = comfy && method === 'POST' && (target.pathname.endsWith('/requests') || SYNC_PATH.test(target.pathname))
      const free = comfy && (method === 'GET' || method === 'POST' && target.pathname.endsWith('/estimate')) || storage && method === 'GET'
      if (!free && !paid) throw new Error(`Refused to send: ${method} ${target.origin}${target.pathname}`)
      if (paid && (!armed || ++paidPosts > PLAN.length)) throw new Error('Refused to send a paid request that was not on the approved list.')
      sent.push(`${method} ${target.origin}${target.pathname.replace(/\/requests\/.+$/, '/requests/…')}`)
      const response = await fetch(url, options)
      // Look at a finished queued result to learn where its audio is stored.
      if (comfy && method === 'GET' && RESULT_PATH.test(target.pathname) && response.ok) {
        try { const link = (await response.clone().json())?.output?.audio?.url; if (typeof link === 'string') lastResultLink = link } catch {}
      }
      return response
    } })
  const results = []
  const save = () => fs.writeFile(RESULTS, JSON.stringify({ requests: sent.length, paidRequests: paidPosts, results }, null, 1))
  try {
    const connected = await router.connect({ apiKey: key })
    if (!connected.success) { console.log(`Could not connect: ${connected.error}`); return }
    // 1. Prices for everything, then one question.
    let total = 0
    console.log('\nThese requests would be sent, once each:\n')
    for (const item of PLAN) {
      const plan = await router.previewCreate({ modelId: item.id, choices: item.choices })
      if (!plan.success) throw new Error(`${label(item)}: could not be prepared (${plan.code}: ${plan.error}). Nothing was sent.`)
      if (!plan.estimate) throw new Error(`${label(item)}: no price to budget with. Nothing was sent.`)
      item.usd = plan.estimate.usd; item.priced = plan.estimate.basis === 'live' ? 'quoted' : 'recorded'
      total += item.usd
      console.log(`  ${label(item).padEnd(46)} $${item.usd.toFixed(4)}  ${item.priced}`)
    }
    console.log(`\n  ${PLAN.length} requests, about $${total.toFixed(2)} in Comfy credits. Budget limit for this run: $${BUDGET_USD.toFixed(2)}.`)
    if (total > BUDGET_USD) { console.log('That is over the limit. Nothing was sent.'); return }
    const answer = await ask('\nType yes to send them, or anything else to stop: ')
    if (answer.toLowerCase() !== 'yes') { console.log('Stopped. Nothing was sent.'); return }
    armed = true
    // 2. One at a time, no retries.
    for (const [index, item] of PLAN.entries()) {
      const row = { request: label(item), model: item.id, voice: item.choices.voice || null, expectedUsd: item.usd, priced: item.priced }
      results.push(row)
      process.stdout.write(`\n[${index + 1}/${PLAN.length}] ${row.request} … `)
      const plan = await router.previewCreate({ modelId: item.id, choices: item.choices })
      if (!plan.success) { row.outcome = 'not sent'; row.error = plan.code; console.log(`not sent (${plan.code})`); continue }
      const submitted = await router.submit({ planId: plan.planId })
      if (!submitted.success) {
        row.outcome = submitted.code === 'COMFY_ROUTER_UNCERTAIN' ? 'unclear' : 'refused'; row.error = submitted.code; row.diagnostics = submitted.diagnostics || null
        console.log(`${row.outcome} (${submitted.code}${submitted.diagnostics ? ` · HTTP ${submitted.diagnostics.httpStatus} ${submitted.diagnostics.errorType || ''}` : ''})`)
        if (row.outcome === 'unclear') { console.log('Stopping: an unclear outcome must be checked on your Comfy usage page before anything else is sent.'); break }
        continue
      }
      let job = submitted.job
      const started = Date.now(), deadline = started + 12 * 60000
      while (!['COMPLETED', 'FAILED', 'CANCELLED', 'UNCERTAIN'].includes(job.status) && Date.now() < deadline) {
        await wait(job.status === 'SUBMITTING' ? 500 : Math.max(3000, Math.min(job.retryAfterMs || 0, 15000)))
        const refreshed = await router.refresh({ jobId: job.jobId })
        if (refreshed.success) job = refreshed.job; else row.lastRefreshError = refreshed.code
      }
      row.status = job.status; row.jobError = job.errorType || null; row.diagnostics = job.diagnostics || null; row.seconds = Math.round((Date.now() - started) / 100) / 10
      row.chargedCredits = job.chargedCredits ?? null; row.chargedUsd = job.chargedUsd ?? null
      if (job.status === 'UNCERTAIN') { row.outcome = 'unclear'; console.log('unclear'); await save(); console.log('Stopping: an unclear outcome must be checked on your Comfy usage page before anything else is sent.'); break }
      if (job.status !== 'COMPLETED') {
        row.outcome = job.status === 'FAILED' ? 'failed' : 'not finished'
        console.log(`${row.outcome} (${job.diagnostics ? `HTTP ${job.diagnostics.httpStatus} ${job.diagnostics.errorType || ''}` : job.errorType || job.status})`); await save(); continue
      }
      lastResultLink = null
      const output = await router.output({ jobId: job.jobId })
      const after = (await router.list({})).jobs.find(entry => entry.jobId === job.jobId) || job
      row.chargedCredits = after.chargedCredits ?? row.chargedCredits; row.chargedUsd = after.chargedUsd ?? row.chargedUsd
      let bytes = output.success ? Buffer.from(output.bytes) : null, extension = output.success ? output.filename.split('.').pop() : null
      if (!output.success && lastResultLink) {
        // Velorn itself would not follow this link yet. Note where it points, and fetch it here so it can be heard.
        try {
          const link = new URL(lastResultLink)
          row.resultAddress = { protocol: link.protocol, host: link.hostname, firstFolder: link.pathname.split('/').slice(0, 2).join('/') + '/', queryNames: [...link.searchParams.keys()].sort() }
          if (link.protocol === 'https:') {
            const response = await fetch(link, { redirect: 'error', credentials: 'omit' })
            const data = response.ok && !(Number(response.headers.get('content-length')) > AUDIO_MAX) ? Buffer.from(await response.arrayBuffer()) : null
            const header = data && data.length <= AUDIO_MAX ? audioHeader(data) : null
            row.resultFetch = { httpStatus: response.status, contentType: response.headers.get('content-type'), recognised: Boolean(header) }
            if (header) { bytes = data; extension = header.extension }
          }
        } catch (error) { row.resultFetch = { error: String(error?.message || error).slice(0, 120) } }
      }
      if (!bytes) { row.outcome = 'made but not collected'; row.error = output.code; row.message = output.error; console.log(`made, but not collected (${output.code})`); await save(); continue }
      const file = path.join(OUT_DIR, `${String(index + 1).padStart(2, '0')}-${item.id}${item.choices.voice ? `-${item.choices.voice}` : ''}.${extension}`)
      await fs.writeFile(file, bytes)
      Object.assign(row, { outcome: output.success ? 'ok' : 'ok, collected by this check only', file: path.basename(file), bytes: bytes.length, mimeType: output.mimeType || null })
      console.log(`${row.outcome} · ${(bytes.length / 1024).toFixed(0)} KB · ${row.seconds}s · charged ${row.chargedUsd == null ? 'not reported' : '$' + row.chargedUsd.toFixed(4)}`)
      await save()
    }
  } finally {
    await save().catch(() => {})
    router.dispose(); await fs.rm(storageDir, { recursive: true, force: true })
  }
  const charged = results.reduce((sum, row) => sum + (row.chargedUsd || 0), 0)
  console.log(`\nDone. ${paidPosts} paid requests were sent. Comfy reported $${charged.toFixed(2)} charged in total.`)
  console.log(`The audio is in ${OUT_DIR} if you want to listen. You can close this tab.`)
}
main().catch(error => { console.error(`\n${error.message}`); process.exitCode = 1 })
