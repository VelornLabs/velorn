import { useEffect, useRef, useState } from 'react'
import { localModelOptionLabel } from '../utils/agentModelSupportPresentation.mjs'

// This panel stages choices only. Its parent owns the existing connection and
// conversation selection; checks never install/load a model or send a prompt.
export default function LmStudioSetup({ endpoint, model, models, checking, connected, connectionError,
  busy, onCheck, onUseModel, onEndpoint, onLater, onBusyChange }) {
  const [selection, setSelection] = useState(model || '')
  const [customId, setCustomId] = useState(model || '')
  const [address, setAddress] = useState(endpoint)
  const [pending, setPending] = useState('')
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const alive = useRef(true), operation = useRef(false), heading = useRef(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false; onBusyChange?.(false) } }, [])
  useEffect(() => { heading.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => { setAddress(endpoint) }, [endpoint])
  const disabled = busy || checking || Boolean(pending)
  const selected = models.find(item => item.id === selection)
  const nativeActions = typeof window.electronAPI?.lmStudioApp?.performAction === 'function'
  const guidesAvailable = typeof window.electronAPI?.openExternalUrl === 'function'
  const performAction = async action => {
    if (disabled || operation.current) return
    operation.current = true; setPending(action); setNotice(''); setActionError(''); onBusyChange?.(true)
    try {
      // Preserve transient native user activation: no await before this call.
      // This adapter never touches the separate experimental setup conversation.
      const guide = action === 'installation_guide' ? 'https://lmstudio.ai/download' : action === 'connection_guide' ? 'https://lmstudio.ai/docs/developer/core/server' : null
      const result = guide ? await window.electronAPI.openExternalUrl(guide)
        : await window.electronAPI?.lmStudioApp?.performAction?.({ action: action === 'open_app' ? 'open' : 'choose' })
      if (!alive.current) return
      if (result?.success !== true) throw new Error(result?.error || 'This setup action is unavailable. Open LM Studio yourself, then check again.')
      setNotice(result?.cancelled ? 'Cancelled. Nothing was changed.' : result?.summary || (action === 'open_app'
        ? 'LM Studio was opened. Start its server, then check again.' : action === 'choose_app'
          ? 'LM Studio was located. Open it when you are ready.' : 'The official guide was opened.'))
    } catch (failure) { if (alive.current) setActionError(failure.message || 'The setup action could not finish.') }
    finally { operation.current = false; if (alive.current) { setPending(''); onBusyChange?.(false) } }
  }
  const saveAddress = () => {
    const value = address.trim()
    try {
      const url = new URL(value)
      if (value.length > 256 || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.port !== '1234' || !['/v1', '/v1/'].includes(url.pathname) || url.username || url.password || url.search || url.hash) throw new Error()
    } catch { setActionError('Use a local HTTP address on port 1234 with /v1, such as http://127.0.0.1:1234/v1. The saved address is unchanged.'); return }
    setActionError(''); onEndpoint(value)
  }
  return <section className="ca-lmstudio-setup" aria-label="LM Studio setup" aria-busy={checking || Boolean(pending)}>
    <h3 ref={heading} tabIndex={-1}>Connect LM Studio</h3>
    <p>Use a model on your computer. No Velorn account is needed.</p>
    {checking ? <p role="status">Checking your LM Studio server…</p> : connected ? <>
      <p role="status">Connected to LM Studio.</p>
      {models.length > 0 ? <>
        <label>Model<select aria-label="LM Studio model" value={selected ? selection : ''} disabled={disabled} onChange={event => setSelection(event.target.value)}>
          <option value="" disabled>Choose a model…</option>
          {models.map(item => <option key={item.id} value={item.id}>{localModelOptionLabel(item)}</option>)}
        </select></label>
        {selected && <p>{selected.loaded === true ? 'Loaded at last check.' : selected.loaded === false
          ? 'Not currently loaded. LM Studio may load it when you send a message.' : 'Loaded state is unknown. Selecting it does not load it or test its capabilities.'}</p>}
        {model && !models.some(item => item.id === model) && <p>Your saved model, {model}, is not in this list. It is unchanged; choose another model or use its ID under Troubleshooting.</p>}
      </> : <p>No chat models were found. In LM Studio, use Discover to download a model, then check again.</p>}
    </> : <>
      <p role="status">LM Studio’s server is not reachable yet.</p>
      <p>Open LM Studio, go to the Developer tab, and select Start server. Then check again.</p>
      <p className="ca-note">This does not mean LM Studio is missing.</p>
    </>}
    <div className="ca-entry-guide-actions">
      {connected && models.length > 0 && <button type="button" className="ca-lmstudio-primary" disabled={disabled || !selected} onClick={() => onUseModel(selection)}>Use model</button>}
      <button type="button" className={connected && models.length ? undefined : 'ca-lmstudio-primary'} disabled={disabled} onClick={onCheck}>{checking ? 'Checking…' : 'Check again'}</button>
      <button type="button" className="ca-lmstudio-later" disabled={Boolean(pending) || busy} onClick={onLater}>Not now</button>
    </div>
    {(!connected || !models.length) && <div className="ca-lmstudio-app-help">
      <div className="ca-entry-guide-actions">
        <button type="button" disabled={disabled || !nativeActions} onClick={() => void performAction('open_app')}>{pending === 'open_app' ? 'Opening…' : 'Open LM Studio'}</button>
        {!connected && <button type="button" disabled={disabled || !guidesAvailable} onClick={() => void performAction('installation_guide')}>Get LM Studio</button>}
      </div>
      {!connected && <button type="button" className="ca-inline-link" disabled={disabled || !nativeActions} onClick={() => void performAction('choose_app')}>Already installed? Choose its location</button>}
      {!nativeActions && <p>Open LM Studio yourself, then check again. App-opening controls are unavailable in this session.</p>}
    </div>}
    {notice && <p role="status">{notice}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    <details className="ca-lmstudio-troubleshooting">
      <summary>Troubleshooting</summary>
      {connectionError && <p role="status">{connectionError}</p>}
      <label>Local server address<input aria-label="LM Studio server address" value={address} disabled={disabled} onChange={event => setAddress(event.target.value)} /></label>
      <button type="button" disabled={disabled || !address.trim()} onClick={saveAddress}>Save address and check</button>
      <p>Use your local LM Studio server. Typing here does not change the saved address.</p>
      <label>Custom model ID<input aria-label="Custom model ID" value={customId} maxLength={256} disabled={disabled} onChange={event => setCustomId(event.target.value)} /></label>
      <button type="button" disabled={disabled || !connected || !customId.trim()} onClick={() => onUseModel(customId.trim())}>Use custom model</button>
      <p>A custom ID is not verified against the model list. No model is downloaded, loaded or inference-tested by setup.</p>
      <button type="button" disabled={disabled || !guidesAvailable} onClick={() => void performAction('connection_guide')}>Open LM Studio connection guide</button>
    </details>
  </section>
}
