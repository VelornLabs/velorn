import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, FolderSearch, Loader2, Music, Plus, RotateCw, X } from 'lucide-react'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import {
  MUSIC_BPM_MAX,
  MUSIC_BACKENDS,
  getMusicBackend,
  MUSIC_BPM_MIN,
  MUSIC_DURATION_MAX,
  MUSIC_DURATION_MIN,
  MUSIC_JOBS_UPDATED_EVENT,
  MUSIC_KEY_SCALES,
  MUSIC_TIME_SIGNATURES,
  MUSIC_VARIATIONS_MAX,
  YUE2_AUTOMATIC_DURATION,
  YUE2_CUSTOM_DURATION_MAX,
  checkMusicModelDependencies,
  getMusicJobs,
  resolveMusicLength,
  queueMusicGeneration,
} from '../services/musicGeneration'
import { checkLocalComfyConnection } from '../services/localComfyConnection'
import { useWorkflowSetupFlow } from '../hooks/useWorkflowSetupFlow'
import { formatBytes } from '../hooks/useWorkflowSetupFlow'
import useMusicPopoverStore from '../stores/musicPopoverStore'

/**
 * Number field that lets you type freely and only clamps to [min, max] when
 * you finish (blur or Enter) — a controlled input that clamped on every
 * keystroke would snap "1" to the minimum before you could type "140".
 */
function ClampedNumberField({ value, min, max, onCommit, className, label }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])

  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.max(min, Math.min(max, Math.round(parsed)))
    setDraft(String(clamped))
    onCommit(clamped)
  }

  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      className={className}
    />
  )
}

/**
 * YuE2 defaults to Automatic with an optional custom maximum. Only explicit
 * custom / ACE-Step durations prefill from an in/out range; finished takes
 * retain their measured length when added to the timeline.
 */
export default function GenerateMusicPopover(props) {
  const storedBackend = useMusicPopoverStore(state => state.backend)
  const backend = MUSIC_BACKENDS.some(model => model.id === storedBackend) ? storedBackend : 'yue2'
  // A fresh setup state per backend prevents late dependency checks or download
  // plans from the previously selected model from enabling the wrong action.
  return <MusicPanel key={backend} {...props} backend={backend} />
}

