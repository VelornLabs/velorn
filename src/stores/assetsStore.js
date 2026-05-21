import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const SPRITE_GENERATION_CONCURRENCY = 2
let activeSpriteGenerationCount = 0
const pendingSpriteGenerationQueue = []
let posterProjectSaveTimer = null

const runWithSpriteGenerationSlot = async (task) => {
  if (activeSpriteGenerationCount >= SPRITE_GENERATION_CONCURRENCY) {
    await new Promise((resolve) => pendingSpriteGenerationQueue.push(resolve))
  }
  activeSpriteGenerationCount += 1
  try {
    return await task()
  } finally {
    activeSpriteGenerationCount = Math.max(0, activeSpriteGenerationCount - 1)
    const next = pendingSpriteGenerationQueue.shift()
    if (next) next()
  }
}

const queueProjectPosterSave = (projectPath, delayMs = 1200) => {
  if (!projectPath) return
  if (posterProjectSaveTimer) {
    clearTimeout(posterProjectSaveTimer)
  }
  posterProjectSaveTimer = setTimeout(async () => {
    posterProjectSaveTimer = null
    try {
      const { useProjectStore } = await import('./projectStore')
      const state = useProjectStore.getState()
      if (state.currentProjectHandle === projectPath && typeof state.saveProject === 'function') {
        await state.saveProject()
      }
    } catch (err) {
      console.warn('Failed to persist poster metadata:', err)
    }
  }, delayMs)
}

/**
 * Store for managing generated and imported assets
 * Persisted to localStorage for data survival across refreshes
 * 
 * Asset structure:
 * {
 *   id: string,
 *   name: string,
 *   type: 'video' | 'audio' | 'image' | 'mask',
 *   url: string (blob URL for playback),
 *   path: string (relative path in project for imported assets),
 *   createdAt: ISO string,
 *   imported: ISO string (for imported assets),
 *   isImported: boolean,
 *   settings: { duration, width, height, etc. },
 *   prompt: string (for AI-generated),
 *   mimeType: string,
 *   size: number,
 *   folderId: string | null (folder organization),
 *   
 *   // Mask-specific fields:
 *   sourceAssetId: string (for masks - the asset the mask was generated from),
 *   frameCount: number (for video masks - number of PNG frames),
 *   maskFrames: Array<{filename, url}> (for video masks - individual frame data),
 * }
 */
