import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, Loader2, MessageSquare, Monitor, Plug, X, XCircle } from 'lucide-react'
import { connectRunningComfy } from '../services/comfyConnectionSetup.mjs'
import { refreshComfyLauncher } from '../services/comfyLauncher'
import { isExportBusy } from '../stores/exportActivityStore'
import ToolSetupAssistant from './ToolSetupAssistant'
import GuidedComfySetup from './GuidedComfySetup'
import SetupHelper from './SetupHelper'
import ComfyLauncherSettingsSection from './ComfyLauncherSettingsSection'
import ComfyHostedSetup from './ComfyHostedSetup'
import './OptionalSetup.css'

// Guides are fixed product destinations, never links supplied by an agent or server.
const GUIDES = {
  codex: 'https://learn.chatgpt.com/docs/cli',
  lmstudio: 'https://lmstudio.ai/docs/developer/core/server',
  comfyui: 'https://docs.comfy.org/installation/system_requirements',
}
const TOOLS = [
  { id: 'codex', name: 'Codex', icon: MessageSquare, description: 'Use your own ChatGPT account with Codex CLI for an editing assistant.' },
  { id: 'lmstudio', name: 'LM Studio', icon: Monitor, description: 'Use a local model as your editing assistant.' },
  { id: 'comfyui', name: 'ComfyUI', icon: Plug, description: 'Connect a local ComfyUI server for AI media generation.' },
]
const LABELS = { ready: 'Ready', signin: 'Sign-in needed', missing: 'Not found', unavailable: 'Not available', 'needs-model': 'Model needed', problem: 'Needs attention' }
const message = (failure, fallback) => typeof failure?.message === 'string' ? failure.message.slice(0, 700) : fallback

