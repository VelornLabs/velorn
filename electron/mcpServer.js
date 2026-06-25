const http = require('http')

const DEFAULT_MCP_PORT = 19790
const MCP_PROTOCOL_VERSION = '2024-11-05'

function safeJsonStringify(value, spacing = 2) {
  try {
    return JSON.stringify(value, null, spacing)
  } catch (error) {
    return JSON.stringify({ error: error?.message || String(error) }, null, spacing)
  }
}

function textResult(value) {
  const text = typeof value === 'string' ? value : safeJsonStringify(value)
  return {
    content: [{ type: 'text', text }],
  }
}

function errorResult(message) {
  return {
    content: [{ type: 'text', text: message || 'Tool failed.' }],
    isError: true,
  }
}

function clampLimit(value, fallback = 100, max = 500) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(max, Math.max(1, Math.floor(parsed)))
}

function hasSnapshot(snapshot) {
  return Boolean(snapshot && snapshot.project)
}

function getSnapshotOrEmpty(snapshot) {
  return snapshot || {
    app: { name: 'ComfyStudio' },
    project: null,
    timelines: [],
    currentTimeline: null,
    assets: [],
    folders: [],
    generatedAt: null,
  }
}

function summarizeAssetCounts(assets = []) {
  return assets.reduce((counts, asset) => {
    const type = asset?.type || 'unknown'
    counts[type] = (counts[type] || 0) + 1
    return counts
  }, {})
}

function summarizeClipCounts(clips = []) {
  return clips.reduce((counts, clip) => {
    const type = clip?.type || 'unknown'
    counts[type] = (counts[type] || 0) + 1
    return counts
  }, {})
}

function summarizeGenerationAssets(assets = []) {
  const activeStates = new Set(['queued', 'generating', 'downloading', 'encoding', 'running'])
  const failedStates = new Set(['failed', 'error'])
  const active = []
  const failed = []
  const generated = []

  for (const asset of assets) {
    const status = String(asset?.generationStatus || asset?.status || '').toLowerCase()
    const yolo = asset?.yolo || asset?.settings?.yolo || null
    const entry = {
      id: asset?.id,
      name: asset?.name,
      type: asset?.type,
      status: status || 'none',
      prompt: asset?.prompt || asset?.settings?.prompt || '',
      workflow: asset?.workflowName || asset?.settings?.workflowName || asset?.workflowId || asset?.settings?.workflowId || '',
      yolo,
      error: asset?.error || asset?.generationError || asset?.settings?.error || '',
      createdAt: asset?.createdAt || asset?.imported || null,
    }
    if (activeStates.has(status)) active.push(entry)
    if (failedStates.has(status) || entry.error) failed.push(entry)
    if (yolo || asset?.prompt || asset?.workflowId || asset?.settings?.workflowId) generated.push(entry)
  }

  return {
    activeCount: active.length,
    failedCount: failed.length,
    generatedCount: generated.length,
    active,
    failed,
    recentGenerated: generated.slice(0, 50),
  }
}

