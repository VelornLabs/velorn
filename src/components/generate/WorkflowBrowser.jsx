import { useEffect, useMemo, useState } from 'react'
import { ImagePlus, LayoutGrid, Loader2, Pencil, RefreshCw, Search, Tag, Trash2 } from 'lucide-react'
import {
  GENERATE_WORKFLOW_CATEGORY_LABELS,
  GENERATE_WORKFLOW_FILTERS,
  GENERATE_WORKFLOW_ROUTES,
} from '../../config/generateWorkflowCatalog'
import { useComfyTemplateCatalog } from '../../hooks/useComfyTemplateCatalog'
import { useCustomWorkflowLibrary } from '../../hooks/useCustomWorkflowLibrary'
import {
  deleteCustomLibraryWorkflow,
  openCustomLibraryWorkflow,
  renameCustomLibraryWorkflow,
  setCustomLibraryWorkflowCategory,
  setCustomLibraryWorkflowThumbnail,
} from '../../services/customWorkflowLibrary'
import WorkflowCard from './WorkflowCard'
import TemplateCard from './TemplateCard'

// Browser tabs are a presentation layer over manifest routes: "featured"
// shows the curated local+cloud manifests (Create mode and the Set up flow
// key off those data-level routes, so the data keeps local/cloud).
const BROWSER_TABS = ['featured', 'custom', 'templates']
const ROUTE_LABELS = {
  featured: 'Featured',
  custom: 'My Workflows',
  templates: 'Templates',
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

function matchesTemplate(template, query, filterId, sourceId) {
  if (filterId !== 'all' && template.categoryId !== filterId) return false
  if (sourceId === 'local' && !template.openSource) return false
  if (sourceId === 'cloud' && template.openSource) return false
  if (!query) return true

  const haystack = [
    template.title,
    template.description,
    template.name,
    ...(template.tags || []),
    ...(template.models || []),
  ].join(' ').toLowerCase()

  return haystack.includes(query)
}

const TEMPLATE_SOURCE_OPTIONS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'local', label: 'Local' },
  { id: 'cloud', label: 'Cloud' },
])

const TEMPLATE_SORT_OPTIONS = Object.freeze([
  { id: 'popular', label: 'Most used' },
  { id: 'newest', label: 'Newest' },
])

const TEMPLATE_COLLAPSE_LIMIT = 10

function compareTemplates(a, b, sortId) {
  if (sortId === 'newest') {
    // Dates are ISO strings, so plain string compare orders correctly.
    const byDate = String(b.date || '').localeCompare(String(a.date || ''))
    if (byDate !== 0) return byDate
  }
  return (b.usage || 0) - (a.usage || 0)
}

function formatFetchedAt(timestamp) {
  const numeric = Number(timestamp)
  if (!Number.isFinite(numeric) || numeric <= 0) return ''
  try {
    return new Date(numeric).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return ''
  }
}

