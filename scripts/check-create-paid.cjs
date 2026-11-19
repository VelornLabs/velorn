'use strict'
// PAID check of the Create connection against the real Comfy Router.
//
// It gets a free quote for every request on its list, prints the list and the
// total, and sends NOTHING that costs credits until you type "yes". Then it
// sends each request once (no retries), waits for it, collects the result, and
// records what Comfy charged. It stops at the first unclear outcome.
//
// The key is read from a hidden prompt, kept in memory, and never written.
//   node scripts/check-create-paid.cjs <results.json> <output-folder> <input-picture.png> [only]
// `only` is an optional comma-separated list of positions in the list below (1 = first),
// or @file.json naming a list of your own: [{ "id": "flux-3-image", "choices": { "prompt": "..." }, "note": "..." }].
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { createComfyRouter, RESULT_STORAGE } = require('../electron/comfyRouter.cjs')
const { getModel, fallbackPrice } = require('../electron/createModels.cjs')

const [RESULTS, OUT_DIR, PICTURE, ONLY] = process.argv.slice(2)
const BUDGET_USD = 5
const TEXT = 'A red fox trotting through a snowy pine forest, cinematic lighting'
const CLIP = 'The fox turns its head and trots forward as snow falls gently'
const EDIT = 'Make it night time, with a full moon and soft blue light'
// `guess` is used for the budget only where neither Comfy nor the record has a price.
const FULL_PLAN = [
  { id: 'nano-banana-pro', choices: { prompt: TEXT } },
  { id: 'nano-banana-2', choices: { prompt: TEXT } },
  { id: 'seedream-5-0-pro', choices: { prompt: TEXT } },
  { id: 'seedream-5-0-flash', choices: { prompt: TEXT } },
  { id: 'seedream-4-0', choices: { prompt: TEXT } },
  { id: 'seedream-4-0', choices: { prompt: TEXT, size: '4K' }, note: '4K size and file limit' },
  { id: 'flux-3-image', choices: { prompt: TEXT } },
  { id: 'gpt-image-2-5', choices: { prompt: TEXT, size: '4K', shape: 'square' }, note: '4K square size' },
  { id: 'seedream-5-0-flash', choices: { prompt: EDIT }, picture: true, note: 'edit a picture' },
  { id: 'gpt-image-2-5', choices: { prompt: EDIT }, picture: true, guess: 0.04, note: 'edit a picture' },
  { id: 'nano-banana-2-1', choices: { prompt: EDIT }, picture: true, note: 'edit a picture' },
  { id: 'flux-3-image', choices: { prompt: EDIT }, picture: true, note: 'edit a picture' },
  { id: 'seedance-2-0-fast', choices: { prompt: CLIP, seconds: 4 } },
  { id: 'seedance-2-0', choices: { prompt: CLIP, seconds: 4 } },
  { id: 'seedance-2-5', choices: { prompt: CLIP, seconds: 4, pictureUse: 'start' }, picture: true, note: 'clip started from a picture' },
  { id: 'seedance-2-0-mini', choices: { prompt: CLIP, seconds: 4, pictureUse: 'start' }, picture: true, note: 'clip started from a picture' },
]
const custom = ONLY && ONLY.startsWith('@') ? JSON.parse(require('node:fs').readFileSync(ONLY.slice(1), 'utf8')) : null
if (custom && (!Array.isArray(custom) || !custom.length || custom.length > 20 || custom.some(item => !getModel(item?.id) || typeof item.choices?.prompt !== 'string'))) throw new Error('The list file is not valid.')
const wanted = ONLY && !custom ? ONLY.split(',').map(Number) : null
if (wanted && wanted.some(n => !Number.isInteger(n) || n < 1 || n > FULL_PLAN.length)) throw new Error('Unknown position in the list.')
const PLAN = custom || (wanted ? wanted.map(n => FULL_PLAN[n - 1]) : FULL_PLAN.slice(0, 15))

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
const label = item => `${getModel(item.id).name}${item.choices.size ? ` ${item.choices.size}` : ''}${item.choices.seconds ? ` ${item.choices.seconds}s` : ''}${item.note ? ` (${item.note})` : ''}`

