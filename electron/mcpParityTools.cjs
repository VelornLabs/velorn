const groups = [require('./mcpEditingTools.cjs'), require('./mcpAudioTools.cjs'),
  require('./mcpExportTools.cjs'), require('./mcpReviewTools.cjs'), require('./mcpStoryboardTools.cjs'), require('./mcpProductionRunTools.cjs'),
  require('./mcpGenerationRunTools.cjs'), require('./mcpComfyRouterTools.cjs'), require('./mcpCaptionEngineTools.cjs')]
const writableTools = new Set(groups.flatMap(group => group.writableTools))
const tools = groups.flatMap(group => group.tools).map(tool => ({
  ...tool,
  inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
    ...(writableTools.has(tool.name) ? { expectedContext: {
      type: 'object', description: 'Opaque context returned by preview/inspection. Pass it unchanged to reject stale writes after project, timeline, session or authored document changes.',
      additionalProperties: true,
    } } : {}),
  } },
}))
if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Duplicate MCP parity tool definition.')
const names = new Set(tools.map(tool => tool.name))
function previewByDefault(name, args = {}) {
  if (!writableTools.has(name)) return undefined
  if (name === 'audio_ducking' && (args.operation || 'status') === 'status') return undefined
  if (name === 'clip_interpolation' && (args.operation || 'inspect') === 'inspect') return undefined
  return true
}
module.exports = { tools, names, writableTools, previewByDefault }