/** Task-first entry point. Readiness is rechecked by the chosen flow, never persisted. */
export default function OptionalSetup({ onSkip, onFinish, onChooseAgentModel, onCloudSetup, initialView = 'start' }) {
  const [view, setView] = useState(initialView)
  const [helperAction, setHelperAction] = useState(null)
  const [helperEntry, setHelperEntry] = useState(['helper', 'helper-agent', 'helper-comfyui'].includes(initialView) ? initialView : null)
  const container = useRef(null), previousView = useRef(view)
  const helperVisible = ['helper', 'helper-agent', 'helper-comfyui'].includes(view)
  const openHelper = () => { setHelperEntry(previous => previous || 'helper'); setView('helper') }
  useEffect(() => {
    if (previousView.current !== view) {
      const heading = container.current?.querySelector('[data-setup-visible="true"] h2')
      if (heading) { heading.tabIndex = -1; heading.focus() }
    }
    previousView.current = view
  }, [view])
  const skip = () => {
    setHelperEntry(null); setHelperAction(null)
    if (onSkip) onSkip()
    else setView('skipped')
  }
  const finish = () => {
    setHelperEntry(null); setHelperAction(null)
    if (onFinish) onFinish()
    else if (onSkip) onSkip()
    else setView('complete')
  }
  const openHelperAction = action => {
    if (action?.integration === 'comfycloud') {
      if (action.action === 'configure') { setHelperAction(action); setView('helper-controls') }
      return
    }
    if (!TOOLS.some(tool => tool.id === action?.integration) || !['check', 'configure', 'install', 'credentials'].includes(action?.action)) return
    if (action.action === 'credentials' && action.integration === 'comfyui' && onCloudSetup) { onCloudSetup(); return }
    setHelperAction(action); setView('helper-controls')
  }
  // Keep only the Luna surface mounted across temporary setup handoffs. Its
  // transcript/native session are RAM-only and die with this overall surface.
  const helper = helperEntry && <div hidden={!helperVisible} inert={!helperVisible ? '' : undefined} data-setup-visible={helperVisible}>
    <SetupHelper active={helperVisible} initialIntegration={helperEntry === 'helper-comfyui' ? 'comfyui' : ''} preferAgent={helperEntry === 'helper-agent'}
      onBack={() => setView('start')} onSkip={skip} onFinish={finish} onChooseAgentModel={onChooseAgentModel}
      onGuided={integration => integration === 'comfycloud' ? openHelperAction({ integration, action: 'configure' }) : setView(!integration ? 'start' : integration === 'comfyui' ? 'comfyui' : 'agent')}
      onManual={integration => { if (integration) openHelperAction({ action: 'configure', integration }); else { setHelperAction(null); setView('manual') } }}
      onAction={openHelperAction} />
  </div>
  const wrap = content => <div ref={container} className="optional-setup-surface">{helper}<div hidden={helperVisible} data-setup-visible={!helperVisible}>{content}</div></div>
  const returnToHelper = helperEntry && <div className="optional-setup-return">
    <button type="button" onClick={openHelper}>Back to Luna setup</button>
    <p className="optional-setup-hint">{helperAction?.integration === 'comfycloud'
      ? 'Your setup conversation is kept while you use these controls. After checking account access, return and ask Luna to read the result; returning does not send a message or renew the test allowance.'
      : 'Your setup conversation is kept while you use these controls. Ask Luna to check again after making changes; returning does not send a message or renew the test allowance.'}</p>
  </div>
  if (helperVisible) return wrap(null)
  if (view === 'helper-controls' && helperAction) {
    const name = TOOLS.find(tool => tool.id === helperAction.integration)?.name
    const comfyControls = helperAction.integration === 'comfyui' && helperAction.action === 'configure'
    return wrap(<div className="optional-setup">
      {returnToHelper}
      <div className="optional-setup-manual">
        {helperAction.integration === 'comfycloud' ? <section aria-label="Comfy Cloud controls">
          <h2>Comfy Cloud controls</h2>
          <p>Use Check account access below for an online check. Return to Luna and ask it to read the result when you are ready; returning does not send a message. Your key stays out of the conversation.</p>
          <ComfyHostedSetup />
        </section> : helperAction.action === 'credentials' ? <><h2>Comfy API key settings</h2>
          <p>Open Settings → Cloud Workflows to enter your key privately. Never paste it into setup chat.</p>
          <p>This enables supported Partner/API nodes through local ComfyUI, not a directly hosted Comfy Cloud connection. No credits are bought and no generation starts.</p></>
          : comfyControls ? <section aria-label="ComfyUI controls" className="optional-setup-launcher">
            <h2>ComfyUI controls</h2>
            <p>These are Velorn’s existing connection and startup controls. Opening them does not start, stop or restart ComfyUI, save its configuration, or generate media. Refresh status or choose an action when you are ready.</p>
            <p className="optional-setup-hint">Launcher status is not a fresh setup verification. After making changes, return to Luna and explicitly check the connection again. Local paths and logs shown here are not sent to Luna.</p>
            <ComfyLauncherSettingsSection refreshOnMount={false} />
          </section>
          : <><p className="optional-setup-hint">Use the controls below for {name}. Luna’s suggestion has not changed a setting or started a download. Check setup again to verify a connection.</p>
            <ManualToolSetup integrations={[helperAction.integration]} /></>}
      </div>
      <div className="optional-setup-actions"><button type="button" onClick={() => setView('start')}>Back to guided setup</button><button type="button" onClick={skip}>Skip for now</button></div>
    </div>)
  }
  if (view === 'comfyui') return wrap(<div className="optional-setup">{returnToHelper}<GuidedComfySetup onBack={() => setView('start')} onSkip={skip}
    onManual={() => setView('manual')} onCloudSetup={onCloudSetup} /></div>)
  if (view === 'manual' || view === 'agent') return wrap(<div className="optional-setup">
    {returnToHelper}
    <button type="button" onClick={() => setView('start')}>Back to guided setup</button>
    <div className="optional-setup-manual"><ManualToolSetup integrations={view === 'agent' ? ['codex', 'lmstudio'] : undefined} /></div>
    <button type="button" onClick={skip}>Skip for now</button>
  </div>)
  return wrap(<section className="optional-setup guided-setup" aria-label="Guided setup">
    <p className="guided-setup-eyebrow">Connect tools · optional</p>
    <h2>{view === 'complete' ? 'Setup check complete' : view === 'skipped' ? 'You can keep editing' : 'What would you like help setting up?'}</h2>
    <p>{view === 'complete' ? 'Your current editing assistant, model and chats are unchanged. You can keep editing, or connect another tool later.' : 'Edit, caption and export without an agent, ComfyUI or a Velorn account. Nothing is installed or connected until you choose it.'}</p>
    {['skipped', 'complete'].includes(view) ? <button type="button" onClick={() => setView('start')}>Back to setup</button> : <>
      <div className="guided-setup-choices">
        <button type="button" aria-label="Set up an editing assistant" onClick={() => setView('agent')}><MessageSquare size={19} aria-hidden="true" /><span><strong>Set up an editing assistant</strong><small>Connect your own Codex account or a local model in LM Studio.</small></span></button>
        <button type="button" aria-label="Set up AI generation" onClick={() => setView('comfyui')}><Plug size={19} aria-hidden="true" /><span><strong>Set up AI generation</strong><small>Choose local ComfyUI or paid API services. We’ll guide you one step at a time.</small></span></button>
      </div>
      <div className="optional-setup-actions"><button type="button" onClick={() => setView('manual')}>Configure manually</button><button type="button" onClick={skip}>Skip for now</button></div>
      <details className="optional-setup-help"><summary>Advanced options</summary>
        <p>Experimental setup chat uses a separate Luna API configuration, not Velo or your Velo allowance. Guided tools work without it.</p>
        <button type="button" onClick={openHelper}>{helperEntry ? 'Continue experimental setup chat' : 'Open experimental setup chat'}</button>
      </details>
    </>}
    <p className="optional-setup-footer">Guided and manual checks use no AI credits. You can return to Connect tools in Settings at any time.</p>
  </section>)
}

