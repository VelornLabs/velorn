import { useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FolderSearch,
  KeyRound,
  LayoutGrid,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import WorkflowFieldRenderer from './WorkflowFieldRenderer'
import { formatBytes } from '../../hooks/useWorkflowSetupFlow'

function SetupItemList({ items, diskSpace, insufficientDiskSpace, totalDownloadBytes }) {
  if (!Array.isArray(items) || items.length === 0) return null
  return (
    <div className="mt-2 space-y-1 rounded-lg border border-sf-dark-700 bg-sf-dark-800/60 p-2">
      {items.map((item) => (
        <div key={item.key} className="flex items-center gap-2 px-1 py-1 text-[11px]">
          {item.kind === 'nodes' ? (
            <Boxes className="h-3.5 w-3.5 shrink-0 text-sf-accent" />
          ) : item.kind === 'model' ? (
            <Download className="h-3.5 w-3.5 shrink-0 text-sf-accent" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-yellow-400" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sf-text-primary">{item.label}</div>
            <div className="truncate text-[10px] text-sf-text-muted">
              {item.detail}
              {item.kind === 'nodes' ? ' · restart handled after install' : ''}
              {!item.auto ? ' · manual step' : ''}
            </div>
          </div>
          {item.docsUrl ? (
            <a
              href={item.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-sf-text-muted transition-colors hover:text-sf-text-primary"
              aria-label={`Open instructions for ${item.label}`}
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          <div className="shrink-0 text-[10px] text-sf-text-muted">
            {item.kind === 'model' ? (Number.isFinite(item.sizeBytes) ? formatBytes(item.sizeBytes) : 'Size unknown') : ''}
          </div>
        </div>
      ))}
      {diskSpace?.checked && Number.isFinite(diskSpace.freeBytes) && (
        <div className={`border-t border-sf-dark-700 px-1 pt-1.5 text-[10px] ${insufficientDiskSpace ? 'text-sf-error' : 'text-sf-text-muted'}`}>
          {insufficientDiskSpace
            ? `Not enough disk space — needs ${formatBytes(totalDownloadBytes)}, ${formatBytes(diskSpace.freeBytes)} free on the ComfyUI drive.`
            : `${formatBytes(diskSpace.freeBytes)} free on the ComfyUI drive.`}
        </div>
      )}
    </div>
  )
}

export default function WorkflowDetail({
  workflow,
  values,
  actions,
  setup = null,
  disabled = false,
  disabledReason = '',
  onBack = null,
}) {
  const [setupListOpen, setSetupListOpen] = useState(false)
  if (!workflow) {
    return (
      <div className="rounded-2xl border border-dashed border-sf-dark-700 bg-sf-dark-900/60 p-8 text-center text-sm text-sf-text-muted">
        Choose a workflow to configure it.
      </div>
    )
  }

  const previewBadges = [workflow.provider, workflow.badge]
    .map((label) => String(label || '').trim())
    .filter(Boolean)
    .filter((label, index, labels) => labels.findIndex((entry) => entry.toLowerCase() === label.toLowerCase()) === index)
  const previewAssets = Array.isArray(values?.previewAssets) ? values.previewAssets : []
  const previewAssetIndex = Math.max(0, Number(values?.previewAssetIndex) || 0)
  const previewAsset = values?.previewAsset
  const canPreviewAsset = previewAsset?.url && ['video', 'image', 'audio'].includes(previewAsset.type)
  const canCyclePreviewAssets = previewAssets.length > 1 && typeof actions?.onPreviewAssetIndexChange === 'function'
  const coverIsVideo = /\.(mp4|webm|mov)(\?|#|$)/i.test(String(workflow.cover || ''))
  const coverPosition = workflow.coverPosition || 'center'
  const goToPreviewAsset = (nextIndex) => {
    if (!canCyclePreviewAssets) return
    const wrappedIndex = (nextIndex + previewAssets.length) % previewAssets.length
    actions.onPreviewAssetIndexChange(wrappedIndex)
  }

  const queueLabel = `Queue ${workflow.outputType === 'audio' ? 'Audio' : workflow.outputType === 'image' ? 'Image' : 'Video'}`
  // Imported templates can pre-download their dependencies before they are runnable.
  const setupMode = (workflow.runnable || workflow.imported) && setup ? setup.mode : 'hidden'
  const setupItems = setup?.items || []
  const autoItemCount = setupItems.filter((item) => item.auto).length
  const setupHeadline = setup && setup.totalDownloadBytes > 0
    ? `Set up — ${formatBytes(setup.totalDownloadBytes)}${setup.unknownSizeCount > 0 ? '+' : ''} download`
    : `Set up — ${autoItemCount} item${autoItemCount === 1 ? '' : 's'}`

  return (
    <div className="space-y-3">
      {typeof onBack === 'function' && (
        <div className="sticky top-3 z-20">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900/95 px-3 py-2 text-xs font-medium text-sf-text-secondary shadow-lg shadow-black/20 backdrop-blur transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to workflows
          </button>
        </div>
      )}

    <div className="mx-auto w-full max-w-4xl space-y-4">
      <div className="mx-auto w-full max-w-xl">
        <div className="overflow-hidden rounded-2xl border border-sf-dark-700 bg-sf-dark-900">
          <div className="relative aspect-video bg-sf-dark-800">
            {canPreviewAsset && previewAsset.type === 'video' ? (
              <video
                src={previewAsset.url}
                className="h-full w-full object-contain"
                controls
                playsInline
              />
            ) : canPreviewAsset && previewAsset.type === 'image' ? (
              <img src={previewAsset.url} alt={previewAsset.name || ''} className="h-full w-full object-contain" />
            ) : canPreviewAsset && previewAsset.type === 'audio' ? (
              <div className="flex h-full items-center justify-center p-6">
                <audio src={previewAsset.url} controls className="w-full max-w-md" />
              </div>
            ) : workflow.cover && coverIsVideo ? (
              <video
                src={workflow.cover}
                className="h-full w-full object-cover"
                style={{ objectPosition: coverPosition }}
                autoPlay
                muted
                loop
                playsInline
              />
            ) : workflow.cover ? (
              <img src={workflow.cover} alt="" className="h-full w-full object-cover" style={{ objectPosition: coverPosition }} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-sf-text-muted">No preview</div>
            )}
            {!canPreviewAsset && (
              <>
                <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/75" />
                <div className="absolute bottom-3 left-3 right-3">
                  {previewBadges.length > 0 && (
                    <div className="flex items-center gap-2">
                      {previewBadges.map((badge) => (
                        <span key={badge} className="rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
                          {badge}
                        </span>
                      ))}
                    </div>
                  )}
                  <h2 className="mt-2 text-lg font-semibold leading-tight text-white">{workflow.title}</h2>
                  <p className="mt-1 max-w-2xl text-xs text-white/75">{workflow.description}</p>
                </div>
              </>
            )}
            {canCyclePreviewAssets && (
              <div className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => goToPreviewAsset(previewAssetIndex - 1)}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white backdrop-blur transition-colors hover:bg-black/85"
                  aria-label="Previous generated image"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <div className="rounded-full bg-black/65 px-3 py-1 text-[11px] font-semibold text-white backdrop-blur">
                  {previewAssetIndex + 1} / {previewAssets.length}
                </div>
                <button
                  type="button"
                  onClick={() => goToPreviewAsset(previewAssetIndex + 1)}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-black/65 text-white backdrop-blur transition-colors hover:bg-black/85"
                  aria-label="Next generated image"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </div>

      </div>

      <div className="rounded-2xl border border-sf-dark-700 bg-sf-dark-900 p-4">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sf-text-muted">
              Workflow setup
            </div>
            <div className="mt-1 text-sm font-semibold text-sf-text-primary">{workflow.subtitle}</div>
          </div>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            workflow.runnable
              ? 'bg-emerald-400/10 text-emerald-300'
              : 'bg-yellow-400/10 text-yellow-300'
          }`}
          >
            {workflow.runnable ? 'Runnable' : 'Preview only'}
          </span>
        </div>

        <div className="space-y-3">
          {(workflow.fields || []).map((field) => (
            <WorkflowFieldRenderer
              key={field.id}
              field={field}
              workflow={workflow}
              values={values}
              actions={actions}
            />
          ))}
        </div>

        {!workflow.runnable && (
          <div className="mt-4 rounded-lg border border-yellow-400/25 bg-yellow-400/10 p-3 text-xs text-yellow-200">
            {workflow.imported ? (
              <>
                This template needs custom nodes your ComfyUI doesn't have yet
                {workflow.unknownNodeTypes?.length > 0 && (
                  <>: <span className="font-semibold">{workflow.unknownNodeTypes.join(', ')}</span></>
                )}.
                {workflow.requiresCustomNodes?.length > 0 && (
                  <> The template lists these node packs: {workflow.requiresCustomNodes.join(', ')}.</>
                )}
                {' '}Run Set up below and restart ComfyUI — the import finishes automatically once the
                nodes are in. If a pack resists, open the template in ComfyUI from its card and use
                Manager's install there instead.
              </>
            ) : (
              'This catalog item is in the browser as a candidate. We still need its workflow graph and bindings before it can run.'
            )}
          </div>
        )}

        {disabledReason && (
          <div className="mt-4 rounded-lg border border-sf-error/30 bg-sf-error/10 p-3 text-xs text-sf-error">
            {disabledReason}
          </div>
        )}

        {setupMode === 'hidden' ? (
          <button
            type="button"
            onClick={actions.onGenerate}
            disabled={disabled || !workflow.runnable}
            className={`mt-4 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              disabled || !workflow.runnable
                ? 'cursor-not-allowed bg-sf-dark-700 text-sf-text-muted'
                : 'bg-sf-accent text-white hover:bg-sf-accent-hover'
            }`}
          >
            <Sparkles className="h-4 w-4" />
            {queueLabel}
          </button>
        ) : (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setSetupListOpen((open) => !open)}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1.5 text-[11px] text-sf-text-secondary transition-colors hover:text-sf-text-primary"
            >
              <span>
                {setupItems.length} item{setupItems.length === 1 ? '' : 's'} needed before this workflow can run
              </span>
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${setupListOpen ? 'rotate-180' : ''}`} />
            </button>

            {setupListOpen && (
              <SetupItemList
                items={setupItems}
                diskSpace={setup.diskSpace}
                insufficientDiskSpace={setup.insufficientDiskSpace}
                totalDownloadBytes={setup.totalDownloadBytes}
              />
            )}

            {setup.error && (
              <div className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-sf-error/30 bg-sf-error/10 p-2 text-[11px] text-sf-error">
                <span className="min-w-0 break-words">{setup.error}</span>
                {setupMode === 'setup' && (
                  <button
                    type="button"
                    onClick={setup.dismissError}
                    className="shrink-0 text-sf-text-muted transition-colors hover:text-sf-text-primary"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            )}

            {setupMode === 'setup' && (
              <button
                type="button"
                onClick={() => { void setup.startSetup() }}
                disabled={setup.insufficientDiskSpace}
                className={`mt-2 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
                  setup.insufficientDiskSpace
                    ? 'cursor-not-allowed bg-sf-dark-700 text-sf-text-muted'
                    : 'bg-sf-accent text-white hover:bg-sf-accent-hover'
                }`}
              >
                <Download className="h-4 w-4" />
                {setupHeadline}
              </button>
            )}

            {setupMode === 'choose-root' && (
              <>
                <button
                  type="button"
                  onClick={() => { void setup.chooseComfyFolder() }}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-sf-accent px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-sf-accent-hover"
                >
                  <FolderSearch className="h-4 w-4" />
                  Choose your ComfyUI folder
                </button>
                <div className="mt-1.5 text-center text-[10px] text-sf-text-muted">
                  {setup.rootValidation?.error || 'Point Velorn at your ComfyUI install so it can download the missing files for you.'}
                </div>
              </>
            )}

            {setupMode === 'installing' && (
              <div className="mt-2 rounded-lg border border-sf-dark-700 bg-sf-dark-800/60 p-3">
                <div className="flex items-center gap-2 text-xs text-sf-text-primary">
                  <Loader2 className="h-4 w-4 animate-spin text-sf-accent" />
                  <span className="min-w-0 flex-1 truncate">
                    {setup.progress.currentLabel || setup.progress.message || 'Installing...'}
                  </span>
                  {setup.progress.totalTasks > 1 && (
                    <span className="shrink-0 text-[10px] text-sf-text-muted">
                      {Math.min(setup.progress.completedTasks + 1, setup.progress.totalTasks)}/{setup.progress.totalTasks}
                    </span>
                  )}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sf-dark-700">
                  <div
                    className="h-full rounded-full bg-sf-accent transition-[width] duration-300"
                    style={{ width: `${Math.max(2, Number(setup.progress.overallPercent) || 0)}%` }}
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[10px] text-sf-text-muted">
                  <span>
                    {setup.progress.taskPercent != null ? `${Math.round(setup.progress.taskPercent)}%` : ''}
                  </span>
                  <span>
                    {setup.progress.totalBytes > 0
                      ? `${formatBytes(setup.progress.bytesDownloaded)} of ${formatBytes(setup.progress.totalBytes)}`
                      : ''}
                  </span>
                </div>
              </div>
            )}

            {setupMode === 'needs-restart' && (
              (setup.restartCapability === 'restart' || setup.restartCapability === 'start') ? (
                <button
                  type="button"
                  onClick={() => { void setup.restartNow() }}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-yellow-500/90 px-4 py-3 text-sm font-semibold text-black transition-colors hover:bg-yellow-400"
                >
                  <RefreshCw className="h-4 w-4" />
                  Restart ComfyUI to finish setup
                </button>
              ) : (
                <>
                  <div className="mt-2 rounded-lg border border-yellow-400/25 bg-yellow-400/10 p-3 text-[11px] text-yellow-200">
                    Install complete. Restart ComfyUI where you started it so the new nodes load, then re-check.
                  </div>
                  <button
                    type="button"
                    onClick={() => { void setup.recheckAfterManualRestart() }}
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-sf-dark-500 px-4 py-2.5 text-sm font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-400 hover:text-sf-text-primary"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Re-check
                  </button>
                </>
              )
            )}

            {setupMode === 'restarting' && (
              <button
                type="button"
                disabled
                className="mt-2 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg bg-sf-dark-700 px-4 py-3 text-sm font-semibold text-sf-text-muted"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                Restarting ComfyUI...
              </button>
            )}

            {setupMode === 'needs-auth' && (
              <button
                type="button"
                onClick={() => actions.onOpenApiKeyDialog?.()}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-sf-accent px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-sf-accent-hover"
              >
                <KeyRound className="h-4 w-4" />
                Add your Comfy.org API key
              </button>
            )}

            {setupMode === 'manual-only' && (
              <button
                type="button"
                disabled
                className="mt-2 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg bg-sf-dark-700 px-4 py-3 text-sm font-semibold text-sf-text-muted"
              >
                <Sparkles className="h-4 w-4" />
                {queueLabel}
              </button>
            )}

            {setup.needsAuth && setupMode !== 'needs-auth' && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-yellow-400/25 bg-yellow-400/5 px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-[10px] text-yellow-300">
                  <KeyRound className="h-3 w-3" />
                  <span>This workflow also needs a Comfy.org API key.</span>
                </div>
                <button
                  type="button"
                  onClick={() => actions.onOpenApiKeyDialog?.()}
                  className="shrink-0 rounded bg-sf-accent px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-sf-accent/90"
                >
                  Add key
                </button>
              </div>
            )}
          </div>
        )}

        {workflow.imported && (
          <button
            type="button"
            onClick={() => actions.onOpenImportedInComfyUi?.()}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-sf-dark-500 px-4 py-2.5 text-sm font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-400 hover:text-sf-text-primary"
          >
            <LayoutGrid className="h-4 w-4" />
            Open in ComfyUI
          </button>
        )}
      </div>
    </div>
    </div>
  )
}
