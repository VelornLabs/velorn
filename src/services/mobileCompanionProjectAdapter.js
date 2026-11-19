import { createMobileProjectController } from './mobileCompanionProjects.mjs'
import { useProjectStore } from '../stores/projectStore'
import { useTimelineStore } from '../stores/timelineStore'
import { useAssetsStore } from '../stores/assetsStore'
import { listProjects } from './fileSystem'
import { isProjectDirty, TIMELINE_PROJECT_KEYS, ASSETS_PROJECT_KEYS } from './projectDirtyTracker'

// Compare authored state by identity around async saving. Playback/selection
// do not count. Saving's own timestamp/thumbnail updates do not count either.
let revision = 0
for (const [store, keys] of [[useTimelineStore, TIMELINE_PROJECT_KEYS], [useAssetsStore, ASSETS_PROJECT_KEYS]]) {
  store.subscribe((next, previous) => { if (keys.some(key => next[key] !== previous[key])) revision++ })
}
useProjectStore.subscribe((next, previous) => {
  const ignored = new Set(['modified', 'thumbnail', 'timelines', 'assets', 'folders', 'folderCounter', 'currentTimelineId'])
  const a = next.currentProject || {}, b = previous.currentProject || {}
  if (next.currentProjectHandle !== previous.currentProjectHandle || next.currentTimelineId !== previous.currentTimelineId
    || next.storyboardRevision !== previous.storyboardRevision
    || [...new Set([...Object.keys(a), ...Object.keys(b)])].some(key => !ignored.has(key) && a[key] !== b[key])) revision++
})
export const mobileProjects = createMobileProjectController({ getState: useProjectStore.getState, listProjects,
  isDirty: isProjectDirty, editIdentity: () => revision, uuid: () => crypto.randomUUID() })
