import test from 'node:test'
import assert from 'node:assert/strict'
import { CONNECTED_AGENT_PROVIDERS, connectedAgentProviderLabel, connectedAgentModelSelection, fundedLunaAvailability, fundedLunaModels, FUNDED_LUNA_DISCLOSURE, VELO_DESCRIPTION } from './connectedAgentProviders.mjs'
import { createConnectedAgentConversationStore } from './connectedAgentConversations.mjs'
import { agentEntryReadiness } from './agentEntryGuide.mjs'

test('Velo is a display name, not a provider, model, history or consent migration', () => {
  assert.equal(connectedAgentProviderLabel('luna'), 'Velo')
  assert.equal(VELO_DESCRIPTION, 'Velorn’s built-in AI assistant.')
  assert.equal(connectedAgentProviderLabel('velo'), 'Unknown provider')
  assert.equal(connectedAgentProviderLabel('codex'), 'Codex')
  assert.equal(connectedAgentProviderLabel('lmstudio'), 'LM Studio')
  assert.equal(connectedAgentProviderLabel('vee'), 'Unknown provider')
  assert.equal(fundedLunaModels()[0].id, 'gpt-6-luna')
  assert.equal(fundedLunaModels()[0].displayName, 'GPT-6 Luna')
  assert.match(FUNDED_LUNA_DISCLOSURE, /Velorn service and OpenAI/)
  assert.match(FUNDED_LUNA_DISCLOSURE, /funded allowance/)
  for (const status of ['not-eligible', 'exhausted', 'unavailable']) assert.match(fundedLunaAvailability({ status }).message, /Velo/)
})

test('funded Luna is explicit, fixed-model, and not available from a malformed or different provider receipt', () => {
  assert.deepEqual(CONNECTED_AGENT_PROVIDERS, ['codex', 'lmstudio', 'luna'])
  for (const value of [undefined, '', 'custom-model', 'gpt-6-astra']) assert.equal(connectedAgentModelSelection('luna', value), 'gpt-6-luna')
  for (const value of [null, {}, { available: true }, { success: true, available: true, eligible: true, provider: 'codex' }]) assert.equal(fundedLunaAvailability(value).available, false)
  const receipt = { success: true, provider: 'luna', available: true, eligible: true }
  assert.equal(fundedLunaAvailability(receipt).available, true)
  assert.equal(agentEntryReadiness(receipt, { provider: 'luna' }).phase, 'ready')
  assert.match(fundedLunaAvailability({ status: 'exhausted' }).message, /used up/)
  assert.match(fundedLunaAvailability({ status: 'not-eligible' }).message, /does not have/)
  for (const status of ['not-eligible', 'exhausted', 'unavailable']) assert.doesNotMatch(fundedLunaAvailability({ status }).message, /draft|no message was sent/i, 'availability can change after earlier tool work, so it cannot assert delivery state')
})

test('third provider history never inherits either preexisting provider and is durable under its own key', () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const history = createConnectedAgentConversationStore({ storage })
  for (const provider of CONNECTED_AGENT_PROVIDERS) {
    const state = history.read('synthetic-project', provider)
    assert.deepEqual(state.conversations[0].messages, [])
    history.write('synthetic-project', provider, state.activeId, [{ role: 'user', text: `Only ${provider}` }])
  }
  for (const provider of CONNECTED_AGENT_PROVIDERS) assert.equal(history.read('synthetic-project', provider).conversations[0].messages[0].text, `Only ${provider}`)
  assert.equal([...values.keys()].filter(key => key.includes('.luna.')).length, 1)
})
