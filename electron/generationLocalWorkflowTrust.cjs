'use strict'

// A remembered human choice, not a certificate that an extension is offline.
// Entries contain hashes/labels only, never prompts, graphs or credentials.
const { createHash } = require('node:crypto')
const GENERATION_LOCAL_TRUST_SETTING_KEY = 'generationLocalWorkflowTrust'
const MAX_ENTRIES = 200
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hash = value => createHash('sha256').update(stable(value)).digest('hex')
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const validWorkflow = value => typeof value === 'string' && value.length <= 200 && /^(?:my-workflow:[A-Za-z0-9][A-Za-z0-9_.-]*|tpl-mcp-[a-z0-9][a-z0-9-]{0,47})$/.test(value)
const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, ' ').slice(0, 160) : ''
const fault = message => Object.assign(new Error(message), { code: 'GENERATION_SPENDING_LOCAL_TRUST_UNAVAILABLE', publicMessage: message })
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

// Only ordinary creative scalar inputs vary without another trust decision.
// Links, models, endpoints, provider settings, scripts and every unrecognized
// input remain in the identity. A saved source edit always changes the revision.
const CREATIVE_INPUT = /^(?:text|prompt|positive|negative|positive_prompt|negative_prompt|text_prompt|prompt_text|positive_text|negative_text|caption|lyrics|seed|noise_seed|image|audio|video|filename_prefix)$/
function graphIdentity(workflow) {
  if (!plain(workflow) || !Object.keys(workflow).length) return null
  const result = Object.create(null)
  for (const [id, node] of Object.entries(workflow)) {
    if (!plain(node) || typeof node.class_type !== 'string' || !plain(node.inputs)) return null
    result[id] = { class_type: node.class_type, inputs: Object.fromEntries(Object.entries(node.inputs).map(([key, value]) =>
      [key, CREATIVE_INPUT.test(key) && !Array.isArray(value) && (value === null || ['string', 'number', 'boolean'].includes(typeof value))
        ? { creativeValueType: value === null ? 'null' : typeof value } : value])) }
  }
  return result
}

function localTrustCandidate({ saved, workflow, endpoint, objectInfo }) {
  if (saved?.success !== true || saved?.ready !== true || !validWorkflow(saved.workflowId) || !validHash(saved.graphFingerprint)) {
    return { eligible: false, reason: 'Save this workflow to My Workflows to remember a local-workflow choice.' }
  }
  const shape = graphIdentity(workflow), sourceShape = graphIdentity(saved.workflow)
  if (!shape || !sourceShape || stable(shape) !== stable(sourceShape)) {
    return { eligible: false, reason: 'This run changes the saved workflow configuration. Save the revised workflow before remembering it as local.' }
  }
  const classes = [...new Set(Object.values(workflow).map(node => node.class_type))].sort()
  // Re-read live metadata every run. A changed class/module or pricing/API flag
  // invalidates remembered trust; lack of metadata is recorded, not guessed.
  const metadata = classes.map(name => {
    const node = plain(objectInfo) && Object.hasOwn(objectInfo, name) ? objectInfo[name] : null
    return { classType: name, module: node?.python_module ?? null, name: node?.name ?? null,
      apiNode: node?.api_node ?? null, priceBadge: node?.price_badge ?? null,
      provider: node?.provider ?? null, providerName: node?.provider_name ?? null }
  })
  const id = hash({ version: 1, workflowId: saved.workflowId, revision: saved.graphFingerprint, shape, endpoint, metadata })
  return { eligible: true, id, workflowId: saved.workflowId, title: clean(saved.title) || 'Saved workflow',
    endpoint, sourceGraphFingerprint: saved.graphFingerprint, reference: id.slice(0, 16) }
}

function normalizeStore(value) {
  if (value == null) return { version: 1, entries: [] }
  if (!plain(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) throw fault('Saved local-workflow choices could not be read. Review Generation spending settings.')
  const ids = new Set()
  const entries = value.entries.map(entry => {
    let endpoint
    try { endpoint = new URL(entry?.endpoint) } catch { /* Rejected below. */ }
    if (!plain(entry) || !validHash(entry.id) || !validWorkflow(entry.workflowId) || !validHash(entry.sourceGraphFingerprint)
      || typeof entry.title !== 'string' || entry.title !== clean(entry.title) || !Number.isFinite(entry.createdAt) || entry.createdAt < 0
      || !endpoint || !['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
      || endpoint.origin !== entry.endpoint || ids.has(entry.id)) throw fault('Saved local-workflow choices could not be read. Review Generation spending settings.')
    ids.add(entry.id)
    return { id: entry.id, workflowId: entry.workflowId, title: entry.title, endpoint: entry.endpoint,
      sourceGraphFingerprint: entry.sourceGraphFingerprint, createdAt: entry.createdAt }
  })
  return { version: 1, entries }
}
function createLocalWorkflowTrustStore({ readStore, writeStore, now = Date.now }) {
  let writes = Promise.resolve()
  const read = async () => normalizeStore(await readStore())
  const publicEntry = ({ sourceGraphFingerprint, ...entry }) => entry
  const authorized = authority => !authority?.signal?.aborted && authority?.isCurrent?.() === true
  function update(mutator, authority) {
    const operation = writes.catch(() => {}).then(async () => {
      if (!authorized(authority)) throw fault('The local-workflow choice was cancelled before it could be saved.')
      const before = await read()
      const next = mutator(before)
      if (!authorized(authority)) throw fault('The local-workflow choice was cancelled before it could be saved.')
      const result = await writeStore(normalizeStore(next), authority)
      if (result?.success === false) throw fault('The local-workflow choice could not be saved.')
      if (stable(await read()) !== stable(next)) throw fault('The local-workflow choice could not be saved.')
      return next.entries.map(publicEntry)
    })
    writes = operation
    return operation
  }
  return {
    async list() { return (await read()).entries.map(publicEntry) },
    async has(candidate) { return candidate?.eligible === true && (await read()).entries.some(entry => entry.id === candidate.id) },
    remember(candidate, authority) {
      if (candidate?.eligible !== true) return Promise.reject(fault('Choose a saved workflow before remembering it as local.'))
      return update(store => ({ version: 1, entries: [...store.entries.filter(entry => entry.workflowId !== candidate.workflowId),
        { id: candidate.id, workflowId: candidate.workflowId, title: candidate.title, endpoint: candidate.endpoint,
          sourceGraphFingerprint: candidate.sourceGraphFingerprint, createdAt: now() }].slice(-MAX_ENTRIES) }), authority)
    },
    revoke(id, authority) {
      if (!validHash(id)) return Promise.reject(fault('Choose a remembered local workflow to remove.'))
      return update(store => ({ ...store, entries: store.entries.filter(entry => entry.id !== id) }), authority)
    },
  }
}

module.exports = { createLocalWorkflowTrustStore, localTrustCandidate, GENERATION_LOCAL_TRUST_SETTING_KEY }
