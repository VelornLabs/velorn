// Asks Velo (Velorn's built-in agent) to write a director script from the
// music video brief: one quiet request, no tools, nothing added to the chat.
//
// It goes through the same native connection as the chat panel
// (`connectedAgent.send`), so the account, the allowance and the privacy
// rules are enforced there, not here. This file only shapes the request and
// checks the answer.
//
// Known limits of that connection, handled or reported below:
//   - one request at a time: starting this would cut off a running chat, so
//     we refuse while another request has been active in the last few seconds
//   - 16 KB per message: a long brief is sent as several messages
//   - plain replies normally stop at two minutes; `longReply` asks for the
//     ten-minute limit, since a full script takes about that long to write

export const VELO_PROVIDER = 'luna'
const MESSAGE_BYTES = 15000
const BUSY_WINDOW_MS = 4000
const FORMAT_REMINDER = 'Return only the director script, in exactly the format the brief describes, starting with the first shot. No introduction, no commentary, no code fences.'

const byteLength = (text) => new TextEncoder().encode(text).length

// Splits a long brief on line breaks into messages under the size limit.
export function splitBriefIntoMessages(brief, maxBytes = MESSAGE_BYTES) {
  const text = String(brief || '').trim()
  if (!text) return []
  const chunks = []
  let current = ''
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line
    if (byteLength(candidate) <= maxBytes) { current = candidate; continue }
    if (current) chunks.push(current)
    current = line
    while (byteLength(current) > maxBytes) {
      // A single enormous line: cut it by characters.
      let cut = Math.min(current.length, maxBytes)
      while (cut > 1 && byteLength(current.slice(0, cut)) > maxBytes) cut = Math.floor(cut * 0.9)
      chunks.push(current.slice(0, cut))
      current = current.slice(cut)
    }
  }
  if (current) chunks.push(current)
  if (chunks.length === 1) return [{ role: 'user', content: chunks[0] }]
  return chunks.map((chunk, index) => ({
    role: 'user',
    content: `[Brief, part ${index + 1} of ${chunks.length}${index + 1 < chunks.length ? ' — more follows, do not answer yet' : ' — this is the last part'}]\n${chunk}`,
  }))
}

// Removes the wrapping a model sometimes adds around the script.
export function cleanScriptAnswer(answer) {
  let text = String(answer || '').replace(/\r/g, '').trim()
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  if (fenced) text = fenced[1].trim()
  return text.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim()
}

export function countScriptShots(text) {
  return (String(text || '').match(/^[ \t#*>-]*shot\s+\d+\b/gim) || []).length
}

const FRIENDLY = {
  LUNA_EXHAUSTED: 'Your Velo allowance is used up. You can still write the script with your own AI below.',
  LUNA_NOT_ELIGIBLE: 'This account does not have Velo yet. You can write the script with your own AI below.',
  LUNA_UNAVAILABLE: 'Velo is not available right now. You can write the script with your own AI below.',
  LUNA_BUSY: 'Velo is busy. Try again in a moment.',
  LUNA_REQUEST_LIMIT: 'This song and brief are too long for Velo in one go. You can write the script with your own AI below.',
  TIMEOUT: 'Velo took too long to answer. Try again, or write the script with your own AI below.',
  CANCELLED: 'Stopped.',
}

export function describeVeloFailure(result) {
  const code = String(result?.code || '')
  // Keep the cause visible to developers; the screen shows the plain version.
  if (code || result?.error) console.warn('[Velo script]', code || 'no code', result?.error || '')
  return FRIENDLY[code] || result?.error || 'Velo could not write the script. Try again, or use your own AI below.'
}

// Tracks whether another agent request (the chat panel) is running, by
// watching the shared event stream. `mine` holds this module's request ids.
export function createBusyWatcher(now = () => Date.now()) {
  const mine = new Set()
  let lastForeign = -Infinity
  return {
    mine,
    see(event) { if (event?.requestId && !mine.has(event.requestId)) lastForeign = now() },
    busy() { return now() - lastForeign < BUSY_WINDOW_MS },
  }
}

let watcher = null
let stopWatching = null
function ensureWatcher(api) {
  if (watcher) return watcher
  watcher = createBusyWatcher()
  if (typeof api?.onEvent === 'function') stopWatching = api.onEvent((event) => watcher.see(event))
  return watcher
}
export function startWatchingVelo(api) { ensureWatcher(api) }
export function resetVeloWatcherForTests() { stopWatching?.(); watcher = null; stopWatching = null }

/**
 * Writes the script. Resolves with { success, text, shots } or
 * { success: false, code, error }. `onText` receives the text so far.
 * Aborting `signal` stops Velo and resolves with code 'CANCELLED'.
 */
export async function writeScriptWithVelo({ api, brief, onText, signal, makeId = () => Math.random().toString(36).slice(2, 12) } = {}) {
  if (typeof api?.send !== 'function') return { success: false, code: 'LUNA_UNAVAILABLE', error: FRIENDLY.LUNA_UNAVAILABLE }
  const messages = splitBriefIntoMessages(brief)
  if (!messages.length) return { success: false, code: 'EMPTY', error: 'There is nothing to write a script from yet.' }
  const watch = ensureWatcher(api)
  if (watch.busy()) return { success: false, code: 'LUNA_BUSY', error: 'Velo is busy in the chat. Wait for it to finish, then try again.' }

  const stopped = () => ({ success: false, code: 'CANCELLED', error: FRIENDLY.CANCELLED })
  if (signal?.aborted) return stopped()

  const ask = async (outbound) => {
    const requestId = `mvscript-${makeId()}`
    watch.mine.add(requestId)
    // Stop asks the native side to end this exact request.
    const cancel = () => { try { Promise.resolve(api.cancel?.({ requestId })).catch(() => {}) } catch { /* nothing to stop */ } }
    signal?.addEventListener('abort', cancel, { once: true })
    let soFar = ''
    const stop = typeof api.onEvent === 'function'
      ? api.onEvent((event) => {
        if (event?.requestId !== requestId || event.type !== 'delta' || typeof event.text !== 'string') return
        soFar += event.text
        onText?.(soFar)
      })
      : null
    try {
      // Velo's engine needs a conversation to file the request under. Each
      // script gets its own, so no earlier brief leaks into this one.
      return await api.send({ requestId, conversationId: requestId, provider: VELO_PROVIDER, toolsEnabled: false, vision: false, longReply: true, messages: outbound, context: {} })
    } catch (error) {
      return { success: false, error: error?.message || '' }
    } finally {
      stop?.()
      signal?.removeEventListener('abort', cancel)
    }
  }

  let result = await ask(messages)
  if (signal?.aborted) return stopped()
  if (!result?.success) return { success: false, code: result?.code || 'FAILED', error: describeVeloFailure(result) }
  let text = cleanScriptAnswer(result.text)
  if (countScriptShots(text) === 0) {
    // One more try with a firm reminder; never more, each try spends allowance.
    const retry = [...messages.slice(0, -1), { role: 'user', content: `${messages.at(-1).content}\n\n${FORMAT_REMINDER}` }]
    result = await ask(retry)
    if (signal?.aborted) return stopped()
    if (!result?.success) return { success: false, code: result?.code || 'FAILED', error: describeVeloFailure(result) }
    text = cleanScriptAnswer(result.text)
    if (countScriptShots(text) === 0) return { success: false, code: 'BAD_FORMAT', error: 'Velo answered, but not with a script Velorn can read. Try again, or use your own AI below.' }
  }
  return { success: true, text, shots: countScriptShots(text) }
}
