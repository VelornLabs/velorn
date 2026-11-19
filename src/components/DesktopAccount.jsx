import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { UserRound, X, Smartphone, Monitor } from 'lucide-react'
import { createDesktopAccountState, desktopAccountIdentity, desktopAccountEmail, desktopAccountStatus, desktopVeeStatus } from './DesktopAccountState.mjs'
import { trapDialogFocus } from '../utils/dialogFocus.mjs'
import './DesktopAccount.css'
import { useDesktopAccountController } from './DesktopAccountController'
import { getGpuShare, gpuShareActivity, subscribeGpuShare } from '../services/gpuShareState'
import { VeloAllowance, useVeloAllowance, veloAllowanceNotice } from './VeloAllowance'

const AccountContext = createContext(null)
const EMPTY = Object.freeze({ live: null, preference: null, checking: false, error: '', hasProject: false })
const emptySubscribe = () => () => {}
const emptySnapshot = () => EMPTY

export function DesktopAccountProvider({ children, hasProject = false, onRequestAgent }) {
  const [store] = useState(createDesktopAccountState)
  const independent = useDesktopAccountController()
  const independentOwner = useRef({ current: null })
  independentOwner.current.current = independent
  useLayoutEffect(() => { store.account(independent ? independentOwner.current : null) }, [store, independent])
  const request = useRef(onRequestAgent); request.current = onRequestAgent
  const alive = useRef(true), reads = useRef(0)
  const [context] = useState(() => ({ store,
    requestAgent: () => request.current?.(),
    async refresh() {
      const epoch = ++reads.current
      store.reading()
      try {
        const preference = await window.electronAPI?.mobileCompanion?.getPreference?.()
        if (alive.current && reads.current === epoch) store.preference(preference || null)
      } catch {
        if (alive.current && reads.current === epoch) store.preference(null, 'Account status could not be checked. Close this panel and try again.')
      }
    },
  }))
  useLayoutEffect(() => { store.setProject(hasProject) }, [store, hasProject])
  useEffect(() => { alive.current = true; void context.refresh(); return () => { alive.current = false; reads.current++ } }, [context, hasProject])
  return <AccountContext.Provider value={context}>{children}</AccountContext.Provider>
}

export function useOpenDesktopAccount() {
  const context = useContext(AccountContext)
  return () => context?.store.open()
}

// Deliberately consumes only the stable context, not the changing snapshot.
// Publishing never rerenders this bridge or the agent conversation. Ownership
// identity prevents an old project cleanup from removing its replacement.
export function DesktopAccountBridge({ mobile, disabled = false, scopeKey, onOpenAdvanced }) {
  const context = useContext(AccountContext)
  const [owner] = useState(() => ({ current: null }))
  owner.current = { mobile, disabled, scopeKey, onOpenAdvanced }
  useLayoutEffect(() => { context?.store.publish(owner) })
  useLayoutEffect(() => () => context?.store.release(owner), [context, owner])
  return null
}

