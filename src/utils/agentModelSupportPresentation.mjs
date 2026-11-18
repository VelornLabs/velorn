// Native qualification metadata is display-only: never a permission or tool
// capability gate. Missing metadata keeps custom/older-server models usable.
export function localModelSupportPresentation(value) {
  const validProfile = typeof value?.profileId === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(value.profileId)
  if (value?.status === 'recommended' && validProfile) return {
    status: 'recommended', label: 'Recommended setup',
    summary: 'This exact setup matches a reviewed Velorn compatibility profile. Review important edits before delivery.',
  }
  if (value?.status === 'unavailable') return {
    status: 'unavailable', label: 'Setup unavailable',
    summary: 'This setup is not currently available. Check the local server and choose an available model.',
  }
  return {
    status: 'experimental', label: 'Experimental in Velorn',
    summary: 'Connected does not mean validated for editing. This setup has not yet matched a reviewed Velorn compatibility profile; you can still use it.',
  }
}

export function localModelOptionLabel(model) {
  const name = typeof model?.displayName === 'string' ? model.displayName : model?.id || ''
  const identity = model?.modelKey && model.id !== model.modelKey ? `${name} (${model.id})` : name
  const loaded = model?.loaded === true ? ` · Loaded${model.contextLength ? ` · ${model.contextLength.toLocaleString('en-US')} context` : ''}`
    : model?.loaded === false ? ' · Not loaded' : ''
  return `${identity}${loaded} · ${localModelSupportPresentation(model?.support).label}`
}
