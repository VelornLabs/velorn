import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  isElectron,
  isFileSystemSupported,
  requestDirectoryAccess,
  createProjectFolder,
  saveProject as saveProjectToFile,
  loadProject as loadProjectFromFile,
  loadLatestProjectAutosave as loadLatestProjectAutosaveFromFile,
  listProjects,
  storeDirectoryHandle,
  getStoredDirectoryHandle,
  verifyPermission,
  removeStoredDirectoryHandle,
} from '../services/fileSystem'
import { useTimelineStore } from './timelineStore'
import { useAssetsStore } from './assetsStore'
import { captureAndSaveProjectThumbnail } from '../utils/projectThumbnail'
import {
  createDefaultFlowAiProjectData,
  normalizeFlowAiProjectData,
} from '../services/flowAiSchema'

/**
 * Resolution presets for new projects
 */
export const RESOLUTION_PRESETS = [
  { name: 'HD 1080p', width: 1920, height: 1080, aspect: '16:9' },
  { name: 'HD 720p', width: 1280, height: 720, aspect: '16:9' },
  { name: '4K UHD', width: 3840, height: 2160, aspect: '16:9' },
  { name: 'Vertical 1080', width: 1080, height: 1920, aspect: '9:16' },
  { name: 'Square', width: 1080, height: 1080, aspect: '1:1' },
  { name: 'Instagram 4:5', width: 1080, height: 1350, aspect: '4:5' },
  { name: 'Cinematic 21:9', width: 2560, height: 1080, aspect: '21:9' },
]

/**
 * Frame rate presets
 */
export const FPS_PRESETS = [
  { value: 15, label: '15 fps' },
  { value: 23.976, label: '23.976 fps (Film)' },
  { value: 24, label: '24 fps (Cinema)' },
  { value: 25, label: '25 fps (PAL)' },
  { value: 30, label: '30 fps (NTSC)' },
  { value: 60, label: '60 fps (High Frame Rate)' },
]

/**
 * Create a default timeline structure
 * @param {string} name - Timeline name
 * @param {string} id - Optional timeline ID
 * @param {object} settings - Optional timeline-specific settings (width, height, fps)
 */
const createDefaultTimeline = (name = 'Timeline 1', id = null, settings = null) => ({
  id: id || `timeline-${Date.now()}`,
  name,
  color: settings?.color || null,
  folderId: settings?.folderId || null,
  created: new Date().toISOString(),
  modified: new Date().toISOString(),
  // Timeline-specific resolution and frame rate (optional - falls back to project settings if null)
  width: settings?.width || null,
  height: settings?.height || null,
  fps: settings?.fps || null,
  duration: 60,
  zoom: 100,
  tracks: [
    { id: 'video-1', name: 'Video 1', type: 'video', muted: false, locked: false, visible: true },
    { id: 'audio-1', name: 'Audio 1', type: 'audio', channels: 'stereo', muted: false, locked: false, visible: true },
  ],
  clips: [],
  transitions: [],
  clipCounter: 1,
  transitionCounter: 1,
  snappingEnabled: true,
  snappingThreshold: 10,
  rippleEditMode: false,
})

const MAX_PROJECT_HISTORY_SIZE = 25

const cloneProjectHistoryValue = (value) => JSON.parse(JSON.stringify(value))

const createTimelineStructureSnapshot = (state) => {
  if (!state?.currentProject) return null

  const liveTimelineData = useTimelineStore.getState().getProjectData()
  const timelines = (state.currentProject.timelines || []).map((timeline) => (
    timeline.id === state.currentTimelineId
      ? { ...timeline, ...liveTimelineData }
      : timeline
  ))

  return {
    timelines: cloneProjectHistoryValue(timelines),
    currentTimelineId: state.currentTimelineId,
  }
}