export default function WorkflowBrowser({
  workflows = [],
  selectedWorkflowId = '',
  route = 'featured',
  variant = 'default',
  onRouteChange,
  onSelectWorkflow,
  onSelectTemplate,
  selectedTemplateName = '',
}) {
  const [query, setQuery] = useState('')
  const [filterId, setFilterId] = useState('all')
  const [templateSort, setTemplateSort] = useState('popular')
  const [templateSource, setTemplateSource] = useState('all')
  const [expandedTemplateCategories, setExpandedTemplateCategories] = useState(() => new Set())
  const isCreateLauncher = variant === 'create-launcher'
  const isTemplatesRoute = !isCreateLauncher && route === GENERATE_WORKFLOW_ROUTES.templates
  const isCustomRoute = !isCreateLauncher && route === GENERATE_WORKFLOW_ROUTES.custom
  const isFeaturedRoute = !isCreateLauncher && route === 'featured'
  const [featuredSource, setFeaturedSource] = useState('all')
  const templateCatalog = useComfyTemplateCatalog(isTemplatesRoute)
  const customLibrary = useCustomWorkflowLibrary(isCustomRoute)
  const [openingLibraryId, setOpeningLibraryId] = useState(null)
  const [libraryHint, setLibraryHint] = useState({ message: '', error: '' })

  const handleOpenLibraryWorkflow = async (workflow) => {
    if (openingLibraryId) return
    setOpeningLibraryId(workflow.id)
    setLibraryHint({ message: '', error: '' })
    const result = await openCustomLibraryWorkflow(workflow.id)
    setOpeningLibraryId(null)
    setLibraryHint(result.success
      ? { message: `Opened "${workflow.title}" in the ComfyUI tab.`, error: '' }
      : { message: '', error: result.error })
  }

  const handleDeleteLibraryWorkflow = async (event, workflow) => {
    event.stopPropagation()
    if (!window.confirm(`Remove "${workflow.title}" from your library?`)) return
    await deleteCustomLibraryWorkflow(workflow.id)
  }

  const [renamingLibraryId, setRenamingLibraryId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const startRenameLibraryWorkflow = (event, workflow) => {
    event.stopPropagation()
    setRenamingLibraryId(workflow.id)
    setRenameValue(workflow.title)
  }
  const confirmRenameLibraryWorkflow = async () => {
    if (!renamingLibraryId) return
    setRenamingLibraryId(null)
    const result = await renameCustomLibraryWorkflow(renamingLibraryId, renameValue)
    if (!result.success) setLibraryHint({ message: '', error: result.error })
  }

  const [categorizingLibraryId, setCategorizingLibraryId] = useState(null)
  const [categoryValue, setCategoryValue] = useState('')
  const libraryCategories = useMemo(() => (
    Array.from(new Set(customLibrary.workflows.map((workflow) => workflow.category).filter(Boolean))).sort()
  ), [customLibrary.workflows])
  const startCategorizeLibraryWorkflow = (event, workflow) => {
    event.stopPropagation()
    setCategorizingLibraryId(workflow.id)
    setCategoryValue(workflow.category || '')
  }
  const confirmCategorizeLibraryWorkflow = async () => {
    if (!categorizingLibraryId) return
    const id = categorizingLibraryId
    setCategorizingLibraryId(null)
    const result = await setCustomLibraryWorkflowCategory(id, categoryValue)
    if (!result.success) setLibraryHint({ message: '', error: result.error })
  }

  const handlePickLibraryThumbnail = async (event, workflow) => {
    event.stopPropagation()
    const api = window.electronAPI
    if (!api?.selectFile || !api?.readFileAsBuffer) return
    const picked = await api.selectFile({
      title: 'Choose a thumbnail image',
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    })
    if (!picked) return
    try {
      const read = await api.readFileAsBuffer(picked)
      if (!read?.success || !read.data) throw new Error(read?.error || 'Could not read the image.')
      const bitmap = await createImageBitmap(new Blob([read.data]))
      // Downscale so the data URL stays small enough to live in the entry JSON.
      const scale = Math.min(1, 512 / bitmap.width)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const result = await setCustomLibraryWorkflowThumbnail(workflow.id, canvas.toDataURL('image/jpeg', 0.82))
      if (!result.success) setLibraryHint({ message: '', error: result.error })
    } catch (error) {
      setLibraryHint({ message: '', error: error instanceof Error ? error.message : 'Could not set the thumbnail.' })
    }
  }

  const routeFilters = useMemo(() => {
    if (isTemplatesRoute) {
      return [
        { id: 'all', label: 'All' },
        ...templateCatalog.categories.map((category) => ({ id: category.id, label: category.label })),
      ]
    }
    // Custom route: chips are the user's own library categories.
    return route === GENERATE_WORKFLOW_ROUTES.custom
      ? [
        { id: 'all', label: 'All' },
        ...libraryCategories.map((category) => ({ id: `cat:${category}`, label: category })),
      ]
      : GENERATE_WORKFLOW_FILTERS
  }, [isTemplatesRoute, route, templateCatalog.categories, libraryCategories])

  useEffect(() => {
    if (routeFilters.some((filter) => filter.id === filterId)) return
    setFilterId('all')
  }, [filterId, routeFilters])

  const normalizedQuery = isCreateLauncher ? '' : query.trim().toLowerCase()
  const activeFilterId = isCreateLauncher || !routeFilters.some((filter) => filter.id === filterId)
    ? 'all'
    : filterId

  const filteredWorkflows = useMemo(() => (
    isTemplatesRoute
      ? []
      : workflows.filter((workflow) => (
        (!isFeaturedRoute || featuredSource === 'all' || workflow.route === featuredSource)
        && matchesWorkflow(workflow, normalizedQuery, activeFilterId)
      ))
  ), [activeFilterId, isTemplatesRoute, isFeaturedRoute, featuredSource, normalizedQuery, workflows])

  const groupedWorkflows = useMemo(() => {
    const groups = new Map()
    filteredWorkflows.forEach((workflow) => {
      const key = workflow.category || 'utility'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(workflow)
    })
    return Array.from(groups.entries())
  }, [filteredWorkflows])

  const filteredTemplates = useMemo(() => (
    isTemplatesRoute
      ? templateCatalog.templates.filter((template) => (
        matchesTemplate(template, normalizedQuery, activeFilterId, templateSource)
      ))
      : []
  ), [activeFilterId, isTemplatesRoute, normalizedQuery, templateCatalog.templates, templateSource])

  const groupedTemplates = useMemo(() => {
    const groups = new Map()
    filteredTemplates.forEach((template) => {
      if (!groups.has(template.categoryLabel)) groups.set(template.categoryLabel, [])
      groups.get(template.categoryLabel).push(template)
    })
    for (const items of groups.values()) {
      items.sort((a, b) => compareTemplates(a, b, templateSort))
    }
    return Array.from(groups.entries())
  }, [filteredTemplates, templateSort])

  const toggleTemplateCategoryExpanded = (categoryLabel) => {
    setExpandedTemplateCategories((prev) => {
      const next = new Set(prev)
      if (next.has(categoryLabel)) next.delete(categoryLabel)
      else next.add(categoryLabel)
      return next
    })
  }

  const templatesLoading = isTemplatesRoute
    && (templateCatalog.status === 'loading' || templateCatalog.status === 'idle')
  const fetchedAtLabel = formatFetchedAt(templateCatalog.fetchedAt)

  return (
    <div className="rounded-2xl border border-sf-dark-700 bg-sf-dark-900/80 p-3 shadow-lg shadow-black/10">
      {!isCreateLauncher && (
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-1 rounded-lg border border-sf-dark-700 bg-sf-dark-800 p-1">
            {BROWSER_TABS.map((routeId) => (
              <button
                key={routeId}
                type="button"
                onClick={() => onRouteChange?.(routeId)}
                className={`rounded-md px-3.5 py-2 text-sm font-semibold transition-colors ${
                  route === routeId
                    ? 'bg-sf-accent text-white'
                    : 'text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary'
                }`}
              >
                {ROUTE_LABELS[routeId] || routeId}
              </button>
            ))}
          </div>
          <div className="relative min-w-0 flex-1 md:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sf-text-muted" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={isTemplatesRoute
                ? 'Search ComfyUI templates, models, tags...'
                : 'Search workflows, providers, tags...'}
              className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-800 py-2 pl-9 pr-3 text-xs text-sf-text-primary outline-none transition-colors placeholder:text-sf-text-muted focus:border-sf-accent"
            />
          </div>
        </div>
      )}

      {!isCreateLauncher && (routeFilters.length > 1 || isFeaturedRoute) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {routeFilters.length > 1 && routeFilters.map((filter) => (
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
          {isFeaturedRoute && (
            <div className="ml-auto flex items-center gap-1 rounded-lg border border-sf-dark-700 bg-sf-dark-800 p-0.5">
              {TEMPLATE_SOURCE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFeaturedSource(option.id)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    featuredSource === option.id
                      ? 'bg-sf-dark-600 text-sf-text-primary'
                      : 'text-sf-text-muted hover:text-sf-text-primary'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isTemplatesRoute && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-sf-dark-700 bg-sf-dark-800 p-0.5">
            {TEMPLATE_SOURCE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setTemplateSource(option.id)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  templateSource === option.id
                    ? 'bg-sf-dark-600 text-sf-text-primary'
                    : 'text-sf-text-muted hover:text-sf-text-primary'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-sf-dark-700 bg-sf-dark-800 p-0.5">
            {TEMPLATE_SORT_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setTemplateSort(option.id)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  templateSort === option.id
                    ? 'bg-sf-dark-600 text-sf-text-primary'
                    : 'text-sf-text-muted hover:text-sf-text-primary'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={`${isCreateLauncher ? 'mt-0' : 'mt-3'} flex items-center justify-between gap-2 text-[11px] text-sf-text-muted`}>
        <span>
          {isCreateLauncher
            ? 'Choose a creator workflow'
            : isTemplatesRoute
              ? (templatesLoading
                ? 'Loading the ComfyUI template catalog...'
                : `Showing ${filteredTemplates.length} of ${templateCatalog.templates.length} ComfyUI templates`)
              : isCustomRoute
              ? `Showing ${customLibrary.workflows.length} saved workflow${customLibrary.workflows.length === 1 ? '' : 's'}`
              : `Showing ${filteredWorkflows.length} ${(ROUTE_LABELS[route] || route).toLowerCase()} workflow${filteredWorkflows.length === 1 ? '' : 's'}`}
        </span>
        {isTemplatesRoute && !templatesLoading && (
          <span className="inline-flex shrink-0 items-center gap-2">
            {fetchedAtLabel && (
              <span>
                Updated {fetchedAtLabel}{templateCatalog.fromCache ? ' (cached)' : ''}
              </span>
            )}
            <button
              type="button"
              onClick={() => { void templateCatalog.refresh() }}
              className="inline-flex items-center gap-1 rounded border border-sf-dark-600 px-1.5 py-0.5 text-[10px] text-sf-text-secondary transition-colors hover:border-sf-dark-400 hover:text-sf-text-primary"
            >
              <RefreshCw className="h-2.5 w-2.5" />
              Refresh
            </button>
          </span>
        )}
        {!isCreateLauncher && !isTemplatesRoute && filterId !== 'all' && (
          <span>{GENERATE_WORKFLOW_CATEGORY_LABELS[filterId]}</span>
        )}
      </div>

      {isTemplatesRoute && templateCatalog.staleError && (
        <div className="mt-2 rounded-lg border border-yellow-400/25 bg-yellow-400/10 px-3 py-2 text-[11px] text-yellow-200">
          Couldn't reach GitHub for a fresh catalog ({templateCatalog.staleError}) — showing the last cached copy.
        </div>
      )}

      <div className="mt-3 space-y-5">
        {isCustomRoute && (
          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-sf-text-muted">
              My ComfyUI Workflows
              <span className="ml-1.5 normal-case tracking-normal text-sf-text-muted/70">({customLibrary.workflows.length})</span>
            </h3>
            <datalist id="velorn-library-categories">
              {libraryCategories.map((category) => (
                <option key={category} value={category} />
              ))}
            </datalist>
            {(libraryHint.message || libraryHint.error) && (
              <div className={`text-[11px] ${libraryHint.error ? 'text-sf-error' : 'text-emerald-300/90'}`}>
                {libraryHint.error || libraryHint.message}
              </div>
            )}
            {customLibrary.workflows.length === 0 ? (
              <div className="rounded-xl border border-dashed border-sf-dark-600 bg-sf-dark-800/60 px-4 py-6 text-center text-xs text-sf-text-muted">
                Open any workflow in the ComfyUI tab and hit "Save to Velorn" — it will show up here
                as a one-click launcher.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {customLibrary.workflows
                  .filter((workflow) => (
                    (!activeFilterId.startsWith('cat:') || workflow.category === activeFilterId.slice(4))
                    && (!normalizedQuery
                      || workflow.title.toLowerCase().includes(normalizedQuery)
                      || workflow.category.toLowerCase().includes(normalizedQuery))
                  ))
                  .map((workflow) => (
                    <div
                      key={workflow.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => { void handleOpenLibraryWorkflow(workflow) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          void handleOpenLibraryWorkflow(workflow)
                        }
                      }}
                      className="group cursor-pointer overflow-hidden rounded-xl border border-sf-dark-700 bg-sf-dark-900 transition-all hover:-translate-y-0.5 hover:border-sf-dark-400 hover:shadow-lg hover:shadow-black/20"
                    >
                      {workflow.thumbnail && (
                        <div className="aspect-video overflow-hidden bg-sf-dark-800">
                          <img
                            src={workflow.thumbnail}
                            alt=""
                            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                          />
                        </div>
                      )}
                      <div className="flex items-start gap-2.5 p-3">
                        {!workflow.thumbnail && (
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-400/10 text-sky-300">
                            {openingLibraryId === workflow.id
                              ? <Loader2 className="h-4 w-4 animate-spin" />
                              : <LayoutGrid className="h-4 w-4" />}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          {renamingLibraryId === workflow.id ? (
                            <input
                              type="text"
                              value={renameValue}
                              autoFocus
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => setRenameValue(event.target.value)}
                              onKeyDown={(event) => {
                                event.stopPropagation()
                                if (event.key === 'Enter') void confirmRenameLibraryWorkflow()
                                if (event.key === 'Escape') setRenamingLibraryId(null)
                              }}
                              onBlur={() => { void confirmRenameLibraryWorkflow() }}
                              className="w-full rounded border border-sf-accent/60 bg-sf-dark-800 px-1.5 py-0.5 text-[13px] font-semibold text-sf-text-primary outline-none"
                            />
                          ) : (
                            <div className="line-clamp-2 text-[13px] font-semibold leading-snug text-sf-text-primary">
                              {workflow.thumbnail && openingLibraryId === workflow.id && (
                                <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin text-sky-300" />
                              )}
                              {workflow.title}
                            </div>
                          )}
                          <div className="mt-0.5 text-[10px] text-sf-text-muted">
                            Saved {workflow.updatedAt ? new Date(workflow.updatedAt).toLocaleDateString() : ''}
                            {workflow.nodeCount > 0 ? ` · ${workflow.nodeCount} nodes` : ''}
                            {workflow.category ? (
                              <span className="ml-1.5 rounded-full border border-sf-dark-600 bg-sf-dark-800 px-1.5 py-0.5 text-[9px] text-sf-text-secondary">
                                {workflow.category}
                              </span>
                            ) : null}
                          </div>
                          {categorizingLibraryId === workflow.id ? (
                            <input
                              type="text"
                              value={categoryValue}
                              autoFocus
                              list="velorn-library-categories"
                              placeholder="Category (e.g. text-to-video)"
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => setCategoryValue(event.target.value)}
                              onKeyDown={(event) => {
                                event.stopPropagation()
                                if (event.key === 'Enter') void confirmCategorizeLibraryWorkflow()
                                if (event.key === 'Escape') setCategorizingLibraryId(null)
                              }}
                              onBlur={() => { void confirmCategorizeLibraryWorkflow() }}
                              className="mt-1.5 w-full rounded border border-sf-accent/60 bg-sf-dark-800 px-1.5 py-0.5 text-[10px] text-sf-text-primary outline-none placeholder:text-sf-text-muted"
                            />
                          ) : (
                            <div className="mt-1.5 text-[10px] text-sf-text-muted/80">
                              Click to open in the ComfyUI tab
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={(event) => startRenameLibraryWorkflow(event, workflow)}
                            className="rounded p-1 text-sf-text-muted transition-colors hover:bg-sf-dark-700 hover:text-sf-text-primary"
                            title="Rename"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(event) => startCategorizeLibraryWorkflow(event, workflow)}
                            className="rounded p-1 text-sf-text-muted transition-colors hover:bg-sf-dark-700 hover:text-sf-text-primary"
                            title="Set category"
                          >
                            <Tag className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(event) => { void handlePickLibraryThumbnail(event, workflow) }}
                            className="rounded p-1 text-sf-text-muted transition-colors hover:bg-sf-dark-700 hover:text-sf-text-primary"
                            title="Set thumbnail image"
                          >
                            <ImagePlus className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(event) => { void handleDeleteLibraryWorkflow(event, workflow) }}
                            className="rounded p-1 text-sf-text-muted transition-colors hover:bg-sf-dark-700 hover:text-sf-error"
                            title="Remove from library"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </section>
        )}
        {isTemplatesRoute ? (
          templatesLoading ? (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-sf-dark-600 bg-sf-dark-800/60 px-4 py-10 text-xs text-sf-text-muted">
              <Loader2 className="h-4 w-4 animate-spin text-sf-accent" />
              Fetching the live template catalog from ComfyUI...
            </div>
          ) : templateCatalog.status === 'error' ? (
            <div className="rounded-xl border border-dashed border-sf-dark-600 bg-sf-dark-800/60 px-4 py-8 text-center text-xs text-sf-text-muted">
              <div>Could not load the ComfyUI template catalog.</div>
              <div className="mt-1 text-[11px] text-sf-error">{templateCatalog.error}</div>
              <button
                type="button"
                onClick={() => { void templateCatalog.refresh() }}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-sf-dark-500 px-3 py-1.5 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-400 hover:text-sf-text-primary"
              >
                <RefreshCw className="h-3 w-3" />
                Try again
              </button>
            </div>
          ) : groupedTemplates.length === 0 ? (
            <div className="rounded-xl border border-dashed border-sf-dark-600 bg-sf-dark-800/60 px-4 py-8 text-center text-xs text-sf-text-muted">
              No templates match that search yet.
            </div>
          ) : groupedTemplates.map(([categoryLabel, items]) => {
            // Searching means the user is hunting — show every match. Otherwise
            // keep each category to its head and expand on demand.
            const isExpanded = Boolean(normalizedQuery) || expandedTemplateCategories.has(categoryLabel)
            const visibleItems = isExpanded ? items : items.slice(0, TEMPLATE_COLLAPSE_LIMIT)
            const hiddenCount = items.length - visibleItems.length
            return (
              <section key={categoryLabel} className="space-y-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-sf-text-muted">
                  {categoryLabel}
                  <span className="ml-1.5 normal-case tracking-normal text-sf-text-muted/70">({items.length})</span>
                </h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {visibleItems.map((template) => (
                    <TemplateCard
                      key={template.name}
                      template={template}
                      selected={selectedTemplateName === template.name}
                      onSelect={onSelectTemplate}
                    />
                  ))}
                </div>
                {(hiddenCount > 0 || (isExpanded && !normalizedQuery && items.length > TEMPLATE_COLLAPSE_LIMIT)) && (
                  <button
                    type="button"
                    onClick={() => toggleTemplateCategoryExpanded(categoryLabel)}
                    className="w-full rounded-lg border border-dashed border-sf-dark-600 bg-sf-dark-800/40 px-3 py-2 text-[11px] text-sf-text-secondary transition-colors hover:border-sf-dark-400 hover:text-sf-text-primary"
                  >
                    {hiddenCount > 0
                      ? `Show all ${items.length} ${categoryLabel.toLowerCase()} templates`
                      : 'Show fewer'}
                  </button>
                )}
              </section>
            )
          })
        ) : groupedWorkflows.length === 0 ? (
          // The custom route's content is the library section above — no
          // curated manifests there is the normal state, not a failed search.
          isCustomRoute ? null : (
            <div className="rounded-xl border border-dashed border-sf-dark-600 bg-sf-dark-800/60 px-4 py-8 text-center text-xs text-sf-text-muted">
              No workflows match that search yet.
            </div>
          )
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