function summarizeMusicVideoWorkflow(snapshot) {
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : []
  const timeline = snapshot?.currentTimeline || null
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : []
  const musicAssets = assets.filter((asset) => {
    const yolo = asset?.yolo || asset?.settings?.yolo
    return yolo?.mode === 'music' || yolo?.workflow === 'music-video' || yolo?.musicVideo
  })

  const byStage = {}
  const byShot = {}
  for (const asset of musicAssets) {
    const yolo = asset?.yolo || asset?.settings?.yolo || {}
    const stage = yolo.stage || asset.type || 'unknown'
    byStage[stage] = (byStage[stage] || 0) + 1
    const shotId = yolo.shotId || yolo.shot_id || yolo.variantKey || ''
    if (shotId) {
      byShot[shotId] = byShot[shotId] || { shotId, assets: 0, stages: {} }
      byShot[shotId].assets += 1
      byShot[shotId].stages[stage] = (byShot[shotId].stages[stage] || 0) + 1
    }
  }

  const assembledClips = clips.filter((clip) => clip?.metadata?.musicVideoAssembly)
  const syncLockedClips = clips.filter((clip) => clip?.lockMode === 'sync' || clip?.syncLock?.mode === 'sync')

  return {
    projectTitle: snapshot?.project?.name || '',
    currentTimeline: timeline ? {
      id: timeline.id,
      name: timeline.name,
      duration: timeline.duration,
      clipCount: clips.length,
    } : null,
    musicAssetCount: musicAssets.length,
    assetsByStage: byStage,
    shots: Object.values(byShot).slice(0, 200),
    assembledClipCount: assembledClips.length,
    syncLockedClipCount: syncLockedClips.length,
  }
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getNumberArg(args, key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(args?.[key])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function roundTime(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.round(parsed * 1000) / 1000
}

function getClipStart(clip) {
  return toFiniteNumber(clip?.startTime, 0)
}

function getClipDuration(clip) {
  return toFiniteNumber(clip?.duration, 0)
}

function getClipEnd(clip) {
  return getClipStart(clip) + getClipDuration(clip)
}

function clipRef(clip) {
  return {
    id: clip?.id,
    name: clip?.name,
    type: clip?.type,
    trackId: clip?.trackId,
    startTime: roundTime(getClipStart(clip)),
    duration: roundTime(getClipDuration(clip)),
    assetId: clip?.assetId || null,
  }
}

function isAssetBackedClip(clip) {
  const type = String(clip?.type || '').toLowerCase()
  return !['adjustment', 'text', 'caption', 'captions', 'marker'].includes(type)
}

function hasNonDefaultTransform(transform = {}) {
  if (!transform || typeof transform !== 'object') return false
  const checks = [
    Math.abs(toFiniteNumber(transform.positionX, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.positionY, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.scaleX, 100) - 100) > 0.001,
    Math.abs(toFiniteNumber(transform.scaleY, 100) - 100) > 0.001,
    Math.abs(toFiniteNumber(transform.rotation, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.opacity, 100) - 100) > 0.001,
    Math.abs(toFiniteNumber(transform.cropTop, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.cropBottom, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.cropLeft, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.cropRight, 0)) > 0.001,
    Math.abs(toFiniteNumber(transform.blur, 0)) > 0.001,
    Boolean(transform.flipH),
    Boolean(transform.flipV),
    Boolean(transform.blendMode && transform.blendMode !== 'normal'),
  ]
  return checks.some(Boolean)
}

function addFinding(findings, finding) {
  findings.push({
    severity: finding.severity || 'info',
    code: finding.code || 'note',
    message: finding.message || '',
    ...finding,
  })
}

function countBy(items = [], getKey) {
  return items.reduce((counts, item) => {
    const key = getKey(item) || 'unknown'
    counts[key] = (counts[key] || 0) + 1
    return counts
  }, {})
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

function joinHumanList(items = []) {
  const cleanItems = items.filter(Boolean)
  if (cleanItems.length === 0) return ''
  if (cleanItems.length === 1) return cleanItems[0]
  if (cleanItems.length === 2) return `${cleanItems[0]} and ${cleanItems[1]}`
  return `${cleanItems.slice(0, -1).join(', ')}, and ${cleanItems[cleanItems.length - 1]}`
}

function describeFindingCodes(findings = [], severity = null) {
  const labels = {
    missing_asset: ['missing asset', 'missing assets'],
    invalid_clip_start: ['invalid clip start', 'invalid clip starts'],
    invalid_clip_duration: ['invalid clip duration', 'invalid clip durations'],
    tiny_clip: ['tiny clip', 'tiny clips'],
    clip_without_asset: ['clip without an asset', 'clips without assets'],
    missing_track: ['clip on a missing track', 'clips on missing tracks'],
    invalid_trim_range: ['invalid trim range', 'invalid trim ranges'],
    tiny_track_gap: ['tiny gap', 'tiny gaps'],
    track_overlap: ['clip overlap', 'clip overlaps'],
    hidden_track_with_clips: ['hidden track with clips', 'hidden tracks with clips'],
    disabled_clip: ['disabled clip', 'disabled clips'],
    muted_audio_track_with_clips: ['muted audio track with clips', 'muted audio tracks with clips'],
    locked_track_with_clips: ['locked track with clips', 'locked tracks with clips'],
    speed_changed_clip: ['speed-changed clip', 'speed-changed clips'],
    failed_music_assets: ['failed music-video asset', 'failed music-video assets'],
    active_music_jobs: ['active music-video job', 'active music-video jobs'],
    shots_with_keyframes_no_video: ['shot with keyframes but no video', 'shots with keyframes but no videos'],
    shots_with_videos_no_keyframes: ['shot with video but no keyframe', 'shots with videos but no keyframes'],
    unassembled_music_videos: ['unassembled music-video video', 'unassembled music-video videos'],
    duplicate_video_variants: ['duplicate video variant', 'duplicate video variants'],
    shots_with_multiple_videos: ['shot with multiple videos', 'shots with multiple videos'],
    manual_replacements: ['manual replacement', 'manual replacements'],
  }
  const matching = severity ? findings.filter((finding) => finding.severity === severity) : findings
  const counts = countBy(matching, (finding) => finding.code)
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => {
      const [singular, plural] = labels[code] || [code.replace(/_/g, ' '), `${code.replace(/_/g, ' ')} items`]
      return pluralize(count, singular, plural)
    })
}

function rankFindings(findings = []) {
  const rank = { error: 0, warning: 1, info: 2 }
  return [...findings].sort((a, b) => {
    const severityDelta = (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)
    if (severityDelta !== 0) return severityDelta
    return String(a.code || '').localeCompare(String(b.code || ''))
  })
}

function getMusicYolo(asset) {
  return asset?.yolo || asset?.settings?.yolo || null
}

function isMusicVideoAsset(asset) {
  const yolo = getMusicYolo(asset)
  return Boolean(yolo?.mode === 'music' || yolo?.workflow === 'music-video' || yolo?.musicVideo)
}

function getMusicAssetStage(asset) {
  const yolo = getMusicYolo(asset) || {}
  if (yolo.stage) return String(yolo.stage)
  if (asset?.type === 'image') return 'storyboard'
  if (asset?.type === 'video') return 'video'
  return String(asset?.type || 'unknown')
}

function getMusicShotId(assetOrYolo) {
  const yolo = assetOrYolo?.yolo || assetOrYolo?.settings?.yolo || assetOrYolo || {}
  return String(yolo.shotId || yolo.shot_id || '').trim()
}

function getMusicVariantKey(assetOrYolo) {
  const yolo = assetOrYolo?.yolo || assetOrYolo?.settings?.yolo || assetOrYolo || {}
  return String(yolo.variantKey || yolo.key || '').trim()
}

function musicAssetRef(asset) {
  const yolo = getMusicYolo(asset) || {}
  return {
    id: asset?.id,
    name: asset?.name,
    type: asset?.type,
    stage: getMusicAssetStage(asset),
    status: asset?.generationStatus || asset?.status || 'none',
    shotId: getMusicShotId(yolo),
    variantKey: getMusicVariantKey(yolo),
    workflowId: yolo.workflowId || asset?.workflowId || asset?.settings?.workflowId || '',
    coverage: yolo.coverage?.label || yolo.coverage?.type || '',
    manualReplacement: Boolean(yolo.manualReplacement),
    createdAt: asset?.createdAt || asset?.imported || null,
    error: asset?.error || asset?.generationError || asset?.settings?.error || '',
  }
}

function analyzeMusicVideoWorkflow(snapshot, args = {}) {
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : []
  const timeline = snapshot?.currentTimeline || null
  const clips = Array.isArray(timeline?.clips) ? timeline.clips : []
  const maxFindings = clampLimit(args.maxFindings, 75, 250)
  const musicAssets = assets.filter(isMusicVideoAsset)
  const musicAssetIds = new Set(musicAssets.map((asset) => asset?.id).filter(Boolean))
  const timelineAssetIds = new Set(clips.map((clip) => clip?.assetId).filter(Boolean))
  const activeStates = new Set(['queued', 'generating', 'downloading', 'encoding', 'running'])
  const failedStates = new Set(['failed', 'error'])
  const findings = []

  if (musicAssets.length === 0) {
    return {
      summary: 'No music-video workflow assets were detected in the open project.',
      project: {
        name: snapshot?.project?.name || '',
        path: snapshot?.project?.path || '',
      },
      health: { status: 'no_music_video_assets', severityCounts: { error: 0, warning: 0, info: 1 } },
      findings: [{
        severity: 'info',
        code: 'no_music_video_assets',
        message: 'This project does not currently expose music-video assets through the MCP snapshot.',
      }],
      suggestedNextActions: ['Open or generate a music-video project, then run this analysis again.'],
      generatedAt: new Date().toISOString(),
    }
  }

  const byStage = countBy(musicAssets, getMusicAssetStage)
  const byWorkflow = countBy(musicAssets, (asset) => musicAssetRef(asset).workflowId || getMusicAssetStage(asset))
  const byCoverage = countBy(musicAssets, (asset) => musicAssetRef(asset).coverage || 'uncategorized')
  const shotsById = new Map()
  const variantsByKey = new Map()
  const failedAssets = []
  const activeAssets = []
  const manualReplacementAssets = []
  const unassembledVideos = []

  const ensureShot = (shotId) => {
    const key = shotId || 'unknown'
    if (!shotsById.has(key)) {
      shotsById.set(key, {
        shotId: key,
        assetCount: 0,
        storyboardCount: 0,
        videoCount: 0,
        failedCount: 0,
        activeCount: 0,
        assembledClipCount: 0,
        syncLockedClipCount: 0,
        manualReplacementCount: 0,
        workflows: {},
        coverage: {},
        variants: {},
      })
    }
    return shotsById.get(key)
  }

  for (const asset of musicAssets) {
    const ref = musicAssetRef(asset)
    const status = String(ref.status || '').toLowerCase()
    const shot = ensureShot(ref.shotId || ref.variantKey || 'unknown')
    shot.assetCount += 1
    if (ref.stage === 'storyboard') shot.storyboardCount += 1
    if (ref.stage === 'video') shot.videoCount += 1
    if (activeStates.has(status)) {
      shot.activeCount += 1
      activeAssets.push(ref)
    }
    if (failedStates.has(status) || ref.error) {
      shot.failedCount += 1
      failedAssets.push(ref)
    }
    if (ref.manualReplacement) {
      shot.manualReplacementCount += 1
      manualReplacementAssets.push(ref)
    }
    if (ref.workflowId) shot.workflows[ref.workflowId] = (shot.workflows[ref.workflowId] || 0) + 1
    if (ref.coverage) shot.coverage[ref.coverage] = (shot.coverage[ref.coverage] || 0) + 1
    if (ref.variantKey) {
      shot.variants[ref.variantKey] = (shot.variants[ref.variantKey] || 0) + 1
      if (!variantsByKey.has(ref.variantKey)) {
        variantsByKey.set(ref.variantKey, {
          variantKey: ref.variantKey,
          shotId: ref.shotId,
          storyboardCount: 0,
          videoCount: 0,
          activeCount: 0,
          failedCount: 0,
          assembledClipCount: 0,
          workflows: {},
        })
      }
      const variant = variantsByKey.get(ref.variantKey)
      if (ref.stage === 'storyboard') variant.storyboardCount += 1
      if (ref.stage === 'video') variant.videoCount += 1
      if (activeStates.has(status)) variant.activeCount += 1
      if (failedStates.has(status) || ref.error) variant.failedCount += 1
      if (ref.workflowId) variant.workflows[ref.workflowId] = (variant.workflows[ref.workflowId] || 0) + 1
    }

    if (ref.stage === 'video' && asset?.id && !timelineAssetIds.has(asset.id)) unassembledVideos.push(ref)
  }

  const assembledClips = clips.filter((clip) => clip?.metadata?.musicVideoAssembly || musicAssetIds.has(clip?.assetId))
  const syncLockedClips = clips.filter((clip) => clip?.lockMode === 'sync' || clip?.syncLock?.mode === 'sync')
  for (const clip of assembledClips) {
    const shotId = String(
      clip?.metadata?.musicVideoAssembly?.shotId
      || clip?.syncLock?.shotId
      || ''
    ).trim()
    const variantKey = String(
      clip?.metadata?.musicVideoAssembly?.variantKey
      || clip?.syncLock?.variantKey
      || ''
    ).trim()
    if (shotId) ensureShot(shotId).assembledClipCount += 1
    if (variantKey && variantsByKey.has(variantKey)) variantsByKey.get(variantKey).assembledClipCount += 1
  }
  for (const clip of syncLockedClips) {
    const shotId = String(clip?.syncLock?.shotId || clip?.metadata?.musicVideoAssembly?.shotId || '').trim()
    if (shotId) ensureShot(shotId).syncLockedClipCount += 1
  }

  const shots = Array.from(shotsById.values())
    .filter((shot) => shot.shotId !== 'unknown')
    .sort((a, b) => a.shotId.localeCompare(b.shotId, undefined, { numeric: true }))
  const variants = Array.from(variantsByKey.values())
  const shotsWithKeyframesNoVideo = shots.filter((shot) => shot.storyboardCount > 0 && shot.videoCount === 0)
  const shotsWithVideosNoKeyframes = shots.filter((shot) => shot.videoCount > 0 && shot.storyboardCount === 0)
  const shotsWithMultipleVideos = shots.filter((shot) => shot.videoCount > 1)
  const variantsWithMultipleVideos = variants.filter((variant) => variant.videoCount > 1)

  if (failedAssets.length > 0) {
    addFinding(findings, {
      severity: 'error',
      code: 'failed_music_assets',
      message: `${pluralize(failedAssets.length, 'music-video asset')} failed or contains an error.`,
      assets: failedAssets.slice(0, 25),
    })
  }
  if (activeAssets.length > 0) {
    addFinding(findings, {
      severity: 'info',
      code: 'active_music_jobs',
      message: `${pluralize(activeAssets.length, 'music-video asset')} still appears active.`,
      assets: activeAssets.slice(0, 25),
    })
  }
  if (shotsWithKeyframesNoVideo.length > 0) {
    addFinding(findings, {
      severity: 'warning',
      code: 'shots_with_keyframes_no_video',
      message: `${pluralize(shotsWithKeyframesNoVideo.length, 'shot')} has keyframes but no detected video asset.`,
      shots: shotsWithKeyframesNoVideo.slice(0, 25).map((shot) => shot.shotId),
    })
  }
  if (shotsWithVideosNoKeyframes.length > 0) {
    addFinding(findings, {
      severity: 'info',
      code: 'shots_with_videos_no_keyframes',
      message: `${pluralize(shotsWithVideosNoKeyframes.length, 'shot')} has video assets but no detected keyframe asset.`,
      shots: shotsWithVideosNoKeyframes.slice(0, 25).map((shot) => shot.shotId),
    })
  }
  if (unassembledVideos.length > 0) {
    addFinding(findings, {
      severity: 'info',
      code: 'unassembled_music_videos',
      message: `${pluralize(unassembledVideos.length, 'music-video video')} exists in assets but is not currently used by a timeline clip.`,
      assets: unassembledVideos.slice(0, 25),
    })
  }
  if (variantsWithMultipleVideos.length > 0) {
    addFinding(findings, {
      severity: 'info',
      code: 'duplicate_video_variants',
      message: `${pluralize(variantsWithMultipleVideos.length, 'variant')} has multiple video assets, usually from reruns or replacements.`,
      variants: variantsWithMultipleVideos.slice(0, 25),
    })
  } else if (shotsWithMultipleVideos.length > 0) {
    addFinding(findings, {
      severity: 'info',
      code: 'shots_with_multiple_videos',
      message: `${pluralize(shotsWithMultipleVideos.length, 'shot')} has multiple video assets, usually from alternate passes or reruns.`,
      shots: shotsWithMultipleVideos.slice(0, 25).map((shot) => shot.shotId),
    })
  }
  if (manualReplacementAssets.length > 0) {
    addFinding(findings, {
      severity: 'info',
      code: 'manual_replacements',
      message: `${pluralize(manualReplacementAssets.length, 'music-video asset')} came from manual replacement/import.`,
      assets: manualReplacementAssets.slice(0, 25),
    })
  }

  const rankedFindings = rankFindings(findings)
  const limitedFindings = rankedFindings.slice(0, maxFindings)
  const severityCounts = rankedFindings.reduce((counts, finding) => {
    counts[finding.severity] = (counts[finding.severity] || 0) + 1
    return counts
  }, { error: 0, warning: 0, info: 0 })
  const status = severityCounts.error > 0
    ? 'needs_attention'
    : severityCounts.warning > 0
      ? 'review_recommended'
      : 'looks_good'
  const summary = `Music-video workflow has ${musicAssets.length} music assets across ${pluralize(shots.length, 'detected shot')}: ${pluralize(byStage.storyboard || 0, 'keyframe/storyboard')} and ${pluralize(byStage.video || 0, 'video')}. ${pluralize(assembledClips.length, 'timeline clip')} ${assembledClips.length === 1 ? 'uses' : 'use'} music-video assets, with ${pluralize(syncLockedClips.length, 'sync-locked clip')}. Found ${severityCounts.error} blocking issue(s), ${severityCounts.warning} warning(s), and ${severityCounts.info} note(s).`
  const warningDetails = describeFindingCodes(rankedFindings, 'warning')
  const errorDetails = describeFindingCodes(rankedFindings, 'error')
  const infoDetails = describeFindingCodes(rankedFindings, 'info')
  const suggestedNextActions = []
  if (severityCounts.error > 0) suggestedNextActions.push(`Fix ${pluralize(severityCounts.error, 'blocking issue')}: ${joinHumanList(errorDetails)}.`)
  if (shotsWithKeyframesNoVideo.length > 0) suggestedNextActions.push(`Queue or import videos for ${pluralize(shotsWithKeyframesNoVideo.length, 'shot')} that already have keyframes.`)
  if (severityCounts.warning > 0 && shotsWithKeyframesNoVideo.length === 0) suggestedNextActions.push(`Review ${pluralize(severityCounts.warning, 'warning')}: ${joinHumanList(warningDetails)}.`)
  if (unassembledVideos.length > 0) suggestedNextActions.push(`${pluralize(unassembledVideos.length, 'video')} ${unassembledVideos.length === 1 ? 'exists' : 'exist'} outside the current timeline; assemble or ignore ${unassembledVideos.length === 1 ? 'it' : 'them'} depending on the edit.`)
  if (suggestedNextActions.length === 0) suggestedNextActions.push('Music-video workflow state looks ready based on the current assets and timeline.')
  if (severityCounts.info > 0 && infoDetails.length > 0) suggestedNextActions.push(`Notes: ${joinHumanList(infoDetails)}.`)

  return {
    summary,
    project: {
      name: snapshot?.project?.name || '',
      path: snapshot?.project?.path || '',
    },
    currentTimeline: timeline ? {
      id: timeline.id,
      name: timeline.name,
      duration: roundTime(timeline.duration),
      clipCount: clips.length,
    } : null,
    health: {
      status,
      severityCounts,
      findingCount: rankedFindings.length,
      returnedFindingCount: limitedFindings.length,
      findingLimitApplied: rankedFindings.length > limitedFindings.length,
    },
    metrics: {
      musicAssetCount: musicAssets.length,
      detectedShotCount: shots.length,
      detectedVariantCount: variants.length,
      assetsByStage: byStage,
      assetsByWorkflow: byWorkflow,
      assetsByCoverage: byCoverage,
      assembledClipCount: assembledClips.length,
      syncLockedClipCount: syncLockedClips.length,
      failedAssetCount: failedAssets.length,
      activeAssetCount: activeAssets.length,
      manualReplacementCount: manualReplacementAssets.length,
      unassembledVideoCount: unassembledVideos.length,
      shotsWithKeyframesNoVideoCount: shotsWithKeyframesNoVideo.length,
      shotsWithVideosNoKeyframesCount: shotsWithVideosNoKeyframes.length,
      duplicateVideoVariantCount: variantsWithMultipleVideos.length,
    },
    findings: limitedFindings,
    notableShots: {
      keyframesNoVideo: shotsWithKeyframesNoVideo.slice(0, 25),
      videosNoKeyframes: shotsWithVideosNoKeyframes.slice(0, 25),
      multipleVideos: shotsWithMultipleVideos.slice(0, 25),
    },
    notableAssets: {
      failed: failedAssets.slice(0, 25),
      active: activeAssets.slice(0, 25),
      unassembledVideos: unassembledVideos.slice(0, 25),
      manualReplacements: manualReplacementAssets.slice(0, 25),
    },
    suggestedNextActions,
    generatedAt: new Date().toISOString(),
  }
}

function analyzeTimeline(snapshot, args = {}) {
  const timeline = snapshot?.currentTimeline || null
  if (!timeline) {
    return {
      summary: 'No current timeline is available to analyze.',
      health: { status: 'blocked', severityCounts: { error: 1, warning: 0, info: 0 } },
      findings: [{
        severity: 'error',
        code: 'no_current_timeline',
        message: 'ComfyStudio does not currently have an active timeline snapshot.',
      }],
    }
  }

  const clips = Array.isArray(timeline.clips) ? timeline.clips : []
  const tracks = Array.isArray(timeline.tracks) ? timeline.tracks : []
  const transitions = Array.isArray(timeline.transitions) ? timeline.transitions : []
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : []
  const assetById = new Map(assets.map((asset) => [asset?.id, asset]).filter(([id]) => id))
  const trackById = new Map(tracks.map((track) => [track?.id, track]).filter(([id]) => id))
  const fps = toFiniteNumber(timeline.fps, 24) || 24
  const frameDuration = 1 / fps
  const maxFindings = clampLimit(args.maxFindings, 75, 250)
  const tinyClipSeconds = getNumberArg(args, 'tinyClipSeconds', Math.max(frameDuration * 2, 0.1), 0.001, 2)
  const overlapThresholdSeconds = getNumberArg(args, 'overlapThresholdSeconds', Math.max(frameDuration / 2, 0.01), 0.001, 2)
  const tinyGapMinSeconds = getNumberArg(args, 'tinyGapMinSeconds', Math.max(frameDuration / 4, 0.01), 0.001, 1)
  const tinyGapMaxSeconds = getNumberArg(args, 'tinyGapMaxSeconds', Math.max(frameDuration * 2, 0.1), 0.002, 2)
  const findings = []
  const tinyClips = []
  const missingAssetClips = []
  const transformedClips = []
  const xmlImportedClips = []
  const syncLockedClips = []
  const disabledClips = []
  const speedChangedClips = []

  for (const clip of clips) {
    const duration = getClipDuration(clip)
    const start = getClipStart(clip)
    const track = trackById.get(clip?.trackId)

    if (!Number.isFinite(Number(clip?.startTime))) {
      addFinding(findings, {
        severity: 'error',
        code: 'invalid_clip_start',
        message: `Clip "${clip?.name || clip?.id}" has an invalid start time.`,
        clip: clipRef(clip),
      })
    }

    if (!Number.isFinite(Number(clip?.duration)) || duration <= 0) {
      addFinding(findings, {
        severity: 'error',
        code: 'invalid_clip_duration',
        message: `Clip "${clip?.name || clip?.id}" has an invalid or zero duration.`,
        clip: clipRef(clip),
      })
    } else if (duration < tinyClipSeconds) {
      tinyClips.push(clipRef(clip))
      addFinding(findings, {
        severity: 'warning',
        code: 'tiny_clip',
        message: `Clip "${clip?.name || clip?.id}" is only ${roundTime(duration)}s long, which can cause export or timeline edge-case issues.`,
        clip: clipRef(clip),
      })
    }

    if (isAssetBackedClip(clip) && clip?.assetId && !assetById.has(clip.assetId)) {
      missingAssetClips.push(clipRef(clip))
      addFinding(findings, {
        severity: 'error',
        code: 'missing_asset',
        message: `Clip "${clip?.name || clip?.id}" references an asset that is not present in the project asset list.`,
        clip: clipRef(clip),
      })
    }

    if (isAssetBackedClip(clip) && !clip?.assetId) {
      addFinding(findings, {
        severity: 'warning',
        code: 'clip_without_asset',
        message: `Clip "${clip?.name || clip?.id}" has no asset reference.`,
        clip: clipRef(clip),
      })
    }

    if (clip?.enabled === false) {
      disabledClips.push(clipRef(clip))
      addFinding(findings, {
        severity: 'info',
        code: 'disabled_clip',
        message: `Clip "${clip?.name || clip?.id}" is disabled and will not play/export normally.`,
        clip: clipRef(clip),
      })
    }

    if (!track && clip?.trackId) {
      addFinding(findings, {
        severity: 'warning',
        code: 'missing_track',
        message: `Clip "${clip?.name || clip?.id}" references a track that is not present in the timeline track list.`,
        clip: clipRef(clip),
      })
    }

    if (hasNonDefaultTransform(clip?.transform)) transformedClips.push(clipRef(clip))
    if (clip?.metadata?.importedFromFcpXml) xmlImportedClips.push(clipRef(clip))
    if (clip?.lockMode === 'sync' || clip?.syncLock?.mode === 'sync') syncLockedClips.push(clipRef(clip))
    if (Math.abs(toFiniteNumber(clip?.speed, 1) - 1) > 0.001) {
      speedChangedClips.push(clipRef(clip))
      addFinding(findings, {
        severity: 'info',
        code: 'speed_changed_clip',
        message: `Clip "${clip?.name || clip?.id}" has a playback speed of ${clip?.speed}.`,
        clip: clipRef(clip),
      })
    }

    const trimStart = Number(clip?.trimStart)
    const trimEnd = Number(clip?.trimEnd)
    if (Number.isFinite(trimStart) && Number.isFinite(trimEnd) && trimEnd <= trimStart) {
      addFinding(findings, {
        severity: 'warning',
        code: 'invalid_trim_range',
        message: `Clip "${clip?.name || clip?.id}" has a trim range where trimEnd is not after trimStart.`,
        clip: clipRef({ ...clip, startTime: start, duration }),
      })
    }
  }

  const trackSummaries = tracks.map((track) => {
    const trackClips = clips
      .filter((clip) => clip?.trackId === track?.id)
      .sort((a, b) => getClipStart(a) - getClipStart(b))
    const enabledClips = trackClips.filter((clip) => clip?.enabled !== false)
    const validClips = enabledClips.filter((clip) => getClipDuration(clip) > 0)
    const tinyTrackClips = validClips.filter((clip) => getClipDuration(clip) < tinyClipSeconds)
    let gapCount = 0
    let tinyGapCount = 0
    let overlapCount = 0
    let firstStart = null
    let lastEnd = null
    let previous = null

    for (const clip of validClips) {
      const start = getClipStart(clip)
      const end = getClipEnd(clip)
      firstStart = firstStart === null ? start : Math.min(firstStart, start)
      lastEnd = lastEnd === null ? end : Math.max(lastEnd, end)

      if (previous) {
        const previousEnd = getClipEnd(previous)
        const gap = start - previousEnd
        const overlap = previousEnd - start
        if (gap > 0) gapCount += 1
        if (gap >= tinyGapMinSeconds && gap <= tinyGapMaxSeconds) {
          tinyGapCount += 1
          addFinding(findings, {
            severity: 'warning',
            code: 'tiny_track_gap',
            message: `Track "${track?.name || track?.id}" has a tiny ${roundTime(gap)}s gap between "${previous?.name || previous?.id}" and "${clip?.name || clip?.id}".`,
            trackId: track?.id,
            clips: [clipRef(previous), clipRef(clip)],
            gapSeconds: roundTime(gap),
          })
        }
        if (overlap > overlapThresholdSeconds) {
          overlapCount += 1
          addFinding(findings, {
            severity: 'warning',
            code: 'track_overlap',
            message: `Track "${track?.name || track?.id}" has a ${roundTime(overlap)}s overlap between "${previous?.name || previous?.id}" and "${clip?.name || clip?.id}".`,
            trackId: track?.id,
            clips: [clipRef(previous), clipRef(clip)],
            overlapSeconds: roundTime(overlap),
          })
        }
      }
      previous = clip
    }

    if (track?.visible === false && enabledClips.length > 0) {
      addFinding(findings, {
        severity: 'warning',
        code: 'hidden_track_with_clips',
        message: `Track "${track?.name || track?.id}" is hidden but contains ${enabledClips.length} enabled clips.`,
        trackId: track?.id,
      })
    }

    if (track?.muted && String(track?.type || '').toLowerCase() === 'audio' && enabledClips.length > 0) {
      addFinding(findings, {
        severity: 'info',
        code: 'muted_audio_track_with_clips',
        message: `Audio track "${track?.name || track?.id}" is muted and contains ${enabledClips.length} enabled clips.`,
        trackId: track?.id,
      })
    }

    if (track?.locked && enabledClips.length > 0) {
      addFinding(findings, {
        severity: 'info',
        code: 'locked_track_with_clips',
        message: `Track "${track?.name || track?.id}" is locked and contains ${enabledClips.length} enabled clips.`,
        trackId: track?.id,
      })
    }

    return {
      id: track?.id,
      name: track?.name,
      type: track?.type,
      visible: track?.visible !== false,
      muted: Boolean(track?.muted),
      locked: Boolean(track?.locked),
      clipCount: trackClips.length,
      enabledClipCount: enabledClips.length,
      startTime: firstStart === null ? null : roundTime(firstStart),
      endTime: lastEnd === null ? null : roundTime(lastEnd),
      gapCount,
      tinyGapCount,
      overlapCount,
      tinyClipCount: tinyTrackClips.length,
    }
  })

  const rankedFindings = rankFindings(findings)
  const limitedFindings = rankedFindings.slice(0, maxFindings)
  const severityCounts = rankedFindings.reduce((counts, finding) => {
    counts[finding.severity] = (counts[finding.severity] || 0) + 1
    return counts
  }, { error: 0, warning: 0, info: 0 })
  const status = severityCounts.error > 0
    ? 'needs_attention'
    : severityCounts.warning > 0
      ? 'review_recommended'
      : 'looks_good'
  const timelineName = timeline.name || 'Untitled timeline'
  const summary = severityCounts.error > 0 || severityCounts.warning > 0
    ? `Timeline "${timelineName}" has ${clips.length} clips across ${tracks.length} tracks. Found ${severityCounts.error} blocking issue(s), ${severityCounts.warning} warning(s), and ${severityCounts.info} informational note(s).`
    : `Timeline "${timelineName}" looks structurally healthy: ${clips.length} clips across ${tracks.length} tracks, with no blocking issues or warnings detected.`

  const suggestedNextActions = []
  const errorDetails = describeFindingCodes(rankedFindings, 'error')
  const warningDetails = describeFindingCodes(rankedFindings, 'warning')
  const infoDetails = describeFindingCodes(rankedFindings, 'info')
  if (severityCounts.error > 0) {
    suggestedNextActions.push(`Fix ${pluralize(severityCounts.error, 'blocking issue')} before exporting: ${joinHumanList(errorDetails)}.`)
  }
  if (severityCounts.warning > 0) {
    suggestedNextActions.push(`Review ${pluralize(severityCounts.warning, 'warning')} before export: ${joinHumanList(warningDetails)}.`)
  }
  if (severityCounts.error === 0 && missingAssetClips.length === 0) {
    suggestedNextActions.push('No missing media or blocking timeline issues were detected.')
  }
  if (severityCounts.info > 0 && infoDetails.length > 0) {
    suggestedNextActions.push(`Informational notes: ${joinHumanList(infoDetails)}.`)
  }
  if (suggestedNextActions.length === 0) suggestedNextActions.push('No immediate timeline cleanup is required based on this read-only analysis.')

  return {
    summary,
    project: {
      name: snapshot?.project?.name || '',
      path: snapshot?.project?.path || '',
    },
    timeline: {
      id: timeline.id,
      name: timelineName,
      duration: roundTime(timeline.duration),
      fps,
      width: timeline.width,
      height: timeline.height,
      trackCount: tracks.length,
      clipCount: clips.length,
      transitionCount: transitions.length,
    },
    health: {
      status,
      severityCounts,
      findingCount: rankedFindings.length,
      returnedFindingCount: limitedFindings.length,
      findingLimitApplied: rankedFindings.length > limitedFindings.length,
    },
    metrics: {
      clipCounts: countBy(clips, (clip) => clip?.type),
      assetCounts: summarizeAssetCounts(assets),
      xmlImportedClipCount: xmlImportedClips.length,
      transformedClipCount: transformedClips.length,
      syncLockedClipCount: syncLockedClips.length,
      disabledClipCount: disabledClips.length,
      speedChangedClipCount: speedChangedClips.length,
      transitionCount: transitions.length,
    },
    findings: limitedFindings,
    trackSummaries,
    notableClips: {
      missingAssets: missingAssetClips.slice(0, 25),
      tiny: tinyClips.slice(0, 25),
      transformed: transformedClips.slice(0, 25),
      xmlImported: xmlImportedClips.slice(0, 25),
      syncLocked: syncLockedClips.slice(0, 25),
      disabled: disabledClips.slice(0, 25),
      speedChanged: speedChangedClips.slice(0, 25),
    },
    suggestedNextActions,
    generatedAt: new Date().toISOString(),
  }
}

function createToolDefinitions() {
  return [
    {
      name: 'get_project',
      description: 'Return a concise summary of the open ComfyStudio project, current timeline, asset counts, and MCP snapshot freshness.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_timeline',
      description: 'Return the current timeline with tracks and clips. Clip timing is in seconds. Use assetId values with get_assets.',
      inputSchema: {
        type: 'object',
        properties: {
          includeClips: { type: 'boolean', description: 'Include timeline clips. Defaults to true.' },
          includeTransitions: { type: 'boolean', description: 'Include transitions. Defaults to false.' },
          limit: { type: 'integer', description: 'Maximum clips to return. Defaults to 300.' },
        },
      },
    },
    {
      name: 'get_assets',
      description: 'Return media assets from the open project. Heavy preview URLs and blobs are never exposed.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Optional asset type filter: video, audio, image, mask, etc.' },
          status: { type: 'string', description: 'Optional generationStatus/status filter.' },
          limit: { type: 'integer', description: 'Maximum assets to return. Defaults to 200.' },
        },
      },
    },
    {
      name: 'get_generation_status',
      description: 'Return active, failed, and recent generated asset status for the open project.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_music_video_status',
      description: 'Summarize ComfyStudio music-video workflow assets, assembled clips, and sync-locked clips in the current project.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'analyze_timeline',
      description: 'Return an AI-friendly read-only timeline health report with likely export risks, missing media, tiny clips/gaps, overlaps, track state, XML imports, transforms, and next actions.',
      inputSchema: {
        type: 'object',
        properties: {
          maxFindings: { type: 'integer', description: 'Maximum findings to return. Defaults to 75.' },
          tinyClipSeconds: { type: 'number', description: 'Clips shorter than this are reported as tiny clip risks. Defaults to about two frames.' },
          overlapThresholdSeconds: { type: 'number', description: 'Overlaps larger than this are reported. Defaults to about half a frame.' },
          tinyGapMinSeconds: { type: 'number', description: 'Minimum gap size to report as a tiny gap.' },
          tinyGapMaxSeconds: { type: 'number', description: 'Maximum gap size to report as a tiny gap.' },
        },
      },
    },
    {
      name: 'analyze_music_video_workflow',
      description: 'Return an AI-friendly read-only health report for the music-video workflow, including generated keyframes/videos, failed or active jobs, assembled clips, sync locks, reruns/replacements, and next actions.',
      inputSchema: {
        type: 'object',
        properties: {
          maxFindings: { type: 'integer', description: 'Maximum findings to return. Defaults to 75.' },
        },
      },
    },
  ]
}

