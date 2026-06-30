import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyEdgeChanges,
  applyNodeChanges,
  BaseEdge,
  Background,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  ArrowUpDown,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Copy,
  Download,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  Play,
  Plus,
  Save,
  Settings2,
  Square,
  Sparkles,
  Type,
  Wand2,
  X,
} from 'lucide-react'
import comfyui from '../services/comfyui'
import useProjectStore from '../stores/projectStore'
import useAssetsStore from '../stores/assetsStore'
import useViewportClampedPosition from '../hooks/useViewportClampedPosition'
import { checkWorkflowDependenciesBatch } from '../services/workflowDependencies'
import {
  FLOW_AI_NODE_LIBRARY,
  FLOW_AI_NODE_TYPES,
  FLOW_AI_TEMPLATES,
  buildNodeStatusSummary,
  createFlowDocument,
  createFlowEdge,
  createFlowNode,
  getDefaultWorkflowId,
  getFlowAudioWorkflowOptions,
  getFlowImageVariantBehavior,
  getFlowImageWorkflowOptions,
  getFlowNodeDefinition,
  getFlowNodeSupportsExecution,
  getFlowOutputDestinationLabel,
  getFlowTextWorkflowOptions,
  getFlowVideoWorkflowOptions,
  getFlowVideoUpscaleWorkflowOptions,
  getFlowWorkflowSummary,
  isSingletonTargetHandle,
  isValidFlowConnection,
  normalizeFlowAiProjectData,
  normalizeFlowImageVariantCount,
  parsePortType,
} from '../services/flowAiSchema'
import {
  getTopazVideoUpscaleCreditsPerSecond,
  TOPAZ_VIDEO_UPSCALE_CREATIVITY_OPTIONS,
  TOPAZ_VIDEO_UPSCALE_MODEL_OPTIONS,
  TOPAZ_VIDEO_UPSCALE_RESOLUTION_OPTIONS,
  topazVideoUpscaleModelSupportsCreativity,
} from '../config/topazVideoUpscaleConfig'
import { getAudioWaveformData } from '../services/audioWaveform'
import { hasUsablePlaybackCache } from '../services/playbackCache'
import { getSpriteFramePosition } from '../services/thumbnailSprites'
import { computeOutputNodeAssetIds, resolveFlowNodeText, runFlowGraph } from '../services/flowAiRuntime'
import { formatCreditsPerSecond, formatCreditsRange } from '../utils/comfyCredits'

function getNodeIcon(nodeType) {
  switch (nodeType) {
    case FLOW_AI_NODE_TYPES.promptAssist:
      return Wand2
    case FLOW_AI_NODE_TYPES.textViewer:
    case FLOW_AI_NODE_TYPES.prompt:
      return Type
    case FLOW_AI_NODE_TYPES.imageInput:
    case FLOW_AI_NODE_TYPES.styleReference:
      return ImageIcon
    case FLOW_AI_NODE_TYPES.imageGen:
      return Sparkles
    case FLOW_AI_NODE_TYPES.videoGen:
      return Film
    case FLOW_AI_NODE_TYPES.videoUpscale:
      return ArrowUpDown
    case FLOW_AI_NODE_TYPES.musicGen:
      return Music
    case FLOW_AI_NODE_TYPES.output:
      return Download
    default:
      return Boxes
  }
}

function shallowStringArrayEqual(left = [], right = []) {
  if (left === right) return true
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function formatRuntimeLabel(workflowId = '') {
  const summary = getFlowWorkflowSummary(workflowId)
  if (!summary) return ''
  return `${summary.label} · ${summary.runtime === 'cloud' ? 'Cloud' : 'Local'}`
}

function formatAssetOutputDestination(folderName = '', assetKind = '') {
  return getFlowOutputDestinationLabel(folderName, assetKind)
}

function formatAssetOutputDestinationSummary(folderName = '') {
  const normalized = String(folderName || '').trim()
  if (normalized) return formatAssetOutputDestination(folderName)
  const autoDestinations = ['image', 'video', 'audio']
    .map((assetKind) => formatAssetOutputDestination('', assetKind).replace(/^Assets \/ /, ''))
  return `Assets / ${autoDestinations.join(' · ')}`
}

const FLOW_BUSY_STATUSES = new Set(['checking', 'queuing', 'running'])
const FLOW_PORT_VISUALS = Object.freeze({
  text: {
    label: 'Text',
    color: '#a78bfa',
    soft: 'rgba(167, 139, 250, 0.18)',
    shadow: 'rgba(167, 139, 250, 0.42)',
    edge: 'rgba(167, 139, 250, 0.5)',
  },
  image: {
    label: 'Image',
    color: '#34d399',
    soft: 'rgba(52, 211, 153, 0.18)',
    shadow: 'rgba(52, 211, 153, 0.36)',
    edge: 'rgba(52, 211, 153, 0.46)',
  },
  video: {
    label: 'Video',
    color: '#38bdf8',
    soft: 'rgba(56, 189, 248, 0.18)',
    shadow: 'rgba(56, 189, 248, 0.42)',
    edge: 'rgba(56, 189, 248, 0.5)',
  },
  audio: {
    label: 'Audio',
    color: '#f59e0b',
    soft: 'rgba(245, 158, 11, 0.18)',
    shadow: 'rgba(245, 158, 11, 0.42)',
    edge: 'rgba(245, 158, 11, 0.48)',
  },
  style: {
    label: 'Style',
    color: '#e879f9',
    soft: 'rgba(232, 121, 249, 0.18)',
    shadow: 'rgba(232, 121, 249, 0.44)',
    edge: 'rgba(232, 121, 249, 0.5)',
  },
  any: {
    label: 'Any',
    color: '#94a3b8',
    soft: 'rgba(148, 163, 184, 0.16)',
    shadow: 'rgba(148, 163, 184, 0.3)',
    edge: 'rgba(148, 163, 184, 0.42)',
  },
})
const FLOW_PORT_LEGEND = Object.freeze(['text', 'image', 'video', 'audio', 'style'])

function resolveFlowPortVisualType(portType = '', portLabel = '') {
  const normalizedType = String(portType || '').trim().toLowerCase()
  const normalizedLabel = String(portLabel || '').trim().toLowerCase()
  if (normalizedType === 'image' && normalizedLabel.includes('style')) return 'style'
  if (FLOW_PORT_VISUALS[normalizedType]) return normalizedType
  return 'any'
}

function getFlowPortVisual(portType = '', portLabel = '') {
  return FLOW_PORT_VISUALS[resolveFlowPortVisualType(portType, portLabel)] || FLOW_PORT_VISUALS.any
}

function getFlowPortDisplayLabel(port = {}) {
  const label = String(port?.label || '').trim()
  if (!label || label.toLowerCase() === 'input') {
    return getFlowPortVisual(port?.type, port?.label).label
  }
  return label
}

function getImageVariantBadge(workflowId = '', variantCount = 1) {
  const behavior = getFlowImageVariantBehavior(workflowId)
  if (behavior.mode === 'fixed') {
    return `${behavior.fixedCount} fixed outputs`
  }
  const normalizedCount = normalizeFlowImageVariantCount(variantCount, workflowId)
  if (normalizedCount <= 1) return ''
  return `${normalizedCount} variants`
}

function getImageVariantInspectorNote(workflowId = '', variantCount = 1) {
  const behavior = getFlowImageVariantBehavior(workflowId)
  if (behavior.mode === 'fixed') {
    return `This workflow already returns ${behavior.fixedCount} images in one run. Branch specific variants later with a selector node.`
  }
  const normalizedCount = normalizeFlowImageVariantCount(variantCount, workflowId)
  if (normalizedCount <= 1) {
    return 'Generate one image from this node. Increase Variants to bundle multiple results into Assets.'
  }
  if (behavior.mode === 'native') {
    return `This workflow will request ${normalizedCount} image variants in one bundled run. Connect it to Asset Output to save the whole set.`
  }
  return `This workflow will run ${normalizedCount} times and bundle the image variants together. Downstream variant picking is not supported yet.`
}

const FLOW_NODE_PREVIEW_TYPES = Object.freeze(['image', 'video', 'audio'])
const FLOW_NODE_PREVIEW_MAX_OUTPUT_ITEMS = 3
const FLOW_NODE_PREVIEW_VISIBILITY_MARGIN_PX = 220
const FLOW_NODE_PREVIEW_VIDEO_STEP_MS = 240
const FLOW_NODE_PREVIEW_AUDIO_SAMPLE_COUNT = 160
const FLOW_NODE_PREVIEW_AUDIO_BAR_COUNT = 28
const FLOW_GRAPH_HISTORY_LIMIT = 60
const FLOW_PASTE_OFFSET_PX = 48
const FLOW_AI_INSPECTOR_WIDTH_STORAGE_KEY = 'comfystudio-flow-ai-inspector-width'
const FLOW_AI_INSPECTOR_DEFAULT_WIDTH = 380
const FLOW_AI_INSPECTOR_MIN_WIDTH = 340
const FLOW_AI_INSPECTOR_MAX_WIDTH = 680

function clampFlowInspectorWidth(width, workspaceWidth = 0) {
  const numeric = Number(width)
  const fallback = FLOW_AI_INSPECTOR_DEFAULT_WIDTH
  const baseWidth = Number.isFinite(numeric) ? numeric : fallback
  let maxWidth = FLOW_AI_INSPECTOR_MAX_WIDTH
  if (Number.isFinite(workspaceWidth) && workspaceWidth > 0) {
    maxWidth = Math.min(
      FLOW_AI_INSPECTOR_MAX_WIDTH,
      Math.max(FLOW_AI_INSPECTOR_MIN_WIDTH, Math.floor(workspaceWidth - 440))
    )
  }
  return Math.max(FLOW_AI_INSPECTOR_MIN_WIDTH, Math.min(maxWidth, Math.round(baseWidth)))
}

function readStoredFlowInspectorWidth() {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return FLOW_AI_INSPECTOR_DEFAULT_WIDTH
  }
  try {
    return clampFlowInspectorWidth(window.localStorage.getItem(FLOW_AI_INSPECTOR_WIDTH_STORAGE_KEY))
  } catch (_) {
    return FLOW_AI_INSPECTOR_DEFAULT_WIDTH
  }
}

function getFlowPreviewKindIcon(kind = '') {
  if (kind === 'image') return ImageIcon
  if (kind === 'video') return Film
  if (kind === 'audio') return Music
  if (kind === 'output') return Download
  return Sparkles
}

function getFlowPreviewKindLabel(kind = '') {
  if (kind === 'image') return 'Image'
  if (kind === 'video') return 'Video'
  if (kind === 'audio') return 'Audio'
  return 'Preview'
}

function isFlowNodeRunnable(nodeType = '') {
  return getFlowNodeSupportsExecution(nodeType) || nodeType === FLOW_AI_NODE_TYPES.output
}

function getFlowNodeResetStatusMessage(nodeType = '') {
  if (nodeType === FLOW_AI_NODE_TYPES.promptAssist) return 'Write a brief or connect a Prompt node, then run to refine it.'
  if (nodeType === FLOW_AI_NODE_TYPES.textViewer) return 'Connect a text-producing node to inspect it here.'
  if (nodeType === FLOW_AI_NODE_TYPES.imageInput) return 'Pick an asset from the project.'
  if (nodeType === FLOW_AI_NODE_TYPES.styleReference) return 'Optional reference for edit-capable image workflows.'
  if (nodeType === FLOW_AI_NODE_TYPES.videoUpscale) return 'Connect a video branch and run to upscale it.'
  if (nodeType === FLOW_AI_NODE_TYPES.output) return 'Sends connected results to the Assets panel.'
  return ''
}

function buildFlowGraphNodeSnapshot(node, options = {}) {
  if (!node?.id || !node?.type) return null
  const rawData = node?.data && typeof node.data === 'object' ? node.data : {}
  const nextData = Object.fromEntries(
    Object.entries(rawData).filter(([key]) => !String(key || '').startsWith('_'))
  )
  nextData.status = 'idle'
  nextData.statusMessage = getFlowNodeResetStatusMessage(node.type)
  nextData.error = ''
  nextData.progress = 0
  nextData.lastPromptId = null
  nextData.lastRunAt = null
  if (!options.preserveOutputs) {
    nextData.outputAssetIds = []
    nextData.resolvedAssetIds = []
    if (Object.prototype.hasOwnProperty.call(nextData, 'outputText')) {
      nextData.outputText = ''
    }
  }
  const snapshot = {
    id: options.id || String(node.id),
    type: String(node.type),
    position: {
      x: Number(node?.position?.x) || 0,
      y: Number(node?.position?.y) || 0,
    },
    data: nextData,
    ...(options.selected ? { selected: true } : {}),
  }
  if (node?.style && typeof node.style === 'object') {
    const width = Number(node.style.width)
    const height = Number(node.style.height)
    const preservedStyle = {}
    if (Number.isFinite(width) && width > 0) preservedStyle.width = width
    if (Number.isFinite(height) && height > 0) preservedStyle.height = height
    if (Object.keys(preservedStyle).length > 0) {
      snapshot.style = preservedStyle
    }
  }
  return snapshot
}

function buildFlowGraphEdgeSnapshot(edge, options = {}) {
  if (!edge?.source || !edge?.target) return null
  return {
    id: options.id || String(edge.id || `flow_edge_${Date.now()}`),
    source: String(options.source || edge.source),
    target: String(options.target || edge.target),
    sourceHandle: options.sourceHandle !== undefined ? options.sourceHandle : (edge.sourceHandle || null),
    targetHandle: options.targetHandle !== undefined ? options.targetHandle : (edge.targetHandle || null),
    animated: false,
    ...(options.selected ? { selected: true } : {}),
  }
}

function buildFlowGraphHistorySnapshot(nodes = [], edges = []) {
  const snapshot = {
    nodes: (nodes || []).map((node) => buildFlowGraphNodeSnapshot(node, { preserveOutputs: true })).filter(Boolean),
    edges: (edges || []).map((edge) => buildFlowGraphEdgeSnapshot(edge)).filter(Boolean),
  }
  return {
    ...snapshot,
    signature: JSON.stringify(snapshot),
  }
}

function buildFlowClipboardPayload(nodes = [], edges = [], selectedNodeIds = []) {
  const selectedIdSet = new Set((selectedNodeIds || []).filter(Boolean))
  const copiedNodes = (nodes || [])
    .filter((node) => selectedIdSet.has(node.id))
    .map((node) => buildFlowGraphNodeSnapshot(node, { preserveOutputs: false }))
    .filter(Boolean)
  const copiedEdges = (edges || [])
    .filter((edge) => selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target))
    .map((edge) => buildFlowGraphEdgeSnapshot(edge))
    .filter(Boolean)
  return {
    nodes: copiedNodes,
    edges: copiedEdges,
    pasteCount: 0,
  }
}

function cloneFlowClipboardPayload(payload, pasteCount = 1) {
  const normalizedPasteCount = Math.max(1, Number(pasteCount) || 1)
  const offset = FLOW_PASTE_OFFSET_PX * normalizedPasteCount
  const nodeIdMap = new Map()
  const nodes = (payload?.nodes || []).map((node) => {
    const cloned = buildFlowGraphNodeSnapshot(node, {
      id: `${node.id}_copy_${Math.random().toString(36).slice(2, 8)}`,
      preserveOutputs: false,
      selected: true,
    })
    if (!cloned) return null
    cloned.position = {
      x: (Number(node?.position?.x) || 0) + offset,
      y: (Number(node?.position?.y) || 0) + offset,
    }
    nodeIdMap.set(node.id, cloned.id)
    return cloned
  }).filter(Boolean)

  const edges = (payload?.edges || []).map((edge) => {
    const source = nodeIdMap.get(edge.source)
    const target = nodeIdMap.get(edge.target)
    if (!source || !target) return null
    return buildFlowGraphEdgeSnapshot(edge, {
      id: `${edge.id}_copy_${Math.random().toString(36).slice(2, 8)}`,
      source,
      target,
      selected: false,
    })
  }).filter(Boolean)

  return { nodes, edges }
}

