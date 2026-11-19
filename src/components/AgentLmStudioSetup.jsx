import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { Download, Check, AlertCircle, Loader2, X } from 'lucide-react'
import { createAgentLmStudioSetupTracker, formatModelBytes, lmStudioSetupPresentation } from '../utils/agentLmStudioSetup.mjs'
import './AgentSetupDownloads.css'

export function useAgentLmStudioSetup({ projectPath, chatId }) {
  const api = globalThis.window?.electronAPI?.lmStudioSetup
  const tracker = useMemo(() => createAgentLmStudioSetupTracker({ api, projectPath, chatId }), [api, projectPath, chatId])
  const state = useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot)
  useEffect(() => { tracker.start(); return () => tracker.dispose() }, [tracker])
  return { ...state, refresh: tracker.refresh, cancel: tracker.cancel, load: tracker.load }
}

export function AgentLmStudioSetup({ items = [], error = '', onRefresh, onCancel, onLoad,
  pendingById = {}, actionErrors = {}, exportBusy = false }) {
  if (!items.length && !error) return null
  return <section className="ca-setup-downloads ca-lmstudio-setups" aria-label="LM Studio model setup">
    {items.map(item => {
      const view = lmStudioSetupPresentation(item), pending = pendingById[item.jobId]
      const downloading = item.state === 'downloading', loading = item.state === 'loading'
      const Icon = loading || view.verifying ? Loader2 : downloading ? Download
        : item.state === 'ready' || item.state === 'completed' ? Check : item.state === 'cancelled' ? X : AlertCircle
      return <article className="ca-setup-download ca-lmstudio-setup" key={item.jobId} data-job-id={item.jobId} data-setup-state={item.state}>
        <header><Icon size={15} aria-hidden="true" /><strong>{item.modelName}</strong></header>
        <p className="ca-setup-download-status" role="status">{view.label}</p>
        {downloading && <>
          <progress aria-label="LM Studio model download progress" {...(view.percent !== null ? { value: view.percent, max: 100 } : {})} />
          <p className="ca-setup-download-bytes">{view.received !== null ? `${formatModelBytes(view.received)} received` : 'Progress unavailable'}
            {view.total > 0 ? ` of ${formatModelBytes(view.total)}` : ' · Size unknown'}{view.percent !== null && ` · ${view.percent}%`}</p>
        </>}
        {loading && <><progress aria-label="LM Studio model loading progress" />
          <p className="ca-setup-download-hint">This step cannot be cancelled here. Waiting for LM Studio to confirm the result.</p></>}
        {item.state === 'completed' && <p className="ca-setup-download-hint">{item.canLoad
          ? 'Loading uses computer memory and requires your confirmation. Downloading alone does not connect a model.'
          : item.error ? 'Loading has not been verified. Check LM Studio before trying again.'
            : 'The model is not confirmed ready to load. Check its download and model identity in LM Studio.'}</p>}
        {item.state === 'ready' && <p className="ca-setup-download-hint">Your selected agent and model are unchanged. Prompt and tool support have not been tested.</p>}
        {view.contextHint && <p className="ca-setup-download-hint ca-lmstudio-context">{view.contextHint}</p>}
        {item.error && <p className="ca-setup-download-error">{item.error}</p>}
        {item.warning && <p className="ca-setup-download-warning">{item.warning}</p>}
        {actionErrors[item.jobId] && <p className="ca-setup-download-error" role="alert">{actionErrors[item.jobId]}</p>}
        {(downloading || item.canLoad) && <div className="ca-setup-download-actions">
          {downloading && <button type="button" disabled={Boolean(pending) || !onCancel} onClick={() => void onCancel?.(item.jobId)}>
            {pending === 'cancel' ? 'Cancelling…' : 'Cancel model download'}</button>}
          {item.state === 'completed' && item.canLoad && <button type="button" disabled={exportBusy || Boolean(pending) || !onLoad}
            title={exportBusy ? 'Wait for export to finish before loading a model.' : undefined} onClick={() => void onLoad?.(item.jobId)}>
            {pending === 'load' ? 'Waiting for approval…' : 'Load & check connection'}</button>}
          {item.state === 'completed' && item.canLoad && exportBusy && <span>Available after export.</span>}
        </div>}
      </article>
    })}
    {error && <div className="ca-setup-download-recovery"><p role="alert">{error}</p>
      <p>{items.length ? 'The last known model setup state is shown.' : 'No current model setup status is available.'}</p>
      {onRefresh && <button type="button" onClick={() => void onRefresh()}>Refresh model progress</button>}
    </div>}
  </section>
}
