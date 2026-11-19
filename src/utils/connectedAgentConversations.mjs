// Device-local renderer history only. No project context, provider requests,
// native APIs, media, or handles are retained in a serialized conversation.
import { CONNECTED_AGENT_LIMITS, createConnectedAgentHistoryStore, getConnectedAgentHistoryKey, sanitizeConnectedAgentRequestedModel,
  redactConnectedAgentText, sanitizeConnectedAgentMessages } from './connectedAgentContext.mjs'
import { sanitizeAgentToolReceipts, sanitizeAgentLocalDiagnostics } from './connectedAgentReceipts.mjs'

export const CONNECTED_AGENT_CONVERSATION_LIMITS = Object.freeze({ conversations: 50, storedCharacters: 2 * 1024 * 1024, titleCharacters: 64 })
const profiles = new WeakMap()
const session = { strings: new Map(), objects: new WeakMap() }
const warning = 'These chats are available for this Velorn session, but could not be saved on this device.'
const protectedWarning = 'Saved chats could not be safely loaded. They have not been replaced; new changes are available only for this Velorn session.'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value)
const timestamp = value => Number.isSafeInteger(value) && value >= 0
const validMessages = value => Array.isArray(value) && value.every(message => object(message)
  && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string'
  && (message.shotIds === undefined || Array.isArray(message.shotIds)))
let sequence = 0

function cleanSelection(value) {
  if (!object(value)) return undefined
  const model = sanitizeConnectedAgentRequestedModel(value.model)
  if (model === undefined) return undefined
  return { model, ...(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.reasoningEffort)
    ? { reasoningEffort: value.reasoningEffort } : {}) }
}
export function getConnectedAgentChatSelection(chat) {
  const saved = cleanSelection(chat?.selection)
  if (saved) return saved
  // Legacy chats already record the requested model on assistant replies.
  const reply = [...(chat?.messages || [])].reverse().find(message => message.role === 'assistant'
    && sanitizeConnectedAgentRequestedModel(message.requestedModel) !== undefined)
  return reply ? cleanSelection({ model: reply.requestedModel, reasoningEffort: reply.requestedReasoningEffort }) : undefined
}

export function getConnectedAgentConversationKey(projectKey, provider) {
  return getConnectedAgentHistoryKey(projectKey, provider)?.replace('.history.v1.', '.conversations.v1.') ?? null
}
function cleanTitle(value) {
  return Array.from(redactConnectedAgentText(value).split(/\r?\n/).find(line => line.trim())?.trim() ?? '')
    .filter(character => !/[\u202a-\u202e\u2066-\u2069]/.test(character))
    .slice(0, CONNECTED_AGENT_CONVERSATION_LIMITS.titleCharacters).join('') || 'New chat'
}
function titleFor(messages) {
  return cleanTitle(messages.find(message => message.role === 'user' && message.text.trim())?.text ?? '')
}
function emptyConversation(selection) {
  const now = Date.now()
  // IDs carry no project identity and are stable once assigned, including
  // repeated StrictMode reads before anything is written to storage.
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return { id: `chat-${random}-${(++sequence).toString(36)}`, title: 'New chat', messages: [], createdAt: now, updatedAt: now,
    ...(cleanSelection(selection) ? { selection: cleanSelection(selection) } : {}) }
}
function documentFor(conversations = [emptyConversation()], activeId = conversations[0].id) {
  return { version: 1, activeId, conversations }
}
function parseDocument(raw) {
  if (typeof raw !== 'string' || raw.length > CONNECTED_AGENT_CONVERSATION_LIMITS.storedCharacters) throw new Error('Invalid saved chats.')
  const value = JSON.parse(raw)
  if (!object(value) || value.version !== 1 || !Array.isArray(value.conversations)
    || !value.conversations.length || value.conversations.length > CONNECTED_AGENT_CONVERSATION_LIMITS.conversations) throw new Error('Invalid saved chats.')
  const ids = new Set()
  const conversations = value.conversations.map(chat => {
    if (!object(chat) || !validId(chat.id) || ids.has(chat.id) || !validMessages(chat.messages)
      || !timestamp(chat.createdAt) || !timestamp(chat.updatedAt)) throw new Error('Invalid saved chat.')
    ids.add(chat.id)
    const messages = sanitizeConnectedAgentMessages(chat.messages)
    return { id: chat.id, title: typeof chat.title === 'string' && chat.title.trim() ? cleanTitle(chat.title) : titleFor(messages),
      messages, createdAt: chat.createdAt, updatedAt: chat.updatedAt,
      ...(cleanSelection(chat.selection) ? { selection: cleanSelection(chat.selection) } : {}) }
  })
  if (!ids.has(value.activeId)) throw new Error('Invalid active chat.')
  return documentFor(conversations, value.activeId)
}