async function main() {
  if (!RESULTS || !OUT_DIR || !PICTURE) throw new Error('Usage: check-create-paid.cjs <results.json> <output-folder> <input-picture>')
  const pictureBytes = await fs.readFile(PICTURE)
  const picture = { mimeType: 'image/png', base64: pictureBytes.toString('base64') }
  await fs.mkdir(OUT_DIR, { recursive: true })
  const sharp = require('sharp')
  const key = await ask('Paste your Comfy key (it will not show), then Enter: ', true)
  if (!key) { console.log('No key entered. Nothing was sent.'); return }
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-create-paid-'))
  let armed = false, paidPosts = 0
  const sent = []
  const router = createComfyRouter({ storageDir, getPolicy: async () => 'ask-cloud',
    getContext: async () => ({ session: 'paid-check', projectKey: path.join(storageDir, 'project') }),
    // The person approves the whole list once, in this terminal, before `armed` is set.
    confirmSpend: async () => armed,
    validateImage: async bytes => { const meta = await sharp(Buffer.from(bytes)).metadata(); await sharp(Buffer.from(bytes)).stats(); return { width: meta.width, height: meta.height } },
    fetchImpl: (url, options) => {
      const method = options.method || 'GET', target = new URL(url)
      const comfy = target.origin === 'https://api.comfy.org'
      const storage = target.origin === `https://${RESULT_STORAGE.host}` && target.pathname.startsWith(RESULT_STORAGE.prefix)
      const paid = comfy && method === 'POST' && target.pathname.endsWith('/requests')
      const free = comfy && (method === 'GET' || method === 'POST' && target.pathname.endsWith('/estimate')) || storage && method === 'GET'
      if (!free && !paid) throw new Error(`Refused to send: ${method} ${target.origin}${target.pathname}`)
      if (paid && (!armed || ++paidPosts > PLAN.length)) throw new Error('Refused to send a paid request that was not on the approved list.')
      sent.push(`${method} ${target.origin}${target.pathname.replace(/\/requests\/.+$/, '/requests/…')}`)
      return fetch(url, options)
    } })
  const results = []
  const save = () => fs.writeFile(RESULTS, JSON.stringify({ requests: sent.length, paidRequests: paidPosts, results }, null, 1))
  try {
    const connected = await router.connect({ apiKey: key })
    if (!connected.success) { console.log(`Could not connect: ${connected.error}`); return }
    const choicesFor = item => ({ ...item.choices, ...(item.picture ? { picture } : {}) })
    // 1. Free quotes for everything, then one question.
    let total = 0
    console.log('\nThese requests would be sent, once each:\n')
    for (const item of PLAN) {
      const plan = await router.previewCreate({ modelId: item.id, choices: choicesFor(item) })
      if (!plan.success) throw new Error(`${label(item)}: could not be prepared (${plan.code}: ${plan.error}). Nothing was sent.`)
      const recorded = fallbackPrice(item.id, getModel(item.id).kind === 'video' ? { seconds: item.choices.seconds } : { size: item.choices.size })
      item.usd = plan.estimate ? plan.estimate.usd : recorded ? recorded.usd : item.guess
      if (typeof item.usd !== 'number') throw new Error(`${label(item)}: no price to budget with. Nothing was sent.`)
      item.priced = plan.estimate ? (plan.estimate.basis === 'live' ? 'quoted' : 'recorded') : 'guess'
      total += item.usd
      console.log(`  ${label(item).padEnd(58)} $${item.usd.toFixed(3)}  ${item.priced}`)
    }
    console.log(`\n  ${PLAN.length} requests, about $${total.toFixed(2)} in Comfy credits. Budget limit for this run: $${BUDGET_USD.toFixed(2)}.`)
    if (total > BUDGET_USD) { console.log('That is over the limit. Nothing was sent.'); return }
    const answer = await ask('\nType yes to send them, or anything else to stop: ')
    if (answer.toLowerCase() !== 'yes') { console.log('Stopped. Nothing was sent.'); return }
    armed = true
    // 2. One at a time, no retries.
    for (const [index, item] of PLAN.entries()) {
      const row = { request: label(item), model: item.id, expectedUsd: item.usd }
      results.push(row)
      process.stdout.write(`\n[${index + 1}/${PLAN.length}] ${row.request} … `)
      const plan = await router.previewCreate({ modelId: item.id, choices: choicesFor(item) })
      if (!plan.success) { row.outcome = 'not sent'; row.error = plan.code; console.log(`not sent (${plan.code})`); continue }
      const submitted = await router.submit({ planId: plan.planId })
      if (!submitted.success) {
        row.outcome = submitted.code === 'COMFY_ROUTER_UNCERTAIN' ? 'unclear' : 'refused'; row.error = submitted.code; row.diagnostics = submitted.diagnostics || null
        console.log(`${row.outcome} (${submitted.code}${submitted.diagnostics ? ` · HTTP ${submitted.diagnostics.httpStatus} ${submitted.diagnostics.errorType || ''}` : ''})`)
        if (row.outcome === 'unclear') { console.log('Stopping: an unclear outcome must be checked on your Comfy usage page before anything else is sent.'); break }
        continue
      }
      let job = submitted.job
      const deadline = Date.now() + (getModel(item.id).kind === 'video' ? 12 : 5) * 60000
      while (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status) && Date.now() < deadline) {
        await wait(Math.max(3000, Math.min(job.retryAfterMs || 0, 15000)))
        const refreshed = await router.refresh({ jobId: job.jobId })
        if (refreshed.success) job = refreshed.job; else row.lastRefreshError = refreshed.code
      }
      row.status = job.status; row.jobError = job.errorType || null
      if (job.status !== 'COMPLETED') { row.outcome = job.status === 'FAILED' ? 'failed' : 'not finished'; console.log(`${row.outcome} (${job.errorType || job.status})`); await save(); continue }
      const output = await router.output({ jobId: job.jobId })
      const after = (await router.list({})).jobs.find(entry => entry.jobId === job.jobId) || job
      row.chargedCredits = after.chargedCredits ?? null; row.chargedUsd = after.chargedUsd ?? null
      if (!output.success) { row.outcome = 'made but not collected'; row.error = output.code; row.message = output.error; console.log(`made, but not collected (${output.code})`); await save(); continue }
      const file = path.join(OUT_DIR, `${String(index + 1).padStart(2, '0')}-${item.id}${item.picture ? '-from-picture' : ''}.${output.filename.split('.').pop()}`)
      await fs.writeFile(file, Buffer.from(output.bytes))
      Object.assign(row, { outcome: 'ok', file: path.basename(file), bytes: output.bytes.length, mimeType: output.mimeType, width: output.width || null, height: output.height || null })
      console.log(`ok · ${output.width ? `${output.width}×${output.height} · ` : ''}${(output.bytes.length / 1048576).toFixed(1)} MB · charged ${row.chargedUsd == null ? 'not reported' : '$' + row.chargedUsd.toFixed(3)}`)
      await save()
    }
  } finally {
    await save().catch(() => {})
    router.dispose(); await fs.rm(storageDir, { recursive: true, force: true })
  }
  const charged = results.reduce((sum, row) => sum + (row.chargedUsd || 0), 0)
  console.log(`\nDone. ${paidPosts} paid requests were sent. Comfy reported $${charged.toFixed(2)} charged in total. You can close this tab.`)
}
main().catch(error => { console.error(`\n${error.message}`); process.exitCode = 1 })