export const useAssetsStore = create(
  persist(
    (set, get) => ({
  // All assets (AI-generated + imported)
  assets: [],
  
  // Folders for organizing assets
  folders: [],
  
  // Currently selected asset for preview
  currentPreview: null,
  
  // Counter for auto-naming
  assetCounter: 1,
  folderCounter: 1,

  // Transient project/media preparation progress for heavy project opens.
  mediaPreparation: {
    active: false,
    phase: 'idle',
    label: '',
    completed: 0,
    total: 0,
    critical: false,
  },
  setMediaPreparation: (updates = {}) => {
    set((state) => ({
      mediaPreparation: {
        ...state.mediaPreparation,
        ...updates,
      },
    }))
  },
  clearMediaPreparation: () => {
    set({
      mediaPreparation: {
        active: false,
        phase: 'idle',
        label: '',
        completed: 0,
        total: 0,
        critical: false,
      },
    })
  },
  
  // Video playback state (shared between PreviewPanel and TransportControls)
  videoRef: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 0.75,
  
  // Register video element ref
  registerVideoRef: (ref) => {
    set({ videoRef: ref })
  },
  
  // Playback controls
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setDuration: (dur) => set({ duration: dur }),
  setVolume: (vol) => {
    const ref = get().videoRef
    if (ref) {
      ref.volume = vol
    }
    set({ volume: vol })
  },
  
  togglePlay: () => {
    const { videoRef, isPlaying, currentPreview } = get()
    if (videoRef) {
      if (isPlaying) {
        videoRef.pause()
      } else {
        videoRef.play()
      }
    } else if (currentPreview?.type === 'mask') {
      // For masks (no videoRef), just toggle the isPlaying state
      // The MaskPreview component will handle the actual playback
      set({ isPlaying: !isPlaying })
    }
  },
  
  seekTo: (time) => {
    const { videoRef, duration } = get()
    const clampedTime = Math.max(0, Math.min(duration, time))
    if (videoRef) {
      videoRef.currentTime = clampedTime
    }
    // Always update currentTime state (needed for masks and other non-video assets)
    set({ currentTime: clampedTime })
  },
  
  skip: (seconds) => {
    const { videoRef, currentTime, duration } = get()
    if (videoRef) {
      const newTime = Math.max(0, Math.min(duration, currentTime + seconds))
      videoRef.currentTime = newTime
      set({ currentTime: newTime })
    }
  },
  
  /**
   * Generate a name from prompt text
   */
  generateName: (prompt) => {
    const counter = get().assetCounter
    // Take first few words, clean up, limit length
    const words = prompt
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .split(/\s+/)
      .slice(0, 4)
      .join('_')
      .substring(0, 30)
    
    set({ assetCounter: counter + 1 })
    return `${words}_${String(counter).padStart(3, '0')}`
  },
  
  /**
   * Add a new generated asset
   */
  addAsset: (asset) => {
    const buildUniqueAssetId = () => {
      const prefix = `asset_${Date.now()}`
      let candidate = `${prefix}_${Math.random().toString(36).slice(2, 8)}`
      while (get().assets.some((entry) => entry?.id === candidate)) {
        candidate = `${prefix}_${Math.random().toString(36).slice(2, 8)}`
      }
      return candidate
    }
    const newAsset = {
      id: buildUniqueAssetId(),
      createdAt: new Date().toISOString(),
      ...asset
    }
    
    set((state) => ({
      assets: [newAsset, ...state.assets],
      currentPreview: newAsset // Auto-preview new assets
    }))
    
    return newAsset
  },
  
  /**
   * Set the current preview
   * Also resets playback state for the new asset
   */
  setPreview: (asset) => {
    set({ 
      currentPreview: asset, 
      previewMode: 'asset',
      isPlaying: false,  // Don't auto-play, let user control
      currentTime: 0,    // Reset to start
    })
  },
  
  /**
   * Preview mode: 'asset' (single asset preview) or 'timeline' (playing timeline)
   */
  previewMode: 'asset',
  
  /**
   * Set the preview mode explicitly
   */
  setPreviewMode: (mode) => {
    set({ previewMode: mode })
  },
  
  /**
   * Clear the current preview
   */
  clearPreview: () => {
    set({ currentPreview: null })
  },
  
  /**
   * Remove an asset
   */
  removeAsset: (id) => {
    set((state) => ({
      assets: state.assets.filter(a => a.id !== id),
      currentPreview: state.currentPreview?.id === id ? null : state.currentPreview
    }))
  },
  
  /**
   * Rename an asset
   */
  renameAsset: (id, newName) => {
    set((state) => ({
      assets: state.assets.map(a => 
        a.id === id ? { ...a, name: newName } : a
      ),
      currentPreview: state.currentPreview?.id === id 
        ? { ...state.currentPreview, name: newName }
        : state.currentPreview
    }))
  },

  /**
   * Update arbitrary asset fields.
   * Useful for generated overlays that need in-place regeneration.
   */
  updateAsset: (id, updates) => {
    if (!id || !updates || typeof updates !== 'object') return
    set((state) => {
      const existing = state.assets.find(a => a.id === id)
      if (!existing) return {}

      const nextAsset = { ...existing, ...updates }
      const oldUrl = existing.url
      const nextUrl = nextAsset.url
      if (oldUrl && oldUrl !== nextUrl && oldUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(oldUrl) } catch (_) {}
      }

      return {
        assets: state.assets.map(a => (a.id === id ? nextAsset : a)),
        currentPreview: state.currentPreview?.id === id
          ? nextAsset
          : state.currentPreview
      }
    })
  },

  /**
   * Enable/disable audio for a video asset
   */
  setAssetAudioEnabled: (id, enabled) => {
    set((state) => ({
      assets: state.assets.map(a =>
        a.id === id ? { ...a, audioEnabled: enabled } : a
      ),
      currentPreview: state.currentPreview?.id === id
        ? { ...state.currentPreview, audioEnabled: enabled }
        : state.currentPreview
    }))
  },

  /**
   * Move an asset to a folder
   * @param {string} assetId - The asset ID
   * @param {string|null} folderId - The folder ID (null = root)
   */
  moveAssetToFolder: (assetId, folderId) => {
    set((state) => ({
      assets: state.assets.map(a =>
        a.id === assetId ? { ...a, folderId } : a
      ),
      currentPreview: state.currentPreview?.id === assetId
        ? { ...state.currentPreview, folderId }
        : state.currentPreview
    }))
  },

  /**
   * Move multiple assets to a folder
   * @param {string[]} assetIds - Asset IDs to move
   * @param {string|null} folderId - The folder ID (null = root)
   */
  moveAssetsToFolder: (assetIds, folderId) => {
    if (!assetIds?.length) return
    const idSet = new Set(assetIds)
    set((state) => ({
      assets: state.assets.map(a =>
        idSet.has(a.id) ? { ...a, folderId } : a
      ),
      currentPreview: state.currentPreview && idSet.has(state.currentPreview.id)
        ? { ...state.currentPreview, folderId }
        : state.currentPreview
    }))
  },

  /**
   * Set folder color (for organization). color: hex string or null.
   */
  setFolderColor: (folderId, color) => {
    set((state) => ({
      folders: state.folders.map(f =>
        f.id === folderId ? { ...f, color: color || null } : f
      )
    }))
  },

  /**
   * Set asset color (for organization). color: hex string or null.
   */
  setAssetColor: (assetId, color) => {
    set((state) => ({
      assets: state.assets.map(a =>
        a.id === assetId ? { ...a, color: color || null } : a
      ),
      currentPreview: state.currentPreview?.id === assetId
        ? { ...state.currentPreview, color: color || null }
        : state.currentPreview
    }))
  },

  /**
   * Add a new folder
   * @param {object} folder - Folder data { name, parentId, color? }
   */
  addFolder: (folder) => {
    const state = get()
    const newFolder = {
      id: `folder-${state.folderCounter}`,
      name: folder.name,
      parentId: folder.parentId || null,
      color: folder.color ?? null,
      createdAt: new Date().toISOString()
    }
    set((state) => ({
      folders: [...state.folders, newFolder],
      folderCounter: state.folderCounter + 1
    }))
    return newFolder
  },

  /**
   * Remove a folder recursively (deletes nested folders and their assets)
   * @param {string} folderId - The folder ID to remove
   */
  removeFolder: (folderId) => {
    const state = get()
    if (!state.folders.some((f) => f.id === folderId)) return

    const idsToDelete = new Set([folderId])
    let changed = true
    while (changed) {
      changed = false
      for (const folder of state.folders) {
        if (idsToDelete.has(folder.id)) continue
        if (idsToDelete.has(folder.parentId || null)) {
          idsToDelete.add(folder.id)
          changed = true
        }
      }
    }

    const updatedAssets = state.assets.filter((a) => !idsToDelete.has(a.folderId || null))
    const updatedFolders = state.folders.filter((f) => !idsToDelete.has(f.id))

    set({
      assets: updatedAssets,
      folders: updatedFolders
    })
  },

  /**
   * Rename a folder
   * @param {string} folderId - The folder ID
   * @param {string} newName - The new name
   */
  renameFolder: (folderId, newName) => {
    set((state) => ({
      folders: state.folders.map(f =>
        f.id === folderId ? { ...f, name: newName } : f
      )
    }))
  },

  /**
   * Clear all assets (for "New Project")
   */
  clearProject: () => {
    // Revoke any blob URLs before clearing
    const state = get()
    state.assets.forEach(asset => {
      if (asset.url && asset.url.startsWith('blob:')) {
        URL.revokeObjectURL(asset.url)
      }
    })
    
    set({
      assets: [],
      folders: [],
      currentPreview: null,
      assetCounter: 1,
      folderCounter: 1,
      mediaPreparation: {
        active: false,
        phase: 'idle',
        label: '',
        completed: 0,
        total: 0,
        critical: false,
      },
      isPlaying: false,
      currentTime: 0,
      duration: 0,
    })
  },

  /**
   * Load assets from project data
   * @param {Array} projectAssets - Assets from project file
   * @param {FileSystemDirectoryHandle|string} projectHandle - The project directory handle for regenerating URLs
   * @param {Array} [projectFolders] - Folders from project file (optional; if omitted, folders are cleared)
   * @param {number} [projectFolderCounter] - Folder counter from project file (optional)
   */
  loadFromProject: async (projectAssets, projectHandle, projectFolders, projectFolderCounter) => {
    // Clear existing assets first
    get().clearProject()

    const sourceAssets = projectAssets || []
    const totalAssets = sourceAssets.length
    set({
      mediaPreparation: {
        active: totalAssets > 0,
        phase: 'assets',
        label: 'Loading project assets...',
        completed: 0,
        total: totalAssets,
        critical: true,
      },
    })

    const fileSystemHelpers = await import('../services/fileSystem')
    const { getProjectFileUrl, getAbsoluteFileUrl, isElectron: isElectronMode } = fileSystemHelpers

    // Load assets - URLs need to be regenerated for imported assets
    const assetsWithUrls = new Array(sourceAssets.length)
    let loadedAssetCount = 0

    const hydrateAsset = async (asset, index) => {
      const needsUrlRefresh = asset?.url?.startsWith?.('blob:')
      const hasPath = !!asset?.path
      const hasAbsolutePath = !!asset?.absolutePath

      if ((asset?.isImported || needsUrlRefresh || hasPath || hasAbsolutePath) && projectHandle) {
        try {
          let url = null
          if (isElectronMode() && hasAbsolutePath) {
            url = await getAbsoluteFileUrl(asset.absolutePath)
          } else if (hasPath) {
            url = await getProjectFileUrl(projectHandle, asset.path)
          }

          let playbackCachePath = asset.playbackCachePath
          let playbackCacheStatus = asset.playbackCacheStatus

          assetsWithUrls[index] = {
            ...asset,
            url,
            playbackCachePath: playbackCachePath ?? undefined,
            playbackCacheStatus,
            playbackCacheUrl: undefined,
            proxyPath: asset.proxyPath ?? undefined,
            proxyStatus: asset.proxyStatus,
            proxyUrl: undefined,
            poster: asset.poster || undefined,
          }
        } catch (err) {
          console.warn(`Could not load asset ${asset.name}:`, err)
          assetsWithUrls[index] = { ...asset, url: null }
        }
      } else {
        assetsWithUrls[index] = asset
      }

      loadedAssetCount += 1
      set({
        mediaPreparation: {
          active: true,
          phase: 'assets',
          label: 'Loading project assets...',
          completed: loadedAssetCount,
          total: totalAssets,
          critical: true,
        },
      })
    }

    const concurrency = Math.max(1, Math.min(8, Math.floor(Number(sourceAssets.length > 120 ? 8 : 4))))
    let cursor = 0
    const worker = async () => {
      while (cursor < sourceAssets.length) {
        const index = cursor
        cursor += 1
        const asset = sourceAssets[index]
        await hydrateAsset(asset, index)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, sourceAssets.length) }, () => worker()))
    
    const nextState = {
      assets: assetsWithUrls,
      assetCounter: (projectAssets?.length || 0) + 1,
      mediaPreparation: {
        active: false,
        phase: 'idle',
        label: '',
        completed: 0,
        total: 0,
        critical: false,
      },
    }
    // Restore folder structure from project file so folders persist across sessions
    if (Array.isArray(projectFolders)) {
      nextState.folders = projectFolders
    }
    if (typeof projectFolderCounter === 'number' && projectFolderCounter >= 0) {
      nextState.folderCounter = projectFolderCounter
    }
    set(nextState)
  },

  /**
   * Get assets data for saving to project
   * Returns assets without blob URLs (paths only for imported)
   */
  getProjectData: () => {
    const state = get()
    return state.assets.map(asset => ({
      ...asset,
      // Don't save blob URLs - they're session-specific
      url: asset.isImported ? null : asset.url, // Keep URL for AI assets (they're external)
      playbackCacheUrl: undefined, // Session-only; path is persisted
      proxyUrl: undefined, // Session-only; path is persisted
    }))
  },

  /**
   * Update asset URL (for when loading from project and regenerating blob URLs)
   */
  updateAssetUrl: (assetId, url) => {
    set((state) => ({
      assets: state.assets.map(a => 
        a.id === assetId ? { ...a, url } : a
      ),
      currentPreview: state.currentPreview?.id === assetId 
        ? { ...state.currentPreview, url }
        : state.currentPreview
    }))
  },

  /**
   * Update asset's sprite data
   * @param {string} assetId - The asset ID
   * @param {object} spriteData - Sprite metadata { spriteUrl, spritePath, ... }
   */
  updateAssetSprite: (assetId, spriteData) => {
    set((state) => ({
      assets: state.assets.map(a => 
        a.id === assetId ? { ...a, sprite: spriteData } : a
      ),
      currentPreview: state.currentPreview?.id === assetId 
        ? { ...state.currentPreview, sprite: spriteData }
        : state.currentPreview
    }))
  },

  /**
   * Update asset's poster data
   * @param {string} assetId - The asset ID
   * @param {object} posterData - Poster metadata { url, posterPath, sourceSignature, ... }
   */
  updateAssetPoster: (assetId, posterData) => {
    set((state) => ({
      assets: state.assets.map(a =>
        a.id === assetId ? { ...a, poster: posterData } : a
      ),
      currentPreview: state.currentPreview?.id === assetId
        ? { ...state.currentPreview, poster: posterData }
        : state.currentPreview
    }))
  },

  /**
   * Get sprite data for an asset
   * @param {string} assetId - The asset ID
   * @returns {object|null} - Sprite data or null
   */
  getAssetSprite: (assetId) => {
    const asset = get().assets.find(a => a.id === assetId)
    return asset?.sprite || null
  },

  /**
   * Generate thumbnail sprite for a video asset
   * @param {string} assetId - The asset ID
   * @param {string} projectPath - Project directory path (for saving)
   */
  generateAssetSprite: async (assetId, projectPath) => {
    const asset = get().assets.find(a => a.id === assetId)
    if (!asset || asset.type !== 'video' || !asset.url) {
      console.warn('Cannot generate sprite: invalid asset or not a video')
      return null
    }

    // Mark as generating
    set((state) => ({
      assets: state.assets.map(a => 
        a.id === assetId ? { ...a, spriteGenerating: true } : a
      )
    }))

    try {
      const { generateThumbnailSprite, saveSpriteToProject } = await import('../services/thumbnailSprites')
      
      // Generate sprite. This uses a hidden video element and canvas seeks,
      // so keep generation bounded across imports/manual actions.
      const result = await runWithSpriteGenerationSlot(() => generateThumbnailSprite(asset.url, asset.duration || 5))
      if (!result) {
        throw new Error('Failed to generate sprite')
      }

      let spriteData = result.spriteData

      // Save to project if we have a project path
      if (projectPath) {
        const saved = await saveSpriteToProject(projectPath, assetId, result.blob, result.spriteData)
        spriteData = {
          ...spriteData,
          spritePath: saved.spritePath,
          url: result.spriteUrl, // Keep blob URL for immediate use
        }
      }

      // Update asset with sprite data
      get().updateAssetSprite(assetId, spriteData)
      
      // Clear generating flag
      set((state) => ({
        assets: state.assets.map(a => 
          a.id === assetId ? { ...a, spriteGenerating: false } : a
        )
      }))

      console.log(`Generated sprite for ${asset.name}: ${spriteData.frameCount} frames`)
      return spriteData
    } catch (err) {
      console.error('Failed to generate sprite:', err)
      
      // Clear generating flag
      set((state) => ({
        assets: state.assets.map(a => 
          a.id === assetId ? { ...a, spriteGenerating: false } : a
        )
      }))
      
      return null
    }
  },

  /**
   * Generate a single-frame poster for a video asset.
   * Posters are used by the Assets panel as the static preview image.
   * @param {string} assetId - The asset ID
   * @param {string} projectPath - Project directory path (for saving)
   */
  generateAssetPoster: async (assetId, projectPath) => {
    const asset = get().assets.find(a => a.id === assetId)
    if (!asset || asset.type !== 'video' || !asset.absolutePath || !projectPath) {
      return null
    }

    try {
      const { loadVideoPosterFromProject, generateVideoPosterInProject, buildPosterSignature } = await import('../services/thumbnailPosters')
      const sourcePath = asset.absolutePath
      const sourceInfo = await window.electronAPI?.getFileInfo?.(sourcePath)
      const sourceSignature = buildPosterSignature(sourceInfo, sourcePath)
      const existing = await loadVideoPosterFromProject(projectPath, assetId, sourceSignature)
      if (existing?.posterData) {
        get().updateAssetPoster(assetId, existing.posterData)
        queueProjectPosterSave(projectPath)
        return existing.posterData
      }

      const result = await generateVideoPosterInProject(projectPath, assetId, sourcePath, sourceSignature)
      if (result?.posterData) {
        get().updateAssetPoster(assetId, result.posterData)
        queueProjectPosterSave(projectPath)
        return result.posterData
      }
    } catch (err) {
      console.warn('Failed to generate poster:', err)
    }

    return null
  },

  /**
   * Hydrate the browser-facing media for a single video asset when it becomes visible.
   * This is intentionally called lazily from the Assets panel so we only touch
   * derived paths for tiles the user can actually see.
   * @param {string} assetId - The asset ID
   * @param {string} projectPath - Project directory path
   */
  hydrateAssetBrowserMedia: async (assetId, projectPath) => {
    if (!assetId || !projectPath || typeof window === 'undefined' || !window.electronAPI?.isElectron) return null
    const asset = get().assets.find(a => a.id === assetId)
    if (!asset || asset.type !== 'video') return null

    const { getProjectFileUrl, getAbsoluteFileUrl } = await import('../services/fileSystem')
    const { loadVideoPosterFromProject, generateVideoPosterInProject, buildPosterSignature } = await import('../services/thumbnailPosters')

    let poster = asset.poster || null
    let posterChanged = false
    let playbackCacheUrl = asset.playbackCacheUrl || undefined
    let proxyUrl = asset.proxyUrl || undefined

    if (!poster && asset.absolutePath) {
      try {
        const sourceInfo = await window.electronAPI.getFileInfo(asset.absolutePath)
        const sourceSignature = buildPosterSignature(sourceInfo, asset.absolutePath)
        const existing = await loadVideoPosterFromProject(projectPath, assetId, sourceSignature)
        if (existing?.posterData) {
          poster = existing.posterData
          posterChanged = true
        } else {
          const generated = await generateVideoPosterInProject(projectPath, assetId, asset.absolutePath, sourceSignature)
          if (generated?.posterData) {
            poster = generated.posterData
            posterChanged = true
            queueProjectPosterSave(projectPath)
          }
        }
      } catch (err) {
        console.warn('Failed to hydrate poster for visible asset:', err)
      }
    }

    if (!playbackCacheUrl && asset.playbackCachePath) {
      try {
        const absolutePlaybackCachePath = await window.electronAPI.pathJoin(projectPath, asset.playbackCachePath)
        const exists = await window.electronAPI.exists(absolutePlaybackCachePath)
        if (exists) {
          playbackCacheUrl = await getProjectFileUrl(projectPath, asset.playbackCachePath)
        }
      } catch (err) {
        console.warn('Failed to hydrate playback cache URL for visible asset:', err)
      }
    }

    if (!proxyUrl && asset.proxyPath) {
      try {
        const absoluteProxyPath = await window.electronAPI.pathJoin(projectPath, asset.proxyPath)
        const exists = await window.electronAPI.exists(absoluteProxyPath)
        if (exists) {
          proxyUrl = await getProjectFileUrl(projectPath, asset.proxyPath)
        }
      } catch (err) {
        console.warn('Failed to hydrate proxy URL for visible asset:', err)
      }
    }

    if (!posterChanged && !playbackCacheUrl && !proxyUrl) return null

    const updates = {}
    if (posterChanged) updates.poster = poster || undefined
    if (typeof playbackCacheUrl !== 'undefined') updates.playbackCacheUrl = playbackCacheUrl
    if (typeof proxyUrl !== 'undefined') updates.proxyUrl = proxyUrl

    if (Object.keys(updates).length > 0) {
      get().updateAsset(assetId, updates)
    }

    return updates
  },

  /**
   * Load saved thumbnail sprites for video assets without flooding the renderer.
   * Startup intentionally does not call this; use it for explicit/on-demand
   * warming where bounded background work is acceptable.
   * @param {string} projectPath - Project directory path
   * @param {object} options - { concurrency?: number, limit?: number, assetIds?: string[] }
   */
  loadSpritesFromProject: async (projectPath, options = {}) => {
    if (!projectPath) return

    const { loadSpriteFromProject, loadSpriteIndex } = await import('../services/thumbnailSprites')
    const spriteIndex = await loadSpriteIndex(projectPath)
    const state = get()
    const targetIds = Array.isArray(options.assetIds) && options.assetIds.length > 0
      ? new Set(options.assetIds)
      : null
    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : null
    const concurrency = Math.max(1, Math.min(4, Math.floor(Number(options.concurrency) || 2)))
    const videoAssets = state.assets
      .filter((asset) => asset?.type === 'video' && (!targetIds || targetIds.has(asset.id)))
      .slice(0, limit || undefined)

    if (videoAssets.length === 0) {
      get().clearMediaPreparation()
      return
    }

    let completed = 0
    const updateProgress = () => {
      set({
        mediaPreparation: {
          active: true,
          phase: 'sprites',
          label: `Loading video thumbnails (${concurrency} at a time)...`,
          completed,
          total: videoAssets.length,
          critical: false,
        },
      })
    }
    updateProgress()

    let cursor = 0
    const loadOne = async (asset) => {
      try {
        const sprite = await loadSpriteFromProject(projectPath, asset.id, spriteIndex)
        if (sprite) {
          get().updateAssetSprite(asset.id, sprite.spriteData)
          console.log(`Loaded sprite for ${asset.name}`)
        }
      } catch (err) {
        // Sprite might not exist yet, that's OK.
      } finally {
        completed += 1
        updateProgress()
      }
    }

    const worker = async () => {
      while (cursor < videoAssets.length) {
        const asset = videoAssets[cursor]
        cursor += 1
        await loadOne(asset)
        // Yield between items so tab switches and paint are not starved.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, videoAssets.length) }, () => worker()))
    } finally {
      get().clearMediaPreparation()
    }
  },

  /**
   * Load or generate posters for video assets without flooding the renderer.
   * Used by the Assets panel so video tiles show a static thumbnail even
   * without a timeline preview.
   * @param {string} projectPath - Project directory path
   * @param {object} options - { concurrency?: number, limit?: number, assetIds?: string[] }
   */
  loadPostersFromProject: async (projectPath, options = {}) => {
    if (!projectPath) return

    const { loadVideoPosterFromProject, generateVideoPosterInProject, buildPosterSignature } = await import('../services/thumbnailPosters')
    const state = get()
    const targetIds = Array.isArray(options.assetIds) && options.assetIds.length > 0
      ? new Set(options.assetIds)
      : null
    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : null
    const concurrency = Math.max(1, Math.min(4, Math.floor(Number(options.concurrency) || 2)))
    const videoAssets = state.assets
      .filter((asset) => asset?.type === 'video' && (!targetIds || targetIds.has(asset.id)))
      .slice(0, limit || undefined)

    if (videoAssets.length === 0) {
      return
    }

    let completed = 0
    const updateProgress = () => {
      set({
        mediaPreparation: {
          active: true,
          phase: 'posters',
          label: `Loading video thumbnails (${concurrency} at a time)...`,
          completed,
          total: videoAssets.length,
          critical: false,
        },
      })
    }
    updateProgress()

    let cursor = 0
    let updatedAnyPoster = false
    const loadOne = async (asset) => {
      try {
        if (asset?.poster?.url) {
          return
        }
        const sourcePath = asset?.absolutePath || null
        if (!sourcePath) return
        const sourceInfo = await window.electronAPI?.getFileInfo?.(sourcePath)
        const sourceSignature = buildPosterSignature(sourceInfo, sourcePath)
        const loaded = await loadVideoPosterFromProject(projectPath, asset.id, sourceSignature)
        if (loaded?.posterData) {
          get().updateAssetPoster(asset.id, loaded.posterData)
          updatedAnyPoster = true
          return
        }
        const generated = await generateVideoPosterInProject(projectPath, asset.id, sourcePath, sourceSignature)
        if (generated?.posterData) {
          get().updateAssetPoster(asset.id, generated.posterData)
          updatedAnyPoster = true
        }
      } catch (err) {
        console.warn('[AssetsStore] poster load failed:', err)
      } finally {
        completed += 1
        updateProgress()
      }
    }

    const worker = async () => {
      while (cursor < videoAssets.length) {
        const asset = videoAssets[cursor]
        cursor += 1
        await loadOne(asset)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, videoAssets.length) }, () => worker()))
    } finally {
      if (updatedAnyPoster) {
        queueProjectPosterSave(projectPath)
      }
      get().clearMediaPreparation()
    }
  },

  /**
   * Get asset by ID
   * @param {string} assetId - The asset ID to find
   * @returns {Object|null} - The asset or null if not found
   */
  getAssetById: (assetId) => {
    return get().assets.find(a => a.id === assetId) || null
  },

  /**
   * Get the current valid URL for an asset (prefers playback cache when ready for smooth timeline playback)
   * @param {string} assetId - The asset ID
   * @returns {string|null} - The current URL or null
   */
  getAssetUrl: (assetId) => {
    const asset = get().assets.find(a => a.id === assetId)
    if (!asset) return null
    // Use playback cache URL when available (Flame-style: optimized for playback)
    const useCache = !!asset.playbackCacheUrl && asset.playbackCacheStatus !== 'failed'
    const url = useCache ? asset.playbackCacheUrl : (asset.url || null)
    if (typeof localStorage !== 'undefined' && localStorage.getItem('comfystudio-debug-playback') === '1' && asset.type === 'video') {
      console.log('[PlaybackCache] getAssetUrl:', { assetId, useCache, urlHint: url ? (url.startsWith('file:') ? 'file:// (cache or original)' : url.slice(0, 50) + '...') : 'null' })
    }
    return url
  },

  /**
   * Set playback cache path and URL for an asset (after transcode completes)
   */
  setPlaybackCache: (assetId, playbackCachePath, playbackCacheUrl) => {
    set((state) => ({
      assets: state.assets.map(a =>
        a.id === assetId ? { ...a, playbackCachePath, playbackCacheUrl } : a
      ),
      currentPreview: state.currentPreview?.id === assetId
        ? { ...state.currentPreview, playbackCachePath, playbackCacheUrl }
        : state.currentPreview,
    }))
  },

  /**
   * Set playback cache status for UI (encoding | ready | failed)
   */
  setPlaybackCacheStatus: (assetId, status) => {
    set((state) => ({
      assets: state.assets.map(a =>
        a.id === assetId ? { ...a, playbackCacheStatus: status } : a
      ),
      currentPreview: state.currentPreview?.id === assetId
        ? { ...state.currentPreview, playbackCacheStatus: status }
        : state.currentPreview,
    }))
  },

  /**
   * Set proxy path + URL for an asset (after low-res proxy transcode completes).
   * Kept distinct from playback cache so a single asset can have both tiers
   * (proxy = small low-res for multi-layer preview, playback = same-res fast
   * decode for single-layer smoothness).
   */
  setProxyCache: (assetId, proxyPath, proxyUrl) => {
    set((state) => ({
      assets: state.assets.map(a =>
        a.id === assetId ? { ...a, proxyPath, proxyUrl } : a
      ),
      currentPreview: state.currentPreview?.id === assetId
        ? { ...state.currentPreview, proxyPath, proxyUrl }
        : state.currentPreview,
    }))
  },

  /**
   * Set proxy status for UI (encoding | ready | failed | skipped).
   */
  setProxyCacheStatus: (assetId, status) => {
    set((state) => ({
      assets: state.assets.map(a =>
        a.id === assetId ? { ...a, proxyStatus: status } : a
      ),
      currentPreview: state.currentPreview?.id === assetId
        ? { ...state.currentPreview, proxyStatus: status }
        : state.currentPreview,
    }))
  },

  /**
   * Mark proxy as unusable and fall back to playback cache / source.
   * Does not touch playbackCache* fields; those recover independently.
   */
  markProxyCacheBroken: (assetId, reason = 'unknown') => {
    if (!assetId) return
    set((state) => ({
      assets: state.assets.map(a =>
        a.id === assetId
          ? {
              ...a,
              proxyUrl: undefined,
              proxyPath: undefined,
              proxyStatus: 'failed',
              proxyError: reason,
            }
          : a
      ),
      currentPreview: state.currentPreview?.id === assetId
        ? {
            ...state.currentPreview,
            proxyUrl: undefined,
            proxyPath: undefined,
            proxyStatus: 'failed',
            proxyError: reason,
          }
        : state.currentPreview,
    }))
  },

  /**
   * Mark playback cache as unusable and immediately fallback to source URL.
   * Keeps source asset URL untouched.
   */
  markPlaybackCacheBroken: (assetId, reason = 'unknown') => {
    if (!assetId) return

    if (typeof localStorage !== 'undefined' && localStorage.getItem('comfystudio-debug-playback') === '1') {
      console.warn('[PlaybackCache] Marking cache broken, fallback to source', { assetId, reason })
    }

    set((state) => ({
      assets: state.assets.map(a =>
        a.id === assetId
          ? {
              ...a,
              playbackCacheUrl: undefined,
              playbackCachePath: undefined,
              playbackCacheStatus: 'failed',
              playbackCacheError: reason,
            }
          : a
      ),
      currentPreview: state.currentPreview?.id === assetId
        ? {
            ...state.currentPreview,
            playbackCacheUrl: undefined,
            playbackCachePath: undefined,
            playbackCacheStatus: 'failed',
            playbackCacheError: reason,
          }
        : state.currentPreview,
    }))
  },

  /**
   * Regenerate URLs for all imported assets that have null URLs
   * Called when project handle becomes available
   * @param {FileSystemDirectoryHandle} projectHandle - The project directory handle
   */
  regenerateImportedUrls: async (projectHandle) => {
    if (!projectHandle) return
    
    const state = get()
    const assetsNeedingUrls = state.assets.filter(a => a.isImported && a.path && !a.url)
    
    if (assetsNeedingUrls.length === 0) return
    
    console.log(`Regenerating URLs for ${assetsNeedingUrls.length} imported assets...`)
    
    for (const asset of assetsNeedingUrls) {
      try {
        const { getProjectFileUrl } = await import('../services/fileSystem')
        const url = await getProjectFileUrl(projectHandle, asset.path)
        get().updateAssetUrl(asset.id, url)
        console.log(`Regenerated URL for ${asset.name}`)
      } catch (err) {
        console.warn(`Could not regenerate URL for ${asset.name}:`, err)
      }
    }
  },

  /**
   * Get all mask assets for a specific source asset
   * @param {string} sourceAssetId - The source asset ID
   * @returns {Array} - Array of mask assets
   */
  getMasksForAsset: (sourceAssetId) => {
    return get().assets.filter(a => a.type === 'mask' && a.sourceAssetId === sourceAssetId)
  },

  /**
   * Get all mask assets in the project
   * @returns {Array} - Array of all mask assets
   */
  getAllMasks: () => {
    return get().assets.filter(a => a.type === 'mask')
  },

  /**
   * Add a mask asset with proper structure
   * @param {Object} maskData - Mask asset data
   * @returns {Object} - The created mask asset
   */
  addMaskAsset: (maskData) => {
    console.log('addMaskAsset called with:', maskData)
    
    const state = get()
    const counter = state.assetCounter
    
    const newMask = {
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      type: 'mask',
      name: maskData.name || `Mask_${String(counter).padStart(3, '0')}`,
      sourceAssetId: maskData.sourceAssetId,
      prompt: maskData.prompt,
      url: maskData.url,                    // For single image masks
      maskFrames: maskData.maskFrames || [], // For video masks (PNG sequence)
      frameCount: maskData.frameCount || 1,
      settings: maskData.settings || {},
      path: maskData.path,
      mimeType: maskData.mimeType || 'image/png',
      folderId: maskData.folderId || null,
      isImported: false, // Masks are always AI-generated
    }
    
    console.log('Creating mask asset:', newMask)
    
    set((state) => ({
      assets: [newMask, ...state.assets],
      assetCounter: state.assetCounter + 1,
      currentPreview: newMask
    }))
    
    console.log('Mask asset added to store')
    
    return newMask
  }
    }),
    {
      name: 'comfystudio-assets', // localStorage key
      partialize: (state) => ({
        // Only persist these fields (exclude transient playback state)
        assets: state.assets,
        folders: state.folders,
        assetCounter: state.assetCounter,
        folderCounter: state.folderCounter,
        volume: state.volume,
        // Don't persist previewMode - always start fresh
      }),
    }
  )
)

export default useAssetsStore
