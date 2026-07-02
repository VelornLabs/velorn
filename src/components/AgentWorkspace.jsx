import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  Check,
  Copy,
  Database,
  Loader2,
  Power,
  PowerOff,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Wand2,
} from 'lucide-react'
import lmstudio from '../services/lmstudio'
import { getAgentToolInstructions, runAgentTool } from '../services/agentTools'

const ACCEPTED_STORAGE_KEY = 'velorn-agent-disclaimer-accepted'
const CHAT_STORAGE_KEY = 'velorn-agent-chat-history'
const MODEL_STORAGE_KEY = 'velorn-agent-selected-model'
const ENDPOINT_STORAGE_KEY = 'velorn-agent-endpoint'
const DEFAULT_ENDPOINT = 'http://localhost:1234'

const BASE_AGENT_PROMPT = `You are Velorn Agent, an AI assistant built into Velorn.

You help the user inspect and operate the open Velorn project using the Velorn tools available to you.

Speak like a friendly creative assistant, not like a developer console. Default to short answers: 1-3 sentences unless the user asks for details. Put the direct answer first. When the user asks a question that needs project context, use read tools first. When the user asks you to modify the project, prefer previewOnly true first unless the user clearly asks you to apply the change. If a tool changes the project, tell the user exactly what changed and what to verify.

Never reveal chain-of-thought, hidden reasoning, analysis channels, XML-like channel tags, or developer notes. Do not write <channel>thought, <channel>analysis, <think>, or similar text. Never show raw JSON unless the user asks for it. Never claim you inspected visuals unless you used inspect_timeline_frame or inspect_timeline_range. Never claim you changed the timeline unless a tool result confirms it.`

function makeMessage(role, content, extra = {}) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  }
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeModelName(model) {
  if (!model) return ''
  return model.id || model.model || model.name || model.path || ''
}

function normalizeModelState(model) {
  if (!model) return ''
  return model.state || model.status || ''
}

function sanitizeToolResult(value) {
  const seen = new WeakSet()
  return JSON.parse(JSON.stringify(value, (key, rawValue) => {
    const lowerKey = String(key || '').toLowerCase()
    if (
      lowerKey.includes('base64') ||
      lowerKey.includes('dataurl') ||
      lowerKey.includes('imagedata') ||
      lowerKey === 'data'
    ) {
      if (typeof rawValue === 'string' && rawValue.length > 500) {
        return `[${rawValue.length} chars omitted]`
      }
    }
    if (typeof rawValue === 'string' && rawValue.length > 8000) {
      return `${rawValue.slice(0, 8000)}... [truncated]`
    }
    if (rawValue && typeof rawValue === 'object') {
      if (seen.has(rawValue)) return '[circular]'
      seen.add(rawValue)
    }
    return rawValue
  }))
}

function formatToolResultForChat(toolName, result, summary = '') {
  const sanitized = sanitizeToolResult(result)
  return [
    `Velorn tool result for ${toolName}:`,
    summary ? `Summary: ${summary}` : '',
    `Technical result JSON:\n${JSON.stringify(sanitized, null, 2)}`,
  ].filter(Boolean).join('\n')
}

function parseAgentToolCalls(text) {
  const calls = []
  const blockPattern = /```(?:velorn-tool|velorn_tool)\s*([\s\S]*?)```/gi
  let match
  while ((match = blockPattern.exec(text || '')) !== null) {
    const body = match[1].trim()
    const parsed = safeJsonParse(body)
    const items = Array.isArray(parsed) ? parsed : [parsed]
    items.filter(Boolean).forEach((item) => {
      const tool = item.tool || item.name
      if (!tool) return
      calls.push({
        tool,
        arguments: item.arguments || item.args || {},
      })
    })
  }
  return calls
}

