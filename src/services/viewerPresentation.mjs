/** Owns one viewer's HTML fullscreen and its optional desktop presentation.
 * Keep the existing DOM/video/canvas mounted; native window sizing is separate
 * from HTML fullscreen so macOS need not create a fullscreen Space. */
export function createViewerPresentation({ getElement, documentTarget = document,
  api = globalThis.window?.electronAPI, onChange = () => {} } = {}) {
  let session = null, disposed = false, revision = -1
  const rememberRevision = state => {
    if (Number.isFinite(state?.revision)) revision = Math.max(revision, state.revision)
  }
  const ownsHtml = current => !!current && documentTarget.fullscreenElement === current.element
  const notify = (current, error = null) => {
    if (!disposed) onChange({ active: ownsHtml(current) || !!current?.nativeActive,
      pending: !!current && ['entering', 'exiting'].includes(current.phase), error })
  }
  const clean = current => {
    if (current.cleanup) return current.cleanup
    current.phase = 'exiting'
    notify(current)
    current.cleanup = (async () => {
      let error = null
      try {
        if (ownsHtml(current)) await documentTarget.exitFullscreen()
      } catch (reason) { error = reason }
      try {
        if (current.nativeTouched) {
          const result = await api.setViewerPresentation({ enabled: false })
          rememberRevision(result)
          if (result?.active) throw new Error('Could not exit viewer presentation. Try Escape again.')
          current.nativeActive = false
          current.nativeTouched = false
        }
      } catch (reason) { error = reason }
      if (!ownsHtml(current) && !current.nativeTouched) {
        if (session === current) session = null
        // Restore keyboard focus without scrolling the editor or changing its selection.
        if (!disposed && current.focus?.isConnected) current.focus.focus?.({ preventScroll: true })
        notify(null, error?.message || null)
      } else {
        current.phase = 'active'
        current.cleanup = null // Allow Escape/button to retry a failed restore.
        notify(current, error?.message || 'Could not exit viewer presentation. Try Escape again.')
      }
    })()
    return current.cleanup
  }
  const exit = async () => {
    const current = session
    if (!current) return
    current.wanted = false
    current.phase = 'exiting'
    notify(current)
    // If Escape/unmount races entry, restore only after native entry settles.
    // A new session cannot start until this session is fully cleaned up.
    await current.start
    await clean(current)
  }
  const enter = () => {
    if (disposed || session) return Promise.resolve()
    const element = getElement()
    if (!element) return Promise.resolve()
    if (documentTarget.fullscreenElement) {
      notify(null, 'Exit the current fullscreen view first.')
      return Promise.resolve()
    }
    if (api && typeof api.setViewerPresentation !== 'function') {
      notify(null, 'Restart Velorn to enable the updated fullscreen viewer.')
      return Promise.resolve()
    }
    const current = { element, wanted: true, phase: 'entering', nativeTouched: false,
      nativeActive: false, focus: documentTarget.activeElement, cleanup: null, start: null }
    session = current
    notify(current)
    // Request synchronously within the click's user activation, before IPC.
    let htmlRequest
    try { htmlRequest = element.requestFullscreen() } catch (error) { htmlRequest = Promise.reject(error) }
    current.start = (async () => {
      let error = null
      try {
        await htmlRequest
        if (!current.wanted || disposed || !ownsHtml(current)) return
        if (api) {
          current.nativeTouched = true
          const result = await api.setViewerPresentation({ enabled: true })
          rememberRevision(result)
          current.nativeActive = !!result?.active
          if (!result?.active) throw new Error('Could not enter viewer presentation.')
        }
        if (current.wanted && !disposed && ownsHtml(current)) {
          current.phase = 'active'
          notify(current)
        }
      } catch (reason) { error = reason; current.wanted = false }
      finally {
        if (!current.wanted || disposed || error || !ownsHtml(current)) {
          await clean(current)
          if (error && !disposed) notify(session, error.message || 'Could not open the fullscreen viewer.')
        }
      }
    })()
    return current.start
  }
  const changed = () => {
    if (!session) return
    if (ownsHtml(session)) notify(session)
    else if (session.phase !== 'exiting') void exit()
  }
  documentTarget.addEventListener('fullscreenchange', changed)
  const unsubscribe = api?.onViewerPresentationChanged?.(state => {
    if (!state || !Number.isFinite(state.revision) || state.revision <= revision) return
    revision = state.revision
    if (!state.active && session?.nativeTouched && session.phase !== 'exiting') void exit()
  })
  return {
    enter, exit,
    toggle: () => session ? exit() : enter(),
    dispose() {
      disposed = true
      documentTarget.removeEventListener('fullscreenchange', changed)
      unsubscribe?.()
      return exit()
    },
  }
}
