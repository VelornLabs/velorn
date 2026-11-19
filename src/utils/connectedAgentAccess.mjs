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

// Velo's Full access runs commands on the computer. That part exists for
// Linux, macOS and Windows; on any other system the card is shown greyed out
// as "coming soon". The native side refuses unsupported systems on its own;
// this only shapes the UI.
export function veloComputerAccessSupported(platform) {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32'
}
