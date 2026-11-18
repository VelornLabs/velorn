import { useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, Cloud, Loader2, MessageSquare, Monitor, Plug, Send, Square } from 'lucide-react'
import './SetupHelper.css'

const TOPICS = Object.freeze([
  { id: 'comfyui', name: 'ComfyUI', detail: 'AI media generation', icon: Plug },
  { id: 'lmstudio', name: 'LM Studio', detail: 'A local editing assistant', icon: Monitor },
  { id: 'codex', name: 'Codex', detail: 'Your ChatGPT editing assistant', icon: MessageSquare },
  { id: 'comfycloud', name: 'Comfy Cloud', detail: 'Hosted account setup', icon: Cloud },
])
const NAMES = Object.fromEntries(TOPICS.map(topic => [topic.id, topic.name]))
const CHECK_LABELS = { ready: 'Ready', signin: 'Sign-in needed', missing: 'Not found', unavailable: 'Not available', 'needs-model': 'Model needed', problem: 'Needs attention' }
const CLOUD_CHECK_LABELS = { missing: 'No hosted key', configured: 'Not verified', verified: 'Account access verified', waitlisted: 'Access pending', 'auth-rejected': 'Key not accepted', 'subscription-or-rate-limited': 'Access needs attention', unavailable: 'Not verified', problem: 'Not verified' }
const CLOUD_SUMMARIES = {
  missing: 'No hosted key is configured. Open Comfy Cloud controls to enter a Comfy key privately. No new Comfy Cloud request was made.',
  configured: 'A hosted key is available, but account access has not been verified in this session. Use Check account access in Comfy Cloud controls.',
  verified: 'The last explicit account check in this Velorn session reported active access. Luna read that stored result; it did not contact Comfy Cloud again. Hosted generation is not enabled or tested.',
  waitlisted: 'The last explicit account check reported a waitlisted account. No new Comfy Cloud request was made.',
  'auth-rejected': 'The last explicit account check rejected the tested key. Open Comfy Cloud controls to review or replace it. No new Comfy Cloud request was made.',
  'subscription-or-rate-limited': 'The last explicit account check reported a subscription or rate limit. No new Comfy Cloud request was made.',
  unavailable: 'Account access could not be verified from the stored result. Use Check account access in Comfy Cloud controls. No new Comfy Cloud request was made.',
  problem: 'The stored account-check result could not be verified. Open Comfy Cloud controls; no new Comfy Cloud request was made.',
}
const validCloudEvidence = check => check?.integration === 'comfycloud' && check.evidence === 'stored-account-check'
  && Object.hasOwn(CLOUD_CHECK_LABELS, check.state) && typeof check.configured === 'boolean'
  && (check.state !== 'verified' || check.configured === true)
const ACTION_LABELS = { check: 'Open setup checks', configure: 'Configure manually', install: 'Review installation options', credentials: 'Open private API key settings', open_app: 'Open LM Studio', choose_app: 'Locate LM Studio…', installation_guide: 'Open official installation guide', connection_guide: 'Open official connection guide' }
const actionLabel = action => action.action === 'configure' && action.integration === 'comfycloud' ? 'Open Comfy Cloud controls'
  : action.action === 'configure' && ['comfyui', 'codex'].includes(action.integration)
  ? action.integration === 'comfyui' ? 'Open ComfyUI controls' : 'Open Codex setup controls'
  : ACTION_LABELS[action.action]
const safePort = value => Number.isInteger(value) && value > 0 && value <= 65535
const verifiedComfyPort = check => check?.integration === 'comfyui' && check.state === 'ready' && safePort(check.configuredPort)
  && Array.isArray(check.ports) && check.ports.length <= 4 && check.ports.every(safePort) && check.ports.includes(check.configuredPort)
  ? check.configuredPort : null
