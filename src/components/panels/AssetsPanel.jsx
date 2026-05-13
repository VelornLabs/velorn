import { Upload, FolderOpen, Image, Video, Music, Search, Grid, List, Trash2, Edit3, Play, FileVideo, FileAudio, FileImage, Loader2, FolderPlus, ChevronRight, ChevronDown, ChevronLeft, Home, Minus, Plus, MoreVertical, FolderInput, Wand2, Layers, Film, VolumeX, Volume2, ArrowUpDown, ArrowUp, ArrowDown, Copy, Type } from 'lucide-react'
import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import useAssetsStore from '../../stores/assetsStore'
import useProjectStore from '../../stores/projectStore'
import useTimelineStore from '../../stores/timelineStore'
import { importAsset, isElectron, writeGeneratedOverlayToProject, deleteProjectFile } from '../../services/fileSystem'
import { enqueuePlaybackTranscode } from '../../services/playbackCache'
import { enqueueProxyTranscode, isProxyPlaybackEnabled } from '../../services/proxyCache'
import { unstitchSequenceAsset } from '../../services/comfyAutoImport'
import { deleteSpriteFromProject } from '../../services/thumbnailSprites'
import MaskGenerationDialog from '../MaskGenerationDialog'
import OverlayGeneratorModal from '../OverlayGeneratorModal'
import TopazVideoUpscaleDialog from '../TopazVideoUpscaleDialog'
import ConfirmDialog from '../ConfirmDialog'
import NewTimelineDialog from '../NewTimelineDialog'
// Thumbnail size presets (xs = extra small for denser grid)
const THUMBNAIL_SIZES = {
  xs: { cols: 5, iconSize: 'w-3 h-3', playSize: 'w-3 h-3', badgeSize: 'text-[5px]', nameSize: 'text-[8px]', infoSize: 'text-[7px]' },
  small: { cols: 3, iconSize: 'w-4 h-4', playSize: 'w-4 h-4', badgeSize: 'text-[6px]', nameSize: 'text-[9px]', infoSize: 'text-[8px]' },
  medium: { cols: 2, iconSize: 'w-6 h-6', playSize: 'w-6 h-6', badgeSize: 'text-[7px]', nameSize: 'text-[10px]', infoSize: 'text-[9px]' },
  large: { cols: 1, iconSize: 'w-8 h-8', playSize: 'w-8 h-8', badgeSize: 'text-[8px]', nameSize: 'text-[11px]', infoSize: 'text-[10px]' },
}
const THUMBNAIL_SIZE_ORDER = ['xs', 'small', 'medium', 'large']
const ASSET_DELETE_MODE_KEY = 'assetsDeleteMode'
const ASSET_DELETE_MODE_DISK = 'disk'
const ASSET_DELETE_MODE_PROJECT_ONLY = 'project-only'
const FOLDER_TILE_ICON_SIZES = {
  xs: 'w-10 h-10',
  small: 'w-12 h-12',
  medium: 'w-16 h-16',
  large: 'w-20 h-20',
}
let transparentAssetDragImage = null

const getTransparentAssetDragImage = () => {
  if (transparentAssetDragImage) return transparentAssetDragImage
  if (typeof document === 'undefined') return null

  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  transparentAssetDragImage = canvas
  return transparentAssetDragImage
}

const normalizeSearchText = (value) => String(value ?? '').toLowerCase()

const assetMatchesSearch = (asset, normalizedQuery) => {
  if (!normalizedQuery) return true
  return normalizeSearchText(asset?.name).includes(normalizedQuery)
    || normalizeSearchText(asset?.prompt).includes(normalizedQuery)
}

function LazyAssetThumbnail({
  asset,
  Icon,
  isActive = true,
  iconClassName = 'w-3.5 h-3.5 text-sf-text-muted',
  imageAlt = '',
  videoClassName = 'w-full h-full object-cover',
  imageClassName = 'w-full h-full object-cover',
  videoProps = {},
}) {
  const containerRef = useRef(null)
  const [shouldLoad, setShouldLoad] = useState(false)

  useEffect(() => {
    if (!isActive) {
      setShouldLoad(false)
      return undefined
    }

    const element = containerRef.current
    if (!element) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true)
      return undefined
    }

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)
      setShouldLoad(visible)
    }, { root: null, rootMargin: '600px 0px', threshold: 0.01 })

    observer.observe(element)
    return () => observer.disconnect()
  }, [isActive])

  const fallback = Icon ? <Icon className={iconClassName} /> : null

  return (
    <div ref={containerRef} className="w-full h-full flex items-center justify-center">
      {shouldLoad && asset?.type === 'video' && asset?.url ? (
        <video src={asset.url} className={videoClassName} muted preload="none" {...videoProps} />
      ) : shouldLoad && asset?.type === 'image' && asset?.url ? (
        <img src={asset.url} alt={imageAlt} className={imageClassName} loading="lazy" decoding="async" />
      ) : fallback}
    </div>
  )
}

