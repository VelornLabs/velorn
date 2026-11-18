'use strict'

// Only errors made at the native pre-turn account checks can prove that no
// prompt was submitted. An auth-mode change during a turn has the same public
// code but cannot safely restore a draft or claim that no actions ran.
const initialAuthFailures = new WeakSet()
function initialCodexAuthFailure(signedIn) {
  const error = Object.assign(new Error(signedIn
    ? 'This connection needs Codex sign-in through ChatGPT. No prompt was sent; API-key billing is not enabled.'
    : 'Sign in to Codex with ChatGPT to continue. No prompt was sent.'), {
    code: signedIn ? 'CODEX_CHATGPT_REQUIRED' : 'CODEX_LOGIN_REQUIRED',
  })
  initialAuthFailures.add(error)
  return error
}
function codexPromptWasNotSent(error) { return initialAuthFailures.has(error) }

module.exports = { initialCodexAuthFailure, codexPromptWasNotSent }