function hasMeaningfulFlowNodeChanges(changes = []) {
  return (changes || []).some((change) => {
    if (!change) return false
    if (change.type === 'select' || change.type === 'dimensions') return false
    if (change.type === 'position') return false
    return true
  })
}

function hasMeaningfulFlowEdgeChanges(changes = []) {
  return (changes || []).some((change) => change && change.type !== 'select')
}

function isTypingTarget(target) {
  return target instanceof HTMLElement
    && (
      target.tagName === 'INPUT'
      || target.tagName === 'TEXTAREA'
      || target.tagName === 'SELECT'
      || target.isContentEditable
    )
}

function getFlowPreviewAssetKind(asset = null) {
  const normalizedType = String(asset?.type || '').trim().toLowerCase()
  if (normalizedType === 'mask') return 'image'
  return FLOW_NODE_PREVIEW_TYPES.includes(normalizedType) ? normalizedType : ''
}

function getFlowPreviewAssetLabel(asset = null) {
  return String(asset?.name || asset?.path || asset?.id || '').trim()
}

function getFlowPreviewAssetUrl(asset = null) {
  if (!asset) return ''
  if (asset.type === 'video' && asset.playbackCacheUrl && hasUsablePlaybackCache(asset)) {
    return String(asset.playbackCacheUrl || '')
  }
  return String(asset.url || '')
}

function sanitizeFlowPreviewSprite(sprite = null) {
  if (!sprite?.frames?.length || !sprite?.url) return null
  return {
    url: sprite.url,
    width: Number(sprite.width) || 0,
    height: Number(sprite.height) || 0,
    frameWidth: Number(sprite.frameWidth) || 0,
    frameHeight: Number(sprite.frameHeight) || 0,
    frameCount: Number(sprite.frameCount) || sprite.frames.length || 0,
    framesPerRow: Number(sprite.framesPerRow) || 0,
    duration: Number(sprite.duration) || 0,
    frameInterval: Number(sprite.frameInterval) || 0,
    frames: sprite.frames,
  }
}

function createFlowPreviewItem(asset = null, options = {}) {
  const kind = getFlowPreviewAssetKind(asset)
  if (!asset?.id || !kind) return null
  return {
    assetId: asset.id,
    key: `${asset.id}:${kind}`,
    kind,
    label: getFlowPreviewAssetLabel(asset),
    url: getFlowPreviewAssetUrl(asset),
    duration: Number(asset?.duration || asset?.settings?.duration || 0) || 0,
    sprite: sanitizeFlowPreviewSprite(asset?.sprite),
    spriteGenerating: Boolean(asset?.spriteGenerating),
    count: Math.max(1, Number(options.count) || 1),
  }
}

function buildFlowPreviewPlaceholder(node) {
  const isBusy = FLOW_BUSY_STATUSES.has(String(node?.data?.status || ''))
  switch (node?.type) {
    case FLOW_AI_NODE_TYPES.imageInput:
      return {
        kind: 'image',
        tone: 'neutral',
        title: 'No source asset yet',
        hint: 'Choose an image or video to feed this branch.',
      }
    case FLOW_AI_NODE_TYPES.styleReference:
      return {
        kind: 'image',
        tone: 'neutral',
        title: 'No style reference yet',
        hint: 'Pick a reference image to guide the look.',
      }
    case FLOW_AI_NODE_TYPES.imageGen:
      return {
        kind: 'image',
        tone: isBusy ? 'processing' : 'neutral',
        title: isBusy ? 'Generating image preview' : 'Run node to see image output',
        hint: isBusy ? 'The latest result will appear here.' : 'Latest generated image variants preview here.',
      }
    case FLOW_AI_NODE_TYPES.videoGen:
      return {
        kind: 'video',
        tone: isBusy ? 'processing' : 'neutral',
        title: isBusy ? 'Generating video preview' : 'Run node to see video output',
        hint: isBusy ? 'A live motion preview will appear after render.' : 'Sprite-based motion preview appears here.',
      }
    case FLOW_AI_NODE_TYPES.videoUpscale:
      return {
        kind: 'video',
        tone: isBusy ? 'processing' : 'neutral',
        title: isBusy ? 'Upscaling video preview' : 'Run node to see upscaled output',
        hint: isBusy ? 'The Topaz result will appear here when it finishes.' : 'Connect a video and the upscaled clip will preview here.',
      }
    case FLOW_AI_NODE_TYPES.musicGen:
      return {
        kind: 'audio',
        tone: isBusy ? 'processing' : 'neutral',
        title: isBusy ? 'Generating audio preview' : 'Run node to see audio output',
        hint: isBusy ? 'Waveform preview updates when the result lands.' : 'Waveform preview appears here after render.',
      }
    case FLOW_AI_NODE_TYPES.output:
      return {
        kind: 'output',
        tone: 'neutral',
        title: 'Awaiting final assets',
        hint: 'Connected image, video, and audio results preview here.',
      }
    default:
      return null
  }
}

function buildOutputPreviewItems(assetIds = [], assetById = new Map()) {
  const grouped = new Map()
  for (const assetId of assetIds || []) {
    const asset = assetById.get(assetId)
    const kind = getFlowPreviewAssetKind(asset)
    if (!asset || !kind) continue
    const existing = grouped.get(kind)
    if (existing) {
      existing.count += 1
      continue
    }
    const item = createFlowPreviewItem(asset, { count: 1 })
    if (item) grouped.set(kind, item)
  }

  return FLOW_NODE_PREVIEW_TYPES
    .map((kind) => grouped.get(kind))
    .filter(Boolean)
    .slice(0, FLOW_NODE_PREVIEW_MAX_OUTPUT_ITEMS)
}

function buildFlowNodePreviewPayload(node, assetById = new Map()) {
  if (!node) return { items: [], placeholder: null }

  if (node.type === FLOW_AI_NODE_TYPES.imageInput || node.type === FLOW_AI_NODE_TYPES.styleReference) {
    const asset = assetById.get(String(node?.data?.assetId || '').trim())
    const item = createFlowPreviewItem(asset)
    return {
      items: item ? [item] : [],
      placeholder: item ? null : buildFlowPreviewPlaceholder(node),
    }
  }

  if (node.type === FLOW_AI_NODE_TYPES.output) {
    const items = buildOutputPreviewItems(node?.data?.resolvedAssetIds || [], assetById)
    return {
      items,
      placeholder: items.length > 0 ? null : buildFlowPreviewPlaceholder(node),
    }
  }

  if (
    node.type === FLOW_AI_NODE_TYPES.imageGen
    || node.type === FLOW_AI_NODE_TYPES.videoGen
    || node.type === FLOW_AI_NODE_TYPES.videoUpscale
    || node.type === FLOW_AI_NODE_TYPES.musicGen
  ) {
    const outputAssetIds = Array.isArray(node?.data?.outputAssetIds) ? node.data.outputAssetIds : []
    const firstAsset = outputAssetIds.map((assetId) => assetById.get(assetId)).find(Boolean)
    const item = createFlowPreviewItem(firstAsset, { count: outputAssetIds.length })
    return {
      items: item ? [item] : [],
      placeholder: item ? null : buildFlowPreviewPlaceholder(node),
    }
  }

  return { items: [], placeholder: null }
}

function isFlowNodePreviewVisible(node, viewport, canvasBounds) {
  if (!canvasBounds?.width || !canvasBounds?.height) return true
  const zoom = Number(viewport?.zoom) || 1
  const offsetX = Number(viewport?.x) || 0
  const offsetY = Number(viewport?.y) || 0
  const nodeX = Number(node?.positionAbsolute?.x ?? node?.position?.x ?? 0)
  const nodeY = Number(node?.positionAbsolute?.y ?? node?.position?.y ?? 0)
  const nodeWidth = (Number(node?.measured?.width) || Number(node?.width) || 260) * zoom
  const nodeHeight = (Number(node?.measured?.height) || Number(node?.height) || 240) * zoom
  const screenLeft = (nodeX * zoom) + offsetX
  const screenTop = (nodeY * zoom) + offsetY
  const screenRight = screenLeft + nodeWidth
  const screenBottom = screenTop + nodeHeight
  return (
    screenRight >= -FLOW_NODE_PREVIEW_VISIBILITY_MARGIN_PX
    && screenBottom >= -FLOW_NODE_PREVIEW_VISIBILITY_MARGIN_PX
    && screenLeft <= canvasBounds.width + FLOW_NODE_PREVIEW_VISIBILITY_MARGIN_PX
    && screenTop <= canvasBounds.height + FLOW_NODE_PREVIEW_VISIBILITY_MARGIN_PX
  )
}

function sampleFlowWaveformBars(peaks = [], targetCount = FLOW_NODE_PREVIEW_AUDIO_BAR_COUNT) {
  if (!peaks?.length) return []
  const bars = []
  for (let index = 0; index < targetCount; index += 1) {
    const start = Math.floor((index / targetCount) * peaks.length)
    const end = Math.max(start + 1, Math.floor(((index + 1) / targetCount) * peaks.length))
    let peak = 0
    for (let cursor = start; cursor < end; cursor += 1) {
      peak = Math.max(peak, Number(peaks[cursor] || 0))
    }
    bars.push(Math.max(0.12, Math.min(1, peak)))
  }
  return bars
}

const FlowPreviewPlaceholder = memo(function FlowPreviewPlaceholder({ placeholder, active }) {
  if (!placeholder) return null
  const Icon = getFlowPreviewKindIcon(placeholder.kind)
  const isProcessing = placeholder.tone === 'processing'
  return (
    <div className={`relative overflow-hidden rounded-xl border px-3 py-3 ${
      isProcessing
        ? 'border-sky-400/25 bg-sky-400/8'
        : 'border-sf-dark-700 bg-sf-dark-950/80'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`rounded-lg border p-2 ${
          isProcessing
            ? 'border-sky-400/35 bg-sky-400/10 text-sky-200'
            : 'border-white/10 bg-sf-dark-900 text-sf-text-muted'
        }`}>
          {isProcessing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Icon className="h-4 w-4" />
          )}
        </div>
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-sf-text-primary">
            {placeholder.title}
          </div>
          <div className="mt-1 text-[10px] leading-5 text-sf-text-muted">
            {placeholder.hint}
          </div>
        </div>
      </div>
      <div
        className="pointer-events-none absolute inset-x-[-35%] top-0 h-full bg-gradient-to-r from-transparent via-white/8 to-transparent"
        style={{
          animation: 'flow-ai-preview-sheen 2.6s linear infinite',
          animationPlayState: active ? 'running' : 'paused',
          opacity: isProcessing ? 1 : 0.45,
        }}
      />
    </div>
  )
})

const FlowAudioPreview = memo(function FlowAudioPreview({ url, active }) {
  const [waveform, setWaveform] = useState(null)

  useEffect(() => {
    let cancelled = false
    if (!url) {
      setWaveform(null)
      return () => {
        cancelled = true
      }
    }
    if (!active) {
      return () => {
        cancelled = true
      }
    }

    getAudioWaveformData(url, FLOW_NODE_PREVIEW_AUDIO_SAMPLE_COUNT)
      .then((result) => {
        if (!cancelled) setWaveform(result)
      })
      .catch(() => {
        if (!cancelled) setWaveform(null)
      })

    return () => {
      cancelled = true
    }
  }, [active, url])

  const bars = useMemo(
    () => sampleFlowWaveformBars(waveform?.peaks || [], FLOW_NODE_PREVIEW_AUDIO_BAR_COUNT),
    [waveform]
  )

  return (
    <div className="relative h-full w-full overflow-hidden bg-[linear-gradient(180deg,rgba(245,158,11,0.12),rgba(9,9,11,0.95))]">
      <div className="absolute inset-0 flex items-center gap-[2px] px-2.5">
        {(bars.length > 0 ? bars : new Array(FLOW_NODE_PREVIEW_AUDIO_BAR_COUNT).fill(0.22)).map((value, index) => (
          <div
            key={index}
            className="min-w-0 flex-1 rounded-full bg-amber-300/80"
            style={{
              height: `${Math.max(16, value * 100)}%`,
              opacity: Math.max(0.3, value),
            }}
          />
        ))}
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-[-38%] w-[32%] bg-gradient-to-r from-transparent via-white/18 to-transparent mix-blend-screen"
        style={{
          animation: 'flow-ai-audio-scan 2.8s linear infinite',
          animationPlayState: active ? 'running' : 'paused',
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-white/6" />
    </div>
  )
})

const FlowPreviewTile = memo(function FlowPreviewTile({ item, active, previewStep, compact = false }) {
  const framePosition = useMemo(() => {
    if (item?.kind !== 'video' || !item?.sprite?.frames?.length) return null
    const totalFrames = Math.max(1, Number(item.sprite.frameCount) || item.sprite.frames.length || 1)
    if (totalFrames <= 1) {
      return getSpriteFramePosition(item.sprite, 0)
    }
    const cycleSpan = Math.max(1, (totalFrames - 1) * 2)
    const cursor = Math.abs(Number(previewStep) || 0) % cycleSpan
    const pingPongFrame = cursor < totalFrames ? cursor : (cycleSpan - cursor)
    const duration = Math.max(0.001, Number(item.sprite.duration) || Number(item.duration) || 1)
    const time = (pingPongFrame / Math.max(1, totalFrames - 1)) * duration
    return getSpriteFramePosition(item.sprite, time)
  }, [item, previewStep])

  const spriteStyle = useMemo(() => {
    if (!item?.sprite?.url || !item?.sprite?.frameWidth || !item?.sprite?.frameHeight || !framePosition) return null
    return {
      width: `${(item.sprite.width / item.sprite.frameWidth) * 100}%`,
      height: `${(item.sprite.height / item.sprite.frameHeight) * 100}%`,
      left: `-${(framePosition.x / item.sprite.frameWidth) * 100}%`,
      top: `-${(framePosition.y / item.sprite.frameHeight) * 100}%`,
      backgroundImage: `url(${item.sprite.url})`,
      backgroundSize: '100% 100%',
      backgroundRepeat: 'no-repeat',
    }
  }, [framePosition, item])

  const countLabel = item?.count > 1 ? `+${item.count - 1}` : ''
  const itemKindLabel = getFlowPreviewKindLabel(item?.kind)
  const isVideoWithoutSprite = item?.kind === 'video' && !spriteStyle
  const FallbackIcon = getFlowPreviewKindIcon(item?.kind)

  return (
    <div className={`relative overflow-hidden rounded-xl border border-white/8 bg-sf-dark-950/85 ${
      compact ? 'h-24' : 'h-28'
    }`}>
      {item?.kind === 'image' && item?.url && (
        <>
          <img
            src={item.url}
            alt={item.label || itemKindLabel}
            className="flow-ai-preview-drift h-full w-full object-cover"
            style={{ animationPlayState: active ? 'running' : 'paused' }}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-white/5" />
        </>
      )}

      {item?.kind === 'video' && spriteStyle && (
        <>
          <div className="absolute inset-0 overflow-hidden">
            <div
              className="absolute"
              style={spriteStyle}
            />
          </div>
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-white/5" />
        </>
      )}

      {item?.kind === 'audio' && item?.url && (
        <FlowAudioPreview url={item.url} active={active} />
      )}

      {isVideoWithoutSprite && (
        <div className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(180deg,rgba(56,189,248,0.14),rgba(9,9,11,0.96))]">
          <div className="text-center">
            <div className="mx-auto inline-flex rounded-full border border-sky-400/30 bg-sky-400/12 p-2 text-sky-200">
              {item?.spriteGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
            </div>
            <div className="mt-2 text-[10px] font-medium text-sf-text-primary">
              {item?.spriteGenerating ? 'Building motion preview' : 'Preparing motion preview'}
            </div>
          </div>
        </div>
      )}

      {!item?.url && item?.kind !== 'video' && (
        <div className="absolute inset-0 flex items-center justify-center bg-sf-dark-950/90">
          <div className="rounded-full border border-white/10 bg-sf-dark-900 p-2 text-sf-text-muted">
            <FallbackIcon className="h-4 w-4" />
          </div>
        </div>
      )}

      <div className="absolute left-2 top-2 rounded-full border border-black/10 bg-black/55 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-white/88 backdrop-blur">
        {itemKindLabel}
      </div>
      {countLabel && (
        <div className="absolute right-2 top-2 rounded-full border border-sf-accent/30 bg-sf-accent/18 px-2 py-0.5 text-[10px] font-semibold text-white">
          {countLabel}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 px-2.5 py-2">
        <div className="truncate text-[10px] font-medium text-white/92">
          {item?.label || itemKindLabel}
        </div>
      </div>
    </div>
  )
})

const FlowNodePreview = memo(function FlowNodePreview({
  type,
  previewItems,
  previewPlaceholder,
  previewActive,
  previewStep,
}) {
  if (type === FLOW_AI_NODE_TYPES.prompt) return null
  if (!previewItems?.length && !previewPlaceholder) return null

  if (!previewItems?.length) {
    return (
      <div className="mt-3">
        <FlowPreviewPlaceholder placeholder={previewPlaceholder} active={previewActive} />
      </div>
    )
  }

  if (type === FLOW_AI_NODE_TYPES.output && previewItems.length > 1) {
    return (
      <div className={`mt-3 grid gap-2 ${previewItems.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
        {previewItems.slice(0, FLOW_NODE_PREVIEW_MAX_OUTPUT_ITEMS).map((item) => (
          <FlowPreviewTile
            key={item.key}
            item={item}
            active={previewActive}
            previewStep={previewStep}
            compact
          />
        ))}
      </div>
    )
  }

  return (
    <div className="mt-3">
      <FlowPreviewTile
        item={previewItems[0]}
        active={previewActive}
        previewStep={previewStep}
      />
    </div>
  )
})

const FlowCanvasEdge = memo(function FlowCanvasEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  selected,
  data,
}) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })

  const isActive = Boolean(data?.isActive)
  const portVisual = getFlowPortVisual(data?.portType, data?.portLabel)
  const activeColor = portVisual.color
  const idleColor = selected ? activeColor : portVisual.edge

  return (
    <g>
      {isActive && (
        <BaseEdge
          path={edgePath}
          interactionWidth={28}
          style={{
            stroke: activeColor,
            strokeOpacity: 0.18,
            strokeWidth: 10,
            ...style,
          }}
        />
      )}
      <BaseEdge
        path={edgePath}
        interactionWidth={28}
        style={{
          stroke: isActive ? activeColor : idleColor,
          strokeWidth: isActive ? 2.6 : 1.6,
          filter: isActive ? `drop-shadow(0 0 6px ${portVisual.shadow})` : 'none',
          ...style,
        }}
      />
      {isActive && (
        <g pointerEvents="none">
          {[0, -0.45, -0.9].map((begin, index) => (
            <circle
              key={String(begin)}
              r={index === 0 ? 3.5 : 2.75}
              fill={activeColor}
              opacity={index === 0 ? 0.95 : 0.75}
            >
              <animateMotion
                dur="1.4s"
                repeatCount="indefinite"
                begin={`${begin}s`}
                path={edgePath}
              />
            </circle>
          ))}
        </g>
      )}
      {selected && typeof data?.onDisconnect === 'function' && (
        <EdgeLabelRenderer>
          <button
            type="button"
            title="Disconnect edge"
            aria-label="Disconnect edge"
            className="nodrag nopan absolute flex h-6 w-6 items-center justify-center rounded-full border border-red-500/40 bg-sf-dark-950/95 text-red-200 shadow-lg transition-colors hover:bg-red-500/15"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            onMouseDown={(event) => {
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              data.onDisconnect(id)
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </EdgeLabelRenderer>
      )}
    </g>
  )
})

