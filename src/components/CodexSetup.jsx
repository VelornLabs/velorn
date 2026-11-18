import { useEffect, useRef, useState } from 'react'

const INSTALL_GUIDE = 'https://learn.chatgpt.com/docs/codex/cli'
const ACTIVE_INSTALL = new Set(['downloading', 'verifying', 'installing'])
const megabytes = bytes => `${(Math.max(0, Number(bytes) || 0) / 1024 / 1024).toFixed(1)} MB`

/** One state-driven setup surface. Native code owns installation consent and paths. */
export default function CodexSetup({ state, checking, busy, loginPending, loginAvailable, error,
  onDetect, onLogin, onCancel, onLater, onChooseExecutable, onAutomatic, executable,
  onInstallBusyChange }) {
  const installer = window.electronAPI?.codexSetupInstaller
  const [guideOnly, setGuideOnly] = useState(!installer?.plan || !installer?.install)
  const [localError, setLocalError] = useState('')
  const [notice, setNotice] = useState('')
  const [planning, setPlanning] = useState(false)
  const [job, setJob] = useState(null)
  const [cancelling, setCancelling] = useState(false)
  const alive = useRef(true), operation = useRef(null), activeJob = useRef(null), timer = useRef(null)
  const guideReturn = useRef(false)
  const callbacks = useRef({ onDetect, onInstallBusyChange })
  callbacks.current = { onDetect, onInstallBusyChange }
  const installing = planning || Boolean(job && ACTIVE_INSTALL.has(job.state))
  useEffect(() => { callbacks.current.onInstallBusyChange?.(installing) }, [installing])
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false; operation.current = null; clearTimeout(timer.current)
      if (activeJob.current) void Promise.resolve(installer?.cancel?.({ jobId: activeJob.current })).catch(() => {})
      callbacks.current.onInstallBusyChange?.(false)
    }
  }, [installer])
  const needsLogin = state === 'signin'
  useEffect(() => {
    const returned = () => {
      if (!guideReturn.current || document.visibilityState === 'hidden' || busy || checking || installing || loginPending) return
      guideReturn.current = false
      void callbacks.current.onDetect?.()
    }
    window.addEventListener('focus', returned)
    return () => window.removeEventListener('focus', returned)
  }, [busy, checking, installing, loginPending])
  async function openGuide() {
    setLocalError('')
    try {
      if (!window.electronAPI?.openExternalUrl) throw new Error()
      guideReturn.current = true
      const result = await window.electronAPI.openExternalUrl(INSTALL_GUIDE)
      if (result?.success === false) throw new Error()
      if (alive.current) setNotice('Follow the official installation instructions, then return here. Velorn will check again when you return.')
    } catch { guideReturn.current = false; if (alive.current) setLocalError('Open learn.chatgpt.com/docs/codex/cli in your browser for the official installation instructions.') }
  }
  function consume(result, token) {
    if (!alive.current || operation.current !== token) return
    if (!result?.success || typeof result.jobId !== 'string' || result.jobId !== activeJob.current
      || ![...ACTIVE_INSTALL, 'completed', 'failed', 'cancelled'].includes(result.state)) {
      throw new Error(result?.error?.message || result?.error || 'Installation progress could not be checked. Use Cancel before trying again.')
    }
    setLocalError('')
    setJob(result)
    if (ACTIVE_INSTALL.has(result.state)) {
      timer.current = setTimeout(() => { void poll(token) }, 600)
    } else {
      activeJob.current = null; operation.current = null
      if (result.state === 'completed') {
        setNotice('Codex installed. Checking the connection…')
        void callbacks.current.onDetect?.()
      } else if (result.state === 'failed') setLocalError(result.error?.message || result.error || 'Codex could not be installed. You can retry or use the installation guide.')
      else setNotice('Installation cancelled. You can keep editing.')
    }
  }
  async function poll(token) {
    try { consume(await installer.status({ jobId: activeJob.current }), token) }
    catch (failure) {
      if (alive.current && operation.current === token) setLocalError(failure.message || 'Installation progress is unavailable. Cancel before trying again.')
    }
  }
  async function install() {
    if (operation.current || busy || checking || loginPending) return
    const token = {}; operation.current = token
    setPlanning(true); setLocalError(''); setNotice(''); setJob(null)
    try {
      const plan = await installer.plan({})
      if (!alive.current || operation.current !== token) return
      if (plan?.supported === false) {
        setGuideOnly(true); setNotice(plan.error || 'Use the official installation guide on this computer.'); return
      }
      if (!plan?.success || typeof plan.planId !== 'string') throw new Error(plan?.error || 'The Codex download could not be prepared. Try again or use the installation guide.')
      // The native dialog reviews source, size and destination. This renderer
      // cannot supply a URL, path, executable or a claimed approval.
      const result = await installer.install({ planId: plan.planId })
      if (!alive.current || operation.current !== token) {
        if (result?.jobId) void Promise.resolve(installer.cancel({ jobId: result.jobId })).catch(() => {})
        return
      }
      if (result?.cancelled) { setNotice('Installation cancelled. Nothing was installed.'); return }
      if (!result?.success || typeof result.jobId !== 'string') throw new Error(result?.error || 'Codex could not be installed.')
      activeJob.current = result.jobId
      consume(result, token)
    } catch (failure) {
      if (alive.current && operation.current === token) setLocalError(failure.message || 'Codex could not be installed.')
    } finally {
      if (alive.current) setPlanning(false)
      if (operation.current === token && !activeJob.current) operation.current = null
    }
  }
  async function cancelInstall() {
    if (!activeJob.current || cancelling) return
    setCancelling(true)
    const token = operation.current
    try {
      const result = await installer.cancel({ jobId: activeJob.current })
      if (!alive.current || operation.current !== token) return
      if (!result?.success) throw new Error(result?.error || 'Could not cancel installation. Wait for it to finish.')
      clearTimeout(timer.current)
      await poll(token)
    } catch (failure) { if (alive.current) setLocalError(failure.message) }
    finally { if (alive.current) setCancelling(false) }
  }
  const unavailable = needsLogin && !loginAvailable
  const disabled = busy || checking || installing || loginPending
  const showLocationChoice = state === 'missing' && !checking && !installing && !loginPending && Boolean(onChooseExecutable)
  const step = checking ? 'Checking Codex…' : planning ? 'Preparing the download…'
    : job?.state === 'downloading' ? 'Downloading Codex…' : job?.state === 'verifying' ? 'Verifying the download…'
      : job?.state === 'installing' ? 'Installing Codex…' : loginPending ? 'Finish signing in in your browser.'
        : needsLogin ? 'Codex is installed. Sign in with your ChatGPT account.'
          : state === 'problem' ? 'Codex could not connect. Check again, or open Troubleshooting below.'
            : 'Install Codex once, then sign in with your ChatGPT account. No Velorn account is needed.'
  return <section className="ca-codex-setup" aria-label="Codex setup">
    <h3>{needsLogin || loginPending ? 'Sign in to Codex' : 'Set up Codex'}</h3>
    <p role="status">{step}</p>
    {installing && job && <div className="ca-codex-progress">
      <progress aria-label="Codex installation progress" max={job.totalBytes || 1} value={job.bytesReceived || 0} />
      <span>{megabytes(job.bytesReceived)} of {megabytes(job.totalBytes)}</span>
    </div>}
    <div className="ca-installation-actions">
      {loginPending ? <button type="button" onClick={onCancel}>Cancel sign-in</button>
        : installing ? <button type="button" disabled={planning || cancelling || !activeJob.current} onClick={() => void cancelInstall()}>{cancelling ? 'Cancelling…' : planning ? 'Waiting for confirmation…' : 'Cancel installation'}</button>
          : checking ? null
            : needsLogin && !unavailable ? <button type="button" className="ca-codex-primary" disabled={disabled} onClick={onLogin}>Sign in with ChatGPT</button>
              : state === 'problem' || unavailable ? <button type="button" className="ca-codex-primary" disabled={disabled} onClick={onDetect}>Check again</button>
                : <button type="button" className="ca-codex-primary" disabled={disabled} onClick={guideOnly ? openGuide : () => void install()}>{guideOnly ? 'Open installation guide' : 'Install Codex'}</button>}
      {onLater && <button type="button" className="ca-codex-later" disabled={installing || loginPending} onClick={onLater}>Not now</button>}
    </div>
    {showLocationChoice && <button type="button" className="ca-codex-location" disabled={disabled} onClick={onChooseExecutable}>Already installed? Choose its location</button>}
    {unavailable && <p className="ca-installation-warning" role="alert">Guided sign-in is unavailable in this session. Use an updated desktop build or the manual steps below.</p>}
    {!checking && !installing && !loginPending && (localError || error) && <p className="ca-installation-warning" role="alert">{localError || error}</p>}
    {installing && localError && <div><p className="ca-installation-warning" role="alert">{localError}</p>
      <button type="button" disabled={planning || cancelling} onClick={() => { if (operation.current && activeJob.current) void poll(operation.current) }}>Check progress</button></div>}
    {notice && !installing && !loginPending && <p role="status">{notice}</p>}
    <details className="ca-codex-troubleshooting">
      <summary>Troubleshooting</summary>
      <p>Already installed Codex or finished signing in? Check again without changing your selected installation.</p>
      <div className="ca-installation-actions">
        <button type="button" disabled={disabled} onClick={onDetect}>Check again</button>
        {onChooseExecutable && !showLocationChoice && <button type="button" disabled={disabled} onClick={onChooseExecutable}>Choose executable…</button>}
        {executable?.mode === 'custom' && onAutomatic && <button type="button" disabled={disabled} onClick={onAutomatic}>Use automatic detection</button>}
        <button type="button" disabled={disabled} onClick={openGuide}>Open Codex guide</button>
      </div>
      {executable?.path && <code>{executable.path}</code>}
      <p>If browser sign-in does not open, cancel it here, run <code>codex login</code> in your terminal, then check again. Never paste passwords or sign-in codes into chat.</p>
      <p>Choosing a different installation or signing in turns off Full computer access. Your existing chats and model choice stay unchanged.</p>
    </details>
  </section>
}