const areTimelineStructureSnapshotsEqual = (a, b) => {
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Helper to get display name from path or handle
 */
const getDisplayName = (handleOrPath) => {
  if (!handleOrPath) return null
  if (typeof handleOrPath === 'string') {
    // It's a path - get the last segment
    const parts = handleOrPath.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || handleOrPath
  }
  // It's a handle
  return handleOrPath.name
}

const normalizeOpenedProjectData = (projectData) => {
  const normalizedProject = { ...(projectData || {}) }

  if (normalizedProject.timeline && !normalizedProject.timelines) {
    const migratedTimeline = {
      ...normalizedProject.timeline,
      id: 'timeline-1',
      name: 'Timeline 1',
      created: normalizedProject.created,
      modified: normalizedProject.modified,
    }
    normalizedProject.timelines = [migratedTimeline]
    normalizedProject.currentTimelineId = migratedTimeline.id
    delete normalizedProject.timeline
  }

  if (!normalizedProject.timelines || normalizedProject.timelines.length === 0) {
    normalizedProject.timelines = [createDefaultTimeline('Timeline 1')]
    normalizedProject.currentTimelineId = normalizedProject.timelines[0].id
  }

  const currentTimelineId = normalizedProject.currentTimelineId || normalizedProject.timelines[0].id
  const currentTimeline = normalizedProject.timelines.find((timeline) => timeline.id === currentTimelineId) || normalizedProject.timelines[0]

  normalizedProject.flowAi = normalizeFlowAiProjectData(normalizedProject.flowAi)

  return {
    projectData: normalizedProject,
    currentTimelineId,
    currentTimeline,
  }
}

const hydrateOpenedProjectSession = async (projectHandleOrPath, rawProjectData, set) => {
  const { projectData, currentTimelineId, currentTimeline } = normalizeOpenedProjectData(rawProjectData)

  const timelineFps = currentTimeline?.fps || projectData?.settings?.fps || 24
  useTimelineStore.getState().loadFromProject(currentTimeline, projectData.assets, timelineFps)
  await useAssetsStore.getState().loadFromProject(
    projectData.assets,
    projectHandleOrPath,
    projectData.folders,
    projectData.folderCounter
  )

  // Do not eagerly load every saved video thumbnail sprite on project open.
  // Large projects can contain hundreds of videos; walking all thumbnail
  // metadata here blocks startup and can make Electron appear as a black
  // screen. Thumbnails are loaded/generated on demand from the asset browser
  // and timeline paths instead.

  const recentProject = {
    name: projectData.name,
    path: typeof projectHandleOrPath === 'string' ? projectHandleOrPath : null,
    modified: projectData.modified,
    created: projectData.created,
    settings: projectData.settings,
    thumbnail: projectData.thumbnail,
  }

  set((state) => ({
    currentProject: projectData,
    currentProjectHandle: projectHandleOrPath,
    currentTimelineId,
    projectHistory: [],
    projectFuture: [],
    projectHistoryLastChangedAt: 0,
    recentProjects: [recentProject, ...state.recentProjects.filter((p) => p.name !== projectData.name)].slice(0, 10),
    isLoading: false,
    error: null,
    lastFailedProjectHandle: null,
    lastFailedProjectName: null,
  }))

  return projectData
}

/**
 * Project Store
 * Manages project state, recent projects, and file system operations
 * Supports multiple timelines per project
 * 
 * In Electron mode: uses string paths
 * In Web mode: uses FileSystemDirectoryHandle objects
 */
export const useProjectStore = create(
  persist(
    (set, get) => ({
      // Current project state
      currentProject: null, // { name, settings, created, modified, timelines, currentTimelineId }
      currentProjectHandle: null, // FileSystemDirectoryHandle (web) or string path (Electron) - not persisted
      currentTimelineId: null, // ID of the currently active timeline
      projectHistory: [], // Timeline-structure snapshots for create/duplicate/rename/delete
      projectFuture: [],
      projectHistoryLastChangedAt: 0,
      
      // Default projects location
      defaultProjectsLocation: null, // Path string for display
      defaultProjectsHandle: null, // FileSystemDirectoryHandle (web) or string path (Electron) - not persisted
      
      // Recent projects list (persisted)
      recentProjects: [], // [{ name, path, modified, settings, thumbnail }]
      
      // New project defaults (persisted)
      defaultResolution: 'HD 1080p',
      defaultFps: 24,
      
      // UI state
      isFirstRun: true, // Whether this is first time opening the app
      isLoading: false,
      error: null,
      lastFailedProjectHandle: null,
      lastFailedProjectName: null,
      
      // Auto-save settings
      autoSaveEnabled: true,
      autoSaveInterval: 30000, // 30 seconds
      lastAutoSave: null,

      // Startup behavior (persisted)
      // When false (default), ComfyStudio lands on the project picker so
      // users can explicitly choose what to work on (Resolve-style hub).
      // Power users can flip this on to jump straight back into their
      // last project.
      reopenLastProjectOnStartup: false,

      // Welcome-screen cosmetics (persisted). Defaults to the cinematic
      // hero on; users on low-power machines or minimal aesthetic
      // preferences can flip this off from Settings → General.
      showHeroBackground: true,

      // Recent projects view mode on the welcome screen: 'grid' (thumbnail
      // cards) or 'list' (compact rows). Persisted so users stay in their
      // preferred view across launches. Default to list for a denser,
      // less intimidating first-run project picker.
      projectListViewMode: 'list',
      
      /**
       * Check if File System API is supported
       */
      checkBrowserSupport: () => {
        return isFileSystemSupported()
      },
      
      /**
       * Check if running in Electron
       */
      isElectronMode: () => {
        return isElectron()
      },
      
      /**
       * Initialize the store on app load
       * Attempts to restore directory handles/paths from storage
       */
      initialize: async () => {
        set({ isLoading: true, error: null })
        
        try {
          // Try to restore default projects location
          const storedDefault = await getStoredDirectoryHandle('defaultProjectsLocation')
          if (storedDefault) {
            const isValid = await verifyPermission(storedDefault)
            if (isValid) {
              set({ 
                defaultProjectsHandle: storedDefault,
                defaultProjectsLocation: getDisplayName(storedDefault),
                isFirstRun: false,
              })
            }
          }
          
          // Try to restore current project (only when the user has opted
          // in via Settings → General → "Reopen last project on startup").
          // By default ComfyStudio lands on the project picker instead.
          const shouldReopenLast = get().reopenLastProjectOnStartup === true
          const storedProject = shouldReopenLast
            ? await getStoredDirectoryHandle('currentProject')
            : null
          if (storedProject) {
            const isValid = await verifyPermission(storedProject)
            if (isValid) {
              const projectData = await loadProjectFromFile(storedProject)
              if (projectData) {
                await hydrateOpenedProjectSession(storedProject, projectData, set)
              }
            }
          }
          
          set({ isLoading: false })
        } catch (err) {
          console.error('Error initializing project store:', err)
          set({ isLoading: false, error: err.message })
        }
      },
      
      /**
       * Set the default projects location
       * @param {FileSystemDirectoryHandle|string} handleOrPath - The directory handle or path
       */
      setDefaultProjectsLocation: async (handleOrPath) => {
        if (!handleOrPath) return
        
        try {
          await storeDirectoryHandle('defaultProjectsLocation', handleOrPath)
          set({ 
            defaultProjectsHandle: handleOrPath,
            defaultProjectsLocation: getDisplayName(handleOrPath),
            isFirstRun: false,
          })
        } catch (err) {
          console.error('Error storing default projects location:', err)
          set({ error: err.message })
        }
      },
      
      /**
       * Prompt user to select default projects location
       */
      selectDefaultProjectsLocation: async () => {
        try {
          const handleOrPath = await requestDirectoryAccess('Select Projects Folder')
          if (handleOrPath) {
            await get().setDefaultProjectsLocation(handleOrPath)
            return true
          }
          return false
        } catch (err) {
          console.error('Error selecting projects location:', err)
          set({ error: err.message })
          return false
        }
      },
      
      /**
       * Create a new project
       * @param {object} options - Project options
       * @param {string} options.name - Project name
       * @param {number} options.width - Resolution width
       * @param {number} options.height - Resolution height
       * @param {number} options.fps - Frame rate
       */
      createProject: async ({ name, width, height, fps }) => {
        const state = get()
        
        if (!state.defaultProjectsHandle) {
          set({ error: 'No projects location set. Please select a projects folder first.' })
          return null
        }
        
        set({ isLoading: true, error: null })
        
        try {
          // Create project folder structure
          const projectHandleOrPath = await createProjectFolder(state.defaultProjectsHandle, name)
          
          // Create default timeline
          const defaultTimeline = createDefaultTimeline('Timeline 1')
          
          // Create project data with timelines array
          const projectData = {
            name,
            version: '1.1', // Updated version for multi-timeline support
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            settings: {
              width,
              height,
              fps,
              aspectRatio: `${width}:${height}`,
            },
            timelines: [defaultTimeline], // Array of timelines
            currentTimelineId: defaultTimeline.id,
            assets: [],
            flowAi: createDefaultFlowAiProjectData(),
            generateWorkspace: null,
          }
          
          // Save project file
          await saveProjectToFile(projectHandleOrPath, projectData)
          
          // Store handle/path for persistence
          await storeDirectoryHandle('currentProject', projectHandleOrPath)
          
          // Add to recent projects
          const recentProject = {
            name,
            path: typeof projectHandleOrPath === 'string' ? projectHandleOrPath : null, // Store path in Electron mode
            modified: projectData.modified,
            created: projectData.created,
            settings: projectData.settings,
            thumbnail: null,
          }
          
          // Load the first timeline into the timeline store
          useTimelineStore.getState().loadFromProject(defaultTimeline, projectData.assets, fps)
          await useAssetsStore.getState().loadFromProject(
            projectData.assets,
            projectHandleOrPath,
            projectData.folders,
            projectData.folderCounter
          )
          
          set((state) => ({
            currentProject: projectData,
            currentProjectHandle: projectHandleOrPath,
            currentTimelineId: defaultTimeline.id,
            projectHistory: [],
            projectFuture: [],
            projectHistoryLastChangedAt: 0,
            recentProjects: [recentProject, ...state.recentProjects.filter(p => p.name !== name)].slice(0, 10),
            isLoading: false,
          }))
          
          return projectData
        } catch (err) {
          console.error('Error creating project:', err)
          set({ isLoading: false, error: err.message })
          return null
        }
      },
      
      /**
       * Open an existing project
       * @param {FileSystemDirectoryHandle|string} projectHandleOrPath - The project directory handle or path
       */
      openProject: async (projectHandleOrPath) => {
        set({ isLoading: true, error: null, lastFailedProjectHandle: null, lastFailedProjectName: null })
        
        try {
          // Verify permission/existence
          const isValid = await verifyPermission(projectHandleOrPath)
          if (!isValid) {
            throw new Error('Permission denied or project folder not accessible')
          }
          
          // Load project data
          const projectData = await loadProjectFromFile(projectHandleOrPath)
          if (!projectData) {
            throw new Error('Invalid project file')
          }
          
          // Store handle/path for persistence
          await storeDirectoryHandle('currentProject', projectHandleOrPath)

          return await hydrateOpenedProjectSession(projectHandleOrPath, projectData, set)
        } catch (err) {
          console.error('Error opening project:', err)
          set({
            isLoading: false,
            error: err.message,
            lastFailedProjectHandle: projectHandleOrPath,
            lastFailedProjectName: getDisplayName(projectHandleOrPath),
          })
          return null
        }
      },
      
      /**
       * Open a project via file picker
       */
      openProjectFromPicker: async () => {
        try {
          const handleOrPath = await requestDirectoryAccess('Select Project Folder')
          if (handleOrPath) {
            return await get().openProject(handleOrPath)
          }
          return null
        } catch (err) {
          console.error('Error opening project from picker:', err)
          set({ error: err.message })
          return null
        }
      },

      /**
       * Open the latest autosave snapshot for the last project that failed to open.
       */
      openLatestAutosaveForFailedProject: async () => {
        const state = get()
        const failedProjectHandle = state.lastFailedProjectHandle

        if (!failedProjectHandle) {
          set({ error: 'No failed project is available for autosave recovery.' })
          return null
        }

        set({ isLoading: true, error: null })

        try {
          const isValid = await verifyPermission(failedProjectHandle)
          if (!isValid) {
            throw new Error('Permission denied or project folder not accessible')
          }

          const { projectData } = await loadLatestProjectAutosaveFromFile(failedProjectHandle)
          await storeDirectoryHandle('currentProject', failedProjectHandle)

          return await hydrateOpenedProjectSession(failedProjectHandle, projectData, set)
        } catch (err) {
          console.error('Error opening latest autosave:', err)
          set({
            isLoading: false,
            error: err.message,
          })
          return null
        }
      },
      
      /**
       * Save the current project
       * @param {object} updates - Partial project data to merge
       */
      saveProject: async (updates = {}) => {
        const state = get()
        
        if (!state.currentProjectHandle || !state.currentProject) {
          console.warn('No project to save')
          return false
        }
        
        try {
          // Gather current state from timeline and assets stores
          const currentTimelineData = useTimelineStore.getState().getProjectData()
          const assetsData = useAssetsStore.getState().getProjectData()
          
          // Update the current timeline in the timelines array
          const updatedTimelines = (state.currentProject.timelines || []).map(t => 
            t.id === state.currentTimelineId 
              ? { ...t, ...currentTimelineData, modified: new Date().toISOString() }
              : t
          )
          
          const assetsState = useAssetsStore.getState()

          // Capture a thumbnail from the current playhead before writing
          // the project JSON so the pointer lands in the same save. If
          // capture fails (empty timeline, playhead over a gap, etc.) we
          // keep whatever pointer we already had.
          let thumbnailPointer = state.currentProject?.thumbnail || null
          try {
            const nextThumb = await captureAndSaveProjectThumbnail(state.currentProjectHandle)
            if (nextThumb) thumbnailPointer = nextThumb
          } catch (_) {
            // Non-fatal; keep existing thumbnail pointer.
          }

          const updatedProject = {
            ...state.currentProject,
            ...updates,
            timelines: updatedTimelines,
            currentTimelineId: state.currentTimelineId,
            assets: assetsData,
            folders: assetsState.folders || [],
            folderCounter: assetsState.folderCounter ?? 1,
            thumbnail: thumbnailPointer,
            modified: new Date().toISOString(),
          }
          
          await saveProjectToFile(state.currentProjectHandle, updatedProject)
          
          set({
            currentProject: updatedProject,
            lastAutoSave: new Date().toISOString(),
          })
          
          // Update recent projects list
          set((state) => ({
            recentProjects: state.recentProjects.map(p => 
              p.name === updatedProject.name 
                ? { ...p, modified: updatedProject.modified, thumbnail: thumbnailPointer }
                : p
            ),
          }))
          
          return true
        } catch (err) {
          console.error('Error saving project:', err)
          set({ error: err.message })
          return false
        }
      },

      saveTimelineStructureToHistory: () => {
        const state = get()
        const snapshot = createTimelineStructureSnapshot(state)
        if (!snapshot) return false

        let changed = false
        set((currentState) => {
          const lastSnapshot = currentState.projectHistory[currentState.projectHistory.length - 1]
          if (lastSnapshot && areTimelineStructureSnapshotsEqual(lastSnapshot, snapshot)) {
            return {}
          }

          changed = true
          const nextHistory = [...currentState.projectHistory, snapshot].slice(-MAX_PROJECT_HISTORY_SIZE)
          return {
            projectHistory: nextHistory,
            projectFuture: [],
            projectHistoryLastChangedAt: Date.now(),
          }
        })

        return changed
      },

      undoTimelineStructureChange: () => {
        const state = get()
        if (!state.currentProject || state.projectHistory.length === 0) return false

        const currentSnapshot = createTimelineStructureSnapshot(state)
        const targetSnapshot = state.projectHistory[state.projectHistory.length - 1]
        const remainingHistory = state.projectHistory.slice(0, -1)
        const nextFuture = currentSnapshot
          && !areTimelineStructureSnapshotsEqual(state.projectFuture[state.projectFuture.length - 1], currentSnapshot)
          ? [...state.projectFuture, currentSnapshot]
          : [...state.projectFuture]

        const nextTimelineId = targetSnapshot.currentTimelineId
          || targetSnapshot.timelines?.[0]?.id
          || null
        const nextTimelines = cloneProjectHistoryValue(targetSnapshot.timelines || [])
        const nextTimeline = nextTimelines.find((timeline) => timeline.id === nextTimelineId) || nextTimelines[0] || null
        if (nextTimeline) {
          const timelineFps = nextTimeline?.fps || state.currentProject?.settings?.fps || 24
          useTimelineStore.getState().loadFromProject(nextTimeline, useAssetsStore.getState().getProjectData(), timelineFps)
        }

        set((currentState) => ({
          currentProject: currentState.currentProject ? {
            ...currentState.currentProject,
            timelines: nextTimelines,
            currentTimelineId: nextTimelineId,
          } : null,
          currentTimelineId: nextTimelineId,
          projectHistory: remainingHistory,
          projectFuture: nextFuture,
          projectHistoryLastChangedAt: Date.now(),
        }))

        return true
      },

      redoTimelineStructureChange: () => {
        const state = get()
        if (!state.currentProject || state.projectFuture.length === 0) return false

        const currentSnapshot = createTimelineStructureSnapshot(state)
        const targetSnapshot = state.projectFuture[state.projectFuture.length - 1]
        const remainingFuture = state.projectFuture.slice(0, -1)
        const nextHistory = currentSnapshot
          && !areTimelineStructureSnapshotsEqual(state.projectHistory[state.projectHistory.length - 1], currentSnapshot)
          ? [...state.projectHistory, currentSnapshot].slice(-MAX_PROJECT_HISTORY_SIZE)
          : [...state.projectHistory]

        const nextTimelineId = targetSnapshot.currentTimelineId
          || targetSnapshot.timelines?.[0]?.id
          || null
        const nextTimelines = cloneProjectHistoryValue(targetSnapshot.timelines || [])
        const nextTimeline = nextTimelines.find((timeline) => timeline.id === nextTimelineId) || nextTimelines[0] || null
        if (nextTimeline) {
          const timelineFps = nextTimeline?.fps || state.currentProject?.settings?.fps || 24
          useTimelineStore.getState().loadFromProject(nextTimeline, useAssetsStore.getState().getProjectData(), timelineFps)
        }

        set((currentState) => ({
          currentProject: currentState.currentProject ? {
            ...currentState.currentProject,
            timelines: nextTimelines,
            currentTimelineId: nextTimelineId,
          } : null,
          currentTimelineId: nextTimelineId,
          projectHistory: nextHistory,
          projectFuture: remainingFuture,
          projectHistoryLastChangedAt: Date.now(),
        }))

        return true
      },

      canUndoTimelineStructureChange: () => get().projectHistory.length > 0,
      canRedoTimelineStructureChange: () => get().projectFuture.length > 0,
      clearTimelineStructureHistory: () => set({
        projectHistory: [],
        projectFuture: [],
        projectHistoryLastChangedAt: 0,
      }),
      
      /**
       * Close the current project
       */
      closeProject: async () => {
        // Save before closing
        await get().saveProject()
        
        // Clear current project handle from storage
        await removeStoredDirectoryHandle('currentProject')
        
        // Clear timeline and assets stores
        useTimelineStore.getState().clearProject()
        useAssetsStore.getState().clearProject()
        
        set({
          currentProject: null,
          currentProjectHandle: null,
          currentTimelineId: null,
          projectHistory: [],
          projectFuture: [],
          projectHistoryLastChangedAt: 0,
        })
      },
      
      // ==========================================
      // TIMELINE MANAGEMENT (Multiple Timelines)
      // ==========================================
      
      /**
       * Get all timelines for the current project
       */
      getTimelines: () => {
        const state = get()
        return state.currentProject?.timelines || []
      },
      
      /**
       * Get the current timeline
       */
      getCurrentTimeline: () => {
        const state = get()
        if (!state.currentProject?.timelines) return null
        return state.currentProject.timelines.find(t => t.id === state.currentTimelineId) || null
      },
      
      /**
       * Get effective settings for the current timeline
       * Falls back to project settings if timeline-specific settings aren't set
       * @returns {object} - { width, height, fps, aspectRatio }
       */
      getCurrentTimelineSettings: () => {
        const state = get()
        if (!state.currentProject) return null
        
        const timeline = state.currentProject.timelines?.find(t => t.id === state.currentTimelineId)
        const projectSettings = state.currentProject.settings || {}
        
        const width = timeline?.width || projectSettings.width || 1920
        const height = timeline?.height || projectSettings.height || 1080
        const fps = timeline?.fps || projectSettings.fps || 24
        
        // Calculate aspect ratio
        const gcd = (a, b) => b === 0 ? a : gcd(b, a % b)
        const divisor = gcd(width, height)
        const aspectRatio = `${width / divisor}:${height / divisor}`
        
        return {
          width,
          height,
          fps,
          aspectRatio,
          isTimelineSpecific: !!(timeline?.width || timeline?.height || timeline?.fps),
        }
      },
      
      /**
       * Switch to a different timeline
       * @param {string} timelineId - ID of the timeline to switch to
       */
      switchTimeline: async (timelineId) => {
        const state = get()
        if (!state.currentProject?.timelines) return false
        
        // Find the target timeline
        const targetTimeline = state.currentProject.timelines.find(t => t.id === timelineId)
        if (!targetTimeline) return false
        
        // Save current timeline state first
        const currentTimelineData = useTimelineStore.getState().getProjectData()
        const updatedTimelines = state.currentProject.timelines.map(t => 
          t.id === state.currentTimelineId 
            ? { ...t, ...currentTimelineData, modified: new Date().toISOString() }
            : t
        )
        
        // Update project with saved timeline
        set((state) => ({
          currentProject: {
            ...state.currentProject,
            timelines: updatedTimelines,
          },
        }))
        
        // Load the target timeline into the timeline store
        const timelineFps = targetTimeline?.fps || state.currentProject?.settings?.fps || 24
        useTimelineStore.getState().loadFromProject(targetTimeline, state.currentProject?.assets || [], timelineFps)
        
        // Update current timeline ID
        set({ currentTimelineId: timelineId })
        
        return true
      },
      
      /**
       * Create a new timeline
       * @param {object|string} options - Timeline options or just name for backward compatibility
       * @param {string} options.name - Name for the new timeline
       * @param {number} options.width - Optional timeline-specific width
       * @param {number} options.height - Optional timeline-specific height
       * @param {number} options.fps - Optional timeline-specific frame rate
       */
      createTimeline: (options = null) => {
        const state = get()
        if (!state.currentProject) return null
        get().saveTimelineStructureToHistory()
        
        // Handle backward compatibility - if options is a string, treat as name
        const isLegacyCall = typeof options === 'string' || options === null
        const name = isLegacyCall ? options : options?.name
        const settings = isLegacyCall ? null : {
          width: options?.width || null,
          height: options?.height || null,
          fps: options?.fps || null,
          color: options?.color || null,
          folderId: options?.folderId || null,
        }
        
        const existingTimelines = state.currentProject.timelines || []
        const timelineNumber = existingTimelines.length + 1
        const timelineName = name || `Timeline ${timelineNumber}`
        
        const newTimeline = createDefaultTimeline(timelineName, null, settings)
        
        set((state) => ({
          currentProject: {
            ...state.currentProject,
            timelines: [...(state.currentProject.timelines || []), newTimeline],
          },
        }))
        
        return newTimeline
      },
      
      /**
       * Duplicate an existing timeline
       * @param {string} timelineId - ID of the timeline to duplicate
       */
      duplicateTimeline: (timelineId) => {
        const state = get()
        if (!state.currentProject?.timelines) return null
        get().saveTimelineStructureToHistory()
        
        // If duplicating current timeline, save its state first
        if (timelineId === state.currentTimelineId) {
          const currentTimelineData = useTimelineStore.getState().getProjectData()
          const updatedTimelines = state.currentProject.timelines.map(t => 
            t.id === state.currentTimelineId 
              ? { ...t, ...currentTimelineData, modified: new Date().toISOString() }
              : t
          )
          set((state) => ({
            currentProject: {
              ...state.currentProject,
              timelines: updatedTimelines,
            },
          }))
        }
        
        // Get fresh state
        const freshState = get()
        const sourceTimeline = freshState.currentProject.timelines.find(t => t.id === timelineId)
        if (!sourceTimeline) return null
        
        const newTimeline = {
          ...JSON.parse(JSON.stringify(sourceTimeline)), // Deep clone
          id: `timeline-${Date.now()}`,
          name: `${sourceTimeline.name} (Copy)`,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
        }
        
        set((state) => ({
          currentProject: {
            ...state.currentProject,
            timelines: [...state.currentProject.timelines, newTimeline],
          },
        }))
        
        return newTimeline
      },
      
      /**
       * Rename a timeline
       * @param {string} timelineId - ID of the timeline to rename
       * @param {string} newName - New name for the timeline
       */
      renameTimeline: (timelineId, newName) => {
        const state = get()
        if (!state.currentProject?.timelines || !newName.trim()) return false
        get().saveTimelineStructureToHistory()
        
        set((state) => ({
          currentProject: {
            ...state.currentProject,
            timelines: state.currentProject.timelines.map(t => 
              t.id === timelineId 
                ? { ...t, name: newName.trim(), modified: new Date().toISOString() }
                : t
            ),
          },
        }))
        
        return true
      },

      /**
       * Set a timeline color for project browser display
       * @param {string} timelineId - ID of the timeline to update
       * @param {string|null} color - Hex color or null
       */
      setTimelineColor: (timelineId, color) => {
        const state = get()
        if (!state.currentProject?.timelines) return false
        const existingTimeline = state.currentProject.timelines.find((timeline) => timeline.id === timelineId)
        if (!existingTimeline) return false
        if ((existingTimeline.color ?? null) === (color ?? null)) return true

        get().saveTimelineStructureToHistory()

        set((currentState) => ({
          currentProject: {
            ...currentState.currentProject,
            timelines: currentState.currentProject.timelines.map((timeline) =>
              timeline.id === timelineId
                ? { ...timeline, color: color ?? null, modified: new Date().toISOString() }
                : timeline
            ),
          },
        }))

        return true
      },

      /**
       * Move a timeline to a folder (or root when null)
       * @param {string} timelineId - ID of the timeline to move
       * @param {string|null} folderId - Destination folder ID (null = root)
       */
      moveTimelineToFolder: (timelineId, folderId = null) => {
        const state = get()
        if (!state.currentProject?.timelines) return false
        const normalizedFolderId = folderId || null
        const existingTimeline = state.currentProject.timelines.find((timeline) => timeline.id === timelineId)
        if (!existingTimeline) return false
        if ((existingTimeline.folderId || null) === normalizedFolderId) return true

        get().saveTimelineStructureToHistory()

        set((currentState) => ({
          currentProject: {
            ...currentState.currentProject,
            timelines: currentState.currentProject.timelines.map((timeline) =>
              timeline.id === timelineId
                ? { ...timeline, folderId: normalizedFolderId, modified: new Date().toISOString() }
                : timeline
            ),
          },
        }))

        return true
      },
      
      /**
       * Delete a timeline
       * @param {string} timelineId - ID of the timeline to delete
       */
      deleteTimeline: (timelineId) => {
        const state = get()
        if (!state.currentProject?.timelines) return false
        
        // Can't delete the last timeline
        if (state.currentProject.timelines.length <= 1) return false
        get().saveTimelineStructureToHistory()
        
        // If deleting the current timeline, switch to another first
        if (timelineId === state.currentTimelineId) {
          const remainingTimelines = state.currentProject.timelines.filter(t => t.id !== timelineId)
          const nextTimeline = remainingTimelines[0]
          
          // Load the next timeline
          const timelineFps = nextTimeline?.fps || state.currentProject?.settings?.fps || 24
          useTimelineStore.getState().loadFromProject(nextTimeline, state.currentProject?.assets || [], timelineFps)
          
          set((state) => ({
            currentProject: {
              ...state.currentProject,
              timelines: remainingTimelines,
            },
            currentTimelineId: nextTimeline.id,
          }))
        } else {
          set((state) => ({
            currentProject: {
              ...state.currentProject,
              timelines: state.currentProject.timelines.filter(t => t.id !== timelineId),
            },
          }))
        }
        
        return true
      },
      
      /**
       * Get list of recent projects (for display)
       * In Electron mode, can refresh from file system
       */
      getRecentProjectsList: async () => {
        const state = get()
        
        if (!state.defaultProjectsHandle) {
          return state.recentProjects
        }
        
        try {
          // Refresh list from file system
          const projects = await listProjects(state.defaultProjectsHandle)
          
          // Update recent projects with fresh data
          const updatedRecent = state.recentProjects.map(recent => {
            const fresh = projects.find(p => p.name === recent.name)
            if (fresh) {
              return {
                ...recent,
                ...fresh,
                // In Electron mode, use the path from fresh data
                path: fresh.path || recent.path,
              }
            }
            return recent
          })
          
          return updatedRecent.slice(0, 10)
        } catch (err) {
          console.error('Error getting recent projects:', err)
          return state.recentProjects
        }
      },
      
      /**
       * Remove a project from the recent list (does not delete the project from disk)
       * @param {object} project - Recent project object with name and optional path
       */
      removeRecentProject: (project) => {
        set((state) => ({
          recentProjects: state.recentProjects.filter(
            (p) => !(p.name === project.name && (p.path || '') === (project.path || ''))
          ),
        }))
      },

      /**
       * Open a recent project by name or path
       * @param {object} recentProject - Recent project object with name and optional path
       */
      openRecentProject: async (recentProject) => {
        const state = get()
        
        if (isElectron()) {
          // In Electron mode, use the path if available
          if (recentProject.path) {
            return await get().openProject(recentProject.path)
          }
          // Otherwise try to find it in the default projects location
          if (state.defaultProjectsHandle) {
            const projectPath = await window.electronAPI.pathJoin(state.defaultProjectsHandle, recentProject.name)
            return await get().openProject(projectPath)
          }
        } else {
          // In web mode, we need to get the handle from the projects list
          if (!state.defaultProjectsHandle) {
            set({ error: 'Projects location not set' })
            return null
          }
          
          // Find the project handle
          const projects = await listProjects(state.defaultProjectsHandle)
          const project = projects.find(p => p.name === recentProject.name)
          if (project?.handle) {
            return await get().openProject(project.handle)
          }
        }
        
        set({ error: `Could not find project: ${recentProject.name}` })
        return null
      },
      
      /**
       * Update project settings
       */
      updateProjectSettings: (settings) => {
        set((state) => ({
          currentProject: state.currentProject ? {
            ...state.currentProject,
            settings: { ...state.currentProject.settings, ...settings },
          } : null,
        }))
      },

      getFlowAiData: () => {
        const state = get()
        return normalizeFlowAiProjectData(state.currentProject?.flowAi)
      },

      setFlowAiData: (flowAi) => {
        if (!get().currentProject) return null
        const normalized = normalizeFlowAiProjectData(flowAi)
        set((state) => ({
          currentProject: state.currentProject ? {
            ...state.currentProject,
            flowAi: normalized,
            modified: new Date().toISOString(),
          } : null,
        }))
        return normalized
      },

      /**
       * Keep Generate/Create workspace state with the active project so
       * new projects start blank and existing projects can reopen their own
       * music-video/script/custom-workflow context.
       */
      setGenerateWorkspaceState: (generateWorkspace) => {
        set((state) => {
          if (!state.currentProject) return {}
          return {
            currentProject: {
              ...state.currentProject,
              generateWorkspace,
            },
          }
        })
      },
      
      /**
       * Clear error
       */
      clearError: () => {
        set({ error: null })
      },
      
      /**
       * Set auto-save enabled
       */
      setAutoSaveEnabled: (enabled) => {
        set({ autoSaveEnabled: enabled })
      },

      /**
       * Toggle whether ComfyStudio should reopen the last project on
       * startup (true) or show the project picker (false, default).
       */
      setReopenLastProjectOnStartup: (enabled) => {
        set({ reopenLastProjectOnStartup: Boolean(enabled) })
      },

      /**
       * Toggle the cinematic hero background on the project picker.
       */
      setShowHeroBackground: (enabled) => {
        set({ showHeroBackground: Boolean(enabled) })
      },

      /**
       * Switch the recent-projects view between grid and list. Any value
       * other than 'list' normalizes to 'grid' so a stale persisted value
       * can't break rendering.
       */
      setProjectListViewMode: (mode) => {
        set({ projectListViewMode: mode === 'list' ? 'list' : 'grid' })
      },

      /**
       * Set default project settings (for new projects)
       */
      setDefaultProjectSettings: (resolution, fps) => {
        set({ defaultResolution: resolution, defaultFps: fps })
      },
      
      /**
       * Get the current project handle/path for file operations
       */
      getProjectHandle: () => {
        return get().currentProjectHandle
      },
    }),
    {
      name: 'comfystudio-project', // localStorage key
      partialize: (state) => ({
        // Only persist these fields
        recentProjects: state.recentProjects,
        isFirstRun: state.isFirstRun,
        defaultProjectsLocation: state.defaultProjectsLocation,
        defaultResolution: state.defaultResolution,
        defaultFps: state.defaultFps,
        autoSaveEnabled: state.autoSaveEnabled,
        autoSaveInterval: state.autoSaveInterval,
        reopenLastProjectOnStartup: state.reopenLastProjectOnStartup,
        showHeroBackground: state.showHeroBackground,
        projectListViewMode: state.projectListViewMode,
        // Note: Handles/paths are stored separately (IndexedDB for web, settings for Electron)
      }),
    }
  )
)

export default useProjectStore