const FLOW_NODE_MIN_WIDTH = 240
const FLOW_NODE_MIN_HEIGHT = 140
const FLOW_NODE_MAX_WIDTH = 900
const FLOW_NODE_MAX_HEIGHT = 1400

const FlowCanvasActionsContext = createContext(null)

const FLOW_REACT_FLOW_PRO_OPTIONS = Object.freeze({ hideAttribution: true })

const FLOW_RESIZER_LINE_STYLE = {
  borderColor: 'transparent',
  borderWidth: 1,
}
const FLOW_RESIZER_HANDLE_STYLE = {
  width: 24,
  height: 24,
  backgroundColor: 'transparent',
  borderColor: 'transparent',
  borderWidth: 0,
}

const FlowNodeResizerControls = memo(function FlowNodeResizerControls({ selected }) {
  const flowActions = useContext(FlowCanvasActionsContext)
  const handleResizeStart = useCallback(() => {
    flowActions?.onResizeStart?.()
  }, [flowActions])
  return (
    <NodeResizer
      isVisible={selected}
      minWidth={FLOW_NODE_MIN_WIDTH}
      minHeight={FLOW_NODE_MIN_HEIGHT}
      maxWidth={FLOW_NODE_MAX_WIDTH}
      maxHeight={FLOW_NODE_MAX_HEIGHT}
      lineStyle={FLOW_RESIZER_LINE_STYLE}
      handleStyle={FLOW_RESIZER_HANDLE_STYLE}
      onResizeStart={handleResizeStart}
    />
  )
})

