import { Play } from 'lucide-react'

export default function WorkflowCard({ workflow, selected = false, onSelect, showRouteBadge = true }) {
  if (!workflow) return null

  const coverIsVideo = /\.(mp4|webm|mov)(\?|#|$)/i.test(String(workflow.cover || ''))
  const coverPosition = workflow.coverPosition || 'center'
  const routeClass = workflow.route === 'cloud'
    ? 'bg-fuchsia-400/15 text-fuchsia-200 border-fuchsia-300/25'
    : workflow.route === 'custom'
      ? 'bg-amber-400/15 text-amber-200 border-amber-300/25'
      : 'bg-emerald-400/15 text-emerald-200 border-emerald-300/25'
  const routeLabel = workflow.route === 'cloud' ? 'Cloud' : workflow.route === 'custom' ? 'Custom' : 'Local'

  return (
    <button
      type="button"
      onClick={() => onSelect?.(workflow)}
      className={`group overflow-hidden rounded-xl border bg-sf-dark-900 text-left transition-all hover:-translate-y-0.5 hover:border-sf-dark-400 hover:shadow-lg hover:shadow-black/20 ${
        selected ? 'border-sf-accent ring-1 ring-sf-accent/70' : 'border-sf-dark-700'
      }`}
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-sf-dark-800">
        {workflow.cover && coverIsVideo ? (
          <video
            src={workflow.cover}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            style={{ objectPosition: coverPosition }}
            autoPlay
            muted
            loop
            playsInline
          />
        ) : workflow.cover ? (
          <img
            src={workflow.cover}
            alt=""
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            style={{ objectPosition: coverPosition }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-sf-text-muted">
            No cover
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/65" />
        {showRouteBadge && (
          <span className={`absolute left-2 top-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${routeClass}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${workflow.route === 'cloud' ? 'bg-fuchsia-300' : workflow.route === 'custom' ? 'bg-amber-300' : 'bg-emerald-300'}`} />
            {routeLabel}
          </span>
        )}
        <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white backdrop-blur">
          {workflow.badge || workflow.provider}
        </span>
        {!workflow.runnable && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-yellow-400/15 px-2 py-0.5 text-[10px] font-semibold text-yellow-200">
            <Play className="h-2.5 w-2.5" />
            Preview
          </span>
        )}
      </div>
      <div className="space-y-1 px-3 py-2.5">
        <div className="line-clamp-2 text-[13px] font-semibold leading-snug text-sf-text-primary">
          {workflow.title}
        </div>
        <div className="truncate text-[11px] text-sf-text-secondary">{workflow.subtitle}</div>
        <div className="line-clamp-2 text-[11px] leading-relaxed text-sf-text-muted">{workflow.description}</div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="rounded border border-sf-dark-600 bg-sf-dark-800 px-1.5 py-0.5 text-[10px] text-sf-text-secondary">
            {workflow.provider}
          </span>
          <span className="truncate text-[10px] text-sf-text-muted">{workflow.runtimeLabel}</span>
        </div>
      </div>
    </button>
  )
}
