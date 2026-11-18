import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Check, Circle, Download, Loader2, MoreHorizontal, Music, Pause, Pencil, Play, Trash2, Upload } from 'lucide-react'
import {
  SONG_PART_KINDS, describeSongParts, findLineAt, formatClock, formatClockTenths, formatSrtLines,
  guessSongParts, joinPartWithAbove, normalizeSongParts, parseClockInput, parseSrtLines, readLyricFile,
  removeLine, setLineStart, setLineText, setPartKind, shiftAllLines, startPartAtLine,
} from '../../utils/songLyricMap.mjs'
import { getAbsoluteFileUrl, getProjectFileUrl } from '../../services/fileSystem'
import { useProjectStore } from '../../stores/projectStore'
import { firstListenFor, useSongListen, writeSongListen } from '../../services/songListenState.mjs'

// First step of the music video: bring a song, then check that the lyrics
// land where they are sung and that the parts (verse, chorus, ...) are right.
//
// The lyrics live in the parent as an SRT string (`lyrics`), which is what the
// Director plan reads. The parts and the "check this one" marks live beside
// them in `songMap` ({ parts, unsure, assetId }), saved with the project.
// `assetId` records which song the lyrics belong to.
//
// When a song has no lyrics yet, Velorn listens to it (electron/songMapEngine)
// and fills them in. Where listening is not set up, or it fails, the lyrics
// can still come from a file ("Use a lyrics file").

const NUDGE_SECONDS = 0.1
const PART_STYLE = {
  verse: { label: 'Verse', bar: 'bg-teal-400/60', dot: 'bg-teal-400' },
  chorus: { label: 'Chorus', bar: 'bg-violet-400/70', dot: 'bg-violet-400' },
  bridge: { label: 'Bridge', bar: 'bg-amber-400/70', dot: 'bg-amber-400' },
  intro: { label: 'Intro', bar: 'bg-sky-400/60', dot: 'bg-sky-400' },
  outro: { label: 'Outro', bar: 'bg-rose-400/60', dot: 'bg-rose-400' },
}
const LISTEN_STEPS = [
  { id: 'voice', label: 'Finding the voice' },
  { id: 'words', label: 'Hearing the words' },
  { id: 'timing', label: 'Lining them up' },
]
const smallButton = 'rounded-md border border-sf-dark-600 px-2 py-1 text-[11px] text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary'