export function DesktopAccountButton({ disabled = false }) {
  const context = useContext(AccountContext)
  const state = useSyncExternalStore(context?.store.subscribe || emptySubscribe, context?.store.getSnapshot || emptySnapshot, emptySnapshot)
  const [open, setOpen] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState('')
  const [renaming, setRenaming] = useState(false)
  const button = useRef(null), sheet = useRef(null), actionLock = useRef(false), mounted = useRef(true)
  const returnFocus = useRef(null)
  const titleId = useId(), descriptionId = useId(), nameId = useId()
  const live = state.independent?.current || (state.hasProject ? state.live?.current : null)
  const mobile = live?.mobile
  // Project-bound legacy operations keep the existing conversation owner;
  // account sign-in/sharing still uses the independent account controller.
  const projectLive = state.hasProject ? state.live?.current : null
  const connection = live ? mobile?.connection : state.preference?.status
  const guided = connection?.guided
  const { displayName, initials } = desktopAccountIdentity(connection)
  const email = desktopAccountEmail(connection)
  const [veeRefresh, setVeeRefresh] = useState(0)
  const registered = guided?.registered === true
  // Only a computer that shares its GPU ever sees this: a job running here, or one waiting for an answer.
  const shareState = useSyncExternalStore(subscribeGpuShare, getGpuShare).state
  const shareActivity = gpuShareActivity(shareState)
  // connection.enabled can mean only that the background service is running.
  // Sharing is governed by the guided preference or an actual legacy listener.
  const privateSharingOnly = connection?.legacyEnabled === true && guided?.enabled !== true
  useEffect(() => { setRenaming(false) }, [registered, live?.scopeKey])
  const phasePending = ['sign-in', 'confirm-account'].includes(guided?.phase)
  const usable = Boolean(live && mobile?.guidedAvailable)
  const accountControlsReady = window.electronAPI?.mobileCompanion?.desktopAccountControlsVersion === 1
  const blocked = disabled || live?.disabled || state.live?.current?.disabled || mobile?.changing || working
  const previousScope = useRef(live?.scopeKey)
  const close = () => { setOpen(false); setError(''); setRenaming(false); if (!mobile?.changing) mobile?.setComputerName?.(null) }
  const veeKey = JSON.stringify([live?.scopeKey, guided?.computer?.id, guided?.account, registered, guided?.enabled, guided?.phase])
  const allowance = useVeloAllowance({ enabled: Boolean(open && registered && live && guided.phase !== 'account-unavailable'), accountKey: veeKey, revision: veeRefresh })
  const veeText = !registered ? 'Connect a Velorn account to check access'
    : !live ? 'Open a project to check availability'
      : guided.phase === 'account-unavailable' ? 'Account connection unavailable'
          : allowance.checking ? 'Checking availability…' : veloAllowanceNotice(allowance.result) || desktopVeeStatus(allowance.result)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (disabled || (previousScope.current && previousScope.current !== live?.scopeKey)) close()
    previousScope.current = live?.scopeKey
  }, [disabled, live?.scopeKey])
  useLayoutEffect(() => {
    if (!open) return undefined
    const dialog = sheet.current
    const focusStart = () => (dialog?.querySelector('[data-account-close]') || dialog)?.focus()
    focusStart()
    // Prevent focus and editor keyboard commands leaking behind the sheet.
    const focus = event => { if (dialog && !dialog.contains(event.target)) focusStart() }
    // A button disabled by its own async action can leave focus on <body>
    // without focusin. Keep Escape/Tab inside the modal in that transition.
    const keyboard = event => {
      if (event.key === 'Escape' || event.key === 'Tab') keys(event)
      else if (dialog && !dialog.contains(event.target)) { event.stopPropagation(); focusStart() }
    }
    document.addEventListener('focusin', focus)
    document.addEventListener('keydown', keyboard, true)
    return () => { document.removeEventListener('focusin', focus); document.removeEventListener('keydown', keyboard, true); (returnFocus.current?.isConnected ? returnFocus.current : button.current)?.focus() }
  }, [open])
  const show = () => {
    if (disabled) return
    if (!open) returnFocus.current = document.activeElement
    setOpen(true); setError('')
    if (!context?.store.current()) {
      void context?.refresh()
      if (state.hasProject) context?.requestAgent()
    }
  }
  useEffect(() => { if (state.openRequest) show() }, [state.openRequest])
  async function act(method, ...args) {
    const current = context?.store.current()
    if (!current || current.disabled || state.live?.current?.disabled || disabled || current.mobile?.changing || actionLock.current || !current.mobile?.guidedAvailable) return
    if (typeof current.mobile[method] !== 'function') return
    // Every click resolves the live bridge again, never a callback retained
    // from a previous project or provider. The native scope remains authority.
    actionLock.current = true; setWorking(true); setError('')
    try { await current.mobile[method](...args) }
    catch (failure) { if (mounted.current && context.store.current()?.scopeKey === current.scopeKey) setError(failure?.message || 'The account action could not finish. Try again.') }
    finally { actionLock.current = false; if (mounted.current) setWorking(false) }
  }
  function keys(event) {
    event.stopPropagation()
    if (event.key === 'Escape' && !(event.nativeEvent || event).isComposing) { event.preventDefault(); close(); return }
    trapDialogFocus(event, sheet.current)
  }
  if (!context) return null
  return <>
    <button ref={button} type="button" className="desktop-account-button no-drag" aria-label="Velorn account" title={displayName ? `Velorn account · ${displayName}` : 'Velorn account'}
      aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => open ? close() : show()}>
      {initials ? <span aria-hidden="true">{initials}</span> : <UserRound size={17} aria-hidden="true" />}
      {shareActivity && <span className={`desktop-account-dot${shareActivity === 'asking' ? ' is-asking' : ''}`} title={shareActivity === 'asking' ? 'A shared GPU job is waiting for your answer' : 'This computer is running a shared GPU job'} />}
    </button>
    {open && createPortal(<div className="desktop-account-backdrop no-drag" onPointerDown={event => {
      if (event.target === event.currentTarget) { event.preventDefault(); close() }
    }} onKeyDown={keys} data-editor-keyboard-scope="text">
      <section ref={sheet} className="desktop-account-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={registered ? undefined : descriptionId} tabIndex={-1}>
        <header><div className="desktop-account-avatar" aria-hidden="true">{initials || <UserRound size={23} />}</div>
          <div className="desktop-account-heading"><h2 id={titleId}>Your Velorn account</h2>{registered && <>
            <small>Connected as</small>
            <p className="desktop-account-name">{displayName || 'Account details unavailable'}</p>
            {email && <p className="desktop-account-email">{email}</p>}
          </>}</div>
          <button type="button" className="desktop-account-close" data-account-close aria-label="Close account" onClick={close}><X size={19} /></button></header>
        {!registered && <p id={descriptionId} className="desktop-account-muted">A Velorn account is optional. Use it for Velo access and phone sharing. Editing, your own Codex and local LM Studio work without one.</p>}
        {shareActivity && <div className="desktop-account-computer"><Monitor size={17} aria-hidden="true" /><div className="desktop-account-computer-label"><small>Shared GPU</small><span>{shareActivity === 'asking' ? 'A job is waiting for your answer' : `Running a job for ${shareState.network.job.from}`}</span></div>
          <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('velorn:open-settings', { detail: 'network' })); close() }}>Open</button></div>}
        {registered && !email && <p className="desktop-account-muted">{displayName ? 'Email is not available for this connection.' : 'Account details are not available for this connection yet.'} Your connection is unchanged.</p>}
        <div className="desktop-account-vee" aria-label="Velo access"><div><strong>Velo</strong><span role="status">{veeText}</span></div>
          {registered && live && guided.phase !== 'account-unavailable' && <button type="button" aria-label="Refresh Velo availability" disabled={veeText === 'Checking availability…'} onClick={() => setVeeRefresh(value => value + 1)}>Refresh</button>}
        </div>
        {registered && <VeloAllowance {...allowance} />}
        {registered && <p className="desktop-account-muted">Free starter allowance while launch funding lasts, no refills. Questions? <a href="mailto:accounts@velorn.ai">accounts@velorn.ai</a></p>}
        {registered && guided.phase === 'account-unavailable' && state.independent && <button type="button" disabled={blocked} onClick={() => void act('refreshAccount')}>Check account connection</button>}
        {!state.hasProject && !state.independent ? <>
          {state.checking && <p role="status">Checking account status…</p>}
          {state.error && <p className="desktop-account-error" role="status">{state.error}</p>}
          <p className="desktop-account-status">Open or create a project to {registered ? 'manage your account on this computer' : 'sign in'}. This does not sign you out or change your account.</p>
        </>
          : !live ? <p className="desktop-account-status" role="status">{state.error || 'Preparing phone access…'}</p>
            : !mobile.guidedAvailable ? <p className="desktop-account-status" role="status">Checking Velorn account…</p>
              : <p className="desktop-account-status" role="status">{desktopAccountStatus(connection)}</p>}
        {registered ? <>
          <div className="desktop-account-computer"><Monitor size={17} aria-hidden="true" /><div><small>Computer</small><span>{guided.computer?.name || 'This computer'}</span></div></div>
          {usable && (!guided.enabled || !guided.automaticAccountAccess) && <button type="button" disabled={blocked} onClick={() => void act('connectPhoneAccount')}>{working || mobile.changing ? 'Connecting…' : privateSharingOnly ? 'Enable account phone sharing' : 'Enable phone sharing'}</button>}
          {guided.enabled && !state.hasProject && <p className="desktop-account-muted">Phone sharing will be ready when you open a project. You can use your account here without one.</p>}
          {Array.isArray(guided.devices) && <details className="desktop-account-devices"><summary tabIndex={0}>Connected devices · {guided.devices.length}</summary>
            {guided.devices.length ? <ul>{guided.devices.map(device => <li key={device.id}><Smartphone size={16} aria-hidden="true" /><div><strong>{device.name}</strong><small>{device.connected ? 'Connected' : 'Offline'}</small></div>
              {usable && <button type="button" disabled={blocked || (!state.independent && !mobile.enabled)} onClick={() => void act('disconnectPhoneDevice', device.id)}>Disconnect</button>}</li>)}</ul> : <p>No phones connected yet.</p>}
          </details>}
        </> : usable && <>
          <div className="desktop-account-computer"><Monitor size={17} aria-hidden="true" /><div className="desktop-account-computer-label"><small>Computer</small><span>{mobile.computerName || 'My computer'}</span></div>
            {!renaming && <button type="button" disabled={blocked || phasePending} onClick={() => setRenaming(true)}>Rename</button>}
          </div>
          {renaming && <>
          <label className="desktop-account-label" htmlFor={nameId}>Computer name</label>
          <input id={nameId} autoFocus value={mobile.computerName} maxLength={80} disabled={blocked || phasePending} onChange={event => {
            const current = context?.store.current()
            if (current && !current.disabled && !disabled && !actionLock.current) current.mobile.setComputerName(event.target.value)
          }} />
          <p className="desktop-account-muted">Used when you sign in. This only changes the name shown in Velorn.</p>
          <button type="button" disabled={blocked || phasePending} onClick={() => { mobile.setComputerName(null); setRenaming(false) }}>Cancel rename</button>
          </>}
          <button type="button" className="desktop-account-primary" disabled={blocked || !accountControlsReady || phasePending || !mobile.computerName?.trim()} onClick={() => void act('connectPhoneAccount', { reauthenticate: true })}>{phasePending ? 'Waiting for sign-in…' : working || mobile.changing ? 'Opening sign-in…' : 'Sign in'}</button>
          {!accountControlsReady && <p className="desktop-account-muted">Restart Velorn after the desktop update to enable sign-in here.</p>}
          <p className="desktop-account-muted">Sign-in opens in your browser.</p>
        </>}
        {registered && <p className="desktop-account-muted">On your phone, open <a href="https://connect.velorn.ai" target="_blank" rel="noopener noreferrer">connect.velorn.ai</a> and use the same account. Keep this computer awake with Velorn and your project open.</p>}
        {(error || mobile?.notice || projectLive?.mobile?.notice) && <p className="desktop-account-error" role="status">{error || mobile?.notice || projectLive?.mobile?.notice}</p>}
        {usable && <footer>
          {/* Older address-and-code pairing can no longer be started here, so a computer that still has it on keeps a way to turn it off. */}
          {connection?.legacyEnabled === true && <button type="button" disabled={blocked} onClick={() => void act('disable')}>{privateSharingOnly ? 'Stop older phone pairing' : 'Stop phone sharing'}</button>}
          {registered && <>
            <button type="button" disabled={blocked || !accountControlsReady || phasePending} onClick={() => void act('manageDesktopAccount', 'sign-out')}>Sign out</button>
            {!accountControlsReady && <small>Restart Velorn after the desktop update to enable these controls.</small>}
          </>}
        </footer>}
      </section>
    </div>, document.body)}
  </>
}
