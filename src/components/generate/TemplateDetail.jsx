import { useEffect, useState } from 'react'
import { ArrowLeft, Download, ExternalLink, KeyRound, LayoutGrid, Loader2, Puzzle } from 'lucide-react'
import { formatBytes } from '../../hooks/useWorkflowSetupFlow'
import { formatUsageCount } from './TemplateCard'
import { collectUiNodeTypes } from '../../services/templateImporter'
import { openUiWorkflowInComfyUi } from '../../services/workflowSetupManager'
import { comfyui } from '../../services/comfyui'

function MetaTile({ label, value }) {
  if (!value) return null
  return (
    <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.14em] text-sf-text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-sf-text-primary">{value}</div>
    </div>
  )
}

export default function TemplateDetail({
  template,
  onBack = null,
  isConnected = false,
  importState = null,
  onImportToGenerate = null,
}) {
  const [openComfyState, setOpenComfyState] = useState({ busy: false, message: '', error: '' })
  const [nodeCheck, setNodeCheck] = useState({ status: 'idle', missing: [] })

  // Courtesy pre-check: diff the template's node types against the live
  // ComfyUI so the user knows whether Manager will have work to do when the
  // template opens. Informational only — the tab flow handles the rest.
  useEffect(() => {
    let cancelled = false
    setNodeCheck({ status: 'idle', missing: [] })
    if (!template?.workflowUrl || !isConnected) return undefined
    ;(async () => {
      setNodeCheck({ status: 'checking', missing: [] })
      try {
        const [response, objectInfo] = await Promise.all([
          fetch(template.workflowUrl, { cache: 'no-store' }),
          comfyui.getObjectInfo(),
        ])
        if (!response.ok) throw new Error(`(${response.status})`)
        const uiWorkflow = await response.json()
        const missing = collectUiNodeTypes(uiWorkflow).filter((type) => !objectInfo?.[type])
        if (!cancelled) setNodeCheck({ status: 'ready', missing })
      } catch {
        if (!cancelled) setNodeCheck({ status: 'unknown', missing: [] })
      }
    })()
    return () => { cancelled = true }
  }, [template?.workflowUrl, isConnected])

  if (!template) return null

  const coverIsVideo = /\.(mp4|webm|mov)(\?|#|$)/i.test(String(template.thumbnailUrl || ''))
  const operational = template.operational || null
  const portfolioRole = String(operational?.portfolioRole || '')
  const portfolioRoleLabel = portfolioRole && portfolioRole !== 'UNASSESSED'
    ? portfolioRole.replaceAll('_', ' ')
    : ''
  const calibrationProfiles = Array.isArray(template.calibrationProfiles)
    ? template.calibrationProfiles
    : []
  const routeRecommendation = template.routeRecommendation || null

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
        message: result.success
          ? 'Opened in the ComfyUI tab — generate there and your outputs land in the Assets panel.'
          : '',
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

          {operational && portfolioRoleLabel && (
            <div className="mt-4 rounded-xl border border-emerald-300/20 bg-emerald-400/5 p-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <MetaTile label="Portfolio" value={portfolioRoleLabel} />
                <MetaTile label="Lane" value={operational.capabilityLane} />
                <MetaTile label="Model evidence" value={operational.modelEvidenceLevel || operational.evidenceLevel} />
                <MetaTile label="Exact route" value={operational.routeEvidenceLevel || operational.evidenceLevel} />
              </div>
              <div className="mt-3 text-[11px] leading-relaxed text-sf-text-secondary">
                <div><span className="font-semibold text-sf-text-primary">Evidence:</span> {operational.evidenceLabel}</div>
                {operational.qualityObservation && (
                  <div className="mt-1"><span className="font-semibold text-sf-text-primary">Observed quality:</span> {operational.qualityObservation}</div>
                )}
                {operational.limitation && (
                  <div className="mt-1 text-amber-200/90"><span className="font-semibold">Limitation:</span> {operational.limitation}</div>
                )}
              </div>
            </div>
          )}

          {routeRecommendation && (
            <div className={`mt-4 rounded-xl border p-3 ${
              routeRecommendation.eligible
                ? 'border-sf-accent/30 bg-sf-accent/5'
                : 'border-red-400/25 bg-red-400/10'
            }`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sf-accent">Explainable route</div>
                  <div className="mt-1 text-sm font-semibold text-sf-text-primary">
                    {routeRecommendation.selected ? 'Recommended route' : `Route rank #${routeRecommendation.rank}`}
                  </div>
                </div>
                <span className="rounded-full border border-sf-dark-600 px-2 py-0.5 font-mono text-xs text-sf-text-primary">
                  {routeRecommendation.score.toFixed(2)}
                </span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                {Object.entries(routeRecommendation.components || {}).map(([key, value]) => (
                  <MetaTile key={key} label={key} value={`${Math.round(Number(value) * 100)}%`} />
                ))}
              </div>
              <div className="mt-3 space-y-1 text-[11px] leading-relaxed text-sf-text-secondary">
                {(routeRecommendation.explanation || []).map((line) => <div key={line}>• {line}</div>)}
              </div>
              <div className="mt-2 border-t border-sf-dark-700 pt-2 text-[10px] text-sf-text-muted">
                Advisory only · Kernel authorizes spend/policy · execution receipt required · media bytes do not transit Kernel.
              </div>
            </div>
          )}

          {calibrationProfiles.length > 0 && (
            <div className="mt-4 rounded-xl border border-sf-accent/30 bg-sf-accent/5 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sf-accent">Workflow Equalizer available</div>
              <div className="mt-2 space-y-2">
                {calibrationProfiles.map((profile) => (
                  <div key={profile.id} className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-sf-text-primary">{profile.title}</span>
                      <span className="rounded-full border border-emerald-400/30 px-2 py-0.5 text-[10px] text-emerald-300">
                        {String(profile.routeEvidenceLevel || profile.evidenceLevel).replaceAll('_', ' ')}
                      </span>
                    </div>
                    <div className="mt-1 text-[10px] text-sf-text-muted">
                      v{profile.version} · {profile.controlIds.join(' · ')}
                    </div>
                    <div className="mt-1 text-[10px] text-sf-text-secondary">
                      Import the workflow to calibrate these controls in Generate; no duplicate graph is created.
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

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

          {isConnected && nodeCheck.status === 'ready' && nodeCheck.missing.length > 0 && (
            <div className="mt-5 rounded-lg border border-yellow-400/25 bg-yellow-400/10 p-2.5 text-[11px] text-yellow-200">
              Heads up — your ComfyUI is missing {nodeCheck.missing.length} node type{nodeCheck.missing.length === 1 ? '' : 's'} this
              template uses: <span className="font-semibold">{nodeCheck.missing.join(', ')}</span>.
              ComfyUI Manager will offer to install them when the template opens.
            </div>
          )}
          {isConnected && nodeCheck.status === 'ready' && nodeCheck.missing.length === 0 && (
            <div className="mt-5 text-center text-[10px] text-emerald-300/90">
              Your ComfyUI has everything this template needs.
            </div>
          )}

          <button
            type="button"
            onClick={() => { void onImportToGenerate?.(template) }}
            disabled={!isConnected || importState?.busy || typeof onImportToGenerate !== 'function'}
            className={`mt-5 flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold transition-colors ${
              isConnected && !importState?.busy && typeof onImportToGenerate === 'function'
                ? 'bg-sf-accent text-white hover:bg-sf-accent-hover'
                : 'cursor-not-allowed bg-sf-dark-700 text-sf-text-muted'
            }`}
          >
            {importState?.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {importState?.busy ? (importState.message || 'Importing workflow…') : 'Import to Generate'}
          </button>
          <div className="mt-1.5 text-center text-[10px] text-sf-text-muted">
            Uses Velorn’s native importer and dependency setup; the official graph remains editable and is not copied into a parallel workflow.
          </div>
          {importState?.error && (
            <div className="mt-1.5 text-center text-[10px] text-sf-error">{importState.error}</div>
          )}

          <button
            type="button"
            onClick={() => { void handleOpenInComfy() }}
            disabled={!isConnected || openComfyState.busy}
            className={`mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-sf-dark-500 px-4 py-3 text-sm font-semibold transition-colors ${
              isConnected && !openComfyState.busy
                ? 'bg-sf-accent text-white hover:bg-sf-accent-hover'
                : 'cursor-not-allowed bg-sf-dark-700 text-sf-text-muted'
            }`}
          >
            {openComfyState.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LayoutGrid className="h-4 w-4" />}
            Open in ComfyUI
          </button>
          <div className="mt-1.5 text-center text-[10px] text-sf-text-muted">
            {isConnected
              ? 'Opens live in the ComfyUI tab — generate there and outputs land in your Assets panel.'
              : 'Start ComfyUI to open this template.'}
          </div>
          {(openComfyState.message || openComfyState.error) && (
            <div className={`mt-1.5 text-center text-[10px] ${openComfyState.error ? 'text-sf-error' : 'text-emerald-300/90'}`}>
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
