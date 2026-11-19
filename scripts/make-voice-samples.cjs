'use strict'
// PAID: records one short sample of every voice the Sound tab offers, so a
// person can hear a voice before spending anything.
//
// Each voice says "Hi, I'm <name>. This is what I sound like." on Eleven V4.
// It prints the list and the total and sends NOTHING until you type "yes".
// Each request is sent once, with no retries, and it stops at the first
// unclear outcome. A voice that already has a sample is skipped.
//
// The key is read from a hidden prompt, kept in memory, and never written.
//   node scripts/make-voice-samples.cjs [output-folder]
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { createComfyRouter } = require('../electron/comfyRouter.cjs')
const { listVoices } = require('../electron/createModels.cjs')

const OUT_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src', 'assets', 'sound'))
const MODEL = 'eleven-v4'
const BUDGET_USD = 0.25
const line = voice => `Hi, I'm ${voice.name}. This is what I sound like.`
const SYNC_PATH = /^\/v2\/models\/elevenlabs\/[a-z0-9_]+$/

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
const exists = file => fs.access(file).then(() => true, () => false)

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true })
  const todo = []
  for (const voice of listVoices()) if (!(await exists(path.join(OUT_DIR, `voice-${voice.id}.mp3`)))) todo.push({ ...voice })
  if (!todo.length) { console.log('Every voice already has a sample. Nothing to do.'); return }
  const key = await ask('Paste your Comfy key (it will not show), then Enter: ', true)
  if (!key) { console.log('No key entered. Nothing was sent.'); return }
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-voice-samples-'))
  let armed = false, paidPosts = 0
  const router = createComfyRouter({ storageDir, getPolicy: async () => 'ask-cloud',
    getContext: async () => ({ session: 'voice-samples', projectKey: path.join(storageDir, 'project') }),
    // The person approves the whole list once, in this terminal, before `armed` is set.
    confirmSpend: async () => armed,
    fetchImpl: (url, options) => {
      const method = options.method || 'GET', target = new URL(url)
      const comfy = target.origin === 'https://api.comfy.org'
      const paid = comfy && method === 'POST' && SYNC_PATH.test(target.pathname)
      const free = comfy && (method === 'GET' || method === 'POST' && target.pathname.endsWith('/estimate'))
      if (!free && !paid) throw new Error(`Refused to send: ${method} ${target.origin}${target.pathname}`)
      if (paid && (!armed || ++paidPosts > todo.length)) throw new Error('Refused to send a paid request that was not on the approved list.')
      return fetch(url, options)
    } })
  let charged = 0, made = 0
  try {
    const connected = await router.connect({ apiKey: key })
    if (!connected.success) { console.log(`Could not connect: ${connected.error}`); return }
    let total = 0
    console.log('\nThese samples would be recorded, once each, on Eleven V4:\n')
    for (const voice of todo) {
      const plan = await router.previewCreate({ modelId: MODEL, choices: { prompt: line(voice), voice: voice.id } })
      if (!plan.success || !plan.estimate) throw new Error(`${voice.name}: could not be prepared (${plan.code || 'no price'}). Nothing was sent.`)
      voice.usd = plan.estimate.usd; total += voice.usd
      console.log(`  ${voice.name.padEnd(10)} "${line(voice)}"`.padEnd(64) + ` $${voice.usd.toFixed(4)}`)
    }
    console.log(`\n  ${todo.length} recordings, about $${total.toFixed(2)} in Comfy credits. Budget limit for this run: $${BUDGET_USD.toFixed(2)}.`)
    if (total > BUDGET_USD) { console.log('That is over the limit. Nothing was sent.'); return }
    const answer = await ask('\nType yes to record them, or anything else to stop: ')
    if (answer.toLowerCase() !== 'yes') { console.log('Stopped. Nothing was sent.'); return }
    armed = true
    for (const [index, voice] of todo.entries()) {
      process.stdout.write(`\n[${index + 1}/${todo.length}] ${voice.name} … `)
      const plan = await router.previewCreate({ modelId: MODEL, choices: { prompt: line(voice), voice: voice.id } })
      if (!plan.success) { console.log(`not sent (${plan.code})`); continue }
      const submitted = await router.submit({ planId: plan.planId })
      if (!submitted.success) {
        console.log(`${submitted.code === 'COMFY_ROUTER_UNCERTAIN' ? 'unclear' : 'refused'} (${submitted.code})`)
        if (submitted.code === 'COMFY_ROUTER_UNCERTAIN') { console.log('Stopping: check your Comfy usage page before anything else is sent.'); break }
        continue
      }
      let job = submitted.job
      const deadline = Date.now() + 12 * 60000
      while (job.status === 'SUBMITTING' && Date.now() < deadline) {
        await wait(500)
        const refreshed = await router.refresh({ jobId: job.jobId })
        if (refreshed.success) job = refreshed.job
      }
      charged += job.chargedUsd || 0
      if (job.status === 'UNCERTAIN' || job.status === 'SUBMITTING') { console.log('unclear'); console.log('Stopping: check your Comfy usage page before anything else is sent.'); break }
      if (job.status !== 'COMPLETED') { console.log(`failed (${job.diagnostics ? `HTTP ${job.diagnostics.httpStatus} ${job.diagnostics.errorType || ''}` : job.errorType || job.status})`); continue }
      const output = await router.output({ jobId: job.jobId })
      if (!output.success || output.mimeType !== 'audio/mpeg') { console.log(`made, but not an MP3 Velorn could save (${output.code || output.mimeType})`); continue }
      await fs.writeFile(path.join(OUT_DIR, `voice-${voice.id}.mp3`), Buffer.from(output.bytes), { flag: 'wx' })
      made++
      console.log(`ok · ${(output.bytes.length / 1024).toFixed(0)} KB · charged ${job.chargedUsd == null ? 'not reported' : '$' + job.chargedUsd.toFixed(4)}`)
    }
  } finally {
    router.dispose(); await fs.rm(storageDir, { recursive: true, force: true })
  }
  console.log(`\nDone. ${made} of ${todo.length} samples saved in ${OUT_DIR}. Comfy reported $${charged.toFixed(2)} charged. You can close this tab.`)
}
main().catch(error => { console.error(`\n${error.message}`); process.exitCode = 1 })
