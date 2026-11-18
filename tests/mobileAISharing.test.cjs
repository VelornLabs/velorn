'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { descriptor, publicationSharing, consentMatches, requestSharing } = require('../electron/mobileAISharing.cjs')
const { validateCommand } = require('../electron/mobileCompanionControl.cjs')
const { sanitizePublication } = require('../electron/mobileCompanion.cjs')
const caps = { tools: false, research: false, fullAccess: false, images: false, view: false }
const consent = value => { const { capabilities, ...result } = value; return result }

test('funded Luna names both recipients, accepts supported capabilities, and requires fresh explicit mobile consent', () => {
  const sharing = descriptor('luna', { ...caps, tools: true })
  assert.equal(sharing.recipient, 'velorn-openai')
  assert.notEqual(sharing.disclosureKey, descriptor('codex', { ...caps, tools: true }).disclosureKey)
  for (const key of ['research', 'fullAccess', 'images', 'view']) {
    const broader = descriptor('luna', { ...caps, tools: true, images: true, [key]: true })
    assert.ok(broader); assert.equal(consentMatches(consent(sharing), broader), false)
  }
  const snapshot = { protocol: 3, contextId: 'context', provider: 'luna', aiSharing: sharing, available: true }
  const message = { kind: 'message', id: 'message', contextId: 'context', text: 'Synthetic text' }
  assert.throws(() => validateCommand(message, snapshot), /AI_SHARING_CHANGED/)
  assert.throws(() => validateCommand({ ...message, aiSharingConsent: consent(descriptor('codex', { ...caps, tools: true })) }, snapshot), /AI_SHARING_CHANGED/)
  assert.deepEqual(validateCommand({ ...message, aiSharingConsent: consent(sharing) }, snapshot).aiSharingConsent, consent(sharing))
  const publication = sanitizePublication({ ...snapshot, chatId: 'chat', chatNavigation: true, fullAccess: false, toolsEnabled: true,
    aiSharingVersion: 1, aiSharingCapabilities: { ...caps, tools: true }, chats: [{ id: 'luna-chat', provider: 'luna', title: 'Funded chat' }] })
  assert.equal(publication.fullAccessSupported, true)
  assert.equal(publication.chats[0].provider, 'luna')
  assert.equal(validateCommand({ kind: 'access', mode: 'full', id: 'access', contextId: 'context' }, publication).mode, 'full')
})

test('sharing disclosure is a bounded native routing enum and deterministic configuration digest', () => {
  const cloud = descriptor('codex', caps), local = descriptor('lmstudio', caps)
  assert.equal(cloud.recipient, 'openai'); assert.equal(local.recipient, 'local-lmstudio')
  assert.match(cloud.disclosureKey, /^[a-f0-9]{64}$/)
  assert.notEqual(cloud.disclosureKey, local.disclosureKey)
  assert.deepEqual(descriptor('codex', { ...Object.fromEntries(Object.entries(caps).reverse()) }), cloud)
  for (const change of [{ tools: true }, { tools: true, research: true }, { tools: true, fullAccess: true }, { images: true }, { images: true, view: true }]) {
    assert.notEqual(descriptor('codex', { ...caps, ...change }).disclosureKey, cloud.disclosureKey)
  }
  for (const invalid of [null, {}, { ...caps, view: true }, { ...caps, research: true }, { ...caps, fullAccess: true }, { ...caps, endpoint: 'https://unknown.test' }, { ...caps, images: 1 }]) {
    assert.equal(descriptor('codex', invalid), null)
  }
  assert.equal(descriptor('unknown', caps), null)
})

test('only mutually supported and internally consistent publications advertise sharing', () => {
  const raw = { protocol: 3, contextId: 'context', chatId: 'chat', provider: 'codex', available: true,
    aiSharingVersion: 1, aiSharingCapabilities: caps }
  assert.deepEqual(sanitizePublication(raw).aiSharing, descriptor('codex', caps))
  for (const change of [{ aiSharingVersion: undefined }, { aiSharingVersion: 2 }, { protocol: 2 }, { provider: 'custom' },
    { toolsEnabled: true }, { fullAccess: true }, { aiSharingCapabilities: {} }]) {
    assert.equal(sanitizePublication({ ...raw, ...change }).aiSharing, undefined)
  }
  assert.equal(publicationSharing({ ...raw, toolsEnabled: true, researchEnabled: true,
    aiSharingCapabilities: { ...caps, tools: true, research: true } }).recipient, 'openai')
})

test('new message envelope binds exact sharing configuration; legacy Android command remains unchanged', () => {
  const sharing = descriptor('codex', caps)
  const snapshot = { protocol: 3, contextId: 'context', provider: 'codex', aiSharing: sharing, available: true }
  const legacy = { kind: 'message', id: 'command', contextId: 'context', text: 'A private draft.' }
  assert.deepEqual(validateCommand(legacy, snapshot), legacy)
  const command = { ...legacy, aiSharingConsent: consent(sharing) }
  assert.deepEqual(validateCommand(command, snapshot), command)
  for (const value of [null, {}, { ...command.aiSharingConsent, version: 2 }, { ...command.aiSharingConsent, disclosureKey: 'a'.repeat(64) },
    { ...command.aiSharingConsent, recipient: 'other' }, { ...command.aiSharingConsent, capabilities: caps }, consent(descriptor('lmstudio', caps))]) {
    assert.throws(() => validateCommand({ ...command, aiSharingConsent: value }, snapshot), /AI_SHARING_CHANGED/)
  }
  assert.throws(() => validateCommand(command, { ...snapshot, aiSharing: undefined }), /AI_SHARING_CHANGED/)
  assert.throws(() => validateCommand({ ...command, kind: 'projects' }, snapshot), /INVALID_COMMAND/)
  assert.throws(() => validateCommand(command, { ...snapshot, contextId: 'new-context' }), /STALE_CONTEXT/)
})

test('actual request routing and effective media/tool permissions must match disclosure', () => {
  const sharing = descriptor('codex', { ...caps, tools: true, research: true, images: true, view: true })
  const request = { provider: 'codex', toolsEnabled: true, researchEnabled: true, allowToolImages: true, mobileSharing: { view: true } }
  assert.equal(consentMatches(consent(sharing), requestSharing(request)), true)
  for (const changed of [{ provider: 'lmstudio' }, { toolsEnabled: false }, { researchEnabled: false }, { allowToolImages: false }, { mobileSharing: { view: false } }, { fullAccess: true }]) {
    assert.equal(consentMatches(consent(sharing), requestSharing({ ...request, ...changed })), false)
  }
})
