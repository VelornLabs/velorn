const TEMPLATE_REPO = 'Comfy-Org/workflow_templates'
const TEMPLATE_INDEX_URL = `https://raw.githubusercontent.com/${TEMPLATE_REPO}/main/templates/index.json`
// jsDelivr fronts the repo with a real CDN — right for thumbnails (many small
// media files, cache-friendly). The index itself comes from raw.githubusercontent
// because jsDelivr can serve branch files up to a week stale.
const TEMPLATE_CDN_BASE = `https://cdn.jsdelivr.net/gh/${TEMPLATE_REPO}@main/`
const TEMPLATE_RAW_BASE = `https://raw.githubusercontent.com/${TEMPLATE_REPO}/main/`
const TEMPLATE_GITHUB_BLOB_BASE = `https://github.com/${TEMPLATE_REPO}/blob/main/`

const CACHE_DIR_NAME = 'template-cache'
const CACHE_FILE_NAME = 'comfy-templates-index.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000

// Tutorial content — not importable generation workflows.
const SKIPPED_CATEGORY_TITLES = new Set(['Getting Started', 'Node Basics'])

let memoryCache = null

function slugifyCategory(title) {
  return String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'other'
}

function normalizeStringList(values) {
  if (!Array.isArray(values)) return []
  return values.map((value) => String(value || '').trim()).filter(Boolean)
}

function buildThumbnailUrl(template) {
  const explicit = Array.isArray(template?.thumbnail) ? template.thumbnail[0] : template?.thumbnail
  if (typeof explicit === 'string' && explicit.trim()) {
    // Explicit thumbnail paths are relative to the repo root (thumbnail/, output/...).
    return `${TEMPLATE_CDN_BASE}${explicit.trim().replace(/^\/+/, '')}`
  }
  const name = String(template?.name || '').trim()
  const subtype = String(template?.mediaSubtype || '').trim().toLowerCase()
  if (!name) return ''
  // Convention used by the ComfyUI frontend: templates/{name}-1.{mediaSubtype}.
  // Audio templates use mp3 media, which is no use as a card cover.
  if (subtype && subtype !== 'webp') return ''
  return `${TEMPLATE_CDN_BASE}templates/${name}-1.webp`
}

function normalizeTemplate(rawTemplate, categoryId, categoryLabel) {
  const name = String(rawTemplate?.name || '').trim()
  if (!name) return null
  return {
    name,
    title: String(rawTemplate?.title || name).trim(),
    description: String(rawTemplate?.description || '').trim(),
    categoryId,
    categoryLabel,
    tags: normalizeStringList(rawTemplate?.tags),
    models: normalizeStringList(rawTemplate?.models),
    date: String(rawTemplate?.date || '').trim(),
    openSource: Boolean(rawTemplate?.openSource),
    sizeBytes: Number.isFinite(Number(rawTemplate?.size)) ? Number(rawTemplate.size) : 0,
    vramBytes: Number.isFinite(Number(rawTemplate?.vram)) ? Number(rawTemplate.vram) : 0,
    usage: Number.isFinite(Number(rawTemplate?.usage)) ? Number(rawTemplate.usage) : 0,
    requiresCustomNodes: normalizeStringList(rawTemplate?.requiresCustomNodes),
    io: rawTemplate?.io && typeof rawTemplate.io === 'object' ? rawTemplate.io : null,
    mediaType: String(rawTemplate?.mediaType || '').trim(),
    mediaSubtype: String(rawTemplate?.mediaSubtype || '').trim(),
    thumbnailUrl: buildThumbnailUrl(rawTemplate),
    workflowUrl: `${TEMPLATE_RAW_BASE}templates/${name}.json`,
    sourceUrl: `${TEMPLATE_GITHUB_BLOB_BASE}templates/${name}.json`,
  }
}