/** Advanced, project-independent setup. Mounting never probes or changes a tool. */
export function ManualToolSetup({ integrations }) {
  const [results, setResults] = useState({})
  const [errors, setErrors] = useState({})
  const [notices, setNotices] = useState({})
  const [pending, setPending] = useState(null)
  const [cancelling, setCancelling] = useState(false)
  const [port, setPort] = useState('8188')
  const alive = useRef(false)
  const operation = useRef(null)
  const loginOperation = useRef(null)
  const cancelOperation = useRef(false)
  const api = window.electronAPI
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      operation.current = null
      if (loginOperation.current) {
        loginOperation.current = null
        void Promise.resolve(api?.connectedAgent?.codexLogin?.({ action: 'cancel' })).catch(() => {})
      }
    }
  }, [api])

  const run = async (integration, action, task) => {
    if (operation.current) return
    const token = {}
    operation.current = token
    const current = () => alive.current && operation.current === token
    setPending({ integration, action })
    setErrors(previous => ({ ...previous, [integration]: '' }))
    setNotices(previous => ({ ...previous, [integration]: '' }))
    try { await task(current, token) }
    catch (failure) {
      if (current()) setErrors(previous => ({ ...previous, [integration]: message(failure, 'Setup could not finish. Please try again.') }))
    } finally {
      if (operation.current === token) {
        operation.current = null
        if (alive.current) setPending(null)
      }
    }
  }

  const inspect = async (integration, current) => {
    if (!api?.optionalSetup?.inspect) throw new Error('Fully quit and reopen Velorn to enable tool setup.')
    const result = await api.optionalSetup.inspect({ integration })
    if (!current()) return
    if (!result?.success) {
      setResults(previous => ({ ...previous, [integration]: null }))
      throw new Error(result?.error || 'The setup check could not finish. Try again.')
    }
    setResults(previous => ({ ...previous, [integration]: result }))
    if (integration === 'comfyui' && Number.isInteger(result.configuredPort)) setPort(String(result.configuredPort))
  }
  const check = integration => run(integration, 'check', async current => {
    // A failed refresh must not continue displaying an old Ready status.
    setResults(previous => ({ ...previous, [integration]: null }))
    await inspect(integration, current)
  })
  const guide = integration => run(integration, 'guide', async () => {
    if (!api?.openExternalUrl) throw new Error(`Open ${GUIDES[integration]} in your browser for the official guide.`)
    const result = await api.openExternalUrl(GUIDES[integration])
    if (result?.success === false) throw new Error(`Open ${GUIDES[integration]} in your browser for the official guide.`)
  })
  const changeExecutable = action => run('codex', action, async current => {
    if (!api?.connectedAgent?.codexExecutable) throw new Error('Fully quit and reopen Velorn to choose or detect Codex.')
    // An attempted installation change can fail after native authority has
    // already been cleared. Do not keep a previous Ready result in that case.
    setResults(previous => ({ ...previous, codex: null }))
    const result = await api.connectedAgent.codexExecutable({ action })
    if (!current() || result?.cancelled) return
    if (!result?.success) throw new Error(result?.error || 'The Codex installation could not be changed.')
    await inspect('codex', current)
  })
  const signIn = () => run('codex', 'login', async (current, token) => {
    if (!api?.connectedAgent?.codexLogin) throw new Error('Fully quit and reopen Velorn to enable guided sign-in.')
    loginOperation.current = token
    try {
      const result = await api.connectedAgent.codexLogin({ action: 'start' })
      if (!current()) return
      if (result?.cancelled) {
        setNotices(previous => ({ ...previous, codex: 'Sign-in cancelled. You can keep using the editor.' }))
        return
      }
      if (!result?.success) throw new Error(result?.error || 'Codex sign-in could not finish. Try again or use Setup help.')
      // A completed browser flow is not proof of a working ChatGPT connection.
      setResults(previous => ({ ...previous, codex: null }))
      await inspect('codex', current)
    } finally {
      if (loginOperation.current === token) loginOperation.current = null
    }
  })
  const cancelLogin = async () => {
    if (!loginOperation.current || cancelOperation.current) return
    const token = loginOperation.current
    cancelOperation.current = true
    setCancelling(true)
    try {
      const result = await api.connectedAgent.codexLogin({ action: 'cancel' })
      if (alive.current && loginOperation.current === token && !result?.success) {
        setErrors(previous => ({ ...previous, codex: result?.error || 'Could not cancel sign-in. Please wait for it to finish.' }))
      }
    } catch {
      if (alive.current && loginOperation.current === token) setErrors(previous => ({ ...previous, codex: 'Could not cancel sign-in. Please wait for it to finish.' }))
    } finally {
      cancelOperation.current = false
      if (alive.current) setCancelling(false)
    }
  }
  const connect = selectedPort => run('comfyui', 'connect', async current => {
    if (isExportBusy()) throw new Error('Wait for the current export to finish before changing the ComfyUI connection.')
    const result = await connectRunningComfy(selectedPort, { isCurrent: () => current() && !isExportBusy() })
    if (!current()) return
    if (result?.cancelled) throw new Error('The connection change stopped before saving. Wait for any export to finish, then check again.')
    if (!result?.success) throw new Error(result?.error || 'Could not connect to ComfyUI. Your saved connection was not changed.')
    setPort(String(result.config.port))
    setResults(previous => ({ ...previous, comfyui: { ...previous.comfyui, state: 'ready', configuredPort: result.config.port,
      summary: `Connected to ComfyUI on port ${result.config.port}.` } }))
    setNotices(previous => ({ ...previous, comfyui: 'Connection saved. No generation was started.' }))
    // Refresh visible status only; this does not start or adopt a process.
    void refreshComfyLauncher().catch(() => {})
  })

  return <section className="optional-setup" aria-label="Optional tools">
    <div className="optional-setup-intro">
      <h2>{integrations?.length === 1 ? `${TOOLS.find(tool => tool.id === integrations[0])?.name || 'Tool'} setup` : integrations ? 'Choose your editing assistant' : 'Connect tools'}</h2>
      <p>{integrations?.length === 1 ? 'Check this tool or use its setup controls below. Nothing will switch your current editing assistant or start generation.' : integrations ? 'Use your own ChatGPT account with Codex, or run a local model with LM Studio. Check only the one you want to use; nothing will switch your current agent.' : 'Optional extras, whenever you need them. Edit, caption and export without an agent, ComfyUI or a Velorn account.'}</p>
    </div>
    <div className="optional-setup-cards">
      {TOOLS.filter(tool => !integrations || integrations.includes(tool.id)).map(({ id, name, icon: Icon, description }) => {
        const result = results[id]
        const active = pending?.integration === id
        const loginPending = active && pending.action === 'login'
        // Optional tools can be absent or unverified without a failure. Reserve
        // red for an action/check error, and never leave stale Ready beside it.
        const tone = active ? 'neutral' : errors[id] ? 'error' : result?.state === 'ready' ? 'success' : LABELS[result?.state] ? 'warning' : 'neutral'
        const statusLabel = active ? (loginPending ? 'Signing in…' : 'Working…') : errors[id] ? 'Needs attention' : result ? (LABELS[result.state] || 'Checked') : 'Optional'
        const StatusIcon = active ? Loader2 : tone === 'success' ? CheckCircle2 : tone === 'warning' ? AlertTriangle : tone === 'error' ? XCircle : null
        const candidates = Array.isArray(result?.connections) ? result.connections.filter(item => Number.isInteger(item?.port)).slice(0, 12) : []
        return <section className="optional-setup-card" aria-label={`${name} setup`} key={id} aria-busy={active}>
          <div className="optional-setup-card-heading">
            <Icon size={19} aria-hidden="true" />
            <h3>{name}</h3>
            <span className="optional-setup-status" data-tone={tone} role="status">
              {StatusIcon && <StatusIcon size={13} className={active ? 'animate-spin' : undefined} aria-hidden="true" />}
              {statusLabel}
            </span>
          </div>
          <p>{description}</p>
          {result?.summary && <p className="optional-setup-result">{result.summary}</p>}
          {loginPending && <p role="status">Finish signing in in your browser. You can cancel here or close setup.</p>}
          <div className="optional-setup-actions">
            {loginPending ? <button type="button" disabled={cancelling} onClick={() => void cancelLogin()}>Cancel sign-in</button> : <>
              {id === 'codex' && result?.state === 'signin' && <button type="button" disabled={Boolean(pending)} onClick={() => void signIn()}>Sign in with ChatGPT</button>}
              <button type="button" aria-label={`Check ${name} setup`} disabled={Boolean(pending)} onClick={() => void check(id)}>Check setup</button>
            </>}
          </div>
          {id === 'codex' && result?.state === 'ready' && <p className="optional-setup-hint">Choose Codex in Assistant settings when you open a project. Your current agent, model and chats are unchanged.</p>}
          {id === 'lmstudio' && result && <p className="optional-setup-hint">{result.state === 'ready'
            ? 'Choose LM Studio and a model in Assistant settings when you open a project. Your current agent and chats are unchanged.'
            : 'In LM Studio, load a model and start its local server in the Developer tab (port 1234), then check again. This check does not download or load a model.'}</p>}
          {id === 'comfyui' && candidates.length > 0 && <div className="optional-setup-connections">
            <p className="optional-setup-hint">Choose the local connection to use. Finding one does not change your settings.</p>
            {candidates.map(candidate => <div key={candidate.port} className="optional-setup-connection">
              <span>Port {candidate.port}{candidate.port === result.configuredPort ? ' · Saved connection' : ''}</span>
              <button type="button" disabled={Boolean(pending)} aria-label={`Connect to ComfyUI on port ${candidate.port}`} onClick={() => void connect(candidate.port)}>Connect</button>
            </div>)}
          </div>}
          <details className="optional-setup-help">
            <summary>{id === 'comfyui' ? 'Setup help or another port' : 'Setup help'}</summary>
            {id === 'codex' && <>
              <p>Use the official standalone Codex CLI if the copy bundled with another app does not work. Installing it and signing in are separate steps.</p>
              <div className="optional-setup-actions">
                <button type="button" disabled={Boolean(pending)} onClick={() => void changeExecutable('auto')}>Use automatic detection</button>
                <button type="button" disabled={Boolean(pending)} onClick={() => void changeExecutable('choose')}>Choose executable…</button>
              </div>
              <p>If the sign-in browser does not open, cancel here, run <code>codex login</code> in your terminal, then check setup. Never paste passwords or sign-in codes into chat.</p>
              <p>Changing the installation or signing in turns off Full computer access. Enable it separately when you are ready.</p>
            </>}
            {id === 'lmstudio' && <p>A stopped server does not mean LM Studio is missing. Open it first; this check only looks at its local server.</p>}
            {id === 'comfyui' && <>
              <p>Open ComfyUI and start the local instance you want to use. No launcher script is needed. If it is on another port, test that port below.</p>
              <div className="optional-setup-actions">
                <label>ComfyUI port<input aria-label="ComfyUI port" type="number" min="1" max="65535" step="1" value={port} disabled={Boolean(pending)} onChange={event => setPort(event.target.value)} /></label>
                <button type="button" disabled={Boolean(pending) || !port.trim()} onClick={() => void connect(port)}>Test and connect</button>
              </div>
              <p>A local connection does not mean every workflow is free. Paid generation still needs confirmation.</p>
            </>}
            <button type="button" disabled={Boolean(pending)} onClick={() => void guide(id)}>Open {name} guide</button>
            <p>The official guide opens in your browser. Velorn does not install software automatically.</p>
          </details>
          {notices[id] && <p className="optional-setup-result" role="status">{notices[id]}</p>}
          {errors[id] && <p className="optional-setup-error" role="alert">{errors[id]}</p>}
          {id !== 'codex' && <ToolSetupAssistant integration={id} name={name} disabled={Boolean(pending)} onCheck={() => check(id)} />}
        </section>
      })}
    </div>
    <p className="optional-setup-footer">Checks do not send a model prompt, install anything or start generation. You can return to Connect tools in Settings at any time.</p>
  </section>
}

