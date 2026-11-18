'use strict'
const { createHash } = require('node:crypto')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const recipients = Object.freeze({ codex: 'openai', lmstudio: 'local-lmstudio', luna: 'velorn-openai' })
const flags = Object.freeze(['tools', 'research', 'fullAccess', 'images', 'view'])
const failures = new WeakSet()
function sharingFailure() {
  const error = Object.assign(new Error('AI sharing permission changed or could not be verified. No message was sent. Review the permission on your phone and try again.'), { code: 'AI_SHARING_CHANGED' })
  failures.add(error)
  return error
}
function sharingPromptWasNotSent(error) { return failures.has(error) }
function descriptor(provider, capabilities) {
  if (!Object.hasOwn(recipients, provider) || !object(capabilities)
    || Object.keys(capabilities).length !== flags.length || flags.some(key => typeof capabilities[key] !== 'boolean')
    || capabilities.research && !capabilities.tools || capabilities.fullAccess && !capabilities.tools
    || capabilities.view && !capabilities.images) return null
  const value = { version: 1, provider, recipient: recipients[provider], capabilities: Object.fromEntries(flags.map(key => [key, capabilities[key]])) }
  return { version: 1, provider, recipient: value.recipient,
    disclosureKey: createHash('sha256').update(JSON.stringify(value)).digest('hex'), capabilities: value.capabilities }
}
function publicationSharing(value) {
  if (value.protocol !== 3 || value.aiSharingVersion !== 1) return null
  const result = descriptor(value.provider, value.aiSharingCapabilities)
  if (!result || result.capabilities.tools !== (value.toolsEnabled === true)
    || result.capabilities.research !== (value.toolsEnabled === true && value.researchEnabled === true)
    || result.capabilities.fullAccess !== (value.fullAccess === true)) return null
  return result
}
function validConsent(value) {
  return object(value) && Object.keys(value).length === 4 && value.version === 1
    && Object.hasOwn(recipients, value.provider) && value.recipient === recipients[value.provider]
    && typeof value.disclosureKey === 'string' && /^[a-f0-9]{64}$/.test(value.disclosureKey)
}
function consentMatches(consent, sharing) {
  return validConsent(consent) && object(sharing) && ['version', 'provider', 'recipient', 'disclosureKey'].every(key => consent[key] === sharing[key])
}
function requestSharing(request) {
  return descriptor(request.provider, { tools: request.toolsEnabled === true, research: request.researchEnabled === true,
    fullAccess: request.fullAccess === true, images: request.allowToolImages === true, view: request.mobileSharing?.view === true })
}
module.exports = { descriptor, publicationSharing, validConsent, consentMatches, requestSharing, sharingFailure, sharingPromptWasNotSent }
