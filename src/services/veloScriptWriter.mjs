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
//     ten-minute limit
//   - one answer is short: on most computers Velo answers through the Velorn
//     service, which ends an answer at about 4,000 tokens and 45 seconds and
//     reports a cut-off answer as a failure. A whole script is several times
//     that, so it is asked for a few shots at a time and joined here.

export const VELO_PROVIDER = 'luna'
const MESSAGE_BYTES = 15000
const BUSY_WINDOW_MS = 4000
const FORMAT_REMINDER = 'Return only the director script, in exactly the format the brief describes, starting with the first shot. No introduction, no commentary, no code fences.'

// How many shots are asked for in one answer, and in the one retry after an
// answer that was too long for the service.
const SHOTS_PER_PART = 8
const SHOTS_PER_SMALL_PART = 4
// A song's script is never this many parts; it only stops a runaway.
const PARTS_MAX = 40
// What is sent back of the script so far: the last shots in full, and only
// the headings and times of the ones before.
const RECENT_BYTES = 7000
const OUTLINE_BYTES = 12000
const MORE = '[[MORE]]'
const END = '[[END]]'

const partRule = (shots) => `Write at most ${shots} shots in this answer, then stop after a complete shot block. If shots are still left to write after that, end the answer with a last line that says exactly ${MORE}. If the script is complete, end with a last line that says exactly ${END}. Never stop in the middle of a shot.`
const firstPartAsk = (shots) => `The script is written in parts, because one answer has a length limit. Start at the beginning of the script. ${partRule(shots)}`
const nextPartAsk = (shots) => `Continue the script exactly where it stopped, with the next shot. Keep the same format, the same headings and the shot numbering going. Do not repeat or rewrite any shot that is already written. ${partRule(shots)}`

const byteLength = (text) => new TextEncoder().encode(text).length

// Takes the marker off the end of a part and says what it was.
export function readScriptPart(answer) {
  const text = cleanScriptAnswer(answer)
  const marker = text.includes(MORE) ? 'more' : text.includes(END) ? 'end' : ''
  return { text: cleanScriptAnswer(text.replaceAll(MORE, '').replaceAll(END, '')), marker }
}

// The script so far, as the messages Velo is shown before it continues.
export function scriptSoFarMessages(script) {
  const text = String(script || '').trim()
  if (!text) return []
  if (byteLength(text) <= RECENT_BYTES) return [{ role: 'assistant', content: text }]
  // Cut at the start of a shot, so the recent part is whole shots.
  const starts = [...text.matchAll(/^[ \t#*>-]*shot\s+\d+\b/gim)].map((match) => match.index)
  const cut = starts.find((index) => byteLength(text.slice(index)) <= RECENT_BYTES) ?? starts.at(-1) ?? 0
  if (cut <= 0) return [{ role: 'assistant', content: text.slice(-RECENT_BYTES) }]
  let outline = text.slice(0, cut).split('\n')
    .filter((line) => /^[ \t#*>-]*(shot\s+\d+|scene\s+\d+|coverage\b|start at\s*:|length\s*:)/i.test(line)).join('\n')
  while (byteLength(outline) > OUTLINE_BYTES) outline = outline.slice(outline.indexOf('\n', Math.floor(outline.length * 0.1)) + 1)
  return [
    { role: 'assistant', content: `[Shots already written, shown here only by their headings and times]\n${outline}` },
    { role: 'assistant', content: text.slice(cut).trim() },
  ]
}

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
  LUNA_SERVICE_UNAVAILABLE: 'Velo could not finish its answer. Try again, or write the script with your own AI below.',
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
 * Writes the script, a few shots at a time. Resolves with { success, text,
 * shots } or { success: false, code, error }. When Velo fails part of the way
 * through, what it wrote is still returned, with `partial` and a `warning`.
 * `onText` receives the text so far.
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

  const ask = async (outbound, shown = '') => {
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
        onText?.(shown + soFar)
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

  // The brief, then what is asked for in this answer.
  const withAsk = (list, asking) => [...list.slice(0, -1), { role: list.at(-1).role, content: `${list.at(-1).content}\n\n${asking}` }]
  let text = ''
  let partial = ''
  for (let part = 0; part < PARTS_MAX; part++) {
    const before = text ? [...messages, ...scriptSoFarMessages(text)] : null
    const outbound = (shots) => (before ? [...before, { role: 'user', content: nextPartAsk(shots) }] : withAsk(messages, firstPartAsk(shots)))
    const shown = text ? `${text}\n\n` : ''
    let result = await ask(outbound(SHOTS_PER_PART), shown)
    if (signal?.aborted) return stopped()
    // The answer was cut off: once more, asking for less.
    if (!result?.success && result?.code === 'LUNA_SERVICE_UNAVAILABLE') {
      result = await ask(outbound(SHOTS_PER_SMALL_PART), shown)
      if (signal?.aborted) return stopped()
    }
    if (!result?.success) {
      // What was already written is kept, not thrown away.
      if (text) { partial = describeVeloFailure(result); break }
      return { success: false, code: result?.code || 'FAILED', error: describeVeloFailure(result) }
    }
    let piece = readScriptPart(result.text)
    if (!text && countScriptShots(piece.text) === 0) {
      // One more try with a firm reminder; never more, each try spends allowance.
      result = await ask(withAsk(messages, `${FORMAT_REMINDER}\n\n${firstPartAsk(SHOTS_PER_PART)}`), shown)
      if (signal?.aborted) return stopped()
      if (!result?.success) return { success: false, code: result?.code || 'FAILED', error: describeVeloFailure(result) }
      piece = readScriptPart(result.text)
      if (countScriptShots(piece.text) === 0) return { success: false, code: 'BAD_FORMAT', error: 'Velo answered, but not with a script Velorn can read. Try again, or use your own AI below.' }
    }
    // A later part with no shots in it means there was nothing left to write.
    if (countScriptShots(piece.text) === 0) break
    text = text ? `${text}\n\n${piece.text}` : piece.text
    onText?.(text)
    if (piece.marker !== 'more') break
  }
  if (partial) return { success: true, text, shots: countScriptShots(text), partial: true, warning: `Velo stopped before the script was finished, so this is only the first part. ${partial}` }
  return { success: true, text, shots: countScriptShots(text) }
}