function MusicPanel({ onClose, anchorRect = null, backend }) {
  const model = getMusicBackend(backend)
  const isYue2 = backend === 'yue2'
  const projectHandle = useProjectStore(state => state.currentProjectHandle)
  const {
    inPoint,
    outPoint,
    playheadPosition,
  } = useTimelineStore()
  const getAssetById = useAssetsStore((state) => state.getAssetById)

  const rangeStart = Number.isFinite(inPoint) && inPoint !== null ? inPoint : null
  const rangeEnd = Number.isFinite(outPoint) && outPoint !== null ? outPoint : null
  const hasRange = rangeStart !== null && rangeEnd !== null && rangeEnd > rangeStart
  const dropTime = hasRange ? rangeStart : (Number(playheadPosition) || 0)

  // Persisted form state (survives popover close and app restart).
  const {
    tags,
    instrumental,
    lyrics,
    yue2LengthMode,
    yue2CustomDurationSeconds,
    durationSeconds,
    variations,
    bpm,
    keyScale,
    timeSignature,
    sessionPromptIds,
    setMusicField,
    appendSessionPromptIds,
  } = useMusicPopoverStore()
  const lengthMode = isYue2 ? (yue2LengthMode === 'custom' ? 'custom' : 'automatic') : 'exact'
  const durationField = isYue2 ? 'yue2CustomDurationSeconds' : 'durationSeconds'
  const resolvedLength = resolveMusicLength({
    backend, durationSeconds: isYue2 ? yue2CustomDurationSeconds : durationSeconds, lengthMode,
  })
  const matchesRange = hasRange && lengthMode !== 'automatic'
    && resolvedLength.durationSeconds === resolveMusicLength({
      backend, lengthMode, durationSeconds: rangeEnd - rangeStart,
    }).durationSeconds

  const [isQueueing, setIsQueueing] = useState(false)
  const [queueError, setQueueError] = useState('')
  const [jobs, setJobs] = useState([])
  const mounted = useRef(true)
  const checkRequest = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  // In/out can prefill an explicit length, never choose Custom or reduce the
  // Automatic ceiling. Preserve the last custom seconds while Automatic is on.
  useEffect(() => {
    if (hasRange && lengthMode !== 'automatic') {
      setMusicField(durationField, resolveMusicLength({
        backend, lengthMode, durationSeconds: rangeEnd - rangeStart,
      }).durationSeconds)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Check the selected backend on open and after a user-approved installation.
  const [isConnected, setIsConnected] = useState(false)
  const [dependencyCheck, setDependencyCheck] = useState({ status: 'idle', hasPack: true, hasBlockingIssues: false })

  const recheckModels = useCallback(async () => {
    const request = ++checkRequest.current
    setDependencyCheck({ status: 'checking', hasPack: true, hasBlockingIssues: false })
    const connection = await checkLocalComfyConnection().catch(() => null)
    const result = connection?.ok ? await checkMusicModelDependencies(backend) : null
    if (mounted.current && request === checkRequest.current) {
      setIsConnected(Boolean(connection?.ok))
      setDependencyCheck(result || { status: 'error', hasPack: true, hasBlockingIssues: true })
    }
    return result
  }, [backend])

  useEffect(() => {
    recheckModels()
  }, [recheckModels])

  const setupFlow = useWorkflowSetupFlow({ dependencyCheck, isConnected, recheck: recheckModels })
  const modelsMissing = setupFlow.mode !== 'hidden' && setupFlow.mode !== 'installing' && setupFlow.mode !== 'restarting'
  const modelsInstalling = setupFlow.mode === 'installing' || setupFlow.phase === 'restarting'
  const checking = ['idle', 'checking'].includes(dependencyCheck.status)
  const modelsReady = isConnected && ['ready', 'partial'].includes(dependencyCheck.status) && !dependencyCheck.hasBlockingIssues

  const refreshJobs = useCallback(() => {
    setJobs(getMusicJobs(sessionPromptIds))
  }, [sessionPromptIds, projectHandle])

  useEffect(() => {
    refreshJobs()
    window.addEventListener(MUSIC_JOBS_UPDATED_EVENT, refreshJobs)
    return () => window.removeEventListener(MUSIC_JOBS_UPDATED_EVENT, refreshJobs)
  }, [refreshJobs])

  const handleGenerate = useCallback(async () => {
    setIsQueueing(true)
    setQueueError('')
    try {
      const queued = await queueMusicGeneration({
        backend,
        tags,
        lyrics,
        instrumental,
        durationSeconds: resolvedLength.durationSeconds,
        ...(isYue2 ? { lengthMode } : {}),
        variations,
        ...(!isYue2 ? { bpm, keyScale, timeSignature } : {}),
      })
      appendSessionPromptIds(queued.map((job) => job.promptId))
    } catch (err) {
      if (err?.queuedJobs?.length) appendSessionPromptIds(err.queuedJobs.map(job => job.promptId))
      setQueueError(err?.message || 'Could not queue music. Check the ComfyUI connection and selected model.')
    } finally {
      setIsQueueing(false)
    }
  }, [backend, isYue2, tags, lyrics, instrumental, resolvedLength.durationSeconds, lengthMode, variations, bpm, keyScale, timeSignature, appendSessionPromptIds])

  const handleAddToTimeline = useCallback((assetId) => {
    const asset = getAssetById(assetId)
    if (!asset) return
    const state = useTimelineStore.getState()
    const audioTracks = (state.tracks || []).filter((track) => track.type === 'audio' && !track.locked)
    const clipLength = Number(asset.duration)
    if (!Number.isFinite(clipLength) || clipLength <= 0) return
    // Prefer an audio track with free space at the drop time; otherwise add one.
    let targetTrack = audioTracks.find((track) => !(state.clips || []).some((clip) => (
      clip.trackId === track.id
      && dropTime < clip.startTime + clip.duration
      && clip.startTime < dropTime + clipLength
    )))
    if (!targetTrack && typeof state.addTrack === 'function') {
      state.addTrack('audio')
      const nextTracks = useTimelineStore.getState().tracks || []
      targetTrack = [...nextTracks].reverse().find((track) => track.type === 'audio') || null
    }
    if (!targetTrack?.id) return
    useTimelineStore.getState().addClip(targetTrack.id, asset, dropTime)
  }, [dropTime, getAssetById])

  const activeCount = useMemo(() => jobs.filter((job) => job.status === 'queued' || job.status === 'running').length, [jobs])

  // Fixed positioning so the panel escapes the timeline toolbar's
  // overflow-hidden/overflow-x-auto containers (which clip an absolutely
  // positioned popover). Anchor under the triggering button, clamped to the
  // viewport; flip above the anchor if it would run off the bottom.
  const PANEL_WIDTH = 360
  const positionStyle = useMemo(() => {
    if (typeof window === 'undefined' || !anchorRect) {
      return { left: '50%', top: '20%', transform: 'translateX(-50%)' }
    }
    const margin = 8
    const left = Math.max(margin, Math.min(anchorRect.left, window.innerWidth - PANEL_WIDTH - margin))
    const spaceBelow = window.innerHeight - anchorRect.bottom
    if (spaceBelow < 360 && anchorRect.top > spaceBelow) {
      return { left: `${left}px`, bottom: `${window.innerHeight - anchorRect.top + margin}px` }
    }
    return { left: `${left}px`, top: `${anchorRect.bottom + margin}px` }
  }, [anchorRect])

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-label="Generate Music"
        className="fixed z-50 max-h-[85vh] w-[360px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-sf-dark-600 bg-sf-dark-800 p-3 shadow-2xl"
        style={positionStyle}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') onClose() }}
      >
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-sf-text-primary">
          <Music className="h-3.5 w-3.5 text-sf-accent" />
          Generate Music
        </span>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-sf-text-muted hover:bg-sf-dark-600 hover:text-sf-text-primary"
          aria-label="Close music generator"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <label className="mb-0.5 block text-[10px] text-sf-text-muted" htmlFor="music-backend">Music model</label>
      <select id="music-backend" value={backend} disabled={isQueueing || modelsInstalling}
        onChange={event => setMusicField('backend', event.target.value)}
        className="mb-2 w-full rounded border border-sf-dark-600 bg-sf-dark-900 px-2 py-1.5 text-xs text-sf-text-primary">
        {MUSIC_BACKENDS.map(entry => <option key={entry.id} value={entry.id}>{entry.label}{entry.id === 'ace-step' ? ' · Fast' : ''}</option>)}
      </select>

      <label className="mb-0.5 block text-[10px] text-sf-text-muted" htmlFor="music-style">Music style</label>
      <textarea
        id="music-style"
        value={tags}
        onChange={(event) => setMusicField('tags', event.target.value)}
        rows={2}
        placeholder="genre, mood, instruments, tempo — e.g. warm lo-fi hip hop, mellow keys, 85 bpm"
        className="mb-2 w-full resize-none rounded border border-sf-dark-600 bg-sf-dark-900 px-2 py-1.5 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
      />

      <label className="mb-2 flex items-center gap-2 text-[10px] text-sf-text-secondary">
        <input
          type="checkbox"
          checked={instrumental}
          onChange={(event) => setMusicField('instrumental', event.target.checked)}
        />
        Instrumental
      </label>

      {!instrumental && (
        <>
          <label className="mb-0.5 block text-[10px] text-sf-text-muted">
            Lyrics — use [verse], [chorus], [bridge] structure tags
          </label>
          <textarea
            aria-label="Lyrics"
            value={lyrics}
            onChange={(event) => setMusicField('lyrics', event.target.value)}
            rows={4}
            placeholder={'[verse]\nNeon rivers running through the night\n[chorus]\nWe glow, we glow...'}
            className="mb-2 w-full resize-none rounded border border-sf-dark-600 bg-sf-dark-900 px-2 py-1.5 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
          />
        </>
      )}

      <div className="mb-2 grid grid-cols-2 gap-2">
        <div>
          {isYue2 && <>
            <label htmlFor="music-length-mode" className="mb-0.5 block text-[10px] text-sf-text-muted">Song length</label>
            <select id="music-length-mode" value={lengthMode}
              onChange={event => setMusicField('yue2LengthMode', event.target.value)}
              className="w-full rounded border border-sf-dark-600 bg-sf-dark-900 px-2 py-1 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none">
              <option value="automatic">Automatic</option>
              <option value="custom">Custom maximum</option>
            </select>
          </>}
          {lengthMode !== 'automatic' && <div className={isYue2 ? 'mt-2' : ''}>
            <label className="mb-0.5 block text-[10px] text-sf-text-muted">
              {isYue2 ? 'Maximum length' : 'Duration'} (s){matchesRange ? ' · In/Out' : ''}
            </label>
            <ClampedNumberField
              label={isYue2 ? 'Maximum length (seconds)' : 'Duration (seconds)'}
              value={resolvedLength.durationSeconds}
              min={MUSIC_DURATION_MIN}
              max={isYue2 ? YUE2_CUSTOM_DURATION_MAX : MUSIC_DURATION_MAX}
              onCommit={(next) => setMusicField(durationField, next)}
              className="w-full rounded border border-sf-dark-600 bg-sf-dark-900 px-2 py-1 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
            />
          </div>}
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] text-sf-text-muted">Variations</label>
          <ClampedNumberField
            label="Variations"
            value={variations}
            min={1}
            max={MUSIC_VARIATIONS_MAX}
            onCommit={(next) => setMusicField('variations', next)}
            className="w-full rounded border border-sf-dark-600 bg-sf-dark-900 px-2 py-1 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
          />
        </div>
      </div>

      {isYue2 ? <p className="mb-2 text-[10px] leading-relaxed text-sf-text-muted">
        {lengthMode === 'automatic'
          ? `Let YuE2 finish the song, up to ${YUE2_AUTOMATIC_DURATION / 60} minutes. It may still reach the limit.`
          : 'YuE2 may finish before this maximum or be cut off at the limit.'}
        {' '}Describe tempo and key in Music style.
        {instrumental ? ' Instrumental is a prompt preference; vocals may still occur.' : ''}
      </p> : <div className="mb-2 grid grid-cols-3 gap-2">
        <div>
          <label className="mb-0.5 block text-[10px] text-sf-text-muted">BPM</label>
          <ClampedNumberField
            label="BPM"
            value={bpm}
            min={MUSIC_BPM_MIN}
            max={MUSIC_BPM_MAX}
            onCommit={(next) => setMusicField('bpm', next)}
            className="w-full rounded border border-sf-dark-600 bg-sf-dark-900 px-2 py-1 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] text-sf-text-muted">Key</label>
          <select
            value={keyScale}
            onChange={(event) => setMusicField('keyScale', event.target.value)}
            className="w-full rounded border border-sf-dark-600 bg-sf-dark-900 px-1 py-1 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
          >
            {MUSIC_KEY_SCALES.map((scale) => (
              <option key={scale} value={scale}>{scale}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] text-sf-text-muted">Time sig</label>
          <select
            value={timeSignature}
            onChange={(event) => setMusicField('timeSignature', event.target.value)}
            className="w-full rounded border border-sf-dark-600 bg-sf-dark-900 px-1 py-1 text-xs text-sf-text-primary focus:border-sf-accent focus:outline-none"
          >
            {MUSIC_TIME_SIGNATURES.map((sig) => (
              <option key={sig} value={sig}>{sig}/4</option>
            ))}
          </select>
        </div>
      </div>}

      {isYue2 && <p className="mb-2 text-[10px] leading-relaxed text-sf-text-muted">
        Local model · GPU support depends on your ComfyUI setup. <a className="text-sf-accent underline" href="https://github.com/multimodal-art-projection/YuE/blob/main/MODEL_LICENSE" target="_blank" rel="noreferrer">Model license</a>
        {' '}permits individual creator use; commercial use by companies needs permission.
      </p>}

      {!projectHandle && <p className="mb-2 text-[10px] text-amber-200">Create or open a project to save generated music.</p>}
      {checking ? <p role="status" className="mb-2 text-[10px] text-sf-text-muted">Checking ComfyUI and {model.label}…</p> : (!isConnected || dependencyCheck.status === 'error') && (
        <p role="status" className="mb-2 text-[10px] text-amber-200">
          {!isConnected ? 'Connect ComfyUI to generate music.' : 'Could not check this model.'}
          {' '}<button className="underline" onClick={recheckModels}>Check again</button>
        </p>
      )}

      {isConnected && modelsMissing && (
        <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 p-2">
          {setupFlow.mode === 'choose-root' ? (
            <>
              <p className="mb-1.5 text-[10px] text-amber-200/90">
                {model.label} isn't set up yet. Point Velorn at your ComfyUI folder to download it.
              </p>
              <button
                onClick={setupFlow.chooseComfyFolder}
                className="flex w-full items-center justify-center gap-1.5 rounded border border-amber-500/50 bg-amber-500/15 px-2 py-1 text-[10px] text-amber-100 hover:bg-amber-500/25"
              >
                <FolderSearch className="h-3 w-3" />
                Choose ComfyUI folder
              </button>
            </>
          ) : setupFlow.mode === 'manual-only' ? (
            <p className="text-[10px] text-amber-200/90">
              {dependencyCheck.missingNodes?.length ? 'Update ComfyUI to add the required music nodes, then check again.' : `${model.label} needs a manual model install.`}
              {' '}<button className="underline" onClick={recheckModels}>Check again</button>
            </p>
          ) : setupFlow.mode === 'needs-restart' ? (
            <>
              <p className="mb-1.5 text-[10px] text-amber-200/90">Models installed. Restart ComfyUI to load them.</p>
              <button
                onClick={setupFlow.restartNow}
                className="flex w-full items-center justify-center gap-1.5 rounded border border-amber-500/50 bg-amber-500/15 px-2 py-1 text-[10px] text-amber-100 hover:bg-amber-500/25"
              >
                <RotateCw className="h-3 w-3" />
                Restart ComfyUI
              </button>
            </>
          ) : (
            <>
              <p className="mb-1.5 text-[10px] text-amber-200/90">
                {model.label} isn't installed yet
                {setupFlow.totalDownloadBytes > 0 ? ` (~${formatBytes(setupFlow.totalDownloadBytes)}${setupFlow.unknownSizeCount > 0 ? ` + ${setupFlow.unknownSizeCount} more` : ''})` : ''}.
              </p>
              {setupFlow.insufficientDiskSpace && (
                <p className="mb-1.5 text-[10px] text-sf-error">Not enough free disk space for the download.</p>
              )}
              <button
                onClick={setupFlow.startSetup}
                disabled={setupFlow.insufficientDiskSpace}
                className="flex w-full items-center justify-center gap-1.5 rounded border border-amber-500/50 bg-amber-500/15 px-2 py-1 text-[10px] text-amber-100 hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-3 w-3" />
                Download model
              </button>
            </>
          )}
          {setupFlow.error && <p className="mt-1 text-[9px] text-sf-error">{setupFlow.error}</p>}
        </div>
      )}

      {modelsInstalling && (
        <div className="mb-2 rounded border border-sf-dark-600 bg-sf-dark-900 p-2">
          <p className="mb-1 flex items-center gap-1.5 text-[10px] text-sf-text-secondary">
            <Loader2 className="h-3 w-3 animate-spin" />
            {setupFlow.progress.currentLabel
              ? `Downloading ${setupFlow.progress.currentLabel}...`
              : 'Installing music model...'}
          </p>
          <div className="h-1 w-full overflow-hidden rounded bg-sf-dark-700">
            <div
              className="h-full bg-sf-accent transition-all"
              style={{ width: `${setupFlow.progress.overallPercent || 0}%` }}
            />
          </div>
        </div>
      )}

      <button
        onClick={handleGenerate}
        disabled={isQueueing || !tags.trim() || !projectHandle || !modelsReady || modelsInstalling}
        className="mb-2 flex w-full items-center justify-center gap-1.5 rounded bg-sf-accent/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sf-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isQueueing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Music className="h-3.5 w-3.5" />}
        {isQueueing ? 'Queueing...' : `Generate ${variations > 1 ? `${variations} takes` : 'music'}`}
      </button>

      {queueError && (
        <p className="mb-2 text-[10px] text-sf-error">{queueError}</p>
      )}

      {jobs.length > 0 && (
        <div className="max-h-48 space-y-1.5 overflow-y-auto border-t border-sf-dark-700 pt-2">
          {activeCount > 0 && (
            <p className="text-[10px] text-sf-text-muted">
              {activeCount} take{activeCount > 1 ? 's' : ''} generating — speed depends on your ComfyUI GPU.
            </p>
          )}
          {jobs.map((job) => (
            <div key={job.promptId} className="rounded border border-sf-dark-700 bg-sf-dark-900 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[10px] text-sf-text-secondary" title={job.tags}>
                  {job.backendLabel}{job.measuredDurationSeconds ? ` · ${job.measuredDurationSeconds.toFixed(1)}s` : ''} · Seed {job.seed}
                </span>
                {(job.status === 'queued' || job.status === 'running') && (
                  <span className="flex items-center gap-1 text-[10px] text-sf-text-muted">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {job.status}
                  </span>
                )}
                {job.status === 'failed' && (
                  <span className="text-[10px] text-sf-error" title={job.error || ''}>failed</span>
                )}
              </div>
              <p className="mt-0.5 text-[9px] text-sf-text-muted">
                {job.lengthMode === 'automatic'
                  ? `Automatic · up to ${job.durationSeconds / 60} min`
                  : `${job.durationSeconds}s${job.durationMode === 'maximum' || job.backend === 'yue2' ? ' max' : ''}`}
              </p>
              {job.status === 'completed' && job.completionWarning && (
                <p role="status" className="mt-1 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-[10px] leading-relaxed text-amber-200">
                  {job.completionWarning}
                </p>
              )}
              {job.error && (
                <p className="mt-0.5 text-[9px] text-sf-error/80">{job.error}</p>
              )}
              {job.status === 'completed' && job.belongsToCurrentProject && job.assetIds.map((assetId) => {
                const asset = getAssetById(assetId)
                if (!asset) return null
                return (
                  <div key={assetId} className="mt-1 space-y-1">
                    {asset?.url && (
                      <audio controls src={asset.url} className="h-7 w-full" />
                    )}
                    <button
                      onClick={() => handleAddToTimeline(assetId)}
                      className="flex w-full items-center justify-center gap-1 rounded border border-sf-accent/50 bg-sf-accent/15 px-2 py-1 text-[10px] text-sf-accent transition-colors hover:bg-sf-accent/25"
                    >
                      <Plus className="h-3 w-3" />
                      Add at {hasRange ? 'range start' : 'playhead'} ({dropTime.toFixed(1)}s)
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
      </div>
    </>
  )
}
