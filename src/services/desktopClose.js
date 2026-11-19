// The native close transaction waits for the real project save. Do not launch
// another asynchronous save from beforeunload after that transaction succeeds.
export function registerDesktopClose({ api, getProjectState, target = window }) {
  let prepared = false, saving = null
  const save = () => {
    if (!saving) saving = Promise.resolve().then(async () => {
      const state = getProjectState()
      return !state.currentProject || await state.saveProject() === true
    }).finally(() => { saving = null })
    return saving
  }
  const unsubscribe = api?.onPrepareClose?.(async () => {
    prepared = await save()
    return prepared
  })
  const unsubscribeCancel = api?.onCloseCancelled?.(() => { prepared = false })
  const beforeUnload = () => {
    if (!prepared) void save().catch(() => {}) // Browser/reload fallback only.
  }
  target.addEventListener('beforeunload', beforeUnload)
  return () => {
    unsubscribe?.(); unsubscribeCancel?.()
    target.removeEventListener('beforeunload', beforeUnload)
  }
}
