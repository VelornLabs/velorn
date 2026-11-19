const authCodes = new Set(['CODEX_LOGIN_REQUIRED', 'CODEX_CHATGPT_REQUIRED'])
const modelId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value)

/** Readiness is metadata only: never a claim that inference or tools work. */
export function agentEntryReadiness(result, { provider, model = '' } = {}) {
  if (provider === 'luna') {
    if (result?.success === true && result.provider === 'luna' && result.available === true && result.eligible === true) return { phase: 'ready' }
    return { phase: 'problem', reason: 'Velo is available only to approved Velorn accounts with a remaining allowance. Check the connection; no Codex installation or login is needed.' }
  }
  if (provider === 'codex') {
    if (result?.success === true && result.available === true) return { phase: 'ready', codexState: 'ready' }
    if (result?.code === 'CODEX_NOT_FOUND') return { phase: 'unconfigured', codexState: 'missing', reason: 'Connect Codex to use your ChatGPT account as an editing assistant.' }
    if (authCodes.has(result?.code)) return { phase: 'unconfigured', codexState: 'signin', reason: 'Codex is installed. Sign in with ChatGPT when you’re ready to use it.' }
    return { phase: 'problem', codexState: 'problem', reason: 'Codex could not be checked. Reconnect it or review the connection settings.' }
  }
  if (provider === 'lmstudio') {
    if (result?.success !== true) return { phase: 'problem', reason: 'LM Studio could not be reached. Open its local server, then check the connection.' }
    if (!modelId(model)) return { phase: 'unconfigured', reason: 'Choose a local model in LM Studio, then select it for your agent.' }
    const selected = Array.isArray(result.models) && result.models.slice(0, 256).find(item => item?.id === model)
    if (result.available === true && selected && (selected.loaded === true || result.loadedModelStatus !== 'available')) return { phase: 'ready' }
    return { phase: 'unconfigured', reason: 'Your selected local model is not currently available. Load it in LM Studio or choose another model.' }
  }
  return { phase: 'problem', reason: 'This agent connection could not be checked.' }
}

export const AGENT_ENTRY_INTENT_KEY = 'velorn.agent-entry-intent.v1'

/** An invitation, never a connection monitor. Only explicit checks report readiness. */
export function createAgentEntryGuide({ getSelection, storage, hasPriorIntent = false } = {}) {
  let acknowledged = hasPriorIntent
  try { acknowledged ||= JSON.parse(storage?.getItem(AGENT_ENTRY_INTENT_KEY))?.acknowledged === true } catch { /* Optional device preference. */ }
  let state = { phase: acknowledged ? 'idle' : 'choice', dismissed: acknowledged }
  let lastResult = null, lastSelection = null
  const listeners = new Set()
  const emit = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener() }
  function remember() {
    acknowledged = true
    try { storage?.setItem(AGENT_ENTRY_INTENT_KEY, JSON.stringify({ acknowledged: true })) } catch { /* Keep dismissal for this session when storage is unavailable. */ }
  }
  function acknowledge() {
    remember(); lastResult = null; lastSelection = null
    emit({ phase: 'idle', dismissed: true, codexState: undefined, reason: undefined })
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    observe(result) {
      remember(); lastResult = result; lastSelection = { ...getSelection() }
      // Skipping an invitation does not hide help for a later explicit failure.
      emit({ ...agentEntryReadiness(result, lastSelection), dismissed: false })
    },
    selectionChanged() {
      const selection = getSelection()
      if (lastResult && selection.provider === lastSelection?.provider && selection.endpoint === lastSelection?.endpoint) {
        lastSelection = { ...selection }; emit(agentEntryReadiness(lastResult, selection))
      } else if (lastResult) {
        lastResult = null; lastSelection = null; emit({ phase: 'idle', codexState: undefined, reason: undefined })
      }
    },
    invalidate() {
      lastResult = null; lastSelection = null; emit({ phase: 'idle', codexState: undefined, reason: undefined })
    },
    acknowledge,
    skip: acknowledge,
  }
}