export function OptionalSetupDialog({ onClose, onFinish, onChooseAgentModel, onCloudSetup, initialView }) {
  const dialog = useRef(null)
  const close = useRef(onClose)
  const titleId = useId()
  close.current = onClose
  useEffect(() => {
    const previousFocus = document.activeElement
    const node = dialog.current
    const backdrop = node?.parentElement
    const siblings = [...document.body.children].filter(item => item !== backdrop)
    const priorInert = siblings.map(item => [item, item.inert])
    for (const [item] of priorInert) item.inert = true
    node?.querySelector('button')?.focus()
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current?.(); return }
      if (event.key !== 'Tab') return
      const buttons = [...node.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex="0"]')]
        .filter(item => item.getClientRects().length > 0)
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (!first) { event.preventDefault(); node.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown, true)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      for (const [item, wasInert] of priorInert) if (item.isConnected) item.inert = wasInert
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])
  return createPortal(<div className="optional-setup-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose?.() }}>
    <div ref={dialog} className="optional-setup-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header><h2 id={titleId}>Optional tools</h2><button type="button" aria-label="Close tool setup" onClick={onClose}><X size={19} aria-hidden="true" /></button></header>
      <div className="optional-setup-dialog-body"><OptionalSetup onSkip={onClose} onFinish={onFinish || onClose} onChooseAgentModel={onChooseAgentModel} onCloudSetup={onCloudSetup} initialView={initialView} /></div>
      <footer><button type="button" onClick={onClose}>Done</button></footer>
    </div>
  </div>, document.body)
}
