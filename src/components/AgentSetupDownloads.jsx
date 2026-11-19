import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { Download, Check, AlertCircle, Loader2, X } from 'lucide-react'
import { createAgentSetupDownloadsTracker, formatInstallerBytes, installerDownloadPresentation } from '../utils/agentSetupDownloads.mjs'
import './AgentSetupDownloads.css'

export function useAgentSetupDownloads({ projectPath, chatId }) {
  const api = globalThis.window?.electronAPI?.toolSetup
  const tracker = useMemo(() => createAgentSetupDownloadsTracker({ api, projectPath, chatId }), [api, projectPath, chatId])
  const state = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot)
  useEffect(() => { tracker.start(); return () => tracker.dispose() }, [tracker])
  return { ...state, refresh: tracker.refresh, cancel: tracker.cancel, open: tracker.open }
}

export function AgentSetupDownloads({ items = [], error = '', onRefresh, onCancel, onOpen,
  pendingById = {}, actionErrors = {}, exportBusy = false }) {
  if (!items.length && !error) return null
  return <section className="ca-setup-downloads" aria-label="Installer downloads">
    {items.map(item => {
      const view = installerDownloadPresentation(item), pending = pendingById[item.jobId]
      const active = item.state === 'downloading'
      const Icon = active ? (view.verifying ? Loader2 : Download) : item.state === 'completed' ? Check : item.state === 'cancelled' ? X : AlertCircle
      return <article className="ca-setup-download" key={item.jobId} data-job-id={item.jobId} data-setup-state={item.state}>
        <header><Icon size={15} aria-hidden="true" /><strong>{view.name} installer</strong></header>
        <p className="ca-setup-download-status" role="status">{view.label}</p>
        {active && <>
          <progress aria-label={`${view.name} installer download progress`} {...(view.percent !== null ? { value: view.percent, max: 100 } : {})} />
          <p className="ca-setup-download-bytes">{view.received !== null ? `${formatInstallerBytes(view.received)} received` : 'Progress unavailable'}
            {view.total > 0 ? ` of ${formatInstallerBytes(view.total)}` : ' · Size unknown'}{view.percent !== null && ` · ${view.percent}%`}</p>
        </>}
        {item.state === 'completed' && <p className="ca-setup-download-hint">{item.opened
          ? 'Finish the installer’s steps, then check setup. Opening does not confirm installation or connection.'
          : 'Not installed or connected yet. Opening requires your confirmation.'}</p>}
        {item.error && <p className="ca-setup-download-error">{item.error}</p>}
        {item.warning && <p className="ca-setup-download-warning">{item.warning}</p>}
        {actionErrors[item.jobId] && <p className="ca-setup-download-error" role="alert">{actionErrors[item.jobId]}</p>}
        {(active || item.canOpen) && <div className="ca-setup-download-actions">
          {active && <button type="button" disabled={Boolean(pending) || !onCancel} onClick={() => void onCancel?.(item.jobId)}>
            {pending === 'cancel' ? 'Cancelling…' : 'Cancel download'}</button>}
          {item.state === 'completed' && item.canOpen && <button type="button" disabled={exportBusy || Boolean(pending) || !onOpen}
            title={exportBusy ? 'Wait for the export to finish before opening the installer.' : undefined} onClick={() => void onOpen?.(item.jobId)}>
            {pending === 'open' ? 'Waiting for approval…' : 'Open installer'}</button>}
          {item.state === 'completed' && item.canOpen && exportBusy && <span>Available after export.</span>}
        </div>}
      </article>
    })}
    {error && <div className="ca-setup-download-recovery"><p role="alert">{error}</p>
      <p>{items.length ? 'The last known download state is shown.' : 'No current download status is available.'}</p>
      {onRefresh && <button type="button" onClick={() => void onRefresh()}>Refresh download progress</button>}
    </div>}
  </section>
}