export function normalizeComfyTemplateIndex(rawIndex) {
  const categories = []
  const templates = []
  const seenNames = new Set()

  for (const module of Array.isArray(rawIndex) ? rawIndex : []) {
    const label = String(module?.title || '').trim()
    if (!label || SKIPPED_CATEGORY_TITLES.has(label)) continue
    const categoryId = slugifyCategory(label)

    const moduleTemplates = []
    for (const rawTemplate of Array.isArray(module?.templates) ? module.templates : []) {
      const normalized = normalizeTemplate(rawTemplate, categoryId, label)
      if (!normalized || seenNames.has(normalized.name)) continue
      seenNames.add(normalized.name)
      moduleTemplates.push(normalized)
    }
    if (moduleTemplates.length === 0) continue

    moduleTemplates.sort((a, b) => b.usage - a.usage)
    categories.push({ id: categoryId, label })
    templates.push(...moduleTemplates)
  }

  return { categories, templates }
}

async function getCachePath() {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  if (!api?.getAppPath || !api?.pathJoin) return null
  try {
    const userData = await api.getAppPath('userData')
    if (!userData) return null
    const dir = await api.pathJoin(userData, CACHE_DIR_NAME)
    const file = await api.pathJoin(dir, CACHE_FILE_NAME)
    return { dir, file }
  } catch {
    return null
  }
}

async function readDiskCache() {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const cachePath = await getCachePath()
  if (!api?.readFile || !cachePath) return null
  try {
    const result = await api.readFile(cachePath.file, { encoding: 'utf8' })
    if (!result?.success || !result.data) return null
    const parsed = JSON.parse(result.data)
    if (!parsed || !Array.isArray(parsed.raw)) return null
    return { fetchedAt: Number(parsed.fetchedAt) || 0, raw: parsed.raw }
  } catch {
    return null
  }
}

async function writeDiskCache(raw, fetchedAt) {
  const api = typeof window !== 'undefined' ? window.electronAPI : null
  const cachePath = await getCachePath()
  if (!api?.writeFile || !cachePath) return
  try {
    await api.createDirectory?.(cachePath.dir, { recursive: true })
    await api.writeFile(cachePath.file, JSON.stringify({ fetchedAt, raw }), { encoding: 'utf8' })
  } catch {
    // Cache persistence is best-effort; browsing still works from memory.
  }
}

async function fetchIndexFromNetwork() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(TEMPLATE_INDEX_URL, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`Template index request failed (${response.status})`)
    }
    const raw = await response.json()
    if (!Array.isArray(raw)) {
      throw new Error('Template index has an unexpected shape.')
    }
    return raw
  } finally {
    clearTimeout(timer)
  }
}

function buildResult(raw, fetchedAt, fromCache, staleError = '') {
  const normalized = normalizeComfyTemplateIndex(raw)
  return {
    categories: normalized.categories,
    templates: normalized.templates,
    fetchedAt,
    fromCache,
    staleError,
  }
}

/**
 * Fetch the live ComfyUI official template catalog, with a 24h user-data cache
 * and stale-cache fallback when GitHub is unreachable. Throws only when there
 * is no network AND no cached copy.
 */
export async function fetchComfyTemplateCatalog({ forceRefresh = false } = {}) {
  const now = Date.now()

  if (!forceRefresh) {
    if (memoryCache && now - memoryCache.fetchedAt < CACHE_TTL_MS) {
      return buildResult(memoryCache.raw, memoryCache.fetchedAt, true)
    }
    const diskCache = await readDiskCache()
    if (diskCache && now - diskCache.fetchedAt < CACHE_TTL_MS) {
      memoryCache = diskCache
      return buildResult(diskCache.raw, diskCache.fetchedAt, true)
    }
  }

  try {
    const raw = await fetchIndexFromNetwork()
    memoryCache = { raw, fetchedAt: now }
    void writeDiskCache(raw, now)
    return buildResult(raw, now, false)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not fetch the template index.'
    const fallback = memoryCache || await readDiskCache()
    if (fallback) {
      memoryCache = fallback
      return buildResult(fallback.raw, fallback.fetchedAt, true, message)
    }
    throw new Error(message)
  }
}
