import { useEffect, useMemo, useRef, useState } from 'react'
import { Sparkles, Loader2, Workflow } from 'lucide-react'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { useFrameForAIStore } from '../stores/frameForAIStore'
import { comfyui } from '../services/comfyui'
import { importAsset, isElectron, getAbsoluteFileUrl } from '../services/fileSystem'
import {
  BUNDLED_FLF2V_PROFILES,
  loadSelectedProfileId,
  saveSelectedProfileId,
} from '../services/builtinWorkflows/flf2vProfiles'
import Flf2vWorkflowPicker from './Flf2vWorkflowPicker'

const NEGATIVE_PROMPT_DEFAULT =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'

const DEFAULT_PROMPT =
  'Smooth transition between the first and last frame, cinematic motion, consistent subject and style'

const POLL_INTERVAL_MS = 2000
const MAX_POLL_SECONDS = 60 * 15 // 15 min cap so we never loop forever

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function randomSeed() {
  return Math.floor(Math.random() * 1e13)
}

/**
 * Fill Gap (FLF2V) action card.
 *
 * Self-contained — does NOT go through the catalog / workflow browser.
 * Takes the currently-selected FLF2V workflow profile (bundled or user-
 * imported JSON), mutates inputs in-memory with the captured start/end
 * frames + user-chosen duration/fps/resolution + prompt, uploads the
 * frames to ComfyUI, queues the prompt, polls for completion, then
 * imports the resulting video into the project and splices it back into
 * the original timeline gap.
 *
 * Workflow selection is persisted to localStorage so reopening the app
 * keeps the same workflow.
 */
