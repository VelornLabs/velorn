// Device-local setup hints only. Never initialize live permissions from these
// values: restoring a setup requires a user action and Full requires native consent.
export function readAccessSetup(settings, provider) {
  const value = settings?.accessSetups?.[provider]
  const mode = ['chat', 'work', 'full'].includes(value?.mode) ? value.mode : 'chat'
  return {
    mode,
    shareImagesAndView: value?.shareImagesAndView === true,
  }
}

export function accessSetupPreferences(settings, provider, setup) {
  const next = { codex: readAccessSetup(settings, 'codex'), lmstudio: readAccessSetup(settings, 'lmstudio'), luna: readAccessSetup(settings, 'luna') }
  if (['codex', 'lmstudio', 'luna'].includes(provider)) {
    next[provider] = readAccessSetup({ accessSetups: { [provider]: setup } }, provider)
  }
  return next
}

export function activeAccessMode({ fullAccessEnabled, toolsEnabled, researchEnabled }) {
  if (fullAccessEnabled) return 'full'
  if (!toolsEnabled) return 'chat'
  return researchEnabled ? 'work' : 'custom'
}