const FlowCanvasNode = memo(function FlowCanvasNode({ data, selected, type }) {
  const definition = getFlowNodeDefinition(type)
  const Icon = getNodeIcon(type)
  const inputCount = definition?.inputs?.length || 0
  const outputCount = definition?.outputs?.length || 0
  const statusLabel = buildNodeStatusSummary({ data })
  const workflowLabel = formatRuntimeLabel(data?.workflowId)
  const isBusy = FLOW_BUSY_STATUSES.has(String(data?.status || ''))
  const outputCountLabel = Array.isArray(data?.outputAssetIds)
    ? data.outputAssetIds.length
    : Array.isArray(data?.resolvedAssetIds)
      ? data.resolvedAssetIds.length
      : 0
  const inputPorts = definition?.inputs || []
  const outputPorts = definition?.outputs || []
  const activeConnectionHandleId = String(data?._activeConnectionHandleId || '')
  const activeConnectionHandleType = String(data?._activeConnectionHandleType || '')
  const imageVariantBadge = type === FLOW_AI_NODE_TYPES.imageGen
    ? getImageVariantBadge(data?.workflowId, data?.variantCount)
    : ''
  const previewItems = Array.isArray(data?._previewItems) ? data._previewItems : []
  const previewPlaceholder = data?._previewPlaceholder || null
  const previewActive = Boolean(data?._previewAnimated)
  const previewStep = Number(data?._previewStep || 0)
  const liveCreditsLabel = (
    type === FLOW_AI_NODE_TYPES.videoUpscale && data?.estimatedCredits
      ? formatCreditsRange(data.estimatedCredits)
      : ''
  )

  return (
    <div
      className={`relative flex h-full w-full flex-col rounded-xl border bg-sf-dark-900/95 shadow-xl backdrop-blur-sm ${
        selected
          ? 'border-sf-accent shadow-sf-accent/10'
          : isBusy
            ? 'border-sky-400/70 shadow-[0_0_18px_rgba(56,189,248,0.16)]'
            : 'border-sf-dark-700'
      }`}
      style={{ minWidth: FLOW_NODE_MIN_WIDTH, minHeight: FLOW_NODE_MIN_HEIGHT }}
    >
      <FlowNodeResizerControls selected={selected} />
      {inputPorts.map((input, index) => {
        const portVisual = getFlowPortVisual(input.type, input.label)
        const isCandidate = activeConnectionHandleType === 'source'
          && isValidFlowConnection({ sourceHandle: activeConnectionHandleId, targetHandle: input.id })
        return (
          <Handle
            key={input.id}
            type="target"
            position={Position.Left}
            id={input.id}
            title={`Input: ${getFlowPortDisplayLabel(input)}`}
            isValidConnection={(connection) => isValidFlowConnection({ ...connection, targetHandle: input.id })}
            className="!h-3.5 !w-3.5 !border-2 transition-all duration-150"
            style={{
              top: 36 + (index * 24),
              left: -8,
              backgroundColor: portVisual.color,
              borderColor: isCandidate ? portVisual.color : 'rgba(9, 9, 11, 0.96)',
              boxShadow: isCandidate
                ? `0 0 0 3px ${portVisual.soft}, 0 0 14px ${portVisual.shadow}`
                : `0 0 0 1px rgba(9, 9, 11, 0.96), 0 0 0 2px ${portVisual.soft}`,
            }}
          />
        )
      })}

      {outputPorts.map((output, index) => {
        const portVisual = getFlowPortVisual(output.type, output.label)
        const isCandidate = activeConnectionHandleType === 'target'
          && isValidFlowConnection({ sourceHandle: output.id, targetHandle: activeConnectionHandleId })
        return (
          <Handle
            key={output.id}
            type="source"
            position={Position.Right}
            id={output.id}
            title={`Output: ${getFlowPortDisplayLabel(output)}`}
            isValidConnection={(connection) => isValidFlowConnection({ ...connection, sourceHandle: output.id })}
            className="!h-3.5 !w-3.5 !border-2 transition-all duration-150"
            style={{
              top: 36 + (index * 24),
              right: -8,
              backgroundColor: portVisual.color,
              borderColor: isCandidate ? portVisual.color : 'rgba(9, 9, 11, 0.96)',
              boxShadow: isCandidate
                ? `0 0 0 3px ${portVisual.soft}, 0 0 14px ${portVisual.shadow}`
                : `0 0 0 1px rgba(9, 9, 11, 0.96), 0 0 0 2px ${portVisual.soft}`,
            }}
          />
        )
      })}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 rounded-lg border p-2 ${
            isBusy
              ? 'border-sky-400/40 bg-sky-400/10 animate-pulse'
              : 'border-white/10 bg-sf-dark-800'
          }`}>
            <Icon className="h-4 w-4 text-sf-text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="truncate text-sm font-semibold text-sf-text-primary">
                {data?.label || definition?.label || 'Node'}
              </div>
              <div className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                data?.status === 'done'
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : data?.status === 'error'
                    ? 'bg-red-500/15 text-red-300'
                    : data?.status === 'running' || data?.status === 'checking' || data?.status === 'queuing'
                      ? 'bg-sky-500/15 text-sky-300'
                      : data?.status === 'blocked'
                        ? 'bg-amber-500/15 text-amber-300'
                        : 'bg-sf-dark-800 text-sf-text-muted'
              }`}>
                {isBusy && (
                  <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-sky-300 animate-pulse" />
                )}
                {statusLabel}
              </div>
            </div>
            <div className="mt-1 text-[11px] text-sf-text-muted">
              {workflowLabel || definition?.description}
            </div>
            {imageVariantBadge && (
              <div className="mt-2 inline-flex items-center rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-1 text-[10px] font-medium text-sky-300">
                {imageVariantBadge}
              </div>
            )}

            <FlowNodePreview
              type={type}
              previewItems={previewItems}
              previewPlaceholder={previewPlaceholder}
              previewActive={previewActive}
              previewStep={previewStep}
            />
          </div>
        </div>

        {(type === FLOW_AI_NODE_TYPES.prompt || type === FLOW_AI_NODE_TYPES.musicGen || type === FLOW_AI_NODE_TYPES.promptAssist || type === FLOW_AI_NODE_TYPES.textViewer) && (
          <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950/70 px-3 py-2 text-[11px] text-sf-text-secondary">
            {type === FLOW_AI_NODE_TYPES.prompt
              ? (String(data?.promptText || '').trim() || 'No prompt yet.')
              : type === FLOW_AI_NODE_TYPES.musicGen
                ? (String(data?.tags || '').trim() || 'No music tags yet.')
                : type === FLOW_AI_NODE_TYPES.promptAssist
                  ? (String(data?.outputText || '').trim() || String(data?.inlinePrompt || '').trim() || 'Run to generate a refined prompt.')
                  : (String(data?._resolvedText || '').trim() || 'Connect text to inspect it here.')}
          </div>
        )}

        {(type === FLOW_AI_NODE_TYPES.imageInput || type === FLOW_AI_NODE_TYPES.styleReference) && (
          <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950/70 px-3 py-2 text-[11px] text-sf-text-secondary">
            {data?.assetLabel || 'No asset selected.'}
          </div>
        )}

        {type === FLOW_AI_NODE_TYPES.output && (
          <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-950/70 px-3 py-2 text-[11px] text-sf-text-secondary">
            <div className="font-medium text-sf-text-primary break-words">
              {formatAssetOutputDestinationSummary(data?.folderName)}
            </div>
            <div className="mt-1">
              {outputCountLabel > 0
                ? `${outputCountLabel} connected asset${outputCountLabel === 1 ? '' : 's'}`
                : (String(data?.folderName || '').trim()
                  ? 'Connect final image, video, or audio branches here.'
                  : 'Blank folder name auto-sorts images, videos, and audio into media folders.')}
            </div>
          </div>
        )}

        {type !== FLOW_AI_NODE_TYPES.output && type !== FLOW_AI_NODE_TYPES.prompt && type !== FLOW_AI_NODE_TYPES.imageInput && type !== FLOW_AI_NODE_TYPES.styleReference && outputCountLabel > 0 && (
          <div className="mt-3 inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-300">
            {type === FLOW_AI_NODE_TYPES.imageGen && outputCountLabel > 1
              ? `${outputCountLabel} image variants`
              : `${outputCountLabel} output asset${outputCountLabel === 1 ? '' : 's'}`}
          </div>
        )}

        {liveCreditsLabel && (
          <div className="mt-3 inline-flex items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[10px] font-medium text-amber-200">
            Est. {liveCreditsLabel}
          </div>
        )}

        {data?.statusMessage && (
          <div className="mt-3 text-[11px] text-sf-text-muted">
            {data.statusMessage}
          </div>
        )}

        {data?.error && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
            {data.error}
          </div>
        )}

        {(inputCount > 0 || outputCount > 0) && (
          <div className="mt-3 space-y-1.5 text-[10px]">
            {inputCount > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="uppercase tracking-[0.18em] text-sf-text-muted">
                  In
                </span>
                {inputPorts.map((input) => {
                  const portVisual = getFlowPortVisual(input.type, input.label)
                  return (
                    <span
                      key={input.id}
                      className="inline-flex items-center rounded-full border px-2 py-0.5 font-medium"
                      style={{
                        borderColor: portVisual.edge,
                        backgroundColor: portVisual.soft,
                        color: portVisual.color,
                      }}
                    >
                      {getFlowPortDisplayLabel(input)}
                    </span>
                  )
                })}
              </div>
            )}
            {outputCount > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="uppercase tracking-[0.18em] text-sf-text-muted">
                  Out
                </span>
                {outputPorts.map((output) => {
                  const portVisual = getFlowPortVisual(output.type, output.label)
                  return (
                    <span
                      key={output.id}
                      className="inline-flex items-center rounded-full border px-2 py-0.5 font-medium"
                      style={{
                        borderColor: portVisual.edge,
                        backgroundColor: portVisual.soft,
                        color: portVisual.color,
                      }}
                    >
                      {getFlowPortDisplayLabel(output)}
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

function InspectorRow({ label, children }) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-sf-text-secondary">
        {label}
      </div>
      {children}
    </label>
  )
}

function renderWorkflowOptions(nodeType) {
  if (nodeType === FLOW_AI_NODE_TYPES.promptAssist) return getFlowTextWorkflowOptions()
  if (nodeType === FLOW_AI_NODE_TYPES.imageGen) return getFlowImageWorkflowOptions()
  if (nodeType === FLOW_AI_NODE_TYPES.videoGen) return getFlowVideoWorkflowOptions()
  if (nodeType === FLOW_AI_NODE_TYPES.videoUpscale) return getFlowVideoUpscaleWorkflowOptions()
  if (nodeType === FLOW_AI_NODE_TYPES.musicGen) return getFlowAudioWorkflowOptions()
  return []
}

export default function FlowAIWorkspace({ onOpenWorkflowSetup }) {
  const currentProject = useProjectStore((state) => state.currentProject)
  const currentProjectHandle = useProjectStore((state) => state.currentProjectHandle)
  const setFlowAiData = useProjectStore((state) => state.setFlowAiData)
  const saveProject = useProjectStore((state) => state.saveProject)
  const assets = useAssetsStore((state) => state.assets)
  const generateAssetSprite = useAssetsStore((state) => state.generateAssetSprite)
  const setPreview = useAssetsStore((state) => state.setPreview)
  const assetById = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset])),
    [assets]
  )

  const projectKey = useMemo(() => {
    if (typeof currentProjectHandle === 'string' && currentProjectHandle) return currentProjectHandle
    return currentProject?.name || 'flow-ai-project'
  }, [currentProject?.name, currentProjectHandle])

  const initialFlowState = useMemo(
    () => normalizeFlowAiProjectData(currentProject?.flowAi),
    [currentProject?.flowAi]
  )

  const [flowProjectData, setFlowProjectState] = useState(initialFlowState)
  const [activeDocumentId, setActiveDocumentId] = useState(initialFlowState.activeDocumentId)
  const activeDocument = useMemo(() => {
    return flowProjectData.documents.find((document) => document.id === activeDocumentId) || flowProjectData.documents[0]
  }, [activeDocumentId, flowProjectData])

  const [nodes, setNodes] = useNodesState(activeDocument?.nodes || [])
  const [edges, setEdges] = useEdgesState(activeDocument?.edges || [])
  const [viewport, setViewport] = useState(activeDocument?.viewport || { x: 0, y: 0, zoom: 0.9 })
  const [selectedNodeId, setSelectedNodeId] = useState(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState('blank')
  const [isRunning, setIsRunning] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [runNotice, setRunNotice] = useState('')
  const [completionNotice, setCompletionNotice] = useState(null)
  const [nodeContextMenu, setNodeContextMenu] = useState(null)
  const [dependencyByWorkflow, setDependencyByWorkflow] = useState({})
  const [activeConnection, setActiveConnection] = useState(null)
  const [canvasBounds, setCanvasBounds] = useState({ width: 0, height: 0 })
  const [workspaceWidth, setWorkspaceWidth] = useState(0)
  const [isPageVisible, setIsPageVisible] = useState(
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
  )
  const [previewStep, setPreviewStep] = useState(0)
  const [inspectorWidth, setInspectorWidth] = useState(() => readStoredFlowInspectorWidth())
  const [isInspectorResizing, setIsInspectorResizing] = useState(false)
  const hydratedProjectKeyRef = useRef(null)
  const lastPersistedSnapshotRef = useRef('')
  const workspaceLayoutRef = useRef(null)
  const canvasViewportRef = useRef(null)
  const nodeContextMenuRef = useRef(null)
  const requestedPreviewSpriteIdsRef = useRef(new Set())
  const flowHistoryByDocumentRef = useRef(new Map())
  const flowClipboardRef = useRef({ nodes: [], edges: [], pasteCount: 0 })
  const flowNodeDragHistoryPendingRef = useRef(false)
  const inspectorResizeStateRef = useRef(null)
  const effectiveInspectorWidth = useMemo(
    () => clampFlowInspectorWidth(inspectorWidth, workspaceWidth),
    [inspectorWidth, workspaceWidth]
  )

  useEffect(() => {
    if (hydratedProjectKeyRef.current === projectKey) return
    hydratedProjectKeyRef.current = projectKey
    requestedPreviewSpriteIdsRef.current.clear()
    flowHistoryByDocumentRef.current.clear()
    flowClipboardRef.current = { nodes: [], edges: [], pasteCount: 0 }
    flowNodeDragHistoryPendingRef.current = false
    const normalized = normalizeFlowAiProjectData(currentProject?.flowAi)
    setFlowProjectState(normalized)
    setActiveDocumentId(normalized.activeDocumentId)
    const nextDocument = normalized.documents.find((document) => document.id === normalized.activeDocumentId) || normalized.documents[0]
    setNodes(nextDocument?.nodes || [])
    setEdges(nextDocument?.edges || [])
    setViewport(nextDocument?.viewport || { x: 0, y: 0, zoom: 0.9 })
    setSelectedNodeId(null)
    setNodeContextMenu(null)
    setRunNotice('')
  }, [currentProject?.flowAi, projectKey, setEdges, setNodes])

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const handleVisibilityChange = () => {
      setIsPageVisible(document.visibilityState !== 'hidden')
    }
    handleVisibilityChange()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  useEffect(() => {
    const element = canvasViewportRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const updateBounds = () => {
      setCanvasBounds({
        width: element.clientWidth || 0,
        height: element.clientHeight || 0,
      })
    }
    updateBounds()
    const observer = new ResizeObserver(updateBounds)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = workspaceLayoutRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const updateBounds = () => {
      setWorkspaceWidth(element.clientWidth || 0)
    }
    updateBounds()
    const observer = new ResizeObserver(updateBounds)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setInspectorWidth((current) => clampFlowInspectorWidth(current, workspaceWidth))
  }, [workspaceWidth])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return
    try {
      window.localStorage.setItem(FLOW_AI_INSPECTOR_WIDTH_STORAGE_KEY, String(effectiveInspectorWidth))
    } catch (_) {
      // ignore
    }
  }, [effectiveInspectorWidth])

  useEffect(() => {
    if (!isInspectorResizing) return undefined
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (event) => {
      const resizeState = inspectorResizeStateRef.current
      if (!resizeState) return
      setInspectorWidth(clampFlowInspectorWidth(resizeState.layoutRight - event.clientX, resizeState.layoutWidth))
    }

    const stopResize = () => {
      inspectorResizeStateRef.current = null
      setIsInspectorResizing(false)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }

    window.addEventListener('mousemove', handlePointerMove)
    window.addEventListener('mouseup', stopResize)
    return () => {
      window.removeEventListener('mousemove', handlePointerMove)
      window.removeEventListener('mouseup', stopResize)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [isInspectorResizing])

  useEffect(() => {
    if (!activeDocument) return
    setNodes(activeDocument.nodes || [])
    setEdges(activeDocument.edges || [])
    setViewport(activeDocument.viewport || { x: 0, y: 0, zoom: 0.9 })
    setSelectedNodeId(null)
    setNodeContextMenu(null)
    flowNodeDragHistoryPendingRef.current = false
  }, [activeDocument?.id, setEdges, setNodes])

  const readFlowHistoryState = useCallback((documentId = activeDocumentId) => {
    if (!documentId) return { past: [], future: [] }
    return flowHistoryByDocumentRef.current.get(documentId) || { past: [], future: [] }
  }, [activeDocumentId])

  const writeFlowHistoryState = useCallback((documentId, nextHistory) => {
    if (!documentId) return
    flowHistoryByDocumentRef.current.set(documentId, {
      past: Array.isArray(nextHistory?.past) ? nextHistory.past : [],
      future: Array.isArray(nextHistory?.future) ? nextHistory.future : [],
    })
  }, [])

  const recordFlowHistorySnapshot = useCallback((snapshot = null) => {
    if (!activeDocumentId) return false
    const nextSnapshot = snapshot || buildFlowGraphHistorySnapshot(nodes, edges)
    const historyState = readFlowHistoryState(activeDocumentId)
    const lastSnapshot = historyState.past[historyState.past.length - 1]
    if (lastSnapshot?.signature === nextSnapshot.signature) return false
    writeFlowHistoryState(activeDocumentId, {
      past: [...historyState.past, nextSnapshot].slice(-FLOW_GRAPH_HISTORY_LIMIT),
      future: [],
    })
    return true
  }, [activeDocumentId, edges, nodes, readFlowHistoryState, writeFlowHistoryState])

  const restoreFlowHistorySnapshot = useCallback((snapshot) => {
    if (!snapshot) return false
    setNodes((snapshot.nodes || []).map((node) => ({
      ...node,
      selected: false,
    })))
    setEdges((snapshot.edges || []).map((edge) => ({
      ...edge,
      selected: false,
    })))
    setSelectedNodeId(null)
    return true
  }, [setEdges, setNodes])

  const undoFlowGraph = useCallback(() => {
    if (!activeDocumentId) return false
    const historyState = readFlowHistoryState(activeDocumentId)
    if (historyState.past.length === 0) return false
    const previousSnapshot = historyState.past[historyState.past.length - 1]
    const currentSnapshot = buildFlowGraphHistorySnapshot(nodes, edges)
    writeFlowHistoryState(activeDocumentId, {
      past: historyState.past.slice(0, -1),
      future: [currentSnapshot, ...historyState.future].slice(0, FLOW_GRAPH_HISTORY_LIMIT),
    })
    return restoreFlowHistorySnapshot(previousSnapshot)
  }, [activeDocumentId, edges, nodes, readFlowHistoryState, restoreFlowHistorySnapshot, writeFlowHistoryState])

  const redoFlowGraph = useCallback(() => {
    if (!activeDocumentId) return false
    const historyState = readFlowHistoryState(activeDocumentId)
    if (historyState.future.length === 0) return false
    const nextSnapshot = historyState.future[0]
    const currentSnapshot = buildFlowGraphHistorySnapshot(nodes, edges)
    writeFlowHistoryState(activeDocumentId, {
      past: [...historyState.past, currentSnapshot].slice(-FLOW_GRAPH_HISTORY_LIMIT),
      future: historyState.future.slice(1),
    })
    return restoreFlowHistorySnapshot(nextSnapshot)
  }, [activeDocumentId, edges, nodes, readFlowHistoryState, restoreFlowHistorySnapshot, writeFlowHistoryState])

  const updateActiveDocument = useCallback((updater) => {
    setFlowProjectState((prev) => {
      const nextDocuments = prev.documents.map((document) => {
        if (document.id !== activeDocumentId) return document
        const nextDocument = typeof updater === 'function' ? updater(document) : updater
        return {
          ...document,
          ...nextDocument,
          updatedAt: new Date().toISOString(),
        }
      })
      return {
        ...prev,
        activeDocumentId,
        documents: nextDocuments,
      }
    })
  }, [activeDocumentId])

  useEffect(() => {
    if (!activeDocument) return
    updateActiveDocument((document) => ({
      ...document,
      nodes,
      edges,
      viewport,
    }))
  }, [activeDocument, edges, nodes, updateActiveDocument, viewport])

  useEffect(() => {
    const payload = {
      ...flowProjectData,
      activeDocumentId,
    }
    const serialized = JSON.stringify(payload)
    if (serialized === lastPersistedSnapshotRef.current) return
    lastPersistedSnapshotRef.current = serialized
    const timer = window.setTimeout(() => {
      setFlowAiData(payload)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [activeDocumentId, flowProjectData, setFlowAiData])

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId]
  )
  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => node.selected).map((node) => node.id),
    [nodes]
  )
  const selectedEdgeIds = useMemo(
    () => edges.filter((edge) => edge.selected).map((edge) => edge.id),
    [edges]
  )
  const nodeContextMenuAnchor = useMemo(
    () => (nodeContextMenu ? { x: nodeContextMenu.x, y: nodeContextMenu.y } : null),
    [nodeContextMenu?.x, nodeContextMenu?.y]
  )
  const nodeContextMenuPosition = useViewportClampedPosition(
    nodeContextMenuAnchor,
    nodeContextMenuRef,
  )
  const nodeContextMenuTarget = useMemo(
    () => (nodeContextMenu ? nodes.find((node) => node.id === nodeContextMenu.nodeId) || null : null),
    [nodeContextMenu, nodes]
  )
  const nodeContextMenuRunnable = Boolean(nodeContextMenuTarget && isFlowNodeRunnable(nodeContextMenuTarget.type))
  useEffect(() => {
    if (!nodeContextMenu) return undefined

    const handleClick = (event) => {
      if (nodeContextMenuRef.current && nodeContextMenuRef.current.contains(event.target)) {
        return
      }
      setNodeContextMenu(null)
    }

    const handleEscape = (event) => {
      if (event.key === 'Escape') setNodeContextMenu(null)
    }

    window.addEventListener('click', handleClick, true)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('click', handleClick, true)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [nodeContextMenu])
  useEffect(() => {
    if (nodeContextMenu && !nodeContextMenuRunnable) {
      setNodeContextMenu(null)
    }
  }, [nodeContextMenu, nodeContextMenuRunnable])
  const handleSelectionChange = useCallback(({ nodes: nextSelectedNodes = [] }) => {
    if (nextSelectedNodes.length === 1) {
      setSelectedNodeId(nextSelectedNodes[0].id)
      return
    }
    if (nextSelectedNodes.length === 0) {
      setSelectedNodeId(null)
      return
    }
    setSelectedNodeId(null)
  }, [])
  const selectFlowNode = useCallback((nodeId) => {
    if (!nodeId) {
      setSelectedNodeId(null)
      return
    }
    setNodes((prev) => {
      let changed = false
      const nextNodes = prev.map((node) => {
        const shouldSelect = node.id === nodeId
        if (Boolean(node.selected) === shouldSelect) return node
        changed = true
        return {
          ...node,
          selected: shouldSelect,
        }
      })
      return changed ? nextNodes : prev
    })
    setEdges((prev) => {
      let changed = false
      const nextEdges = prev.map((edge) => {
        if (!edge.selected) return edge
        changed = true
        return {
          ...edge,
          selected: false,
        }
      })
      return changed ? nextEdges : prev
    })
    setSelectedNodeId(nodeId)
  }, [setEdges, setNodes])
  const handleNodeContextMenu = useCallback((event, node) => {
    event.preventDefault()
    event.stopPropagation()
    if (!node || !isFlowNodeRunnable(node.type)) {
      setNodeContextMenu(null)
      return
    }
    selectFlowNode(node.id)
    setNodeContextMenu({
      x: event.clientX,
      y: event.clientY,
      nodeId: node.id,
    })
  }, [selectFlowNode])
  const handleNodesChange = useCallback((changes) => {
    if (!Array.isArray(changes) || changes.length === 0) return
    if (hasMeaningfulFlowNodeChanges(changes)) {
      recordFlowHistorySnapshot()
    }
    setNodes((currentNodes) => applyNodeChanges(changes, currentNodes))
  }, [recordFlowHistorySnapshot, setNodes])
  const handleFlowNodeResizeStart = useCallback(() => {
    recordFlowHistorySnapshot()
  }, [recordFlowHistorySnapshot])
  const flowCanvasActions = useMemo(() => ({
    onResizeStart: handleFlowNodeResizeStart,
  }), [handleFlowNodeResizeStart])
  const handleEdgesChange = useCallback((changes) => {
    if (!Array.isArray(changes) || changes.length === 0) return
    if (hasMeaningfulFlowEdgeChanges(changes)) {
      recordFlowHistorySnapshot()
    }
    setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges))
  }, [recordFlowHistorySnapshot, setEdges])
  const handleNodeDragStart = useCallback(() => {
    if (flowNodeDragHistoryPendingRef.current) return
    flowNodeDragHistoryPendingRef.current = true
    recordFlowHistorySnapshot()
  }, [recordFlowHistorySnapshot])
  const handleNodeDragStop = useCallback(() => {
    flowNodeDragHistoryPendingRef.current = false
  }, [])
  const handleDisconnectEdge = useCallback((edgeId) => {
    if (!edgeId) return
    recordFlowHistorySnapshot()
    setEdges((prev) => prev.filter((edge) => edge.id !== edgeId))
  }, [recordFlowHistorySnapshot, setEdges])
  const activeConnectionType = useMemo(
    () => activeConnection?.visualType || parsePortType(activeConnection?.handleId || ''),
    [activeConnection]
  )
  const connectionLineStyle = useMemo(() => {
    const portVisual = getFlowPortVisual(activeConnectionType)
    return {
      stroke: portVisual.color,
      strokeWidth: 2.4,
      filter: `drop-shadow(0 0 6px ${portVisual.shadow})`,
    }
  }, [activeConnectionType])
  const flowTextDocument = useMemo(() => ({
    nodes,
    edges,
  }), [edges, nodes])
  const displayNodes = useMemo(() => {
    return nodes.map((node) => {
      const previewPayload = buildFlowNodePreviewPayload(node, assetById)
      const previewAnimated = isPageVisible && isFlowNodePreviewVisible(node, viewport, canvasBounds)
      const hasAnimatedVideoPreview = (previewPayload.items || []).some((item) => item.kind === 'video' && item?.sprite?.url)
      const resolvedText = node.type === FLOW_AI_NODE_TYPES.textViewer
        ? resolveFlowNodeText(flowTextDocument, node)
        : ''
      return {
        ...node,
        data: {
          ...(node.data || {}),
          _activeConnectionHandleId: activeConnection?.handleId || '',
          _activeConnectionHandleType: activeConnection?.handleType || '',
          _previewItems: previewPayload.items,
          _previewPlaceholder: previewPayload.placeholder,
          _previewAnimated: previewAnimated,
          _previewStep: previewAnimated && hasAnimatedVideoPreview ? previewStep : 0,
          _resolvedText: resolvedText,
        },
      }
    })
  }, [activeConnection, assetById, canvasBounds, flowTextDocument, isPageVisible, nodes, previewStep, viewport])
  const previewVideoAssetIds = useMemo(() => {
    const nextIds = new Set()
    for (const node of displayNodes) {
      if (!node?.data?._previewAnimated) continue
      for (const item of node?.data?._previewItems || []) {
        if (item?.kind === 'video' && item?.assetId) {
          nextIds.add(item.assetId)
        }
      }
    }
    return Array.from(nextIds)
  }, [displayNodes])
  const previewVideoAssetIdsKey = useMemo(
    () => previewVideoAssetIds.join('|'),
    [previewVideoAssetIds]
  )
  const animatedPreviewVideoCount = useMemo(() => {
    const previewIds = previewVideoAssetIdsKey ? previewVideoAssetIdsKey.split('|') : []
    return previewIds.reduce((count, assetId) => (
      assetById.get(assetId)?.sprite?.url ? count + 1 : count
    ), 0)
  }, [assetById, previewVideoAssetIdsKey])
  useEffect(() => {
    if (!isPageVisible || animatedPreviewVideoCount === 0) return undefined
    const timer = window.setInterval(() => {
      setPreviewStep((step) => (step + 1) % 100000)
    }, FLOW_NODE_PREVIEW_VIDEO_STEP_MS)
    return () => window.clearInterval(timer)
  }, [animatedPreviewVideoCount, isPageVisible])
  useEffect(() => {
    const projectPath = typeof currentProjectHandle === 'string' ? currentProjectHandle : null
    const previewIds = previewVideoAssetIdsKey ? previewVideoAssetIdsKey.split('|') : []
    const candidates = previewIds.filter((assetId) => {
      const asset = assetById.get(assetId)
      return Boolean(
        asset
        && asset.type === 'video'
        && asset.url
        && !asset.sprite?.url
        && !asset.spriteGenerating
        && !requestedPreviewSpriteIdsRef.current.has(assetId)
      )
    })
    if (candidates.length === 0) return undefined

    let cancelled = false
    ;(async () => {
      for (const assetId of candidates) {
        if (cancelled) return
        requestedPreviewSpriteIdsRef.current.add(assetId)
        try {
          await generateAssetSprite(assetId, projectPath)
        } catch (error) {
          console.warn('Failed to generate Flow AI preview sprite:', error)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [assetById, currentProjectHandle, generateAssetSprite, previewVideoAssetIdsKey])
  const activeTargetNodeIds = useMemo(() => {
    return new Set(
      nodes
        .filter((node) => FLOW_BUSY_STATUSES.has(String(node?.data?.status || '')))
        .map((node) => node.id)
    )
  }, [nodes])
  const displayEdges = useMemo(() => {
    return edges.map((edge) => ({
      ...edge,
      type: 'flow-canvas',
      data: {
        ...(edge.data || {}),
        isActive: activeTargetNodeIds.has(edge.target),
        onDisconnect: handleDisconnectEdge,
        portType: parsePortType(edge.targetHandle || edge.sourceHandle),
      },
    }))
  }, [activeTargetNodeIds, edges, handleDisconnectEdge])

  const selectableAssets = useMemo(() => {
    return assets.map((asset) => ({
      id: asset.id,
      label: asset.name || asset.path || asset.id,
      type: asset.type,
      asset,
    }))
  }, [assets])

  const imageInputAssets = useMemo(
    () => selectableAssets.filter((entry) => entry.type === 'image' || entry.type === 'video'),
    [selectableAssets]
  )
  const styleAssets = useMemo(
    () => selectableAssets.filter((entry) => entry.type === 'image'),
    [selectableAssets]
  )

  const executableWorkflowIds = useMemo(() => {
    return Array.from(new Set(
      nodes
        .filter((node) => getFlowNodeSupportsExecution(node.type))
        .map((node) => String(node?.data?.workflowId || '').trim())
        .filter(Boolean)
    ))
  }, [nodes])

  useEffect(() => {
    if (executableWorkflowIds.length === 0) {
      setDependencyByWorkflow({})
      return
    }

    let cancelled = false
    checkWorkflowDependenciesBatch(executableWorkflowIds)
      .then((results) => {
        if (cancelled) return
        const nextMap = {}
        for (const result of results || []) {
          nextMap[result.workflowId] = result
        }
        setDependencyByWorkflow(nextMap)
      })
      .catch(() => {
        if (cancelled) return
        setDependencyByWorkflow({})
      })
    return () => {
      cancelled = true
    }
  }, [executableWorkflowIds])

  useEffect(() => {
    if (nodes.length === 0) return
    setNodes((prev) => {
      let changed = false
      const nextNodes = prev.map((node) => {
        if (!getFlowNodeSupportsExecution(node.type)) return node
        const dependency = dependencyByWorkflow[String(node?.data?.workflowId || '').trim()]
        const dependencyStatus = dependency?.status || 'unknown'
        const dependencySummary = dependency?.hasBlockingIssues
          ? (
            dependency?.missingAuth
              ? 'Missing API key'
              : `${(dependency?.missingNodes?.length || 0)} nodes / ${(dependency?.missingModels?.length || 0)} models missing`
          )
          : dependencyStatus === 'ready'
            ? 'All set'
            : dependency?.error || ''
        const workflowLabel = formatRuntimeLabel(node?.data?.workflowId)
        if (
          node?.data?.dependencyStatus === dependencyStatus
          && node?.data?.dependencySummary === dependencySummary
          && node?.data?.workflowLabel === workflowLabel
        ) {
          return node
        }
        changed = true
        return {
          ...node,
          data: {
            ...node.data,
            dependencyStatus,
            dependencySummary,
            workflowLabel,
          },
        }
      })
      return changed ? nextNodes : prev
    })
  }, [dependencyByWorkflow, nodes.length, setNodes])

  useEffect(() => {
    if (nodes.length === 0) return
    setNodes((prev) => {
      let changed = false
      const nextNodes = prev.map((node) => {
        if (node.type !== FLOW_AI_NODE_TYPES.output) return node
        const nextPatch = {}
        const currentLabel = String(node?.data?.label || '').trim()
        const currentStatusMessage = String(node?.data?.statusMessage || '').trim()
        if (!currentLabel || currentLabel === 'Output') {
          nextPatch.label = 'Asset Output'
        }
        if (!currentStatusMessage || currentStatusMessage === 'Connect final image, video, or audio nodes here.') {
          nextPatch.statusMessage = 'Sends connected results to the Assets panel.'
        }
        if (typeof node?.data?.folderName !== 'string') {
          nextPatch.folderName = ''
        }
        if (Object.keys(nextPatch).length === 0) return node
        changed = true
        return {
          ...node,
          data: {
            ...node.data,
            ...nextPatch,
          },
        }
      })
      return changed ? nextNodes : prev
    })
  }, [nodes.length, setNodes])

  useEffect(() => {
    const outputAssetIdsByNode = computeOutputNodeAssetIds({
      nodes,
      edges,
    })
    if (Object.keys(outputAssetIdsByNode).length === 0) return
    setNodes((prev) => {
      let changed = false
      const nextNodes = prev.map((node) => {
        if (node.type !== FLOW_AI_NODE_TYPES.output) return node
        const nextIds = outputAssetIdsByNode[node.id] || []
        if (shallowStringArrayEqual(node?.data?.resolvedAssetIds || [], nextIds)) return node
        changed = true
        return {
          ...node,
          data: {
            ...node.data,
            resolvedAssetIds: nextIds,
          },
        }
      })
      return changed ? nextNodes : prev
    })
  }, [assets, edges, nodes, setNodes])

  useEffect(() => {
    if (assets.length === 0) return
    const assetNameById = new Map(assets.map((asset) => [asset.id, asset.name || asset.path || asset.id]))
    setNodes((prev) => {
      let changed = false
      const nextNodes = prev.map((node) => {
        if (node.type !== FLOW_AI_NODE_TYPES.imageInput && node.type !== FLOW_AI_NODE_TYPES.styleReference) {
          return node
        }
        const assetId = String(node?.data?.assetId || '').trim()
        const nextLabel = assetNameById.get(assetId) || ''
        if ((node?.data?.assetLabel || '') === nextLabel) return node
        changed = true
        return {
          ...node,
          data: {
            ...node.data,
            assetLabel: nextLabel,
          },
        }
      })
      return changed ? nextNodes : prev
    })
  }, [assets, setNodes])

  const updateNodeData = useCallback((nodeId, patch, options = {}) => {
    const shouldRecordHistory = options.recordHistory !== false
    const currentNode = nodes.find((node) => node.id === nodeId)
    if (!currentNode) return false
    const nextPatch = typeof patch === 'function' ? patch(currentNode.data) : patch
    if (!nextPatch || Object.keys(nextPatch).length === 0) return false
    const hasChange = Object.entries(nextPatch).some(([key, value]) => currentNode?.data?.[key] !== value)
    if (!hasChange) return false
    if (shouldRecordHistory) recordFlowHistorySnapshot()
    setNodes((prev) => prev.map((node) => {
      if (node.id !== nodeId) return node
      return {
        ...node,
        data: {
          ...node.data,
          ...(nextPatch || {}),
        },
      }
    }))
    return true
  }, [nodes, recordFlowHistorySnapshot, setNodes])

  const handleConnect = useCallback((connection) => {
    if (!isValidFlowConnection(connection)) return
    recordFlowHistorySnapshot()
    setEdges((prev) => {
      const filtered = isSingletonTargetHandle(connection.targetHandle)
        ? prev.filter((edge) => !(edge.target === connection.target && edge.targetHandle === connection.targetHandle))
        : prev
      return [
        ...filtered,
        createFlowEdge(connection),
      ]
    })
    setActiveConnection(null)
  }, [recordFlowHistorySnapshot, setEdges])

  const handleConnectStart = useCallback((_event, params) => {
    const node = nodes.find((entry) => entry.id === params?.nodeId)
    const definition = getFlowNodeDefinition(node?.type)
    const ports = params?.handleType === 'target' ? (definition?.inputs || []) : (definition?.outputs || [])
    const activePort = ports.find((port) => port.id === params?.handleId)
    setActiveConnection({
      handleId: String(params?.handleId || ''),
      handleType: String(params?.handleType || ''),
      visualType: resolveFlowPortVisualType(parsePortType(params?.handleId || ''), activePort?.label),
    })
  }, [nodes])

  const handleConnectEnd = useCallback(() => {
    setActiveConnection(null)
  }, [])

  const handleAddNode = useCallback((nodeType) => {
    const nextIndex = nodes.length
    const newNode = createFlowNode(nodeType, {
      position: {
        x: 120 + ((nextIndex % 3) * 320),
        y: 80 + (Math.floor(nextIndex / 3) * 190),
      },
      data: {
        workflowId: getFlowNodeSupportsExecution(nodeType)
          ? getDefaultWorkflowId(nodeType)
          : undefined,
      },
    })
    recordFlowHistorySnapshot()
    setNodes((prev) => [
      ...prev.map((node) => ({ ...node, selected: false })),
      { ...newNode, selected: true },
    ])
    setSelectedNodeId(newNode.id)
  }, [nodes.length, recordFlowHistorySnapshot, setNodes])

  const duplicateFlowNodes = useCallback((nodeIds = []) => {
    const ids = (nodeIds || []).filter(Boolean)
    if (ids.length === 0) return false
    const nodeIdSet = new Set(ids)
    const sourceNodes = nodes.filter((node) => nodeIdSet.has(node.id))
    if (sourceNodes.length === 0) return false

    recordFlowHistorySnapshot()

    const nodeIdMap = new Map()
    const duplicatedNodes = sourceNodes.map((node) => {
      const duplicate = buildFlowGraphNodeSnapshot(node, {
        id: `${node.id}_copy_${Math.random().toString(36).slice(2, 8)}`,
        preserveOutputs: false,
        selected: true,
      })
      duplicate.position = {
        x: (Number(node?.position?.x) || 0) + FLOW_PASTE_OFFSET_PX,
        y: (Number(node?.position?.y) || 0) + FLOW_PASTE_OFFSET_PX,
      }
      nodeIdMap.set(node.id, duplicate.id)
      return duplicate
    })
    const duplicatedEdges = edges
      .filter((edge) => nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target))
      .map((edge) => buildFlowGraphEdgeSnapshot(edge, {
        id: `${edge.id}_copy_${Math.random().toString(36).slice(2, 8)}`,
        source: nodeIdMap.get(edge.source),
        target: nodeIdMap.get(edge.target),
      }))
      .filter(Boolean)

    setNodes((prev) => [
      ...prev.map((node) => ({ ...node, selected: false })),
      ...duplicatedNodes,
    ])
    setEdges((prev) => [
      ...prev.map((edge) => ({ ...edge, selected: false })),
      ...duplicatedEdges,
    ])
    setSelectedNodeId(duplicatedNodes.length === 1 ? duplicatedNodes[0].id : null)
    return true
  }, [edges, nodes, recordFlowHistorySnapshot, setEdges, setNodes])

  const copyFlowSelection = useCallback(() => {
    const nodeIds = selectedNodeIds.length > 0
      ? selectedNodeIds
      : (selectedNodeId ? [selectedNodeId] : [])
    const payload = buildFlowClipboardPayload(nodes, edges, nodeIds)
    if (payload.nodes.length === 0) return false
    flowClipboardRef.current = payload
    setRunNotice(
      `Copied ${payload.nodes.length} Flow AI node${payload.nodes.length === 1 ? '' : 's'}${payload.edges.length > 0 ? ` and ${payload.edges.length} edge${payload.edges.length === 1 ? '' : 's'}` : ''}.`
    )
    return true
  }, [edges, nodes, selectedNodeId, selectedNodeIds])

  const pasteFlowSelection = useCallback(() => {
    const payload = flowClipboardRef.current
    if (!payload?.nodes?.length) return false

    recordFlowHistorySnapshot()

    const nextPasteCount = Math.max(1, Number(payload.pasteCount || 0) + 1)
    const pasted = cloneFlowClipboardPayload(payload, nextPasteCount)
    flowClipboardRef.current = {
      ...payload,
      pasteCount: nextPasteCount,
    }

    setNodes((prev) => [
      ...prev.map((node) => ({ ...node, selected: false })),
      ...pasted.nodes,
    ])
    setEdges((prev) => [
      ...prev.map((edge) => ({ ...edge, selected: false })),
      ...pasted.edges,
    ])
    setSelectedNodeId(pasted.nodes.length === 1 ? pasted.nodes[0].id : null)
    setRunNotice(`Pasted ${pasted.nodes.length} Flow AI node${pasted.nodes.length === 1 ? '' : 's'}.`)
    return true
  }, [recordFlowHistorySnapshot, setEdges, setNodes])

  const deleteFlowSelection = useCallback(() => {
    const nodeIds = selectedNodeIds.length > 0
      ? selectedNodeIds
      : (selectedNodeId ? [selectedNodeId] : [])
    const edgeIds = selectedEdgeIds
    if (nodeIds.length === 0 && edgeIds.length === 0) return false

    const nodeIdSet = new Set(nodeIds)
    const edgeIdSet = new Set(edgeIds)
    recordFlowHistorySnapshot()

    setNodes((prev) => prev.filter((node) => !nodeIdSet.has(node.id)))
    setEdges((prev) => prev.filter((edge) => (
      !edgeIdSet.has(edge.id)
      && !nodeIdSet.has(edge.source)
      && !nodeIdSet.has(edge.target)
    )))
    setSelectedNodeId(null)
    return true
  }, [recordFlowHistorySnapshot, selectedEdgeIds, selectedNodeId, selectedNodeIds, setEdges, setNodes])

  const handleCreateDocument = useCallback((templateId = 'blank') => {
    const template = FLOW_AI_TEMPLATES.find((entry) => entry.id === templateId)
    const newDocument = createFlowDocument({
      name: template?.label || 'Flow',
      templateId,
    })
    setFlowProjectState((prev) => ({
      ...prev,
      activeDocumentId: newDocument.id,
      documents: [...prev.documents, newDocument],
    }))
    setActiveDocumentId(newDocument.id)
  }, [])

  const handleDuplicateDocument = useCallback(() => {
    if (!activeDocument) return
    const duplicate = {
      ...activeDocument,
      id: `flow_copy_${Date.now()}`,
      name: `${activeDocument.name} Copy`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: activeDocument.nodes.map((node) => ({
        ...node,
        id: `${node.id}_copy_${Math.random().toString(36).slice(2, 6)}`,
        data: {
          ...node.data,
          status: 'idle',
          statusMessage: '',
          error: '',
          progress: 0,
          estimatedCredits: null,
          estimatedCreditsSource: null,
          outputAssetIds: [],
          resolvedAssetIds: [],
          outputText: '',
          lastPromptId: null,
          lastRunAt: null,
        },
      })),
      edges: [],
    }
    const nodeIdMap = new Map()
    duplicate.nodes.forEach((node, index) => {
      nodeIdMap.set(activeDocument.nodes[index].id, node.id)
    })
    duplicate.edges = activeDocument.edges.map((edge) => ({
      ...edge,
      id: `${edge.id}_copy_${Math.random().toString(36).slice(2, 6)}`,
      source: nodeIdMap.get(edge.source) || edge.source,
      target: nodeIdMap.get(edge.target) || edge.target,
    }))
    setFlowProjectState((prev) => ({
      ...prev,
      activeDocumentId: duplicate.id,
      documents: [...prev.documents, duplicate],
    }))
    setActiveDocumentId(duplicate.id)
  }, [activeDocument])

  const handleDeleteDocument = useCallback(() => {
    if (!activeDocument || flowProjectData.documents.length <= 1) return
    const remaining = flowProjectData.documents.filter((document) => document.id !== activeDocument.id)
    const nextActive = remaining[0]
    setFlowProjectState((prev) => ({
      ...prev,
      activeDocumentId: nextActive.id,
      documents: remaining,
    }))
    setActiveDocumentId(nextActive.id)
  }, [activeDocument, flowProjectData.documents])

  const handleRun = useCallback(async (options = {}) => {
    if (!activeDocument || isRunning) return
    setNodeContextMenu(null)
    setIsRunning(true)
    setIsStopping(false)
    setRunNotice('')
    setCompletionNotice(null)
    try {
      const snapshot = {
        ...activeDocument,
        nodes,
        edges,
        viewport,
      }
      const result = await runFlowGraph(snapshot, {
        documentId: activeDocument.id,
        targetNodeId: options.targetNodeId || null,
        forceRunAll: Boolean(options.forceRunAll),
        onNodePatch: (nodeId, patch) => updateNodeData(nodeId, patch, { recordHistory: false }),
      })
      if (result.importedAssetIds.length > 0) {
        const firstAssetId = result.importedAssetIds[0]
        const firstAsset = useAssetsStore.getState().assets.find((asset) => asset.id === firstAssetId)
        if (firstAsset) setPreview(firstAsset)
      }
      const importedCount = result.importedAssetIds.length
      const textCount = Array.isArray(result.textOutputNodeIds) ? result.textOutputNodeIds.length : 0
      const completionDetail = importedCount > 0
        ? `Saved ${importedCount} asset${importedCount === 1 ? '' : 's'} to the Assets panel.`
        : textCount > 0
          ? `Updated ${textCount} prompt output${textCount === 1 ? '' : 's'}.`
          : 'Flow finished without new assets.'
      setRunNotice(
        importedCount > 0
          ? `Flow AI imported ${importedCount} asset${importedCount === 1 ? '' : 's'}.`
          : textCount > 0
            ? `Flow AI updated ${textCount} prompt output${textCount === 1 ? '' : 's'}.`
            : 'Flow AI finished without new assets.'
      )
      setCompletionNotice({
        title: 'Flow Complete',
        detail: completionDetail,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Flow AI run failed.')
      const interrupted = /interrupt/i.test(message)
      setRunNotice(interrupted ? 'Flow AI interrupted.' : message)
      setCompletionNotice(null)
      if (selectedNodeId && !interrupted) {
        updateNodeData(selectedNodeId, {
          status: 'error',
          error: message,
          statusMessage: '',
        }, { recordHistory: false })
      }
    } finally {
      setIsStopping(false)
      setIsRunning(false)
    }
  }, [activeDocument, edges, isRunning, nodes, selectedNodeId, setPreview, updateNodeData, viewport])
  const handleRunNodeFromContextMenu = useCallback(() => {
    if (!nodeContextMenuTarget || !nodeContextMenuRunnable) return
    setNodeContextMenu(null)
    void handleRun({ targetNodeId: nodeContextMenuTarget.id })
  }, [handleRun, nodeContextMenuRunnable, nodeContextMenuTarget])

  const handleStopFlow = useCallback(async () => {
    if (!isRunning || isStopping) return
    setIsStopping(true)
    setRunNotice('Interrupt requested. Waiting for ComfyUI to stop…')
    setCompletionNotice(null)
    setNodes((prev) => prev.map((node) => (
      FLOW_BUSY_STATUSES.has(String(node?.data?.status || ''))
        ? {
            ...node,
            data: {
              ...node.data,
              statusMessage: 'Interrupt requested…',
            },
          }
        : node
    )))
    try {
      await comfyui.interrupt()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Failed to interrupt Flow AI.')
      setRunNotice(message)
      setIsStopping(false)
    }
  }, [isRunning, isStopping, setNodes])

  const handleSaveNow = useCallback(async () => {
    setFlowAiData({
      ...flowProjectData,
      activeDocumentId,
    })
    await saveProject()
    setRunNotice('Saved Flow AI changes to the current project.')
  }, [activeDocumentId, flowProjectData, saveProject, setFlowAiData])

  const handleResetInspectorWidth = useCallback(() => {
    setInspectorWidth(clampFlowInspectorWidth(FLOW_AI_INSPECTOR_DEFAULT_WIDTH, workspaceWidth))
  }, [workspaceWidth])

  const handleStartInspectorResize = useCallback((event) => {
    if (event.button !== 0) return
    const layoutRect = workspaceLayoutRef.current?.getBoundingClientRect()
    if (!layoutRect) return
    event.preventDefault()
    inspectorResizeStateRef.current = {
      layoutRight: layoutRect.right,
      layoutWidth: layoutRect.width,
    }
    setInspectorWidth(clampFlowInspectorWidth(layoutRect.right - event.clientX, layoutRect.width))
    setIsInspectorResizing(true)
  }, [])

  const handleInspectorResizeKeyDown = useCallback((event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setInspectorWidth((current) => clampFlowInspectorWidth(current + 24, workspaceWidth))
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      setInspectorWidth((current) => clampFlowInspectorWidth(current - 24, workspaceWidth))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setInspectorWidth(clampFlowInspectorWidth(FLOW_AI_INSPECTOR_MIN_WIDTH, workspaceWidth))
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setInspectorWidth(clampFlowInspectorWidth(FLOW_AI_INSPECTOR_MAX_WIDTH, workspaceWidth))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleResetInspectorWidth()
    }
  }, [handleResetInspectorWidth, workspaceWidth])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (isTypingTarget(event.target)) return

      const key = String(event.key || '').toLowerCase()
      const isModifierHeld = event.ctrlKey || event.metaKey

      if (isModifierHeld && !event.shiftKey && key === 'z') {
        if (undoFlowGraph()) {
          event.preventDefault()
        }
        return
      }

      if (isModifierHeld && ((event.shiftKey && key === 'z') || key === 'y')) {
        if (redoFlowGraph()) {
          event.preventDefault()
        }
        return
      }

      if (isModifierHeld && key === 'c') {
        if (copyFlowSelection()) {
          event.preventDefault()
        }
        return
      }

      if (isModifierHeld && key === 'v') {
        if (pasteFlowSelection()) {
          event.preventDefault()
        }
        return
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && !isModifierHeld) {
        if (deleteFlowSelection()) {
          event.preventDefault()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [copyFlowSelection, deleteFlowSelection, pasteFlowSelection, redoFlowGraph, undoFlowGraph])

  const selectedNodeWorkflowSummary = selectedNode?.data?.workflowId
    ? getFlowWorkflowSummary(selectedNode.data.workflowId)
    : null
  const selectedNodeDependency = selectedNode?.data?.workflowId
    ? dependencyByWorkflow[String(selectedNode.data.workflowId || '').trim()]
    : null
  const selectedNodeGuideCreditsPerSecond = selectedNode?.type === FLOW_AI_NODE_TYPES.videoUpscale
    ? getTopazVideoUpscaleCreditsPerSecond(selectedNode?.data?.upscaleModel, selectedNode?.data?.targetResolution)
    : null
  const selectedNodeGuideCreditsLabel = selectedNodeGuideCreditsPerSecond != null
    ? formatCreditsPerSecond(selectedNodeGuideCreditsPerSecond)
    : 'Pricing unavailable'
  const selectedNodeLiveCredits = selectedNode?.type === FLOW_AI_NODE_TYPES.videoUpscale
    ? selectedNode?.data?.estimatedCredits || null
    : null
  const selectedNodeLiveCreditsLabel = selectedNodeLiveCredits ? formatCreditsRange(selectedNodeLiveCredits) : ''
  const selectedImageVariantBehavior = selectedNode?.type === FLOW_AI_NODE_TYPES.imageGen
    ? getFlowImageVariantBehavior(selectedNode?.data?.workflowId)
    : null
  const selectedImageVariantCount = selectedNode?.type === FLOW_AI_NODE_TYPES.imageGen
    ? normalizeFlowImageVariantCount(selectedNode?.data?.variantCount, selectedNode?.data?.workflowId)
    : 1
  const selectedNodeResolvedText = selectedNode?.type === FLOW_AI_NODE_TYPES.textViewer
    ? resolveFlowNodeText(flowTextDocument, selectedNode)
    : ''

  const runnableSelection = Boolean(
    selectedNode
    && (
      getFlowNodeSupportsExecution(selectedNode.type)
      || selectedNode.type === FLOW_AI_NODE_TYPES.output
    )
  )

  const nodeTypes = useMemo(() => ({
    [FLOW_AI_NODE_TYPES.promptAssist]: FlowCanvasNode,
    [FLOW_AI_NODE_TYPES.textViewer]: FlowCanvasNode,
    [FLOW_AI_NODE_TYPES.prompt]: FlowCanvasNode,
    [FLOW_AI_NODE_TYPES.imageInput]: FlowCanvasNode,
    [FLOW_AI_NODE_TYPES.styleReference]: FlowCanvasNode,
    [FLOW_AI_NODE_TYPES.imageGen]: FlowCanvasNode,
    [FLOW_AI_NODE_TYPES.videoGen]: FlowCanvasNode,
    [FLOW_AI_NODE_TYPES.videoUpscale]: FlowCanvasNode,
    [FLOW_AI_NODE_TYPES.musicGen]: FlowCanvasNode,
    [FLOW_AI_NODE_TYPES.output]: FlowCanvasNode,
  }), [])
  const edgeTypes = useMemo(() => ({
    'flow-canvas': FlowCanvasEdge,
  }), [])

  const minimapNodeColor = useCallback((node) => {
    switch (node?.type) {
      case FLOW_AI_NODE_TYPES.prompt: return 'rgba(167, 139, 250, 0.42)'
      case FLOW_AI_NODE_TYPES.imageInput: return 'rgba(52, 211, 153, 0.42)'
      case FLOW_AI_NODE_TYPES.styleReference: return 'rgba(232, 121, 249, 0.42)'
      case FLOW_AI_NODE_TYPES.promptAssist: return 'rgba(125, 211, 252, 0.42)'
      case FLOW_AI_NODE_TYPES.textViewer: return 'rgba(196, 181, 253, 0.42)'
      case FLOW_AI_NODE_TYPES.imageGen: return 'rgba(56, 189, 248, 0.42)'
      case FLOW_AI_NODE_TYPES.videoGen: return 'rgba(34, 211, 238, 0.42)'
      case FLOW_AI_NODE_TYPES.videoUpscale: return 'rgba(251, 191, 36, 0.42)'
      case FLOW_AI_NODE_TYPES.musicGen: return 'rgba(251, 191, 36, 0.42)'
      case FLOW_AI_NODE_TYPES.output: return 'rgba(148, 163, 184, 0.5)'
      default: return 'rgba(148, 163, 184, 0.42)'
    }
  }, [])
  const minimapNodeStrokeColor = useCallback(() => 'rgba(148, 163, 184, 0.35)', [])

  return (
    <div ref={workspaceLayoutRef} className="flex h-full min-h-0 overflow-hidden bg-sf-dark-950">
      <style>{`
        @keyframes flow-ai-preview-drift {
          0% { transform: scale(1.02) translate3d(-1.5%, -1%, 0); }
          50% { transform: scale(1.06) translate3d(1.5%, 0.75%, 0); }
          100% { transform: scale(1.02) translate3d(-0.75%, 1%, 0); }
        }
        @keyframes flow-ai-preview-sheen {
          0% { transform: translate3d(-18%, 0, 0); }
          100% { transform: translate3d(180%, 0, 0); }
        }
        @keyframes flow-ai-audio-scan {
          0% { transform: translate3d(0, 0, 0); }
          100% { transform: translate3d(440%, 0, 0); }
        }
        .flow-ai-preview-drift {
          animation: flow-ai-preview-drift 8.5s ease-in-out infinite alternate;
          will-change: transform;
        }
        .flow-ai-canvas .react-flow__node-output {
          background: transparent !important;
          border: 0 !important;
          padding: 0 !important;
          box-shadow: none !important;
        }
        .flow-ai-canvas .react-flow__node-output.selected,
        .flow-ai-canvas .react-flow__node-output:focus,
        .flow-ai-canvas .react-flow__node-output:focus-visible {
          box-shadow: none !important;
          outline: none !important;
        }
        .flow-ai-canvas .react-flow__controls {
          border: 1px solid rgba(63, 63, 70, 0.95) !important;
          border-radius: 14px !important;
          overflow: hidden;
          background: rgba(9, 9, 11, 0.94) !important;
          box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28) !important;
        }
        .flow-ai-canvas .react-flow__controls-button {
          width: 34px;
          height: 34px;
          border: 0 !important;
          border-bottom: 1px solid rgba(39, 39, 42, 0.95) !important;
          background: rgba(9, 9, 11, 0.94) !important;
          color: rgba(226, 232, 240, 0.92) !important;
        }
        .flow-ai-canvas .react-flow__controls-button:last-child {
          border-bottom: 0 !important;
        }
        .flow-ai-canvas .react-flow__controls-button:hover {
          background: rgba(24, 24, 27, 0.98) !important;
        }
        .flow-ai-canvas .react-flow__controls-button svg {
          fill: currentColor !important;
        }
      `}</style>
      <div className="flex h-full min-h-0 w-[270px] flex-shrink-0 flex-col border-r border-sf-dark-800 bg-sf-dark-950/80">
        <div className="flex-shrink-0 border-b border-sf-dark-800 px-4 py-4">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-sf-text-muted">
            Flow AI
          </div>
          <div className="mt-2 text-sm text-sf-text-secondary">
            A curated canvas for local ComfyUI and cloud partner workflows.
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sf-text-muted">
                Documents
              </div>
              <button
                type="button"
                onClick={() => handleCreateDocument(selectedTemplateId)}
                className="inline-flex items-center gap-1 rounded-md bg-sf-accent px-2 py-1 text-[11px] font-medium text-white"
              >
                <Plus className="h-3.5 w-3.5" />
                New
              </button>
            </div>
            <select
              value={selectedTemplateId}
              onChange={(event) => setSelectedTemplateId(event.target.value)}
              className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
            >
              {FLOW_AI_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.label}
                </option>
              ))}
            </select>
            <div className="mt-3 space-y-2">
              {flowProjectData.documents.map((document) => (
                <button
                  key={document.id}
                  type="button"
                  onClick={() => setActiveDocumentId(document.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    activeDocumentId === document.id
                      ? 'border-sf-accent bg-sf-accent/10 text-sf-text-primary'
                      : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-secondary hover:border-sf-dark-600 hover:bg-sf-dark-800'
                  }`}
                >
                  <div className="truncate text-sm font-medium">
                    {document.name}
                  </div>
                  <div className="mt-1 text-[11px] text-sf-text-muted">
                    {document.nodes.length} nodes
                  </div>
                </button>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={handleDuplicateDocument}
                className="flex-1 rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-[11px] text-sf-text-secondary hover:bg-sf-dark-800"
              >
                Duplicate
              </button>
              <button
                type="button"
                onClick={handleDeleteDocument}
                disabled={flowProjectData.documents.length <= 1}
                className="flex-1 rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-[11px] text-sf-text-secondary disabled:cursor-not-allowed disabled:opacity-40 hover:bg-sf-dark-800"
              >
                Delete
              </button>
            </div>
          </section>

          <section>
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-sf-text-muted">
              Node Palette
            </div>
            <div className="space-y-2">
              {FLOW_AI_NODE_LIBRARY.map((entry) => {
                const Icon = getNodeIcon(entry.type)
                return (
                  <button
                    key={entry.type}
                    type="button"
                    onClick={() => handleAddNode(entry.type)}
                    className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-left transition-colors hover:border-sf-dark-600 hover:bg-sf-dark-800"
                  >
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-sf-text-primary" />
                      <div className="font-medium text-sf-text-primary">
                        {entry.label}
                      </div>
                    </div>
                    <div className="mt-1 text-[11px] text-sf-text-muted">
                      {entry.description}
                    </div>
                  </button>
                )
              })}
            </div>
          </section>

          <section>
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-sf-text-muted">
              Port Key
            </div>
            <div className="flex flex-wrap gap-2">
              {FLOW_PORT_LEGEND.map((portType) => {
                const portVisual = getFlowPortVisual(portType)
                return (
                  <span
                    key={portType}
                    className="inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-medium"
                    style={{
                      borderColor: portVisual.edge,
                      backgroundColor: portVisual.soft,
                      color: portVisual.color,
                    }}
                  >
                    {portVisual.label}
                  </span>
                )
              })}
            </div>
          </section>

          <section>
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-sf-text-muted">
              Tips
            </div>
            <div className="space-y-2 rounded-xl border border-sf-dark-800 bg-sf-dark-900/70 p-3 text-[11px] leading-5 text-sf-text-muted">
              <div>Use a `Prompt` node to feed multiple image/video/music blocks.</div>
              <div>Connect image outputs into `Video Gen` to animate a branch.</div>
              <div>Cloud workflows still run through ComfyUI partner nodes, so Workflow Setup and API keys still matter.</div>
              <div>V1 is intentionally curated: high-level production nodes only, not raw one-to-one Comfy node parity.</div>
            </div>
          </section>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-sf-dark-800 px-4 py-3">
          <Wand2 className="h-4 w-4 text-sf-accent" />
          <input
            value={activeDocument?.name || ''}
            onChange={(event) => updateActiveDocument({ name: event.target.value || 'Flow' })}
            className="min-w-0 flex-1 rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none focus:border-sf-accent"
          />
          <button
            type="button"
            onClick={() => handleRun({ forceRunAll: true })}
            disabled={isRunning}
            className="inline-flex items-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Run Flow
          </button>
          <button
            type="button"
            onClick={handleStopFlow}
            disabled={!isRunning}
            className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isStopping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
            Stop Flow
          </button>
          <button
            type="button"
            onClick={() => selectedNodeId && handleRun({ targetNodeId: selectedNodeId })}
            disabled={!runnableSelection || isRunning}
            className="inline-flex items-center gap-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Sparkles className="h-4 w-4" />
            Run Selection
          </button>
          <button
            type="button"
            onClick={handleSaveNow}
            className="inline-flex items-center gap-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary"
          >
            <Save className="h-4 w-4" />
            Save
          </button>
          <button
            type="button"
            onClick={() => onOpenWorkflowSetup?.()}
            className="inline-flex items-center gap-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary"
          >
            <Settings2 className="h-4 w-4" />
            Workflow Setup
          </button>
        </div>

        <div ref={canvasViewportRef} className="relative min-h-0 flex-1">
          {completionNotice && !isRunning && (
            <div className="pointer-events-none absolute right-4 top-4 z-20">
              <div className="pointer-events-auto flex max-w-[420px] items-start gap-3 rounded-2xl border border-sf-success/40 bg-sf-success/14 px-4 py-3 shadow-[0_18px_40px_rgba(0,0,0,0.38)] backdrop-blur">
                <div className="mt-0.5 rounded-full bg-sf-success/18 p-1.5 text-sf-success">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-sf-text-primary">
                    {completionNotice.title}
                  </div>
                  <div className="mt-1 text-xs leading-5 text-sf-text-secondary">
                    {completionNotice.detail}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setCompletionNotice(null)}
                  className="rounded-md border border-sf-success/30 bg-sf-dark-950/35 p-1 text-sf-text-muted transition-colors hover:border-sf-success/50 hover:text-sf-text-primary"
                  aria-label="Dismiss completion notice"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
          {nodeContextMenu && nodeContextMenuTarget && nodeContextMenuRunnable && (
            <div
              ref={nodeContextMenuRef}
              className="fixed z-30 min-w-[190px] rounded-xl border border-sf-dark-700 bg-sf-dark-900/96 p-1 shadow-[0_18px_40px_rgba(0,0,0,0.42)] backdrop-blur"
              style={{
                left: nodeContextMenuPosition.x,
                top: nodeContextMenuPosition.y,
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-sf-text-muted">
                {nodeContextMenuTarget.data?.label || getFlowNodeDefinition(nodeContextMenuTarget.type)?.label || 'Node'}
              </div>
              <button
                type="button"
                onClick={handleRunNodeFromContextMenu}
                disabled={isRunning}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-sf-text-primary transition-colors hover:bg-sf-dark-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-sf-accent" />}
                Run selected node
              </button>
            </div>
          )}
          <FlowCanvasActionsContext.Provider value={flowCanvasActions}>
            <ReactFlow
              nodes={displayNodes}
              edges={displayEdges}
              viewport={viewport}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={handleConnect}
              onConnectStart={handleConnectStart}
              onConnectEnd={handleConnectEnd}
              onNodeDragStart={handleNodeDragStart}
              onNodeDragStop={handleNodeDragStop}
              onSelectionChange={handleSelectionChange}
              isValidConnection={isValidFlowConnection}
              onNodeClick={(_, node) => {
                setNodeContextMenu(null)
                setSelectedNodeId(node.id)
              }}
              onNodeContextMenu={handleNodeContextMenu}
              onPaneClick={() => {
                setNodeContextMenu(null)
                setSelectedNodeId(null)
              }}
              onViewportChange={setViewport}
              deleteKeyCode={null}
              connectionLineStyle={connectionLineStyle}
              proOptions={FLOW_REACT_FLOW_PRO_OPTIONS}
              className="flow-ai-canvas bg-[radial-gradient(circle_at_top,_rgba(37,99,235,0.08),_transparent_35%),linear-gradient(180deg,#09090b_0%,#050507_100%)]"
            >
              <Background gap={28} size={1} color="rgba(255,255,255,0.06)" />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                bgColor="rgba(9, 9, 11, 0.94)"
                maskColor="rgba(0, 0, 0, 0.5)"
                maskStrokeColor="rgba(96, 165, 250, 0.35)"
                maskStrokeWidth={1}
                nodeColor={minimapNodeColor}
                nodeStrokeColor={minimapNodeStrokeColor}
                nodeStrokeWidth={1}
                nodeBorderRadius={2}
                className="!bg-sf-dark-950/95 !border !border-sf-dark-700"
              />
            </ReactFlow>
          </FlowCanvasActionsContext.Provider>
        </div>

        <div
          className={`border-t px-4 py-2 text-xs ${
            completionNotice && !isRunning
              ? 'border-sf-success/30 bg-sf-success/10 text-sf-success'
              : 'border-sf-dark-800 text-sf-text-muted'
          }`}
        >
          {runNotice || 'Flow AI writes into the same project assets pipeline used by Generate.'}
        </div>
      </div>

      <div
        role="separator"
        aria-label="Resize inspector panel"
        aria-orientation="vertical"
        aria-valuemin={FLOW_AI_INSPECTOR_MIN_WIDTH}
        aria-valuemax={clampFlowInspectorWidth(FLOW_AI_INSPECTOR_MAX_WIDTH, workspaceWidth)}
        aria-valuenow={effectiveInspectorWidth}
        tabIndex={0}
        onMouseDown={handleStartInspectorResize}
        onDoubleClick={handleResetInspectorWidth}
        onKeyDown={handleInspectorResizeKeyDown}
        className={`group relative flex w-3 flex-shrink-0 cursor-col-resize items-stretch justify-center transition-colors ${
          isInspectorResizing ? 'bg-sky-400/10' : 'bg-sf-dark-950/60 hover:bg-sf-dark-900'
        }`}
        title="Drag to resize the inspector. Double-click to reset."
      >
        <div className={`absolute inset-y-0 w-px transition-colors ${
          isInspectorResizing ? 'bg-sky-400/80' : 'bg-sf-dark-700 group-hover:bg-sf-dark-500'
        }`} />
        <div className={`my-auto h-14 w-1.5 rounded-full border transition-colors ${
          isInspectorResizing
            ? 'border-sky-400/70 bg-sky-400/70'
            : 'border-sf-dark-700 bg-sf-dark-800 group-hover:border-sf-dark-500'
        }`} />
      </div>

      <div
        className="flex h-full min-h-0 flex-shrink-0 flex-col border-l border-sf-dark-800 bg-sf-dark-950/80"
        style={{ width: effectiveInspectorWidth, minWidth: FLOW_AI_INSPECTOR_MIN_WIDTH }}
      >
        <div className="flex-shrink-0 border-b border-sf-dark-800 px-4 py-4">
          <div className="text-xs font-semibold uppercase tracking-[0.2em] text-sf-text-muted">
            Inspector
          </div>
          <div className="mt-2 text-sm text-sf-text-secondary">
            {selectedNode ? 'Edit the selected node and run branches directly from here.' : 'Select a node to edit it.'}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
          {!selectedNode && (
            <div className="rounded-xl border border-sf-dark-800 bg-sf-dark-900/70 p-4 text-sm text-sf-text-muted">
              Pick a node on the canvas to edit prompts, workflow choices, input assets, and runtime settings.
            </div>
          )}

          {selectedNode && (
            <>
              <InspectorRow label="Label">
                <input
                  value={selectedNode.data.label || ''}
                  onChange={(event) => updateNodeData(selectedNode.id, { label: event.target.value })}
                  className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                />
              </InspectorRow>

              {selectedNode.type === FLOW_AI_NODE_TYPES.prompt && (
                <>
                  <InspectorRow label="Prompt Text">
                    <textarea
                      rows={7}
                      value={selectedNode.data.promptText || ''}
                      onChange={(event) => updateNodeData(selectedNode.id, { promptText: event.target.value })}
                      className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                    />
                  </InspectorRow>
                </>
              )}

              {selectedNode.type === FLOW_AI_NODE_TYPES.textViewer && (
                <>
                  <div className="rounded-xl border border-sf-dark-800 bg-sf-dark-900/70 p-3 text-sm text-sf-text-secondary">
                    This node passes text through unchanged so you can inspect it before the next step.
                  </div>
                  <InspectorRow label="Resolved Text">
                    <textarea
                      rows={12}
                      readOnly
                      value={selectedNodeResolvedText}
                      placeholder="Connect text to inspect it here."
                      className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                    />
                  </InspectorRow>
                  <button
                    type="button"
                    disabled={!selectedNodeResolvedText}
                    onClick={() => {
                      if (!selectedNodeResolvedText) return
                      void navigator.clipboard?.writeText(selectedNodeResolvedText)
                    }}
                    className="inline-flex items-center gap-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Copy className="h-4 w-4" />
                    Copy Text
                  </button>
                </>
              )}

              {(selectedNode.type === FLOW_AI_NODE_TYPES.imageInput || selectedNode.type === FLOW_AI_NODE_TYPES.styleReference) && (
                <>
                  <InspectorRow label="Project Asset">
                    <select
                      value={selectedNode.data.assetId || ''}
                      onChange={(event) => {
                        const options = selectedNode.type === FLOW_AI_NODE_TYPES.styleReference ? styleAssets : imageInputAssets
                        const picked = options.find((entry) => entry.id === event.target.value)
                        updateNodeData(selectedNode.id, {
                          assetId: event.target.value,
                          assetLabel: picked?.label || '',
                        })
                      }}
                      className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                    >
                      <option value="">Select an asset…</option>
                      {(selectedNode.type === FLOW_AI_NODE_TYPES.styleReference ? styleAssets : imageInputAssets).map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </InspectorRow>
                  {selectedNode.type === FLOW_AI_NODE_TYPES.imageInput && (
                    <InspectorRow label="Video Frame Time (seconds)">
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={selectedNode.data.frameTime ?? 0}
                        onChange={(event) => updateNodeData(selectedNode.id, { frameTime: Number(event.target.value) || 0 })}
                        className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                      />
                    </InspectorRow>
                  )}
                </>
              )}

              {getFlowNodeSupportsExecution(selectedNode.type) && (
                <>
                  <InspectorRow label="Workflow">
                    <select
                      value={selectedNode.data.workflowId || ''}
                      onChange={(event) => updateNodeData(selectedNode.id, {
                        workflowId: event.target.value,
                        dependencyStatus: 'unknown',
                        dependencySummary: '',
                        ...(selectedNode.type === FLOW_AI_NODE_TYPES.imageGen
                          ? { variantCount: normalizeFlowImageVariantCount(selectedNode.data.variantCount, event.target.value) }
                          : {}),
                      })}
                      className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                    >
                      {renderWorkflowOptions(selectedNode.type).map((workflow) => (
                        <option key={workflow.id} value={workflow.id}>
                          {workflow.label}
                        </option>
                      ))}
                    </select>
                  </InspectorRow>

                  {selectedNodeWorkflowSummary && (
                    <div className={`rounded-xl border px-3 py-3 text-sm ${
                      selectedNodeWorkflowSummary.runtime === 'cloud'
                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                        : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                    }`}>
                      <div className="font-medium">
                        {selectedNodeWorkflowSummary.label}
                      </div>
                      <div className="mt-1 text-[12px] opacity-90">
                        {selectedNodeWorkflowSummary.runtime === 'cloud'
                          ? 'Runs through ComfyUI partner-node credits.'
                          : 'Runs on your local ComfyUI instance and GPU.'}
                      </div>
                    </div>
                  )}

                  {selectedNodeDependency && (
                    <div className={`rounded-xl border px-3 py-3 text-sm ${
                      selectedNodeDependency.hasBlockingIssues
                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                        : selectedNodeDependency.status === 'ready'
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'
                          : 'border-sf-dark-700 bg-sf-dark-900 text-sf-text-secondary'
                    }`}>
                      <div className="flex items-center gap-2 font-medium">
                        {selectedNodeDependency.hasBlockingIssues ? (
                          <AlertTriangle className="h-4 w-4" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4" />
                        )}
                        Workflow readiness
                      </div>
                      <div className="mt-2 text-[12px]">
                        {selectedNode.data.dependencySummary || 'Checking…'}
                      </div>
                      {selectedNodeDependency.hasBlockingIssues && (
                        <button
                          type="button"
                          onClick={() => onOpenWorkflowSetup?.()}
                          className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-400/30 bg-black/20 px-3 py-2 text-[12px] font-medium text-amber-100"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                          Open Workflow Setup
                        </button>
                      )}
                    </div>
                  )}

                  {selectedNode.type === FLOW_AI_NODE_TYPES.promptAssist && (
                    <>
                      <InspectorRow label="Inline Brief">
                        <textarea
                          rows={5}
                          value={selectedNode.data.inlinePrompt || ''}
                          onChange={(event) => updateNodeData(selectedNode.id, { inlinePrompt: event.target.value })}
                          placeholder="Optional. Leave blank to use the connected Prompt node."
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                        />
                      </InspectorRow>
                      <InspectorRow label="System Prompt Override">
                        <textarea
                          rows={5}
                          value={selectedNode.data.systemPrompt || ''}
                          onChange={(event) => updateNodeData(selectedNode.id, { systemPrompt: event.target.value })}
                          placeholder="Optional. Leave blank to use the bundled Gemini workflow default."
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                        />
                      </InspectorRow>
                      <InspectorRow label="Reference Frame Time (seconds)">
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={selectedNode.data.frameTime ?? 0}
                          onChange={(event) => updateNodeData(selectedNode.id, { frameTime: Number(event.target.value) || 0 })}
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                        />
                      </InspectorRow>
                      <InspectorRow label="Seed">
                        <div className="flex gap-2">
                          <input
                            type="number"
                            value={selectedNode.data.seed ?? 0}
                            onChange={(event) => updateNodeData(selectedNode.id, { seed: Number(event.target.value) || 0 })}
                            className="min-w-0 flex-1 rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => updateNodeData(selectedNode.id, { seed: Math.floor(Math.random() * 1000000) })}
                            className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-secondary"
                          >
                            Random
                          </button>
                        </div>
                      </InspectorRow>
                      <div className="rounded-xl border border-sf-dark-800 bg-sf-dark-900/70 p-3 text-sm text-sf-text-secondary">
                        Connect a `Prompt` node for the rough idea, and optionally connect an `Image Input` or generated frame as visual context.
                      </div>
                      <InspectorRow label="Latest Output">
                        <textarea
                          rows={8}
                          readOnly
                          value={selectedNode.data.outputText || ''}
                          placeholder="Run the node to generate prompt text."
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-secondary outline-none"
                        />
                      </InspectorRow>
                    </>
                  )}

                  {(selectedNode.type === FLOW_AI_NODE_TYPES.imageGen || selectedNode.type === FLOW_AI_NODE_TYPES.videoGen) && (
                    <>
                      <InspectorRow label="Inline Prompt Override">
                        <textarea
                          rows={4}
                          value={selectedNode.data.inlinePrompt || ''}
                          onChange={(event) => updateNodeData(selectedNode.id, { inlinePrompt: event.target.value })}
                          placeholder="Optional. Leave blank to use the connected Prompt node."
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                        />
                      </InspectorRow>
                      <InspectorRow label="Negative Prompt">
                        <textarea
                          rows={3}
                          value={selectedNode.data.negativePrompt || ''}
                          onChange={(event) => updateNodeData(selectedNode.id, { negativePrompt: event.target.value })}
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                        />
                      </InspectorRow>
                      <div className="grid grid-cols-2 gap-3">
                        <InspectorRow label="Width">
                          <input
                            type="number"
                            min="256"
                            step="64"
                            value={selectedNode.data.width ?? 1280}
                            onChange={(event) => updateNodeData(selectedNode.id, { width: Number(event.target.value) || 1280 })}
                            className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                          />
                        </InspectorRow>
                        <InspectorRow label="Height">
                          <input
                            type="number"
                            min="256"
                            step="64"
                            value={selectedNode.data.height ?? 720}
                            onChange={(event) => updateNodeData(selectedNode.id, { height: Number(event.target.value) || 720 })}
                            className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                          />
                        </InspectorRow>
                      </div>
                      <InspectorRow label="Seed">
                        <div className="flex gap-2">
                          <input
                            type="number"
                            value={selectedNode.data.seed ?? 0}
                            onChange={(event) => updateNodeData(selectedNode.id, { seed: Number(event.target.value) || 0 })}
                            className="min-w-0 flex-1 rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => updateNodeData(selectedNode.id, { seed: Math.floor(Math.random() * 1000000) })}
                            className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-secondary"
                          >
                            Random
                          </button>
                        </div>
                      </InspectorRow>
                      {selectedNode.type === FLOW_AI_NODE_TYPES.imageGen && selectedImageVariantBehavior?.mode !== 'fixed' && (
                        <InspectorRow label="Variants">
                          <input
                            type="number"
                            min="1"
                            max={selectedImageVariantBehavior?.max || 10}
                            value={selectedImageVariantCount}
                            onChange={(event) => updateNodeData(selectedNode.id, {
                              variantCount: normalizeFlowImageVariantCount(event.target.value, selectedNode.data.workflowId),
                            })}
                            className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                          />
                        </InspectorRow>
                      )}
                      {selectedNode.type === FLOW_AI_NODE_TYPES.imageGen && (
                        <div className="rounded-xl border border-sf-dark-800 bg-sf-dark-900/70 p-3 text-sm text-sf-text-secondary">
                          {getImageVariantInspectorNote(selectedNode.data.workflowId, selectedNode.data.variantCount)}
                        </div>
                      )}
                    </>
                  )}

                  {selectedNode.type === FLOW_AI_NODE_TYPES.videoGen && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <InspectorRow label="Duration (s)">
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={selectedNode.data.duration ?? 5}
                            onChange={(event) => updateNodeData(selectedNode.id, { duration: Number(event.target.value) || 5 })}
                            className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                          />
                        </InspectorRow>
                        <InspectorRow label="FPS">
                          <select
                            value={selectedNode.data.fps ?? 24}
                            onChange={(event) => updateNodeData(selectedNode.id, { fps: Number(event.target.value) || 24 })}
                            className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                          >
                            <option value={16}>16 fps</option>
                            <option value={24}>24 fps</option>
                            <option value={30}>30 fps</option>
                          </select>
                        </InspectorRow>
                      </div>
                      {selectedNode.data.workflowId === 'wan22-i2v' && (
                        <InspectorRow label="WAN Quality Preset">
                          <select
                            value={selectedNode.data.wanQualityPreset || 'balanced'}
                            onChange={(event) => updateNodeData(selectedNode.id, { wanQualityPreset: event.target.value })}
                            className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                          >
                            <option value="face-lock">Face Lock</option>
                            <option value="balanced">Balanced</option>
                          </select>
                        </InspectorRow>
                      )}
                      <div className="rounded-xl border border-sf-dark-800 bg-sf-dark-900/70 p-3 text-sm text-sf-text-secondary">
                        Video Gen currently outputs one final video per run. Multi-video bundles can come later.
                      </div>
                    </>
                  )}

                  {selectedNode.type === FLOW_AI_NODE_TYPES.videoUpscale && (
                    <>
                      <InspectorRow label="Topaz Model">
                        <select
                          value={selectedNode.data.upscaleModel || TOPAZ_VIDEO_UPSCALE_MODEL_OPTIONS[0]?.id || ''}
                          onChange={(event) => updateNodeData(selectedNode.id, {
                            upscaleModel: event.target.value,
                            estimatedCredits: null,
                            estimatedCreditsSource: null,
                          })}
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                        >
                          {TOPAZ_VIDEO_UPSCALE_MODEL_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </InspectorRow>
                      <InspectorRow label="Target Resolution">
                        <select
                          value={selectedNode.data.targetResolution || TOPAZ_VIDEO_UPSCALE_RESOLUTION_OPTIONS[0]?.id || ''}
                          onChange={(event) => updateNodeData(selectedNode.id, {
                            targetResolution: event.target.value,
                            estimatedCredits: null,
                            estimatedCreditsSource: null,
                          })}
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                        >
                          {TOPAZ_VIDEO_UPSCALE_RESOLUTION_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </InspectorRow>
                      <InspectorRow label="Upscale Creativity">
                        <select
                          value={selectedNode.data.upscaleCreativity || TOPAZ_VIDEO_UPSCALE_CREATIVITY_OPTIONS[0]?.id || ''}
                          onChange={(event) => updateNodeData(selectedNode.id, {
                            upscaleCreativity: event.target.value,
                            estimatedCredits: null,
                            estimatedCreditsSource: null,
                          })}
                          disabled={!topazVideoUpscaleModelSupportsCreativity(selectedNode.data.upscaleModel)}
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none disabled:opacity-50"
                        >
                          {TOPAZ_VIDEO_UPSCALE_CREATIVITY_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </InspectorRow>
                      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-3 text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] font-medium uppercase tracking-wide text-amber-200/80">
                              Estimated cost
                            </div>
                            <div className="mt-1 font-medium text-amber-100">
                              {selectedNodeGuideCreditsLabel}
                            </div>
                          </div>
                          <div className="rounded-full border border-amber-400/20 bg-black/20 px-2.5 py-1 text-[10px] font-medium text-amber-200">
                            Pricing guide
                          </div>
                        </div>
                        <div className="mt-2 text-xs text-amber-100/75">
                          Approximate per-second rate from the ComfyUI partner nodes pricing guide. Multiply by clip length for a rough total.
                        </div>
                        {selectedNodeLiveCreditsLabel && (
                          <div className="mt-3 rounded-lg border border-amber-400/15 bg-black/15 px-3 py-2 text-xs text-amber-100/85">
                            Current Topaz job estimate: {selectedNodeLiveCreditsLabel}
                          </div>
                        )}
                      </div>
                      <div className="rounded-xl border border-sf-dark-800 bg-sf-dark-900/70 p-3 text-sm text-sf-text-secondary">
                        Connect a `Video` edge from an upstream render, then run this node to import a new upscaled clip without replacing the source asset.
                      </div>
                    </>
                  )}

                  {selectedNode.type === FLOW_AI_NODE_TYPES.musicGen && (
                    <>
                      <InspectorRow label="Music Tags">
                        <textarea
                          rows={3}
                          value={selectedNode.data.tags || ''}
                          onChange={(event) => updateNodeData(selectedNode.id, { tags: event.target.value })}
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                        />
                      </InspectorRow>
                      <InspectorRow label="Inline Lyrics / Text">
                        <textarea
                          rows={4}
                          value={selectedNode.data.lyrics || ''}
                          onChange={(event) => updateNodeData(selectedNode.id, { lyrics: event.target.value })}
                          placeholder="Optional. Leave blank to use a connected Prompt node."
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                        />
                      </InspectorRow>
                      <div className="grid grid-cols-2 gap-3">
                        <InspectorRow label="Duration (s)">
                          <input
                            type="number"
                            min="2"
                            step="1"
                            value={selectedNode.data.duration ?? 8}
                            onChange={(event) => updateNodeData(selectedNode.id, { duration: Number(event.target.value) || 8 })}
                            className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                          />
                        </InspectorRow>
                        <InspectorRow label="BPM">
                          <input
                            type="number"
                            min="60"
                            step="1"
                            value={selectedNode.data.bpm ?? 120}
                            onChange={(event) => updateNodeData(selectedNode.id, { bpm: Number(event.target.value) || 120 })}
                            className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                          />
                        </InspectorRow>
                      </div>
                      <InspectorRow label="Key / Scale">
                        <input
                          value={selectedNode.data.keyscale || 'C Major'}
                          onChange={(event) => updateNodeData(selectedNode.id, { keyscale: event.target.value })}
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                        />
                      </InspectorRow>
                      <InspectorRow label="Seed">
                        <div className="flex gap-2">
                          <input
                            type="number"
                            value={selectedNode.data.seed ?? 0}
                            onChange={(event) => updateNodeData(selectedNode.id, { seed: Number(event.target.value) || 0 })}
                            className="min-w-0 flex-1 rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => updateNodeData(selectedNode.id, { seed: Math.floor(Math.random() * 1000000) })}
                            className="rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-secondary"
                          >
                            Random
                          </button>
                        </div>
                      </InspectorRow>
                    </>
                  )}

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleRun({ targetNodeId: selectedNode.id })}
                      disabled={isRunning}
                      className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-sf-accent px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                      Run Node
                    </button>
                  </div>
                </>
              )}

              {selectedNode.type === FLOW_AI_NODE_TYPES.output && (
                <>
                  <InspectorRow label="Asset Folder (optional)">
                    <input
                      value={selectedNode.data.folderName || ''}
                      onChange={(event) => updateNodeData(selectedNode.id, { folderName: event.target.value })}
                      placeholder="Shots"
                      className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary outline-none"
                    />
                  </InspectorRow>
                  <div className="rounded-xl border border-sf-dark-800 bg-sf-dark-900/70 p-3 text-sm text-sf-text-secondary">
                    <div>Connected results go to:</div>
                    <div className="mt-1 font-medium text-sf-text-primary break-words">
                      {formatAssetOutputDestinationSummary(selectedNode.data.folderName)}
                    </div>
                    {!String(selectedNode.data.folderName || '').trim() && (
                      <div className="mt-2 text-xs text-sf-text-muted">
                        Blank means images go to Flow AI Images, videos to Flow AI Videos, and audio to Flow AI Audio.
                      </div>
                    )}
                  </div>
                  <div className="rounded-xl border border-sf-dark-800 bg-sf-dark-900/70 p-3 text-sm text-sf-text-secondary">
                    This node marks final results for the Assets panel. It has one input each for image, video, and audio. Use multiple Asset Output nodes if you want separate folders or more than one final result of the same media type.
                  </div>
                  <div className="space-y-2">
                    {(selectedNode.data.resolvedAssetIds || []).length === 0 && (
                      <div className="rounded-lg border border-sf-dark-800 bg-sf-dark-900/70 px-3 py-3 text-sm text-sf-text-muted">
                        No connected assets yet.
                      </div>
                    )}
                    {(selectedNode.data.resolvedAssetIds || []).map((assetId) => {
                      const asset = assets.find((entry) => entry.id === assetId)
                      if (!asset) return null
                      return (
                        <button
                          key={assetId}
                          type="button"
                          onClick={() => setPreview(asset)}
                          className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-left hover:bg-sf-dark-800"
                        >
                          <div className="truncate text-sm font-medium text-sf-text-primary">
                            {asset.name}
                          </div>
                          <div className="mt-1 text-[11px] text-sf-text-muted">
                            {asset.type}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    duplicateFlowNodes([selectedNode.id])
                  }}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-sm text-sf-text-primary"
                >
                  <Copy className="h-4 w-4" />
                  Duplicate
                </button>
                <button
                  type="button"
                  onClick={() => {
                    deleteFlowSelection()
                  }}
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200"
                >
                  <X className="h-4 w-4" />
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