class ComfyStudioMcpServer {
  constructor({ port = DEFAULT_MCP_PORT, version = '0.1.0' } = {}) {
    this.port = port
    this.version = version
    this.server = null
    this.running = false
    this.error = null
    this.lastSnapshot = null
    this.lastSnapshotAt = null
    this.tools = createToolDefinitions()
  }

  async start() {
    if (this.server) return this.getStatus()

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        this.writeJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: error?.message || String(error) },
          id: null,
        })
      })
    })

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.off('error', reject)
        this.running = true
        this.error = null
        resolve()
      })
    }).catch((error) => {
      this.error = error?.message || String(error)
      this.running = false
      this.server = null
      throw error
    })

    return this.getStatus()
  }

  async stop() {
    const server = this.server
    this.server = null
    this.running = false
    if (!server) return
    await new Promise((resolve) => server.close(resolve))
  }

  updateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false
    this.lastSnapshot = snapshot
    this.lastSnapshotAt = new Date().toISOString()
    return true
  }

  getStatus() {
    return {
      running: this.running,
      port: this.port,
      url: `http://127.0.0.1:${this.port}/mcp`,
      error: this.error,
      toolCount: this.tools.length,
      lastSnapshotAt: this.lastSnapshotAt,
      hasProject: hasSnapshot(this.lastSnapshot),
    }
  }

  async handleRequest(req, res) {
    this.writeCorsHeaders(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`)
    if (url.pathname !== '/mcp' && url.pathname !== '/') {
      this.writeJson(res, 404, { error: 'Not found.' })
      return
    }

    if (req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      return
    }

    if (req.method !== 'POST') {
      this.writeJson(res, 405, { error: 'Method not allowed.' })
      return
    }

    const body = await this.readRequestBody(req)
    let payload
    try {
      payload = body ? JSON.parse(body) : null
    } catch {
      this.writeJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error.' },
        id: null,
      })
      return
    }

    if (Array.isArray(payload)) {
      const responses = payload
        .map((entry) => this.handleJsonRpc(entry))
        .filter(Boolean)
      if (responses.length === 0) {
        res.writeHead(202)
        res.end()
        return
      }
      this.writeJson(res, 200, responses)
      return
    }

    const response = this.handleJsonRpc(payload)
    if (!response) {
      res.writeHead(202)
      res.end()
      return
    }
    this.writeJson(res, 200, response)
  }

  handleJsonRpc(message) {
    if (!message || typeof message !== 'object') {
      return {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request.' },
        id: null,
      }
    }

    const id = Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : undefined
    const isNotification = id === undefined || id === null
    const method = String(message.method || '')
    const params = message.params || {}

    if (!method || method.startsWith('notifications/')) return null

    try {
      let result
      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: params.protocolVersion || MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: {
              name: 'comfystudio',
              version: this.version,
            },
            instructions: 'You are connected to ComfyStudio. Use the tools to inspect the open project, timeline, assets, generation status, and music-video workflow state. This first MCP surface is read-only.',
          }
          break
        case 'ping':
          result = {}
          break
        case 'tools/list':
          result = { tools: this.tools }
          break
        case 'tools/call':
          result = this.callTool(params?.name, params?.arguments || {})
          break
        case 'resources/list':
          result = { resources: [] }
          break
        default:
          return {
            jsonrpc: '2.0',
            error: { code: -32601, message: `Method not found: ${method}` },
            id: isNotification ? null : id,
          }
      }

      if (isNotification) return null
      return { jsonrpc: '2.0', result, id }
    } catch (error) {
      if (isNotification) return null
      return {
        jsonrpc: '2.0',
        error: { code: -32603, message: error?.message || String(error) },
        id,
      }
    }
  }

  callTool(name, args = {}) {
    const snapshot = getSnapshotOrEmpty(this.lastSnapshot)
    if (!hasSnapshot(snapshot) && name !== 'get_project') {
      return errorResult('No ComfyStudio project is open yet.')
    }

    switch (name) {
      case 'get_project':
        return textResult({
          app: snapshot.app,
          project: snapshot.project,
          currentTimeline: snapshot.currentTimeline ? {
            id: snapshot.currentTimeline.id,
            name: snapshot.currentTimeline.name,
            duration: snapshot.currentTimeline.duration,
            fps: snapshot.currentTimeline.fps,
            width: snapshot.currentTimeline.width,
            height: snapshot.currentTimeline.height,
            trackCount: snapshot.currentTimeline.tracks?.length || 0,
            clipCount: snapshot.currentTimeline.clips?.length || 0,
            transitionCount: snapshot.currentTimeline.transitions?.length || 0,
          } : null,
          timelineCount: snapshot.timelines?.length || 0,
          assetCount: snapshot.assets?.length || 0,
          assetCounts: summarizeAssetCounts(snapshot.assets || []),
          generatedAt: snapshot.generatedAt,
          mcp: this.getStatus(),
        })
      case 'get_timeline': {
        const timeline = snapshot.currentTimeline || null
        if (!timeline) return errorResult('No current timeline is available.')
        const includeClips = args.includeClips !== false
        const includeTransitions = args.includeTransitions === true
        const limit = clampLimit(args.limit, 300, 1000)
        return textResult({
          ...timeline,
          clipCounts: summarizeClipCounts(timeline.clips || []),
          clips: includeClips ? (timeline.clips || []).slice(0, limit) : undefined,
          transitions: includeTransitions ? (timeline.transitions || []) : undefined,
          clipLimitApplied: includeClips && (timeline.clips || []).length > limit,
        })
      }
      case 'get_assets': {
        const type = String(args.type || '').trim().toLowerCase()
        const status = String(args.status || '').trim().toLowerCase()
        const limit = clampLimit(args.limit, 200, 1000)
        let assets = snapshot.assets || []
        if (type) assets = assets.filter((asset) => String(asset?.type || '').toLowerCase() === type)
        if (status) {
          assets = assets.filter((asset) => (
            String(asset?.generationStatus || asset?.status || '').toLowerCase() === status
          ))
        }
        return textResult({
          count: assets.length,
          limitApplied: assets.length > limit,
          assets: assets.slice(0, limit),
        })
      }
      case 'get_generation_status':
        return textResult(summarizeGenerationAssets(snapshot.assets || []))
      case 'get_music_video_status':
        return textResult(summarizeMusicVideoWorkflow(snapshot))
      case 'analyze_timeline':
        return textResult(analyzeTimeline(snapshot, args))
      case 'analyze_music_video_workflow':
        return textResult(analyzeMusicVideoWorkflow(snapshot, args))
      default:
        return errorResult(`Unknown tool: ${name}`)
    }
  }

  readRequestBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 5 * 1024 * 1024) {
          req.destroy()
          reject(new Error('Request body is too large.'))
        }
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }

  writeCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, MCP-Protocol-Version')
  }

  writeJson(res, statusCode, payload) {
    this.writeCorsHeaders(res)
    const data = safeJsonStringify(payload, 0)
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    })
    res.end(data)
  }
}

function createComfyStudioMcpServer(options = {}) {
  return new ComfyStudioMcpServer(options)
}

module.exports = {
  DEFAULT_MCP_PORT,
  createComfyStudioMcpServer,
}