/** All methods return detached snapshots. Reads never write/remove storage.
 * Shared per-storage memory is authoritative after any failed persistence:
 * remounts cannot reload stale saved messages or resurrect deleted chats.
 */
export function createConnectedAgentConversationStore({ storage = null } = {}) {
  const hasStorage = storage && (typeof storage === 'object' || typeof storage === 'function')
  if (hasStorage && !profiles.has(storage)) profiles.set(storage, { strings: new Map(), objects: new WeakMap() })
  const profile = hasStorage ? profiles.get(storage) : session
  const legacy = createConnectedAgentHistoryStore({ storage })
  function slotFor(projectKey, provider) {
    if (!getConnectedAgentHistoryKey('validate-provider', provider) || projectKey == null) return null
    if (object(projectKey)) {
      if (!profile.objects.has(projectKey)) profile.objects.set(projectKey, new Map())
      return { map: profile.objects.get(projectKey), key: provider, durableKey: null, legacyKey: null }
    }
    const key = getConnectedAgentConversationKey(projectKey, provider)
    return key ? { map: profile.strings, key, durableKey: key, legacyKey: getConnectedAgentHistoryKey(projectKey, provider) } : null
  }
  function load(projectKey, provider) {
    const slot = slotFor(projectKey, provider)
    if (!slot) return null
    if (slot.map.has(slot.key)) return slot.map.get(slot.key)
    const state = { ...slot, document: null, persistent: false, warning, protected: false, migrationPending: false }
    if (slot.durableKey && storage?.getItem) {
      try {
        const raw = storage.getItem(slot.durableKey)
        if (raw != null) {
          state.document = parseDocument(raw)
          // A previous session may have saved the collection successfully but
          // failed legacy cleanup. Retrying this exact key prevents a stale
          // legacy copy from surviving explicit edits/deletions indefinitely.
          state.migrationPending = true
        }
        else {
          const old = storage.getItem(slot.legacyKey)
          if (old != null) {
            if (typeof old !== 'string' || old.length > CONNECTED_AGENT_LIMITS.storedCharacters) throw new Error('Invalid legacy history.')
            const value = JSON.parse(old)
            if (!object(value) || value.version !== 1 || !validMessages(value.messages)) throw new Error('Invalid legacy history.')
            state.migrationPending = true
          }
          const messages = legacy.read(projectKey, provider)
          const first = emptyConversation()
          first.messages = messages; first.title = titleFor(messages)
          state.document = documentFor([first])
        }
        state.persistent = typeof storage.setItem === 'function'
        state.warning = state.persistent ? undefined : warning
      } catch {
        // Failure is not evidence of absence. Keep unknown/malformed data
        // untouched, including any legacy source, for recovery outside here.
        state.protected = true; state.warning = protectedWarning
      }
    } else if (slot.durableKey && storage) {
      state.protected = true; state.warning = protectedWarning
    } else if (slot.durableKey && !storage) {
      // The legacy null-storage string-key fallback has the same renderer
      // scope and is safe to carry forward without touching durable storage.
      const messages = legacy.read(projectKey, provider)
      const first = emptyConversation()
      first.messages = messages; first.title = titleFor(messages)
      state.document = documentFor([first])
    }
    // Object-key legacy histories were not profile isolated. Never import them
    // into another storage profile or serialize browser handles/project names.
    state.document ??= documentFor()
    slot.map.set(slot.key, state)
    return state
  }
  function snapshot(state) {
    if (!state) return { activeId: null, conversations: [], persistent: false }
    return { activeId: state.document.activeId,
      conversations: state.document.conversations.map(chat => ({ ...chat, ...(chat.selection ? { selection: { ...chat.selection } } : {}), messages: chat.messages.map(message => ({ ...message,
        ...(message.shotIds ? { shotIds: [...message.shotIds] } : {}),
        ...(message.sourceUrls ? { sourceUrls: [...message.sourceUrls] } : {}),
        ...(message.toolReceipts ? { toolReceipts: sanitizeAgentToolReceipts(message.toolReceipts) } : {}),
        ...(message.localDiagnostics ? { localDiagnostics: sanitizeAgentLocalDiagnostics(message.localDiagnostics) } : {}),
      })) })), persistent: state.persistent, ...(state.warning ? { warning: state.warning } : {}) }
  }
  function save(state, document) {
    state.document = document
    state.persistent = false
    state.warning = state.protected ? protectedWarning : warning
    if (!state.durableKey || state.protected || typeof storage?.setItem !== 'function') return snapshot(state)
    // At most 50 independently bounded chat histories remain usable in memory.
    // A large collection must not evict old chats or discard a new reply.
    const serialized = JSON.stringify(document)
    if (serialized.length > CONNECTED_AGENT_CONVERSATION_LIMITS.storedCharacters) return snapshot(state)
    try {
      storage.setItem(state.durableKey, serialized)
      if (state.migrationPending) {
        if (typeof storage.removeItem !== 'function') throw new Error('Legacy cleanup unavailable.')
        storage.removeItem(state.legacyKey)
        state.migrationPending = false
      }
      state.persistent = true; state.warning = undefined
    } catch { /* Keep this shared session state authoritative; retry on an explicit change. */ }
    return snapshot(state)
  }
  function read(projectKey, provider) { return snapshot(load(projectKey, provider)) }
  function create(projectKey, provider, selection) {
    const state = load(projectKey, provider)
    if (!state) return snapshot(state)
    if (state.document.conversations.length >= CONNECTED_AGENT_CONVERSATION_LIMITS.conversations) {
      throw Object.assign(new Error('This project already has 50 chats for this provider. Delete a chat before creating another.'), { code: 'CONVERSATION_LIMIT' })
    }
    const chat = emptyConversation(selection)
    return save(state, documentFor([...state.document.conversations, chat], chat.id))
  }
  function select(projectKey, provider, id) {
    const state = load(projectKey, provider)
    if (!state || !state.document.conversations.some(chat => chat.id === id)) return snapshot(state)
    return save(state, documentFor(state.document.conversations, id))
  }
  function write(projectKey, provider, id, messages, selection) {
    const state = load(projectKey, provider)
    if (!state || !state.document.conversations.some(chat => chat.id === id)) return snapshot(state)
    const clean = sanitizeConnectedAgentMessages(messages)
    return save(state, documentFor(state.document.conversations.map(chat => chat.id !== id ? chat : {
      ...chat, messages: clean,
      ...(cleanSelection(selection) ? { selection: cleanSelection(selection) } : {}),
      // Retention trims the message window, not the established conversation
      // name. Derive it once from the first user message, then preserve it.
      title: chat.messages.some(message => message.role === 'user' && message.text.trim()) ? cleanTitle(chat.title) : titleFor(clean),
      updatedAt: Math.max(chat.updatedAt, Date.now()),
    }), state.document.activeId))
  }
  function remove(projectKey, provider, id) {
    const state = load(projectKey, provider)
    if (!state || !state.document.conversations.some(chat => chat.id === id)) return snapshot(state)
    const conversations = state.document.conversations.filter(chat => chat.id !== id)
    if (!conversations.length) conversations.push(emptyConversation())
    const activeId = state.document.activeId === id ? conversations[0].id : state.document.activeId
    return save(state, documentFor(conversations, activeId))
  }
  return { read, create, select, write, remove }
}
