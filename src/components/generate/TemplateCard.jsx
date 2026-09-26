import { useRef } from 'react'
import { KeyRound, Puzzle } from 'lucide-react'
import { formatBytes } from '../../hooks/useWorkflowSetupFlow'

export function formatUsageCount(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return ''
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M runs`
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(1)}k runs`
  return `${Math.round(numeric)} runs`
}

export default function TemplateCard({ template, selected = false, onSelect }) {
  const videoRef = useRef(null)
  if (!template) return null

  const coverIsVideo = /\.(mp4|webm|mov)(\?|#|$)/i.test(String(template.thumbnailUrl || ''))
  const sizeLabel = template.sizeBytes > 0 ? formatBytes(template.sizeBytes) : ''
  const usageLabel = formatUsageCount(template.usage)
  const portfolioRole = String(template.operational?.portfolioRole || '')
  const portfolioRoleLabel = portfolioRole && portfolioRole !== 'UNASSESSED'
    ? portfolioRole.replaceAll('_', ' ')
    : ''
  const evidenceLevel = String(template.operational?.evidenceLevel || '')
  const recommendation = template.routeRecommendation || null

  return (
    <button
      type="button"
      onClick={() => onSelect?.(template)}
      className={`group overflow-hidden rounded-xl border bg-sf-dark-900 text-left transition-all hover:-translate-y-0.5 hover:border-sf-dark-400 hover:shadow-lg hover:shadow-black/20 ${
        selected ? 'border-sf-accent ring-1 ring-sf-accent/70' : 'border-sf-dark-700'
      }`}
    >
      <div
        className="relative aspect-[4/3] overflow-hidden bg-sf-dark-800"
        onMouseEnter={() => { void videoRef.current?.play?.()?.catch?.(() => {}) }}
        onMouseLeave={() => videoRef.current?.pause?.()}
      >
        {template.thumbnailUrl && coverIsVideo ? (
          <video
            ref={videoRef}
            src={template.thumbnailUrl}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            preload="none"
            muted
            loop
            playsInline
          />
        ) : template.thumbnailUrl ? (
          <img
            src={template.thumbnailUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-sf-text-muted">
            {template.mediaSubtype === 'mp3' ? 'Audio template' : 'No preview'}
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/65" />
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full border border-sky-300/25 bg-sky-400/15 px-2 py-0.5 text-[10px] font-semibold text-sky-200">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-300" />
          ComfyUI
        </span>
        {portfolioRoleLabel && (
          <span className={`absolute right-2 top-2 rounded-full border px-2 py-0.5 text-[9px] font-bold tracking-wide backdrop-blur ${
            portfolioRole === 'CHAMPION' || portfolioRole === 'SPECIALIST_CHAMPION'
              ? 'border-emerald-300/35 bg-emerald-400/20 text-emerald-100'
              : portfolioRole === 'FRONTIER_BLOCKED'
                ? 'border-red-300/30 bg-red-400/20 text-red-100'
                : 'border-violet-300/30 bg-violet-400/20 text-violet-100'
          }`}
          >
            {portfolioRoleLabel}
          </span>
        )}
        <span className={`absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold backdrop-blur ${
          template.openSource
            ? 'bg-black/55 text-white'
            : 'bg-amber-400/20 text-amber-200'
        }`}
        >
          {template.openSource ? 'Open source' : (
            <>
              <KeyRound className="h-2.5 w-2.5" />
              API key
            </>
          )}
        </span>
        {template.requiresCustomNodes.length > 0 && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
            <Puzzle className="h-2.5 w-2.5" />
            {template.requiresCustomNodes.length} node pack{template.requiresCustomNodes.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="space-y-1 px-3 py-2.5">
        <div className="line-clamp-2 text-[13px] font-semibold leading-snug text-sf-text-primary">
          {template.title}
        </div>
        {recommendation && (
          <div
            className={`rounded-lg border px-2 py-1.5 text-[10px] ${
              recommendation.eligible
                ? 'border-sf-accent/35 bg-sf-accent/10 text-sf-text-secondary'
                : 'border-red-400/25 bg-red-400/10 text-red-200/90'
            }`}
            title={(recommendation.explanation || []).join('\n')}
          >
            <div className="flex items-center justify-between gap-2 font-semibold">
              <span>{recommendation.selected ? 'Recommended' : `Route #${recommendation.rank}`}</span>
              <span className="font-mono">{recommendation.score.toFixed(2)}</span>
            </div>
            <div className="mt-0.5 truncate text-sf-text-muted">
              route {recommendation.routeEvidenceLevel} · model {recommendation.modelEvidenceLevel}
            </div>
          </div>
        )}
        {template.models.length > 0 && (
          <div className="truncate text-[11px] text-sf-text-secondary">{template.models.join(' · ')}</div>
        )}
        {portfolioRoleLabel && (
          <div className="truncate text-[10px] font-medium text-emerald-200/90">
            {template.operational?.capabilityLane} · {evidenceLevel}
          </div>
        )}
        <div className="line-clamp-2 text-[11px] leading-relaxed text-sf-text-muted">{template.description}</div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="rounded border border-sf-dark-600 bg-sf-dark-800 px-1.5 py-0.5 text-[10px] text-sf-text-secondary">
            {sizeLabel || 'Cloud'}
          </span>
          <span className="truncate text-[10px] text-sf-text-muted">{usageLabel}</span>
        </div>
      </div>
    </button>
  )
}
