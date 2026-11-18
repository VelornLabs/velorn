'use strict'
const { createHash } = require('node:crypto')
const { isAutoApprovableEdit } = require('./connectedAgentEditPolicy.cjs')
const { EFFORTS } = require('./connectedAgentReasoning.cjs')
const { publicationSharing, consentMatches } = require('./mobileAISharing.cjs')
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x)
const text = (x, n = 256) => typeof x === 'string' ? x.slice(0, n) : ''
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Navigation is not an undoable authored edit. Allow this specific action on
// the phone without broadening desktop auto-approval or permitting arbitrary
// tools. The ordinary native one-use approval and freshness checks still run.
function isMobileApprovableAction(name, args) {
  if (isAutoApprovableEdit(name, args)) return true
  if (name !== 'set_playhead' || !object(args) || args.previewOnly !== false) return false
  const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0
  const timecode = x => typeof x === 'string' && /^\d{1,6}:\d{2}:\d{2}(?::\d{2,3}|\.\d{1,6})?$/.test(x)
  const rules = { timeSeconds: number, time: x => number(x) || timecode(x), timecode,
    frame: x => number(x) && Number.isSafeInteger(x), snapToFrame: x => typeof x === 'boolean',
    previewOnly: x => x === false, previewToken: x => typeof x === 'string' && x.length > 0 && x.length <= 512,
    expectedContext: object }
  return ['timeSeconds', 'time', 'timecode', 'frame'].some(key => Object.hasOwn(args, key))
    && Object.entries(args).every(([key, value]) => Object.hasOwn(rules, key) && rules[key](value))
}

