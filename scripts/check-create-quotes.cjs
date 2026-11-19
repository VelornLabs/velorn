'use strict'
// Asks Comfy for live price quotes through Velorn's own Create connection and
// prints them beside the recorded prices. FREE: it only connects and previews.
// It never submits a request, so no model runs and nothing is charged.
// The key is read from a hidden prompt, kept in memory, and never written.
//
//   node scripts/check-create-quotes.cjs [results.json]
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createComfyRouter } = require('../electron/comfyRouter.cjs')
const { listModels, sizesFor, resolutionsFor, fallbackPrice } = require('../electron/createModels.cjs')

function hiddenPrompt(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    if (!input.isTTY) return reject(new Error('Run this in a terminal so the key can be typed out of sight.'))
    process.stdout.write(question)
    input.setRawMode(true); input.resume(); input.setEncoding('utf8')
    let value = ''
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') { input.setRawMode(false); input.pause(); input.removeListener('data', onData); process.stdout.write('\n'); return resolve(value.trim()) }
        if (char === '\u0003') { input.setRawMode(false); process.stdout.write('\n'); process.exit(130) }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    input.on('data', onData)
  })
}

async function main() {
  const key = await hiddenPrompt('Paste your Comfy key (it will not show), then Enter: ')
  if (!key) { console.log('No key entered. Nothing was sent.'); return }
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-create-quotes-'))
  const sent = []
  const router = createComfyRouter({ storageDir, getPolicy: async () => 'ask-cloud',
    getContext: async () => ({ session: 'quote-check', projectKey: path.join(storageDir, 'project') }),
    confirmSpend: async () => { throw new Error('This script never submits.') },
    fetchImpl: (url, options) => {
      const line = `${options.method || 'GET'} ${url}`
      // Refuse anything that is not a read or a price quote BEFORE it is sent.
      if (!/^GET |\/estimate$/.test(line)) throw new Error(`Refused to send: ${line}`)
      sent.push(line); return fetch(url, options)
    } })
  const rows = []
  try {
    const connected = await router.connect({ apiKey: key })
    if (!connected.success) { console.log(`Could not connect: ${connected.error}`); return }
    for (const model of listModels()) {
      const variants = model.kind === 'video'
        ? resolutionsFor(model).flatMap(resolution => [5, 10].map(seconds => ({ seconds, resolution })))
        : sizesFor(model).map(size => ({ size }))
      for (const variant of variants) {
        const plan = await router.previewCreate({ modelId: model.id, choices: { prompt: 'quote check', ...variant } })
        const recorded = fallbackPrice(model.id, variant)
        rows.push({ model: model.name, ...variant, recordedUsd: recorded ? recorded.usd : null,
          ...(plan.success ? { shownUsd: plan.estimate ? plan.estimate.usd : null, firm: plan.estimate ? plan.estimate.firm : null,
            basis: plan.estimate ? plan.estimate.basis : null, range: plan.estimate?.range || null, oneClick: plan.buttonApproval }
            : { error: plan.code }) })
      }
    }
  } finally { router.dispose(); await fs.rm(storageDir, { recursive: true, force: true }) }
  const unexpected = sent.filter(line => !/^GET |\/estimate$/.test(line))
  if (unexpected.length) throw new Error(`Unexpected request: ${unexpected[0]}`)
  for (const row of rows) console.log([row.model.padEnd(20), String(row.size || `${row.seconds}s ${row.resolution}`).padEnd(10),
    row.error ? `ERROR ${row.error}` : `shown ${row.shownUsd === null ? 'no price' : '$' + row.shownUsd.toFixed(4)} (${row.basis || '-'})`.padEnd(30),
    `recorded ${row.recordedUsd === null ? 'none' : '$' + row.recordedUsd.toFixed(4)}`].join('  '))
  if (process.argv[2]) await fs.writeFile(process.argv[2], JSON.stringify({ requests: sent.length, rows }, null, 1))
  console.log(`\nDone. ${sent.length} requests, all free: one connection check and price quotes. No model was run.`)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
