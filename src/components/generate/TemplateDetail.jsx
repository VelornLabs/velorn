import { useState } from 'react'
import { ArrowLeft, CheckCircle2, Download, ExternalLink, KeyRound, LayoutGrid, Loader2, Puzzle, RefreshCw } from 'lucide-react'
import { formatBytes } from '../../hooks/useWorkflowSetupFlow'
import { formatUsageCount } from './TemplateCard'
import { importComfyTemplate } from '../../services/templateImporter'
import { openUiWorkflowInComfyUi } from '../../services/workflowSetupManager'
import { getImportedWorkflowEntries } from '../../config/importedWorkflowRegistry'

function MetaTile({ label, value }) {
  if (!value) return null
  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.14em] text-sf-text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-sf-text-primary">{value}</div>
    </div>
  )
}

export default function TemplateDetail({ template, onBack = null, isConnected = false }) {
  const [importState, setImportState] = useState({ phase: 'idle', message: '', error: '' })
  const [openComfyState, setOpenComfyState] = useState({ busy: false, message: '', error: '' })
  if (!template) return null

  const coverIsVideo = /\.(mp4|webm|mov)(\?|#|$)/i.test(String(template.thumbnailUrl || ''))
  const importedEntry = getImportedWorkflowEntries().find((entry) => entry.templateName === template.name) || null
  const alreadyImported = importState.phase === 'done' || Boolean(importedEntry)
  const importIncomplete = importState.phase === 'done'
    ? Boolean(importState.incomplete)
    : Boolean(importedEntry?.conversionIncomplete)
  const importing = importState.phase === 'importing'

  const handleOpenInComfy = async () => {
    if (openComfyState.busy) return
    setOpenComfyState({ busy: true, message: '', error: '' })
    try {
      const response = await fetch(template.workflowUrl, { cache: 'no-store' })
      if (!response.ok) throw new Error(`Could not download the template workflow (${response.status}).`)
      const uiWorkflow = await response.json()
      const result = await openUiWorkflowInComfyUi(uiWorkflow, { label: template.title })
      setOpenComfyState({
        busy: false,
        message: result.success ? result.hint : '',
        error: result.success ? '' : result.error,
      })
    } catch (error) {
      setOpenComfyState({
        busy: false,
        message: '',
        error: error instanceof Error ? error.message : 'Could not open the template in ComfyUI.',
      })
    }
  }

  const handleImport = async () => {
    if (importing) return
    setImportState({ phase: 'importing', message: 'Starting import...', error: '' })
    try {
      const result = await importComfyTemplate(template, {
        onProgress: (_step, message) => {
          setImportState((prev) => (prev.phase === 'importing' ? { ...prev, message } : prev))
        },
      })
      setImportState({
        phase: 'done',
        incomplete: Boolean(result?.entry?.conversionIncomplete),
        message: '',
        error: '',
      })
    } catch (error) {
      setImportState({
        phase: 'error',
        message: '',
        error: error instanceof Error ? error.message : 'Import failed.',
      })
    }
  }

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
            Back to templates
          </button>
        </div>
      )}

      <div className="mx-auto w-full max-w-4xl space-y-4">
        <div className="mx-auto w-full max-w-xl">
          <div className="overflow-hidden rounded-2xl border border-sf-dark-700 bg-sf-dark-900">
            <div className="relative aspect-video bg-sf-dark-800">
              {template.thumbnailUrl && coverIsVideo ? (
                <video
                  src={template.thumbnailUrl}
                  className="h-full w-full object-contain"
                  autoPlay
                  muted
                  loop
                  playsInline
                />
              ) : template.thumbnailUrl ? (
                <img src={template.thumbnailUrl} alt="" className="h-full w-full object-contain" />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-sf-text-muted">No preview</div>
              )}
              <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-black/75" />
              <div className="absolute bottom-3 left-3 right-3">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-sky-400/20 px-2 py-0.5 text-[10px] font-semibold text-sky-200 backdrop-blur">
                    ComfyUI template
                  </span>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold backdrop-blur ${
                    template.openSource ? 'bg-black/55 text-white' : 'bg-amber-400/20 text-amber-200'
                  }`}
                  >
                    {template.openSource ? 'Open source' : (
                      <>
                        <KeyRound className="h-2.5 w-2.5" />
                        Comfy API key
                      </>
                    )}
                  </span>
                </div>
                <h2 className="mt-2 text-lg font-semibold leading-tight text-white">{template.title}</h2>
                <p className="mt-1 max-w-2xl text-xs text-white/75">{template.description}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-sf-dark-700 bg-sf-dark-900 p-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MetaTile label="Download" value={template.sizeBytes > 0 ? formatBytes(template.sizeBytes) : ''} />
            <MetaTile label="VRAM" value={template.vramBytes > 0 ? formatBytes(template.vramBytes) : ''} />
            <MetaTile label="Popularity" value={formatUsageCount(template.usage)} />
            <MetaTile label="Updated" value={template.date} />
          </div>

          {template.models.length > 0 && (
            <div className="mt-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sf-text-muted">Models</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {template.models.map((model) => (
                  <span key={model} className="rounded border border-sf-dark-600 bg-sf-dark-800 px-1.5 py-0.5 text-[11px] text-sf-text-secondary">
                    {model}
                  </span>
                ))}
              </div>
            </div>
          )}

          {template.requiresCustomNodes.length > 0 && (
            <div className="mt-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sf-text-muted">Custom nodes</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {template.requiresCustomNodes.map((pack) => (
                  <span key={pack} className="inline-flex items-center gap-1 rounded border border-sf-dark-600 bg-sf-dark-800 px-1.5 py-0.5 text-[11px] text-sf-text-secondary">
                    <Puzzle className="h-3 w-3 text-sf-text-muted" />
                    {pack}
                  </span>
                ))}
              </div>
            </div>
          )}

          {template.tags.length > 0 && (
            <div className="mt-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sf-text-muted">Tags</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {template.tags.map((tag) => (
                  <span key={tag} className="rounded-full border border-sf-dark-700 bg-sf-dark-800 px-2 py-0.5 text-[10px] text-sf-text-muted">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {importState.phase === 'error' && (
            <div className="mt-5 rounded-lg border border-sf-error/30 bg-sf-error/10 p-2.5 text-[11px] text-sf-error">
              {importState.error}
            </div>
          )}

          {alreadyImported ? (
            <>
              <button
                type="button"
                disabled
                className="mt-5 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg bg-emerald-400/10 px-4 py-3 text-sm font-semibold text-emerald-300"
              >
                <CheckCircle2 className="h-4 w-4" />
                Imported
              </button>
              {importIncomplete ? (
                <div className="mt-1.5 rounded-lg border border-yellow-400/25 bg-yellow-400/10 p-2.5 text-center text-[10px] text-yellow-200">
                  Imported, but some of its custom nodes aren't installed yet. Open it under the{' '}
                  {template.openSource ? 'Local' : 'Cloud'} tab, run Set up, restart ComfyUI, then
                  come back here and Re-import to finish.
                </div>
              ) : (
                <div className="mt-1.5 text-center text-[10px] text-sf-text-muted">
                  This template now appears under the {template.openSource ? 'Local' : 'Cloud'} tab.
                  Use its Set up button there to install what it needs.
                </div>
              )}
              <button
                type="button"
                onClick={() => { void handleImport() }}
                disabled={!isConnected}
                className={`mt-2 flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors ${
                  isConnected
                    ? 'border-sf-dark-500 text-sf-text-secondary hover:border-sf-dark-400 hover:text-sf-text-primary'
                    : 'cursor-not-allowed border-sf-dark-700 text-sf-text-muted'
                }`}
              >
                <RefreshCw className="h-4 w-4" />
                Re-import latest version
              </button>
              {!isConnected && (
                <div className="mt-1.5 text-center text-[10px] text-sf-text-muted">
                  Start ComfyUI to re-import — conversion runs through your local install.
                </div>
              )}
            </>
          ) : importing ? (
            <>
              <button
                type="button"
                disabled
                className="mt-5 flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-lg bg-sf-dark-700 px-4 py-3 text-sm font-semibold text-sf-text-muted"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                {importState.message || 'Importing...'}
              </button>
              <div className="mt-1.5 text-center text-[10px] text-sf-text-muted">
                The template loads through your ComfyUI to convert it for Velorn.
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => { void handleImport() }}
                disabled={!isConnected}
                className={`mt-5 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
                  isConnected
                    ? 'bg-sf-accent text-white hover:bg-sf-accent-hover'
                    : 'cursor-not-allowed bg-sf-dark-700 text-sf-text-muted'
                }`}
              >
                <Download className="h-4 w-4" />
                {importState.phase === 'error' ? 'Retry import' : 'Import template'}
              </button>
              <div className="mt-1.5 text-center text-[10px] text-sf-text-muted">
                {isConnected
                  ? 'Converts through your ComfyUI install and registers it in Generate.'
                  : 'Start ComfyUI to import — conversion runs through your local install.'}
              </div>
            </>
          )}

          <button
            type="button"
            onClick={() => { void handleOpenInComfy() }}
            disabled={!isConnected || openComfyState.busy}
            className={`mt-2 flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors ${
              isConnected && !openComfyState.busy
                ? 'border-sf-dark-500 text-sf-text-secondary hover:border-sf-dark-400 hover:text-sf-text-primary'
                : 'cursor-not-allowed border-sf-dark-700 text-sf-text-muted'
            }`}
          >
            {openComfyState.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LayoutGrid className="h-4 w-4" />}
            Open in ComfyUI
          </button>
          {(openComfyState.message || openComfyState.error) && (
            <div className={`mt-1.5 text-center text-[10px] ${openComfyState.error ? 'text-sf-error' : 'text-sf-text-muted'}`}>
              {openComfyState.error || openComfyState.message}
            </div>
          )}

          <a
            href={template.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-sf-dark-500 px-4 py-2.5 text-sm font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-400 hover:text-sf-text-primary"
          >
            <ExternalLink className="h-4 w-4" />
            View on GitHub
          </a>
        </div>
      </div>
    </div>
  )
}
