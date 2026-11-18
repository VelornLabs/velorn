'use strict'
const { createHash } = require('node:crypto')

function invalidateContinuity(state) {
  if (!state || typeof state !== 'object') return
  state.epoch = (state.epoch || 0) + 1
  state.record = null
}

// Native grant-owned RAM mapping only. No thread ID/path can come from IPC or
// chat text. Codex owns its normal local session files; this code never copies
// credentials, edits history files, or deletes another application's sessions.
function prepareContinuity(state, identity) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null
  const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  const previous = state.record
  const epoch = (state.epoch || 0) + 1
  state.epoch = epoch
  state.record = null // Consume before a request; uncertain turns are not resumed.
  const matching = previous?.fingerprint === fingerprint
  return {
    threadId: matching ? previous.threadId : null,
    mode: matching ? 'continued' : previous ? 'reset' : 'new',
    commit(threadId) {
      if (state.epoch === epoch && typeof threadId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(threadId)) state.record = { fingerprint, threadId }
    },
    discard() { if (state.epoch === epoch) state.record = null },
  }
}
module.exports = { prepareContinuity, invalidateContinuity }