function controlsSnapshot(value, safeText) {
  if (![2, 3].includes(value.protocol)) return {}
  const parity = value.protocol === 3
  if (!id(value.contextId)) throw Error('Invalid mobile context')
  const models = (Array.isArray(value.models) ? value.models : []).slice(0, 256)
    .filter(m => object(m) && typeof m.id === 'string' && m.id.length <= 256)
    .map(m => ({ id: m.id, label: safeText(m.label || m.id, 256) }))
  const projects = (Array.isArray(value.projects) ? value.projects : []).slice(0, 100)
    .filter(p => object(p) && id(p.id)).map(p => ({ id: p.id, name: safeText(p.name, 256), current: p.current === true }))
  const chatNavigation = parity && value.chatNavigation === true
  const seenChats = new Set()
  const chats = chatNavigation ? (Array.isArray(value.chats) ? value.chats : []).slice(0, 100).flatMap(chat => {
    if (!object(chat) || !id(chat.id) || !['codex', 'lmstudio', 'luna'].includes(chat.provider)
      || typeof chat.title !== 'string' || seenChats.has(`${chat.provider}:${chat.id}`)) return []
    seenChats.add(`${chat.provider}:${chat.id}`)
    return [{ id: chat.id, title: safeText(chat.title.replace(/[\u202a-\u202e\u2066-\u2069]/g, ''), 256), provider: chat.provider,
      current: chat.id === value.chatId && chat.provider === value.provider,
      updatedAt: Number.isSafeInteger(chat.updatedAt) && chat.updatedAt >= 0 ? Math.min(chat.updatedAt, Date.now()) : 0 }]
  }) : []
  const approvals = (Array.isArray(value.approvals) ? value.approvals : []).filter(a => a?.state === 'pending').slice(0, 8).flatMap(a => {
    if (!object(a) || !id(a.approvalId) || !id(a.requestId)) return []
    const args = text(a.arguments, 131073), preview = text(a.preview, 16000)
    let eligible = false, display = ''
    try {
      const parsed = JSON.parse(args)
      // Native freshness guards can contain private project paths. They are
      // not authored edits. Bind their exact bytes into the review digest,
      // but expose every authored argument without those internal guards.
      display = JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([key]) => !['expectedContext', 'previewToken'].includes(key))), null, 2)
      eligible = a.reviewable === true && args.length <= 131072 && object(parsed)
        && (parity || (value.phoneRequest === true && isMobileApprovableAction(a.toolName, parsed) && safeText(display, 262144) === display))
    } catch {}
    const result = { approvalId: a.approvalId, requestId: a.requestId, toolName: safeText(a.toolName, 120),
      arguments: eligible ? display : '', preview: eligible ? safeText(preview, 16000) : '',
      warnings: (Array.isArray(a.warnings) ? a.warnings : []).slice(0, 8).map(w => safeText(w, 500)),
      remoteEligible: eligible, state: a.state === 'pending' ? 'pending' : 'sending' }
    return [{ ...result, reviewToken: hash({ ...result, binding: hash(args) }) }]
  })
  const aiSharing = publicationSharing(value)
  return { protocol: value.protocol, contextId: value.contextId, chatId: id(value.chatId) ? value.chatId : '', models, projects, approvals,
    ...(aiSharing ? { aiSharing } : {}),
    ...(parity ? { chatNavigation, chats } : {}),
    ...(parity && value.provider === 'codex' ? {
      reasoningEffort: EFFORTS.includes(value.reasoningEffort) ? value.reasoningEffort : '',
      reasoningOptions: (Array.isArray(value.reasoningOptions) ? value.reasoningOptions : []).slice(0, 8)
        .filter(item => EFFORTS.includes(item?.id)).map(item => ({ id: item.id, label: safeText(item.label, 32) })),
    } : {}),
    phoneRequest: value.phoneRequest === true, toolsEnabled: value.toolsEnabled === true,
    dirty: value.dirty === true, modelCatalogStatus: safeText(value.modelCatalogStatus, 200),
    fullAccess: parity && value.fullAccess === true, fullAccessSupported: parity && ['codex', 'lmstudio', 'luna'].includes(value.provider),
    fullAccessBundleVersion: parity && value.fullAccess === true && value.fullAccessBundleVersion === 1 && value.spendingPolicy === 'ask-cloud' ? 1 : 0,
    researchEnabled: parity && value.researchEnabled === true,
    spendingPolicy: value.spendingPolicy === 'ask-cloud' ? 'ask-cloud' : 'local-only', remoteApprovals: true }
}
function validateCommand(input, snapshot) {
  if (!object(input) || !id(input.id) || !id(input.contextId) || input.contextId !== snapshot.contextId) throw Error('STALE_CONTEXT')
  const fields = { message: ['text', 'aiSharingConsent'], model: ['model'], projects: [], project: ['projectId', 'saveCurrent'], chat: ['chatId', 'provider'], 'new-chat': [],
    approval: ['approvalId', 'reviewToken', 'approved'], 'native-approval': ['approvalId', 'reviewToken', 'approved', 'riskAcknowledged', 'trustLocal'],
    spending: ['policy'], reasoning: ['effort'], 'show-review': ['reviewId'], stop: [], preview: [], models: [], access: ['mode', 'bundleVersion'] }
  if (!Object.hasOwn(fields, input.kind) || Object.keys(input).some(k => !['id', 'kind', 'contextId', ...fields[input.kind]].includes(k))) throw Error('INVALID_COMMAND')
  if (input.kind === 'message' && (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000 || /\u0000/.test(input.text))) throw Error('INVALID_MESSAGE')
  if (input.kind === 'message' && (snapshot.provider === 'luna' || Object.hasOwn(input, 'aiSharingConsent')) && !consentMatches(input.aiSharingConsent, snapshot.aiSharing)) throw Error('AI_SHARING_CHANGED')
  if (input.kind === 'model' && !(snapshot.models || []).some(m => m.id === input.model)) throw Error('MODEL_UNAVAILABLE')
  if (['chat', 'new-chat'].includes(input.kind) && (snapshot.protocol !== 3 || snapshot.chatNavigation !== true)) throw Error('CHAT_NAVIGATION_UNAVAILABLE')
  if (input.kind === 'chat' && (!id(input.chatId) || !['codex', 'lmstudio', 'luna'].includes(input.provider)
    || !(snapshot.chats || []).some(chat => chat.id === input.chatId && chat.provider === input.provider))) throw Error('CHAT_UNAVAILABLE')
  if (input.kind === 'show-review' && !(snapshot.reviews || []).some(frame => frame.id === input.reviewId && Number.isFinite(frame.timeSeconds))) throw Error('PREVIEW_UNAVAILABLE')
  if (input.kind === 'reasoning' && (snapshot.protocol !== 3 || snapshot.provider !== 'codex'
    || !(snapshot.reasoningOptions || []).some(item => item.id === input.effort))) throw Error('REASONING_UNAVAILABLE')
  if (input.kind === 'access' && !['review', 'work', ...(snapshot.protocol === 3 && snapshot.fullAccessSupported ? ['full'] : [])].includes(input.mode)) throw Error('INVALID_ACCESS')
  if (input.kind === 'access' && Object.hasOwn(input, 'bundleVersion') && (input.bundleVersion !== 1 || input.mode !== 'full' || snapshot.protocol !== 3)) throw Error('INVALID_ACCESS')
  if (input.kind === 'spending' && (snapshot.protocol !== 3 || !['local-only', 'ask-cloud'].includes(input.policy))) throw Error('INVALID_COMMAND')
  if (input.kind === 'native-approval') {
    const approval = (snapshot.nativeApprovals || []).find(a => a.approvalId === input.approvalId && a.reviewToken === input.reviewToken)
    if (snapshot.protocol !== 3 || !approval || typeof input.approved !== 'boolean' || typeof input.riskAcknowledged !== 'boolean'
      || (input.approved && approval.requiresRiskAcknowledgement && !input.riskAcknowledged)
      || (Object.hasOwn(input, 'trustLocal') && (typeof input.trustLocal !== 'boolean' || !approval.allowLocalTrust || !input.approved))) throw Error('APPROVAL_UNAVAILABLE')
  }
  if (input.kind === 'project' && (!(snapshot.projects || []).some(p => p.id === input.projectId) || typeof input.saveCurrent !== 'boolean')) throw Error('PROJECT_UNAVAILABLE')
  if (input.kind === 'approval') {
    const approval = (snapshot.approvals || []).find(a => a.approvalId === input.approvalId && a.reviewToken === input.reviewToken && a.state === 'pending')
    if (!approval || typeof input.approved !== 'boolean' || (input.approved && !approval.remoteEligible)) throw Error('APPROVAL_UNAVAILABLE')
  }
  if (input.kind === 'stop' && !(snapshot.protocol === 3 ? snapshot.busy : snapshot.phoneRequest)) throw Error('NOT_A_PHONE_REQUEST')
  if (!['approval', 'native-approval', 'stop'].includes(input.kind) && (snapshot.busy || snapshot.awaitingApproval || snapshot.nativeApprovals?.length || !snapshot.available)) throw Error('BUSY')
  return { ...input }
}
module.exports = { controlsSnapshot, validateCommand, isMobileApprovableAction }
