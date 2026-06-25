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
