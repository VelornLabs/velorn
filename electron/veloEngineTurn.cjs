'use strict'
const RECOVERY_DIALOG = Object.freeze({ type: 'warning', title: 'Continue interrupted chat?',
  message: 'Previous actions may already have completed.',
  detail: 'Continue sends only your new message. It will not retry or replay the previous request. Review earlier actions before continuing.',
  buttons: Object.freeze(['Cancel', 'Continue']), defaultId: 0, cancelId: 0, noLink: true })

// Candidate-only pre-dispatch recovery. Do not clear the durable uncertainty
// journal or replay a previous request. Only a native affirmative choice can
// acknowledge uncertainty for this one NEW message.
async function runCandidateTurn({ engine, input, firstInput, developerInstructions, signal,
  assertAuthorized, showRecoveryDialog, onWaiting = () => {} }) {
  const { lunaPreflightFailure } = require('./connectedAgentLuna.cjs')
  const { abortable } = require('./connectedAgentMcpGateway.cjs')
  const cancelled = () => Object.assign(new Error('Continuation cancelled. Your new message was not sent; previous actions were not repeated.'), { code: 'CANCELLED' })
  const check = async () => {
    if (signal?.aborted) throw cancelled()
    await assertAuthorized()
    if (signal?.aborted) throw cancelled()
  }
  let acknowledgeUncertain = false
  try {
    await check()
    const started = await engine.start()
    await check()
    if (started.recoveryRequired === true) {
      let choice
      onWaiting(true)
      try {
        choice = await abortable(Promise.resolve().then(() => {
          if (signal?.aborted) throw cancelled()
          return showRecoveryDialog({ ...RECOVERY_DIALOG, buttons: [...RECOVERY_DIALOG.buttons], signal })
        }), signal)
      } finally { onWaiting(false) }
      if (choice?.response !== 1) throw cancelled()
      // Native account, project, window and access authority may have changed
      // while the modal was open. A previous confirmation cannot restore them.
      await check()
      acknowledgeUncertain = true
    }
    await check()
  } catch (error) {
    // The trusted native marker restores the draft via the existing IPC path.
    // Never brand failures from runTurn: that request may already be billable.
    throw lunaPreflightFailure(error)
  }
  return engine.runTurn({ input, firstInput, developerInstructions, signal, acknowledgeUncertain })
}

module.exports = { runCandidateTurn, RECOVERY_DIALOG }
