// Provider selection is explicit. These labels never imply account entitlement
// or authorize a model turn; the native connection verifies each request.
export const CONNECTED_AGENT_PROVIDERS = Object.freeze(['codex', 'lmstudio', 'luna'])
export const FUNDED_LUNA_MODEL = 'gpt-6-luna'
export const FUNDED_LUNA_REASONING = 'low'
// A known model label is not proof of funded access. Native status/turn checks
// still decide eligibility; the phone need not display an empty picker meanwhile.
export function fundedLunaModels() {
  return [{ id: FUNDED_LUNA_MODEL, displayName: 'GPT-6 Luna', defaultReasoningEffort: FUNDED_LUNA_REASONING,
    supportedReasoningEfforts: [{ reasoningEffort: FUNDED_LUNA_REASONING }] }]
}
export const FUNDED_LUNA_DISCLOSURE = 'Send shares your message, relevant chat history, project context, selected images and enabled tool results with the Velorn service and OpenAI for GPT-6 Luna processing. Available only to accounts with a funded allowance; no personal Codex login is used. No automatic fallback.'
export function connectedAgentProviderLabel(provider) {
  return ({ codex: 'Codex', lmstudio: 'LM Studio', luna: 'Velo' })[provider] || 'Unknown provider'
}
export function connectedAgentModelSelection(provider, value) {
  return provider === 'luna' ? FUNDED_LUNA_MODEL : typeof value === 'string' ? value.slice(0, 256) : ''
}
export function fundedLunaAvailability(result) {
  if (result?.success === true && result.provider === 'luna' && result.available === true && result.eligible === true) {
    return { available: true, message: 'Velo is available for this account. Usage is limited to its funded allowance.' }
  }
  const messages = {
    'not-eligible': 'This account does not have Velo access yet. Open View Velo access for account details and help.',
    exhausted: 'Your Velo allowance is used up. There are no automatic refills. Open View Velo access for details.',
  }
  return { available: false, message: messages[result?.status] || 'Velo access could not be checked. Open your Velorn account to refresh it. No other agent will be used automatically.' }
}
export const VELO_DESCRIPTION = 'Velorn’s built-in AI assistant.'