const IN_CHAT_ACTIONS = new Set(['open_app', 'choose_app', 'installation_guide', 'connection_guide'])
const allowedAction = (action, integration) => integration === 'comfycloud' ? ['configure', 'connection_guide'].includes(action) : Object.hasOwn(ACTION_LABELS, action)
  && (action !== 'credentials' || integration === 'comfyui') && (action !== 'install' || integration !== 'codex')
  && (!['open_app', 'choose_app'].includes(action) || integration === 'lmstudio')
const UNAVAILABLE = 'Luna setup chat is not connected yet. You can still use guided or manual setup.'
const MAX_MESSAGE = 2000
// Order teardown before a subsequent helper mounts. No conversation or project
// data lives here; this is only a barrier for native session-reset requests.
let resetBarrier = Promise.resolve()
function resetSession(api) {
  const reset = resetBarrier.catch(() => {}).then(async () => {
    if (typeof api?.cancel === 'function') await api.cancel({})
    if (typeof api?.reset !== 'function') throw new Error('Setup chat is unavailable.')
    const result = await api.reset({})
    if (result?.success !== true) throw new Error('Setup chat could not be reset. You can still use guided or manual setup.')
  })
  resetBarrier = reset.catch(() => {})
  return reset
}
function cancelSession(api) {
  const cancel = resetBarrier.catch(() => {}).then(async () => {
    if (typeof api?.cancel !== 'function') throw new Error('Stopping could not be confirmed. Start a new setup conversation before sending again.')
    const result = await api.cancel({})
    if (result?.success !== true) throw new Error('Stopping could not be confirmed. Start a new setup conversation before sending again.')
  })
  resetBarrier = cancel.catch(() => {})
  return cancel
}
// Only paired emphasis is rendered. URLs, HTML and other model-authored markup
// remain text; official destinations are native-owned enum actions below.
const guidanceText = text => text.split(/(\*\*[^*\n]{1,300}\*\*)/g).map((part, index) => part.startsWith('**') && part.endsWith('**')
  ? <strong key={index}>{part.slice(2, -2)}</strong> : part)
const safeError = result => typeof result?.error === 'string' && result.error.trim()
  ? result.error.slice(0, 600) : 'Luna could not finish this reply. Nothing was retried. You can use the setup controls below.'