function AssetsPanel({ isActive = true }) {
  const [viewMode, setViewMode] = useState('grid')
  const [thumbnailSize, setThumbnailSize] = useState('medium')
  const [assetDeleteMode, setAssetDeleteMode] = useState(() => {
    try {
      const saved = localStorage.getItem(ASSET_DELETE_MODE_KEY)
      if (saved === ASSET_DELETE_MODE_DISK || saved === ASSET_DELETE_MODE_PROJECT_ONLY) return saved
    } catch (_) {}
    return ASSET_DELETE_MODE_DISK
  })
  const [searchQuery, setSearchQuery] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editingType, setEditingType] = useState(null)
  const [editName, setEditName] = useState('')
  const [isImporting, setIsImporting] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isAssetDragActive, setIsAssetDragActive] = useState(false)
  const [assetDragPreview, setAssetDragPreview] = useState(null) // { assetId, clientX, clientY }
  const fileInputRef = useRef(null)
  const activeAssetDragIdRef = useRef(null)
  
  // Folder state
  const [currentFolderId, setCurrentFolderId] = useState(null) // null = root
  const [showNewFolderInput, setShowNewFolderInput] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [contextMenu, setContextMenu] = useState(null) // { x, y, assetId?, folderId?, sequenceId? }
  const newFolderInputRef = useRef(null)
  
  // Mask generation state
  const [maskDialogAsset, setMaskDialogAsset] = useState(null) // Asset to generate mask for
  const [topazUpscaleAsset, setTopazUpscaleAsset] = useState(null)
  // Overlay generator modal (matte/letterbox/vignette/grain)
  const [overlayModalOpen, setOverlayModalOpen] = useState(false)
  const [overlayModalInitialType, setOverlayModalInitialType] = useState('letterbox')
  const [overlayModalFolderId, setOverlayModalFolderId] = useState(null) // when opened from folder context menu
  const [confirmDialog, setConfirmDialog] = useState(null) // { title, message, confirmLabel, cancelLabel, tone }
  const [showNewTimelineDialog, setShowNewTimelineDialog] = useState(false)
  const confirmResolverRef = useRef(null)
  
  // Selected assets (array for multi-select; used for delete and drag-to-folder)
  const [selectedAssetIds, setSelectedAssetIds] = useState([])
  const [selectedSequenceId, setSelectedSequenceId] = useState(null)
  const [openingSequenceId, setOpeningSequenceId] = useState(null)
  const [dragOverFolderId, setDragOverFolderId] = useState(null) // 'root' | folderId for drop highlight
  // List view: which folder IDs are expanded to show contents inline
  const [expandedFolderIds, setExpandedFolderIds] = useState(() => new Set())
  // List details view: sort by column (name | type | source | date), sortDir (asc | desc)
  const LIST_SORT_KEY = 'assetsListSort'
  const [listSortBy, setListSortBy] = useState(() => {
    try {
      const s = localStorage.getItem(LIST_SORT_KEY)
      if (s) {
        const { by, dir } = JSON.parse(s)
        if (['name', 'type', 'source', 'date'].includes(by) && (dir === 'asc' || dir === 'desc')) return { by, dir }
      }
    } catch (_) {}
    return { by: 'date', dir: 'desc' }
  })
  const panelRef = useRef(null)

  const setListSort = (by) => {
    setListSortBy(prev => {
      const nextDir = prev.by === by && prev.dir === 'asc' ? 'desc' : 'asc'
      const next = { by, dir: nextDir }
      try { localStorage.setItem(LIST_SORT_KEY, JSON.stringify(next)) } catch (_) {}
      return next
    })
  }

  const toggleFolderExpanded = (folderId) => {
    setExpandedFolderIds(prev => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  const ASSET_DRAG_TYPE = 'application/x-comfystudio-asset-ids'
  const SEQUENCE_DRAG_TYPE = 'application/x-comfystudio-sequence-ids'

  const notifyAssetDragStart = (assetId, assetIds) => {
    if (typeof window === 'undefined') return
    try {
      window.dispatchEvent(new CustomEvent('comfystudio-assets-drag-start', {
        detail: { assetId, assetIds }
      }))
    } catch (_) {}
  }

  const notifyAssetDragEnd = () => {
    if (typeof window === 'undefined') return
    try {
      window.dispatchEvent(new Event('comfystudio-assets-drag-end'))
    } catch (_) {}
  }

  const clearAssetDragPreview = useCallback(() => {
    activeAssetDragIdRef.current = null
    setIsAssetDragActive(false)
    setAssetDragPreview(null)
  }, [])

  const updateAssetDragPreviewPosition = useCallback((clientX, clientY) => {
    const activeAssetId = activeAssetDragIdRef.current
    if (!activeAssetId) return
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return
    if (clientX === 0 && clientY === 0) return

    const panelBounds = panelRef.current?.getBoundingClientRect()
    const isInsidePanel = Boolean(
      panelBounds
      && clientX >= panelBounds.left
      && clientX <= panelBounds.right
      && clientY >= panelBounds.top
      && clientY <= panelBounds.bottom
    )

    if (!isInsidePanel) {
      setAssetDragPreview((prev) => (prev ? null : prev))
      return
    }

    setAssetDragPreview((prev) => {
      if (
        prev
        && prev.assetId === activeAssetId
        && prev.clientX === clientX
        && prev.clientY === clientY
      ) {
        return prev
      }
      return { assetId: activeAssetId, clientX, clientY }
    })
  }, [])

  const startAssetDrag = useCallback((e, assetId, assetIds) => {
    const orderedAssetIds = [
      assetId,
      ...(Array.isArray(assetIds) ? assetIds : []).filter((id) => id && id !== assetId),
    ]
    const data = JSON.stringify(orderedAssetIds)
    e.dataTransfer.setData('assetId', assetId)
    e.dataTransfer.setData(ASSET_DRAG_TYPE, data)
    e.dataTransfer.setData('text/plain', data)
    e.dataTransfer.effectAllowed = 'copyMove'

    const dragImage = getTransparentAssetDragImage()
    if (dragImage && typeof e.dataTransfer.setDragImage === 'function') {
      e.dataTransfer.setDragImage(dragImage, 0, 0)
    }

    activeAssetDragIdRef.current = assetId
    setIsAssetDragActive(true)
    updateAssetDragPreviewPosition(e.clientX, e.clientY)
    notifyAssetDragStart(assetId, orderedAssetIds)
  }, [updateAssetDragPreviewPosition])

  const startSequenceDrag = useCallback((e, sequenceId) => {
    if (!sequenceId) return
    const ids = [sequenceId]
    const data = JSON.stringify(ids)
    e.dataTransfer.setData(SEQUENCE_DRAG_TYPE, data)
    e.dataTransfer.setData('text/plain', data)
    e.dataTransfer.effectAllowed = 'move'
  }, [SEQUENCE_DRAG_TYPE])

  const endAssetDrag = useCallback(() => {
    clearAssetDragPreview()
    notifyAssetDragEnd()
  }, [clearAssetDragPreview])

  // Color palette for folders and assets (null = no color)
  const COLOR_PALETTE = [
    null,
    '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
    '#3b82f6', '#8b5cf6', '#ec4899', '#78716c',
  ]

  // Get assets from store
  const { 
    assets, 
    currentPreview, 
    setPreview, 
    setPreviewMode,
    removeAsset, 
    renameAsset, 
    addAsset,
    updateAsset,
    folders,
    addFolder,
    removeFolder,
    renameFolder,
    setFolderColor,
    setAssetColor,
    moveAssetToFolder,
    moveAssetsToFolder,
    generateAssetSprite,
    getAssetSprite,
    setAssetAudioEnabled,
  } = useAssetsStore()
  const { currentProject, currentProjectHandle, currentTimelineId, switchTimeline, renameTimeline, setTimelineColor, moveTimelineToFolder, duplicateTimeline, deleteTimeline, getCurrentTimelineSettings } = useProjectStore()
  const { isPlaying: timelineIsPlaying, togglePlay: timelineTogglePlay, removeAudioClipsForAsset, clearSelection: clearTimelineSelection } = useTimelineStore()
  
  // Load thumbnail size from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('assetsThumbnailSize')
    if (saved && THUMBNAIL_SIZES[saved]) {
      setThumbnailSize(saved)
    }
  }, [])
  
  // Save thumbnail size to localStorage
  const setAndSaveThumbnailSize = (size) => {
    setThumbnailSize(size)
    localStorage.setItem('assetsThumbnailSize', size)
  }

  const setAndSaveAssetDeleteMode = useCallback((mode) => {
    const normalized = mode === ASSET_DELETE_MODE_PROJECT_ONLY
      ? ASSET_DELETE_MODE_PROJECT_ONLY
      : ASSET_DELETE_MODE_DISK
    setAssetDeleteMode(normalized)
    try {
      localStorage.setItem(ASSET_DELETE_MODE_KEY, normalized)
    } catch (_) {}
  }, [])

  const shouldDeleteFromDisk = assetDeleteMode === ASSET_DELETE_MODE_DISK
  
  // Supported file types
  const SUPPORTED_VIDEO = ['.mp4', '.webm', '.mov']
  const SUPPORTED_AUDIO = ['.mp3', '.wav', '.ogg']
  const SUPPORTED_IMAGE = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
  const ALL_SUPPORTED = [...SUPPORTED_VIDEO, ...SUPPORTED_AUDIO, ...SUPPORTED_IMAGE]
  
  // Determine file category from extension
  const getFileCategory = (filename) => {
    const ext = '.' + filename.split('.').pop().toLowerCase()
    if (SUPPORTED_VIDEO.includes(ext)) return 'video'
    if (SUPPORTED_AUDIO.includes(ext)) return 'audio'
    if (SUPPORTED_IMAGE.includes(ext)) return 'images'
    return null
  }
  
  // Handle file import
  const handleImport = async (files) => {
    if (!currentProjectHandle || files.length === 0) return
    
    setIsImporting(true)
    
    for (const file of files) {
      const category = getFileCategory(file.name)
      if (!category) {
        console.warn(`Unsupported file type: ${file.name}`)
        continue
      }
      
      try {
        const assetInfo = await importAsset(currentProjectHandle, file, category)
        
        // Add to assets store with URL for playback
        const newAsset = addAsset({
          ...assetInfo,
          url: URL.createObjectURL(file),
          folderId: currentFolderId, // Add to current folder
          settings: {
            duration: assetInfo.duration,
            fps: assetInfo.fps,
          },
        })
        
        // Flame-style: transcode video for smooth playback (Electron only)
        if (category === 'video' && isElectron() && currentProjectHandle && newAsset?.absolutePath) {
          enqueuePlaybackTranscode(currentProjectHandle, newAsset.id, newAsset.absolutePath).catch(() => {})
          // Low-res preview proxy (NLE-style). Only spawned when the user
          // has proxies enabled — otherwise we'd waste disk/cpu on every
          // import. If they turn proxies on later, the "Generate missing
          // proxies" button in the preview panel backfills existing videos.
          if (isProxyPlaybackEnabled()) {
            enqueueProxyTranscode(currentProjectHandle, newAsset.id, newAsset.absolutePath).catch(() => {})
          }
        }
        
        // Auto-generate thumbnail sprites for videos in background
        if (category === 'video' && assetInfo.duration > 0.5 && newAsset) {
          const projectPath = typeof currentProjectHandle === 'string' ? currentProjectHandle : null
          // Generate sprites asynchronously (don't await)
          generateAssetSprite(newAsset.id, projectPath).catch(err => {
            console.warn('Auto-sprite generation failed:', err)
          })
        }
      } catch (err) {
        console.error(`Error importing ${file.name}:`, err)
      }
    }
    
    setIsImporting(false)
  }
  
  // Handle file input change
  const handleFileInputChange = (e) => {
    const files = Array.from(e.target.files || [])
    handleImport(files)
    e.target.value = ''
  }
  
  // Handle drag and drop
  const handleDragOver = (e) => {
    e.preventDefault()
    const isInternalAssetDrag = e.dataTransfer?.types?.includes(ASSET_DRAG_TYPE)
    const isInternalSequenceDrag = e.dataTransfer?.types?.includes(SEQUENCE_DRAG_TYPE)
    if (isInternalAssetDrag || isInternalSequenceDrag) {
      setIsDragOver(false)
      if (isInternalAssetDrag) {
        updateAssetDragPreviewPosition(e.clientX, e.clientY)
      }
      return
    }
    e.stopPropagation()
    setIsDragOver(true)
  }
  
  const handleDragLeave = (e) => {
    e.preventDefault()
    const isInternalAssetDrag = e.dataTransfer?.types?.includes(ASSET_DRAG_TYPE)
    const isInternalSequenceDrag = e.dataTransfer?.types?.includes(SEQUENCE_DRAG_TYPE)
    if (!isInternalAssetDrag && !isInternalSequenceDrag) {
      e.stopPropagation()
    }
    setIsDragOver(false)
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOverFolderId(null)
  }
  
  const handleDrop = (e) => {
    e.preventDefault()
    const isInternalAssetDrag = e.dataTransfer?.types?.includes(ASSET_DRAG_TYPE)
    const isInternalSequenceDrag = e.dataTransfer?.types?.includes(SEQUENCE_DRAG_TYPE)
    if (!isInternalAssetDrag && !isInternalSequenceDrag) {
      e.stopPropagation()
    }
    setIsDragOver(false)
    setDragOverFolderId(null)

    // Ignore internal asset drag (handled by folder drop targets)
    if (isInternalAssetDrag || isInternalSequenceDrag) return

    const files = Array.from(e.dataTransfer.files || [])
    const validFiles = files.filter(f => {
      const ext = '.' + f.name.split('.').pop().toLowerCase()
      return ALL_SUPPORTED.includes(ext)
    })
    if (validFiles.length > 0) {
      handleImport(validFiles)
    }
  }
  
  // Open file picker
  const openFilePicker = () => {
    fileInputRef.current?.click()
  }

  const closeOverlayModal = () => {
    setOverlayModalOpen(false)
  }

  const openOverlayGenerator = (type = 'letterbox', folderId = null) => {
    setOverlayModalFolderId(folderId)
    setOverlayModalInitialType(type)
    setOverlayModalOpen(true)
  }

  // Get current folder and its subfolders
  const currentFolder = currentFolderId ? folders?.find(f => f.id === currentFolderId) : null
  const subFolders = (folders || []).filter(f => f.parentId === currentFolderId)
  const projectTimelines = currentProject?.timelines || []
  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  
  // Filter assets by current folder and search query
  const filteredAssets = assets.filter(asset => {
    const matchesFolder = (asset.folderId || null) === currentFolderId
    return matchesFolder && assetMatchesSearch(asset, normalizedSearchQuery)
  })

  const filteredTimelines = useMemo(() => {
    return projectTimelines.filter((timeline) => {
      const timelineFolderId = timeline?.folderId || null
      const matchesFolder = timelineFolderId === currentFolderId
      if (!matchesFolder) return false
      if (!normalizedSearchQuery) return true
      return normalizeSearchText(timeline?.name).includes(normalizedSearchQuery)
    })
  }, [currentFolderId, normalizedSearchQuery, projectTimelines])
  
  // Get subfolders by parent (for list view expand)
  const getSubfoldersOf = (parentId) => (folders || []).filter(f => f.parentId === parentId)
  // Get assets in folder, optionally filtered by search
  const getAssetsInFolder = (folderId, search = '') => {
    const normalizedQuery = String(search || '').trim().toLowerCase()
    return assets.filter(a => {
      const inFolder = (a.folderId || null) === folderId
      return inFolder && assetMatchesSearch(a, normalizedQuery)
    })
  }
  const getTimelinesInFolder = (folderId, search = '') => {
    const normalizedQuery = String(search || '').trim().toLowerCase()
    return projectTimelines.filter((timeline) => {
      const inFolder = (timeline?.folderId || null) === folderId
      return inFolder && (!normalizedQuery || normalizeSearchText(timeline?.name).includes(normalizedQuery))
    })
  }

  // Count assets recursively so parent folders (e.g. Generated) reflect nested content.
  const folderDescendantIdsByFolderId = useMemo(() => {
    const childrenByParent = new Map()
    for (const folder of (folders || [])) {
      const parentId = folder?.parentId || null
      const existing = childrenByParent.get(parentId) || []
      existing.push(folder.id)
      childrenByParent.set(parentId, existing)
    }

    const descendantsByFolder = new Map()
    for (const folder of (folders || [])) {
      const descendants = new Set([folder.id])
      const queue = [folder.id]
      while (queue.length > 0) {
        const currentFolderId = queue.shift()
        const childIds = childrenByParent.get(currentFolderId) || []
        for (const childId of childIds) {
          if (descendants.has(childId)) continue
          descendants.add(childId)
          queue.push(childId)
        }
      }
      descendantsByFolder.set(folder.id, descendants)
    }

    return descendantsByFolder
  }, [folders])

  const getFolderItemCount = useCallback((folderId) => {
    const descendants = folderDescendantIdsByFolderId.get(folderId)
    if (!descendants || descendants.size === 0) return 0
    const assetCount = assets.reduce((count, asset) => (
      descendants.has(asset.folderId || null) ? count + 1 : count
    ), 0)
    const timelineCount = projectTimelines.reduce((count, timeline) => (
      descendants.has(timeline?.folderId || null) ? count + 1 : count
    ), 0)
    return assetCount + timelineCount
  }, [assets, folderDescendantIdsByFolderId, projectTimelines])

  const deleteAssetFilesOnly = useCallback(async (assetIds = []) => {
    const ids = Array.from(new Set((assetIds || []).filter(Boolean)))
    if (ids.length === 0) return
    const deleteSet = new Set(ids)
    const assetsToDelete = assets.filter((asset) => deleteSet.has(asset.id))
    if (assetsToDelete.length === 0) return

    const remainingAssets = assets.filter((asset) => !deleteSet.has(asset.id))
    const remainingRelativePaths = new Set()
    const remainingAbsolutePaths = new Set()
    const addPath = (setRef, value) => {
      if (typeof value !== 'string') return
      const normalized = value.trim()
      if (!normalized) return
      setRef.add(normalized)
    }

    for (const asset of remainingAssets) {
      addPath(remainingRelativePaths, asset?.path)
      addPath(remainingRelativePaths, asset?.playbackCachePath)
      addPath(remainingRelativePaths, asset?.proxyPath)
      if (!asset?.path) addPath(remainingAbsolutePaths, asset?.absolutePath)
      addPath(remainingAbsolutePaths, asset?.sprite?.spritePath)
    }

    const deleteRelativePath = async (relativePath) => {
      const normalized = typeof relativePath === 'string' ? relativePath.trim() : ''
      if (!normalized || !currentProjectHandle) return
      if (remainingRelativePaths.has(normalized)) return
      try {
        await deleteProjectFile(currentProjectHandle, normalized)
      } catch (_) {
        // Best effort: file may have already been removed or moved.
      }
    }

    const deleteAbsolutePath = async (absolutePath) => {
      const normalized = typeof absolutePath === 'string' ? absolutePath.trim() : ''
      if (!normalized || !isElectron() || !window.electronAPI?.deleteFile) return
      if (remainingAbsolutePaths.has(normalized)) return
      try {
        await window.electronAPI.deleteFile(normalized)
      } catch (_) {
        // Best effort for external/derived files.
      }
    }

    for (const asset of assetsToDelete) {
      const relativeCandidates = new Set([
        asset?.path,
        asset?.playbackCachePath,
        asset?.proxyPath,
      ].filter(Boolean))
      for (const relativePath of relativeCandidates) {
        await deleteRelativePath(relativePath)
      }

      if (!asset?.path && asset?.absolutePath) {
        await deleteAbsolutePath(asset.absolutePath)
      }

      if (isElectron() && typeof currentProjectHandle === 'string' && asset?.sprite) {
        try {
          await deleteSpriteFromProject(currentProjectHandle, asset.id)
        } catch (_) {
          // Ignore sprite cleanup failures.
        }
      } else if (asset?.sprite?.spritePath) {
        await deleteAbsolutePath(asset.sprite.spritePath)
      }
    }
  }, [assets, currentProjectHandle])

  // Get folder breadcrumb path
  const getFolderPath = () => {
    if (!currentFolderId) return []
    const path = []
    let folderId = currentFolderId
    while (folderId) {
      const folder = folders?.find(f => f.id === folderId)
      if (folder) {
        path.unshift(folder)
        folderId = folder.parentId
      } else {
        break
      }
    }
    return path
  }

  const getIcon = (type) => {
    switch (type) {
      case 'image': return Image
      case 'video': return Video
      case 'audio': return Music
      case 'mask': return Layers
      default: return FolderOpen
    }
  }
  
  // Check if asset can have a mask generated
  const canGenerateMask = (asset) => {
    return asset.type === 'video' || asset.type === 'image'
  }
  
  // Handle opening mask generation dialog
  const handleOpenMaskDialog = (assetId) => {
    const asset = assets.find(a => a.id === assetId)
    if (asset && canGenerateMask(asset)) {
      setMaskDialogAsset(asset)
      setContextMenu(null)
    }
  }
  
  // Check if asset can have thumbnails generated (videos only)
  const canGenerateThumbnails = (asset) => {
    return asset.type === 'video' && asset.duration > 0.5
  }

  const canUpscaleVideo = (asset) => {
    return asset?.type === 'video'
  }

  const handleOpenTopazUpscaleDialog = (assetId) => {
    const asset = assets.find(a => a.id === assetId)
    if (!asset || !canUpscaleVideo(asset)) return
    setTopazUpscaleAsset(asset)
    setContextMenu(null)
  }

  
  // Handle generating thumbnail sprite
  const handleGenerateThumbnails = async (assetId) => {
    setContextMenu(null)
    const asset = assets.find(a => a.id === assetId)
    if (!asset || !canGenerateThumbnails(asset)) return
    
    // Get project path for saving sprites
    const projectPath = typeof currentProjectHandle === 'string' ? currentProjectHandle : null
    
    try {
      await generateAssetSprite(assetId, projectPath)
    } catch (err) {
      console.error('Failed to generate thumbnails:', err)
    }
  }

  // Format relative time
  const formatTime = (isoString) => {
    const date = new Date(isoString)
    const now = new Date()
    const diffMs = now - date
    const diffMins = Math.floor(diffMs / 60000)
    
    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    return date.toLocaleDateString()
  }

  const formatSequenceDuration = (seconds) => {
    const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const secs = totalSeconds % 60

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    }

    return `${minutes}:${String(secs).padStart(2, '0')}`
  }

  // Asset value getters for sorting and display
  const getAssetSource = (a) => (a.isImported ? 'IMP' : 'AI')
  const getAssetDate = (a) => new Date(a.createdAt || a.imported || 0).getTime()
  const getTimelineDate = (timeline) => new Date(timeline?.modified || timeline?.created || 0).getTime()
  const getAssetTypeLabel = (a) => {
    if (a.type === 'mask') return 'Mask'
    if (a.type === 'video') return 'Video'
    if (a.type === 'image') return 'Image'
    if (a.type === 'audio') return 'Audio'
    return a.type || '—'
  }
  const getBrowserItemName = (entry) => {
    if (entry.kind === 'sequence') return entry.item?.name || 'Untitled Sequence'
    return entry.item?.name || ''
  }
  const getBrowserItemTypeLabel = (entry) => {
    if (entry.kind === 'sequence') return 'Sequence'
    return getAssetTypeLabel(entry.item)
  }
  const getBrowserItemSource = (entry) => {
    if (entry.kind === 'sequence') return 'SEQ'
    return getAssetSource(entry.item)
  }
  const getBrowserItemDate = (entry) => {
    if (entry.kind === 'sequence') return getTimelineDate(entry.item)
    return getAssetDate(entry.item)
  }

  const sortAssets = (list) => {
    const { by, dir } = listSortBy
    const mult = dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      let va, vb
      switch (by) {
        case 'name': va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); return mult * (va < vb ? -1 : va > vb ? 1 : 0)
        case 'type': va = getAssetTypeLabel(a); vb = getAssetTypeLabel(b); return mult * (va < vb ? -1 : va > vb ? 1 : 0)
        case 'source': va = getAssetSource(a); vb = getAssetSource(b); return mult * (va < vb ? -1 : va > vb ? 1 : 0)
        case 'date': default: va = getAssetDate(a); vb = getAssetDate(b); return mult * (va - vb)
      }
    })
  }

  const sortBrowserItems = (list) => {
    const { by, dir } = listSortBy
    const mult = dir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      let va, vb
      switch (by) {
        case 'name':
          va = getBrowserItemName(a).toLowerCase()
          vb = getBrowserItemName(b).toLowerCase()
          return mult * (va < vb ? -1 : va > vb ? 1 : 0)
        case 'type':
          va = getBrowserItemTypeLabel(a)
          vb = getBrowserItemTypeLabel(b)
          return mult * (va < vb ? -1 : va > vb ? 1 : 0)
        case 'source':
          va = getBrowserItemSource(a)
          vb = getBrowserItemSource(b)
          return mult * (va < vb ? -1 : va > vb ? 1 : 0)
        case 'date':
        default:
          va = getBrowserItemDate(a)
          vb = getBrowserItemDate(b)
          return mult * (va - vb)
      }
    })
  }

  // Handle double-click to preview
  const handleDoubleClick = (asset) => {
    if (timelineIsPlaying) {
      timelineTogglePlay()
    }
    setPreview(asset)
  }
  
  // Handle single-click to select and preview (with multi-select: Ctrl/Cmd toggle, Shift range)
  const handleClick = (e, asset) => {
    panelRef.current?.focus?.()
    clearTimelineSelection()
    setSelectedSequenceId(null)
    if (timelineIsPlaying) {
      timelineTogglePlay()
    }
    if (e?.ctrlKey || e?.metaKey) {
      setSelectedAssetIds(prev =>
        prev.includes(asset.id) ? prev.filter(id => id !== asset.id) : [...prev, asset.id]
      )
      setPreview(asset)
      return
    }
    if (e?.shiftKey) {
      const idx = filteredAssets.findIndex(a => a.id === asset.id)
      const lastId = selectedAssetIds[selectedAssetIds.length - 1]
      const lastIdx = filteredAssets.findIndex(a => a.id === lastId)
      const from = lastIdx >= 0 ? Math.min(lastIdx, idx) : idx
      const to = lastIdx >= 0 ? Math.max(lastIdx, idx) : idx
      const rangeIds = filteredAssets.slice(from, to + 1).map(a => a.id)
      setSelectedAssetIds(rangeIds)
      setPreview(asset)
      return
    }
    setSelectedAssetIds([asset.id])
    setPreview(asset)
  }

  const handleSequenceClick = (timeline) => {
    if (!timeline?.id) return
    panelRef.current?.focus?.()
    clearTimelineSelection()
    setSelectedSequenceId(timeline.id)
    setSelectedAssetIds([])
  }

  const handleSequenceDoubleClick = async (timeline) => {
    if (!timeline?.id) return
    setSelectedSequenceId(timeline.id)
    setSelectedAssetIds([])
    if (timelineIsPlaying) {
      timelineTogglePlay()
    }
    setPreviewMode('timeline')
    if (timeline.id === currentTimelineId) return

    setOpeningSequenceId(timeline.id)
    try {
      await switchTimeline(timeline.id)
    } finally {
      setOpeningSequenceId(null)
    }
  }

  const requestConfirm = useCallback(({
    title = 'Confirm action',
    message = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    tone = 'danger',
  }) => {
    if (confirmResolverRef.current) {
      confirmResolverRef.current(false)
      confirmResolverRef.current = null
    }
    return new Promise((resolve) => {
      confirmResolverRef.current = resolve
      setConfirmDialog({ title, message, confirmLabel, cancelLabel, tone })
    })
  }, [])

  const resolveConfirmDialog = useCallback((accepted) => {
    setConfirmDialog(null)
    const resolve = confirmResolverRef.current
    confirmResolverRef.current = null
    if (resolve) resolve(Boolean(accepted))
  }, [])

  useEffect(() => () => {
    if (confirmResolverRef.current) {
      confirmResolverRef.current(false)
      confirmResolverRef.current = null
    }
  }, [])
  
  // Keyboard handler for Delete/Backspace (and Escape to clear selection)
  useEffect(() => {
    const handleKeyDown = async (e) => {
      if (!panelRef.current?.contains(document.activeElement) && document.activeElement !== panelRef.current) return
      if (confirmDialog) return
      const active = document.activeElement
      if (editingId || (active && (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable))) return

      if (e.key === 'Escape') {
        clearTimelineSelection()
        setSelectedAssetIds([])
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAssetIds.length > 0) {
        e.preventDefault()
        e.stopPropagation()
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation()
        const count = selectedAssetIds.length
        const confirmed = await requestConfirm({
          title: count === 1 ? 'Delete asset?' : 'Delete selected assets?',
          message: shouldDeleteFromDisk
            ? (
                count === 1
                  ? 'Delete this asset?\n\nThis also deletes its local file from the project folder (when available). This cannot be undone.'
                  : `Delete ${count} selected assets?\n\nThis also deletes their local files from the project folder (when available). This cannot be undone.`
              )
            : (
                count === 1
                  ? 'Delete this asset from the project?\n\nThe source file on disk will be kept.'
                  : `Delete ${count} selected assets from the project?\n\nSource files on disk will be kept.`
              ),
          confirmLabel: count === 1 ? 'Delete asset' : 'Delete assets',
          cancelLabel: 'Keep',
          tone: 'danger',
        })
        if (confirmed) {
          if (shouldDeleteFromDisk) {
            await deleteAssetFilesOnly(selectedAssetIds)
          }
          selectedAssetIds.forEach(id => removeAsset(id))
          setSelectedAssetIds([])
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [selectedAssetIds, editingId, removeAsset, requestConfirm, confirmDialog, clearTimelineSelection, deleteAssetFilesOnly, shouldDeleteFromDisk])
  
  // Handle folder click
  const handleFolderClick = (folderId) => {
    panelRef.current?.focus?.()
    clearTimelineSelection()
    setSelectedSequenceId(null)
    setCurrentFolderId(folderId)
  }

  // Start editing name
  const startEditing = (e, asset) => {
    e.stopPropagation()
    setContextMenu(null)
    setEditingType('asset')
    setEditingId(asset.id)
    setEditName(asset.name || '')
  }

  const startSequenceEditing = (e, timeline) => {
    e?.stopPropagation?.()
    if (!timeline?.id) return
    setContextMenu(null)
    setEditingType('sequence')
    setEditingId(timeline.id)
    setEditName(timeline.name || '')
    setSelectedSequenceId(timeline.id)
    setSelectedAssetIds([])
  }

  const startFolderEditing = (e, folder) => {
    e?.stopPropagation?.()
    if (!folder?.id) return
    setContextMenu(null)
    setEditingType('folder')
    setEditingId(folder.id)
    setEditName(folder.name || '')
  }

  // Save edited name
  const saveEdit = (e) => {
    e.preventDefault()
    if (editName.trim() && editingId) {
      if (editingType === 'sequence') {
        renameTimeline(editingId, editName.trim())
      } else if (editingType === 'folder') {
        renameFolder(editingId, editName.trim())
      } else {
        renameAsset(editingId, editName.trim())
      }
    }
    setEditingType(null)
    setEditingId(null)
    setEditName('')
  }

  // Handle delete
  const handleDelete = async (e, id) => {
    e.stopPropagation()
    const confirmed = await requestConfirm({
      title: 'Delete asset?',
      message: shouldDeleteFromDisk
        ? 'Delete this asset?\n\nThis also deletes its local file from the project folder (when available). This cannot be undone.'
        : 'Delete this asset from the project?\n\nThe source file on disk will be kept.',
      confirmLabel: 'Delete asset',
      cancelLabel: 'Keep',
      tone: 'danger',
    })
    if (confirmed) {
      if (shouldDeleteFromDisk) {
        await deleteAssetFilesOnly([id])
      }
      removeAsset(id)
    }
  }

  const handleDeleteFolder = useCallback(async (folderId, folderName) => {
    const folder = (folders || []).find((entry) => entry.id === folderId) || null
    const parentFolderId = folder?.parentId || null
    const descendantIds = folderDescendantIdsByFolderId.get(folderId) || new Set([folderId])
    const folderIds = new Set(descendantIds)
    const assetIdsInFolderTree = assets
      .filter((asset) => folderIds.has(asset.folderId || null))
      .map((asset) => asset.id)
    const timelineIdsInFolderTree = projectTimelines
      .filter((timeline) => folderIds.has(timeline?.folderId || null))
      .map((timeline) => timeline.id)
    const assetCount = assetIdsInFolderTree.length
    const confirmed = await requestConfirm({
      title: 'Delete folder?',
      message: shouldDeleteFromDisk
        ? `Delete folder "${folderName}" and all its contents?\n\n${assetCount} asset${assetCount === 1 ? '' : 's'} will be removed from the project and deleted from local disk (when available). This cannot be undone.`
        : `Delete folder "${folderName}" and all its contents from the project?\n\n${assetCount} asset${assetCount === 1 ? '' : 's'} will be removed from the project. Source files on disk will be kept.`,
      confirmLabel: 'Delete folder',
      cancelLabel: 'Keep',
      tone: 'danger',
    })
    if (!confirmed) return false
    if (shouldDeleteFromDisk) {
      await deleteAssetFilesOnly(assetIdsInFolderTree)
    }
    timelineIdsInFolderTree.forEach((timelineId) => {
      moveTimelineToFolder(timelineId, parentFolderId)
    })
    removeFolder(folderId)
    return true
  }, [assets, deleteAssetFilesOnly, folderDescendantIdsByFolderId, folders, moveTimelineToFolder, projectTimelines, removeFolder, requestConfirm, shouldDeleteFromDisk])

  // Toggle audio on a video asset
  const handleToggleVideoAudio = (assetId) => {
    const asset = assets.find(a => a.id === assetId)
    if (!asset || asset.type !== 'video') return
    if (asset.hasAudio === false) {
      setContextMenu(null)
      return
    }
    const nextEnabled = asset.audioEnabled === false
    setAssetAudioEnabled(assetId, nextEnabled)
    if (!nextEnabled) {
      removeAudioClipsForAsset(assetId)
    }
    setContextMenu(null)
  }

  const handleUnstitchSequence = async (assetId) => {
    const asset = assets.find(a => a.id === assetId)
    setContextMenu(null)
    if (!asset?.sequenceSource) return
    try {
      const result = await unstitchSequenceAsset(asset)
      if (!result?.success) {
        console.warn('[AssetsPanel] unstitch failed:', result?.error)
      }
    } catch (err) {
      console.error('[AssetsPanel] unstitch threw:', err)
    }
  }
  
  // Create new folder
  const handleCreateFolder = () => {
    if (newFolderName.trim()) {
      addFolder({
        name: newFolderName.trim(),
        parentId: currentFolderId
      })
      setNewFolderName('')
      setShowNewFolderInput(false)
    }
  }
  
  // Handle context menu (on asset)
  const handleContextMenu = (e, assetId) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, assetId, folderId: null })
  }

  // Handle context menu (on folder)
  const handleFolderContextMenu = (e, folderId) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, assetId: null, folderId })
  }

  const handleSequenceContextMenu = (e, timeline) => {
    e.preventDefault()
    e.stopPropagation()
    if (!timeline?.id) return
    setSelectedSequenceId(timeline.id)
    setSelectedAssetIds([])
    setContextMenu({ x: e.clientX, y: e.clientY, assetId: null, folderId: null, sequenceId: timeline.id })
  }

  // Handle context menu on empty area (right-click on background / empty spot)
  const handleEmptyAreaContextMenu = (e) => {
    if (e.target.closest('[data-is-asset], [data-is-folder], [data-is-sequence]')) return
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, assetId: null, folderId: null })
  }

  // Empty-area menu actions
  const handleEmptyMenuNewFolder = () => {
    setContextMenu(null)
    setShowNewFolderInput(true)
  }
  const handleEmptyMenuImport = () => {
    setContextMenu(null)
    openFilePicker()
  }
  const handleEmptyMenuNewTimeline = () => {
    setContextMenu(null)
    setShowNewTimelineDialog(true)
  }

  const handleTimelineCreatedFromAssets = useCallback((timeline) => {
    if (!timeline?.id) return
    setCurrentFolderId(null)
    setSelectedAssetIds([])
    setSelectedSequenceId(timeline.id)
    setPreviewMode('timeline')
  }, [setPreviewMode])

  const handleOpenSequenceFromContextMenu = async (timeline) => {
    setContextMenu(null)
    await handleSequenceDoubleClick(timeline)
  }

  const handleDuplicateSequence = async (timeline) => {
    if (!timeline?.id) return
    setContextMenu(null)
    const newTimeline = duplicateTimeline(timeline.id)
    if (!newTimeline?.id) return
    setCurrentFolderId(null)
    setSelectedAssetIds([])
    setSelectedSequenceId(newTimeline.id)
    setPreviewMode('timeline')
    await switchTimeline(newTimeline.id)
  }

  const handleDeleteSequence = async (timeline) => {
    if (!timeline?.id) return
    const timelineCount = currentProject?.timelines?.length || 0
    if (timelineCount <= 1) {
      setContextMenu(null)
      return
    }
    const confirmed = await requestConfirm({
      title: 'Delete timeline?',
      message: `Delete timeline "${timeline.name || 'Untitled Sequence'}"?`,
      confirmLabel: 'Delete timeline',
      cancelLabel: 'Keep',
      tone: 'danger',
    })
    if (!confirmed) return

    setContextMenu(null)
    const deletingCurrent = timeline.id === currentTimelineId
    const deleted = deleteTimeline(timeline.id)
    if (!deleted) return
    setSelectedAssetIds([])
    setSelectedSequenceId(deletingCurrent ? (useProjectStore.getState().currentTimelineId || null) : null)
    if (!deletingCurrent) {
      setPreviewMode('timeline')
    }
  }
  
  // Close context menu when clicking outside
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = () => setContextMenu(null)
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [contextMenu])

  useEffect(() => {
    if (!isAssetDragActive) return undefined

    const handleWindowDragOver = (e) => {
      updateAssetDragPreviewPosition(e.clientX, e.clientY)
    }
    const handleWindowDrop = () => clearAssetDragPreview()
    const handleWindowDragEnd = () => clearAssetDragPreview()

    window.addEventListener('dragover', handleWindowDragOver, true)
    window.addEventListener('drop', handleWindowDrop, true)
    window.addEventListener('dragend', handleWindowDragEnd, true)

    return () => {
      window.removeEventListener('dragover', handleWindowDragOver, true)
      window.removeEventListener('drop', handleWindowDrop, true)
      window.removeEventListener('dragend', handleWindowDragEnd, true)
    }
  }, [isAssetDragActive, updateAssetDragPreviewPosition, clearAssetDragPreview])
  
  // Move asset(s) to folder
  const handleMoveToFolder = (assetIdOrIds, folderId) => {
    const ids = Array.isArray(assetIdOrIds) ? assetIdOrIds : [assetIdOrIds]
    if (ids.length > 1) moveAssetsToFolder(ids, folderId)
    else moveAssetToFolder(ids[0], folderId)
    setContextMenu(null)
    setSelectedAssetIds([])
  }

  // Drop target handlers for dragging assets onto folders
  const handleFolderDragOver = (e, folderId) => {
    const types = e.dataTransfer?.types || []
    const hasAssetDrag = types.includes(ASSET_DRAG_TYPE)
    const hasSequenceDrag = types.includes(SEQUENCE_DRAG_TYPE)
    if (!hasAssetDrag && !hasSequenceDrag) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(false)
    if (hasAssetDrag) {
      updateAssetDragPreviewPosition(e.clientX, e.clientY)
    }
    setDragOverFolderId(folderId)
  }
  const handleFolderDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOverFolderId(null)
  }
  const handleFolderDrop = (e, folderId) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverFolderId(null)
    const targetFolderId = folderId === 'root' ? null : folderId

    const sequenceRaw = e.dataTransfer.getData(SEQUENCE_DRAG_TYPE)
    if (sequenceRaw) {
      try {
        const sequenceIds = JSON.parse(sequenceRaw)
        if (Array.isArray(sequenceIds) && sequenceIds.length > 0) {
          sequenceIds.forEach((sequenceId) => moveTimelineToFolder(sequenceId, targetFolderId))
          setSelectedSequenceId(sequenceIds[0] || null)
          return
        }
      } catch (_) { /* ignore parse errors */ }
    }

    // Some browsers don't expose custom MIME type on drop; fallback to text/plain
    const raw = e.dataTransfer.getData(ASSET_DRAG_TYPE) || e.dataTransfer.getData('text/plain')
    if (!raw) return
    try {
      const assetIds = JSON.parse(raw)
      if (Array.isArray(assetIds) && assetIds.length > 0) {
        moveAssetsToFolder(assetIds, targetFolderId)
        setSelectedAssetIds([])
      }
    } catch (_) {}
  }
  
  // Focus new folder input when shown
  useEffect(() => {
    if (showNewFolderInput && newFolderInputRef.current) {
      newFolderInputRef.current.focus()
    }
  }, [showNewFolderInput])

  useEffect(() => {
    setSelectedSequenceId(currentTimelineId || null)
  }, [currentTimelineId])
  
  // Get thumbnail size config
  const sizeConfig = THUMBNAIL_SIZES[thumbnailSize]
  const folderTileIconSize = FOLDER_TILE_ICON_SIZES[thumbnailSize] || FOLDER_TILE_ICON_SIZES.medium
  const listDetailsGridColumns = 'grid-cols-[minmax(0,1fr)_64px_44px_86px_28px]'
  const dragPreviewAsset = assetDragPreview
    ? assets.find((asset) => asset.id === assetDragPreview.assetId) || null
    : null
  const DragPreviewIcon = dragPreviewAsset ? getIcon(dragPreviewAsset.type) : null
  const hasVisibleSequences = filteredTimelines.length > 0
  const isPanelEmpty = filteredAssets.length === 0 && subFolders.length === 0 && !hasVisibleSequences
  const rootBrowserItems = [
    ...filteredTimelines.map((timeline) => ({ kind: 'sequence', item: timeline })),
    ...filteredAssets.map((asset) => ({ kind: 'asset', item: asset })),
  ]
  const sortedRootBrowserItems = sortBrowserItems(rootBrowserItems)

  const renderSequenceGridItem = (timeline) => {
    const isCurrent = timeline.id === currentTimelineId
    const isSelected = timeline.id === selectedSequenceId
    const isEditing = editingType === 'sequence' && editingId === timeline.id
    const clipCount = Array.isArray(timeline.clips) ? timeline.clips.length : 0
    const trackCount = Array.isArray(timeline.tracks) ? timeline.tracks.length : 0
    const timelineColor = timeline.color ?? null

    return (
      <div
        key={timeline.id}
        data-is-sequence
        draggable
        onDragStart={(e) => startSequenceDrag(e, timeline.id)}
        onClick={() => handleSequenceClick(timeline)}
        onDoubleClick={() => handleSequenceDoubleClick(timeline)}
        onContextMenu={(e) => handleSequenceContextMenu(e, timeline)}
        className={`bg-sf-dark-800 border rounded overflow-hidden text-left transition-all cursor-pointer group ${
          isCurrent
            ? 'border-sf-accent ring-1 ring-sf-accent'
            : isSelected
              ? 'border-sf-dark-500 bg-sf-dark-800'
              : 'border-sf-dark-600 hover:border-sf-dark-500'
        }`}
        style={timelineColor ? { borderLeftWidth: '4px', borderLeftColor: timelineColor } : {}}
      >
        <div className="aspect-video relative overflow-hidden bg-gradient-to-br from-sf-dark-700 via-sf-dark-800 to-sf-dark-900 flex items-center justify-center">
          <div className="absolute inset-x-0 top-3 flex justify-center opacity-20">
            <div className="h-px w-3/4 bg-sf-accent" />
          </div>
          <div className="absolute inset-x-0 bottom-3 flex justify-center opacity-20">
            <div className="h-px w-3/4 bg-sf-accent" />
          </div>
          <div className="rounded-full bg-sf-dark-900/80 p-3 shadow-lg">
            <Film className={`${sizeConfig.iconSize} text-sf-accent`} />
          </div>

          <div className={`absolute top-0.5 left-0.5 px-1 py-0.5 rounded ${sizeConfig.badgeSize} text-white font-medium bg-sf-accent/90`}>
            SEQ
          </div>

          <div className="absolute top-0.5 right-0.5 flex items-center gap-0.5">
            <button
              type="button"
              onClick={(e) => startSequenceEditing(e, timeline)}
              className={`p-0.5 rounded bg-sf-dark-800/90 hover:bg-sf-dark-700 transition-opacity ${
                isSelected || isEditing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
              title="Rename sequence"
            >
              <Edit3 className="w-2.5 h-2.5 text-sf-text-muted" />
            </button>
            {isCurrent && (
              <div className={`px-1 py-0.5 rounded ${sizeConfig.badgeSize} text-black font-medium bg-sf-text-primary/90`}>
                ACTIVE
              </div>
            )}
          </div>

          {openingSequenceId === timeline.id && (
            <div className="absolute bottom-0.5 left-0.5 px-1 py-0.5 rounded bg-sf-dark-800/90">
              <Loader2 className="w-2 h-2 text-sf-blue animate-spin" />
            </div>
          )}

          <div className="pointer-events-none absolute inset-0 bg-black/0 group-hover:bg-black/15 transition-colors" />
        </div>

        <div className="p-1.5">
          {isEditing ? (
            <form onSubmit={saveEdit}>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={saveEdit}
                autoFocus
                className={`w-full bg-sf-dark-700 border border-sf-accent rounded px-1 py-0.5 ${sizeConfig.nameSize} text-sf-text-primary focus:outline-none`}
              />
            </form>
          ) : (
            <p className={`${sizeConfig.nameSize} text-sf-text-primary truncate`} title={timeline.name || 'Untitled Sequence'}>
              {timeline.name || 'Untitled Sequence'}
            </p>
          )}
          <p className={`${sizeConfig.infoSize} text-sf-text-muted mt-0.5`}>
            {clipCount} clip{clipCount === 1 ? '' : 's'} • {trackCount} track{trackCount === 1 ? '' : 's'}
          </p>
          <p className={`${sizeConfig.infoSize} text-sf-text-muted`}>
            {formatSequenceDuration(timeline.duration)} • {formatTime(timeline.modified || timeline.created)}
          </p>
        </div>
      </div>
    )
  }

  const renderSequenceListRow = (timeline) => {
    const isCurrent = timeline.id === currentTimelineId
    const isSelected = timeline.id === selectedSequenceId
    const isEditing = editingType === 'sequence' && editingId === timeline.id
    const timelineColor = timeline.color ?? null

    return (
      <div
        key={timeline.id}
        data-is-sequence
        draggable
        onDragStart={(e) => startSequenceDrag(e, timeline.id)}
        onClick={() => handleSequenceClick(timeline)}
        onDoubleClick={() => handleSequenceDoubleClick(timeline)}
        onContextMenu={(e) => handleSequenceContextMenu(e, timeline)}
        className={`grid ${listDetailsGridColumns} gap-1 items-center px-1.5 py-1 rounded cursor-pointer transition-colors group ${
          isCurrent
            ? 'bg-sf-accent/20 ring-1 ring-sf-accent/40'
            : isSelected
              ? 'bg-sf-dark-800'
              : 'hover:bg-sf-dark-800'
        }`}
        style={timelineColor ? { borderLeft: `3px solid ${timelineColor}` } : {}}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded overflow-hidden bg-sf-dark-700 flex-shrink-0 flex items-center justify-center">
            <Film className="w-3.5 h-3.5 text-sf-accent" />
          </div>
          <div className="min-w-0 flex-1">
            {isEditing ? (
              <form onSubmit={saveEdit} className="min-w-0 flex-1">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={saveEdit}
                  autoFocus
                  className="w-full bg-sf-dark-700 border border-sf-accent rounded px-1 py-0.5 text-[10px] text-sf-text-primary focus:outline-none"
                />
              </form>
            ) : (
              <span className="text-[11px] text-sf-text-primary truncate block">{timeline.name || 'Untitled Sequence'}</span>
            )}
          </div>
        </div>
        <span className="text-[10px] text-sf-text-muted truncate">Sequence</span>
        <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-sf-accent/90 text-white">SEQ</span>
        <span className="text-[10px] text-sf-text-muted truncate" title={timeline.modified || timeline.created}>
          {formatTime(timeline.modified || timeline.created)}
        </span>
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={(e) => startSequenceEditing(e, timeline)}
            className="p-0.5 opacity-0 group-hover:opacity-100 hover:bg-sf-dark-700 rounded transition-opacity"
            title="Rename sequence"
          >
            <Edit3 className="w-2.5 h-2.5 text-sf-text-muted" />
          </button>
          {isCurrent && (
            <span className="rounded bg-sf-accent px-1.5 py-0.5 text-[9px] font-medium text-black">
              Active
            </span>
          )}
          {openingSequenceId === timeline.id && (
            <Loader2 className="w-3 h-3 animate-spin text-sf-text-muted" />
          )}
        </div>
      </div>
    )
  }

  // List view: recursive folder row with expand arrow and inline contents
  const ListFolderRow = ({ folder, depth }) => {
    const isExpanded = expandedFolderIds.has(folder.id)
    const isEditingFolder = editingType === 'folder' && editingId === folder.id
    const childFolders = getSubfoldersOf(folder.id)
    const childAssets = getAssetsInFolder(folder.id, searchQuery)
    const childTimelines = getTimelinesInFolder(folder.id, searchQuery)
    const childEntries = sortBrowserItems([
      ...childTimelines.map((timeline) => ({ kind: 'sequence', item: timeline })),
      ...childAssets.map((asset) => ({ kind: 'asset', item: asset })),
    ])
    return (
      <>
        <div
          data-is-folder
          style={{ paddingLeft: depth * 14, ...(folder.color ? { borderLeft: `3px solid ${folder.color}` } : {}) }}
          onClick={() => handleFolderClick(folder.id)}
          onDragOver={(e) => handleFolderDragOver(e, folder.id)}
          onDragLeave={handleFolderDragLeave}
          onDrop={(e) => handleFolderDrop(e, folder.id)}
          onContextMenu={(e) => handleFolderContextMenu(e, folder.id)}
          className={`flex items-center gap-2 p-1.5 rounded cursor-pointer transition-colors group ${
            dragOverFolderId === folder.id ? 'bg-sf-accent/20 ring-1 ring-sf-accent' : 'hover:bg-sf-dark-800'
          }`}
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleFolderExpanded(folder.id) }}
            className="p-0.5 -m-0.5 flex-shrink-0 rounded hover:bg-sf-dark-700 text-sf-text-muted"
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
          <FolderOpen className="w-3.5 h-3.5 text-sf-accent flex-shrink-0" />
          <div className="flex-1 min-w-0">
            {isEditingFolder ? (
              <form onSubmit={saveEdit} className="min-w-0" onClick={(e) => e.stopPropagation()}>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={saveEdit}
                  autoFocus
                  className="w-full bg-sf-dark-700 border border-sf-accent rounded px-1 py-0.5 text-[10px] text-sf-text-primary focus:outline-none"
                />
              </form>
            ) : (
              <p className="text-[11px] text-sf-text-primary truncate">{folder.name}</p>
            )}
            <p className="text-[9px] text-sf-text-muted">{getFolderItemCount(folder.id)} items</p>
          </div>
          <button
            onClick={(e) => startFolderEditing(e, folder)}
            className="p-0.5 opacity-0 group-hover:opacity-100 hover:bg-sf-dark-700 rounded transition-opacity"
            title="Rename folder"
          >
            <Edit3 className="w-2.5 h-2.5 text-sf-text-muted" />
          </button>
          <button
            onClick={async (e) => {
              e.stopPropagation()
              await handleDeleteFolder(folder.id, folder.name)
            }}
            className="p-0.5 opacity-0 group-hover:opacity-100 hover:bg-sf-error rounded transition-opacity"
          >
            <Trash2 className="w-2.5 h-2.5 text-sf-text-muted" />
          </button>
        </div>
        {isExpanded && (
          <div className="space-y-0.5">
            {childFolders.map(f => <ListFolderRow key={f.id} folder={f} depth={depth + 1} />)}
            {childEntries.map((entry) => {
              if (entry.kind === 'sequence') {
                const timeline = entry.item
                return (
                  <div key={timeline.id} style={{ paddingLeft: (depth + 1) * 14 }}>
                    {renderSequenceListRow(timeline)}
                  </div>
                )
              }

              const asset = entry.item
              const Icon = getIcon(asset.type)
              const isSelected = selectedAssetIds.includes(asset.id) || currentPreview?.id === asset.id
              const isEditingAsset = editingType === 'asset' && editingId === asset.id
              const idsToMove = selectedAssetIds.includes(asset.id) ? selectedAssetIds : [asset.id]
              return (
                <div
                  key={asset.id}
                  data-is-asset
                  draggable
                  style={{
                    paddingLeft: (depth + 1) * 14,
                    ...(asset.color ? { borderLeft: `3px solid ${asset.color}` } : {}),
                  }}
                  onDragStart={(e) => startAssetDrag(e, asset.id, idsToMove)}
                  onDragEnd={endAssetDrag}
                  onClick={(e) => handleClick(e, asset)}
                  onDoubleClick={() => handleDoubleClick(asset)}
                  onContextMenu={(e) => handleContextMenu(e, asset.id)}
                  className={`grid ${listDetailsGridColumns} gap-1 items-center px-1.5 py-1 rounded cursor-pointer transition-colors group ${isSelected ? 'bg-sf-accent/20' : 'hover:bg-sf-dark-800'}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-6 h-6 rounded overflow-hidden bg-sf-dark-700 flex-shrink-0 flex items-center justify-center">
                      <LazyAssetThumbnail
                        asset={asset}
                        Icon={Icon}
                        isActive={isActive}
                        iconClassName="w-3.5 h-3.5 text-sf-text-muted"
                        imageAlt=""
                      />
                    </div>
                    {isEditingAsset ? (
                      <form onSubmit={saveEdit} className="min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
                        <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} onBlur={saveEdit} autoFocus className="w-full bg-sf-dark-700 border border-sf-accent rounded px-1 py-0.5 text-[10px] text-sf-text-primary focus:outline-none" />
                      </form>
                    ) : (
                      <span className="text-[11px] text-sf-text-primary truncate block">{asset.name}</span>
                    )}
                  </div>
                  <span className="text-[10px] text-sf-text-muted truncate">{getAssetTypeLabel(asset)}</span>
                  <span className={`text-[9px] font-medium px-1 py-0.5 rounded ${asset.isImported ? 'bg-sf-dark-700 text-sf-text-secondary' : 'bg-sf-accent/90 text-white'}`}>{getAssetSource(asset)}</span>
                  <span className="text-[10px] text-sf-text-muted truncate">{formatTime(asset.createdAt)}</span>
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={(e) => startEditing(e, asset)} className="p-0.5 hover:bg-sf-dark-700 rounded" title="Rename"><Edit3 className="w-2.5 h-2.5 text-sf-text-muted" /></button>
                    <button onClick={(e) => handleDelete(e, asset.id)} className="p-0.5 hover:bg-sf-error rounded" title="Delete"><Trash2 className="w-2.5 h-2.5 text-sf-text-muted" /></button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </>
    )
  }

  return (
    <div 
      ref={panelRef}
      tabIndex={-1}
      className={`h-full flex flex-col outline-none ${isDragOver ? 'ring-2 ring-sf-accent ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ALL_SUPPORTED.join(',')}
        onChange={handleFileInputChange}
        className="hidden"
      />
      
      {/* Header */}
      <div className="p-2 border-b border-sf-dark-700 space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sf-text-muted" />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded pl-7 pr-2 py-1 text-xs text-sf-text-primary placeholder-sf-text-muted focus:outline-none focus:border-sf-accent"
            />
          </div>
          
          <div className="flex items-center gap-0.5 bg-sf-dark-800 rounded p-0.5">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1 rounded ${viewMode === 'grid' ? 'bg-sf-dark-600' : ''}`}
              title="Grid view"
            >
              <Grid className="w-3.5 h-3.5 text-sf-text-secondary" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-1 rounded ${viewMode === 'list' ? 'bg-sf-dark-600' : ''}`}
              title="List view"
            >
              <List className="w-3.5 h-3.5 text-sf-text-secondary" />
            </button>
          </div>
          
          <button 
            onClick={openFilePicker}
            disabled={!currentProjectHandle || isImporting}
            className="p-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 disabled:opacity-50 rounded transition-colors" 
            title="Import Media"
          >
            {isImporting ? (
              <Loader2 className="w-3.5 h-3.5 text-sf-text-secondary animate-spin" />
            ) : (
              <Upload className="w-3.5 h-3.5 text-sf-text-secondary" />
            )}
          </button>
        </div>
        
        {/* Thumbnail size control (only in grid mode) */}
        {viewMode === 'grid' && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-sf-text-muted">Size:</span>
            <div className="flex items-center gap-1 flex-1">
              <Minus className="w-3 h-3 text-sf-text-muted" />
              <input
                type="range"
                min="0"
                max={THUMBNAIL_SIZE_ORDER.length - 1}
                value={THUMBNAIL_SIZE_ORDER.indexOf(thumbnailSize)}
                onChange={(e) => {
                  const index = Math.max(0, Math.min(parseInt(e.target.value, 10) || 0, THUMBNAIL_SIZE_ORDER.length - 1))
                  setAndSaveThumbnailSize(THUMBNAIL_SIZE_ORDER[index])
                }}
                className="flex-1 h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
              <Plus className="w-3 h-3 text-sf-text-muted" />
            </div>
            <button
              onClick={() => setShowNewFolderInput(true)}
              className="p-1 hover:bg-sf-dark-700 rounded transition-colors"
              title="New Folder"
            >
              <FolderPlus className="w-3.5 h-3.5 text-sf-text-secondary" />
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-sf-text-muted">Delete:</span>
          <div className="flex items-center gap-0.5 bg-sf-dark-800 rounded p-0.5">
            <button
              type="button"
              onClick={() => setAndSaveAssetDeleteMode(ASSET_DELETE_MODE_DISK)}
              className={`px-2 py-1 rounded text-[10px] transition-colors ${
                shouldDeleteFromDisk ? 'bg-sf-dark-600 text-sf-text-primary' : 'text-sf-text-muted hover:text-sf-text-primary'
              }`}
              title="Delete from project and local disk"
            >
              Delete Disk
            </button>
            <button
              type="button"
              onClick={() => setAndSaveAssetDeleteMode(ASSET_DELETE_MODE_PROJECT_ONLY)}
              className={`px-2 py-1 rounded text-[10px] transition-colors ${
                !shouldDeleteFromDisk ? 'bg-sf-dark-600 text-sf-text-primary' : 'text-sf-text-muted hover:text-sf-text-primary'
              }`}
              title="Remove from project only (keep local files)"
            >
              Project Only
            </button>
          </div>
        </div>
        
        {/* Folder breadcrumb navigation */}
        {(currentFolderId || subFolders.length > 0 || folders?.length > 0) && (
          <div className="flex items-center gap-1 text-[10px] overflow-x-auto">
            <button
              onClick={() => setCurrentFolderId(null)}
              onDragOver={(e) => handleFolderDragOver(e, 'root')}
              onDragLeave={handleFolderDragLeave}
              onDrop={(e) => handleFolderDrop(e, null)}
              className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded transition-colors ${
                !currentFolderId ? 'text-sf-accent' : 'text-sf-text-muted'
              } ${dragOverFolderId === 'root' ? 'ring-1 ring-sf-accent bg-sf-accent/20' : 'hover:bg-sf-dark-700'}`}
            >
              <Home className="w-3 h-3" />
              <span>Root</span>
            </button>
            {getFolderPath().map((folder, idx) => (
              <div key={folder.id} className="flex items-center">
                <ChevronRight className="w-3 h-3 text-sf-text-muted" />
                <button
                  onClick={() => setCurrentFolderId(folder.id)}
                  onDragOver={(e) => handleFolderDragOver(e, folder.id)}
                  onDragLeave={handleFolderDragLeave}
                  onDrop={(e) => handleFolderDrop(e, folder.id)}
                  className={`px-1.5 py-0.5 rounded transition-colors ${
                    folder.id === currentFolderId ? 'text-sf-accent' : 'text-sf-text-muted'
                  } ${dragOverFolderId === folder.id ? 'ring-1 ring-sf-accent bg-sf-accent/20' : 'hover:bg-sf-dark-700'}`}
                >
                  {folder.name}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      
      {/* New folder input */}
      {showNewFolderInput && (
        <div className="px-2 py-1.5 border-b border-sf-dark-700 flex items-center gap-2">
          <FolderPlus className="w-3.5 h-3.5 text-sf-accent" />
          <input
            ref={newFolderInputRef}
            type="text"
            placeholder="Folder name..."
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                handleCreateFolder()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setShowNewFolderInput(false)
              }
            }}
            onBlur={() => {
              if (!newFolderName.trim()) setShowNewFolderInput(false)
            }}
            className="flex-1 bg-sf-dark-800 border border-sf-accent rounded px-2 py-0.5 text-xs text-sf-text-primary placeholder-sf-text-muted focus:outline-none"
          />
          <button
            onClick={handleCreateFolder}
            disabled={!newFolderName.trim()}
            className="px-2 py-0.5 bg-sf-accent text-white text-[10px] rounded disabled:opacity-50"
          >
            Create
          </button>
        </div>
      )}
      
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-sf-accent/20 border-2 border-dashed border-sf-accent rounded-lg flex items-center justify-center z-10 pointer-events-none">
          <div className="text-center">
            <Upload className="w-8 h-8 text-sf-accent mx-auto mb-2" />
            <p className="text-sm text-sf-text-primary font-medium">Drop to import</p>
            <p className="text-xs text-sf-text-muted">Video, audio, or image files</p>
          </div>
        </div>
      )}
      
      {/* Assets Grid/List */}
      <div 
        className="flex-1 p-2 overflow-auto relative"
        onContextMenu={handleEmptyAreaContextMenu}
        onDoubleClick={(e) => {
          // Double-click on empty area triggers import
          if (e.target === e.currentTarget || e.target.closest('.empty-state-container')) {
            openFilePicker()
          }
        }}
      >
        {isPanelEmpty ? (
          <div className="empty-state-container h-full flex flex-col items-center justify-center text-sf-text-muted">
            <Video className="w-10 h-10 mb-2 opacity-50" />
            <p className="text-xs">{searchQuery.trim() ? 'No matching assets or sequences' : 'No assets yet'}</p>
            <p className="text-[10px] mt-1">
              {searchQuery.trim() ? 'Try a different search or clear the filter.' : 'Generate AI videos or import your footage'}
            </p>
            <div className="flex gap-2 mt-3">
              <button
                onClick={openFilePicker}
                disabled={!currentProjectHandle}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 disabled:opacity-50 rounded text-xs text-sf-text-secondary transition-colors"
              >
                <Upload className="w-3 h-3" />
                Import Media
              </button>
              <button
                onClick={() => setShowNewFolderInput(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors"
              >
                <FolderPlus className="w-3 h-3" />
                New Folder
              </button>
            </div>
          </div>
        ) : viewMode === 'grid' ? (
          <div 
            className={`grid gap-2`} 
            style={{ gridTemplateColumns: `repeat(${sizeConfig.cols}, minmax(0, 1fr))` }}
            onDoubleClick={(e) => {
              // Double-click on empty grid area triggers import
              if (e.target === e.currentTarget) {
                openFilePicker()
              }
            }}
          >
            {/* Back button if in a folder */}
            {currentFolderId && (
              <button
                onClick={() => {
                  setSelectedSequenceId(null)
                  setCurrentFolderId(currentFolder?.parentId || null)
                }}
                className="aspect-video bg-sf-dark-800 border border-sf-dark-600 rounded flex flex-col items-center justify-center hover:border-sf-dark-500 transition-colors"
              >
                <ChevronLeft className={`${sizeConfig.iconSize} text-sf-text-muted mb-1`} />
                <span className={`${sizeConfig.nameSize} text-sf-text-muted`}>Back</span>
              </button>
            )}
            
            {/* Subfolders */}
            {subFolders.map((folder) => {
              const isEditingFolder = editingType === 'folder' && editingId === folder.id
              return (
                <div
                  key={folder.id}
                  data-is-folder
                  onClick={() => handleFolderClick(folder.id)}
                  onDragOver={(e) => handleFolderDragOver(e, folder.id)}
                  onDragLeave={handleFolderDragLeave}
                  onDrop={(e) => handleFolderDrop(e, folder.id)}
                  onContextMenu={(e) => handleFolderContextMenu(e, folder.id)}
                  className={`bg-sf-dark-800 border rounded cursor-pointer transition-colors group overflow-hidden ${
                    dragOverFolderId === folder.id ? 'border-sf-accent ring-2 ring-sf-accent ring-offset-1 ring-offset-sf-dark-900' : 'border-sf-dark-600 hover:border-sf-dark-500'
                  }`}
                  style={folder.color ? { borderLeftWidth: '4px', borderLeftColor: folder.color } : {}}
                >
                  <div className="aspect-video bg-gradient-to-b from-sf-dark-700/25 to-sf-dark-900/75 flex items-center justify-center relative">
                    <FolderOpen className={`${folderTileIconSize} text-sf-accent/80`} strokeWidth={1.6} />
                    <button
                      type="button"
                      onClick={(e) => startFolderEditing(e, folder)}
                      className="absolute top-1 right-1 p-0.5 rounded bg-sf-dark-900/70 opacity-0 group-hover:opacity-100 hover:bg-sf-dark-700 transition-opacity"
                      title="Rename folder"
                    >
                      <Edit3 className="w-2.5 h-2.5 text-sf-text-muted" />
                    </button>
                  </div>
                  <div className="px-1.5 py-1 border-t border-sf-dark-700/80 bg-sf-dark-900/85 text-center leading-tight">
                    {isEditingFolder ? (
                      <form onSubmit={saveEdit} className="mb-0.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={saveEdit}
                          autoFocus
                          className="w-full bg-sf-dark-700 border border-sf-accent rounded px-1 py-0.5 text-[10px] text-sf-text-primary text-center focus:outline-none"
                        />
                      </form>
                    ) : (
                      <span className={`${sizeConfig.nameSize} block text-sf-text-primary truncate`}>
                        {folder.name}
                      </span>
                    )}
                    <span className={`${sizeConfig.infoSize} text-sf-text-muted`}>
                      {getFolderItemCount(folder.id)} items
                    </span>
                  </div>
                </div>
              )
            })}
            
            {/* Items in the current folder: sequences mixed with assets */}
            {rootBrowserItems.map((entry) => {
              if (entry.kind === 'sequence') {
                return renderSequenceGridItem(entry.item)
              }

              const asset = entry.item
              const Icon = getIcon(asset.type)
              const isSelected = selectedAssetIds.includes(asset.id) || currentPreview?.id === asset.id
              const isEditingAsset = editingType === 'asset' && editingId === asset.id
              const idsToMove = selectedAssetIds.includes(asset.id) ? selectedAssetIds : [asset.id]

              return (
                <div
                  key={asset.id}
                  data-is-asset
                  draggable
                  onDragStart={(e) => startAssetDrag(e, asset.id, idsToMove)}
                  onDragEnd={endAssetDrag}
                  onClick={(e) => handleClick(e, asset)}
                  onDoubleClick={() => handleDoubleClick(asset)}
                  onContextMenu={(e) => handleContextMenu(e, asset.id)}
                  className={`bg-sf-dark-800 border rounded overflow-hidden cursor-grab transition-all group ${
                    isSelected 
                      ? 'border-sf-accent ring-1 ring-sf-accent' 
                      : 'border-sf-dark-600 hover:border-sf-dark-500'
                  }`}
                  style={asset.color ? { borderLeftWidth: '4px', borderLeftColor: asset.color } : {}}
                >
                  {/* Thumbnail */}
                  <div className="aspect-video bg-sf-dark-700 flex items-center justify-center relative overflow-hidden">
                    <LazyAssetThumbnail
                      asset={asset}
                      Icon={Icon}
                      isActive={isActive}
                      iconClassName={`${sizeConfig.iconSize} text-sf-text-muted`}
                      imageAlt={asset.name}
                      videoProps={{
                        onMouseEnter: (e) => e.target.play(),
                        onMouseLeave: (e) => {
                          e.target.pause()
                          e.target.currentTime = 0
                        },
                      }}
                    />
                    
                    {/* Badge - AI, Imported, or Mask */}
                    <div className={`absolute top-0.5 left-0.5 px-1 py-0.5 rounded ${sizeConfig.badgeSize} text-white font-medium ${
                      asset.type === 'mask' ? 'bg-purple-600/90' : asset.isImported ? 'bg-sf-dark-700/90' : 'bg-sf-accent/90'
                    }`}>
                      {asset.type === 'mask' ? 'MASK' : asset.isImported ? 'IMP' : 'AI'}
                    </div>

                    {/* Stitched-sequence badge - only for ComfyUI auto-imported frame sequences */}
                    {asset.sequenceSource?.kind === 'comfy-stitched' && (
                      <div
                        className={`absolute top-0.5 right-0.5 px-1 py-0.5 rounded ${sizeConfig.badgeSize} text-white font-medium bg-sf-accent/80`}
                        title={`Stitched from ${asset.sequenceSource.frameCount} frames at ${asset.sequenceSource.fps} fps (right-click to unstitch)`}
                      >
                        SEQ · {asset.sequenceSource.frameCount}
                      </div>
                    )}

                    {/* Sprite badge - shows if thumbnails are ready */}
                    {asset.type === 'video' && asset.sprite?.url && (
                      <div className={`absolute bottom-0.5 left-0.5 px-1 py-0.5 rounded ${sizeConfig.badgeSize} text-white font-medium bg-sf-blue/90`} title="Thumbnails ready for fast scrubbing">
                        <Film className="w-2 h-2 inline-block" />
                      </div>
                    )}
                    
                    {/* Generating indicator */}
                    {asset.spriteGenerating && (
                      <div className="absolute bottom-0.5 left-0.5 px-1 py-0.5 rounded bg-sf-dark-800/90">
                        <Loader2 className={`w-2 h-2 text-sf-blue animate-spin`} />
                      </div>
                    )}
                    
                    {/* Play overlay on hover */}
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Play className={`${sizeConfig.playSize} text-white`} />
                    </div>

                    {/* Actions */}
                    <div className="absolute top-0.5 right-0.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => startEditing(e, asset)}
                        className="p-0.5 bg-sf-dark-800/90 hover:bg-sf-dark-700 rounded"
                        title="Rename"
                      >
                        <Edit3 className="w-2.5 h-2.5 text-sf-text-muted" />
                      </button>
                      <button
                        onClick={(e) => handleDelete(e, asset.id)}
                        className="p-0.5 bg-sf-dark-800/90 hover:bg-sf-error rounded"
                        title="Delete"
                      >
                        <Trash2 className="w-2.5 h-2.5 text-sf-text-muted" />
                      </button>
                    </div>
                  </div>
                  
                  {/* Info */}
                  <div className="p-1.5">
                    {isEditingAsset ? (
                      <form onSubmit={saveEdit} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={saveEdit}
                          autoFocus
                          className={`w-full bg-sf-dark-700 border border-sf-accent rounded px-1 py-0.5 ${sizeConfig.nameSize} text-sf-text-primary focus:outline-none`}
                        />
                      </form>
                    ) : (
                      <p className={`${sizeConfig.nameSize} text-sf-text-primary truncate`} title={asset.name}>
                        {asset.name}
                      </p>
                    )}
                    <p className={`${sizeConfig.infoSize} text-sf-text-muted mt-0.5`}>
                      {formatTime(asset.createdAt)} • {asset.settings?.duration ? `${asset.settings.duration}s` : asset.type}
                    </p>
                  </div>
                </div>
              )
            })}
            
            {/* Upload placeholder */}
            <button
              onClick={openFilePicker}
              disabled={!currentProjectHandle || isImporting}
              className="aspect-video border-2 border-dashed border-sf-dark-600 rounded flex items-center justify-center hover:border-sf-accent disabled:opacity-50 cursor-pointer transition-colors"
            >
              <div className="text-center">
                {isImporting ? (
                  <Loader2 className={`${sizeConfig.iconSize} text-sf-text-muted mx-auto mb-1 animate-spin`} />
                ) : (
                  <Upload className={`${sizeConfig.iconSize} text-sf-text-muted mx-auto mb-1`} />
                )}
                <span className={`${sizeConfig.nameSize} text-sf-text-muted`}>Import</span>
              </div>
            </button>
          </div>
        ) : (
          /* List View (details style with sortable columns) */
          <div 
            className="flex flex-col min-h-0"
            onDoubleClick={(e) => {
              if (e.target === e.currentTarget) openFilePicker()
            }}
          >
            {/* Back button if in a folder */}
            {currentFolderId && (
              <button
                onClick={() => {
                  setSelectedSequenceId(null)
                  setCurrentFolderId(currentFolder?.parentId || null)
                }}
                className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-sf-dark-800 transition-colors flex-shrink-0"
              >
                <ChevronLeft className="w-3.5 h-3.5 text-sf-text-muted" />
                <span className="text-[11px] text-sf-text-muted">Back</span>
              </button>
            )}

            {/* Column headers - sortable */}
            <div className={`grid ${listDetailsGridColumns} gap-1 px-1.5 py-1 border-b border-sf-dark-700 flex-shrink-0 text-[10px] text-sf-text-muted font-medium`}>
              <button type="button" onClick={() => setListSort('name')} className="text-left hover:text-sf-text-primary flex items-center gap-0.5 truncate">
                Name {listSortBy.by === 'name' ? (listSortBy.dir === 'asc' ? <ArrowUp className="w-3 h-3 flex-shrink-0" /> : <ArrowDown className="w-3 h-3 flex-shrink-0" />) : <ArrowUpDown className="w-3 h-3 flex-shrink-0 opacity-50" />}
              </button>
              <button type="button" onClick={() => setListSort('type')} className="text-left hover:text-sf-text-primary flex items-center gap-0.5">
                Type {listSortBy.by === 'type' ? (listSortBy.dir === 'asc' ? <ArrowUp className="w-3 h-3 flex-shrink-0" /> : <ArrowDown className="w-3 h-3 flex-shrink-0" />) : <ArrowUpDown className="w-3 h-3 flex-shrink-0 opacity-50" />}
              </button>
              <button type="button" onClick={() => setListSort('source')} className="text-left hover:text-sf-text-primary flex items-center gap-0.5">
                Source {listSortBy.by === 'source' ? (listSortBy.dir === 'asc' ? <ArrowUp className="w-3 h-3 flex-shrink-0" /> : <ArrowDown className="w-3 h-3 flex-shrink-0" />) : <ArrowUpDown className="w-3 h-3 flex-shrink-0 opacity-50" />}
              </button>
              <button type="button" onClick={() => setListSort('date')} className="text-left hover:text-sf-text-primary flex items-center gap-0.5">
                Date {listSortBy.by === 'date' ? (listSortBy.dir === 'asc' ? <ArrowUp className="w-3 h-3 flex-shrink-0" /> : <ArrowDown className="w-3 h-3 flex-shrink-0" />) : <ArrowUpDown className="w-3 h-3 flex-shrink-0 opacity-50" />}
              </button>
              <span className="w-7" aria-hidden />
            </div>
            
            <div className="flex-1 min-h-0 overflow-auto space-y-0.5">
            {/* Subfolders (with expand arrow to show contents inline) */}
            {subFolders.map((folder) => (
              <ListFolderRow key={folder.id} folder={folder} depth={0} />
            ))}
            
            {/* Items in the current folder: sequences mixed with assets */}
            {sortedRootBrowserItems.map((entry) => {
              if (entry.kind === 'sequence') {
                return renderSequenceListRow(entry.item)
              }

              const asset = entry.item
              const Icon = getIcon(asset.type)
              const isSelected = selectedAssetIds.includes(asset.id) || currentPreview?.id === asset.id
              const isEditingAsset = editingType === 'asset' && editingId === asset.id
              const idsToMove = selectedAssetIds.includes(asset.id) ? selectedAssetIds : [asset.id]

              return (
                <div 
                  key={asset.id}
                  data-is-asset
                  draggable
                  onDragStart={(e) => startAssetDrag(e, asset.id, idsToMove)}
                  onDragEnd={endAssetDrag}
                  onClick={(e) => handleClick(e, asset)}
                  onDoubleClick={() => handleDoubleClick(asset)}
                  onContextMenu={(e) => handleContextMenu(e, asset.id)}
                  className={`grid ${listDetailsGridColumns} gap-1 items-center px-1.5 py-1 rounded cursor-pointer transition-colors group ${
                    isSelected ? 'bg-sf-accent/20' : 'hover:bg-sf-dark-800'
                  }`}
                  style={asset.color ? { borderLeft: `3px solid ${asset.color}` } : {}}
                >
                  {/* Name + thumbnail */}
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded overflow-hidden bg-sf-dark-700 flex-shrink-0 flex items-center justify-center">
                      <LazyAssetThumbnail
                        asset={asset}
                        Icon={Icon}
                        isActive={isActive}
                        iconClassName="w-3.5 h-3.5 text-sf-text-muted"
                        imageAlt=""
                      />
                    </div>
                    {isEditingAsset ? (
                      <form onSubmit={saveEdit} className="min-w-0 flex-1" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={saveEdit}
                          autoFocus
                          className="w-full bg-sf-dark-700 border border-sf-accent rounded px-1 py-0.5 text-[10px] text-sf-text-primary focus:outline-none"
                        />
                      </form>
                    ) : (
                      <span className="text-[11px] text-sf-text-primary truncate block">{asset.name}</span>
                    )}
                  </div>
                  <span className="text-[10px] text-sf-text-muted truncate">{getAssetTypeLabel(asset)}</span>
                  <span className={`text-[9px] font-medium px-1 py-0.5 rounded ${asset.isImported ? 'bg-sf-dark-700 text-sf-text-secondary' : 'bg-sf-accent/90 text-white'}`}>{getAssetSource(asset)}</span>
                  <span className="text-[10px] text-sf-text-muted truncate" title={asset.createdAt}>{formatTime(asset.createdAt)}</span>
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={(e) => startEditing(e, asset)} className="p-0.5 hover:bg-sf-dark-700 rounded" title="Rename"><Edit3 className="w-2.5 h-2.5 text-sf-text-muted" /></button>
                    <button onClick={(e) => handleDelete(e, asset.id)} className="p-0.5 hover:bg-sf-error rounded" title="Delete"><Trash2 className="w-2.5 h-2.5 text-sf-text-muted" /></button>
                  </div>
                </div>
              )
            })}
            </div>
          </div>
        )}
      </div>

      <NewTimelineDialog
        isOpen={showNewTimelineDialog}
        onClose={() => setShowNewTimelineDialog(false)}
        onCreated={handleTimelineCreatedFromAssets}
      />

      {/* Asset drag thumbnail: shown only while cursor remains over Assets panel */}
      {dragPreviewAsset && assetDragPreview && (
        <div
          className="fixed z-[70] pointer-events-none bg-sf-dark-800/95 border border-sf-dark-500 rounded-md shadow-lg px-2 py-1.5 max-w-[220px]"
          style={{
            left: assetDragPreview.clientX + 14,
            top: assetDragPreview.clientY + 14,
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-10 h-7 rounded overflow-hidden bg-sf-dark-700 flex-shrink-0 flex items-center justify-center">
              {DragPreviewIcon && (
                <LazyAssetThumbnail
                  asset={dragPreviewAsset}
                  Icon={DragPreviewIcon}
                  isActive={isActive}
                  iconClassName="w-4 h-4 text-sf-text-muted"
                  imageAlt=""
                />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-[10px] text-sf-text-primary truncate">{dragPreviewAsset.name}</div>
              <div className="text-[9px] text-sf-text-muted truncate">{getAssetTypeLabel(dragPreviewAsset)}</div>
            </div>
          </div>
        </div>
      )}
      
      {/* Context Menu */}
      {contextMenu && (
        <div
          className="fixed bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl py-1 min-w-[160px] z-50"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Folder menu: Set color + Delete */}
          {contextMenu.folderId ? (
            <>
              <div className="px-3 py-1 text-[10px] text-sf-text-muted uppercase tracking-wider">Color</div>
              <div className="px-2 py-1 flex flex-wrap gap-1">
                {COLOR_PALETTE.map((c) => (
                  <button
                    key={c ?? 'none'}
                    type="button"
                    onClick={() => {
                      setFolderColor(contextMenu.folderId, c)
                      setContextMenu(null)
                    }}
                    className={`w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center ${(folders?.find(f => f.id === contextMenu.folderId)?.color ?? null) === c ? 'border-white scale-110' : 'border-sf-dark-600 hover:border-sf-dark-500'} ${!c ? 'bg-sf-dark-600' : ''}`}
                    style={c ? { backgroundColor: c } : {}}
                    title={c ? c : 'None'}
                  >
                    {!c && <Minus className="w-3 h-3 text-sf-text-muted" />}
                  </button>
                ))}
              </div>
              <div className="border-t border-sf-dark-600 my-1" />
              <button
                onClick={() => { openOverlayGenerator('letterbox', contextMenu.folderId); setContextMenu(null) }}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
              >
                <span className="w-4 text-center">▬</span>
                Create overlay in this folder…
              </button>
              <button
                onClick={(e) => {
                  const folder = folders?.find((f) => f.id === contextMenu.folderId)
                  if (folder) startFolderEditing(e, folder)
                }}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
              >
                <Edit3 className="w-3 h-3 text-sf-accent" />
                Rename folder
              </button>
              <div className="border-t border-sf-dark-600 my-1" />
              <button
                onClick={async () => {
                  const folder = folders?.find(f => f.id === contextMenu.folderId)
                  if (folder) {
                    await handleDeleteFolder(contextMenu.folderId, folder.name)
                  }
                  setContextMenu(null)
                }}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-error hover:bg-sf-dark-700 flex items-center gap-2"
              >
                <Trash2 className="w-3 h-3" />
                Delete folder
              </button>
            </>
          ) : contextMenu.sequenceId ? (
            <>
              {(() => {
                const timeline = projectTimelines.find((entry) => entry.id === contextMenu.sequenceId)
                const timelineCount = projectTimelines.length
                if (!timeline) return null

                return (
                  <>
                    <div className="px-3 py-1 text-[10px] text-sf-text-muted uppercase tracking-wider">Color</div>
                    <div className="px-2 py-1 flex flex-wrap gap-1">
                      {COLOR_PALETTE.map((c) => (
                        <button
                          key={c ?? 'none'}
                          type="button"
                          onClick={() => {
                            setTimelineColor(timeline.id, c)
                            setContextMenu(null)
                          }}
                          className={`w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center ${(timeline.color ?? null) === c ? 'border-white scale-110' : 'border-sf-dark-600 hover:border-sf-dark-500'} ${!c ? 'bg-sf-dark-600' : ''}`}
                          style={c ? { backgroundColor: c } : {}}
                          title={c ? c : 'None'}
                        >
                          {!c && <Minus className="w-3 h-3 text-sf-text-muted" />}
                        </button>
                      ))}
                    </div>
                    <div className="border-t border-sf-dark-600 my-1" />
                    <button
                      onClick={() => handleOpenSequenceFromContextMenu(timeline)}
                      className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
                    >
                      <Play className="w-3 h-3 text-sf-accent" />
                      Open
                    </button>
                    <button
                      onClick={(e) => startSequenceEditing(e, timeline)}
                      className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
                    >
                      <Edit3 className="w-3 h-3 text-sf-accent" />
                      Rename
                    </button>
                    <button
                      onClick={() => handleDuplicateSequence(timeline)}
                      className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
                    >
                      <Copy className="w-3 h-3 text-sf-accent" />
                      Duplicate
                    </button>
                    <div className="px-3 py-1 text-[10px] text-sf-text-muted uppercase tracking-wider">
                      Move to folder
                    </div>
                    <button
                      onClick={() => {
                        moveTimelineToFolder(timeline.id, null)
                        setContextMenu(null)
                      }}
                      className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
                    >
                      <Home className="w-3 h-3" />
                      Root
                    </button>
                    {(folders || []).map((folderOption) => (
                      <button
                        key={folderOption.id}
                        onClick={() => {
                          moveTimelineToFolder(timeline.id, folderOption.id)
                          setContextMenu(null)
                        }}
                        className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
                      >
                        <FolderOpen className="w-3 h-3 text-sf-accent" />
                        {folderOption.name}
                      </button>
                    ))}
                    <div className="border-t border-sf-dark-600 my-1" />
                    <button
                      onClick={() => handleDeleteSequence(timeline)}
                      disabled={timelineCount <= 1}
                      className="w-full px-3 py-1.5 text-left text-xs text-sf-error hover:bg-sf-dark-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Trash2 className="w-3 h-3" />
                      Delete
                    </button>
                  </>
                )
              })()}
            </>
          ) : contextMenu.assetId == null ? (
            /* Empty area: New Folder, Import, Create overlay */
            <>
              <button
                onClick={handleEmptyMenuNewTimeline}
                disabled={!currentProject}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Film className="w-3 h-3 text-sf-accent" />
                Create New Timeline...
              </button>
              <button
                onClick={handleEmptyMenuNewFolder}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
              >
                <FolderPlus className="w-3 h-3 text-sf-accent" />
                New Folder
              </button>
              <button
                onClick={handleEmptyMenuImport}
                disabled={!currentProjectHandle}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Upload className="w-3 h-3 text-sf-accent" />
                Import
              </button>
              <div className="border-t border-sf-dark-600 my-1" />
              <div className="px-2 py-1 text-[10px] text-sf-text-muted uppercase tracking-wider">Create overlay</div>
              <button
                onClick={() => { openOverlayGenerator('letterbox', null); setContextMenu(null) }}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
              >
                <span className="w-4 text-center">▬</span>
                Letterbox overlay…
              </button>
              <button
                onClick={() => { openOverlayGenerator('color', null); setContextMenu(null) }}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
              >
                <span className="w-4 text-center">■</span>
                Color matte…
              </button>
            </>
          ) : (
            /* Asset menu */
            <>
          {/* Video/Image specific options */}
          {(() => {
            const asset = assets.find(a => a.id === contextMenu.assetId)
            const showMask = asset && canGenerateMask(asset)
            const showThumbnails = asset && canGenerateThumbnails(asset)
            const showUpscale = asset && canUpscaleVideo(asset)
            const hasSprite = asset?.sprite?.url
            const isGenerating = asset?.spriteGenerating
            const showAudioToggle = asset?.type === 'video' && asset?.hasAudio !== false
            const isAudioDisabled = asset?.audioEnabled === false
            const isStitchedSequence = asset?.sequenceSource?.kind === 'comfy-stitched'

            if (!showMask && !showThumbnails && !showUpscale && !showAudioToggle && !isStitchedSequence) return null
            
            return (
              <>
                {/* Toggle audio on video */}
                {showAudioToggle && (
                  <button
                    onClick={() => handleToggleVideoAudio(contextMenu.assetId)}
                    className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
                  >
                    {isAudioDisabled ? (
                      <Volume2 className="w-3 h-3 text-sf-success" />
                    ) : (
                      <VolumeX className="w-3 h-3 text-sf-error" />
                    )}
                    {isAudioDisabled ? 'Restore audio on video' : 'Remove audio from video'}
                  </button>
                )}

                {showUpscale && (
                  <button
                    onClick={() => handleOpenTopazUpscaleDialog(contextMenu.assetId)}
                    className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
                  >
                    <ArrowUpDown className="w-3 h-3 text-amber-300" />
                    Upscale Video...
                  </button>
                )}

                {/* Generate Thumbnails - videos only */}
                {showThumbnails && (
                  <button
                    onClick={() => handleGenerateThumbnails(contextMenu.assetId)}
                    disabled={isGenerating}
                    className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isGenerating ? (
                      <Loader2 className="w-3 h-3 text-sf-accent animate-spin" />
                    ) : (
                      <Film className="w-3 h-3 text-sf-blue" />
                    )}
                    {isGenerating ? 'Generating...' : hasSprite ? 'Regenerate Thumbnails' : 'Generate Thumbnails'}
                  </button>
                )}

                {/* Per-asset captions have moved to the timeline toolbar —
                    transcription runs on the edited program audio so cues
                    always line up with what the viewer will hear. */}

                {/* Create Mask option */}
                {showMask && (
                  <button
                    onClick={() => handleOpenMaskDialog(contextMenu.assetId)}
                    className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
                  >
                    <Wand2 className="w-3 h-3 text-sf-accent" />
                    Create Mask...
                  </button>
                )}

                {/* Unstitch a ComfyUI-stitched frame sequence back into individual images */}
                {isStitchedSequence && (
                  <button
                    onClick={() => handleUnstitchSequence(contextMenu.assetId)}
                    className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
                    title={`Stitched from ${asset?.sequenceSource?.frameCount || '?'} frames at ${asset?.sequenceSource?.fps || '?'}fps`}
                  >
                    <Film className="w-3 h-3 text-sf-accent" />
                    Unstitch to individual frames
                  </button>
                )}

                <div className="border-t border-sf-dark-600 my-1" />
              </>
            )
          })()}
          
          {/* Set color for asset */}
          <div className="px-3 py-1 text-[10px] text-sf-text-muted uppercase tracking-wider">Color</div>
          <div className="px-2 py-1 flex flex-wrap gap-1">
            {COLOR_PALETTE.map((c) => (
              <button
                key={c ?? 'none'}
                type="button"
                onClick={() => {
                  setAssetColor(contextMenu.assetId, c)
                  setContextMenu(null)
                }}
                className={`w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center ${(assets.find(a => a.id === contextMenu.assetId)?.color ?? null) === c ? 'border-white scale-110' : 'border-sf-dark-600 hover:border-sf-dark-500'} ${!c ? 'bg-sf-dark-600' : ''}`}
                style={c ? { backgroundColor: c } : {}}
                title={c ? c : 'None'}
              >
                {!c && <Minus className="w-3 h-3 text-sf-text-muted" />}
              </button>
            ))}
          </div>
          <div className="border-t border-sf-dark-600 my-1" />
          
          <div className="px-3 py-1 text-[10px] text-sf-text-muted uppercase tracking-wider">
            Move to folder
          </div>
          {(() => {
            const ids = selectedAssetIds.includes(contextMenu.assetId) ? selectedAssetIds : [contextMenu.assetId]
            return (
              <>
                <button
                  onClick={() => handleMoveToFolder(ids, null)}
                  className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
                >
                  <Home className="w-3 h-3" />
                  Root
                </button>
                {(folders || []).map((folder) => (
                  <button
                    key={folder.id}
                    onClick={() => handleMoveToFolder(ids, folder.id)}
                    className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2"
                  >
                    <FolderOpen className="w-3 h-3 text-sf-accent" />
                    {folder.name}
                  </button>
                ))}
              </>
            )
          })()}
            </>
          )}
        </div>
      )}
      
      <ConfirmDialog
        isOpen={Boolean(confirmDialog)}
        title={confirmDialog?.title || 'Confirm action'}
        message={confirmDialog?.message || ''}
        confirmLabel={confirmDialog?.confirmLabel || 'Confirm'}
        cancelLabel={confirmDialog?.cancelLabel || 'Cancel'}
        tone={confirmDialog?.tone || 'danger'}
        onConfirm={() => resolveConfirmDialog(true)}
        onCancel={() => resolveConfirmDialog(false)}
      />

      {/* Mask Generation Dialog */}
      {maskDialogAsset && (
        <MaskGenerationDialog
          asset={maskDialogAsset}
          onClose={() => setMaskDialogAsset(null)}
          currentFolderId={currentFolderId}
        />
      )}

      {topazUpscaleAsset && (
        <TopazVideoUpscaleDialog
          asset={topazUpscaleAsset}
          onClose={() => setTopazUpscaleAsset(null)}
        />
      )}

      {/* Overlay generator (currently letterbox and color matte only) */}
      <OverlayGeneratorModal
        isOpen={overlayModalOpen}
        onClose={closeOverlayModal}
        onAdd={async (asset) => {
          const targetFolderId = asset.folderId ?? currentFolderId
          const applyGeneratedAsset = (nextAsset) => {
            addAsset({
              ...nextAsset,
              folderId: targetFolderId,
            })
          }

          if (asset.blob && currentProjectHandle && isElectron() && typeof currentProjectHandle === 'string') {
            try {
              const persisted = await writeGeneratedOverlayToProject(
                currentProjectHandle,
                asset.blob,
                asset.name || 'overlay',
                asset.type,
                asset.settings || {}
              )
              applyGeneratedAsset(persisted)
            } catch (err) {
              console.warn('Could not save overlay to project, using blob URL:', err)
              const url = URL.createObjectURL(asset.blob)
              const { blob: _b, ...rest } = asset
              applyGeneratedAsset({ ...rest, url })
            }
          } else {
            const url = asset.blob ? URL.createObjectURL(asset.blob) : asset.url
            const { blob: _b, ...rest } = asset
            applyGeneratedAsset({ ...rest, url: url || rest.url })
          }
        }}
        timelineSize={getCurrentTimelineSettings() ? { width: getCurrentTimelineSettings().width, height: getCurrentTimelineSettings().height } : { width: 1920, height: 1080 }}
        defaultFolderId={overlayModalFolderId ?? currentFolderId}
        initialType={overlayModalInitialType}
        availableTypes={['letterbox', 'color']}
      />

      {/* Footer with asset count */}
      <div className="px-2 py-1.5 border-t border-sf-dark-700 flex items-center justify-between">
        <span className="text-[10px] text-sf-text-muted">
          {filteredAssets.length} {filteredAssets.length === 1 ? 'asset' : 'assets'}
          {subFolders.length > 0 && ` • ${subFolders.length} ${subFolders.length === 1 ? 'folder' : 'folders'}`}
        </span>
        {viewMode === 'list' && (
          <button
            onClick={() => setShowNewFolderInput(true)}
            className="p-0.5 hover:bg-sf-dark-700 rounded transition-colors"
            title="New Folder"
          >
            <FolderPlus className="w-3 h-3 text-sf-text-muted" />
          </button>
        )}
      </div>
    </div>
  )
}

export default AssetsPanel