export default function Flf2vDraftCard({
  frameForAI,
  timelineFps,
  currentResolution,
  onClear,
}) {
  const projectFps = Number.isFinite(Number(timelineFps)) && Number(timelineFps) > 0
    ? Number(timelineFps)
    : 24
  const projectWidth = Number(currentResolution?.width) || 1280
  const projectHeight = Number(currentResolution?.height) || 720
  const gapDuration = Math.max(0, Number(frameForAI?.targetDurationSeconds) || 0)

  // Form state — defaults come from the project (resolution / fps / gap
  // duration). User can override any of them before queuing.
  const [width, setWidth] = useState(alignDim(projectWidth))
  const [height, setHeight] = useState(alignDim(projectHeight))
  const [fps, setFps] = useState(projectFps)
  const [duration, setDuration] = useState(round2(gapDuration || 2.5))
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [negativePrompt, setNegativePrompt] = useState(NEGATIVE_PROMPT_DEFAULT)
  const [seed, setSeed] = useState(() => randomSeed())
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState(null) // 'uploading' | 'queued' | 'running' | 'saving' | 'done' | 'error'
  const [errorMessage, setErrorMessage] = useState(null)
  const [progressPct, setProgressPct] = useState(0)
  const [lastResult, setLastResult] = useState(null) // { assetId, filename } so the user can see what was just made

  // Profile state — selected workflow + optional imported one + picker open.
  const [activeProfile, setActiveProfile] = useState(() => resolveInitialProfile())
  const [importedProfile, setImportedProfile] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const workflowBtnRef = useRef(null)

  const assetsStore = useAssetsStore()
  const timelineStore = useTimelineStore()
  const clearFrameForAI = useFrameForAIStore((s) => s.clearFrame)

  const promptIdRef = useRef(null)
  const pollStopRef = useRef(false)

  const previewStartUrl = frameForAI?.startFrame?.blobUrl || null
  const previewEndUrl = frameForAI?.endFrame?.blobUrl || null

  useEffect(() => () => {
    pollStopRef.current = true
  }, [])

  function handleSelectProfile(profile) {
    setActiveProfile(profile)
    if (profile.id.startsWith('imported:')) {
      setImportedProfile(profile)
      saveSelectedProfileId({ kind: 'imported', profile })
    } else {
      saveSelectedProfileId({ kind: 'bundled', id: profile.id })
    }
  }

  // Wan length = N*4 + 1, computed from the form's duration × fps.
  const length = snapWanLength(Math.max(1, Math.round(duration * fps) + 1))

  const mutation = activeProfile?.mutation
  const canQueue = useMemo(() => {
    if (busy) return false
    if (!previewStartUrl || !previewEndUrl) return false
    if (!frameForAI?.startFrame?.file || !frameForAI?.endFrame?.file) return false
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false
    if (width < 64 || height < 64) return false
    if (!Number.isFinite(fps) || fps < 1) return false
    if (!Number.isFinite(duration) || duration <= 0) return false
    if (!mutation?.setStartImage || !mutation?.setEndImage) return false
    return true
  }, [busy, previewStartUrl, previewEndUrl, frameForAI, width, height, fps, duration, mutation])

  async function handleQueue() {
    if (!canQueue) return
    setBusy(true)
    setErrorMessage(null)
    setProgressPct(0)
    setLastResult(null)

    try {
      // 1) Upload the two captured frames to ComfyUI's input dir.
      setStage('uploading')
      const [startUpload, endUpload] = await Promise.all([
        comfyui.uploadFile(frameForAI.startFrame.file),
        comfyui.uploadFile(frameForAI.endFrame.file),
      ])
      if (!startUpload?.name || !endUpload?.name) {
        throw new Error('ComfyUI did not return a filename for the uploaded frames')
      }

      // 2) Deep-clone the profile workflow and apply per-job mutations.
      const workflow = deepClone(activeProfile.workflowJson)
      safeCall(mutation?.setStartImage, workflow, startUpload.name)
      safeCall(mutation?.setEndImage,   workflow, endUpload.name)
      safeCall(mutation?.setWidth,      workflow, width)
      safeCall(mutation?.setHeight,     workflow, height)
      safeCall(mutation?.setLength,     workflow, length)
      safeCall(mutation?.setPositivePrompt, workflow, prompt || DEFAULT_PROMPT)
      safeCall(mutation?.setNegativePrompt, workflow, negativePrompt || NEGATIVE_PROMPT_DEFAULT)
      safeCall(mutation?.setFps,        workflow, fps)
      safeCall(mutation?.setSeeds,      workflow, seed)
      safeCall(mutation?.setFilenamePrefix, workflow, `video/gapfill_${Date.now()}`)

      // 3) Queue. comfyui.queuePrompt returns the prompt_id string directly
      //    (NOT an object), so use it as-is — accessing .prompt_id on a
      //    string would always be undefined and silently mask real errors.
      setStage('queued')
      const promptId = await comfyui.queuePrompt(workflow)
      if (!promptId) {
        throw new Error('ComfyUI did not return a prompt_id')
      }
      promptIdRef.current = promptId

      // 4) Poll for completion.
      setStage('running')
      pollStopRef.current = false
      const start = Date.now()
      while (!pollStopRef.current) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        if (Date.now() - start > MAX_POLL_SECONDS * 1000) {
          throw new Error('Generation timed out')
        }
        const history = await fetchHistory(promptId)
        if (history?.outputs && Object.keys(history.outputs).length > 0) {
          const videos = collectVideoOutputs(history.outputs)
          if (videos.length === 0) {
            throw new Error('ComfyUI finished but produced no videos')
          }
          const picked = pickBestVideo(videos)
          if (!picked) {
            throw new Error('Could not extract video output from history')
          }
          const result = await spliceResultIntoGap(picked, history.outputs, {
            assetsStore,
            timelineStore,
            frameForAI,
            gapDuration: duration,
            log,
            setStage,
            setProgressPct,
          })
          setStage('done')
          if (result?.assetId) {
            setLastResult({ assetId: result.assetId, filename: result.filename })
          }
          // Switch back to the editor tab so the user lands on the timeline
          // and sees the freshly inserted clip immediately.
          try {
            window.dispatchEvent(new CustomEvent('comfystudio-switch-tab', { detail: { tab: 'editor' } }))
          } catch (_) { /* ignore */ }
          // Intentionally do NOT clear frameForAI here — the user wants the
          // card to stay so they can re-queue with different params if the
          // output is wrong.
          return
        }
        const elapsed = (Date.now() - start) / 1000
        setProgressPct(Math.min(95, 5 + (elapsed / 60) * 90))
      }
    } catch (err) {
      console.error('[FillGap FLF2V] failed:', err)
      setStage('error')
      setErrorMessage(err?.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-4 rounded-lg border border-sf-accent/40 bg-sf-accent/5 min-h-[48rem] relative">
      <div className="flex items-start gap-4">
        <div className="flex gap-1.5 flex-shrink-0">
          <FramePreview url={previewStartUrl} label="Start" />
          <div className="self-center text-sf-text-muted text-xs">→</div>
          <FramePreview url={previewEndUrl} label="End" />
        </div>
        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-medium text-sf-text-primary">
              Fill Gap (FLF2V) — First/Last Frame
            </div>
            <div className="px-2 py-0.5 rounded-full bg-sf-accent/20 text-sf-accent text-[10px] font-medium">
              {duration.toFixed(2)}s · {length} frames @ {fps}fps · {width}×{height}
            </div>
            {stage && (
              <div className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                stage === 'error' ? 'bg-red-500/20 text-red-300'
                : stage === 'done' ? 'bg-green-500/20 text-green-300'
                : 'bg-sf-accent/15 text-sf-accent'
              }`}>
                {stageLabel(stage, progressPct)}
              </div>
            )}
            {lastResult?.filename && (
              <div className="px-2 py-0.5 rounded-full bg-green-500/15 text-green-200 text-[10px]">
                inserted: {lastResult.filename}
              </div>
            )}
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-sf-text-muted">
              Prompt
            </label>
            <textarea
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={busy}
              className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:border-sf-accent outline-none disabled:opacity-50 resize-y"
              placeholder="Describe the motion you'd like between the two frames..."
            />
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-sf-text-muted">
              Negative prompt
            </label>
            <textarea
              rows={3}
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              disabled={busy}
              className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:border-sf-accent outline-none disabled:opacity-50 resize-y"
              placeholder="What to avoid in the generation..."
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Field
              label="Width"
              value={width}
              onChange={setWidth}
              step={16}
              min={64}
              max={2048}
              disabled={busy}
            />
            <Field
              label="Height"
              value={height}
              onChange={setHeight}
              step={16}
              min={64}
              max={2048}
              disabled={busy}
            />
            <Field
              label="Seed"
              value={seed}
              onChange={(v) => setSeed(Number(v) || 0)}
              step={1}
              min={0}
              disabled={busy}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Field
              label="FPS"
              value={fps}
              onChange={setFps}
              step={1}
              min={1}
              max={60}
              disabled={busy}
            />
            <Field
              label="Duration (s)"
              value={duration}
              onChange={setDuration}
              step={0.1}
              min={0.1}
              max={30}
              disabled={busy}
            />
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => {
                  setWidth(alignDim(projectWidth))
                  setHeight(alignDim(projectHeight))
                  setFps(projectFps)
                  setDuration(round2(gapDuration || 2.5))
                }}
                disabled={busy}
                title="Reset form values to project defaults"
                className="w-full px-2 py-1 rounded bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary text-[11px] disabled:opacity-50"
              >
                Use project defaults
              </button>
            </div>
          </div>

          {errorMessage && (
            <div className="px-2 py-1.5 rounded bg-red-500/15 border border-red-500/40 text-[11px] text-red-200">
              {errorMessage}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleQueue}
              disabled={!canQueue}
              className="px-3 py-1.5 rounded bg-sf-accent text-black text-xs font-medium hover:bg-sf-accent/90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
              {busy ? stageLabel(stage, progressPct) : (lastResult ? 'Re-queue' : 'Queue Video')}
            </button>
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className="px-2 py-1 rounded text-[11px] bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary transition-colors disabled:opacity-50"
            >
              Clear
            </button>
            <div className="ml-auto relative">
              <button
                ref={workflowBtnRef}
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                disabled={busy}
                title="Change workflow"
                className="px-2 py-1 rounded text-[11px] bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-muted hover:text-sf-text-primary transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                <Workflow className="w-3 h-3" />
                <span className="max-w-[12rem] truncate">
                  {activeProfile?.label || 'Workflow'}
                </span>
              </button>
              {pickerOpen && (
                <Flf2vWorkflowPicker
                  currentProfileId={activeProfile?.id}
                  importedProfile={importedProfile}
                  onSelect={handleSelectProfile}
                  onClose={() => setPickerOpen(false)}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// --- helpers ---------------------------------------------------------------

function resolveInitialProfile() {
  const stored = loadSelectedProfileId()
  if (stored?.kind === 'bundled' && stored.id) {
    const found = BUNDLED_FLF2V_PROFILES.find((p) => p.id === stored.id)
    if (found) return found
  }
  if (stored?.kind === 'imported' && stored.profile) {
    return stored.profile
  }
  return BUNDLED_FLF2V_PROFILES[0] || null
}

function safeCall(fn, ...args) {
  if (typeof fn === 'function') {
    try { fn(...args) } catch (_) { /* mutation not applicable, skip */ }
  }
}

// Wan needs multiples of 16 for width/height.
function alignDim(n) {
  if (!Number.isFinite(Number(n)) || Number(n) <= 0) return 1280
  return Math.max(64, Math.round(Number(n) / 16) * 16)
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100
}

function FramePreview({ url, label }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="w-24 h-14 rounded overflow-hidden bg-sf-dark-800 border border-sf-dark-600">
        {url ? (
          <img src={url} alt={`${label} frame`} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[10px] text-sf-text-muted">
            no frame
          </div>
        )}
      </div>
      <div className="text-[9px] text-sf-text-muted uppercase tracking-wider">{label}</div>
    </div>
  )
}

function Field({ label, value, onChange, step, min, max, disabled }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wider text-sf-text-muted">
        {label}
      </label>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (!Number.isNaN(n)) onChange(n)
        }}
        className="mt-1 w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:border-sf-accent outline-none disabled:opacity-50"
      />
    </div>
  )
}

function stageLabel(stage, progressPct) {
  if (!stage) return ''
  switch (stage) {
    case 'uploading': return 'Uploading frames…'
    case 'queued': return 'Queueing…'
    case 'running': return `Running… ${Math.round(progressPct || 0)}%`
    case 'saving': return 'Importing result…'
    case 'done': return 'Done'
    case 'error': return 'Error'
    default: return stage
  }
}

// Snap an arbitrary length to the nearest valid WanFirstLastFrameToVideo
// length (N*4 + 1: 1, 5, 9, 13, ..., 81, 85, ...). Non-aligned values
// land on fractional frame indices in the VAE temporal conditioning and
// weaken the start/end frame anchoring.
function snapWanLength(n) {
  const x = Math.max(1, Math.round(Number(n) || 1))
  return Math.max(1, Math.round((x - 1) / 4) * 4 + 1)
}

async function fetchHistory(promptId) {
  try {
    const base = comfyui.getHttpBase?.()
    const root = base || (typeof comfyui.getComfyURL === 'function' ? comfyui.getComfyURL() : 'http://127.0.0.1:8188')
    const r = await fetch(`${root}/history/${encodeURIComponent(promptId)}`)
    if (!r.ok) return null
    const data = await r.json()
    return data?.[promptId] || null
  } catch (_) {
    return null
  }
}

function collectVideoOutputs(outputs) {
  const out = []
  for (const nodeOutputs of Object.values(outputs || {})) {
    if (!nodeOutputs) continue
    // ComfyUI's SaveVideo node (bundled) reports its saved file under the
    // 'images' key with `animated: [true]`. Older nodes (VHS VideoCombine)
    // report under 'videos' / 'gifs'. Handle all.
    const images = nodeOutputs.images || []
    const animated = nodeOutputs.animated || []
    const isAnimated = Array.isArray(animated) && animated[0] === true
    if (isAnimated) {
      for (const v of images) out.push({ kind: 'video', node: nodeOutputs, ...v })
    }
    const videos = nodeOutputs.videos || []
    for (const v of videos) out.push({ kind: 'video', node: nodeOutputs, ...v })
    const gifs = nodeOutputs.gifs || []
    for (const g of gifs) out.push({ kind: 'gif', node: nodeOutputs, ...g })
  }
  return out
}

function pickBestVideo(items) {
  return items.find((it) => it.kind === 'video') || items[0] || null
}

async function spliceResultIntoGap(picked, outputs, ctx) {
  const { assetsStore, timelineStore, frameForAI, gapDuration, setStage } = ctx
  setStage?.('saving')

  const filename = picked?.filename || picked?.name
  const subfolder = picked?.subfolder || picked?.type || 'output'
  if (!filename) throw new Error('No filename on the picked output')

  const blob = await comfyui.downloadVideo(filename, subfolder, 'output')
  const file = new File([blob], filename, { type: blob.type || 'video/mp4' })

  const gap = {
    trackId: frameForAI?.targetTrackId,
    startTime: Number(frameForAI?.targetGapStartTime) || 0,
    endTime: (Number(frameForAI?.targetGapStartTime) || 0) + (Number(frameForAI?.targetDurationSeconds) || 0),
  }

  // Save the file into the project's assets directory so it gets an
  // absolutePath and proper media metadata (duration, width, height, fps).
  // This is what the timeline needs to render thumbnails and to compute
  // the clip duration correctly when inserted.
  const projectHandle = useProjectStore.getState().getProjectHandle?.()
  let newAsset
  if (isElectron() && projectHandle) {
    newAsset = await importAsset(projectHandle, file, 'video')
    // importAsset() doesn't set `url` on the returned asset — only
    // `absolutePath`. addClip() reads `asset.url` for both the clip
    // source and its thumbnail (timelineStore.js), so without this the
    // inserted clip renders blank. Resolve the file:// URL ourselves.
    if (newAsset?.absolutePath && !newAsset.url) {
      try {
        newAsset = { ...newAsset, url: await getAbsoluteFileUrl(newAsset.absolutePath) }
      } catch (err) {
        console.warn('[FillGap FLF2V] could not resolve asset url:', err)
      }
    }
    // The AssetsPanel's normal import path triggers generateAssetPoster /
    // generateAssetSprite after importAsset. Since we're going around it,
    // fire them ourselves so the timeline tile + scrubber thumbnail both
    // appear. Failures are non-fatal — playback works without them.
    if (newAsset?.id) {
      const assetRecord = assetsStore.addAsset?.(newAsset)
      // addAsset returns the stored copy (with id). Use it for downstream calls.
      const stored = assetRecord || newAsset
      try {
        assetsStore.generateAssetPoster?.(stored.id, projectHandle)?.catch((err) => {
          console.warn('[FillGap FLF2V] poster generation failed:', err)
        })
      } catch (_) { /* ignore sync throws */ }
      try {
        assetsStore.generateAssetSprite?.(stored.id, projectHandle)?.catch((err) => {
          console.warn('[FillGap FLF2V] sprite generation failed:', err)
        })
      } catch (_) { /* ignore sync throws */ }
      newAsset = stored
    }
  } else {
    // Web fallback — at minimum register a blob-backed asset so playback
    // still works (preview thumbnail may be missing in non-Electron).
    const blobUrl = URL.createObjectURL(file)
    newAsset = assetsStore.addAsset({
      name: `Gap fill ${new Date().toISOString().slice(11, 19)}.mp4`,
      type: 'video',
      url: blobUrl,
      size: file.size,
      mimeType: file.type || 'video/mp4',
      isImported: false,
      settings: { source: 'gap-fill-flf2v' },
    })
  }

  const timelineFpsNum = Number(timelineStore.timelineFps) || 24
  const tracks = timelineStore.tracks || []
  const targetTrack = tracks.find((t) => t?.id === gap.trackId && t?.type === 'video')
    || tracks.find((t) => t?.type === 'video')
  if (!targetTrack) {
    console.warn('[FillGap FLF2V] no video track to insert into')
    return { assetId: newAsset?.id, filename: newAsset?.name }
  }

  const inserted = timelineStore.addClip(targetTrack.id, newAsset, gap.startTime, timelineFpsNum, {
    enabled: true,
    selectAfterAdd: false,
    resolveOverlaps: true,
  })
  if (!inserted) {
    console.warn('[FillGap FLF2V] addClip returned null')
    return { assetId: newAsset?.id, filename: newAsset?.name }
  }

  // If the generated clip's duration differs from the gap, surface it in
  // the console (the card stays open so the user can re-queue).
  if (typeof newAsset?.duration === 'number' && gapDuration > 0) {
    const diff = Math.abs((newAsset.duration || 0) - gapDuration)
    if (diff > 0.25) {
      console.warn(`[FillGap FLF2V] duration mismatch: gap=${gapDuration.toFixed(2)}s asset=${newAsset.duration.toFixed(2)}s`)
    }
  }

  return { assetId: newAsset?.id, filename: newAsset?.name }
}

function log(level, msg) {
  const fn = level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log'
  console[fn](`[FillGap FLF2V] ${msg}`)
}