function loadedModelEvidence(check, integration) {
  if (integration !== 'lmstudio' || check?.integration !== 'lmstudio' || check.state !== 'ready') return null
  const evidence = check.loadedModels
  if (evidence?.verified !== true || typeof evidence.truncated !== 'boolean' || !Array.isArray(evidence.names)
    || !evidence.names.length || evidence.names.length > 8) return null
  // Native already filters these display labels. Defense in depth: never show
  // paths, credentials, direction controls, links or markup as a model name.
  const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && value === value.trim()
    && !/[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069<>{}\\]/.test(value)
    && !/^(?:[\/~]|[a-z]:|\.[^/]*\/)|(?:^|[\s("'`])(?:~\/|\.{1,2}\/|\/)\S+|(?:^|\/)\.{1,2}(?:\/|$)|\b[a-z]:\/|\b[a-z][a-z0-9+.-]*:\/\/|\b(?:https?|file|ftp|mailto|data|javascript):/i.test(value)
    && !/^(?:models?|downloads|home|users|private|tmp|var|opt|mnt|media|applications)\//i.test(value)
    && !/(?:\bsk-[a-z0-9_-]{16,}|\bBearer\s+|-----BEGIN [A-Z ]*PRIVATE KEY-----)|\b(?:api[_ -]?key|access[_ -]?token|password|secret|authorization)\s*[:=]/i.test(value)
  if (!evidence.names.every(safeName)) return null
  return { names: [...evidence.names], truncated: evidence.truncated }
}
function replyView(result, integration) {
  if (result?.success !== true || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 12000
    || !Array.isArray(result.actions) || result.actions.length > 12 || !Array.isArray(result.checks) || result.checks.length > 12
    || !Number.isSafeInteger(result.remainingTurns) || result.remainingTurns < 0 || result.remainingTurns > 1000) {
    throw new Error(result?.success === false ? safeError(result) : 'Luna returned a reply that could not be verified. Nothing was run. Try guided or manual setup.')
  }
  const actions = result.actions.filter(item => item?.integration === integration && allowedAction(item.action, integration))
    .filter((item, index, list) => list.findIndex(other => other.action === item.action) === index)
    .map(({ action, integration: selected }) => ({ action, integration: selected }))
  const checks = result.checks.filter(item => item?.integration === integration && Object.hasOwn(integration === 'comfycloud' ? CLOUD_CHECK_LABELS : CHECK_LABELS, item.state)
    && typeof item.summary === 'string' && item.summary.length <= 1000 && (integration !== 'codex' || item.summary.trim()))
    .map(item => ({ integration: item.integration,
      state: item.integration === 'comfycloud' && !validCloudEvidence(item) ? 'problem'
        : item.integration === 'comfyui' && item.state === 'ready' && !verifiedComfyPort(item) ? 'problem' : item.state,
      summary: item.integration === 'comfycloud' ? CLOUD_SUMMARIES[validCloudEvidence(item) ? item.state : 'problem']
        : item.integration === 'comfyui' && item.state === 'ready' && !verifiedComfyPort(item) ? 'The saved ComfyUI connection could not be verified. Check again before continuing.' : item.summary,
      fresh: item === result.checks.at(-1),
      installation: item.integration === 'lmstudio' && ['found', 'not_found', 'unknown'].includes(item.installation?.state)
        && typeof item.installation.summary === 'string' && item.installation.summary.length <= 1000
        ? { state: item.installation.state, summary: item.installation.summary, canOpen: item.installation.canOpen === true } : undefined }))
  const lastCheck = result.checks.at(-1)
  return { role: 'assistant', text: result.text, actions, checks, remainingTurns: result.remainingTurns,
    lmReady: integration === 'lmstudio' && lastCheck?.integration === 'lmstudio' && lastCheck.state === 'ready'
      && typeof lastCheck.summary === 'string' && lastCheck.summary.length <= 1000,
    loadedModels: loadedModelEvidence(result.checks.at(-1), integration),
    codexReady: integration === 'codex' && lastCheck?.integration === 'codex' && lastCheck.state === 'ready'
      && typeof lastCheck.summary === 'string' && Boolean(lastCheck.summary.trim()) && lastCheck.summary.length <= 1000,
    cloudVerified: integration === 'comfycloud' && validCloudEvidence(lastCheck) && lastCheck.state === 'verified'
      && typeof lastCheck.summary === 'string' && Boolean(lastCheck.summary.trim()) && lastCheck.summary.length <= 1000,
    comfyPort: integration === 'comfyui' && lastCheck?.integration === 'comfyui' && lastCheck.state === 'ready'
      && typeof lastCheck.summary === 'string' && lastCheck.summary.length <= 1000 ? verifiedComfyPort(lastCheck) : null }
}

/** Optional, isolated setup conversation. No app/project stores or attachments. */
export default function SetupHelper({ initialIntegration = '', preferAgent = false, active = true, onBack, onSkip, onFinish, onChooseAgentModel, onManual, onGuided, onAction }) {
  const [integration, setIntegration] = useState(Object.hasOwn(NAMES, initialIntegration) ? initialIntegration : '')
  const [status, setStatus] = useState(null)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState('status')
  const [sessionReady, setSessionReady] = useState(false)
  const [remaining, setRemaining] = useState(null)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const alive = useRef(false), version = useRef(0), operation = useRef(null), input = useRef(null), focusInput = useRef(false)
  const visible = useRef(active), previouslyActive = useRef(active)
  visible.current = active
  const titleId = useId(), inputId = useId(), privacyId = useId()
  const api = window.electronAPI?.setupHelper
  const available = status?.available === true && status.mode === 'internal-api' && status.model === 'gpt-6-luna'
  useEffect(() => {
    if (active && !pending && available && focusInput.current) { focusInput.current = false; input.current?.focus() }
  }, [pending, available, integration, active])
  useEffect(() => {
    alive.current = true
    const token = ++version.current
    const current = () => alive.current && version.current === token
    void (async () => {
      try {
        await resetBarrier
        if (!current()) return
        const result = typeof api?.status === 'function' ? await api.status({}) : null
        if (!current()) return
        setStatus(result?.success === true ? { available: result.available, mode: result.mode, model: result.model } : { available: false })
        if (Number.isSafeInteger(result?.remainingTurns) && result.remainingTurns >= 0 && result.remainingTurns <= 1000) setRemaining(result.remainingTurns)
        // The first send still explicitly resets this helper's native history.
        setSessionReady(false)
      } catch { if (current()) setStatus({ available: false }) }
      finally { if (current()) setPending('') }
    })()
    return () => {
      alive.current = false; version.current += 1; operation.current = null
      void resetSession(api).catch(() => {})
    }
  }, [api])
  useEffect(() => {
    const wasActive = previouslyActive.current
    previouslyActive.current = active
    if (active || !wasActive) return
    setMessages(previous => previous.map(entry => entry.checks?.length ? { ...entry, stale: true } : entry))
    // Temporary handoffs retain native history. Never let an in-flight answer
    // continue spending or appear as a fresh check after leaving this surface.
    if (operation.current) {
      const token = ++version.current, wasAction = pending === 'action'
      operation.current = null; setPending('stop'); setRemaining(null)
      void cancelSession(api).then(() => {
        if (alive.current && version.current === token) setNotice(wasAction
          ? 'You left before the setup action returned. Inspect the app or browser before trying again; its result is not verified here.'
          : 'The active reply was stopped when you opened setup controls. Ask again when you are ready; nothing was retried.')
      }).catch(failure => {
        if (alive.current && version.current === token) { setSessionReady(false); setError(failure.message) }
      }).finally(() => { if (alive.current && version.current === token) setPending('') })
    }
  }, [active, api])
  const changeTopic = next => {
    if (!Object.hasOwn(NAMES, next)) return
    const token = ++version.current
    operation.current = null
    focusInput.current = true
    setIntegration(next); setMessages([]); setDraft(''); setError(''); setNotice(''); setSessionReady(false)
    setPending('reset')
    void resetSession(api).then(() => {
      if (alive.current && version.current === token) setSessionReady(true)
    }).catch(failure => {
      if (alive.current && version.current === token && available) setError(failure.message)
    }).finally(() => { if (alive.current && version.current === token) setPending('') })
  }
  const send = async event => {
    event.preventDefault()
    const text = draft.trim()
    if (!active || !available || pending || operation.current || !integration || !text || text.length > MAX_MESSAGE || remaining === 0) return
    const token = ++version.current, request = {}
    const current = () => alive.current && visible.current && version.current === token && operation.current === request
    operation.current = request
    setPending('send'); setError(''); setNotice('')
    // A new question/recheck immediately expires old readiness, including if
    // the request subsequently fails, is cancelled, or returns no native check.
    setMessages(previous => previous.map(entry => entry.checks?.length ? { ...entry, stale: true } : entry))
    try {
      await resetBarrier
      if (!current()) return
      if (!sessionReady) { await resetSession(api); if (!current()) return; setSessionReady(true) }
      if (typeof api?.send !== 'function') throw new Error(UNAVAILABLE)
      setMessages(previous => [...previous.slice(-19), { role: 'user', text }]); setDraft('')
      // Fixed narrow payload. Never include a project, path, transcript, key,
      // attachment, selected agent, account or generation setting.
      const result = await api.send({ integration, message: text })
      if (!current()) return
      if (Number.isSafeInteger(result?.remainingTurns) && result.remainingTurns >= 0 && result.remainingTurns <= 1000) setRemaining(result.remainingTurns)
      const reply = replyView(result, integration)
      setMessages(previous => [...previous.slice(-19).map(entry => entry.checks?.length ? { ...entry, stale: true } : entry), reply]); setRemaining(reply.remainingTurns)
    } catch (failure) { if (current()) setError(failure.message || 'Setup chat could not finish. Nothing was retried.') }
    finally { if (current()) { operation.current = null; focusInput.current = true; setPending('') } }
  }
  const stop = async () => {
    if (pending !== 'send') return
    const token = ++version.current
    operation.current = null; setPending('stop'); setError('')
    try {
      const result = await api?.cancel?.({})
      if (!alive.current || version.current !== token) return
      if (result?.success !== true) throw new Error('Stopping could not be confirmed. Start a new setup conversation or use the manual controls.')
      setNotice('Stopped. A request already sent may still use API tokens. Nothing was retried.')
    } catch (failure) {
      if (alive.current && version.current === token) { setSessionReady(false); setError(failure.message) }
    } finally { if (alive.current && version.current === token) { focusInput.current = true; setPending('') } }
  }
  const leave = callback => {
    callback?.()
  }
  const performAction = async action => {
    if (!active || pending || operation.current || action.integration !== integration || !allowedAction(action.action, integration)) return
    if (!IN_CHAT_ACTIONS.has(action.action)) { leave(() => onAction?.(action)); return }
    const token = ++version.current, request = {}
    const current = () => alive.current && visible.current && version.current === token && operation.current === request
    operation.current = request; setPending('action'); setError(''); setNotice('')
    setMessages(previous => previous.map(entry => entry.checks?.length ? { ...entry, stale: true } : entry))
    try {
      if (typeof api?.performAction !== 'function') throw new Error('Fully quit and reopen Velorn to enable these setup controls. Guided and manual setup remain available.')
      await resetBarrier
      if (!current()) return
      if (!sessionReady) { await resetSession(api); if (!current()) return; setSessionReady(true) }
      const result = await api.performAction({ integration, action: action.action })
      if (!current()) return
      if (result?.success !== true) throw new Error(safeError(result))
      const summary = typeof result.summary === 'string' && result.summary.trim() && result.summary.length <= 1000 ? result.summary : null
      const fallback = result.cancelled ? 'Cancelled. No connection was changed.' : action.action === 'open_app'
        ? 'The app open request completed. This does not verify its server or load a model. Check the connection when you are ready.' : action.action === 'choose_app'
          ? 'The installation selection completed. Nothing was launched; check the connection after starting the app and its server.' : 'The official guide was opened. No connection, model or setting was changed.'
      setMessages(previous => [...previous.slice(-19), { role: 'action', text: summary || fallback }])
    } catch (failure) { if (current()) setError(failure.message || 'The setup action could not finish. Try the manual controls.') }
    finally { if (current()) { operation.current = null; setPending('') } }
  }
  const topics = preferAgent ? [TOPICS[1], TOPICS[2], TOPICS[0], TOPICS[3]] : TOPICS
  const latest = messages.at(-1)
  const completion = active && integration === 'lmstudio' && !pending && !error && latest?.role === 'assistant' && !latest.stale && latest.lmReady
    ? { loadedModels: latest.loadedModels } : null
  const comfyCompletion = active && integration === 'comfyui' && !pending && !error && latest?.role === 'assistant' && !latest.stale && safePort(latest.comfyPort)
    ? latest.comfyPort : null
  const codexCompletion = active && integration === 'codex' && !pending && !error && latest?.role === 'assistant' && !latest.stale && latest.codexReady
  const cloudCompletion = active && integration === 'comfycloud' && !pending && !error && latest?.role === 'assistant' && !latest.stale && latest.cloudVerified
  return <section className="optional-setup setup-helper" aria-labelledby={titleId}>
    <p className="setup-helper-eyebrow">Experimental setup conversation · separate from Velo</p>
    <h2 id={titleId}>Help with setup · Luna</h2>
    <p>Ask about connecting ComfyUI, Comfy Cloud, LM Studio or Codex. This is separate from your project chat and does not change your editing assistant.</p>
    <div className="setup-helper-disclosure" role="status">
      {pending === 'status' ? 'Checking whether setup chat is connected. No model prompt is sent.' : available
        ? 'Internal Luna test · uses configured API project. No free credits are active.' : UNAVAILABLE}
    </div>
    <fieldset className="setup-helper-topics"><legend>What would you like to set up?</legend>
      <div>{topics.map(({ id, name, detail, icon: Icon }) => <button key={id} type="button" aria-pressed={integration === id}
        onClick={() => changeTopic(id)} disabled={pending === 'status'}><Icon size={17} aria-hidden="true" /><span><strong>{name}</strong><small>{detail}</small></span></button>)}</div>
    </fieldset>
    {integration && <>
      <p className="setup-helper-privacy" id={privacyId}>Only your setup question and limited setup checks are sent. No project, timeline, files or project chat are attached. Never paste API keys, passwords or sign-in codes here.</p>
      <div className="setup-helper-transcript" role="log" aria-label={`${NAMES[integration]} setup conversation`} aria-live="polite" aria-relevant="additions text">
        {!messages.length && <p className="setup-helper-empty">Ask what you need help with. For example: “How do I connect {NAMES[integration]} to Velorn?” Nothing runs until you send.</p>}
        {messages.map((entry, index) => <article key={index} className="setup-helper-message" data-role={entry.role}>
          <h3>{entry.role === 'user' ? 'You' : entry.role === 'action' ? 'Native setup action' : 'Luna · setup guidance'}</h3>
          <p className="setup-helper-text">{entry.role === 'assistant' ? guidanceText(entry.text) : entry.text}</p>
          {entry.checks?.map((check, checkIndex) => {
            const stale = entry.stale || !check.fresh
            return <div className="setup-helper-check" data-stale={stale || undefined} key={checkIndex}>
            <strong>{check.integration === 'comfycloud' ? stale ? 'Earlier account status' : 'Native account status' : stale ? 'Earlier setup check' : 'Native setup check'} · {NAMES[check.integration]} · {stale ? check.integration === 'comfycloud' ? 'Read status again' : 'Recheck needed' : (check.integration === 'comfycloud' ? CLOUD_CHECK_LABELS : CHECK_LABELS)[check.state]}</strong><p>{check.summary}</p>
            {check.installation && <details className="setup-helper-installation" open={check.state !== 'ready' && !stale}>
              <summary>Installation-only check · {check.installation.state === 'found' ? 'Found' : check.installation.state === 'not_found' ? 'Not found in checked locations' : 'Not verified'}</summary>
              <p>{check.installation.summary}</p>
            </details>}
            {stale && <p>{check.integration === 'comfycloud'
              ? 'This is an earlier stored account status. After using the private controls, ask Luna to read the result again. A new online check requires Check account access.'
              : 'This is an earlier result, not current readiness. Ask Luna to check again after making changes.'}</p>}
          </div>})}
          {entry.actions?.length > 0 && <div className="setup-helper-actions" aria-label="Suggested setup controls">
            {entry.actions.map(action => <button key={action.action} type="button" disabled={Boolean(pending)}
              onClick={() => void performAction(action)}>{actionLabel(action)}</button>)}
          </div>}
        </article>)}
      </div>
      {cloudCompletion && <section className="setup-helper-completion" aria-label="Comfy Cloud account setup complete">
        <h3>Comfy Cloud account check verified</h3>
        <p>The last explicit account check in this Velorn session reported active access. Luna only read that result; it did not contact Comfy Cloud again.</p>
        <p>This does not verify your subscription, credit balance or workflows. Hosted generation is not enabled in Velorn yet. Your local ComfyUI, editing assistant, model and chats are unchanged.</p>
        <div className="setup-helper-actions"><button type="button" onClick={() => leave(onFinish || onSkip)}>Finish setup — keep current assistant</button></div>
      </section>}
      {codexCompletion && <section className="setup-helper-completion" aria-label="Codex setup complete">
        <h3>Codex setup verified</h3>
        <p>Velorn found Codex CLI and verified that it is signed in through ChatGPT.</p>
        <p>This checks installation and sign-in only. No Codex prompt was sent; model responses and tool capabilities have not been tested.</p>
        <p>This check did not change your sign-in, editing assistant, model or chats.</p>
        <div className="setup-helper-actions"><button type="button" onClick={() => leave(onFinish || onSkip)}>Finish setup — keep current assistant</button></div>
      </section>}
      {comfyCompletion && <section className="setup-helper-completion" aria-label="ComfyUI setup complete">
        <h3>ComfyUI connection verified</h3>
        <p>Velorn reached your saved local ComfyUI connection on port {comfyCompletion}.</p>
        <p>This verifies the connection only. Models, workflows and generation have not been tested.</p>
        <p>This check did not change your saved connection, editing assistant, model or chats.</p>
        <div className="setup-helper-actions"><button type="button" onClick={() => leave(onFinish || onSkip)}>Finish setup — keep current assistant</button></div>
      </section>}
      {completion && <section className="setup-helper-completion" aria-label="LM Studio setup complete">
        <h3>LM Studio connection verified</h3>
        {completion.loadedModels ? <>
          <p>Velorn reached the local server. LM Studio reported {completion.loadedModels.names.length === 1 && !completion.loadedModels.truncated ? 'this language model' : 'these language models'} loaded:</p>
          <ul>{completion.loadedModels.names.map((name, index) => <li key={index}>{name}</li>)}</ul>
          {completion.loadedModels.truncated && <p className="setup-helper-completion-note">Additional loaded model details are not shown.</p>}
        </> : <p>Velorn reached the local server. LM Studio reports a loaded chat model. Its name could not be displayed.</p>}
        <p>This checks connection and loaded state only. No inference or tool-capability test was run.</p>
        <p>Your current editing assistant, model and chats are unchanged.</p>
        <div className="setup-helper-actions">
          <button type="button" onClick={() => leave(onFinish || onSkip)}>Finish setup — keep current assistant</button>
          {typeof onChooseAgentModel === 'function' && <button type="button" onClick={() => leave(onChooseAgentModel)}>Choose an LM Studio model</button>}
        </div>
        <p className="setup-helper-completion-note">{typeof onChooseAgentModel === 'function'
          ? 'The model picker opens with your current assistant unchanged. Choose LM Studio under Agent, then choose a model. Changing assistants starts a new chat; existing chats stay in history.'
          : 'To use LM Studio for editing, open a project, then choose LM Studio and a model in Assistant settings. Changing assistants starts a new chat; existing chats stay in history.'}</p>
      </section>}
      <p className="setup-helper-privacy">Luna’s explanation is guidance, not proof that a connection works. Native setup checks are labeled separately. Suggested controls only open when clicked.</p>
      {integration === 'comfycloud' && <details className="setup-helper-guides"><summary>Comfy Cloud controls</summary>
        <p>Enter your Comfy key privately and choose Check account access here. Luna can read the resulting status, but cannot see your key, perform the online check, remember or forget keys, purchase credits, or run workflows.</p>
        <div className="setup-helper-actions"><button type="button" disabled={Boolean(pending)} onClick={() => void performAction({ integration, action: 'configure' })}>Open Comfy Cloud controls</button></div>
      </details>}
      {integration === 'comfyui' && <details className="setup-helper-guides"><summary>ComfyUI controls</summary>
        <p>Open the existing connection and startup controls without another Luna message. Opening them does not start, stop or restart ComfyUI, save its configuration, or generate media.</p>
        <div className="setup-helper-actions"><button type="button" disabled={Boolean(pending)} onClick={() => void performAction({ integration, action: 'configure' })}>Open ComfyUI controls</button></div>
      </details>}
      {integration === 'lmstudio' && <details className="setup-helper-guides"><summary>LM Studio app controls</summary>
        <p>Use these controls without another Luna message. Open asks for native confirmation; Locate selects an existing installation without launching it. Neither verifies the server or requests a model load.</p>
        <div className="setup-helper-actions">{['open_app', 'choose_app'].map(action => <button type="button" key={action} disabled={Boolean(pending)} onClick={() => void performAction({ integration, action })}>{ACTION_LABELS[action]}</button>)}</div>
      </details>}
      {integration === 'codex' && <details className="setup-helper-guides"><summary>Codex setup controls</summary>
        <p>Open Velorn’s existing setup controls without another Luna message. Opening them does not sign you in or out, change settings, send a Codex prompt, or switch your editing assistant.</p>
        <div className="setup-helper-actions"><button type="button" disabled={Boolean(pending)} onClick={() => void performAction({ integration, action: 'configure' })}>Open Codex setup controls</button></div>
      </details>}
      <details className="setup-helper-guides"><summary>Official {NAMES[integration]} guides</summary>
        <p>These fixed official links open in your browser. Opening a guide uses no Luna tokens.</p>
        <div className="setup-helper-actions">{(integration === 'comfycloud' ? ['connection_guide'] : ['installation_guide', 'connection_guide']).map(action => <button type="button" key={action} disabled={Boolean(pending)} onClick={() => void performAction({ integration, action })}>{ACTION_LABELS[action]}</button>)}</div>
      </details>
      <form onSubmit={send} className="setup-helper-composer">
        <label htmlFor={inputId}>Your {NAMES[integration]} setup question</label>
        <textarea ref={input} id={inputId} aria-describedby={privacyId} rows={3} maxLength={MAX_MESSAGE} value={draft}
          disabled={!available || Boolean(pending)} onChange={event => setDraft(event.target.value)} placeholder="Tell Luna what you’re trying to set up…" />
        <div>{pending === 'send' ? <button type="button" onClick={() => void stop()}><Square size={14} aria-hidden="true" />Stop</button>
          : <button type="submit" disabled={!available || Boolean(pending) || !draft.trim() || remaining === 0}><Send size={14} aria-hidden="true" />Send to Luna</button>}
          {pending && pending !== 'status' && <span role="status"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{pending === 'send' ? 'Luna is replying…' : pending === 'stop' ? 'Stopping…' : pending === 'action' ? 'Opening setup control…' : 'Starting a new setup conversation…'}</span>}
          {remaining !== null && !pending && <span>{remaining === 0 ? 'The internal setup test has reached its turn limit. Manual setup is still available.' : `${remaining} setup test turns remaining`}</span>}
        </div>
      </form>
      {messages.length > 0 && <button type="button" className="setup-helper-reset" onClick={() => changeTopic(integration)}>Start a new setup conversation</button>}
    </>}
    {error && <p className="optional-setup-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <nav className="setup-helper-navigation" aria-label="Other setup options">
      <button type="button" onClick={() => leave(onBack)}><ArrowLeft size={14} aria-hidden="true" />Back to setup</button>
      <button type="button" onClick={() => leave(() => onGuided?.(integration))}>Use guided setup</button>
      <button type="button" onClick={() => leave(() => onManual?.(integration))}>Configure manually</button>
      <button type="button" onClick={() => leave(onSkip)}>Skip for now</button>
    </nav>
    <p className="optional-setup-footer">This temporary conversation stays here while you use setup controls, and clears when you close Connect tools. Editing stays available without Luna, an agent account or ComfyUI. Setup chat does not install tools, enter credentials, generate media or change spending permissions.</p>
  </section>
}
