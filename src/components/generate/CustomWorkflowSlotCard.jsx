import { useState } from 'react'
import { CheckCircle2, ChevronRight, Clipboard, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react'
import CustomWorkflowLibraryPicker from './CustomWorkflowLibraryPicker'

/**
 * Shared "custom workflow" slot card for Director creators (keyframe + video
 * slots). Primary path: pick a saved My Workflows graph — the picker is the
 * card's main content until a workflow is loaded, then the card collapses to
 * a one-line summary. Import JSON and the Velorn bridge live under Advanced;
 * the bridge section shrinks to a note once installed.
 */
export default function CustomWorkflowSlotCard({
  kind = 'keyframe',
  workflowName = '',
  workflowLoaded = false,
  validation,
  canOpenInComfyUi = true,
  onOpenInComfyUi,
  onImportJson,
  onClear,
  onPickLibrary,
  bridgeStatus,
  bridgeBusy = false,
  bridgeIntro = '',
  onInstallBridge,
  onCheckBridge,
}) {
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [changingWorkflow, setChangingWorkflow] = useState(false)

  const validationOk = Boolean(validation?.ok)
  const warnings = Array.isArray(validation?.warnings) ? validation.warnings : []
  const pickerVisible = !workflowLoaded || changingWorkflow

  const bridgeState = String(bridgeStatus?.state || 'unknown').trim()
  const bridgeInstalled = Boolean(bridgeStatus?.installed)
  const bridgeMessage = String(
    bridgeStatus?.message
    || bridgeStatus?.error
    || 'Optional bridge lets ComfyUI send the current graph back to Velorn.'
  ).trim()
  const bridgeBadge = bridgeState === 'unavailable'
    ? { label: 'Needs setup', className: 'border-amber-500/40 bg-amber-500/10 text-amber-200' }
    : bridgeState === 'not_installed'
      ? { label: 'Optional', className: 'border-sf-accent/40 bg-sf-accent/10 text-sf-accent' }
      : { label: 'Checking', className: 'border-sf-dark-500 bg-sf-dark-800 text-sf-text-secondary' }
  const canInstallBridge = typeof onInstallBridge === 'function'
    && !bridgeInstalled
    && bridgeState !== 'unavailable'

  return (
    <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-sf-text-muted">Custom workflow</span>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${
            workflowLoaded && validationOk
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
          }`}>
            {workflowLoaded ? (validationOk ? 'Ready' : 'Needs setup') : 'None loaded'}
          </span>
          {workflowLoaded && (
            <span className="truncate text-xs text-sf-text-primary">{workflowName || 'Custom workflow'}</span>
          )}
        </div>
        {workflowLoaded && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setChangingWorkflow((current) => !current)}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
              title="Pick a different saved workflow."
            >
              {changingWorkflow ? 'Cancel' : 'Change'}
            </button>
            <button
              type="button"
              onClick={onOpenInComfyUi}
              disabled={!canOpenInComfyUi}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-accent/50 bg-sf-accent/10 px-2 py-1.5 text-[10px] font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:border-sf-dark-600 disabled:bg-sf-dark-800 disabled:text-sf-text-muted"
              title="Open the loaded custom workflow in the embedded ComfyUI tab."
            >
              <ExternalLink className="h-3 w-3" />
              Open in ComfyUI
            </button>
            <button
              type="button"
              onClick={() => {
                setChangingWorkflow(false)
                onClear?.()
              }}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-muted transition-colors hover:border-red-500/60 hover:text-red-300"
              title="Clear the loaded custom workflow."
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          </div>
        )}
      </div>

      {workflowLoaded && !validationOk && (
        <div className="mt-2 text-[10px] text-amber-200">{validation?.message}</div>
      )}
      {workflowLoaded && warnings.length > 0 && (
        <div className="mt-1 text-[10px] text-amber-200">{warnings.slice(0, 2).join(' ')}</div>
      )}

      {pickerVisible && (
        <CustomWorkflowLibraryPicker
          kind={kind}
          dismissible={workflowLoaded}
          onPick={async (id) => {
            const result = await onPickLibrary?.(id)
            if (result?.success) setChangingWorkflow(false)
            return result
          }}
          onClose={() => setChangingWorkflow(false)}
        />
      )}

      {!workflowLoaded && (
        <div className="mt-2 text-[10px] leading-4 text-sf-text-muted">
          Need a starting point?{' '}
          <button
            type="button"
            onClick={onOpenInComfyUi}
            disabled={!canOpenInComfyUi}
            className="font-semibold text-sf-accent transition-colors hover:underline disabled:cursor-not-allowed disabled:text-sf-text-muted"
          >
            Open the starter in ComfyUI
          </button>
          {' '}— it has every VELORN node title already set. Make it yours, then save it to My Workflows.
        </div>
      )}

      <div className="mt-3 border-t border-sf-dark-700 pt-2">
        <button
          type="button"
          onClick={() => setShowAdvanced((current) => !current)}
          className="inline-flex items-center gap-1 text-[10px] font-medium text-sf-text-muted transition-colors hover:text-sf-text-primary"
        >
          <ChevronRight className={`h-3 w-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
          Advanced
        </button>
        {showAdvanced && (
          <div className="mt-2 grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] text-sf-text-muted">Have API-format JSON exported from ComfyUI?</span>
              <button
                type="button"
                onClick={onImportJson}
                className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
                title="Import the API JSON you exported from ComfyUI."
              >
                <Clipboard className="h-3 w-3" />
                Import JSON
              </button>
            </div>
            {bridgeInstalled ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[10px] text-emerald-300">
                  Velorn Bridge installed — Send to Velorn is available inside ComfyUI.
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={onInstallBridge}
                    disabled={bridgeBusy || typeof onInstallBridge !== 'function'}
                    className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    title="Copy the latest bundled bridge files into ComfyUI custom_nodes. Restart ComfyUI afterwards."
                  >
                    {bridgeBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                    Update
                  </button>
                  <button
                    type="button"
                    onClick={() => onCheckBridge?.({ silent: false })}
                    disabled={bridgeBusy || typeof onCheckBridge !== 'function'}
                    className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    title="Re-check whether the bridge is installed."
                  >
                    <RefreshCw className={`h-3 w-3 ${bridgeBusy ? 'animate-spin' : ''}`} />
                    Re-check
                  </button>
                </span>
              </div>
            ) : (
              <div className="rounded border border-sf-dark-700 bg-sf-dark-950/40 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-sf-text-muted">Velorn bridge</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] ${bridgeBadge.className}`}>
                    {bridgeBadge.label}
                  </span>
                </div>
                {bridgeIntro && (
                  <p className="mt-1 text-[10px] leading-4 text-sf-text-muted">{bridgeIntro}</p>
                )}
                {bridgeMessage && (
                  <div className={`mt-1 text-[10px] ${bridgeState === 'unavailable' ? 'text-amber-200' : 'text-sf-text-secondary'}`}>
                    {bridgeMessage}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={onInstallBridge}
                    disabled={!canInstallBridge || bridgeBusy}
                    className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-accent/50 bg-sf-accent/10 px-2 py-1.5 text-[10px] font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:border-sf-dark-600 disabled:bg-sf-dark-800 disabled:text-sf-text-muted"
                    title={bridgeState === 'unavailable' ? 'Choose a ComfyUI folder or configure the launcher first.' : 'Install the bundled Velorn Bridge into ComfyUI custom_nodes.'}
                  >
                    {bridgeBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                    Install Bridge
                  </button>
                  <button
                    type="button"
                    onClick={() => onCheckBridge?.({ silent: false })}
                    disabled={bridgeBusy || typeof onCheckBridge !== 'function'}
                    className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-[10px] font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                    title="Re-check whether the bridge is installed."
                  >
                    <RefreshCw className={`h-3 w-3 ${bridgeBusy ? 'animate-spin' : ''}`} />
                    Re-check
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
