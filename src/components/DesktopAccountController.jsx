import { useEffect, useRef, useState } from 'react'

// Application-level account controls. No project, chat, model choice or phone
// snapshot is required. Credentials and all authority remain native-only.
export function useDesktopAccountController() {
  const api = window.electronAPI?.mobileCompanion
  const supported = api?.desktopAccountVersion === 1 && typeof api.desktopAccount === 'function'
  const [preference, setPreference] = useState(null), [notice, setNotice] = useState('')
  const [changing, setChanging] = useState(false), [nameDraft, setNameDraft] = useState(null)
  const alive = useRef(false), epoch = useRef(0), locked = useRef(false)
  const connection = preference?.status
  const name = connection?.guided?.computer?.name || connection?.guided?.computerName || 'My computer'
  useEffect(() => { setNameDraft(null) }, [connection?.guided?.computer?.id])
  useEffect(() => {
    if (!supported) return
    alive.current = true
    const refresh = async () => {
      if (locked.current) return
      const read = ++epoch.current
      try {
        const result = await api.getPreference()
        if (alive.current && read === epoch.current && result?.success) {
          setPreference(result); setNotice(value => value === 'Account status could not be checked. Try again shortly.' ? '' : value)
        }
      } catch { if (alive.current && read === epoch.current) setNotice('Account status could not be checked. Try again shortly.') }
    }
    void refresh()
    const timer = setInterval(refresh, 2500)
    const off = api.onEvent?.(event => { if (event?.type === 'status') void refresh() })
    return () => { alive.current = false; epoch.current++; clearInterval(timer); off?.() }
  }, [api, supported])
  async function perform(action, fields = {}) {
    if (!supported || locked.current) return
    locked.current = true; epoch.current++; setChanging(true); setNotice('')
    try {
      // Invoke before the first await: preload requires the actual click's
      // transient user activation. Polling never calls this method.
      const result = await api.desktopAccount({ action, ...fields })
      if (!result?.success) throw Error(result?.error || 'The account action could not finish. Try again.')
      if (alive.current) { setPreference(value => ({ ...value, status: result.status })); if (!result.cancelled) setNameDraft(null) }
    } catch (error) { if (alive.current) setNotice(error.message) }
    finally { locked.current = false; if (alive.current) setChanging(false) }
  }
  return supported ? { scopeKey: 'desktop-account', mobile: {
    connection, guidedAvailable: preference?.guidedAvailable === true,
    enabled: connection?.enabled === true || connection?.guided?.enabled === true,
    changing, notice, computerName: nameDraft ?? name, setComputerName: setNameDraft,
    connectPhoneAccount: () => connection?.guided?.registered
      ? perform('enable-phone') : perform('sign-in', { name: nameDraft ?? name }),
    manageDesktopAccount: action => perform(action),
    disconnectPhoneDevice: deviceId => perform('disconnect-device', { deviceId }),
    disable: () => perform('disable-phone'),
    refreshAccount: () => perform('refresh'),
  } } : null
}
