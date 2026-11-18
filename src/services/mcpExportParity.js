import useProjectStore from '../stores/projectStore'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import { captureMcpContext, assertMcpContext } from './mcpContext'
import { createMcpExportController } from './mcpExportController.mjs'
import { beginLocalExportActivity } from '../stores/exportActivityStore'

export const MCP_EXPORT_ACTIONS = createMcpExportController({
  getProject: () => useProjectStore.getState(),
  getTimeline: () => useTimelineStore.getState(),
  getAssets: () => useAssetsStore.getState(),
  getApi: () => globalThis.window?.electronAPI,
  captureContext: captureMcpContext,
  assertContext: assertMcpContext,
  beginBatchActivity: beginLocalExportActivity,
  notifyPresets: () => globalThis.window?.dispatchEvent(new Event('velorn-custom-export-presets-changed')),
})

export const cancelMcpExportBatchFromUi = activeJob => MCP_EXPORT_ACTIONS.cancelBatchFromUi(activeJob)