function cleanAssistantText(text) {
  let cleaned = String(text || '')
  cleaned = cleaned.replace(/```(?:velorn-tool|velorn_tool)\s*[\s\S]*?```/gi, '')
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '')
  cleaned = cleaned.replace(/<\|(?:analysis|thought|reasoning)\|>[\s\S]*?(?=<\|(?:final|answer|assistant)\|>|$)/gi, '')
  cleaned = cleaned.replace(/<\|(?:final|answer|assistant)\|>/gi, '')
  cleaned = cleaned.replace(/<\|channel\>\s*(?:thought|analysis|reasoning)[\s\S]*?(?=<\|channel\>\s*(?:final|answer|assistant)|$)/gi, '')
  cleaned = cleaned.replace(/<\|channel\>\s*(?:final|answer|assistant)\s*/gi, '')
  cleaned = cleaned.replace(/<\|?\/?channel\|?>/gi, '')
  cleaned = cleaned.replace(/<channel>\s*(?:thought|analysis|reasoning)[\s\S]*?(?=<channel>\s*(?:final|answer|assistant)|$)/gi, '')
  cleaned = cleaned.replace(/<channel>\s*(?:final|answer|assistant)\s*/gi, '')
  cleaned = cleaned.replace(/<\/?channel[^>]*>/gi, '')
  cleaned = cleaned.replace(/Velorn tool result for [\s\S]*$/gi, '')
  cleaned = cleaned.replace(/^\s*(?:tool call|tool use)\s*:?.*$/gim, '')
  cleaned = cleaned.replace(/^\s*\d+\.\s*\*\*Tool Call\*\*[\s\S]*$/gim, '')
  cleaned = cleaned.replace(/^\s*["']?velorn-tool["']?\s*$/gim, '')
  cleaned = cleaned.replace(/^\s*["']?tool["']?\s*:\s*["'][^"']+["'].*$/gim, '')
  cleaned = cleaned.replace(/^\s*["']?arguments["']?\s*:\s*\{.*$/gim, '')
  cleaned = cleaned.replace(/^\s*(?:I should|I need to|The user is asking|The user asked|I have the result|The summary states|I will state|We need to).*$/gim, '')
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')
  return cleaned.trim()
}

function summarizeToolResult(toolName, result) {
  if (!result || typeof result !== 'object') return `Ran ${toolName}.`
  if (toolName === 'analyze_timeline' && result.counts) {
    const total = result.counts.clips ?? 0
    const active = result.counts.activeClips ?? Math.max(0, total - (result.counts.disabledClips || 0))
    const disabled = result.counts.disabledClips ?? 0
    return `There are ${active} active clips on the active timeline (${total} total, ${disabled} disabled).`
  }
  if (toolName === 'get_timeline' && result.timeline) {
    const timeline = result.timeline
    const total = timeline.clipCount ?? timeline.clips?.length ?? 0
    const active = timeline.activeClipCount ?? total
    return `The active timeline "${timeline.name || 'Untitled'}" has ${active} active clips (${total} total).`
  }
  if (toolName === 'find_timeline_items') {
    return `Found ${result.count ?? result.items?.length ?? 0} matching item(s).`
  }
  if (toolName === 'get_project' && result.project) {
    return `Project loaded: ${result.project.name || 'Untitled'}${result.currentTimeline ? `, active timeline ${result.currentTimeline.name}` : ''}.`
  }
  if (result.previewOnly) return `Preview ready for ${toolName}; nothing was applied yet.`
  if (result.created || result.updated || result.success) return `${toolName} completed.`
  return `Ran ${toolName}.`
}

function shouldUseToolSummary(response) {
  const text = String(response || '').trim()
  if (!text) return true
  if (text.length > 900) return true
  if (/```|<channel>|<think>|Velorn tool result|Technical result JSON/i.test(text)) return true
  if (/"tool"\s*:|\"arguments\"\s*:|^\s*\{[\s\S]*\}\s*$/m.test(text)) return true
  return false
}

function toLlmMessages(messages, extraSystem = '') {
  const systemContent = [
    BASE_AGENT_PROMPT,
    getAgentToolInstructions(),
    extraSystem,
  ].filter(Boolean).join('\n\n')

  const history = messages.slice(-24).map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: message.content,
      }
    }
    return {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    }
  })

  return [
    { role: 'system', content: systemContent },
    ...history,
  ]
}

function ToolBadge({ mode }) {
  const isWrite = mode === 'write'
  return (
    <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] ${
      isWrite
        ? 'bg-amber-500/15 text-amber-200 border border-amber-400/25'
        : 'bg-cyan-400/10 text-cyan-200 border border-cyan-300/20'
    }`}>
      {mode}
    </span>
  )
}

function AgentWorkspace() {
  const [hasAccepted, setHasAccepted] = useState(() => {
    try {
      return localStorage.getItem(ACCEPTED_STORAGE_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [acceptChecked, setAcceptChecked] = useState(false)
  const [endpoint, setEndpoint] = useState(() => {
    try {
      return localStorage.getItem(ENDPOINT_STORAGE_KEY) || DEFAULT_ENDPOINT
    } catch {
      return DEFAULT_ENDPOINT
    }
  })
  const [isConnected, setIsConnected] = useState(false)
  const [isCheckingConnection, setIsCheckingConnection] = useState(false)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [models, setModels] = useState([])
  const [selectedModelId, setSelectedModelId] = useState(() => {
    try {
      return localStorage.getItem(MODEL_STORAGE_KEY) || ''
    } catch {
      return ''
    }
  })
  const [loadedModelId, setLoadedModelId] = useState('')
  const [isLoadingModel, setIsLoadingModel] = useState(false)
  const [isUnloadingModel, setIsUnloadingModel] = useState(false)
  const [messages, setMessages] = useState(() => {
    try {
      return safeJsonParse(localStorage.getItem(CHAT_STORAGE_KEY), []) || []
    } catch {
      return []
    }
  })
  const [inputMessage, setInputMessage] = useState('')
  const [currentResponse, setCurrentResponse] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [copiedId, setCopiedId] = useState('')
  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  const activeModelId = loadedModelId || selectedModelId
  const canSend = hasAccepted && isConnected && activeModelId && inputMessage.trim() && !isGenerating

  useEffect(() => {
    lmstudio.setBaseUrl(endpoint)
    try {
      localStorage.setItem(ENDPOINT_STORAGE_KEY, endpoint)
    } catch {
      // ignore localStorage write failures
    }
  }, [endpoint])

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages))
    } catch {
      // ignore localStorage write failures
    }
  }, [messages])

  useEffect(() => {
    if (!selectedModelId) return
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, selectedModelId)
    } catch {
      // ignore localStorage write failures
    }
  }, [selectedModelId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, currentResponse])

  const loadModels = useCallback(async () => {
    setIsLoadingModels(true)
    try {
      const modelList = await lmstudio.listModels()
      setModels(modelList)
      const loaded = modelList.find((model) => normalizeModelState(model) === 'loaded')
      if (loaded) setLoadedModelId(normalizeModelName(loaded))
      setSelectedModelId((current) => {
        if (current && modelList.some((model) => normalizeModelName(model) === current)) return current
        if (loaded) return normalizeModelName(loaded)
        return normalizeModelName(modelList[0]) || ''
      })
    } catch (error) {
      console.warn('[Agent] Failed to load local models:', error)
      setModels([])
    } finally {
      setIsLoadingModels(false)
    }
  }, [])

  const checkConnection = useCallback(async () => {
    setIsCheckingConnection(true)
    lmstudio.setBaseUrl(endpoint)
    try {
      const connected = await lmstudio.checkConnection()
      setIsConnected(connected)
      if (connected) {
        await loadModels()
      }
    } catch (error) {
      console.warn('[Agent] Connection check failed:', error)
      setIsConnected(false)
    } finally {
      setIsCheckingConnection(false)
    }
  }, [endpoint, loadModels])

  useEffect(() => {
    checkConnection()
  }, [checkConnection])

  const handleAccept = () => {
    if (!acceptChecked) return
    try {
      localStorage.setItem(ACCEPTED_STORAGE_KEY, 'true')
    } catch {
      // ignore localStorage write failures
    }
    setHasAccepted(true)
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const handleLoadModel = async () => {
    if (!selectedModelId) return
    setIsLoadingModel(true)
    try {
      await lmstudio.loadModel(selectedModelId, {
        context_length: 8192,
        flash_attention: true,
      })
      setLoadedModelId(selectedModelId)
      await loadModels()
    } catch (error) {
      window.alert?.(`Failed to load model: ${error.message}`)
    } finally {
      setIsLoadingModel(false)
    }
  }

  const handleUnloadModel = async () => {
    if (!loadedModelId) return
    setIsUnloadingModel(true)
    try {
      await lmstudio.unloadModel(loadedModelId)
      setLoadedModelId('')
      await loadModels()
    } catch (error) {
      window.alert?.(`Failed to unload model: ${error.message}`)
    } finally {
      setIsUnloadingModel(false)
    }
  }

  const copyMessage = async (message) => {
    try {
      await navigator.clipboard?.writeText(message.content || '')
      setCopiedId(message.id)
      setTimeout(() => setCopiedId(''), 1200)
    } catch {
      // ignore clipboard failure
    }
  }

  const executeToolCalls = async (toolCalls, baseMessages) => {
    let nextMessages = [...baseMessages]
    const resultMessages = []

    for (const call of toolCalls) {
      const toolName = call.tool
      const args = call.arguments || {}
      try {
        const result = await runAgentTool(toolName, args)
        const summary = summarizeToolResult(toolName, result)
        const content = formatToolResultForChat(toolName, result, summary)
        const toolMessage = makeMessage('tool', content, {
          toolName,
          status: 'success',
          summary,
        })
        resultMessages.push(toolMessage)
      } catch (error) {
        resultMessages.push(makeMessage('tool', `Velorn tool error for ${toolName}:\n${error.message || String(error)}`, {
          toolName,
          status: 'error',
          summary: `${toolName} failed.`,
        }))
      }
    }

    nextMessages = [...nextMessages, ...resultMessages]
    setMessages(nextMessages)

    return { nextMessages, resultMessages }
  }

  const streamAssistantMessage = async (history, extraSystem = '', options = {}) => {
    let fullResponse = ''
    setCurrentResponse('')
    await lmstudio.streamChatCompletion(
      activeModelId,
      toLlmMessages(history, extraSystem),
      (chunk) => {
        fullResponse += chunk
        setCurrentResponse(cleanAssistantText(fullResponse))
      },
      {
        temperature: options.temperature ?? 0.2,
        max_tokens: options.max_tokens ?? 900,
      }
    )
    setCurrentResponse('')
    return fullResponse.trim()
  }

  const runConversation = async (startingMessages) => {
    const response = await streamAssistantMessage(startingMessages)
    const visibleResponse = cleanAssistantText(response)
    const toolCalls = parseAgentToolCalls(response)
    let nextMessages = visibleResponse
      ? [...startingMessages, makeMessage('assistant', visibleResponse)]
      : [...startingMessages]
    setMessages(nextMessages)

    if (toolCalls.length === 0) {
      if (!visibleResponse) {
        setMessages([
          ...startingMessages,
          makeMessage('assistant', 'I got a reasoning-only response from the local model. Try asking again, or use a larger instruction model for cleaner answers.'),
        ])
      }
      return
    }

    const toolResult = await executeToolCalls(toolCalls, nextMessages)
    nextMessages = toolResult.nextMessages

    const summaryPrompt = `Do not call any tools in this response. Do not reveal chain-of-thought or mention JSON/tool blocks. Summarize the Velorn tool results in plain English in 1-2 sentences. Put the answer first. If the user asked a simple count, answer the count first. If a tool was previewOnly, say that nothing was applied yet and what the user should approve next.`
    const summary = cleanAssistantText(await streamAssistantMessage(nextMessages, summaryPrompt, {
      temperature: 0.1,
      max_tokens: 350,
    }))
    const fallbackSummary = toolResult.resultMessages
      .map((message) => message.summary)
      .filter(Boolean)
      .join('\n')
    setMessages([...nextMessages, makeMessage('assistant', shouldUseToolSummary(summary) ? (fallbackSummary || 'Done.') : summary)])
  }

  const handleSendMessage = async () => {
    const userText = inputMessage.trim()
    if (!canSend || !userText) return
    setInputMessage('')
    const nextMessages = [...messages, makeMessage('user', userText)]
    setMessages(nextMessages)
    setIsGenerating(true)
    try {
      await runConversation(nextMessages)
    } catch (error) {
      setCurrentResponse('')
      setMessages((current) => [
        ...current,
        makeMessage('assistant', `I hit an Agent error: ${error.message || String(error)}\n\nMake sure your local model server is running at ${endpoint}, then try again.`),
      ])
    } finally {
      setIsGenerating(false)
    }
  }

  const clearChat = () => {
    setMessages([])
    setCurrentResponse('')
  }

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSendMessage()
    }
  }

  const renderMessageContent = (message) => {
    if (message.role === 'tool') {
      return (
        <div className="space-y-2">
          <div className="text-sm text-sf-text-secondary">
            {message.summary || `Ran ${message.toolName || 'tool'}.`}
          </div>
          <details className="rounded border border-sf-dark-600 bg-black/20">
            <summary className="cursor-pointer px-3 py-2 text-[11px] text-sf-text-muted hover:text-sf-text-primary">
              Show technical details
            </summary>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-sf-dark-600 p-3 text-[11px] leading-relaxed text-sf-text-secondary">
              {message.content}
            </pre>
          </details>
        </div>
      )
    }
    return (
      <div className="whitespace-pre-wrap leading-relaxed">
        {cleanAssistantText(message.content)}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-1 bg-sf-dark-950 text-sf-text-primary">
      <aside className="flex w-[320px] flex-shrink-0 flex-col border-r border-sf-dark-700 bg-sf-dark-900/95">
        <div className="border-b border-sf-dark-700 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-sf-accent/40 bg-sf-accent/15 text-sf-accent">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">Agent</h1>
              <p className="text-xs text-sf-text-muted">Local AI control for the open Velorn project.</p>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          <section className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/65 p-3">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-sf-accent" />
                <h2 className="text-sm font-semibold">Local model</h2>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                isConnected ? 'bg-emerald-500/15 text-emerald-200' : 'bg-red-500/15 text-red-200'
              }`}>
                {isConnected ? 'Connected' : 'Offline'}
              </span>
            </div>

            <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-sf-text-muted">
              OpenAI-compatible endpoint
            </label>
            <div className="mb-3 flex gap-2">
              <input
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
                className="min-w-0 flex-1 rounded border border-sf-dark-600 bg-sf-dark-950 px-2 py-1.5 text-xs outline-none focus:border-sf-accent"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={checkConnection}
                disabled={isCheckingConnection}
                className="inline-flex items-center gap-1 rounded border border-sf-dark-600 px-2 py-1.5 text-xs text-sf-text-secondary hover:border-sf-accent hover:text-sf-text-primary disabled:opacity-50"
              >
                {isCheckingConnection ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Check
              </button>
            </div>

            <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-sf-text-muted">
              Model
            </label>
            <select
              value={selectedModelId}
              onChange={(event) => setSelectedModelId(event.target.value)}
              disabled={!isConnected || isLoadingModels}
              className="mb-3 w-full rounded border border-sf-dark-600 bg-sf-dark-950 px-2 py-1.5 text-xs outline-none focus:border-sf-accent disabled:opacity-50"
            >
              {!models.length && <option value="">No models found</option>}
              {models.map((model) => {
                const id = normalizeModelName(model)
                const state = normalizeModelState(model)
                return (
                  <option key={id} value={id}>
                    {id}{state ? ` (${state})` : ''}
                  </option>
                )
              })}
            </select>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleLoadModel}
                disabled={!selectedModelId || isLoadingModel}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded bg-sf-accent px-2 py-1.5 text-xs font-medium text-white hover:bg-sf-accent/90 disabled:opacity-50"
              >
                {isLoadingModel ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                Load
              </button>
              <button
                type="button"
                onClick={handleUnloadModel}
                disabled={!loadedModelId || isUnloadingModel}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded border border-sf-dark-600 px-2 py-1.5 text-xs text-sf-text-secondary hover:border-sf-accent hover:text-sf-text-primary disabled:opacity-50"
              >
                {isUnloadingModel ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PowerOff className="h-3.5 w-3.5" />}
                Unload
              </button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-sf-text-muted">
              LM Studio works at the default endpoint. Ollama can work through its OpenAI-compatible server when pointed here.
            </p>
          </section>
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col bg-[radial-gradient(circle_at_top,rgba(117,92,255,0.12),transparent_40%),#05070d]">
        <div className="flex items-center justify-between border-b border-sf-dark-700 bg-black/25 px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold">Velorn Agent</h2>
            <p className="text-xs text-sf-text-muted">
              Ask a local model to inspect, plan, preview, and operate the current project through Velorn tools.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={clearChat}
              className="inline-flex items-center gap-1 rounded border border-sf-dark-600 px-2 py-1.5 text-xs text-sf-text-secondary hover:border-red-400/50 hover:text-red-200"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
            <div className="rounded-full border border-sf-dark-600 px-2 py-1 text-[11px] text-sf-text-muted">
              {activeModelId || 'No model selected'}
            </div>
          </div>
        </div>

        {!hasAccepted && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="w-full max-w-2xl rounded-xl border border-amber-300/25 bg-sf-dark-900 p-6 shadow-2xl">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-amber-300/30 bg-amber-400/10 text-amber-200">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">Enable Agent Mode</h3>
                  <p className="text-sm text-sf-text-muted">This gives a local AI model tool access to the open Velorn project.</p>
                </div>
              </div>
              <div className="space-y-3 text-sm leading-relaxed text-sf-text-secondary">
                <p>
                  Agent Mode can inspect and modify your project when you ask it to. It can create clips, add tracks,
                  label clips, add markers, change keyframes, queue generations, and start exports through Velorn tools.
                </p>
                <p>
                  It does not expose generic shell, operating-system, or arbitrary file tools from Velorn. Still, for important
                  work, duplicate the project first and ask the agent to preview or explain changes before applying them.
                </p>
              </div>
              <label className="mt-5 flex items-start gap-3 rounded-lg border border-sf-dark-600 bg-black/25 p-3 text-sm text-sf-text-secondary">
                <input
                  type="checkbox"
                  checked={acceptChecked}
                  onChange={(event) => setAcceptChecked(event.target.checked)}
                  className="mt-0.5"
                />
                <span>I understand Agent actions can change my open project, and I should preview or back up important work.</span>
              </label>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleAccept}
                  disabled={!acceptChecked}
                  className="inline-flex items-center gap-2 rounded bg-sf-accent px-4 py-2 text-sm font-semibold text-white hover:bg-sf-accent/90 disabled:opacity-50"
                >
                  <ShieldCheck className="h-4 w-4" />
                  Enable Agent
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          {messages.length === 0 && !currentResponse ? (
            <div className="mx-auto mt-14 max-w-2xl text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-sf-accent/30 bg-sf-accent/10 text-sf-accent">
                <Wand2 className="h-7 w-7" />
              </div>
              <h3 className="mb-2 text-xl font-semibold">Talk to your edit.</h3>
              <p className="text-sm leading-relaxed text-sf-text-muted">
                Start with a question, a review pass, or a preview-only edit. The model will call Velorn tools when it needs project context or editor control.
              </p>
            </div>
          ) : (
            <div className="mx-auto max-w-6xl space-y-4">
              {messages
                .filter((message) => message.role !== 'assistant' || cleanAssistantText(message.content))
                .map((message) => (
                <div
                  key={message.id}
                  className={`group rounded-xl border p-4 ${
                    message.role === 'user'
                      ? 'ml-16 border-sf-accent/25 bg-sf-accent/10'
                      : message.role === 'tool'
                        ? 'border-sf-dark-600 bg-black/20'
                        : 'mr-16 border-sf-dark-700 bg-sf-dark-900/75'
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-sf-text-muted">
                        {message.role === 'tool' ? (message.toolName || 'tool') : message.role}
                      </span>
                      {message.role === 'tool' && (
                        <ToolBadge mode={message.status === 'error' ? 'write' : 'read'} />
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => copyMessage(message)}
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                      title="Copy"
                    >
                      {copiedId === message.id ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5 text-sf-text-muted" />}
                    </button>
                  </div>
                  <div className="text-sm text-sf-text-primary">
                    {renderMessageContent(message)}
                  </div>
                </div>
              ))}
              {currentResponse && (
                <div className="mr-16 rounded-xl border border-sf-dark-700 bg-sf-dark-900/75 p-4">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-sf-text-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    assistant
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed text-sf-text-primary">
                    {currentResponse}
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="border-t border-sf-dark-700 bg-sf-dark-950/95 p-4">
          <div className="mx-auto flex max-w-6xl items-end gap-3">
            <textarea
              ref={inputRef}
              value={inputMessage}
              onChange={(event) => setInputMessage(event.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!hasAccepted || !isConnected || !activeModelId || isGenerating}
              placeholder={
                !hasAccepted
                  ? 'Enable Agent Mode first'
                  : !isConnected
                    ? 'Connect LM Studio or a local OpenAI-compatible server'
                    : !activeModelId
                      ? 'Select a local model'
                      : 'Ask the agent to inspect, preview, edit, or export...'
              }
              rows={2}
              className="max-h-40 min-h-[52px] flex-1 resize-none rounded-lg border border-sf-dark-600 bg-sf-dark-900 px-3 py-2 text-sm outline-none focus:border-sf-accent disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleSendMessage}
              disabled={!canSend}
              className="inline-flex h-[52px] w-[52px] items-center justify-center rounded-lg bg-sf-accent text-white hover:bg-sf-accent/90 disabled:opacity-50"
              title="Send"
            >
              {isGenerating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}

export default AgentWorkspace
