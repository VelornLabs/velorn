import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, ExternalLink, Play, X } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'
import { trapDialogFocus } from '../utils/dialogFocus.mjs'
import { TUTORIAL_GROUPS } from '../config/tutorialVideos.mjs'
import {
  extractYouTubeVideoId,
  getYouTubeEmbedUrl,
  getYouTubeThumbnailUrl,
  getYouTubeWatchUrl,
} from '../services/discoverCatalog.mjs'

// The Tutorials tab. The file and component keep their older "Discover" name
// because the tab id and the saved "show this tab" setting still use it.

function buildYouTubeEmbedUrl(input) {
  const youtubeId = extractYouTubeVideoId(input)
  if (!youtubeId) return ''
  // The iframe is never mounted until a user explicitly clicks Watch. Keep
  // every part of its URL local and fixed apart from the revalidated video ID.
  return `${getYouTubeEmbedUrl(youtubeId)}&autoplay=1&playsinline=1&modestbranding=1&iv_load_policy=3`
}

async function openYouTubeExternally(url) {
  try {
    if (typeof window !== 'undefined' && window.electronAPI?.openExternalUrl) {
      const result = await window.electronAPI.openExternalUrl(url)
      if (result?.success) return true
    }
  } catch (_) {
    // Fall through to the browser-safe path below.
  }

  try {
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer')
      return true
    }
  } catch (_) {
    // There is no useful recovery if neither host can open a URL.
  }
  return false
}

function TutorialCard({ video, onWatch, retryThumbnails }) {
  const { t } = useI18n()
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const youtubeId = extractYouTubeVideoId(video.youtubeId)
  const thumbnailUrl = youtubeId ? getYouTubeThumbnailUrl(youtubeId) : ''

  useEffect(() => {
    if (retryThumbnails) setThumbnailFailed(false)
  }, [retryThumbnails, thumbnailUrl])

  return (
    <button
      type="button"
      onClick={() => onWatch(video)}
      disabled={!youtubeId}
      aria-label={t('discover.actions.watch', { title: video.title }, `Watch ${video.title}`)}
      className="group flex flex-col overflow-hidden rounded-xl border border-sf-dark-700 bg-sf-dark-900 text-left shadow-sm transition-colors hover:border-sf-dark-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent"
    >
      <span className="relative block aspect-video w-full overflow-hidden bg-sf-dark-800">
        {thumbnailUrl && !thumbnailFailed ? (
          <img
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            draggable="false"
            onError={() => setThumbnailFailed(true)}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-sf-dark-700 to-sf-dark-900">
            <BookOpen className="h-10 w-10 text-sf-text-muted" aria-hidden="true" />
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/10 transition-colors group-hover:bg-black/25" aria-hidden="true">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/95 text-sf-dark-950 shadow-lg transition-transform group-hover:scale-105">
            <Play className="ml-0.5 h-5 w-5 fill-current" />
          </span>
        </span>
      </span>
      <span className="block p-3.5">
        <span className="block text-sm font-semibold leading-snug text-sf-text-primary">{video.title}</span>
        {video.description && (
          <span className="mt-1.5 block text-xs leading-relaxed text-sf-text-secondary">{video.description}</span>
        )}
      </span>
    </button>
  )
}

function VideoPlayerModal({ item, onClose }) {
  const { t } = useI18n()
  const dialogRef = useRef(null)
  const closeButtonRef = useRef(null)
  const youtubeId = extractYouTubeVideoId(item?.youtubeId)
  const embedUrl = buildYouTubeEmbedUrl(youtubeId)

  useEffect(() => {
    const previousFocus = document.activeElement
    closeButtonRef.current?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [])

  if (!item || !youtubeId || !embedUrl) return null

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="discover-player-title"
      data-discover-overlay="true"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          return
        }
        trapDialogFocus(event, dialogRef.current)
      }}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose()
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-sf-dark-600 bg-sf-dark-900 shadow-2xl outline-none"
      >
        <div className="flex items-start gap-3 border-b border-sf-dark-700 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="discover-player-title" className="truncate text-base font-semibold text-sf-text-primary">
              {item.title}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-sf-text-muted transition-colors hover:bg-sf-dark-700 hover:text-sf-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent"
            aria-label={t('discover.actions.close', undefined, 'Close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="aspect-video w-full bg-black">
          <iframe
            src={embedUrl}
            title={t('discover.player.title', { title: item.title }, `YouTube video: ${item.title}`)}
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-sf-dark-700 px-4 py-3">
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-sf-text-muted">
            {t(
              'discover.player.privacy',
              undefined,
              'Thumbnails are provided by YouTube. Velorn loads the player only after you choose to watch a video.',
            )}
          </p>
          <button
            type="button"
            onClick={() => { void openYouTubeExternally(getYouTubeWatchUrl(youtubeId)) }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-sf-dark-600 bg-sf-dark-800 px-3 py-1.5 text-xs font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('discover.actions.openYouTube', undefined, 'Open on YouTube')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function DiscoverWorkspace({ onClose }) {
  const { t } = useI18n()
  const [activeVideo, setActiveVideo] = useState(null)
  const closeVideo = useCallback(() => setActiveVideo(null), [])
  const [isOnline, setIsOnline] = useState(() => (
    typeof navigator === 'undefined' ? true : navigator.onLine !== false
  ))

  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-sf-dark-950">
      <header className="flex-shrink-0 border-b border-sf-dark-700 bg-sf-dark-950/95 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-sf-text-primary">
              {t('discover.title', undefined, 'Tutorials')}
            </h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-sf-text-muted">
              {t(
                'discover.subtitle',
                undefined,
                'Short videos that teach Velorn, one part at a time.',
              )}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-sf-text-secondary">
              {t(
                'discover.visibilityHint',
                undefined,
                'You can hide the Tutorials tab anytime in Settings → Appearance.',
              )}
            </p>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-sf-dark-700 bg-sf-dark-800 p-2 text-sf-text-muted transition-colors hover:text-sf-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-sf-accent"
              aria-label={t('discover.actions.close', undefined, 'Close')}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto w-full max-w-7xl space-y-8">
          {TUTORIAL_GROUPS.map((group) => (
            <section key={group.id} aria-labelledby={`tutorials-group-${group.id}`}>
              <h2 id={`tutorials-group-${group.id}`} className="mb-3 text-base font-semibold text-sf-text-primary">
                {t(`discover.groups.${group.id}`, undefined, group.title)}
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {group.videos.map((video) => (
                  <TutorialCard
                    key={video.youtubeId}
                    video={video}
                    onWatch={setActiveVideo}
                    retryThumbnails={isOnline}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>

      {activeVideo && <VideoPlayerModal item={activeVideo} onClose={closeVideo} />}
    </div>
  )
}
