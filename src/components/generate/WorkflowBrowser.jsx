import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import {
  GENERATE_WORKFLOW_CATEGORY_LABELS,
  GENERATE_WORKFLOW_FILTERS,
  GENERATE_WORKFLOW_ROUTES,
} from '../../config/generateWorkflowCatalog'
import WorkflowCard from './WorkflowCard'

const ROUTE_LABELS = {
  local: 'Local',
  cloud: 'Cloud',
  custom: 'Custom',
}

const CUSTOM_WORKFLOW_FILTERS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
])

function matchesWorkflow(workflow, query, filterId) {
  if (filterId !== 'all' && workflow.category !== filterId) return false
  if (!query) return true

  const haystack = [
    workflow.title,
    workflow.subtitle,
    workflow.description,
    workflow.provider,
    workflow.category,
    ...(workflow.tags || []),
  ].join(' ').toLowerCase()

  return haystack.includes(query)
}

export default function WorkflowBrowser({
  workflows = [],
  selectedWorkflowId = '',
  route = GENERATE_WORKFLOW_ROUTES.local,
  variant = 'default',
  onRouteChange,
  onSelectWorkflow,
}) {
  const [query, setQuery] = useState('')
  const [filterId, setFilterId] = useState('all')
  const isCreateLauncher = variant === 'create-launcher'
  const routeFilters = route === GENERATE_WORKFLOW_ROUTES.custom
    ? CUSTOM_WORKFLOW_FILTERS
    : GENERATE_WORKFLOW_FILTERS

  useEffect(() => {
    if (routeFilters.some((filter) => filter.id === filterId)) return
    setFilterId('all')
  }, [filterId, routeFilters])

  const normalizedQuery = isCreateLauncher ? '' : query.trim().toLowerCase()
  const activeFilterId = isCreateLauncher || !routeFilters.some((filter) => filter.id === filterId)
    ? 'all'
    : filterId

  const filteredWorkflows = useMemo(() => (
    workflows.filter((workflow) => matchesWorkflow(workflow, normalizedQuery, activeFilterId))
  ), [activeFilterId, normalizedQuery, workflows])

  const groupedWorkflows = useMemo(() => {
    const groups = new Map()
    filteredWorkflows.forEach((workflow) => {
      const key = workflow.category || 'utility'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(workflow)
    })
    return Array.from(groups.entries())
  }, [filteredWorkflows])

  return (
    <div className="rounded-2xl border border-sf-dark-700 bg-sf-dark-900/80 p-3 shadow-lg shadow-black/10">
      {!isCreateLauncher && (
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-1 rounded-lg border border-sf-dark-700 bg-sf-dark-800 p-1">
            {Object.values(GENERATE_WORKFLOW_ROUTES).map((routeId) => (
              <button
                key={routeId}
                type="button"
                onClick={() => onRouteChange?.(routeId)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  route === routeId
                    ? 'bg-sf-accent text-white'
                    : 'text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary'
                }`}
              >
                <span className="inline-flex items-center gap-1.5">
                  <span>{ROUTE_LABELS[routeId] || routeId}</span>
                  {routeId === GENERATE_WORKFLOW_ROUTES.custom && (
                    <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none ${
                      route === routeId
                        ? 'bg-white/20 text-white'
                        : 'bg-amber-500/15 text-amber-200'
                    }`}>
                      Beta
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
          <div className="relative min-w-0 flex-1 md:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sf-text-muted" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search workflows, providers, tags..."
              className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-800 py-2 pl-9 pr-3 text-xs text-sf-text-primary outline-none transition-colors placeholder:text-sf-text-muted focus:border-sf-accent"
            />
          </div>
        </div>
      )}

      {!isCreateLauncher && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {routeFilters.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => setFilterId(filter.id)}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                filterId === filter.id
                  ? 'border-sf-accent/60 bg-sf-accent/15 text-sf-accent'
                  : 'border-sf-dark-700 bg-sf-dark-800 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      )}

      <div className={`${isCreateLauncher ? 'mt-0' : 'mt-3'} flex items-center justify-between gap-2 text-[11px] text-sf-text-muted`}>
        <span>
          {isCreateLauncher
            ? 'Choose a creator workflow'
            : `Showing ${filteredWorkflows.length} ${(ROUTE_LABELS[route] || route).toLowerCase()} workflow${filteredWorkflows.length === 1 ? '' : 's'}`}
        </span>
        {!isCreateLauncher && filterId !== 'all' && <span>{GENERATE_WORKFLOW_CATEGORY_LABELS[filterId]}</span>}
      </div>

      <div className="mt-3 space-y-5">
        {groupedWorkflows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-sf-dark-600 bg-sf-dark-800/60 px-4 py-8 text-center text-xs text-sf-text-muted">
            No workflows match that search yet.
          </div>
        ) : groupedWorkflows.map(([categoryId, items]) => (
          <section key={categoryId} className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-sf-text-muted">
              {GENERATE_WORKFLOW_CATEGORY_LABELS[categoryId] || categoryId}
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {items.map((workflow) => (
                <WorkflowCard
                  key={workflow.id}
                  workflow={workflow}
                  selected={selectedWorkflowId === workflow.id || selectedWorkflowId === workflow.workflowId}
                  onSelect={onSelectWorkflow}
                  showRouteBadge={!isCreateLauncher}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
