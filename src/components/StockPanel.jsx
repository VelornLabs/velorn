import { useState, useEffect, useCallback } from 'react'
import { Search, Video, Image as ImageIcon, Download, Loader2, ExternalLink, AlertCircle, Play, X, Home } from 'lucide-react'
import useProjectStore from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import { importAsset, isElectron } from '../services/fileSystem'
import { enqueuePlaybackTranscode } from '../services/playbackCache'
import { enqueueProxyTranscode, isProxyPlaybackEnabled } from '../services/proxyCache'
import { getPexelsApiKey } from '../services/pexelsSettings'
import {
  PEXELS_DEFAULT_PER_PAGE,
  VELORN_OPEN_STOCK_EVENT,
  buildPexelsAssetRecord,
  downloadPexelsMediaItem,
  getBestPexelsVideoFile,
  loadDefaultPexelsMedia,
  readPexelsStockPanelState,
  searchPexelsMedia,
  writePexelsStockPanelState,
} from '../services/pexelsStock'
import { useI18n } from '../i18n/I18nContext'

const PER_PAGE = PEXELS_DEFAULT_PER_PAGE

function StockPanel() {
  const { t } = useI18n()
  const persistedState = readPexelsStockPanelState()
  const [apiKey, setApiKey] = useState(null)
  const [searchQuery, setSearchQuery] = useState(persistedState?.searchQuery || '')
  const [mediaType, setMediaType] = useState(
    persistedState?.mediaType === 'photos' ? 'photos' : 'videos'
  ) // 'videos' | 'photos'
  const [results, setResults] = useState(Array.isArray(persistedState?.results) ? persistedState.results : [])
  const [page, setPage] = useState(Math.max(1, Number(persistedState?.page) || 1))
  const [totalResults, setTotalResults] = useState(Math.max(0, Number(persistedState?.totalResults) || 0))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [addingId, setAddingId] = useState(null) // id of item being added
  const [isDefaultContent, setIsDefaultContent] = useState(Boolean(persistedState?.isDefaultContent ?? true)) // trending/popular when no search
  const [previewVideo, setPreviewVideo] = useState(null) // video item for preview modal

  const { currentProjectHandle } = useProjectStore()
  const { addAsset } = useAssetsStore()

  // Load API key on mount
  useEffect(() => {
    getPexelsApiKey().then(key => setApiKey(key?.trim() || null))
  }, [])

  // Persist panel state so tab switches keep current stock context/results.
  useEffect(() => {
    writePexelsStockPanelState({
      searchQuery,
      mediaType,
      results,
      page,
      totalResults,
      isDefaultContent,
    })
  }, [searchQuery, mediaType, results, page, totalResults, isDefaultContent])

  // MCP searches can open an already-mounted Stock tab. A newly-mounted tab
  // hydrates the same payload from localStorage above; this event handles the
  // case where the tab was already visible when the search completed.
  useEffect(() => {
    const handler = (event) => {
      const state = event?.detail?.stockState
      if (!state || !Array.isArray(state.results)) return
      setSearchQuery(String(state.searchQuery || ''))
      setMediaType(state.mediaType === 'photos' ? 'photos' : 'videos')
      setResults(state.results)
      setPage(Math.max(1, Number(state.page) || 1))
      setTotalResults(Math.max(0, Number(state.totalResults) || 0))
      setIsDefaultContent(Boolean(state.isDefaultContent))
      setError(null)
      setPreviewVideo(null)
    }
    window.addEventListener(VELORN_OPEN_STOCK_EVENT, handler)
    return () => window.removeEventListener(VELORN_OPEN_STOCK_EVENT, handler)
  }, [])

  // Fetch trending/popular content when no search query (first visit or cleared search)
  const loadDefaultContent = useCallback(async (pageNum = 1) => {
    if (!apiKey) return
    setError(null)
    setLoading(true)
    try {
      const response = await loadDefaultPexelsMedia({ apiKey, mediaType, page: pageNum, perPage: PER_PAGE })
      setResults(response.items)
      setTotalResults(response.totalResults)
      setPage(response.page)
      setIsDefaultContent(true)
    } catch (err) {
      setError(err.message || t('stock.loadFailed'))
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [apiKey, mediaType, t])

  // When API key is ready and there's no search query, show trending/popular
  useEffect(() => {
    if (!apiKey || searchQuery.trim()) return
    if (results.length > 0 && isDefaultContent) return
    loadDefaultContent(1)
  }, [apiKey, mediaType, searchQuery, isDefaultContent, results.length, loadDefaultContent])

  const search = useCallback(async (pageNum = 1) => {
    if (!apiKey) {
      setError(t('stock.apiKeyMissing'))
      return
    }
    const query = searchQuery.trim()
    if (!query) {
      setError(t('stock.searchTermRequired'))
      return
    }
    setError(null)
    setIsDefaultContent(false)
    setLoading(true)
    try {
      const response = await searchPexelsMedia({ apiKey, query, mediaType, page: pageNum, perPage: PER_PAGE })
      setResults(response.items)
      setTotalResults(response.totalResults)
      setPage(response.page)
    } catch (err) {
      setError(err.message || t('stock.searchFailed'))
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [apiKey, searchQuery, mediaType, t])

  const handleAddToProject = async (item) => {
    if (!currentProjectHandle) {
      setError(t('stock.projectRequired'))
      return
    }
    setAddingId(item.id)
    setError(null)
    try {
      const downloaded = await downloadPexelsMediaItem({ item, mediaType })
      const assetInfo = await importAsset(currentProjectHandle, downloaded.file, downloaded.spec.category)
      const blobUrl = URL.createObjectURL(downloaded.blob)
      const newAsset = addAsset(buildPexelsAssetRecord({
        item,
        mediaType,
        query: searchQuery,
        imported: assetInfo,
        blobUrl,
        sourceTool: 'stock_panel',
      }))
      if (downloaded.spec.assetType === 'video' && isElectron() && currentProjectHandle && newAsset?.absolutePath) {
        enqueuePlaybackTranscode(currentProjectHandle, newAsset.id, newAsset.absolutePath).catch(() => {})
        if (isProxyPlaybackEnabled()) {
          enqueueProxyTranscode(currentProjectHandle, newAsset.id, newAsset.absolutePath).catch(() => {})
        }
      }
    } catch (err) {
      setError(err.message || t('stock.addFailed'))
    } finally {
      setAddingId(null)
    }
  }

  const totalPages = Math.ceil(totalResults / PER_PAGE)
  const loadPage = (pageNum) => isDefaultContent ? loadDefaultContent(pageNum) : search(pageNum)
  const canGoHome = Boolean(searchQuery.trim()) || !isDefaultContent

  const handleGoHome = useCallback(() => {
    setError(null)
    setSearchQuery('')
    setIsDefaultContent(true)
    setPage(1)
    setPreviewVideo(null)
    loadDefaultContent(1)
  }, [loadDefaultContent])

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-sf-dark-950">
      {/* Header */}
      <div className="flex-shrink-0 p-4 border-b border-sf-dark-700">
        <div className="flex items-center gap-3 mb-3">
          <h1 className="text-lg font-semibold text-sf-text-primary">{t('stock.title')}</h1>
          <a
            href="https://www.pexels.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-sf-text-muted hover:text-sf-accent flex items-center gap-1"
          >
            <ExternalLink className="w-3 h-3" />
            {t('stock.source')}
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1 min-w-[200px] relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-sf-text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search(1)}
              placeholder={t('stock.searchPlaceholder')}
              className="w-full pl-8 pr-3 py-2 bg-sf-dark-800 border border-sf-dark-600 rounded-lg text-sm text-sf-text-primary placeholder-sf-text-muted focus:outline-none focus:border-sf-accent"
            />
          </div>
          <div className="flex rounded-lg overflow-hidden border border-sf-dark-600">
            <button
              onClick={() => setMediaType('videos')}
              className={`px-3 py-2 text-xs flex items-center gap-1.5 transition-colors ${mediaType === 'videos' ? 'bg-sf-accent text-white' : 'bg-sf-dark-800 text-sf-text-muted hover:bg-sf-dark-700'}`}
            >
              <Video className="w-3.5 h-3.5" />
              {t('stock.videos')}
            </button>
            <button
              onClick={() => setMediaType('photos')}
              className={`px-3 py-2 text-xs flex items-center gap-1.5 transition-colors ${mediaType === 'photos' ? 'bg-sf-accent text-white' : 'bg-sf-dark-800 text-sf-text-muted hover:bg-sf-dark-700'}`}
            >
              <ImageIcon className="w-3.5 h-3.5" />
              {t('stock.photos')}
            </button>
          </div>
          <button
            onClick={() => search(1)}
            disabled={loading || !searchQuery.trim()}
            className="px-4 py-2 bg-sf-accent hover:bg-sf-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg flex items-center gap-2 transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {t('stock.search')}
          </button>
          <button
            onClick={handleGoHome}
            disabled={loading || !canGoHome}
            className="px-3 py-2 bg-sf-dark-800 border border-sf-dark-600 hover:bg-sf-dark-700 disabled:opacity-50 disabled:cursor-not-allowed text-sf-text-secondary text-sm font-medium rounded-lg flex items-center gap-2 transition-colors"
            title={t('stock.homeHelp')}
          >
            <Home className="w-4 h-4" />
            {t('stock.home')}
          </button>
        </div>
      </div>

      {/* No API key */}
      {!apiKey && (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="max-w-md text-center">
            <AlertCircle className="w-12 h-12 text-sf-accent mx-auto mb-3" />
            <p className="text-sm text-sf-text-primary mb-2">{t('stock.apiRequired')}</p>
            <p className="text-xs text-sf-text-muted mb-4">
              {t('stock.apiGetKeyAt')}{' '}
              <a href="https://www.pexels.com/api/" target="_blank" rel="noopener noreferrer" className="text-sf-accent hover:underline">
                pexels.com/api
              </a>
              {t('stock.apiInstructions')}
            </p>
            <button
              onClick={() => getPexelsApiKey().then(key => setApiKey(key?.trim() || null))}
              className="px-3 py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-primary"
            >
              {t('stock.refreshKey')}
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {apiKey && error && (
        <div className="flex-shrink-0 px-4 py-2 bg-red-500/10 border-b border-red-500/30 text-sm text-red-400 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Results grid */}
      {apiKey && (
        <div className="flex-1 overflow-auto p-4">
          {loading && results.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 text-sf-accent animate-spin" />
            </div>
          ) : results.length === 0 && !error ? (
            <div className="text-center py-20 text-sf-text-muted text-sm">
              {searchQuery.trim() ? t('stock.noResults') : t('stock.enterSearch')}
            </div>
          ) : (
            <>
              {isDefaultContent && (
                <p className="text-xs text-sf-text-muted mb-3">
                  {mediaType === 'videos' ? t('stock.popularVideos') : t('stock.trendingPhotos')} {t('stock.defaultHelp')}
                </p>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {results.map((item) => {
                  const thumb = mediaType === 'videos' ? (item.image || item.video_pictures?.[0]?.picture) : (item.src?.medium || item.src?.large)
                  const isAdding = addingId === item.id
                  const isVideo = mediaType === 'videos'
                  return (
                    <div
                      key={item.id}
                      className="bg-sf-dark-800 border border-sf-dark-600 rounded-lg overflow-hidden group"
                    >
                      <div
                        className={`aspect-video bg-sf-dark-700 relative ${isVideo ? 'cursor-pointer' : ''}`}
                        onClick={isVideo ? () => setPreviewVideo(item) : undefined}
                        role={isVideo ? 'button' : undefined}
                        aria-label={isVideo ? t('stock.previewVideo') : undefined}
                      >
                        {thumb && (
                          <img
                            src={thumb}
                            alt={item.alt || item.user?.name || ''}
                            className="w-full h-full object-cover"
                          />
                        )}
                        {isVideo && item.duration && (
                          <span className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/70 rounded text-[10px] text-white">
                            {item.duration}s
                          </span>
                        )}
                        {isVideo && (
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); setPreviewVideo(item) }}
                              className="p-2 bg-white/90 hover:bg-white rounded-full text-sf-dark-900 shadow-lg"
                              title={t('stock.preview')}
                              aria-label={t('stock.previewVideo')}
                            >
                              <Play className="w-5 h-5 fill-current" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleAddToProject(item) }}
                              disabled={!currentProjectHandle || isAdding}
                              className="px-3 py-1.5 bg-sf-accent hover:bg-sf-accent-hover disabled:opacity-50 text-white text-xs font-medium rounded flex items-center gap-1.5"
                            >
                              {isAdding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                              {t('stock.addToProject')}
                            </button>
                          </div>
                        )}
                        {!isVideo && (
                          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <button
                              onClick={() => handleAddToProject(item)}
                              disabled={!currentProjectHandle || isAdding}
                              className="px-3 py-1.5 bg-sf-accent hover:bg-sf-accent-hover disabled:opacity-50 text-white text-xs font-medium rounded flex items-center gap-1.5"
                            >
                              {isAdding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                              {t('stock.addToProject')}
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="p-2">
                        <p className="text-[10px] text-sf-text-muted truncate" title={item.alt || item.user?.name}>
                          {item.alt || item.user?.name || `Pexels ${item.id}`}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-6">
                  <button
                    onClick={() => loadPage(page - 1)}
                    disabled={page <= 1 || loading}
                    className="px-3 py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 disabled:opacity-50 rounded text-xs text-sf-text-primary"
                  >
                    {t('stock.previous')}
                  </button>
                  <span className="text-xs text-sf-text-muted">
                    {t('stock.page', { page, pages: totalPages, results: totalResults })}
                  </span>
                  <button
                    onClick={() => loadPage(page + 1)}
                    disabled={page >= totalPages || loading}
                    className="px-3 py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 disabled:opacity-50 rounded text-xs text-sf-text-primary"
                  >
                    {t('stock.next')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Video preview modal */}
      {previewVideo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPreviewVideo(null)}
          role="dialog"
          aria-modal="true"
          aria-label={t('stock.videoPreview')}
        >
          <div
            className="relative bg-sf-dark-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setPreviewVideo(null)}
              className="absolute top-2 right-2 z-10 p-1.5 rounded-full bg-black/60 hover:bg-black/80 text-white transition-colors"
              aria-label={t('stock.closePreview')}
            >
              <X className="w-5 h-5" />
            </button>
            <div className="flex-1 min-h-0 flex items-center justify-center p-4">
              <video
                src={getBestPexelsVideoFile(previewVideo)?.link || ''}
                controls
                className="max-w-full max-h-[70vh] w-full rounded"
                preload="metadata"
                onEnded={(e) => e.target.pause()}
              />
            </div>
            <div className="flex items-center justify-between gap-4 p-4 border-t border-sf-dark-600">
              <p className="text-sm text-sf-text-muted truncate flex-1">
                {previewVideo.user?.name || `Video ${previewVideo.id}`}
                {previewVideo.duration != null && ` · ${previewVideo.duration}s`}
              </p>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => setPreviewVideo(null)}
                  className="px-3 py-1.5 bg-sf-dark-600 hover:bg-sf-dark-500 rounded text-sm text-sf-text-primary"
                >
                  {t('common.close')}
                </button>
                <button
                  onClick={() => {
                    handleAddToProject(previewVideo)
                    setPreviewVideo(null)
                  }}
                  disabled={!currentProjectHandle || addingId === previewVideo.id}
                  className="px-4 py-1.5 bg-sf-accent hover:bg-sf-accent-hover disabled:opacity-50 text-white text-sm font-medium rounded flex items-center gap-1.5"
                >
                  {addingId === previewVideo.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  {t('stock.addToProject')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer attribution */}
      <div className="flex-shrink-0 px-4 py-2 border-t border-sf-dark-700 text-[10px] text-sf-text-muted">
        <a href="https://www.pexels.com" target="_blank" rel="noopener noreferrer" className="text-sf-accent hover:underline">
          {t('stock.providedBy')}
        </a>
        {t('stock.attribution')}
      </div>
    </div>
  )
}

export default StockPanel