const downloadSize = (bytes) => {
  const gb = Number(bytes) / 1e9
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(Number(bytes) / 1e6))} MB`
}

export default function SongStep({
  audioAsset = null,
  audioAssets = [],
  onSelectAudioAsset,
  onImportAudio,
  importing = false,
  lyrics = '',
  onLyricsChange,
  songMap = null,
  onSongMapChange,
  onDone,
  shapePicker = null,
}) {
  const audioRef = useRef(null)
  const fileInputRef = useRef(null)
  const lineRefs = useRef([])
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [fileError, setFileError] = useState('')
  const [selectedLine, setSelectedLine] = useState(-1)
  const [timeText, setTimeText] = useState('')
  const [editLine, setEditLine] = useState(-1)
  const [editText, setEditText] = useState('')
  const [shifted, setShifted] = useState(0)
  const [moreForLine, setMoreForLine] = useState(false)
  const [shiftOpen, setShiftOpen] = useState(false)
  const [songUrl, setSongUrl] = useState('')
  const [playError, setPlayError] = useState('')
  const projectHandle = useProjectStore((state) => state.currentProjectHandle)
  // idle | listening | unavailable | error
  // Remembered outside this screen, so leaving for another step and coming
  // back shows the listening still going (see songListenState.mjs).
  const listen = useSongListen(audioAsset?.id || '')
  const setListen = useCallback((next) => writeSongListen(audioAsset?.id || '', next), [audioAsset?.id])
  // Getting the listening tools onto this computer, when they are not there yet.
  const [setup, setSetup] = useState({ canInstall: false, bytes: 0, installing: false, step: '', doneBytes: 0, totalBytes: 0, error: '' })
  const lastSongId = useRef(audioAsset?.id || '')
  // True from the moment the user asks for a song here until it arrives.
  const pickingSong = useRef(false)

  // Lyrics known to belong to another song are never shown, not even for the
  // moment before they are cleared.
  const lyricsAreForAnotherSong = Boolean(songMap?.assetId && audioAsset?.id && songMap.assetId !== audioAsset.id)
  const lines = useMemo(() => (lyricsAreForAnotherSong ? [] : parseSrtLines(lyrics)), [lyrics, lyricsAreForAnotherSong])
  const parts = useMemo(
    () => normalizeSongParts(songMap?.parts, lines.length) || guessSongParts(lines),
    [songMap?.parts, lines]
  )
  const described = useMemo(() => describeSongParts(lines, parts), [lines, parts])
  const unsure = useMemo(
    () => (Array.isArray(songMap?.unsure) ? songMap.unsure.filter((index) => Number.isInteger(index) && index >= 0 && index < lines.length) : []),
    [songMap?.unsure, lines.length]
  )
  const songLength = duration || Number(audioAsset?.duration) || Number(audioAsset?.settings?.duration) || (lines.length ? lines[lines.length - 1].end : 0)
  const currentLine = findLineAt(lines, time)
  const selected = selectedLine >= 0 && selectedLine < lines.length ? selectedLine : -1
  const selectedStart = selected >= 0 ? lines[selected].start : null

  // A song picked through the file dialog has no address until the project is
  // reopened, so work one out from where the file sits.
  useEffect(() => {
    let cancelled = false
    setPlayError('')
    setSongUrl(audioAsset?.url || '')
    if (audioAsset && !audioAsset.url) {
      const lookup = audioAsset.absolutePath
        ? getAbsoluteFileUrl(audioAsset.absolutePath)
        : audioAsset.path && projectHandle ? getProjectFileUrl(projectHandle, audioAsset.path) : Promise.resolve('')
      Promise.resolve(lookup)
        .then((url) => { if (!cancelled) { setSongUrl(url || ''); if (!url) setPlayError('Velorn could not find this song file.') } })
        .catch(() => { if (!cancelled) setPlayError('Velorn could not find this song file.') })
    }
    return () => { cancelled = true }
  }, [audioAsset?.id, audioAsset?.url, audioAsset?.absolutePath, audioAsset?.path, projectHandle])
  useEffect(() => { setPlaying(false); setTime(0); setDuration(0) }, [songUrl])
  useEffect(() => { setSelectedLine(-1); setEditLine(-1); setShifted(0) }, [audioAsset?.id])
  useEffect(() => { setTimeText(selectedStart === null ? '' : formatClockTenths(selectedStart)) }, [selected, selectedStart])
  useEffect(() => {
    if (playing) lineRefs.current[currentLine]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [currentLine, playing])

  const commitLines = useCallback((nextLines) => { onLyricsChange?.(formatSrtLines(nextLines)) }, [onLyricsChange])
  const commitMap = useCallback((next) => { onSongMapChange?.({ parts, unsure, assetId: audioAsset?.id || null, ...next }) }, [audioAsset?.id, onSongMapChange, parts, unsure])
  const clearUnsure = (index) => (unsure.includes(index) ? { unsure: unsure.filter((entry) => entry !== index) } : null)

  const togglePlay = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) audio.play().catch(() => { setPlayError('This song could not be played.') })
    else audio.pause()
  }
  const seek = (seconds) => {
    const audio = audioRef.current
    const target = Math.max(0, Math.min(seconds, songLength || seconds))
    if (audio) audio.currentTime = target
    setTime(target)
  }
  const handleStripClick = (event) => {
    if (!songLength) return
    const box = event.currentTarget.getBoundingClientRect()
    seek(((event.clientX - box.left) / box.width) * songLength)
  }

  // Clicking a line picks it and moves the playhead there. It does not start
  // the song; the play button does that.
  const selectLine = (index) => { setSelectedLine(index); setMoreForLine(false); seek(lines[index].start) }
  const showFirstUnsure = () => {
    const index = unsure[0]
    if (index === undefined) return
    selectLine(index)
    lineRefs.current[index]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const moveLine = (index, seconds) => {
    const next = setLineStart(lines, index, seconds)
    commitLines(next)
    const cleared = clearUnsure(index)
    if (cleared) commitMap(cleared)
    seek(next[index].start)
  }
  const commitTimeText = () => {
    if (selected < 0) return
    const seconds = parseClockInput(timeText)
    if (seconds === null) { setTimeText(formatClockTenths(lines[selected].start)); return }
    moveLine(selected, seconds)
  }

  const handleNudgeAll = (direction) => {
    const delta = direction * NUDGE_SECONDS
    commitLines(shiftAllLines(lines, delta))
    setShifted((value) => Math.round((value + delta) * 10) / 10)
  }

  const deleteLine = (index) => {
    const next = removeLine(lines, parts, unsure, index)
    commitLines(next.lines)
    onSongMapChange?.({ parts: next.parts, unsure: next.unsure, assetId: audioAsset?.id || null })
    setSelectedLine(-1)
    setEditLine(-1)
  }

  const startEdit = (index) => { setEditLine(index); setEditText(lines[index].text) }
  const finishEdit = (save) => {
    if (save && editLine >= 0) commitLines(setLineText(lines, editLine, editText))
    setEditLine(-1)
  }

  const handleLyricFile = async (file) => {
    if (!file) return
    setFileError('')
    try {
      const result = readLyricFile(await file.text())
      if (result.error) { setFileError(result.error); return }
      commitLines(result.lines)
      onSongMapChange?.({ parts: guessSongParts(result.lines), unsure: result.unsure, assetId: audioAsset?.id || null })
      setShifted(0)
      setSelectedLine(-1)
    } catch {
      setFileError('This file could not be read.')
    }
  }

  const startListening = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!audioAsset || !api?.songMapAnalyze) { setListen({ status: 'unavailable', step: 'voice', percent: 0, error: '' }); return }
    setFileError('')
    setListen({ status: 'listening', step: 'voice', percent: 0, error: '' })
    try {
      const ready = await api.songMapStatus()
      if (!ready?.ready) {
        setSetup((current) => ({ ...current, canInstall: ready?.canInstall === true, bytes: Number(ready?.downloadBytes) || 0 }))
        setListen({ status: 'unavailable', step: 'voice', percent: 0, error: '' })
        return
      }
      const inputPath = audioAsset.absolutePath
        || (audioAsset.path && typeof projectHandle === 'string' ? await api.pathJoin(projectHandle, audioAsset.path) : '')
      const result = await api.songMapAnalyze({ inputPath })
      if (!result?.success) {
        setListen({ status: result?.code === 'SONG_MAP_CANCELLED' ? 'idle' : 'error', step: 'voice', percent: 0, error: result?.error || 'Listening did not finish.' })
        return
      }
      const heard = readLyricFile(JSON.stringify({ rows: result.lines || [] }))
      if (heard.error) { setListen({ status: 'error', step: 'voice', percent: 0, error: 'Velorn could not hear any lyrics in this song.' }); return }
      onLyricsChange?.(formatSrtLines(heard.lines))
      onSongMapChange?.({ parts: guessSongParts(heard.lines), unsure: heard.unsure, assetId: audioAsset.id })
      setShifted(0)
      setSelectedLine(-1)
      setListen({ status: 'idle', step: 'voice', percent: 0, error: '' })
    } catch (error) {
      setListen({ status: 'error', step: 'voice', percent: 0, error: error?.message || 'Listening did not finish.' })
    }
  }, [audioAsset, onLyricsChange, onSongMapChange, projectHandle, setListen])

  // Downloads the listening tools, then listens straight away.
  const installListening = useCallback(async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI : null
    if (!api?.songMapInstall) return
    setSetup((current) => ({ ...current, installing: true, step: 'speech', doneBytes: 0, totalBytes: 0, error: '' }))
    let result = null
    try { result = await api.songMapInstall() } catch (error) { result = { success: false, error: error?.message } }
    if (!result?.success) {
      setSetup((current) => ({ ...current, installing: false, error: result?.error || 'The download did not finish.' }))
      return
    }
    setSetup((current) => ({ ...current, installing: false, canInstall: false, error: '' }))
    void startListening()
  }, [startListening])

  useEffect(() => {
    const subscribe = typeof window !== 'undefined' ? window.electronAPI?.onSongMapInstallProgress : null
    if (!subscribe) return undefined
    return subscribe((update) => {
      setSetup((current) => (current.installing
        ? { ...current, step: update?.step || current.step, doneBytes: Number(update?.doneBytes) || 0, totalBytes: Number(update?.totalBytes) || 0 }
        : current))
    })
  }, [])

  // Progress from the engine while it listens.
  useEffect(() => {
    const subscribe = typeof window !== 'undefined' ? window.electronAPI?.onSongMapProgress : null
    if (!subscribe) return undefined
    return subscribe((update) => {
      setListen((current) => (current.status === 'listening' ? { ...current, step: update?.step || current.step, percent: Number(update?.percent) || 0 } : current))
    })
  }, [setListen])

  // A different song starts clean: the lyrics and parts on screen belong to
  // the song before it. (Lyrics are kept per project, not per song.) They are
  // cleared when they are known to belong to another song, or when the user
  // has just chosen a song on this screen. A song that merely finishes loading
  // when the project opens is left alone.
  useEffect(() => {
    const id = audioAsset?.id || ''
    if (!id || id === lastSongId.current) return
    lastSongId.current = id
    const owner = songMap?.assetId || ''
    const chosenHere = pickingSong.current
    pickingSong.current = false
    if (!String(lyrics || '').trim() || (owner ? owner === id : !chosenHere)) return
    onLyricsChange?.('')
    onSongMapChange?.(null)
    setListen({ status: 'idle', step: 'voice', percent: 0, error: '' })
    // Only a change of song should run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioAsset?.id])

  // A song with no lyrics yet: listen to it once, without being asked.
  useEffect(() => {
    if (!audioAsset?.id || lines.length > 0 || listen.status !== 'idle' || !firstListenFor(audioAsset.id)) return
    void startListening()
  }, [audioAsset?.id, lines.length, listen.status, startListening])

  const stopListening = () => { void window.electronAPI?.songMapCancel?.() }
  const listenAgain = () => {
    if (lines.length > 0 && !window.confirm('Listen to the song again? This replaces the lyrics and parts you have now.')) return
    void startListening()
  }

  const handleDrop = (event) => {
    event.preventDefault()
    setDragOver(false)
    const file = event.dataTransfer?.files?.[0]
    if (file) { pickingSong.current = true; onImportAudio?.(file) }
  }

  const lyricFileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".srt,.json,.txt"
      className="hidden"
      onChange={(event) => { void handleLyricFile(event.target.files?.[0]); event.target.value = '' }}
    />
  )
  const shapeRow = shapePicker && (
    <div className="mt-5 flex items-center justify-center gap-3 text-xs text-sf-text-secondary">
      <span>Shape of the video</span>
      {shapePicker}
    </div>
  )

  // 1. No song yet.
  if (!audioAsset) {
    return (
      <div className="mx-auto max-w-2xl">
        <button
          type="button"
          onClick={() => { pickingSong.current = true; onImportAudio?.() }}
          onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          disabled={importing}
          className={`flex w-full flex-col items-center rounded-xl border border-dashed px-6 py-10 text-center transition-colors ${
            dragOver ? 'border-sf-accent bg-sf-accent/10' : 'border-sf-dark-500 bg-sf-dark-900/60 hover:border-sf-accent/70'
          }`}
        >
          <Music className="h-7 w-7 text-sf-text-secondary" />
          <span className="mt-3 text-base font-semibold text-sf-text-primary">{importing ? 'Adding your song…' : 'Drop your song here'}</span>
          <span className="mt-1 text-xs text-sf-text-muted">or click to choose a file</span>
        </button>
        {audioAssets.length > 0 && (
          <div className="mt-4 flex items-center gap-2 text-xs text-sf-text-secondary">
            <span>Or use a song already in this project</span>
            <select
              value=""
              onChange={(event) => { pickingSong.current = true; onSelectAudioAsset?.(event.target.value || null) }}
              className="min-w-0 flex-1 rounded-lg border border-sf-dark-600 bg-sf-dark-950 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
            >
              <option value="">Choose a song</option>
              {audioAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name || asset.id}</option>)}
            </select>
          </div>
        )}
        {shapeRow}
      </div>
    )
  }

  const songHeader = (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
        className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-sf-accent text-white transition-colors hover:bg-sf-accent-hover"
      >
        {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-sf-text-primary">{audioAsset.name || 'Your song'}</div>
        <div className="text-xs text-sf-text-muted">
          {songLength ? formatClock(songLength) : ''}
          {lines.length > 0 && listen.status !== 'listening' && ` · ${lines.length} lines`}
        </div>
      </div>
      <div className="text-xs tabular-nums text-sf-text-secondary">{formatClock(time)}</div>
      {shapePicker}
      {playError && <span className="text-xs text-sf-error">{playError}</span>}
      <button type="button" onClick={() => { lastSongId.current = ''; onSelectAudioAsset?.(null) }} className="text-xs text-sf-text-muted hover:text-sf-text-primary">
        Change song
      </button>
      <audio
        ref={audioRef}
        src={songUrl || undefined}
        onError={() => { if (songUrl) setPlayError('This song could not be played.') }}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
      />
    </div>
  )

  // 2a. Listening to the song.
  if (listen.status === 'listening') {
    const activeIndex = Math.max(0, LISTEN_STEPS.findIndex((entry) => entry.id === listen.step))
    return (
      <div className="mx-auto max-w-2xl">
        {songHeader}
        <div className="mt-5 rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-5">
          <div className="text-sm font-semibold text-sf-text-primary">Listening to your song</div>
          <p className="mt-1 text-xs leading-5 text-sf-text-secondary">This part takes a while: about as long as the song itself, sometimes a little longer. You can look at the other steps while you wait.</p>
          <div className="mt-4 space-y-2">
            {LISTEN_STEPS.map((entry, index) => (
              <div key={entry.id} className={`flex items-center gap-2 text-sm ${index > activeIndex ? 'text-sf-text-muted' : 'text-sf-text-primary'}`}>
                {index < activeIndex
                  ? <Check className="h-4 w-4 text-green-400" />
                  : index === activeIndex ? <Loader2 className="h-4 w-4 animate-spin text-sf-accent" /> : <Circle className="h-4 w-4" />}
                <span>{entry.label}{index === activeIndex ? '…' : ''}</span>
                {index === activeIndex && <span className="text-xs tabular-nums text-sf-text-muted">{Math.round(listen.percent)}%</span>}
              </div>
            ))}
          </div>
          <div className="mt-4 h-1 overflow-hidden rounded bg-sf-dark-800">
            <div className="h-1 bg-sf-accent transition-all" style={{ width: `${Math.min(100, ((activeIndex + listen.percent / 100) / LISTEN_STEPS.length) * 100)}%` }} />
          </div>
          <button type="button" onClick={stopListening} className="mt-4 text-xs text-sf-text-muted hover:text-sf-text-primary">Stop</button>
        </div>
      </div>
    )
  }

  // 2b. Song chosen, no timed lyrics, and listening is not running.
  if (lines.length === 0) {
    const cannotListen = listen.status === 'unavailable'
    return (
      <div className="mx-auto max-w-2xl">
        {songHeader}
        <div className="mt-5 rounded-xl border border-sf-dark-700 bg-sf-dark-900/60 p-5">
          <div className="text-sm font-semibold text-sf-text-primary">Now the lyrics</div>
          <p className="mt-1 text-xs leading-5 text-sf-text-secondary">
            {listen.status === 'error'
              ? listen.error
              : cannotListen && setup.canInstall
                ? `Velorn can listen to the song and write the lyrics down. It needs to download its listening tools once${setup.bytes > 0 ? ` (${downloadSize(setup.bytes)})` : ''}. After that it works offline and is free. Or you can bring the lyrics as a file with timings.`
                : cannotListen
                  ? 'Listening is not set up on this computer yet. You can bring the lyrics as a file with timings.'
                  : 'Velorn can listen to the song and write the lyrics down, or you can bring them as a file with timings.'}
          </p>
          {setup.installing && (
            <div className="mt-3" role="status">
              <div className="flex items-center justify-between text-xs text-sf-text-secondary">
                <span className="inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />{setup.step === 'song' ? 'Downloading the listening tools' : 'Downloading the speech model'}</span>
                {setup.totalBytes > 0 && <span>{downloadSize(setup.doneBytes)} of {downloadSize(setup.totalBytes)}</span>}
              </div>
              {setup.totalBytes > 0 && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sf-dark-800">
                  <div className="h-full rounded-full bg-sf-accent transition-all" style={{ width: `${Math.min(100, Math.round((setup.doneBytes / setup.totalBytes) * 100))}%` }} />
                </div>
              )}
              <p className="mt-2 text-[11px] text-sf-text-muted">Keep Velorn open until it finishes.</p>
            </div>
          )}
          {setup.error && !setup.installing && <p className="mt-3 text-xs text-sf-error">{setup.error}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {cannotListen && setup.canInstall && !setup.installing && (
              <button
                type="button"
                onClick={() => { void installListening() }}
                className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover"
              >
                <Download className="h-3.5 w-3.5" />
                {setup.error ? 'Try the download again' : `Download${setup.bytes > 0 ? ` ${downloadSize(setup.bytes)}` : ''}`}
              </button>
            )}
            {!cannotListen && (
              <button
                type="button"
                onClick={() => { void startListening() }}
                className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover"
              >
                <Music className="h-3.5 w-3.5" />
                {listen.status === 'error' ? 'Try again' : 'Listen to the song'}
              </button>
            )}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={cannotListen && !setup.canInstall
                ? 'inline-flex items-center gap-2 rounded-lg bg-sf-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover'
                : 'inline-flex items-center gap-2 rounded-lg border border-sf-dark-600 px-4 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary'}
            >
              <Upload className="h-3.5 w-3.5" />
              Use a lyrics file
            </button>
          </div>
          {fileError && <p className="mt-3 text-xs text-sf-error">{fileError}</p>}
        </div>
        {lyricFileInput}
      </div>
    )
  }

  // 3. Check the lyrics.
  const kindsShown = SONG_PART_KINDS.filter((kind) => parts.some((part) => part.kind === kind))
  const partStartingAt = new Map(described.map((part, index) => [part.firstLine, index]))

  return (
    <div className="mx-auto max-w-3xl">
      {/* The player and song strip stay under the Director's fixed heading. */}
      <div className="sticky z-[6] -mt-2 bg-sf-dark-950 pb-2 pt-2" style={{ top: 'calc(var(--dh-top, 0px) - 1px)' }}>
      {songHeader}

      <div
        role="slider"
        tabIndex={0}
        aria-label="Song position"
        aria-valuemin={0}
        aria-valuemax={Math.round(songLength)}
        aria-valuenow={Math.round(time)}
        onClick={handleStripClick}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') seek(time - 5)
          if (event.key === 'ArrowRight') seek(time + 5)
        }}
        className="relative mt-4 h-7 cursor-pointer overflow-hidden rounded-md bg-sf-dark-800"
      >
        {songLength > 0 && described.map((part) => (
          <div
            key={`part-${part.firstLine}`}
            title={part.label}
            className={`absolute inset-y-0 border-l border-sf-dark-950/60 ${PART_STYLE[part.kind].bar}`}
            style={{ left: `${(part.start / songLength) * 100}%`, width: `${Math.max(0.3, ((part.end - part.start) / songLength) * 100)}%` }}
          />
        ))}
        {songLength > 0 && unsure.map((index) => (
          <div key={`unsure-${index}`} className="absolute inset-y-0 w-1 bg-yellow-400" style={{ left: `${(lines[index].start / songLength) * 100}%` }} />
        ))}
        {songLength > 0 && <div className="absolute inset-y-0 w-0.5 bg-white" style={{ left: `${Math.min(100, (time / songLength) * 100)}%` }} />}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-4 text-[11px] text-sf-text-muted">
        {kindsShown.map((kind) => (
          <span key={kind}><span className={`mr-1 inline-block h-2.5 w-2.5 rounded-sm align-[-1px] ${PART_STYLE[kind].bar}`} />{PART_STYLE[kind].label}</span>
        ))}
        <span><span className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-sf-dark-800 align-[-1px] ring-1 ring-sf-dark-500" />No voice</span>
      </div>

      </div>
      {/* Why this step matters, said once, whether or not Velorn is unsure. */}
      <p className="mt-4 text-xs leading-5 text-sf-text-secondary">
        <span className="font-semibold text-sf-text-primary">Check the words and the parts.</span>{' '}
        The video is planned from them: each line becomes a shot, and verses and choruses get different looks.
      </p>
      {unsure.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200" role="status">
          <span>Velorn wasn't sure about {unsure.length} {unsure.length === 1 ? 'line' : 'lines'}.</span>
          <button type="button" onClick={showFirstUnsure} className={`${smallButton} border-yellow-500/50 text-yellow-200`}>Show me the first one</button>
        </div>
      )}
      <div className="mt-4 space-y-0.5">
        {lines.map((line, index) => {
          const isCurrent = index === currentLine
          const isSelected = index === selected
          const isUnsure = unsure.includes(index)
          const partIndex = partStartingAt.get(index)
          const part = partIndex === undefined ? null : described[partIndex]
          return (
            <div key={`${index}-${line.text}`} ref={(node) => { lineRefs.current[index] = node }} className="scroll-mb-20" style={{ scrollMarginTop: 'calc(var(--dh-top, 0px) + 130px)' }}>
              {part && (
                <div className={`group/part flex items-center gap-2 px-3 pb-1 ${index === 0 ? 'pt-1' : 'pt-4'}`}>
                  <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-sm ${PART_STYLE[part.kind].dot}`} />
                  <select
                    value={part.kind}
                    onChange={(event) => commitMap({ parts: setPartKind(parts, partIndex, event.target.value) })}
                    aria-label={`What is this part? Now ${part.label}`}
                    className="cursor-pointer rounded border border-transparent bg-transparent py-0.5 pl-0.5 pr-1 text-[11px] font-semibold uppercase tracking-wide text-sf-text-primary outline-none hover:border-sf-dark-600 focus:border-sf-accent"
                  >
                    {SONG_PART_KINDS.map((kind) => <option key={kind} value={kind} className="bg-sf-dark-900 normal-case">{PART_STYLE[kind].label}</option>)}
                  </select>
                  {part.label !== PART_STYLE[part.kind].label && (
                    <span className="-ml-1 text-[11px] font-semibold text-sf-text-primary">{part.label.split(' ').pop()}</span>
                  )}
                  <span className="text-[11px] tabular-nums text-sf-text-muted">{formatClock(part.start)}</span>
                  {partIndex > 0 && (
                    <button
                      type="button"
                      onClick={() => commitMap({ parts: joinPartWithAbove(parts, partIndex) })}
                      className="text-[11px] text-sf-text-muted opacity-0 transition-opacity hover:text-sf-text-primary focus:opacity-100 group-hover/part:opacity-100"
                    >
                      Join with the part above
                    </button>
                  )}
                </div>
              )}
              <div
                className={`rounded-lg px-3 transition-colors ${
                  isSelected ? 'bg-sf-dark-800 py-2 ring-1 ring-sf-accent/60' : isCurrent ? 'bg-sf-accent/20 py-2' : isUnsure ? 'bg-yellow-500/10 py-1.5' : 'py-1.5 hover:bg-sf-dark-800/70'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="w-10 flex-shrink-0 text-[11px] tabular-nums text-sf-text-muted">{formatClock(line.start)}</span>
                  {editLine === index ? (
                    <input
                      autoFocus
                      value={editText}
                      onChange={(event) => setEditText(event.target.value)}
                      onBlur={() => finishEdit(true)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') finishEdit(true)
                        if (event.key === 'Escape') finishEdit(false)
                      }}
                      className="min-w-0 flex-1 rounded border border-sf-accent bg-sf-dark-950 px-2 py-1 text-sm text-sf-text-primary outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => selectLine(index)}
                      className={`min-w-0 flex-1 text-left ${isCurrent ? 'text-base font-semibold text-sf-text-primary' : isUnsure ? 'text-sm text-yellow-200' : isSelected ? 'text-sm text-sf-text-primary' : 'text-sm text-sf-text-secondary'}`}
                    >
                      {line.text}
                    </button>
                  )}
                  {isUnsure && (
                    <span className="flex flex-shrink-0 items-center gap-1 text-[11px] text-yellow-300">
                      <AlertCircle className="h-3 w-3" />
                      Check this one
                    </span>
                  )}
                </div>
                {isSelected && editLine !== index && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 pl-12">
                    <button type="button" onClick={() => startEdit(index)} className={`${smallButton} inline-flex items-center gap-1`}>
                      <Pencil className="h-3 w-3" />
                      Fix the words
                    </button>
                    <button type="button" onClick={() => moveLine(index, line.start - NUDGE_SECONDS)} className={smallButton}>Earlier</button>
                    <button type="button" onClick={() => moveLine(index, line.start + NUDGE_SECONDS)} className={smallButton}>Later</button>
                    {isUnsure && (
                      <button type="button" onClick={() => commitMap(clearUnsure(index))} className={`${smallButton} inline-flex items-center gap-1 border-yellow-500/50 text-yellow-200`}>
                        <Check className="h-3 w-3" />
                        This line is fine
                      </button>
                    )}
                    <button type="button" onClick={() => setMoreForLine((open) => !open)} aria-expanded={moreForLine} aria-label="More for this line" className={smallButton}>
                      <MoreHorizontal className="h-3 w-3" />
                    </button>
                    {moreForLine && (
                      <>
                        <span className="text-[11px] text-sf-text-muted">Starts at</span>
                        <input
                          value={timeText}
                          onChange={(event) => setTimeText(event.target.value)}
                          onBlur={commitTimeText}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') { event.preventDefault(); commitTimeText() }
                            if (event.key === 'Escape') setTimeText(formatClockTenths(line.start))
                          }}
                          aria-label="Start time of this line"
                          className="w-16 rounded border border-sf-dark-600 bg-sf-dark-950 px-2 py-1 text-center text-[11px] tabular-nums text-sf-text-primary outline-none focus:border-sf-accent"
                        />
                        {index > 0 && partIndex === undefined && (
                          <button type="button" onClick={() => commitMap({ parts: startPartAtLine(parts, index) })} className={smallButton}>New part starts here</button>
                        )}
                        <button type="button" onClick={() => deleteLine(index)} className={`${smallButton} inline-flex items-center gap-1`}>
                          <Trash2 className="h-3 w-3" />
                          Remove this line
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="sticky bottom-0 z-[5] mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-sf-dark-700 bg-sf-dark-950 py-3 text-[11px] text-sf-text-muted">
        <button type="button" onClick={listenAgain} className="hover:text-sf-text-primary">Listen to the song again</button>
        <button type="button" onClick={() => fileInputRef.current?.click()} className="hover:text-sf-text-primary">Use a lyrics file</button>
        <button type="button" onClick={() => setShiftOpen((open) => !open)} aria-expanded={shiftOpen} className="hover:text-sf-text-primary">Shift all lyrics</button>
        {shiftOpen && (
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => handleNudgeAll(-1)} className={smallButton}>Earlier</button>
            <button type="button" onClick={() => handleNudgeAll(1)} className={smallButton}>Later</button>
            {shifted !== 0 && <span className="tabular-nums">{shifted > 0 ? '+' : ''}{shifted.toFixed(1)} s</span>}
          </span>
        )}
        <span className="flex-1" />
        <button type="button" onClick={() => onDone?.()} className="rounded-lg bg-sf-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover">
          Looks good
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-sf-text-muted">
        {fileError && <span className="text-sf-error">{fileError}</span>}
        {listen.status === 'error' && <span className="text-sf-error">Listening did not finish: {listen.error}</span>}
        {listen.status === 'unavailable' && <span className="text-sf-error">Listening is not set up on this computer yet.</span>}
      </div>
      {lyricFileInput}
    </div>
  )
}
