import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { MessageSquare, X, Send, Square, Settings, Eye, ArrowLeft, ArrowUpRight, Plus, MoreHorizontal, Trash2, Loader2, Clock, Paperclip, FileJson, Check } from 'lucide-react'
import useProjectStore from '../stores/projectStore'
import useTimelineStore from '../stores/timelineStore'
import useAssetsStore from '../stores/assetsStore'
import useExportActivityStore, { isExportBusy } from '../stores/exportActivityStore'
import { getStoryboardProjectKey } from '../utils/storyboardWorkspace.mjs'
import { captureMcpContext } from '../services/mcpContext'
import {
  buildConnectedAgentContext, formatConnectedAgentResponse,
  selectConnectedAgentImageCandidates, containsLocalComfyAddress,
  sanitizeConnectedAgentMessages, sanitizeConnectedAgentRequestedModel, redactConnectedAgentText, collectConnectedAgentSourceUrls,
} from '../utils/connectedAgentContext.mjs'
import { createConnectedAgentConversationStore, getConnectedAgentChatSelection } from '../utils/connectedAgentConversations.mjs'
import { CONNECTED_AGENT_PROVIDERS, FUNDED_LUNA_REASONING, FUNDED_LUNA_DISCLOSURE, VELO_DESCRIPTION, fundedLunaModels, connectedAgentProviderLabel, connectedAgentModelSelection, fundedLunaAvailability } from '../utils/connectedAgentProviders.mjs'
import { readAccessSetup, accessSetupPreferences, activeAccessMode, veloComputerAccessSupported } from '../utils/connectedAgentAccess.mjs'
import { readChatAttachment, checkAttachmentBatch } from '../utils/connectedAgentAttachments.mjs'
import { AgentMessageContent } from './AgentMessageContent'
import { AgentReviewGallery, AgentRecoveredReviewGallery, reviewThumbnail, useAgentReviewMedia } from './AgentReviewGallery'
import { AgentPlayableMedia, useAgentPlayableMedia } from './AgentPlayableMedia'
import { AgentSetupDownloads, useAgentSetupDownloads } from './AgentSetupDownloads'
import { AgentLmStudioSetup, useAgentLmStudioSetup } from './AgentLmStudioSetup'
import { isAgentCommand } from '../utils/connectedAgentPresentation.mjs'
import { connectedAgentDurationMs, updateConnectedAgentTiming, formatConnectedAgentDuration } from '../utils/connectedAgentTiming.mjs'
import { THINKING_LABELS, validThinkingLevel, thinkingOptions, selectedThinkingLevel } from '../utils/connectedAgentReasoning.mjs'
import { localModelSupportPresentation, localModelOptionLabel } from '../utils/agentModelSupportPresentation.mjs'
import { createAgentEntryGuide } from '../utils/agentEntryGuide.mjs'
import { sanitizeAgentToolReceipts, sanitizeAgentLocalDiagnostics, receiptOutcomeLabel, missingAgentReplyText, agentStatusMessage } from '../utils/connectedAgentReceipts.mjs'
import { selectedTextWithin } from '../utils/textClipboard.mjs'
import { appendWorkflowAgentReference } from '../utils/workflowAgentReference.mjs'
import { hasExistingAgentProjectWork, stageAgentProjectStarter } from '../utils/agentProjectStarters.mjs'
import AgentProjectWelcome from './AgentProjectWelcome'
import CodexSetup from './CodexSetup'
import LmStudioSetup from './LmStudioSetup'
import { OptionalSetupDialog } from './OptionalSetup'
import GenerationMemorySetting from './GenerationMemorySetting'
import { VeloAllowance, useVeloAllowance, veloAllowanceNotice } from './VeloAllowance'
import WorkflowLocalTrustSettings from './WorkflowLocalTrustSettings'
import { useMobileCompanion, MobileCompanionRequest } from './MobileCompanion'
import { DesktopAccountBridge, useOpenDesktopAccount } from './DesktopAccount'
import './ConnectedAgentPanel.css'

// Keep unsent desktop work when the paired phone opens another project.
// Session memory only: attachments and drafts are not written to disk here.
const mobileDraftCache = new Map()

const identities = new WeakMap()
let nextIdentity = 0
const SETTINGS_KEY = 'velorn.connected-agent.settings.v1'
const codexAuthRequired = code => ['CODEX_LOGIN_REQUIRED', 'CODEX_CHATGPT_REQUIRED'].includes(code)
const CODEX_SETUP_REQUIRED = 'Connect Codex before sending. Your draft is saved here.'
function readSettings() {
  try { const value = JSON.parse(window.localStorage.getItem(SETTINGS_KEY)); return value && typeof value === 'object' ? value : {} } catch { return {} }
}
function saveSettings(changes) {
  try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readSettings(), ...changes })); return true } catch { return false /* Optional local preferences; no project write. */ }
}
function sessionId(value) {
  if (value && typeof value === 'object') {
    if (!identities.has(value)) identities.set(value, `session-${++nextIdentity}`)
    return identities.get(value)
  }
  return String(value ?? 'closed')
}
function editorViewIdentity() {
  const project = useProjectStore.getState()
  const timeline = useTimelineStore.getState()
  return JSON.stringify([project.currentTimelineId, timeline.timelineSessionId, timeline.playheadPosition])
}

// Device-only installation metadata. It never belongs in prompts, persisted
// chat history, project context, or renderer preferences.
function codexExecutableInfo(value) {
  if (!value || !['automatic', 'custom'].includes(value.mode) || typeof value.available !== 'boolean'
    || typeof value.path !== 'string' || value.path.length > 8192 || typeof value.source !== 'string' || value.source.length > 256) return null
  const plain = text => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
  return { path: plain(value.path), source: plain(value.source), mode: value.mode, available: value.available,
    error: typeof value.error === 'string' ? plain(value.error).slice(0, 2000) : '' }
}

// This policy belongs to native device settings, never chat/provider preferences.
// Do not label an old or unavailable preload as protected by the default policy.
function generationSpendingPolicy(value) {
  return value?.success === true && value.scope === 'velorn-managed'
    && ['local-only', 'ask-cloud'].includes(value.policy) ? value.policy : null
}
const SPENDING_UNAVAILABLE = 'Generation spending protection could not be verified. Fully quit and reopen Velorn before generating.'

function RequestedModel({ value, provider, effort }) {
  const model = sanitizeConnectedAgentRequestedModel(value)
  const label = model === undefined ? 'Model not recorded'
    : model ? `Requested model: ${model}`
      : provider === 'codex' ? 'Requested: Codex default (not confirmed)' : 'Requested: model unspecified (not confirmed)'
  const detail = <span className="ca-requested-model" title={model === undefined
    ? 'This reply has no recorded model selection. Its model cannot be inferred from your current settings.'
    : 'Records the model and thinking selections sent with this request, not a billing receipt.'}>{label}{provider === 'codex' && validThinkingLevel(effort) ? ` · Thinking: ${THINKING_LABELS[effort]}` : ''}</span>
  return provider === 'luna' ? <details className="ca-settings-disclosure ca-reply-model"><summary>Model details</summary>{detail}</details> : detail
}

function toolDetail(value, limit = 6000) {
  let text
  try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) } catch { text = 'Details are unavailable.' }
  text = String(text ?? '')
  return text.length > limit ? `${text.slice(0, limit)}\n… Details truncated.` : text
}

const ACTIVITY_LIMIT = 60
const ACTIVITY_OUTPUT_LIMIT = 16 * 1024
const ACTIVITY_OUTPUT_TOTAL = 64 * 1024
const activityId = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\x00-\x1f\x7f]/.test(value)
// Native events contain public, already-redacted text only. Repeat the text
// redaction here defensively; never render an arbitrary event object or persist
// activity/output in conversation history. All updates are cumulative by ID.
const activityText = (value, limit) => redactConnectedAgentText(typeof value === 'string' ? value : '', limit)
function updateActivity(previous, item) {
  const index = previous.findIndex(entry => entry.id === item.id)
  if (index >= 0 && previous[index].status !== 'running' && item.status === 'running') return previous
  let next = index < 0 ? [...previous, item].slice(-ACTIVITY_LIMIT)
    : previous.map((entry, position) => position === index ? { ...entry, ...item } : entry)
  // Keep recent output within a second renderer-side RAM budget even if a
  // provider emits more than its native per-turn budget. Summaries stay visible.
  let remaining = ACTIVITY_OUTPUT_TOTAL
  next = next.map(entry => ({ ...entry }))
  for (let position = next.length - 1; position >= 0; position--) {
    const entry = next[position]
    if (!entry.output) continue
    const retained = entry.output.slice(0, remaining)
    remaining -= retained.length
    entry.outputTruncated = entry.outputTruncated || retained.length < entry.output.length
    entry.output = retained
  }
  return next
}

function LiveActivity({ items, timing, busy, replyUnavailable }) {
  if (!items.length && !timing) return null
  const states = { running: 'Running', completed: 'Completed', denied: 'Denied', failed: 'Failed',
    stopped: 'Stopped', unconfirmed: 'Outcome not confirmed' }
  return <details className="ca-live-activity ca-tool-activity" aria-label="Activity details">
    <summary>Activity details{items.length === ACTIVITY_LIMIT ? ' · latest 60 entries' : ''}</summary>
    {items.length > 0 && <ol>{items.map(item => <li key={item.id} data-activity-id={item.id} data-kind={item.kind} data-state={item.status}>
      <span className="ca-activity-mark" aria-hidden="true">{item.status === 'running'
        ? <Loader2 size={13} className="ca-activity-spinner" /> : item.status === 'completed' ? <Check size={13} /> : <Clock size={13} />}</span>
      <div className="ca-activity-entry">{item.kind === 'progress'
        ? <div className="ca-progress-text"><AgentMessageContent text={item.text} progress /></div>
        : <><div className="ca-tool-heading"><strong>{item.toolName || 'Tool action'}</strong><span>{states[item.status]}</span>
          {item.durationMs !== undefined && <span className="ca-tool-duration" title={`${item.durationMs} ms elapsed`}>{formatConnectedAgentDuration(item.durationMs)}</span>}</div>
          {item.summary && (isAgentCommand(item.toolName)
            ? <details className="ca-command-details"><summary>Command details</summary><pre>{item.summary}</pre></details>
            : <p>{item.summary}</p>)}
          {(item.output || item.outputTruncated) && <details className="ca-command-output"><summary>Command output</summary>
            <pre>{item.output || 'Earlier output is no longer retained.'}{item.output && item.outputTruncated ? '\n… Output truncated.' : ''}</pre>
          </details>}</>}
      </div>
    </li>)}</ol>}
    <RunDetails timing={timing} busy={busy} replyUnavailable={replyUnavailable} />
  </details>
}

function ToolReceipts({ value }) {
  const receipts = sanitizeAgentToolReceipts(value)
  if (!receipts) return null
  return <details className="ca-tool-receipts" aria-label="Recorded tool results">
    <summary>Recorded tool results</summary>
    <p>Recorded when these tools ran, not a live inspection or confirmation that the entire request finished.</p>
    <ul>{receipts.entries.map(entry => <li key={entry.id} data-receipt-outcome={entry.outcome}>
      <code>{entry.toolName}</code><span>{receiptOutcomeLabel(entry.outcome)}</span>
    </li>)}</ul>
    {receipts.omitted > 0 && <p>{receipts.omitted} additional receipts are not shown.</p>}
  </details>
}
function LocalDiagnostics({ value }) {
  const entries = sanitizeAgentLocalDiagnostics(value)
  if (!entries) return null
  const number = value => value === null ? 'unknown' : value
  return <details className="ca-local-diagnostics" aria-label="Local response diagnostics">
    <summary>Local response diagnostics</summary>
    <p>Response metadata only. No prompts, tool arguments or private reasoning are saved here.</p>
    <ol>{entries.map((entry, index) => <li key={index}>
      {entry.answerRecovery ? 'Answer-only recovery' : `Prediction ${entry.prediction}`}: {number(entry.publicContentChars)} public characters,
      {' '}{number(entry.parsedToolCalls)} tool calls; stop reason: {entry.finishReason}.
      {' '}Tokens: {number(entry.promptTokens)} input / {number(entry.completionTokens)} output.
    </li>)}</ol>
  </details>
}
function RunDetails({ timing, busy, replyUnavailable = false }) {
  if (!timing) return null
  const outcome = replyUnavailable && timing.outcome === 'failed' ? 'Final reply unavailable'
    : { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }[timing.outcome]
  const continuity = { new: 'New', continued: 'Continued', reset: 'Reset' }[timing.continuity]
  return <details className="ca-run-details" aria-label="Run details">
    <summary>Run details</summary>
    <dl>{[['setup', 'Setup'], ['first-update', 'First public update'], ['total', 'Total run']].map(([phase, label]) =>
      <div key={phase}><dt>{label}</dt><dd data-timing-phase={phase} title={timing[phase] === undefined ? undefined : `${timing[phase]} ms elapsed`}>
        {timing[phase] === undefined ? (busy && timing.total === undefined ? 'Waiting…' : 'Not recorded') : formatConnectedAgentDuration(timing[phase])}
      </dd></div>)}
      {outcome && <div><dt>Outcome</dt><dd>{outcome}</dd></div>}
      {continuity && <div><dt>Runtime session</dt><dd>{continuity}</dd></div>}
    </dl>
    <p>Measured from native request start, after attachment preparation. First update includes setup. Tool durations include approval waiting and validation, not just execution; they can overlap and are not added together.</p>
  </details>
}

function approvalArguments(value) {
  const limit = 128 * 1024
  try {
    const compact = typeof value === 'string' ? value : JSON.stringify(value ?? {})
    if (new TextEncoder().encode(compact).byteLength > limit) {
      return { reviewable: false, text: 'Arguments exceed the 128 KiB review limit and cannot be approved. Deny this action and ask for a smaller request.' }
    }
    const formatted = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)
    // Preserve every argument. Fall back to compact JSON if indentation would
    // inflate an otherwise bounded native payload; never truncate a batch.
    return { reviewable: true, text: new TextEncoder().encode(formatted).byteLength > limit * 2 ? compact : formatted }
  } catch {
    return { reviewable: false, text: 'Arguments could not be fully displayed and cannot be approved. Deny this action and request it again.' }
  }
}

function visibleShots(root) {
  if (!root) return []
  const viewport = root.getBoundingClientRect()
  return [...root.querySelectorAll('[data-shot-id]')].filter(element => {
    const box = element.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && box.bottom > viewport.top && box.top < viewport.bottom
      && box.right > viewport.left && box.left < viewport.right
  }).map(element => element.dataset.shotId)
}

// Only opt-in, existing project images. No downloads, thumbnail generation or
// video seeking; unavailable/tainted images are reported, never invented.
async function smallImage(asset, assertAvailable) {
  assertAvailable()
  if (asset?.type !== 'image' || !/^(blob:|data:image\/(png|jpeg|webp);|file:|comfystudio-file:|https?:\/\/(127\.0\.0\.1|localhost)([:/]))/i.test(asset.url || '')) {
    throw new Error('A local image preview is not available.')
  }
  const img = new Image()
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { img.src = ''; reject(new Error('Image preview timed out.')) }, 5000)
    img.onload = () => { clearTimeout(timer); resolve() }
    img.onerror = () => { clearTimeout(timer); reject(new Error('Image preview could not be read.')) }
    img.src = asset.url
  })
  assertAvailable()
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('Empty image preview.')
  const scale = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', .82)
}

function Conversation({ projectKey, provider, onProviderChange, settingsOpen, settingsId, onSettingsOpen, onBackToChat, activeTab, visible, onShowShot, onOpenEditor, workspaceRef, onHighlight, renderHeader, workflowReferenceRef, setupModelPickerRef }) {
  const openAccount = useOpenDesktopAccount()
  const [pendingProvider, setPendingProvider] = useState(null)
  const providerConfirmation = useRef(null)
  useEffect(() => { if (pendingProvider) providerConfirmation.current?.querySelector('[data-keep-chat]')?.focus() }, [pendingProvider])
  const history = useMemo(() => createConnectedAgentConversationStore({ storage: window.localStorage }), [])
  const [conversations, setConversations] = useState(() => history.read(projectKey, provider))
  const activeChat = conversations.conversations.find(chat => chat.id === conversations.activeId)
  const otherChats = useMemo(() => CONNECTED_AGENT_PROVIDERS.filter(value => value !== provider)
    .flatMap(value => history.read(projectKey, value).conversations.filter(chat => chat.messages.length || chat.selection)
      .map(chat => ({ ...chat, provider: value }))), [history, projectKey, provider, conversations])
  const fundedLuna = provider === 'luna'
  const computerAccessProvider = provider === 'codex' || fundedLuna
  // Velo's own computer tools exist for Linux and macOS. On Windows the Full
  // access card is shown greyed out as "coming soon" instead of failing.
  const hostPlatform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined
  const veloFullAccessComingSoon = fundedLuna && typeof hostPlatform === 'string' && !veloComputerAccessSupported(hostPlatform)
  const comingSoonText = `Full access for Velo is coming soon${hostPlatform === 'win32' ? ' on Windows' : ' on this system'}.`
  const savedSelection = getConnectedAgentChatSelection(activeChat)
  const draftCacheKey = `${projectKey}:${provider}`
  const cachedDraft = mobileDraftCache.get(draftCacheKey)
  const cachedChatMatches = cachedDraft?.chatId === conversations.activeId
  const project = useProjectStore(state => state.currentProject)
  const handle = useProjectStore(state => state.currentProjectHandle)
  const loading = useProjectStore(state => state.isLoading)
  const exportBusy = useExportActivityStore(state => Boolean(state.activeJob || state.localActivity))
  const assets = useAssetsStore(state => state.assets)
  const clipCount = useTimelineStore(state => state.clips?.length || 0)
  const hasProjectWork = useMemo(() => hasExistingAgentProjectWork({ project, assets, clips: clipCount ? [true] : [] }), [project, assets, clipCount])
  const [model, setModel] = useState(() => connectedAgentModelSelection(provider, savedSelection?.model ?? readSettings()[`${provider}Model`]))
  const [thinkingPreference, setThinkingPreference] = useState(() => savedSelection?.reasoningEffort || (validThinkingLevel(readSettings().codexReasoningEffort) ? readSettings().codexReasoningEffort : 'medium'))
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [setupModelHandoff, setSetupModelHandoff] = useState(false)
  const setupModelHandoffRef = useRef(false)
  const providerPicker = useRef(null)
  const [setupHelperOpen, setSetupHelperOpen] = useState(false)
  const [customModelDraft, setCustomModelDraft] = useState('')
  const [endpoint, setEndpoint] = useState(() => String(readSettings().endpoint || 'http://127.0.0.1:1234/v1').slice(0, 256))
  const [models, setModels] = useState(() => provider === 'luna' ? fundedLunaModels() : [])
  const [loadedModelStatus, setLoadedModelStatus] = useState('unchecked')
  const modelChoiceEpoch = useRef(0)
  const [customModelMode, setCustomModelMode] = useState(false)
  const currentModelChoice = useRef({ model, custom: customModelMode })
  currentModelChoice.current = { model, custom: customModelMode }
  const [modelCatalogError, setModelCatalogError] = useState('')
  const [connection, setConnection] = useState('')
  const [lunaConnection, setLunaConnection] = useState({ available: false, message: 'Checking this account’s Velo availability… No message is sent by checking.' })
  const lunaCheckInFlight = useRef(null), lunaAccountKey = useRef(''), lunaAutoCheck = useRef('')
  const [checking, setChecking] = useState(false)
  const [codexExecutable, setCodexExecutable] = useState(null)
  const [codexSetupState, setCodexSetupState] = useState('unknown')
  const [codexSetupOpen, setCodexSetupOpen] = useState(false)
  const [lmStudioSetupOpen, setLmStudioSetupOpen] = useState(false)
  const [lmStudioAppBusy, setLmStudioAppBusy] = useState(false)
  const [lmStudioCheck, setLmStudioCheck] = useState({ connected: false, endpoint: '', error: '' })
  const [codexInstallBusy, setCodexInstallBusy] = useState(false)
  const [codexLoginPending, setCodexLoginPending] = useState(false)
  const [codexLoginError, setCodexLoginError] = useState('')
  const codexLoginOperation = useRef(null)
  const codexAuthRecovery = useRef(null)
  const [executableError, setExecutableError] = useState('')
  const [executableReading, setExecutableReading] = useState(false)
  const [executableChanging, setExecutableChanging] = useState(false)
  const executableEpoch = useRef(0), executableMutation = useRef(null)
  const [shareImages, setShareImages] = useState(false)
  const [shareView, setShareView] = useState(false)
  const [localVision, setLocalVision] = useState(false)
  const [toolsEnabled, setToolsEnabled] = useState(false)
  const [researchEnabled, setResearchEnabled] = useState(false)
  const [preferredSetup, setPreferredSetup] = useState(() => readAccessSetup(readSettings(), provider))
  const [accessNotice, setAccessNotice] = useState('')
  // A native-confirmed grant is intentionally RAM-only, never a preference or
  // conversation-history field. Workspace navigation retains this component;
  // project/provider/remount boundaries and explicit chat changes revoke it.
  const [fullAccessEnabled, setFullAccessEnabled] = useState(false)
  const [fullAccessChanging, setFullAccessChanging] = useState(false)
  const [fullAccessError, setFullAccessError] = useState('')
  const fullAccessGrant = useRef(null), fullAccessEpoch = useRef(0), fullAccessPending = useRef(false)
  // Presentation reflects the native grant, not the selected mode or an old
  // phone/tools receipt. Only main can mint computer authority.
  const fullComputerAccessEnabled = fullAccessEnabled && (provider === 'codex'
    || (fundedLuna && fullAccessGrant.current?.scope === 'velorn-velo-full-computer-access' && fullAccessGrant.current?.version === 2))
  const [fullAccessPreference, setFullAccessPreference] = useState({ scope: null, checked: false, remembered: false })
  const fullAccessPreferenceEpoch = useRef(0)
  const fullAccessRestoreAttempt = useRef(null)
  const fullAccessRestoreTimer = useRef(null)
  const [fullAccessRestoreRetry, setFullAccessRestoreRetry] = useState(0)
  const [fullAccessLearnMoreOpen, setFullAccessLearnMoreOpen] = useState(false)
  const [fullAccessDetailsSequence, setFullAccessDetailsSequence] = useState(0)
  const [accessOptionsOpen, setAccessOptionsOpen] = useState(false)
  const [advancedOptionsOpen, setAdvancedOptionsOpen] = useState(false)
  const phoneSettings = useRef(null)
  const fullAccessDetails = useRef(null)
  const [spendingPolicy, setSpendingPolicy] = useState(null)
  const [spendingReading, setSpendingReading] = useState(true)
  const [spendingChanging, setSpendingChanging] = useState(false)
  const [spendingError, setSpendingError] = useState('')
  const [spendingNotice, setSpendingNotice] = useState('')
  const spendingEpoch = useRef(0), spendingMutation = useRef(false)
  const [approvals, setApprovals] = useState([])
  const [liveActivity, setLiveActivity] = useState([])
  const [runTiming, setRunTiming] = useState(null)
  const timingRequest = useRef(null)
  const structuredProgress = useRef(false)
  const [draft, setDraft] = useState((cachedChatMatches ? cachedDraft?.draft : cachedDraft?.drafts?.get(conversations.activeId)) || '')
  const [attachments, setAttachments] = useState((cachedChatMatches ? cachedDraft?.attachments : cachedDraft?.attachmentDrafts?.get(conversations.activeId)) || [])
  const currentComposer = useRef({ draft, attachments })
  currentComposer.current = { draft, attachments }
  const [attaching, setAttaching] = useState(false)
  const [autoApproveEdits, setAutoApproveEdits] = useState(false)
  const attachmentDrafts = useRef(cachedDraft?.attachmentDrafts || new Map()), approvalModes = useRef(new Map())
  const attachmentEpoch = useRef(0), attachmentRead = useRef(false), fileInput = useRef(null)
  const [error, setError] = useState('')
  const reviewChat = useRef(null)
  const [status, setStatus] = useState('')
  const [serviceWaiting, setServiceWaiting] = useState(false)
  const [partial, setPartial] = useState('')
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [requestModel, setRequestModel] = useState(undefined)
  const [requestThinking, setRequestThinking] = useState(undefined)
  const [requestFromPhone, setRequestFromPhone] = useState(false)
  const [lastShared, setLastShared] = useState(null)
  const activeChatId = useRef(conversations.activeId)
  activeChatId.current = conversations.activeId
  const messages = activeChat?.messages || []
  const [chatMenuOpen, setChatMenuOpen] = useState(false)
  const [deleteChatId, setDeleteChatId] = useState(null)
  const drafts = useRef(cachedDraft?.drafts || new Map()), focusComposer = useRef(false), restoreChatOptionsFocus = useRef(false)
  useEffect(() => {
    mobileDraftCache.set(draftCacheKey, { chatId: conversations.activeId, draft, attachments, drafts: drafts.current, attachmentDrafts: attachmentDrafts.current })
  }, [draftCacheKey, conversations.activeId, draft, attachments])
  const starterDraft = useRef({ chatId: null, text: '' })
  const [starterNotice, setStarterNotice] = useState({ chatId: null, text: '' })
  const composer = useRef(null), chatMenu = useRef(null), chatMenuButton = useRef(null), deleteDialog = useRef(null)
  const activeRequest = useRef(null), mounted = useRef(true), connectionEpoch = useRef(0)
  useLayoutEffect(() => {
    if (!workflowReferenceRef) return undefined
    const stageReference = entry => {
      const current = useProjectStore.getState()
      if (!mounted.current || current.isLoading || !current.currentProject
        || getStoryboardProjectKey(current.currentProject, current.currentProjectHandle) !== projectKey) {
        return { success: false, error: 'The project changed. Open the current project chat and try again.' }
      }
      if (busy || activeRequest.current || loading || isExportBusy() || deleteChatId
        || fullAccessPending.current || executableMutation.current || spendingMutation.current || attachmentRead.current) {
        return { success: false, error: 'Wait for the current agent operation or export to finish, then add the workflow.' }
      }
      const result = appendWorkflowAgentReference(draft, entry)
      if (!result.success) return result
      setDraft(result.text)
      drafts.current.set(conversations.activeId, result.text)
      setError('')
      focusComposer.current = true
      onSettingsOpen(false)
      return { success: true }
    }
    workflowReferenceRef.current = stageReference
    return () => { if (workflowReferenceRef.current === stageReference) workflowReferenceRef.current = null }
  })
  const checkedCodexModels = useRef(false)
  const requestToolsEnabled = useRef(false)
  const approvalRecords = useRef(new Map())
  const latestTab = useRef(activeTab)
  const viewEpoch = useRef(0)
  const latestVisible = useRef(visible)
  if (latestTab.current !== activeTab || latestVisible.current !== visible) viewEpoch.current++
  latestTab.current = activeTab
  latestVisible.current = visible
  const accessStart = useRef(null)
  const editingApprovals = useRef(null), accessModes = useRef(null), approvalFocusRequested = useRef(false)
  const [approvalFocusSequence, setApprovalFocusSequence] = useState(0)
  const messagesContainer = useRef(null), approvalStart = useRef(null)
  const pendingApprovalId = approvals.find(approval => approval.state === 'pending')?.approvalId
  const submittingDecision = approvals.some(approval => approval.state === 'sending')
  const runningTool = [...liveActivity].reverse().find(item => item.kind === 'tool' && item.status === 'running')
  const activityState = pendingApprovalId ? 'approval' : submittingDecision ? 'decision'
    : preparing ? 'preparing' : fundedLuna && serviceWaiting ? 'service-wait' : runningTool ? 'tool' : 'working'
  const activityLabel = { approval: 'Waiting for your approval', decision: 'Submitting your decision…',
    preparing: 'Preparing message…', 'service-wait': 'Waiting for Velo…', tool: fullAccessEnabled ? 'Using tools…' : 'Using Velorn tools…', working: 'Working…' }[activityState]
  const activityDetail = activityState === 'approval' ? 'Review the action and warnings in the conversation.'
    : activityState === 'decision' ? 'Waiting for Velorn to accept your decision.'
    : activityState === 'preparing' ? 'Preparing project context and any shared images.'
    : activityState === 'service-wait' ? status
    : activityState === 'tool' ? ({ wait_for_comfyui_runs: 'Waiting for generation results.',
      queue_comfyui_workflow: 'Preparing a generation.', inspect_velorn_workflow: 'Checking the workflow.',
      inspect_comfyui_node: 'Checking workflow requirements.', diagnose_comfyui_connection: 'Checking ComfyUI.',
      get_assets: 'Checking project assets.', install_workflow_setup: 'Setting up the workflow.' }[runningTool.toolName]
      || 'Working on your request. Open Activity details for individual steps.')
    : partial ? 'The response is still in progress.' : 'Waiting for the agent’s response.'
  const currentViewAvailable = ['storyboard', 'editor'].includes(activeTab)
  const api = window.electronAPI?.connectedAgent
  const entrySelection = useRef(null)
  entrySelection.current = { provider, endpoint, model }
  const entryGuide = useMemo(() => createAgentEntryGuide({
    getSelection: () => entrySelection.current, storage: window.localStorage,
    // A default provider value alone is not user intent. Existing saved choices
    // and conversations suppress the invitation, without claiming availability.
    hasPriorIntent: Boolean(model || savedSelection || conversations.conversations.some(chat => chat.messages.length)
      || otherChats.length || Object.hasOwn(readSettings(), 'provider') || Object.hasOwn(readSettings(), `${provider}Model`)),
  }), [projectKey, provider])
  const entryState = useSyncExternalStore(entryGuide.subscribe, entryGuide.getSnapshot, entryGuide.getSnapshot)
  useEffect(() => { entryGuide.selectionChanged() }, [entryGuide, model, endpoint])
  useEffect(() => { if (!visible) setSetupHelperOpen(false) }, [visible])
  const previousSetupHelperOpen = useRef(false)
  useEffect(() => {
    // The one-time invitation disappears after opening help, so its button may
    // no longer exist for the dialog's usual focus restoration.
    if (previousSetupHelperOpen.current && !setupHelperOpen && visible && !settingsOpen && !modelPickerOpen) composer.current?.focus()
    previousSetupHelperOpen.current = setupHelperOpen
  }, [setupHelperOpen, visible, settingsOpen, modelPickerOpen])
  useEffect(() => {
    if (provider === 'codex' && entryState.codexState && !['unknown', 'checking'].includes(entryState.phase)) setCodexSetupState(entryState.codexState)
  }, [provider, entryState.phase, entryState.codexState])
  const fullAccessScope = JSON.stringify([projectKey, provider, conversations.activeId])
  const fullAccessRemembered = fullAccessPreference.scope === fullAccessScope && fullAccessPreference.remembered
  const fullAccessPreferencePending = typeof api?.getFullAccessPreference === 'function'
    && (fullAccessPreference.scope !== fullAccessScope || !fullAccessPreference.checked
      || (fullAccessRemembered && !fullAccessEnabled && fullAccessRestoreAttempt.current !== fullAccessScope))
  const reviewProjectIsCurrent = useCallback(() => {
    const current = useProjectStore.getState()
    return !current.isLoading && getStoryboardProjectKey(current.currentProject, current.currentProjectHandle) === projectKey
  }, [projectKey])
  const { frames: reviewFrames, warning: reviewMediaWarning, saveFrame: saveReviewFrame } = useAgentReviewMedia({
    projectKey, projectPath: typeof handle === 'string' ? handle : '', chatId: conversations.activeId,
    turnIds: [...messages.map(message => message.turnId), activeRequest.current], isProjectCurrent: reviewProjectIsCurrent,
  })
  const playable = useAgentPlayableMedia({ projectPath: typeof handle === 'string' ? handle : '', chatId: conversations.activeId,
    turnIds: [...messages.map(message => message.turnId), activeRequest.current], assets })
  const setupDownloads = useAgentSetupDownloads({ projectPath: typeof handle === 'string' ? handle : '', chatId: conversations.activeId })
  const lmStudioDownloads = useAgentLmStudioSetup({ projectPath: typeof handle === 'string' ? handle : '', chatId: conversations.activeId })
  const spendingApi = window.electronAPI?.generationSpending
  const spendingAvailable = typeof spendingApi?.getStatus === 'function'
    && typeof spendingApi?.setPolicy === 'function' && typeof spendingApi?.onChanged === 'function'
  const currentContext = () => buildConnectedAgentContext({ project: useProjectStore.getState().currentProject,
    handle: useProjectStore.getState().currentProjectHandle, assets: useAssetsStore.getState().assets,
    timeline: { ...useProjectStore.getState().getCurrentTimeline?.(), ...useTimelineStore.getState() }, activeTab, visibleShotIds: visibleShots(workspaceRef?.current) })

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      fullAccessEpoch.current++
      clearTimeout(fullAccessRestoreTimer.current)
      if (fullAccessGrant.current || fullAccessPending.current) {
        fullAccessGrant.current = null
        fullAccessPending.current = false
        void api?.setFullAccess?.({ enabled: false, conversationId: activeChatId.current }).catch(() => {})
      }
      attachmentEpoch.current++
      connectionEpoch.current++
      executableEpoch.current++
      if (codexLoginOperation.current) {
        codexLoginOperation.current = null
        void api?.codexLogin?.({ action: 'cancel' }).catch(() => {})
      }
      const requestId = activeRequest.current
      activeRequest.current = null
      approvalRecords.current.clear()
      if (requestId) void api?.cancel?.({ requestId }).catch(() => {})
    }
  }, [api])
  const acceptSpendingStatus = result => {
    const policy = generationSpendingPolicy(result)
    setSpendingPolicy(policy)
    setSpendingReading(false)
    setSpendingError(policy ? '' : SPENDING_UNAVAILABLE)
    return policy
  }
  async function refreshSpendingStatus() {
    const epoch = ++spendingEpoch.current
    setSpendingReading(true); setSpendingError(''); setSpendingNotice(''); setSpendingPolicy(null)
    try {
      if (!spendingAvailable) throw new Error(SPENDING_UNAVAILABLE)
      const result = await spendingApi.getStatus()
      if (mounted.current && epoch === spendingEpoch.current) acceptSpendingStatus(result)
    } catch {
      if (mounted.current && epoch === spendingEpoch.current) acceptSpendingStatus(null)
    }
  }
  useEffect(() => {
    let active = true, unsubscribe
    try {
      if (!spendingAvailable) throw new Error(SPENDING_UNAVAILABLE)
      unsubscribe = spendingApi.onChanged(result => {
        if (!active || !mounted.current) return
        spendingEpoch.current++ // A late initial read cannot overwrite a change.
        setSpendingNotice(''); acceptSpendingStatus(result)
      })
      void refreshSpendingStatus()
    } catch { acceptSpendingStatus(null) }
    return () => { active = false; spendingEpoch.current++; if (typeof unsubscribe === 'function') unsubscribe() }
  }, [spendingApi])
  async function changeSpendingPolicy(policy) {
    if (policy === spendingPolicy) return { success: true, status: 'completed' }
    if (!spendingAvailable || !spendingPolicy || policy === spendingPolicy
      || !['local-only', 'ask-cloud'].includes(policy) || busy || loading || spendingReading
      || spendingMutation.current || fullAccessPending.current || executableMutation.current || isExportBusy()) return
    const epoch = ++spendingEpoch.current
    spendingMutation.current = true; setSpendingChanging(true); setSpendingError(''); setSpendingNotice('')
    try {
      // Only a direct UI choice invokes this native permission boundary. The
      // native dialog confirms a relaxation; never optimistically show it active.
      const result = await spendingApi.setPolicy(policy)
      if (!mounted.current) return { success: false, error: 'The project changed.' }
      if (result?.cancelled === true) { setSpendingNotice('Generation spending was not changed.'); return { success: false, error: 'Spending permission was not changed.' } }
      if (epoch === spendingEpoch.current) acceptSpendingStatus(result)
      return result?.success ? { success: true, status: 'completed' } : { success: false, error: result?.error || 'Spending permission was not changed.' }
    } catch {
      if (mounted.current && epoch === spendingEpoch.current) acceptSpendingStatus(null)
      return { success: false, error: 'Spending permission could not be changed.' }
    } finally {
      spendingMutation.current = false
      if (mounted.current) setSpendingChanging(false)
    }
  }
  useEffect(() => api?.onEvent?.(event => {
    if (!mounted.current || !event
      || useProjectStore.getState().isLoading
      || getStoryboardProjectKey(useProjectStore.getState().currentProject, useProjectStore.getState().currentProjectHandle) !== projectKey) return
    if (event.type === 'codex-setup-changed') {
      // Setup can also happen in the app-wide Connect tools surface. Native
      // authority is already revoked: reconcile RAM without sending another
      // permission change into the setup operation or disturbing this chat.
      fullAccessEpoch.current++
      fullAccessPreferenceEpoch.current++
      fullAccessGrant.current = null; fullAccessPending.current = false
      fullAccessRestoreAttempt.current = fullAccessScope
      clearTimeout(fullAccessRestoreTimer.current)
      setFullAccessEnabled(false); setFullAccessChanging(false); setFullAccessError('')
      setFullAccessPreference(previous => ({ scope: fullAccessScope, checked: true,
        remembered: provider === 'codex' ? false : previous.scope === fullAccessScope && previous.remembered }))
      if (provider === 'codex') {
        entryGuide.invalidate()
        connectionEpoch.current++; executableEpoch.current++; modelChoiceEpoch.current++
        checkedCodexModels.current = false
        setChecking(false); setExecutableReading(false)
        setCodexExecutable(null); setModels([]); setModelCatalogError('')
        setCodexSetupState('unknown'); setExecutableError('')
        setConnection('Codex setup changed. Check connection to refresh its status and models.')
      }
      return
    }
    // Stop clears the active request immediately. Its final public timing may
    // still arrive, but no late reply/tool event is allowed back into the chat.
    if (event.type === 'timing' && timingRequest.current && event.requestId === timingRequest.current) {
      if (event.requestId !== activeRequest.current && event.phase !== 'total') return
      setRunTiming(previous => updateConnectedAgentTiming(previous, event))
      return
    }
    if (!activeRequest.current || event.requestId !== activeRequest.current) return
    if (event.type === 'review-frame') {
      const chatId = reviewChat.current, requestId = event.requestId
      void reviewThumbnail(event.frame).then(frame => {
        if (frame && mounted.current && reviewProjectIsCurrent()) {
          // Keep the capture's original owner even if its reply completes or the
          // user switches conversations while thumbnail compression finishes.
          void saveReviewFrame(frame, { chatId, turnId: requestId })
        }
      }).catch(() => { if (mounted.current && timingRequest.current === requestId) setError('A review still could not be displayed. Ask for a smaller preview.') })
      return
    }
    if (event.type === 'delta' && !structuredProgress.current && typeof event.text === 'string') setPartial(text => (text + event.text).slice(0, 48000))
    if (event.type === 'status') { setStatus(event.text || ''); setServiceWaiting(event.waitingFor === 'velo-service') }
    if (event.type === 'progress' && activityId(event.itemId) && typeof event.text === 'string'
      && ['commentary', 'final_answer'].includes(event.phase) && ['running', 'completed'].includes(event.status)) {
      const firstStructured = !structuredProgress.current
      structuredProgress.current = true
      if (event.phase === 'final_answer') setPartial(activityText(event.text, 48000))
      else {
        if (firstStructured) setPartial('')
        setLiveActivity(previous => updateActivity(previous, { id: `progress:${event.itemId}`, kind: 'progress',
          status: event.status, text: activityText(event.text, 12000) }))
      }
    }
    if (event.type === 'approval' && requestToolsEnabled.current && typeof event.approvalId === 'string'
      && !approvalRecords.current.has(event.approvalId) && approvalRecords.current.size < 200) {
      const requestedArguments = approvalArguments(event.arguments)
      const approval = { requestId: event.requestId, approvalId: event.approvalId,
        toolName: toolDetail(event.toolName, 120), arguments: requestedArguments.text, reviewable: requestedArguments.reviewable,
        preview: event.preview === undefined ? '' : toolDetail(event.preview),
        warnings: Array.isArray(event.warnings) ? event.warnings.slice(0, 8).map(warning => toolDetail(warning, 500)) : [],
        state: 'pending' }
      approvalRecords.current.set(event.approvalId, approval)
      setApprovals(previous => [...previous, approval].slice(-30))
    }
    if (event.type === 'tool' && requestToolsEnabled.current && activityId(event.callId)
      && ['running', 'completed', 'denied', 'failed', 'stopped'].includes(event.status)) {
      const activity = { id: `tool:${event.callId}`, kind: 'tool', toolName: activityText(event.toolName, 120),
        status: event.status, summary: activityText(event.summary, 600),
        ...(connectedAgentDurationMs(event.durationMs) !== undefined ? { durationMs: event.durationMs } : {}),
        ...(typeof event.output === 'string' ? { output: activityText(event.output, ACTIVITY_OUTPUT_LIMIT),
          outputTruncated: event.output.length > ACTIVITY_OUTPUT_LIMIT } : {}) }
      setLiveActivity(previous => updateActivity(previous, activity))
    }
  }), [api, projectKey, provider, fullAccessScope, reviewProjectIsCurrent, saveReviewFrame])
  useLayoutEffect(() => {
    if (pendingApprovalId) onSettingsOpen(false)
  }, [pendingApprovalId, onSettingsOpen])
  useEffect(() => {
    // Opening settings is a fresh editing session for the selected model ID.
    // Catalog refreshes must not overwrite an in-progress custom draft.
    if (settingsOpen) setCustomModelDraft(currentModelChoice.current.model)
  }, [settingsOpen])
  useLayoutEffect(() => {
    if (!settingsOpen || !visible) return
    if (approvalFocusRequested.current && editingApprovals.current) {
      approvalFocusRequested.current = false
      const section = fullAccessEnabled ? accessModes.current : editingApprovals.current
      section.focus({ preventScroll: true })
      // Reveal only the settings scroller, not the editor or the outer page.
      const scroller = section.closest('.ca-settings-scroll')
      if (scroller) scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12
    } else accessStart.current?.focus()
  }, [settingsOpen, visible, approvalFocusSequence])
  useLayoutEffect(() => {
    if (focusComposer.current && visible && !settingsOpen && !modelPickerOpen && !codexSetupOpen && !lmStudioSetupOpen) {
      focusComposer.current = false
      composer.current?.focus()
    }
  }, [conversations.activeId, settingsOpen, modelPickerOpen, codexSetupOpen, lmStudioSetupOpen, visible, draft, entryState.dismissed])
  useLayoutEffect(() => {
    if (deleteChatId) deleteDialog.current?.querySelector('button')?.focus()
    else if (restoreChatOptionsFocus.current) {
      restoreChatOptionsFocus.current = false
      if (visible) chatMenuButton.current?.focus()
    }
    else if (chatMenuOpen) chatMenu.current?.querySelector('button')?.focus()
  }, [deleteChatId, chatMenuOpen])
  useEffect(() => { if (settingsOpen || !visible) { setChatMenuOpen(false); setDeleteChatId(null) } }, [settingsOpen, visible])
  useLayoutEffect(() => {
    if (!visible || settingsOpen || !messagesContainer.current) return
    const log = messagesContainer.current
    let frame = null
    const revealLatest = () => {
      frame = null
      if (!log.isConnected || !log.clientHeight) return
      // A pending action must show its heading/warnings, not just Approve.
      // Otherwise each workspace entry returns to the latest conversation.
      // Scroll only this log, never its workspace or the outer editor dock.
      if (pendingApprovalId && approvalStart.current) {
        log.scrollTop += approvalStart.current.getBoundingClientRect().top - log.getBoundingClientRect().top - 8
      } else if (!messages.length && !busy && !liveActivity.length) {
        // A new conversation starts at its welcome, not at the last starter.
        log.scrollTop = 0
      } else log.scrollTop = log.scrollHeight
    }
    const scheduleReveal = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      // The parent dock reparents this existing DOM in its layout effect.
      // Wait for that move before measuring the new workspace's chat height.
      frame = requestAnimationFrame(revealLatest)
    }
    // Height changes and animated width changes can reflow the conversation
    // after the move. Observe geometry, not scrolling, so manual reading works.
    const resizeObserver = new ResizeObserver(scheduleReveal)
    resizeObserver.observe(log)
    scheduleReveal()
    return () => {
      resizeObserver.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [activeTab, conversations.activeId, messages, busy, partial, status, liveActivity, pendingApprovalId, visible, settingsOpen])

  const storeMessages = next => {
    setConversations(history.write(projectKey, provider, conversations.activeId, next, { model, reasoningEffort: thinkingPreference }))
  }
  const revokeFullAccess = ({ forget = false } = {}) => {
    const hadGrant = fullAccessGrant.current || fullAccessPending.current
    fullAccessRestoreAttempt.current = fullAccessScope
    fullAccessEpoch.current++
    fullAccessGrant.current = null; fullAccessPending.current = false
    setFullAccessEnabled(false); setFullAccessChanging(false); setFullAccessError('')
    if (hadGrant || forget) return api?.setFullAccess?.({ enabled: false, provider, conversationId: conversations.activeId, ...(forget ? { forget: true } : {}) }).then(result => {
      if (mounted.current && conversations.activeId === activeChatId.current && result?.success && forget) setFullAccessPreference({ scope: fullAccessScope, checked: true, remembered: false })
      if (mounted.current && !result?.success) setFullAccessError(result?.error || 'Full access could not be revoked. Stop the response and restart Velorn before continuing.')
      return result
    }).catch(() => { if (mounted.current) setFullAccessError('Full access could not be revoked. Stop the response and restart Velorn before continuing.') })
  }
  const rememberSetup = (mode, shareImagesAndView = preferredSetup.shareImagesAndView) => {
    const accessSetups = accessSetupPreferences(readSettings(), provider, { mode, shareImagesAndView })
    setPreferredSetup(accessSetups[provider])
    const saved = saveSettings({ accessSetups })
    setAccessNotice(saved ? '' : 'Setup is active, but its preference could not be saved on this device.')
  }
  const accessBusy = busy || loading || fullAccessChanging || fullAccessPreferencePending || executableChanging || codexInstallBusy || lmStudioAppBusy || spendingChanging || exportBusy
  function chooseProjectStarter(id) {
    const current = useProjectStore.getState()
    if (messages.length || busy || activeRequest.current || accessBusy || !visible || settingsOpen || deleteChatId
      || fullAccessPending.current || executableMutation.current || spendingMutation.current || attachmentRead.current
      || isExportBusy() || current.isLoading || getStoryboardProjectKey(current.currentProject, current.currentProjectHandle) !== projectKey) return
    const result = stageAgentProjectStarter({ id, draft,
      previousStarterText: starterDraft.current.chatId === conversations.activeId ? starterDraft.current.text : '' })
    if (!result.success) { setError(result.error); return }
    setDraft(result.text)
    drafts.current.set(conversations.activeId, result.text)
    starterDraft.current = { chatId: conversations.activeId, text: result.starterText }
    setStarterNotice({ chatId: conversations.activeId, text: 'Added to your draft. Nothing has been sent or changed.' })
    setError('')
    focusComposer.current = true
    composer.current?.focus()
  }
  const accessMode = activeAccessMode({ fullAccessEnabled, toolsEnabled, researchEnabled })
  const fullSetupComplete = fullAccessEnabled && shareImages && shareView && (!fundedLuna || fullComputerAccessEnabled)
  const fullSetupLabel = 'Full access'
  const approvalStatus = fullAccessEnabled ? 'Full access · automatic'
    : !toolsEnabled ? 'Chat only' : autoApproveEdits ? 'Auto-approve editing' : 'Ask before changes'
  const approvalHelp = fullAccessEnabled
    ? 'Requested actions run automatically, without edit approval, mandatory preview or checkpoint steps. Normal timeline Undo remains available. File changes may not be undoable. Generation spending stays separate. Stop to interrupt.'
    : !toolsEnabled ? 'Choose Work in Velorn above to enable editing tools.'
      : autoApproveEdits ? 'This chat session: supported undoable edits only. Generation, spending, downloads and file changes still ask. Stop to interrupt.'
        : 'Ask before changes. Auto-approve covers supported undoable edits only, for this chat session.'
  const openApprovalSettings = () => {
    approvalFocusRequested.current = true
    setApprovalFocusSequence(sequence => sequence + 1)
    onSettingsOpen(true)
  }
  const openFullAccessDetails = () => { setAdvancedOptionsOpen(true); setAccessOptionsOpen(true); setFullAccessLearnMoreOpen(true); setFullAccessDetailsSequence(sequence => sequence + 1); onSettingsOpen(true) }
  useEffect(() => {
    if (settingsOpen && advancedOptionsOpen && accessOptionsOpen && fullAccessLearnMoreOpen) fullAccessDetails.current?.scrollIntoView({ block: 'nearest' })
  }, [settingsOpen, advancedOptionsOpen, accessOptionsOpen, fullAccessLearnMoreOpen, fullAccessDetailsSequence])
  function applyAccessMode(mode) {
    if (busy || loading || fullAccessPending.current || executableMutation.current || spendingMutation.current || isExportBusy()) return
    if (mode === 'full') { void changeFullAccess(true, true); return }
    if (!['chat', 'work'].includes(mode)) return
    void revokeFullAccess({ forget: true })
    setToolsEnabled(mode === 'work'); setResearchEnabled(mode === 'work')
    setAutoApproveEdits(false); approvalModes.current.clear()
    if (mode === 'chat') { setShareImages(false); setShareView(false) }
    rememberSetup(mode)
  }
  async function changeFullAccess(enabled, bundle = false, { restoreOnly = false, fromPhone = false } = {}) {
    if (busy || loading || fullAccessPending.current || executableMutation.current || spendingMutation.current || isExportBusy()) return
    if (!enabled) return revokeFullAccess({ forget: true })
    if (veloFullAccessComingSoon && !fromPhone) { setFullAccessError(''); return { success: false, error: comingSoonText } }
    if (!toolsEnabled && !bundle) { setFullAccessError('Enable Velorn tools first, or use Full access.'); return }
    if (!api?.setFullAccess) { setFullAccessError('Fully quit and reopen Velorn to enable Full access.'); return }
    const epoch = ++fullAccessEpoch.current, conversationId = conversations.activeId
    fullAccessRestoreAttempt.current = fullAccessScope
    const ownsRequest = () => mounted.current && epoch === fullAccessEpoch.current && conversationId === activeChatId.current
    const stillCurrent = () => ownsRequest() && !isExportBusy()
      && !useProjectStore.getState().isLoading
      && getStoryboardProjectKey(useProjectStore.getState().currentProject, useProjectStore.getState().currentProjectHandle) === projectKey
    fullAccessPending.current = true; setFullAccessChanging(true); setFullAccessError(''); setAccessNotice('')
    clearTimeout(fullAccessRestoreTimer.current)
    try {
      const result = await api.setFullAccess({ enabled: true, provider, conversationId, expectedContext: captureMcpContext(),
        shareImagesAndView: true, ...(restoreOnly ? { restoreOnly: true } : {}), ...(fromPhone ? { fromPhone: true } : {}) })
      if (!stillCurrent()) {
        // A late confirmation must not create a grant for an abandoned view.
        void api.setFullAccess({ enabled: false, provider, conversationId }).catch(() => {})
        if (ownsRequest()) setFullAccessError('The app context changed during confirmation. Full access was not enabled; try again when idle.')
        return { success: false, error: 'The app context changed during confirmation.' }
      }
      if (!result?.success) throw Object.assign(new Error(result?.error || 'Full access was not enabled.'), { code: result?.code })
      if (typeof result.remembered === 'boolean') setFullAccessPreference({ scope: fullAccessScope, checked: true, remembered: result.remembered })
      if (result.enabled !== true) {
        if (!restoreOnly) setFullAccessError('Full access was not enabled.')
        return { success: false, error: 'Full access was not enabled.' }
      }
      if (typeof result.token !== 'string' || !result.token || result.token.length > 100) {
        void api.setFullAccess({ enabled: false, provider, conversationId }).catch(() => {})
        throw new Error('The native confirmation returned no valid session grant. Full access remains off; restart Velorn and try again.')
      }
      fullAccessGrant.current = { token: result.token, conversationId, scope: result.scope, version: result.version }
      setFullAccessEnabled(true)
      if (bundle) {
        // Atomic bundle: no permissions change until a current native grant.
        // Missing/older native receipts must never imply image-sharing consent.
        const images = result.shareImagesAndView === true
        setToolsEnabled(true); setResearchEnabled(true)
        setAutoApproveEdits(false); approvalModes.current.clear()
        setShareImages(images); setShareView(images)
        rememberSetup('full', images)
        if (typeof result.shareImagesAndView !== 'boolean') setAccessNotice('Full access is enabled. Automatic image sharing stayed off; restart Velorn for the image-sharing confirmation, or use Access options.')
      } else if (typeof result.shareImagesAndView === 'boolean') {
        setShareImages(result.shareImagesAndView); setShareView(result.shareImagesAndView)
      }
      return { success: true, status: 'completed' }
    } catch (failure) {
      if (stillCurrent()) {
        if (failure.code === 'UNSUPPORTED_PLATFORM') { setFullAccessError(''); setAccessNotice(failure.message || comingSoonText) }
        else setFullAccessError(failure.message || 'Full access could not be enabled.')
        // Native context may still be hydrating during startup. Retry only the
        // remembered setup, never a tool action or a declined confirmation.
        if (restoreOnly && fullAccessRestoreRetry < 3 && ['BUSY','STALE_APPROVAL','TOOLS_UNAVAILABLE'].includes(failure.code)) {
          fullAccessRestoreTimer.current = setTimeout(() => {
            if (!stillCurrent()) return
            fullAccessRestoreAttempt.current = null
            setFullAccessRestoreRetry(value => value + 1)
          }, 1000 * (fullAccessRestoreRetry + 1))
        }
      }
      return { success: false, error: failure.message }
    }
    finally { if (ownsRequest()) { fullAccessPending.current = false; setFullAccessChanging(false) } }
  }
  useEffect(() => {
    let current = true
    const epoch = ++fullAccessPreferenceEpoch.current
    fullAccessRestoreAttempt.current = null
    clearTimeout(fullAccessRestoreTimer.current)
    setFullAccessRestoreRetry(0)
    if (typeof api?.getFullAccessPreference !== 'function') {
      setFullAccessPreference({ scope: fullAccessScope, checked: true, remembered: false })
      return () => { current = false }
    }
    setFullAccessPreference({ scope: fullAccessScope, checked: false, remembered: false })
    void api.getFullAccessPreference({ provider }).then(result => {
      if (!current || !mounted.current || epoch !== fullAccessPreferenceEpoch.current) return
      setFullAccessPreference({ scope: fullAccessScope, checked: true, remembered: result?.success === true && result.remembered === true })
      if (result?.success !== true) setFullAccessError('The remembered access choice could not be checked. Enable full access in Assistant settings if needed.')
    }).catch(() => {
      if (!current || !mounted.current || epoch !== fullAccessPreferenceEpoch.current) return
      setFullAccessPreference({ scope: fullAccessScope, checked: true, remembered: false })
      setFullAccessError('The remembered access choice could not be checked. Enable full access in Assistant settings if needed.')
    })
    return () => { current = false }
  }, [api, fullAccessScope, provider])
  useEffect(() => {
    if (!fullAccessRemembered || !fullAccessPreference.checked || fullAccessEnabled || fullAccessChanging
      || fullAccessRestoreAttempt.current === fullAccessScope || busy || loading || executableChanging || spendingChanging
      || fullAccessPending.current || executableMutation.current || spendingMutation.current || isExportBusy()
      || !reviewProjectIsCurrent()) return
    // Only the native saved choice may restore authority. The renderer's saved
    // setup is a UI preference, never a grant. One attempt per active context
    // also prevents an expired/mobile-revoked grant from immediately re-enabling.
    fullAccessRestoreAttempt.current = fullAccessScope
    void changeFullAccess(true, true, { restoreOnly: true })
  }, [fullAccessRemembered, fullAccessPreference.checked, fullAccessEnabled, fullAccessChanging, fullAccessScope,
    busy, loading, executableChanging, spendingChanging, exportBusy, provider, reviewProjectIsCurrent, fullAccessRestoreRetry])
  const canManageChats = !busy && !fullAccessChanging && !fullAccessPreferencePending && !spendingChanging && !executableChanging && !codexInstallBusy && !lmStudioAppBusy && !loading && visible
  const showConversation = next => {
    revokeFullAccess()
    connectionEpoch.current++; executableEpoch.current++
    if (checking || executableReading || executableMutation.current) checkedCodexModels.current = false
    setChecking(false); setExecutableReading(false); setExecutableError('')
    drafts.current.set(conversations.activeId, draft)
    attachmentDrafts.current.set(conversations.activeId, attachments)
    approvalModes.current.set(conversations.activeId, autoApproveEdits)
    attachmentEpoch.current++; attachmentRead.current = false; setAttaching(false)
    setConversations(next)
    const selection = getConnectedAgentChatSelection(next.conversations.find(chat => chat.id === next.activeId))
    if (selection) {
      modelChoiceEpoch.current++
      const selectedModel = connectedAgentModelSelection(provider, selection.model)
      setModel(selectedModel); currentModelChoice.current = { model: selectedModel, custom: false }
      if (selection.reasoningEffort) setThinkingPreference(selection.reasoningEffort)
      saveSettings({ [`${provider}Model`]: selection.model, ...(selection.reasoningEffort ? { codexReasoningEffort: selection.reasoningEffort } : {}) })
    }
    setCustomModelMode(false); setCustomModelDraft(''); setModelPickerOpen(false); setLmStudioSetupOpen(false)
    setDraft(drafts.current.get(next.activeId) || '')
    setAttachments(attachmentDrafts.current.get(next.activeId) || [])
    setAutoApproveEdits(toolsEnabled && approvalModes.current.get(next.activeId) === true)
    setChatMenuOpen(false); setDeleteChatId(null)
    setError(''); setPartial(''); setStatus(''); setLastShared(null)
    approvalRecords.current.clear(); setApprovals([]); setLiveActivity([]); structuredProgress.current = false
    timingRequest.current = null; setRunTiming(null)
    onHighlight?.([])
    focusComposer.current = true
    onSettingsOpen(false)
  }
  const chatNavigationAvailable = fromPhone => (fromPhone ? !busy && !fullAccessChanging && !fullAccessPreferencePending && !spendingChanging && !executableChanging && !codexInstallBusy && !lmStudioAppBusy && !loading : canManageChats)
    && !deleteChatId && !activeRequest.current && !attachmentRead.current && !fullAccessPending.current && !executableMutation.current && !spendingMutation.current
    && !isExportBusy() && connectionContextIsCurrent(conversations.activeId)
  const newChat = ({ fromPhone = false } = {}) => {
    if (!chatNavigationAvailable(fromPhone)) return { success: false, error: 'Chat navigation is busy. Wait for the current operation.' }
    try {
      rememberSelection(); showConversation(history.create(projectKey, provider, { model, reasoningEffort: thinkingPreference }))
      return { success: true, status: 'completed' }
    }
    catch (failure) {
      setError(failure.message || 'A new conversation could not be created.'); onSettingsOpen(false)
      return { success: false, error: failure.message || 'A new conversation could not be created.' }
    }
  }
  const selectChat = (id, { fromPhone = false } = {}) => {
    if (!chatNavigationAvailable(fromPhone)) return { success: false, error: 'Chat navigation is busy. Wait for the current operation.' }
    if (id === conversations.activeId) return { success: true, status: 'completed' }
    try {
      rememberSelection()
      const other = CONNECTED_AGENT_PROVIDERS.find(value => value !== provider && id.startsWith(`${value}:`))
      if (other) {
        history.select(projectKey, other, id.slice(other.length + 1))
        onSettingsOpen(false); onProviderChange(other)
      } else showConversation(history.select(projectKey, provider, id))
      return { success: true, status: 'completed' }
    }
    catch (failure) {
      setError(failure.message || 'This conversation could not be opened.')
      return { success: false, error: failure.message || 'This conversation could not be opened.' }
    }
  }
  const cancelDelete = () => { restoreChatOptionsFocus.current = true; setDeleteChatId(null) }
  const deleteChat = () => {
    if (!canManageChats || !deleteChatId) return
    try {
      const removedId = deleteChatId
      const next = history.remove(projectKey, provider, removedId)
      showConversation(next)
      drafts.current.delete(removedId)
      attachmentDrafts.current.delete(removedId); approvalModes.current.delete(removedId)
    } catch (failure) { setDeleteChatId(null); setError(failure.message || 'This conversation could not be deleted.') }
  }
  const connectionContextIsCurrent = chatId => mounted.current && activeChatId.current === chatId
    && !useProjectStore.getState().isLoading
    && getStoryboardProjectKey(useProjectStore.getState().currentProject, useProjectStore.getState().currentProjectHandle) === projectKey
  async function refreshCodexExecutable() {
    if (provider !== 'codex') return
    if (!api?.codexExecutable) { setExecutableError('Fully quit and reopen Velorn to choose or detect the Codex executable.'); return }
    const epoch = ++executableEpoch.current, chatId = conversations.activeId
    const current = () => epoch === executableEpoch.current && connectionContextIsCurrent(chatId)
    // Background status refreshes must not erase an explicit picker failure.
    setExecutableReading(true)
    try {
      const result = await api.codexExecutable({ action: 'status' })
      if (!current()) return
      if (!result?.success) throw new Error(result?.error || 'Codex installation could not be checked. Try Check connection again.')
      const info = codexExecutableInfo(result.executable)
      if (!info) throw new Error('Codex installation details were unavailable. Restart Velorn and try again.')
      setCodexExecutable(info)
    } catch (failure) { if (current()) { setCodexExecutable(null); setExecutableError(failure.message) } }
    finally { if (current()) setExecutableReading(false) }
  }
  async function changeCodexExecutable(action) {
    if (provider !== 'codex' || busy || checking || executableReading || executableMutation.current
      || fullAccessPending.current || fullAccessPreferencePending || spendingMutation.current || loading || isExportBusy()) return
    if (!api?.codexExecutable) { setExecutableError('Fully quit and reopen Velorn to choose or detect the Codex executable.'); return }
    const operation = { chatId: conversations.activeId }
    executableMutation.current = operation
    setExecutableChanging(true); setExecutableError(''); setCodexLoginError('')
    const current = () => executableMutation.current === operation && connectionContextIsCurrent(operation.chatId)
    try {
      // The native picker is the only path authority: never accept a path from
      // renderer input or send this machine-specific location to the provider.
      const result = await api.codexExecutable({ action })
      if (!current()) return
      if (!result?.success) {
        // An uncertain native installation change revokes its old grant. Do
        // not continue showing authority while reconciling that failure.
        revokeFullAccess()
        if (api.getFullAccessPreference) {
          try {
            const preference = await api.getFullAccessPreference({ provider })
            if (current()) setFullAccessPreference({ scope: fullAccessScope, checked: true,
              remembered: preference?.success === true && preference.remembered === true })
          } catch { if (current()) setFullAccessPreference({ scope: fullAccessScope, checked: true, remembered: false }) }
        }
        throw new Error(result?.error || 'The Codex executable could not be changed. Check the installation before continuing.')
      }
      if (result.cancelled) return
      revokeFullAccess()
      setFullAccessPreference({ scope: fullAccessScope, checked: true, remembered: false })
      const info = codexExecutableInfo(result.executable)
      if (!info) throw new Error('The Codex installation changed, but its details were unavailable. Restart Velorn before continuing.')
      setCodexExecutable(info); setModels([]); setModelCatalogError(''); setConnection('')
      // Retain the exact selected model, even if absent in the new catalog.
      await checkConnection()
    } catch (failure) { if (current()) setExecutableError(failure.message) }
    finally {
      if (executableMutation.current === operation) {
        executableMutation.current = null
        if (mounted.current) setExecutableChanging(false)
      }
    }
  }
  async function signInCodex() {
    if (provider !== 'codex' || codexSetupState !== 'signin' || !api?.codexLogin || busy || checking
      || executableReading || executableMutation.current || fullAccessPending.current || fullAccessPreferencePending
      || spendingMutation.current || loading || isExportBusy()) return
    const operation = { chatId: conversations.activeId }
    codexLoginOperation.current = operation; executableMutation.current = operation
    setCodexLoginPending(true); setExecutableChanging(true); setCodexLoginError(''); setExecutableError('')
    // Account changes never inherit an old account's remembered authority.
    revokeFullAccess()
    setFullAccessPreference({ scope: fullAccessScope, checked: true, remembered: false })
    const current = () => codexLoginOperation.current === operation && connectionContextIsCurrent(operation.chatId)
    try {
      const result = await api.codexLogin({ action: 'start' })
      if (!current()) return
      if (result?.cancelled) { setCodexLoginError('Sign-in cancelled. No message was sent.'); return }
      if (!result?.success) throw new Error(result?.error || 'Codex sign-in could not finish. Try again or use Setup help.')
      // Native login has ended; its account must still pass the normal check.
      await checkConnection()
    } catch (failure) { if (current()) setCodexLoginError(failure.message || 'Codex sign-in could not finish.') }
    finally {
      if (codexLoginOperation.current === operation) codexLoginOperation.current = null
      if (executableMutation.current === operation) {
        executableMutation.current = null
        if (mounted.current) { setCodexLoginPending(false); setExecutableChanging(false) }
      }
    }
  }
  async function cancelCodexLogin() {
    if (!codexLoginOperation.current) return
    try {
      const result = await api.codexLogin({ action: 'cancel' })
      if (!result?.success && mounted.current) setCodexLoginError(result?.error || 'Sign-in could not be cancelled. Please wait for it to finish.')
    } catch { if (mounted.current) setCodexLoginError('Sign-in could not be cancelled. Please wait for it to finish.') }
  }
  function checkConnection() {
    if (!fundedLuna) return performConnectionCheck()
    const accountKey = lunaAccountKey.current
    const key = JSON.stringify([projectKey, conversations.activeId, accountKey])
    if (lunaCheckInFlight.current?.key === key) return lunaCheckInFlight.current.promise
    const previous = lunaCheckInFlight.current
    const operation = { key }
    operation.promise = Promise.resolve().then(async () => {
      // Native inspection is single-flight. Let the old account's read settle,
      // discard its result, then inspect the latest context (never in parallel).
      await previous?.promise
      if (connectionContextIsCurrent(conversations.activeId) && accountKey === lunaAccountKey.current) return performConnectionCheck()
    }).finally(() => {
      if (lunaCheckInFlight.current === operation) lunaCheckInFlight.current = null
    })
    lunaCheckInFlight.current = operation
    return operation.promise
  }
  async function performConnectionCheck(checkEndpoint = endpoint) {
    if (provider === 'codex') checkedCodexModels.current = true
    if (!api) { setConnection('Fully quit and reopen Velorn to enable the native agent connection.'); return }
    const epoch = ++connectionEpoch.current, chatId = conversations.activeId, choiceEpoch = modelChoiceEpoch.current
    const accountKey = lunaAccountKey.current
    const current = () => epoch === connectionEpoch.current && connectionContextIsCurrent(chatId)
      && (!fundedLuna || accountKey === lunaAccountKey.current)
    setChecking(true); setConnection('Checking…'); setModelCatalogError(''); setExecutableError(''); setCodexLoginError('')
    if (provider === 'codex') void refreshCodexExecutable()
    try {
      const result = await api.inspect({ provider, ...(fundedLuna ? {} : { endpoint: checkEndpoint }), model: currentModelChoice.current.model })
      if (!current()) return
      entryGuide.observe(result)
      if (provider === 'codex' && result?.executable) {
        const info = codexExecutableInfo(result.executable)
        if (info) setCodexExecutable(info)
      }
      if (!result?.success) throw Object.assign(new Error(result?.error || 'The agent is not available yet.'), { code: result?.code })
      if (fundedLuna) setLunaConnection({ ...fundedLunaAvailability(result), accountKey })
      if (provider === 'codex') setCodexSetupState(result.available === false
        ? result.code === 'CODEX_NOT_FOUND' ? 'missing'
          : codexAuthRequired(result.code) ? 'signin' : 'problem'
        : result.available === true || !codexAuthRecovery.current ? 'ready' : 'signin')
      if (provider === 'codex' && result.available === true) {
        // A login process exiting successfully is not account verification.
        // Clear only this chat's active recovery notice, never old history or
        // an unrelated error that appeared while the check was in progress.
        const recovery = codexAuthRecovery.current
        setError(previous => previous === CODEX_SETUP_REQUIRED
          || (recovery?.chatId === chatId && previous === recovery.notice) ? '' : previous)
        codexAuthRecovery.current = null
      }
      const seen = new Set()
      const options = (Array.isArray(result.models) ? result.models : []).slice(0, 256)
        .map(item => typeof item === 'string' ? { id: item } : item)
        .filter(item => {
          if (typeof item?.id !== 'string' || !item.id || item.id.length > 256 || item.id === '__custom__' || seen.has(item.id)) return false
          seen.add(item.id)
          return true
        })
      // A failed refresh must not remove the user's choice (or a previous
      // usable catalog). Codex default is always an empty override, never the
      // first entry in a changing catalog.
      if (provider !== 'codex' || options.length || result.modelCatalogStatus === 'available') setModels(options)
      if (provider === 'lmstudio') {
        setLoadedModelStatus(result.loadedModelStatus === 'available' ? 'available' : 'unavailable')
        // Native success proves the metadata endpoint responded. `available`
        // instead describes whether its catalog contains a usable chat model.
        setLmStudioCheck({ connected: true, endpoint: checkEndpoint, error: '' })
      }
      if (provider === 'codex') setModelCatalogError(result.available === false ? '' : result.modelCatalogError
        || (!options.length && result.modelCatalogStatus !== 'not-requested'
          ? 'The Codex model list is unavailable. You can still use Codex default or enter a custom model ID.' : ''))
      if (provider === 'lmstudio' && !currentModelChoice.current.model && !currentModelChoice.current.custom
        && !setupModelHandoffRef.current && options[0] && choiceEpoch === modelChoiceEpoch.current) { setModel(options[0].id); saveSettings({ lmstudioModel: options[0].id }) }
      setConnection(fundedLuna ? fundedLunaAvailability(result).message : result.message || (provider === 'codex' ? 'Codex connection is ready.' : `${options.length} model${options.length === 1 ? '' : 's'} available in LM Studio.`))
    } catch (e) {
      if (current()) {
        entryGuide.observe({ success: false, code: e.code })
        setConnection(e.message)
        if (fundedLuna) setLunaConnection({ ...fundedLunaAvailability(null), accountKey })
        if (provider === 'codex') setCodexSetupState(e.code === 'CODEX_NOT_FOUND' ? 'missing'
          : codexAuthRequired(e.code) ? 'signin' : 'problem')
        if (provider === 'lmstudio') { setLoadedModelStatus('unavailable'); setLmStudioCheck({ connected: false, endpoint: checkEndpoint, error: e.message }) }
        if (provider === 'codex') setModelCatalogError(e.code === 'CODEX_NOT_FOUND'
          ? 'Codex CLI was not found. Choose its executable below; the model list can load after the connection is available.'
          : 'The Codex model list is unavailable. You can still use Codex default or enter a custom model ID.')
      }
    }
    finally { if (current()) setChecking(false) }
  }
  useEffect(() => {
    // Read-only metadata, requested only when the user opens these settings.
    // No model turn, project context, image sharing or sign-in is started here.
    if (provider !== 'codex' || (!settingsOpen && !modelPickerOpen) || !visible || busy || executableChanging) return
    // Defer until the view settles: StrictMode's mount probe and a project
    // switch closing settings must not start duplicate/stale native checks.
    const epoch = executableEpoch.current
    const timer = setTimeout(() => {
      if (!mounted.current || epoch !== executableEpoch.current
        || getStoryboardProjectKey(useProjectStore.getState().currentProject, useProjectStore.getState().currentProjectHandle) !== projectKey) return
      // Reopening settings checks local installation metadata without loading
      // the catalog again or starting a provider turn. Explicit Check connection
      // supersedes a scheduled refresh through the metadata epoch above.
      if (checkedCodexModels.current) void refreshCodexExecutable()
      else void checkConnection()
    }, 0)
    return () => clearTimeout(timer)
  }, [provider, settingsOpen, modelPickerOpen, visible, busy, executableChanging])
  useEffect(() => {
    // Model discovery is read-only. Refresh whenever local settings open so a
    // loaded model is selectable without finding a second connection button.
    if (provider !== 'lmstudio' || (!settingsOpen && !modelPickerOpen) || !visible || busy) return
    const epoch = connectionEpoch.current
    const timer = setTimeout(() => {
      if (mounted.current && epoch === connectionEpoch.current
        && getStoryboardProjectKey(useProjectStore.getState().currentProject, useProjectStore.getState().currentProjectHandle) === projectKey) void checkConnection()
    }, 200)
    return () => clearTimeout(timer)
  }, [provider, settingsOpen, modelPickerOpen, visible, busy, endpoint])
  const selectedCatalogModel = models.find(item => item.id === model)
  const localModelSupport = localModelSupportPresentation(selectedCatalogModel?.support)
  const thinkingModel = selectedCatalogModel || (!model ? models.find(item => item.isDefault) : undefined)
  const availableThinking = provider === 'codex' ? thinkingOptions(thinkingModel) : []
  // Velo's policy applies even with an old native catalog or saved chat effort.
  // Do not rewrite historical receipts or the user's independent Codex choice.
  const thinkingLevel = fundedLuna ? FUNDED_LUNA_REASONING : provider === 'codex' ? selectedThinkingLevel(thinkingPreference, thinkingModel) : undefined
  const changeThinking = value => {
    if (provider !== 'codex' || busy || loading || fullAccessPending.current || executableMutation.current || isExportBusy()
      || !availableThinking.some(item => item.id === value)) throw Error('Refresh the model list and choose a supported thinking level.')
    // Chat selection takes precedence over global preferences on remount.
    // Persist the next-request effort immediately, without creating a chat,
    // relabelling prior replies, or revoking the current access grant.
    setConversations(history.write(projectKey, provider, conversations.activeId, messages, { model, reasoningEffort: value }))
    setThinkingPreference(value)
    saveSettings({ codexReasoningEffort: value })
  }
  const visibleSelectedModel = sanitizeConnectedAgentRequestedModel(model)
  const codexSetupBlocked = provider === 'codex' && ['missing', 'signin', 'problem'].includes(codexSetupState)
  const codexNeedsSetup = provider === 'codex' && (codexSetupBlocked || (codexSetupState === 'unknown' && !model && !models.length))
  const selectedModelLabel = visibleSelectedModel === undefined ? 'Model ID unavailable'
    : visibleSelectedModel || (provider === 'codex' ? codexNeedsSetup ? 'Connect Codex to choose a model' : 'Codex default' : 'No model selected')
  const useCustomModel = customModelMode || Boolean(model && !selectedCatalogModel)
  const rememberSelection = () => {
    drafts.current.set(conversations.activeId, draft)
    attachmentDrafts.current.set(conversations.activeId, attachments)
    return history.write(projectKey, provider, conversations.activeId, messages, { model, reasoningEffort: thinkingPreference })
  }
  const selectionDisabled = !canManageChats || checking || executableChanging || exportBusy || Boolean(deleteChatId)
  const showEntryGuide = !entryState.dismissed && !settingsOpen && !modelPickerOpen && !codexSetupOpen && !lmStudioSetupOpen && !busy
    && ['choice', 'unconfigured', 'problem'].includes(entryState.phase)
  const showAssistantChoice = showEntryGuide && entryState.phase === 'choice'
  const openCodexSetup = (shouldCheck = true) => {
    if (provider !== 'codex' || selectionDisabled) return
    entryGuide.acknowledge(); setSetupHelperOpen(false); setPendingProvider(null)
    setSetupModelHandoff(false); setupModelHandoffRef.current = false
    setModelPickerOpen(false); onSettingsOpen(false); setCodexSetupOpen(true)
    if (shouldCheck) void checkConnection()
  }
  const openSetupHelper = () => {
    if (provider === 'codex') { openCodexSetup(); return }
    if (provider === 'lmstudio') { openLmStudioSetup(); return }
    entryGuide.acknowledge(); setSetupHelperOpen(true)
  }
  const openLmStudioSetup = () => {
    // A first-choice provider handoff can arrive while its saved permission
    // preference is still being read. Opening this read-only view is safe;
    // its actions remain disabled until that read settles.
    if (provider !== 'lmstudio' || !visible || busy || loading || checking || fullAccessChanging || spendingChanging
      || executableChanging || codexInstallBusy || lmStudioAppBusy || exportBusy || deleteChatId) return
    // Set the synchronous guard before discovery so no result chooses the
    // first catalog model on the user's behalf, including an in-flight result.
    setupModelHandoffRef.current = true
    entryGuide.acknowledge(); setSetupHelperOpen(false); setPendingProvider(null)
    setSetupModelHandoff(false); setModelPickerOpen(false); onSettingsOpen(false)
    setLmStudioSetupOpen(true); void checkConnection()
  }
  const openSetupModelPicker = (fromSetup = true) => {
    // Synchronous guard also covers a catalog request started before this
    // handoff. Discovery must not turn into an implicit first-model choice.
    if (provider === 'codex' && codexNeedsSetup) { openCodexSetup(); return }
    if (provider === 'lmstudio' && (fromSetup || !model.trim())) { openLmStudioSetup(); return }
    setupModelHandoffRef.current = fromSetup && provider === 'lmstudio'
    setSetupHelperOpen(false); onSettingsOpen(false)
    setCustomModelDraft(model); setSetupModelHandoff(fromSetup && provider === 'lmstudio'); setModelPickerOpen(true)
  }
  useLayoutEffect(() => {
    if (!setupModelPickerRef) return
    setupModelPickerRef.current = openSetupModelPicker
    return () => { setupModelPickerRef.current = null }
  // Keep external setup handoffs current when readiness or busy state changes,
  // even when the chosen model remains the default empty string.
  })
  useEffect(() => {
    if (!setupModelHandoff || !modelPickerOpen || settingsOpen || !visible || selectionDisabled) return
    // Wait for the setup dialog to restore inert/focus before focusing the
    // existing picker. This opens controls only; it never selects a provider.
    const timer = setTimeout(() => {
      providerPicker.current?.focus({ preventScroll: true })
      const picker = providerPicker.current?.closest('.ca-chat-model-picker')
      if (picker) picker.scrollTop = 0
    }, 0)
    return () => clearTimeout(timer)
  }, [setupModelHandoff, modelPickerOpen, settingsOpen, visible, selectionDisabled])
  const changeProvider = (next, options = {}) => {
    if (selectionDisabled || next === provider || !CONNECTED_AGENT_PROVIDERS.includes(next)) return false
    try {
      rememberSelection()
      history.create(projectKey, next, { model: connectedAgentModelSelection(next, readSettings()[`${next}Model`]), ...(next === 'codex' ? { reasoningEffort: thinkingPreference } : {}) })
      onSettingsOpen(false); onProviderChange(next, { showModelPicker: modelPickerOpen, setupHandoff: setupModelHandoff, ...options })
      return true
    } catch (failure) { setError(failure.message || 'A new chat could not be created.'); return false }
  }
  const chooseFirstAssistant = next => {
    // Explicit selection only. Reuse the normal provider/chat boundary, never
    // authentication, permission grants, model loading or a message submission.
    if (!showAssistantChoice || entryGuide.getSnapshot().phase !== 'choice' || selectionDisabled || !CONNECTED_AGENT_PROVIDERS.includes(next)) return
    if (next === provider) {
      saveSettings({ provider: next }); entryGuide.acknowledge()
      if (next === 'codex') openCodexSetup()
      else if (next !== 'luna') openSetupModelPicker(true)
      else focusComposer.current = true
    } else if (changeProvider(next, { showModelPicker: next !== 'luna', setupHandoff: true })) {
      entryGuide.acknowledge()
    }
  }
  useEffect(() => {
    if (provider !== 'codex' || !codexSetupOpen || checking || codexLoginPending || codexInstallBusy || codexSetupState !== 'ready') return
    setCodexSetupOpen(false); entryGuide.acknowledge(); focusComposer.current = true
  }, [provider, codexSetupOpen, codexSetupState, checking, codexLoginPending, codexInstallBusy, entryGuide])
  useEffect(() => {
    // Recovery and provider-switch handoffs converge on the same panel. No
    // general tools chooser or installation-selection mutation is involved.
    if (provider === 'codex' && modelPickerOpen && codexNeedsSetup && !selectionDisabled && !codexSetupOpen) {
      // A send-time authentication failure is already authoritative. Preserve
      // it until explicit sign-in/check; another inspection could race a stale
      // pre-failure result or make recovery wait on a background request.
      openCodexSetup(!codexAuthRecovery.current)
    }
  }, [provider, modelPickerOpen, codexNeedsSetup, selectionDisabled, codexSetupOpen])
  useEffect(() => { if (!settingsOpen && !modelPickerOpen) setPendingProvider(null) }, [settingsOpen, modelPickerOpen])
  const changeModel = value => {
    if (selectionDisabled || fundedLuna) return false
    const next = value.trim().slice(0, 256)
    if (next === model) return true
    if (provider === 'lmstudio' && !next) return false
    try {
      // A model is the next-request selection, not a conversation boundary.
      // Keep this provider's transcript, draft, attachments and access grant.
      setConversations(history.write(projectKey, provider, conversations.activeId, messages, { model: next, reasoningEffort: thinkingPreference }))
      modelChoiceEpoch.current++
      setModel(next); currentModelChoice.current = { model: next, custom: false }
      saveSettings({ [`${provider}Model`]: next })
      setCustomModelMode(false); setCustomModelDraft(''); setModelPickerOpen(false)
      setError('')
      focusComposer.current = true
      onSettingsOpen(false)
      return true
    } catch (failure) { setError(failure.message || 'The model selection could not be saved.'); return false }
  }
  const useLmStudioModel = value => {
    if (provider !== 'lmstudio' || !lmStudioSetupOpen || !lmStudioCheck.connected || lmStudioCheck.endpoint !== endpoint || !value.trim()) return
    if (!changeModel(value)) return
    setLmStudioSetupOpen(false); entryGuide.acknowledge(); focusComposer.current = true
  }
  const saveLmStudioEndpoint = value => {
    if (provider !== 'lmstudio' || selectionDisabled || !lmStudioSetupOpen) return
    setEndpoint(value); saveSettings({ endpoint: value }); setModels([])
    setLoadedModelStatus('unchecked'); setLmStudioCheck({ connected: false, endpoint: value, error: '' })
    void performConnectionCheck(value)
  }
  const stop = event => {
    // React can reuse this DOM button for Send before the click's default
    // action. Never let a Stop click become a fresh form submission.
    event?.preventDefault()
    const requestId = activeRequest.current
    activeRequest.current = null
    if (requestId && messages.at(-1)?.role === 'user' && messages.at(-1)?.turnId === requestId) {
      storeMessages([...messages, { role: 'assistant', turnId: requestId, text: 'Stopped. Any completed actions and captured previews remain available.', deliveryStatus: 'failed' }])
    }
    approvalRecords.current.clear(); setApprovals([])
    if (requestId) void api?.cancel?.({ requestId }).catch(() => {})
    setLiveActivity(previous => previous.map(item => item.status === 'running' ? { ...item, status: 'stopped' } : item))
    setBusy(false); setPreparing(false); setPartial(''); setStatus(fullAccessEnabled
      ? 'Stopped. Completed computer actions may have changed files or services and cannot necessarily be undone.'
      : requestToolsEnabled.current ? 'Stopped. Any completed tool actions remain in the project; use Undo where available.'
        : 'Stopped. No changes were made.')
  }
  async function attachFiles(files) {
    if (busy || loading || fullAccessPending.current || attachmentRead.current || isExportBusy() || !visible || settingsOpen || deleteChatId) return
    const batch = Array.from(files || [])
    if (!batch.length) return
    if (attachments.length + batch.length > 4) { setError('Attach at most four files per message.'); return }
    const epoch = ++attachmentEpoch.current, chatId = conversations.activeId
    const stillCurrent = () => mounted.current && attachmentEpoch.current === epoch && activeChatId.current === chatId
      && !useProjectStore.getState().isLoading
      && getStoryboardProjectKey(useProjectStore.getState().currentProject, useProjectStore.getState().currentProjectHandle) === projectKey
    attachmentRead.current = true; setAttaching(true); setError('')
    try {
      const items = []
      for (const file of batch) { items.push(await readChatAttachment(file)); if (!stillCurrent()) return }
      if (isExportBusy()) throw new Error('Export paused attachments. Please attach them again when export finishes.')
      setAttachments(checkAttachmentBatch([...attachments, ...items]))
    } catch (failure) { if (stillCurrent()) setError(failure.message || 'The attachment could not be read.') }
    finally { if (stillCurrent()) { attachmentRead.current = false; setAttaching(false) } }
  }
  async function decideApproval(approvalId, approved, fromPhone = false) {
    const approval = approvalRecords.current.get(approvalId)
    if (!approval || approval.state !== 'pending' || !mounted.current || !busy || (!fromPhone && !latestVisible.current)
      || (approved && (!approval.reviewable || isExportBusy()))
      || activeRequest.current !== approval.requestId || useProjectStore.getState().isLoading
      || getStoryboardProjectKey(useProjectStore.getState().currentProject, useProjectStore.getState().currentProjectHandle) !== projectKey) return { success: false, error: 'This approval is no longer available.' }
    // Update the ref before awaiting IPC so a double click or replayed event
    // cannot answer the same one-use approval twice.
    approvalRecords.current.set(approvalId, { ...approval, state: 'answered' })
    setApprovals(previous => previous.map(item => item.approvalId === approvalId ? { ...item, state: 'sending' } : item))
    try {
      if (!api?.approveTool) throw new Error('Restart Velorn to enable tool approvals.')
      const result = await api.approveTool({ requestId: approval.requestId, approvalId, approved })
      if (!mounted.current || activeRequest.current !== approval.requestId) return
      if (!result?.success) throw new Error(result?.error || 'This tool approval is no longer available.')
      setApprovals(previous => previous.filter(item => item.approvalId !== approvalId))
      return { success: true, status: 'completed' }
    } catch (failure) {
      if (!mounted.current || activeRequest.current !== approval.requestId) return
      stop()
      setError(`${failure.message} The request was stopped; inspect the project before retrying.`)
      return { success: false, error: failure.message }
    }
  }
  const aiSharingCapabilities = { tools: toolsEnabled, research: toolsEnabled && researchEnabled,
    fullAccess: fullAccessEnabled && toolsEnabled, images: shareImages && (provider !== 'lmstudio' || localVision),
    view: shareImages && shareView && (provider !== 'lmstudio' || localVision) }
  const currentAISharing = useRef(null)
  currentAISharing.current = { provider, capabilities: aiSharingCapabilities }
  async function send(event, phoneText, phoneSharing) {
    event?.preventDefault()
    const fromPhone = typeof phoneText === 'string'
    if (fundedLuna && fromPhone && !phoneSharing) return { success: false, error: 'Velo requires an updated phone AI-sharing permission for Velorn and OpenAI. No message was sent.' }
    if (phoneSharing && (!fromPhone || api?.aiSharingVersion !== 1 || phoneSharing.consent?.provider !== provider
      || JSON.stringify(phoneSharing.capabilities) !== JSON.stringify(aiSharingCapabilities))) {
      return { success: false, error: 'AI sharing settings changed. No message was sent. Review the permission on your phone and try again.' }
    }
    const outgoingDraft = fromPhone ? phoneText.slice(0, 4000) : draft
    const outgoingAttachments = fromPhone ? [] : attachments
    if (busy || activeRequest.current || fullAccessPending.current || fullAccessPreferencePending || executableMutation.current || spendingMutation.current || loading || attachmentRead.current || isExportBusy() || (!fromPhone && (!visible || settingsOpen)) || deleteChatId || (!outgoingDraft.trim() && !outgoingAttachments.length)) return { success: false, error: 'The desktop is busy or unavailable. No message was sent.' }
    entryGuide.acknowledge()
    if (!api?.send) { setError('Fully quit and reopen Velorn to enable the native agent connection.'); return }
    if (fundedLuna && (!lunaConnection.available || lunaConnection.accountKey !== lunaAccountKey.current || checking)) {
      const message = checking || lunaConnection.accountKey !== lunaAccountKey.current
        ? 'Checking Velo availability. Please try again once it is ready.' : lunaConnection.message
      const notice = `${message} No message was sent. Your draft is preserved.`
      setError(notice)
      return { success: false, error: notice }
    }
    if (codexSetupBlocked) {
      if (!modelPickerOpen) setCustomModelDraft(model)
      setModelPickerOpen(true); setError(CODEX_SETUP_REQUIRED)
      return { success: false, error: 'Codex needs setup on the desktop. No message was sent.' }
    }
    if (provider === 'codex' && api.reasoningControlVersion !== 1) { setError('Fully quit and reopen Velorn before using Thinking level. The running native connection cannot apply this setting yet; no message was sent.'); return }
    if (provider === 'lmstudio' && !model.trim()) { entryGuide.observe({ success: true, available: false }); setError('Choose a loaded LM Studio model in Assistant settings first.'); return }
    if (outgoingAttachments.some(item => item.kind === 'image') && provider === 'lmstudio' && !localVision) { setError('Enable a vision-capable LM Studio model in Assistant settings, or remove the attached images.'); return }
    const requestId = `review-${crypto.randomUUID()}`
    // Freeze the exact Send choice before any asynchronous image preparation.
    // This is request metadata only, never confirmation of execution or billing.
    const requestedModel = model
    const requestedReasoningEffort = thinkingLevel
    // Phone and desktop drive the same conversation and native permission grant.
    const fullAccess = fullAccessEnabled && toolsEnabled
    const fullAccessToken = fullAccess ? fullAccessGrant.current?.token : undefined
    if (fullAccess && (!fullAccessToken || fullAccessGrant.current?.conversationId !== conversations.activeId)) {
      revokeFullAccess(); setError('Full access has expired. Enable it again in Assistant settings.'); return
    }
    activeRequest.current = requestId
    reviewChat.current = conversations.activeId
    timingRequest.current = requestId; setRunTiming(null)
    requestToolsEnabled.current = toolsEnabled
    approvalRecords.current.clear(); setApprovals([]); setLiveActivity([]); structuredProgress.current = false
    setRequestModel(requestedModel)
    setRequestThinking(requestedReasoningEffort)
    setRequestFromPhone(fromPhone)
    setBusy(true); setPreparing(true); setError(''); setPartial(''); setServiceWaiting(false); setStatus('Gathering the current project view…')
    const isCurrent = () => mounted.current && activeRequest.current === requestId
      && !useProjectStore.getState().isLoading
      && getStoryboardProjectKey(useProjectStore.getState().currentProject, useProjectStore.getState().currentProjectHandle) === projectKey
    const allowPublicUrls = toolsEnabled && (researchEnabled || fullAccess)
    const typedPrompt = outgoingDraft.trim() || 'Please inspect the attached files. Do not make changes yet.'
    const prompt = redactConnectedAgentText(typedPrompt, undefined, { allowPublicUrls })
    const documents = outgoingAttachments.filter(item => item.kind === 'json').map(item => ({ name: item.name, text: item.text }))
    const sourceUrls = allowPublicUrls ? collectConnectedAgentSourceUrls(prompt) : []
    const context = currentContext()
    // Native-only stale-project guard. Never put handles/paths in model context.
    const expectedContext = captureMcpContext()
    const initialEditorView = editorViewIdentity()
    const initialViewEpoch = viewEpoch.current
    const vision = provider !== 'lmstudio' || localVision
    const images = outgoingAttachments.filter(item => item.kind === 'image').map(item => ({ label: `Attached image: ${item.name}`, dataUrl: item.dataUrl })), missingImages = []
    // Export preparation and queue gaps count too. Remember an intervening
    // export even if it finishes before an awaited image/capture comes back.
    // This guards only preparation: an already-sent reply keeps streaming.
    let exportInterrupted = false
    const stopWatchingExport = useExportActivityStore.subscribe(() => {
      if (isExportBusy()) exportInterrupted = true
    })
    const assertCanPrepare = () => {
      if (exportInterrupted || isExportBusy()) throw new Error('Export paused this message before it was sent. Your draft is preserved; send it again when export finishes.')
    }
    let submittedMessages = null
    try {
      assertCanPrepare()
      if (shareImages && vision) {
        const candidates = selectConnectedAgentImageCandidates({ context, prompt, visibleShotIds: context.visibleShotIds })
        const availableSlots = Math.max(0, (shareView && currentViewAvailable ? 4 : 5) - images.length)
        for (const candidate of candidates.slice(0, availableSlots)) {
          if (!isCurrent()) return
          assertCanPrepare()
          const asset = assets.find(item => item.id === candidate.assetId)
          try { images.push({ label: `${candidate.label} (${candidate.shotId})`, dataUrl: await smallImage(asset, assertCanPrepare) }) }
          catch { assertCanPrepare(); missingImages.push(candidate.label) }
        }
      }
      if (shareImages && shareView && vision && currentViewAvailable && workspaceRef?.current && (!fromPhone || (latestVisible.current && !settingsOpen))) {
        const assertCurrentView = () => {
          assertCanPrepare()
          if (!latestVisible.current) throw new Error('The Agent panel was hidden while preparing images. Reopen it and send again.')
          if (latestTab.current !== activeTab) throw new Error('The workspace changed while preparing images. Please send again from the view you want to discuss.')
          if (viewEpoch.current !== initialViewEpoch) throw new Error('The workspace changed while preparing images. Please send again from the view you want to discuss.')
          if (activeTab === 'editor' && editorViewIdentity() !== initialEditorView) throw new Error('The timeline or playhead changed while preparing its view. Pause playback and send again from the view you want to discuss.')
        }
        assertCurrentView()
        const target = workspaceRef.current
        const rectangle = () => {
          const bounds = target.getBoundingClientRect()
          return { x: Math.ceil(bounds.x), y: Math.ceil(bounds.y), width: Math.floor(bounds.width), height: Math.floor(bounds.height) }
        }
        const rect = rectangle()
        let resized = false
        const observer = new ResizeObserver(() => { if (JSON.stringify(rectangle()) !== JSON.stringify(rect)) resized = true })
        observer.observe(target)
        let result
        try { assertCanPrepare(); result = await api.capture({ rect }) } finally { observer.disconnect() }
        assertCurrentView()
        if (target !== workspaceRef.current || resized || JSON.stringify(rectangle()) !== JSON.stringify(rect)) {
          throw new Error('The viewer layout changed while capturing its view. Keep the layout steady and send again.')
        }
        if (result.success && result.dataUrl) images.push({ label: `Current ${activeTab === 'editor' ? 'editor viewer' : 'storyboard workspace'} (single snapshot, not playback)`, dataUrl: result.dataUrl })
        else missingImages.push('Current view')
      }
      if (!isCurrent()) return
      assertCanPrepare()
      if (phoneSharing && (currentAISharing.current.provider !== phoneSharing.consent.provider
        || JSON.stringify(currentAISharing.current.capabilities) !== JSON.stringify(phoneSharing.capabilities))) {
        throw new Error('AI sharing settings changed while preparing. No message was sent. Review the permission on your phone and try again.')
      }
      if (!fromPhone && !latestVisible.current) throw new Error('The Agent panel was hidden while preparing images. Reopen it and send again.')
      context.mobileVideoReview = {
        supported: mobile.available === true, sharingEnabled: mobile.enabled === true,
        phonePaired: mobile.connection?.paired === true, shareMediaEnabled: shareImages,
        delivery: 'The local phone companion attaches completed native Velorn video exports to the agent reply that started them when paired and Share images is enabled. Saved review stills and export references are restored from the project after desktop restarts; no duplicate render or upload is needed. Other saved exports are under Settings > Project exports. This is not confirmation that the phone received or played a video. If absent, check Project exports, sharing, and any file-unavailable message, then refresh the phone page; do not recommend cloud upload or re-export as the first step. Direct shell exports and exports made before durable review history was introduced are not automatically listed.',
      }
      context.mobileAudioReview = {
        supported: mobile.available === true, sharingEnabled: mobile.enabled === true,
        phonePaired: mobile.connection?.paired === true, shareMediaEnabled: shareImages,
        delivery: 'Completed project audio and imported video can appear as persistent players in desktop and paired-phone chat replies. Tool receipts link generated media to the originating turn; players stay with that reply and restore after restart. To show existing takes or videos here, first inspect get_assets, then call get_assets with their exact assetIds and showInChat:true. This attaches existing files to this reply without regeneration, export, duplicate import or cloud upload. Users can also choose Show project media here from a desktop reply’s options menu to recover older unlinked takes. Phone review-media sharing (Share images or Full access) must be enabled. Check actual tool results before saying a take is ready. External files must first be imported into the project. Playback depends on device codecs; do not claim the user received or heard it. This shares media with the user, not with the model.',
      }
      context.visualReview = { attachedLabels: images.map(image => image.label), unavailable: missingImages,
        note: fullAccess && fullComputerAccessEnabled && (!fundedLuna || !fromPhone) ? 'These are the automatic or explicit attachments only. Full computer access can independently read accessible media; do not claim to have inspected media without actually reading it.'
          : images.length ? 'Only these still images were shared. No audio or moving video was shared.' : 'Text context only. Do not claim to have seen images or watched playback.' }
      // History keeps receipts, not file contents. Attachments are shared only
      // on this turn; future turns must ask for them again when needed.
      const receipt = outgoingAttachments.length ? `\n\nAttached for this message only: ${outgoingAttachments.map(item => `${item.name} (${item.kind})`).join(', ')}` : ''
      const next = sanitizeConnectedAgentMessages([...messages, { role: 'user', turnId: requestId, text: prompt + receipt, ...(sourceUrls.length ? { sourceUrls } : {}) }])
      storeMessages(next)
      submittedMessages = next
      if (!fromPhone) {
        // Preparation can await previews while the composer remains editable.
        // Clear only the submitted values, never a newer draft.
        if (currentComposer.current.draft === outgoingDraft) {
          currentComposer.current.draft = ''
          setDraft(''); drafts.current.delete(conversations.activeId)
        }
        if (currentComposer.current.attachments === outgoingAttachments) {
          currentComposer.current.attachments = []
          setAttachments([]); attachmentDrafts.current.delete(conversations.activeId)
        }
      }
      setLastShared({ tab: activeTab, count: images.length, labels: images.map(image => image.label), missing: missingImages })
      setStatus(fundedLuna ? 'Discussing with Velo…' : provider === 'codex' ? 'Discussing with Codex…' : 'Thinking locally…')
      stopWatchingExport()
      setPreparing(false)
      const result = await api.send({ requestId, provider, ...(fundedLuna ? {} : { endpoint }), model: requestedModel, vision,
        ...(phoneSharing ? { mobileSharing: { commandId: phoneSharing.commandId, consent: phoneSharing.consent, view: aiSharingCapabilities.view } } : {}),
        ...(provider !== 'lmstudio' ? { reasoningEffort: requestedReasoningEffort } : {}),
        toolsEnabled, researchEnabled: toolsEnabled && researchEnabled, expectedContext, allowToolImages: shareImages && vision,
        fullAccess, fullAccessToken, conversationId: conversations.activeId,
        autoApproveEdits: toolsEnabled && !fullAccess && autoApproveEdits, documents,
        // Saved source references retain display text, not permission to share
        // links again after Research & setup has been switched off.
        // Full mode shares only this explicit prompt as typed, so user-selected
        // paths/URLs reach the computer runtime. Durable history and automatic
        // context stay sanitized; granting access never unredacts old messages.
        messages: next.filter(message => !agentStatusMessage(message)).slice(-24).map((message, index, outbound) => ({ role: message.role,
          content: fullAccess && index === outbound.length - 1 ? typedPrompt
            : redactConnectedAgentText(message.text, undefined, { allowPublicUrls, sourceUrls: message.sourceUrls || [] }) })), context, images })
      if (!isCurrent()) return
      if (!result?.success) {
        if (fullAccess && ['UNAUTHORIZED', 'STALE_APPROVAL'].includes(result?.code)) revokeFullAccess()
        throw Object.assign(new Error(result?.error || 'The agent could not finish this response.'), { code: result?.code,
          promptNotSent: result?.promptNotSent === true,
          toolReceipts: sanitizeAgentToolReceipts(result?.toolReceipts), localDiagnostics: sanitizeAgentLocalDiagnostics(result?.localDiagnostics) })
      }
      // Only a completed reply with an exact root loopback candidate asks the
      // native setup reader for fresh configured-connection proof. No mount
      // probes, model-supplied flags, port selection, or link opening. Timeout
      // and failed checks retain ordinary redaction rather than hold the reply.
      let verifiedComfySetup
      if (containsLocalComfyAddress(result.text) && typeof window.electronAPI?.optionalSetup?.inspect === 'function') {
        let timeout
        try {
          verifiedComfySetup = await Promise.race([
            Promise.resolve().then(() => window.electronAPI.optionalSetup.inspect({ integration: 'comfyui' })),
            new Promise(resolve => { timeout = setTimeout(() => resolve(undefined), 3500) }),
          ])
        } catch { /* Unavailable verification never promotes a private URL. */ }
        finally { clearTimeout(timeout) }
        if (!isCurrent()) return
      }
      // Verified local roots become inert prose before saving. Public citations
      // likewise grant no research/tool permission.
      const formatted = formatConnectedAgentResponse(result.text || '', context, { allowPublicUrls: true, verifiedComfySetup })
      if (!formatted.text.trim()) throw Object.assign(new Error('The model returned no conversation text.'), {
        code: 'EMPTY_RESPONSE', toolReceipts: sanitizeAgentToolReceipts(result?.toolReceipts) })
      storeMessages([...next, { role: 'assistant', turnId: requestId, ...formatted, requestedModel,
        ...(sanitizeAgentToolReceipts(result.toolReceipts) ? { toolReceipts: sanitizeAgentToolReceipts(result.toolReceipts) } : {}),
        ...(requestedReasoningEffort ? { requestedReasoningEffort } : {}) }])
      onHighlight?.(formatted.shotIds)
      setPartial(''); setStatus('')
      return { success: true, status: 'completed' }
    } catch (e) {
      if (isCurrent()) {
        const detail = redactConnectedAgentText(`${typeof e.code === 'string' && /^[A-Z_]{1,80}$/.test(e.code) ? `[${e.code}] ` : ''}${e.message || 'The request could not finish.'}`, 1800)
        const toolReceipts = sanitizeAgentToolReceipts(e.toolReceipts), localDiagnostics = sanitizeAgentLocalDiagnostics(e.localDiagnostics)
        const needsCodexSignIn = provider === 'codex' && codexAuthRequired(e.code)
        if (needsCodexSignIn || ['CODEX_NOT_FOUND', 'CODEX_PROCESS_TERMINATED', 'CONNECTION_FAILED', 'MODEL_REQUIRED'].includes(e.code)) entryGuide.observe({ success: false, code: e.code })
        // An account can change mid-turn too. Only a native pre-prompt receipt
        // permits restoring the request or saying no prompt was sent.
        const authPromptNotSent = needsCodexSignIn && e.promptNotSent === true && !toolReceipts
        const lunaPromptNotSent = fundedLuna && e.promptNotSent === true && !toolReceipts
        // Request, network and provider failures do not establish lost account
        // access. Only explicit native/service access outcomes change this card;
        // every later send still performs its ordinary native access preflight.
        if (fundedLuna && ['LUNA_NOT_ELIGIBLE', 'LUNA_EXHAUSTED', 'LUNA_AUTH_REQUIRED'].includes(e.code)) {
          setLunaConnection(fundedLunaAvailability({ status: e.code === 'LUNA_NOT_ELIGIBLE' ? 'not-eligible' : e.code === 'LUNA_EXHAUSTED' ? 'exhausted' : 'unavailable' }))
        }
        let authNotice = ''
        let newerComposerPreserved = false
        if (lunaPromptNotSent && !fromPhone) {
          newerComposerPreserved = Boolean((currentComposer.current.draft && currentComposer.current.draft !== outgoingDraft)
            || (currentComposer.current.attachments.length && currentComposer.current.attachments !== outgoingAttachments))
          if (!newerComposerPreserved) {
            setDraft(outgoingDraft); drafts.current.set(conversations.activeId, outgoingDraft)
            setAttachments(outgoingAttachments); attachmentDrafts.current.set(conversations.activeId, outgoingAttachments)
          }
        }
        if (needsCodexSignIn) {
          connectionEpoch.current++; executableEpoch.current++
          checkedCodexModels.current = true
          setChecking(false); setExecutableReading(false)
          setCodexSetupState('signin'); setCodexLoginError(''); setExecutableError(''); setModelCatalogError('')
          setConnection('Your Codex session needs ChatGPT sign-in. Choose Sign in with ChatGPT to continue.')
          if (!modelPickerOpen) setCustomModelDraft(model)
          setModelPickerOpen(true)
          void revokeFullAccess({ forget: true })
          setFullAccessPreference({ scope: fullAccessScope, checked: true, remembered: false })
          if (authPromptNotSent && !fromPhone) {
            // Do not replay after sign-in. Restore the exact original text and
            // RAM-only attachments, not a redacted history representation.
            newerComposerPreserved = Boolean((currentComposer.current.draft && currentComposer.current.draft !== outgoingDraft)
              || (currentComposer.current.attachments.length && currentComposer.current.attachments !== outgoingAttachments))
            if (!newerComposerPreserved) {
              setDraft(outgoingDraft); drafts.current.set(conversations.activeId, outgoingDraft)
              setAttachments(outgoingAttachments); attachmentDrafts.current.set(conversations.activeId, outgoingAttachments)
            }
          }
          authNotice = authPromptNotSent
            ? `Sign in with ChatGPT to reconnect Codex. No prompt was sent. ${fromPhone ? 'Send your message again when you are ready.'
              : newerComposerPreserved ? 'Your newer draft is unchanged. The unsent message remains in this conversation.'
                : 'Your draft and attachments are ready to send when you choose.'}`
            : 'Sign in with ChatGPT to reconnect Codex. An action may already have completed. Inspect the result before repeating an edit.'
          codexAuthRecovery.current = { chatId: conversations.activeId, notice: authNotice }
        }
        const replyUnavailable = Boolean(submittedMessages && e.code === 'EMPTY_RESPONSE')
        const text = lunaPromptNotSent ? `Message not sent: ${detail}\n\nNo provider was called or used as a fallback. ${fromPhone ? 'The unsent message is recorded below; nothing was retried.' : newerComposerPreserved ? 'Your newer draft is unchanged.' : 'Your draft is preserved.'}${fromPhone || newerComposerPreserved ? `\n\nUnsent message:\n${prompt}` : ''}`
          : authPromptNotSent ? `Message not sent: ${detail}\n\nSign in with ChatGPT to reconnect Codex. Nothing was automatically retried.${fromPhone || newerComposerPreserved
          ? `\n\nUnsent message:\n${prompt}${outgoingAttachments.length ? `\n\nAttachments for this attempt: ${outgoingAttachments.map(item => item.name).join(', ')}` : ''}` : ''}`
          : replyUnavailable ? missingAgentReplyText(toolReceipts)
          : `${submittedMessages ? 'Request did not finish' : 'Message not sent'}: ${detail}\n\n${submittedMessages ? 'An action may already have completed. Inspect the result before repeating an edit.' : 'Your draft is preserved.'}`
        // The proven-unsent user attempt remains a draft, not provider history.
        // Keeping just its status receipt prevents duplication on manual retry.
        storeMessages([...((authPromptNotSent || lunaPromptNotSent) ? messages : submittedMessages || messages), { role: 'assistant', turnId: requestId, text,
          deliveryStatus: replyUnavailable ? 'reply-unavailable' : 'failed',
          ...(toolReceipts ? { toolReceipts } : {}), ...(localDiagnostics ? { localDiagnostics } : {}) }])
        setError(authNotice || (replyUnavailable ? 'Final reply unavailable. Check the recorded tool results in this conversation before retrying.' : detail))
        setPartial(''); setStatus('')
      }
      return { success: false, ...(e.code === 'EMPTY_RESPONSE' ? { deliveryStatus: 'reply-unavailable' } : {}),
        error: e.code === 'EMPTY_RESPONSE' ? 'Final reply unavailable. Check the recorded tool results in the conversation before retrying.'
          : e.message || 'The response could not finish. Inspect the desktop before retrying.' }
    }
    finally {
      stopWatchingExport()
      if (isCurrent()) {
        activeRequest.current = null; approvalRecords.current.clear(); setApprovals([]); setBusy(false); setPreparing(false)
        setLiveActivity(previous => previous.map(item => item.status === 'running' ? { ...item, status: 'unconfirmed' } : item))
      }
    }
  }

  function showReviewFrame(id) {
    const frame = reviewFrames.find(item => item.id === id && item.chatId === conversations.activeId)
    if (busy || loading || isExportBusy() || !connectionContextIsCurrent(conversations.activeId)
      || !frame || frame.unavailable || !Number.isFinite(frame.timeSeconds) || frame.timelineId !== useProjectStore.getState().currentTimelineId) {
      setError('This preview belongs to a different timeline or the editor is busy. No navigation was made.')
      return { success: false, error: 'Preview is unavailable in the current timeline.' }
    }
    useTimelineStore.getState().shuttlePause()
    useAssetsStore.getState().clearPreview()
    useTimelineStore.getState().setPlayheadPosition(frame.timeSeconds, { snapToFrame: true })
    onOpenEditor?.()
    return { success: true, status: 'completed' }
  }

  const mobile = useMobileCompanion({
    scopeKey: `${projectKey}:${provider}:${conversations.activeId}`, projectName: project?.name || 'Project',
    projectPath: typeof handle === 'string' ? handle : '',
    chatTitle: activeChat?.title || 'Conversation', chatId: conversations.activeId, provider, model, messages, activeTurnId: activeRequest.current, aiSharingCapabilities,
    chats: [...conversations.conversations.map(chat => ({ id: chat.id, title: chat.title, provider,
      current: chat.id === conversations.activeId, updatedAt: chat.updatedAt })),
    ...otherChats.map(chat => ({ id: chat.id, title: chat.title, provider: chat.provider, current: false, updatedAt: chat.updatedAt }))],
    onNewChat: () => newChat({ fromPhone: true }),
    onSelectChat: (id, nextProvider) => {
      const candidates = nextProvider === provider ? conversations.conversations : otherChats.filter(chat => chat.provider === nextProvider)
      if (!CONNECTED_AGENT_PROVIDERS.includes(nextProvider) || !candidates.some(chat => chat.id === id)) {
        throw Error('This chat is no longer available. Refresh the chat list.')
      }
      return selectChat(nextProvider === provider ? id : `${nextProvider}:${id}`, { fromPhone: true })
    },
    reasoningEffort: thinkingLevel, reasoningOptions: availableThinking,
    models: [...(provider === 'codex' ? [{ id: '', label: 'Codex default' }] : []), ...models.map(item => ({ id: item.id, label: provider === 'lmstudio' ? localModelOptionLabel(item) : item.displayName || item.id }))],
    modelCatalogStatus: modelCatalogError || connection, toolsEnabled, researchEnabled, fullAccess: fullAccessEnabled, spendingPolicy,
    fullAccessBundleVersion: fullSetupComplete && fullAccessRemembered && spendingPolicy === 'ask-cloud' ? 1 : 0,
    approvals, phoneRequest: requestFromPhone, liveActivity,
    reviews: reviewFrames.filter(frame => frame.chatId === conversations.activeId), shareReviewImages: shareImages, onShowReview: showReviewFrame,
    isCurrent: () => connectionContextIsCurrent(conversations.activeId),
    onModels: checkConnection,
    onReasoning: changeThinking,
    onModel: value => { if (busy || (value !== '' && !models.some(item => item.id === value))) throw Error('Refresh the model list first.'); changeModel(value) },
    onAccess: async (mode, { bundleVersion } = {}) => {
      if (busy || loading || fullAccessPending.current || fullAccessPreferencePending || executableMutation.current || spendingMutation.current || isExportBusy()) throw Error('Wait for the current operation.')
      if (mode === 'full') {
        if (fullSetupComplete && bundleVersion !== 1) return { success: true, status: 'completed' }
        const result = await changeFullAccess(true, true, { fromPhone: true })
        if (result?.success && bundleVersion === 1) await refreshSpendingStatus()
        return result || { success: false, error: 'Full access is unavailable.' }
      }
      applyAccessMode(mode === 'review' ? 'chat' : mode)
      return { success: true, status: 'completed' }
    },
    onSpending: async policy => await changeSpendingPolicy(policy) || { success: false, error: 'Spending settings are busy or unavailable.' },
    onAccessRevoked: async ({ reason } = {}) => {
      const remembered = fullAccessRemembered, chatId = conversations.activeId
      const epoch = fullAccessEpoch.current + 1
      const result = await revokeFullAccess()
      // Model/thinking changes rotate the phone command context, not the
      // user's remembered desktop consent. Restore a fresh native grant after
      // that revocation only; Stop/Forget/disconnect must remain off.
      if (reason === 'shared-context-changed' && remembered && result?.success
        && epoch === fullAccessEpoch.current && connectionContextIsCurrent(chatId)) {
        fullAccessRestoreAttempt.current = null
        setFullAccessRestoreRetry(value => value + 1)
      }
    },
    onApproval: (id, approved) => decideApproval(id, approved, true), onStop: () => stop(),
    busy, preparing, awaitingApproval: approvals.some(item => item.state === 'pending'),
    status: error || status, activity: `${activityLabel} — ${activityDetail}`, partial, visible, settingsOpen, loading, exportBusy,
    activeTab, workspaceRef, onSend: (text, sharing) => send(null, text, sharing),
  })
  // The phone uses this desktop catalog and connection state. Discover funded
  // access on restore/selection, including when the Agent panel is hidden, and
  // again after native account startup/reconnection. This only reads status;
  // it never sends a prompt, retries a turn, or grants a funded allowance.
  const fundedAccountKey = JSON.stringify([mobile.connection?.guided?.registered,
    mobile.connection?.guided?.phase === 'account-unavailable', mobile.connection?.guided?.computer?.id,
    mobile.connection?.guided?.account])
  lunaAccountKey.current = fundedAccountKey
  const veloAllowance = useVeloAllowance({ enabled: Boolean(fundedLuna && visible && mobile.connection?.guided?.registered
    && mobile.connection?.guided?.phase !== 'account-unavailable'), accountKey: fundedAccountKey, revision: busy })
  useEffect(() => {
    if (!fundedLuna) return
    if (lunaConnection.accountKey !== fundedAccountKey) {
      setLunaConnection({ available: false, accountKey: fundedAccountKey,
        message: 'Checking this account’s Velo availability… No message is sent by checking.' })
    }
    if (busy || loading || exportBusy) return
    const key = JSON.stringify([fundedAccountKey, conversations.activeId, visible, settingsOpen, modelPickerOpen])
    if (lunaAutoCheck.current === key) return
    const timer = setTimeout(() => {
      if (!connectionContextIsCurrent(conversations.activeId) || lunaAccountKey.current !== fundedAccountKey) return
      lunaAutoCheck.current = key
      void checkConnection()
    }, 0)
    return () => clearTimeout(timer)
  }, [fundedLuna, fundedAccountKey, conversations.activeId, visible, settingsOpen, modelPickerOpen, busy, loading, exportBusy])
  useEffect(() => {
    if (!fundedLuna) return
    const retryAvailability = () => {
      if (document.visibilityState !== 'hidden' && !busy && !loading && !isExportBusy()
        && connectionContextIsCurrent(conversations.activeId)) void checkConnection()
    }
    window.addEventListener('online', retryAvailability)
    document.addEventListener('visibilitychange', retryAvailability)
    return () => {
      window.removeEventListener('online', retryAvailability)
      document.removeEventListener('visibilitychange', retryAvailability)
    }
  }, [fundedLuna, busy, loading, conversations.activeId])
  const nativeMobileApprovalKey = (mobile.nativeApprovals || []).map(approval => approval.approvalId).join(',')
  useLayoutEffect(() => {
    // Account setup moved out; pending decisions remain visible in settings.
    if (!settingsOpen || !nativeMobileApprovalKey) return
    const section = phoneSettings.current
    const scroller = section?.closest('.ca-settings-scroll')
    if (scroller) scroller.scrollTop += section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12
  }, [settingsOpen, nativeMobileApprovalKey])

  // A per-turn key below keeps an explicitly opened activity disclosure stable
  // as the answer arrives, and resets it for the next request. Only replies enter history.
  const lastActivityReply = !busy && (liveActivity.length > 0 || runTiming) && messages.at(-1)?.role === 'assistant' ? messages.at(-1) : null
  const setupDownloadCards = turnId => {
    const items = setupDownloads.items.filter(item => item.turnId === turnId)
    const models = lmStudioDownloads.items.filter(item => item.turnId === turnId)
    if (!items.length && !models.length) return null
    return <><AgentSetupDownloads items={items}
      error={setupDownloads.items[0]?.turnId === turnId ? setupDownloads.error : ''}
      onRefresh={setupDownloads.refresh} onCancel={setupDownloads.cancel}
      onOpen={jobId => { if (!loading && !isExportBusy()) return setupDownloads.open(jobId) }}
      pendingById={setupDownloads.pendingById} actionErrors={setupDownloads.actionErrors}
      exportBusy={exportBusy || loading} />
      <AgentLmStudioSetup items={models}
        error={lmStudioDownloads.items[0]?.turnId === turnId ? lmStudioDownloads.error : ''}
        onRefresh={lmStudioDownloads.refresh} onCancel={lmStudioDownloads.cancel}
        onLoad={jobId => { if (!loading && !isExportBusy()) return lmStudioDownloads.load(jobId) }}
        pendingById={lmStudioDownloads.pendingById} actionErrors={lmStudioDownloads.actionErrors}
        exportBusy={exportBusy || loading} /></>
  }
  const messageNode = (message, key) => {
    const hasReplyMedia = message.turnId && (message.role === 'assistant' || (!busy && !messages.some(reply => reply.role === 'assistant' && reply.turnId === message.turnId)))
    const content = actions => <>
    {message.role === 'assistant' ? <AgentMessageContent text={message.text} copyable actions={actions} /> : <><p>{message.text}</p>{actions && <div className="ca-message-actions">{actions}</div>}</>}{message.shotIds?.length > 0 && <div className="ca-shot-links">{message.shotIds.map(id => {
      const shot = currentContext().storyboard?.shots?.find(item => item.shotId === id)
      return shot && <button key={id} type="button" disabled={exportBusy} onClick={() => { if (!isExportBusy()) onShowShot?.(id) }} title={`Show ${shot.label}`}><ArrowUpRight size={12} />{shot.label}</button>
    })}</div>}
    {message.turnId && (message.role === 'assistant' || (!busy && !messages.some(reply => reply.role === 'assistant' && reply.turnId === message.turnId))) && setupDownloadCards(message.turnId)}
    {message.role === 'assistant' && <><ToolReceipts value={message.toolReceipts} /><LocalDiagnostics value={message.localDiagnostics} /></>}
    {message.role === 'assistant' && message.turnId && <AgentReviewGallery frames={reviewFrames.filter(frame => frame.chatId === conversations.activeId && frame.turnId === message.turnId)} onShow={showReviewFrame} disabled={busy || exportBusy || loading} />}
    </>
    return <article key={key} className={`ca-message ca-${message.role}`}>
    <strong>{message.role === 'user' ? 'You' : agentStatusMessage(message) ? 'Velorn status' : fundedLuna ? 'Velo' : 'Velorn Assistant'}</strong>
    {agentStatusMessage(message) ? <span className="ca-status-label">{message.deliveryStatus === 'reply-unavailable' ? 'Final reply unavailable · not an agent reply' : 'Request status · not an agent reply'}</span> : message.role === 'assistant' && <RequestedModel value={message.requestedModel} provider={provider} effort={message.requestedReasoningEffort} />}
    {hasReplyMedia ? <AgentPlayableMedia key={`${conversations.activeId}:${message.turnId}`} items={playable.items.filter(item => item.turnId === message.turnId)} candidates={playable.candidates}
      onAttach={ids => playable.attach(message.turnId, ids)} disabled={busy || exportBusy || loading}>{content}</AgentPlayableMedia> : content(null)}
    {message.role === 'user' && <AgentRecoveredReviewGallery message={message} messages={messages} frames={reviewFrames}
      chatId={conversations.activeId} busy={busy} onShow={showReviewFrame} disabled={exportBusy || loading} />}
  </article>
  }

  const veeAccess = <section aria-label="Velo access" className="ca-vee-access">
    <p role="status">{veloAllowanceNotice(veloAllowance.result) || (lunaConnection.available ? 'Velo is ready. Uses your Velo allowance, not generation credits.'
      : !mobile.connection?.guided?.registered ? 'Sign in to your Velorn account to check Velo access.' : lunaConnection.message)}</p>
    {!lunaConnection.available && <button type="button" disabled={selectionDisabled} onClick={openAccount}>{mobile.connection?.guided?.registered ? 'View Velo access' : 'Sign in to Velorn'}</button>}
  </section>
  const modelControls = <>
          {setupModelHandoff && provider === 'lmstudio' && <p className="ca-note" role="status">{provider === 'lmstudio'
            ? 'Choose your preferred LM Studio model below. Choosing a model does not send a message or request a model load.'
            : 'Choose LM Studio under Assistant, then choose a model. Your current assistant stays selected until you change it.'}</p>}
          {!pendingProvider && provider === 'codex' && codexNeedsSetup && <button type="button" disabled={selectionDisabled} onClick={openCodexSetup}>Set up Codex</button>}
          <div className="ca-provider"><label htmlFor={`${settingsId}-provider`}>Assistant</label><select ref={providerPicker} id={`${settingsId}-provider`} aria-label="Assistant selection" value={pendingProvider ?? provider} disabled={selectionDisabled} onChange={event => setPendingProvider(event.target.value === provider ? null : event.target.value)}><option value="codex">Codex</option><option value="lmstudio">LM Studio · local</option><option value="luna">Velo</option></select></div>
          <p className="ca-note">{fundedLuna ? 'A different assistant starts a separate chat. This chat stays saved.' : 'Change the model to keep this chat. A different assistant starts a separate chat.'}</p>
          {pendingProvider && <section ref={providerConfirmation} className="ca-provider-confirm" role="group" aria-label="Confirm assistant switch" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPendingProvider(null); providerPicker.current?.focus() } }}>
            <p>Start a new {connectedAgentProviderLabel(pendingProvider)} chat? This chat, its draft and attachments stay with {connectedAgentProviderLabel(provider)}. Previous messages won’t be shared with the new assistant.</p>
            <button type="button" disabled={selectionDisabled} onClick={() => { const next = pendingProvider; setPendingProvider(null); changeProvider(next) }}>Start {connectedAgentProviderLabel(pendingProvider)} chat</button>
            <button type="button" data-keep-chat onClick={() => { setPendingProvider(null); providerPicker.current?.focus() }}>Keep this chat</button>
          </section>}
          <div className="ca-options" hidden={Boolean(pendingProvider)} inert={pendingProvider ? '' : undefined}>
            {fundedLuna && <section aria-label="Velo connection"><p>{VELO_DESCRIPTION}</p>{veeAccess}<details className="ca-settings-disclosure"><summary>About Velo and sharing</summary><p>Velo uses GPT-6 Luna through OpenAI. Velo is the assistant; GPT-6 Luna is its underlying model, not another assistant to select.</p><p>No Codex installation or personal Codex sign-in is needed.</p><p>{FUNDED_LUNA_DISCLOSURE}</p></details></section>}
            {settingsOpen && provider === 'lmstudio' && <label>Local server<input aria-label="LM Studio endpoint" value={endpoint} disabled={selectionDisabled} onChange={event => { setEndpoint(event.target.value); setConnection(''); setModels([]); setLoadedModelStatus('unchecked'); connectionEpoch.current++; saveSettings({ endpoint: event.target.value.slice(0, 256) }) }} /></label>}
            {provider === 'codex' ? !codexSetupBlocked && <>
              <label>Model<select aria-label="Model" value={useCustomModel ? '__custom__' : model} disabled={selectionDisabled} onChange={event => {
                const custom = event.target.value === '__custom__'
                setCustomModelMode(custom); if (custom) setCustomModelDraft(model)
                if (!custom) changeModel(event.target.value)
              }}>
                <option value="">Codex default</option>
                {models.map(item => <option key={item.id} value={item.id}>{item.displayName || item.id}</option>)}
                <option value="__custom__">Custom model…</option>
              </select></label>
              {useCustomModel && <label>Custom model ID<input aria-label="Custom model ID" value={customModelDraft} maxLength={256} disabled={selectionDisabled} placeholder="Enter a Codex model ID" onChange={event => setCustomModelDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); changeModel(customModelDraft) } }} /><button type="button" disabled={selectionDisabled || !customModelDraft.trim() || customModelDraft.trim() === model} onClick={() => changeModel(customModelDraft)}>Use model</button></label>}
              {checking ? <p>Loading Codex models…</p> : modelCatalogError ? <p role="status">{modelCatalogError}</p>
                : selectedCatalogModel?.description && !useCustomModel ? <p>{selectedCatalogModel.description}</p> : null}
              {!model && <p>Codex default lets Codex choose the model. Checking the connection refreshes this list.</p>}
            </> : provider === 'lmstudio' && <>
              <label>Model<select aria-label="Model" value={customModelMode ? '__custom__' : model} disabled={selectionDisabled} onChange={event => {
                const custom = event.target.value === '__custom__'
                modelChoiceEpoch.current++
                setCustomModelMode(custom); if (custom) setCustomModelDraft(model)
                if (!custom) changeModel(event.target.value)
              }}>
                <option value="" disabled>Choose a model…</option>
                {model && !selectedCatalogModel && <option value={model}>{model} · Selected</option>}
                {models.map(item => <option key={item.id} value={item.id}>{localModelOptionLabel(item)}</option>)}
                <option value="__custom__">Enter model ID…</option>
              </select></label>
              {customModelMode && <label>Custom model ID<input aria-label="Custom model ID" value={customModelDraft} maxLength={256} disabled={selectionDisabled} placeholder="Enter an LM Studio model ID" onChange={event => setCustomModelDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); changeModel(customModelDraft) } }} /><button type="button" disabled={selectionDisabled || !customModelDraft.trim() || customModelDraft.trim() === model} onClick={() => changeModel(customModelDraft)}>Use model</button></label>}
              <p>Choose the model Velorn uses here. Changing the selection in LM Studio does not change this choice.</p>
              {checking ? <p role="status">Loading LM Studio models…</p> : loadedModelStatus === 'available'
                ? <p>{selectedCatalogModel?.loaded === true ? `Loaded at last check${selectedCatalogModel.contextLength ? ` · ${selectedCatalogModel.contextLength.toLocaleString('en-US')} context` : ''}.`
                  : selectedCatalogModel?.loaded === false ? 'This model is not loaded. Sending may load it; choose a Loaded model above to use one already in memory.'
                    : 'This model’s loaded state is unknown. Check connection to refresh.'}</p>
                : loadedModelStatus === 'unavailable' ? <p>Loaded state unavailable. You can still choose a listed model or enter its ID.</p> : null}
              {model.trim() && <details className="ca-settings-disclosure" aria-label="Local model compatibility">
                <summary>{localModelSupport.label}</summary>
                <p>{localModelSupport.summary}</p>
                <p>Recommendations are based on tested model versions and settings, not size alone. Light, Balanced and Advanced choices will be added as they qualify. Changing this label never changes tool permissions.</p>
              </details>}
            </>}
            {!fundedLuna && <button type="button" disabled={checking || busy || executableChanging || fullAccessChanging || exportBusy} onClick={checkConnection}>{checking ? 'Checking…' : 'Check connection'}</button>}
            {connection && !codexSetupBlocked && !fundedLuna && <p role="status">{connection.startsWith('Codex CLI is connected') ? 'Codex is connected.' : connection}</p>}
          </div>
  </>
  const activityIndicator = busy && <div className="ca-activity" data-testid="agent-activity" data-state={activityState}
    role="status" aria-live="polite" aria-atomic="true">
    {activityState === 'approval' ? <Clock size={16} aria-hidden="true" />
      : <span className="ca-stellar-wave" aria-hidden="true">
        {[0, 1, 2, 3, 4].map(index => <i key={index} style={{ '--ca-star-index': index }} />)}
      </span>}
    <div><strong>{activityLabel}</strong><span>{activityDetail}</span></div>
  </div>
  return <>
    <DesktopAccountBridge mobile={mobile} disabled={busy || loading || exportBusy || Boolean(deleteChatId)}
      scopeKey={`${projectKey}:${provider}:${conversations.activeId}`} />
    {renderHeader(newChat, !canManageChats || Boolean(deleteChatId), Boolean(deleteChatId) || codexInstallBusy || codexLoginPending || lmStudioAppBusy)}
    {busy && requestFromPhone && <div className="ca-mobile-notice" role="status">Phone request · Same desktop permissions · Approvals available on either screen</div>}
    {exportBusy && <p className="ca-export-paused" role="status">Export has priority. New messages, image capture and tool approvals are paused. Your conversation and draft are preserved.</p>}
    <div className="ca-settings" id={settingsId} hidden={!settingsOpen} role="region" aria-label="Assistant settings">
      <div className="ca-settings-heading"><h3>Assistant settings</h3><button type="button" aria-label="Back to chat" onClick={onBackToChat}><ArrowLeft size={13} />Back to chat</button></div>
      <div className="ca-settings-scroll">
        <section className="ca-settings-section"><h3>Which assistant?</h3>{settingsOpen && modelControls}</section>
        <section ref={accessModes} id={`${settingsId}-access-modes`} tabIndex={-1} className="ca-settings-section ca-access-modes" aria-labelledby={`${settingsId}-access-title`}>
          <h3 id={`${settingsId}-access-title`}>What can it do?</h3>
          <div className="ca-access-options" role="group" aria-label="Assistant access mode">
            <button type="button" aria-label="Chat only" aria-pressed={!toolsEnabled && !fullAccessEnabled} disabled={accessBusy} onClick={() => applyAccessMode('chat')}>
              <strong>Chat only</strong><span>Discuss your project without running tools.</span></button>
            <button ref={accessStart} type="button" aria-label="Work in Velorn" aria-pressed={toolsEnabled && !fullAccessEnabled} disabled={accessBusy} onClick={() => applyAccessMode('work')}>
              <strong>Work in Velorn</strong><span>Chat, edit and create with Velorn tools.</span></button>
            {<button type="button" className="ca-full-mode" aria-label={fullSetupLabel} aria-pressed={accessMode === 'full'} disabled={accessBusy || fullSetupComplete || !api?.setFullAccess || veloFullAccessComingSoon} data-coming-soon={veloFullAccessComingSoon || undefined} onClick={() => applyAccessMode('full')}>
              <strong>{fullSetupLabel}{veloFullAccessComingSoon && <em className="ca-coming-soon">Coming soon</em>}</strong><span>{veloFullAccessComingSoon ? `${comingSoonText} Chat and Work in Velorn work today.` : computerAccessProvider ? 'Velorn tools, files, commands, network and images.' : 'All Velorn tools, files and shared previews.'} Actions run automatically.</span></button>}
          </div>
          {!fullAccessEnabled && <div className="ca-access-summary">
            <div>
              {!pendingApprovalId && !submittingDecision && <button type="button" className="ca-approval-status" data-testid="agent-approval-status" aria-label={`Editing approvals: ${approvalStatus}`}
                aria-controls={`${settingsId}-${fullAccessEnabled ? 'access-modes' : 'editing-approvals'}`} title="Open editing approval settings" disabled={fullAccessChanging || spendingChanging}
                onClick={openApprovalSettings}><Settings size={11} aria-hidden="true" />{approvalStatus}</button>}
            </div>
          </div>}
          {provider === 'lmstudio' && <p className="ca-note">Full access enables automatic Velorn actions. LM Studio does not include a computer-command tool.</p>}
          {!api?.setFullAccess && <p className="ca-note">Restart Velorn to load the native full-access confirmation.</p>}
          {(fullAccessChanging || fullAccessPreferencePending) && <p role="status">{fullAccessRemembered ? 'Restoring remembered Full access…' : fullAccessChanging ? 'Waiting for native confirmation…' : 'Checking remembered access…'}</p>}
          {fullAccessError && <p className="ca-access-risk" role="alert">{fullAccessError}</p>}
          {accessNotice && <p className="ca-note" role="status">{accessNotice}</p>}
        </section>
        <section hidden={fullAccessEnabled} ref={editingApprovals} id={`${settingsId}-editing-approvals`} className="ca-settings-section ca-editing-approvals" tabIndex={-1} aria-labelledby={`${settingsId}-editing-approvals-title`}>
          <h3 id={`${settingsId}-editing-approvals-title`}>When should it ask?</h3>
          <p className="ca-note">{fullAccessEnabled ? 'Full access · automatic actions' : !toolsEnabled ? 'Chat only · no tool actions' : 'Work in Velorn · this chat session'}</p>
          {!fullAccessEnabled && <fieldset className="ca-approval-mode" disabled={accessBusy || !toolsEnabled} aria-describedby={`${settingsId}-approval-help`}>
            <legend>Editing approvals</legend>
            <label><input type="radio" name={`${settingsId}-approval`} checked={!autoApproveEdits} onChange={() => setAutoApproveEdits(false)} />Ask first</label>
            {<label><input type="radio" name={`${settingsId}-approval`} checked={autoApproveEdits} onChange={() => setAutoApproveEdits(true)} />Auto-approve editing</label>}
          </fieldset>}
          <p className="ca-note ca-approval-help" id={`${settingsId}-approval-help`}>{approvalHelp}</p>
        </section>
        <details className="ca-settings-section ca-settings-disclosure ca-more-options" open={advancedOptionsOpen} onToggle={event => setAdvancedOptionsOpen(event.currentTarget.open)}><summary>Advanced options</summary>
        {provider === 'codex' && !codexSetupBlocked && <details className="ca-settings-disclosure ca-thinking-options" hidden={Boolean(pendingProvider)} inert={pendingProvider ? '' : undefined}><summary>Thinking level</summary>
          <select aria-label="Thinking level" value={thinkingLevel} disabled={busy || checking || fullAccessChanging || executableChanging || exportBusy || !availableThinking.length}
            onChange={event => {
              try {
                changeThinking(event.target.value)
                focusComposer.current = true
                setModelPickerOpen(false)
                onSettingsOpen(false)
              } catch (failure) { setError(failure.message) }
            }}>
            {availableThinking.length ? availableThinking.map(item => <option key={item.id} value={item.id}>{item.label}</option>)
              : <option value={thinkingLevel}>{THINKING_LABELS[thinkingLevel]} · support unverified</option>}
          </select>
          <p>{availableThinking.length ? 'Changes apply to your next message in this chat. Lower thinking levels may respond faster.' : 'Check the connection to see supported thinking levels.'}</p>
        </details>}
        <details className="ca-advanced-permissions" open={accessOptionsOpen} onToggle={event => setAccessOptionsOpen(event.currentTarget.open)}><summary>Access options</summary>
        <section className="ca-settings-section ca-tools-consent"><h3>Editing access</h3>
          <label className="ca-check"><input type="checkbox" checked={toolsEnabled} disabled={busy || fullAccessChanging || fullAccessPreferencePending} onChange={event => { setToolsEnabled(event.target.checked); if (!event.target.checked) { void revokeFullAccess({ forget: true }); setResearchEnabled(false); setAutoApproveEdits(false); approvalModes.current.clear() } }} />Velorn tools</label>
          <p>{fullAccessEnabled
            ? 'Requested Velorn actions run automatically. Normal timeline Undo remains available. Generation spending stays separate.'
            : 'Allow MCP tools across Velorn to inspect the project. Changes ask for your approval unless you enable supported editing auto-approval. Unrelated accounts and connected apps are not inherited.'}</p>
          {<div className="ca-research-consent">
            <label className="ca-check"><input type="checkbox" checked={toolsEnabled && researchEnabled} disabled={accessBusy || !toolsEnabled} aria-describedby={`${settingsId}-research-details`} onChange={event => setResearchEnabled(toolsEnabled && event.target.checked)} />Research &amp; setup</label>
            <div id={`${settingsId}-research-details`}>
              <p>Read public websites and search GitHub / Hugging Face for workflow and model sources. Requires Velorn tools.</p>
              <p>{fullAccessEnabled ? `Full access permits supported downloads and installs without per-action prompts.${fullComputerAccessEnabled ? ` ${connectedAgentProviderLabel(provider)} can also use computer commands outside the configured models folder.` : ''}` : 'Model downloads are limited to the configured ComfyUI models folder. Downloads and installs ask for your approval.'}</p>
              <p>No terminal, connected accounts, or full computer access are granted by Research &amp; setup alone. Existing Velorn workflow setup tools remain available with Velorn tools alone.</p>
              {provider === 'lmstudio' && <p className="ca-research-warning">With LM Studio, inference stays local, but research sends search queries to public websites.</p>}
            </div>
          </div>}
        </section>
        {<section className="ca-settings-section ca-full-access-consent" aria-labelledby={`${settingsId}-full-access-title`}>
          <h3 id={`${settingsId}-full-access-title`}>Full access</h3>
          <label className="ca-check"><input type="checkbox" checked={computerAccessProvider ? fullComputerAccessEnabled : fullAccessEnabled} disabled={accessBusy || !toolsEnabled || veloFullAccessComingSoon} aria-describedby={`${settingsId}-full-access-details`} onChange={event => void changeFullAccess(event.target.checked)} />{computerAccessProvider ? 'Full computer access (experimental)' : 'Full Velorn access'}</label>
          <div id={`${settingsId}-full-access-details`}>
            <p>Giving an agent full access can be dangerous. It may change or delete files.</p>
            <button type="button" onClick={openFullAccessDetails}>Learn more about Full access</button>
            {veloFullAccessComingSoon ? <p>{comingSoonText}</p> : !toolsEnabled ? <p>Enable Velorn tools first, or use Full access above.</p> : !api?.setFullAccess && <p>Fully quit and reopen Velorn to enable Full access.</p>}
          </div>
          {fullAccessEnabled && <p className="ca-full-access-active">Full access · automatic{fullAccessRemembered ? ' · Remembered on this desktop' : ' for this chat session'}.</p>}
          {busy && fullAccessEnabled && <p>Stop the response before changing this permission.</p>}
        </section>}
        {<section className="ca-settings-section"><h3>Image sharing</h3>
          {provider === 'lmstudio' && <><label className="ca-check"><input type="checkbox" checked={localVision} disabled={accessBusy} onChange={event => setLocalVision(event.target.checked)} />Vision-capable model</label><p className="ca-note">Enable vision only if the loaded model accepts images. Review media can still be shared with your phone without model vision.</p></>}
          <div className="ca-image-options"><label className="ca-check"><input type="checkbox" checked={shareImages} disabled={accessBusy} onChange={event => setShareImages(event.target.checked)} />Share images</label>{shareImages && <label className="ca-check"><input type="checkbox" checked={shareView} disabled={accessBusy} onChange={event => setShareView(event.target.checked)} />Include current view</label>}</div>
          <p className="ca-note">{shareImages ? provider === 'lmstudio' && !localVision ? 'Review media sharing is on. Images are not sent to the text-only local model.' : `Shares up to 4 referenced or visible storyboard stills on Send.${toolsEnabled ? ' Also permits images returned by Velorn tools.' : ''}` : fullComputerAccessEnabled ? 'Automatic image sharing is off. Full computer access can still read accessible image and other media files directly.' : 'Text context only. Enable images for visual feedback.'}</p>
          {fullComputerAccessEnabled && shareImages && <p className="ca-note">These switches control automatic attachments and Velorn tool images only, not direct file reads through full computer access.</p>}
          {shareImages && shareView && <p className="ca-note">Current-view snapshots are available only in Editor and Storyboard. Other workspaces share project context and any referenced storyboard stills.</p>}
          {lastShared && <details className="ca-shared"><summary>Last message: {lastShared.count} image{lastShared.count === 1 ? '' : 's'} · {lastShared.tab}</summary>{lastShared.labels.map(label => <p key={label}>{label}</p>)}{lastShared.missing.length > 0 && <p>Unavailable: {lastShared.missing.join(', ')}</p>}</details>}
        </section>}
          {fullAccessRemembered && <div className="ca-access-remembered"><span>Remembered on this desktop</span><button type="button" disabled={accessBusy} onClick={() => void revokeFullAccess({ forget: true })}>Turn off and forget</button></div>}
          {<details ref={fullAccessDetails} className="ca-full-access-details" open={fullAccessLearnMoreOpen} onToggle={event => setFullAccessLearnMoreOpen(event.currentTarget.open)}>
            <summary>Learn more about Full access</summary>
            <p>Requested Velorn actions run automatically without mandatory edit approvals, previews or checkpoints. Normal timeline Undo remains available; direct file changes may not be undoable. {computerAccessProvider ? `${connectedAgentProviderLabel(provider)} can also run local commands, read and change files, install software and use network services with your normal OS user permissions, not administrator/root privileges.` : 'LM Studio can use Velorn’s tools, but does not receive an arbitrary computer-command tool.'}</p>
            <p>Remember on this desktop keeps your choice for this provider across restarts. Choosing Chat only or Work in Velorn clears that choice. You can also turn off Full access under Access options. Images and the current view are included for vision-capable models, and review media is shared with your phone. This is not continuous streaming.</p>
            <p>Velorn-managed generation still follows Generation spending. {computerAccessProvider && 'Direct computer commands and third-party services can bypass those controls and incur costs. Full access is not a global spending cap. '}Stop interrupts the response, but does not undo completed actions or necessarily cancel external jobs.</p>
            {fundedLuna && <p>No Codex installation or sign-in is needed. Shared context, images, file content and command output go through Velorn to OpenAI. Your Velo inference allowance still applies; Full access does not add or refill it. Earlier tool-only approval does not grant computer access; fresh confirmation is required.</p>}
            {provider === 'codex' && <p>Your message is sent as typed, including paths and links. Avoid including secrets. Codex keeps local session files for continuity; turning off access does not erase those files.</p>}
          </details>}
        </details>
        <section className="ca-settings-section">
          <details className="ca-settings-disclosure ca-connection-settings"><summary>Advanced connection settings</summary>
          {provider === 'lmstudio' && <p>Start LM Studio’s local server and load a model.</p>}
          <p>Selected and requested model labels record your choice, not a server-confirmed model or billing receipt.</p>
          {provider === 'codex' && <p>Thinking options come from the model’s Codex catalog. The selected level is requested explicitly, not inherited from your Codex settings.</p>}
          {provider === 'codex' && <section className="ca-codex-installation" aria-label="Codex installation">
            <h3>Codex installation</h3>
            {codexExecutable && <>
              <p>{codexExecutable.mode === 'custom' ? 'Chosen executable' : 'Automatic detection'}{codexExecutable.source ? ` · ${codexExecutable.source}` : ''}</p>
              {codexExecutable.path && <code aria-label="Codex executable path">{codexExecutable.path}</code>}
              {!codexExecutable.available && <p className="ca-installation-warning" role="status">Codex CLI was not found or is unavailable. Install it separately, then choose its executable or retry Check connection. Velorn does not install it automatically.</p>}
              {codexExecutable.error && <p className="ca-installation-warning">{codexExecutable.error}</p>}
            </>}
            <div className="ca-installation-actions">
              <button type="button" disabled={!api?.codexExecutable || busy || checking || executableReading || executableChanging || fullAccessChanging || spendingChanging || exportBusy} onClick={() => void changeCodexExecutable('choose')}>Choose executable…</button>
              {codexExecutable?.mode === 'custom' && <button type="button" disabled={!api?.codexExecutable || busy || checking || executableReading || executableChanging || fullAccessChanging || spendingChanging || exportBusy} onClick={() => void changeCodexExecutable('auto')}>Use automatic detection</button>}
            </div>
            <p>This device only; the executable path is not sent in chat or project context. Changing installation turns off Full computer access.</p>
            {(executableReading || executableChanging) && <p role="status">{executableChanging ? 'Updating Codex installation…' : 'Checking Codex installation…'}</p>}
            {(!api?.codexExecutable || executableError) && <p className="ca-installation-warning" role="alert">{executableError || 'Fully quit and reopen Velorn to choose or detect the Codex executable.'}</p>}
          </section>}
          {!fundedLuna && <p className="ca-privacy">{provider === 'codex' ? 'Send shares your message and project context with Codex. Uses your Codex account and limits.' : researchEnabled ? 'Model inference uses your local LM Studio server. Research queries also go to public websites. No cloud model fallback.' : 'Messages go only to your local LM Studio server. No cloud fallback.'}</p>}
          </details>
        </section>
        </details>
        <details className="ca-settings-disclosure ca-setup-help"><summary>Setup help</summary>
          <button type="button" disabled={selectionDisabled} onClick={openSetupHelper}>Setup helper</button>
          <p className="ca-note">Optional help connecting an editing assistant. Your current agent and chat stay unchanged.</p>
        </details>
        <details className="ca-settings-disclosure ca-generation-options"><summary>Generation and performance</summary>
        <section className="ca-settings-section ca-generation-spending" aria-labelledby={`${settingsId}-spending-title`}>
          <h3 id={`${settingsId}-spending-title`}>Generation spending</h3>
          <p className="ca-note">Image, video and audio generation — separate from Velo’s chat allowance and your Codex account.</p>
          <p className="ca-note">{!spendingPolicy ? 'Spending protection is unverified; restart before generating.' : 'Velorn shows the price and asks before anything is spent.'} Direct computer commands are outside these controls.</p>
          <details className="ca-settings-disclosure" id={`${settingsId}-spending-details`}><summary>Spending details</summary>
            <p>Paid or unverified generation always needs your approval first. If a saved workflow has unfamiliar nodes, Velorn shows which ones before it runs. Unrecognized does not mean paid.</p>
            <p>Saved on this device across chats and providers. Applies to all Velorn-managed generation in all projects, not Codex chat billing. Does not change chat-model billing. This is not a global spending cap; unrestricted shell, network and direct ComfyUI calls can bypass it.</p>
          </details>
          {spendingChanging && <p role="status">Waiting for native confirmation…</p>}
          {spendingNotice && <p role="status">{spendingNotice}</p>}
          {spendingError && <p className="ca-spending-error" role="alert">{spendingError}</p>}
          {spendingError && spendingAvailable && <button type="button" disabled={spendingReading || spendingChanging || busy || fullAccessChanging || exportBusy} onClick={() => void refreshSpendingStatus()}>Check spending protection</button>}
          <WorkflowLocalTrustSettings disabled={spendingChanging || busy || loading || fullAccessChanging || exportBusy} />
        </section>
        <GenerationMemorySetting />
        </details>
        <section className="ca-phone-settings"><button type="button" onClick={openAccount}>Manage phone sharing</button></section>
        <div ref={phoneSettings} className="ca-phone-decisions"><MobileCompanionRequest mobile={mobile} disabled={busy || loading || exportBusy || !visible || Boolean(deleteChatId)} /></div>
        <div className="ca-context"><Eye size={13} /><span>{activeTab === 'storyboard' ? 'Looking at the storyboard' : activeTab === 'editor' ? 'In the editor' : `In ${activeTab}`}<small>{project?.name}</small></span></div>
      </div>
      {busy && <div className="ca-settings-running">{settingsOpen && activityIndicator}<button type="button" onClick={stop} aria-label="Stop response"><Square size={12} />Stop</button></div>}
    </div>
    <div className="ca-chat" data-awaiting-approval={Boolean(pendingApprovalId)} hidden={settingsOpen} inert={deleteChatId ? '' : undefined}>
    <MobileCompanionRequest mobile={mobile} disabled={busy || loading || exportBusy || !visible || Boolean(deleteChatId)} />
    {!fullAccessEnabled && !veloFullAccessComingSoon && (preferredSetup.mode === 'full' || fullAccessPreferencePending || fullAccessError) && <div className="ca-restore-access">
      <span>{fullAccessPreferencePending ? 'Checking remembered access…' : 'Full access is off'}</span>
      {!fullAccessPreferencePending && !(busy && requestFromPhone) && <button type="button" disabled={accessBusy || !api?.setFullAccess || Boolean(deleteChatId)} onClick={() => applyAccessMode('full')}>Full access</button>}
      {fullAccessChanging && <span role="status">{fullAccessRemembered ? 'Restoring remembered Full access…' : 'Waiting for native confirmation…'}</span>}
      {fullAccessError && <span role="alert">{fullAccessError}</span>}
    </div>}
    <div className="ca-conversations">
      <select aria-label="Conversation" title={activeChat?.title || 'Conversation'} value={conversations.activeId || ''} disabled={!canManageChats || Boolean(deleteChatId)} onChange={event => selectChat(event.target.value)}>
        <optgroup label={connectedAgentProviderLabel(provider)}>{conversations.conversations.map(chat => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</optgroup>
        {CONNECTED_AGENT_PROVIDERS.filter(value => value !== provider).map(value => <optgroup key={value} label={connectedAgentProviderLabel(value)}>{otherChats.filter(chat => chat.provider === value).map(chat => <option key={chat.id} value={`${value}:${chat.id}`}>{chat.title}</option>)}</optgroup>)}
      </select>
      <div className="ca-conversation-actions" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setChatMenuOpen(false) }}>
        <button ref={chatMenuButton} type="button" aria-label="Conversation options" title="Conversation options" aria-haspopup="menu" aria-expanded={chatMenuOpen} disabled={!canManageChats || Boolean(deleteChatId)} onClick={() => setChatMenuOpen(open => !open)}><MoreHorizontal size={16} /></button>
        {chatMenuOpen && <div ref={chatMenu} className="ca-conversation-menu" role="menu" aria-label="Conversation options" onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setChatMenuOpen(false); chatMenuButton.current?.focus() }
        }}><button type="button" role="menuitem" onClick={() => { setChatMenuOpen(false); setDeleteChatId(conversations.activeId) }}><Trash2 size={13} />Delete conversation</button></div>}
      </div>
    </div>
    {conversations.warning && <p className="ca-history-warning" role="status">{conversations.warning}</p>}
    {reviewMediaWarning && <p className="ca-history-warning" role="status">{reviewMediaWarning}</p>}
    <div ref={messagesContainer} className={`ca-messages${codexSetupOpen || lmStudioSetupOpen ? ' ca-codex-setup-area' : ''}`} role={codexSetupOpen || lmStudioSetupOpen ? 'region' : 'log'} aria-label={codexSetupOpen ? 'Set up Codex' : lmStudioSetupOpen ? 'Set up LM Studio' : 'Agent conversation'}>
      {codexSetupOpen && provider === 'codex' && <CodexSetup state={codexSetupState} checking={checking || codexSetupState === 'unknown'}
        busy={accessBusy || executableReading} loginPending={codexLoginPending}
        loginAvailable={typeof api?.codexLogin === 'function'} error={codexLoginError || executableError || (codexSetupState === 'problem' && !checking ? connection : '')}
        onDetect={() => void checkConnection()} onLogin={() => void signInCodex()} onCancel={() => void cancelCodexLogin()}
        onLater={() => { if (!codexInstallBusy && !codexLoginPending) { setCodexSetupOpen(false); entryGuide.skip() } }}
        executable={codexExecutable} onChooseExecutable={api?.codexExecutable ? () => void changeCodexExecutable('choose') : undefined}
        onAutomatic={() => void changeCodexExecutable('auto')} onInstallBusyChange={setCodexInstallBusy} />}
      {lmStudioSetupOpen && provider === 'lmstudio' && <LmStudioSetup endpoint={endpoint} model={model} models={models}
        checking={checking} connected={lmStudioCheck.connected && lmStudioCheck.endpoint === endpoint} connectionError={lmStudioCheck.error}
        busy={accessBusy} onCheck={() => void checkConnection()} onUseModel={useLmStudioModel} onEndpoint={saveLmStudioEndpoint}
        onBusyChange={setLmStudioAppBusy} onLater={() => {
          if (lmStudioAppBusy) return
          connectionEpoch.current++; setChecking(false); setLmStudioSetupOpen(false); entryGuide.skip(); focusComposer.current = true
        }} />}
      <div className="ca-conversation-content" hidden={codexSetupOpen || lmStudioSetupOpen}>
      {showAssistantChoice && <section className="ca-entry-guide ca-assistant-choice" aria-label="Choose your assistant">
        <h3>Choose your assistant</h3>
        <p>Optional. You can edit without an assistant and change your choice later.</p>
        <div className="ca-assistant-choices">
          <button type="button" aria-label="Choose Velo" disabled={selectionDisabled} onClick={() => chooseFirstAssistant('luna')}><strong>Velo</strong><span>Velorn’s built-in AI assistant. Sign in to use your available allowance.</span></button>
          <button type="button" aria-label="Choose Codex" disabled={selectionDisabled} onClick={() => chooseFirstAssistant('codex')}><strong>Codex</strong><span>Use your own Codex account.</span></button>
          <button type="button" aria-label="Choose LM Studio" disabled={selectionDisabled} onClick={() => chooseFirstAssistant('lmstudio')}><strong>LM Studio</strong><span>Use a local model on your computer.</span></button>
          <button type="button" aria-label="Not now" disabled={selectionDisabled} onClick={() => { entryGuide.skip(); focusComposer.current = true }}><strong>Not now</strong><span>Keep editing without an assistant.</span></button>
        </div>
      </section>}
      {showEntryGuide && !showAssistantChoice && provider === 'codex' && <section className="ca-entry-guide" aria-label="Codex connection help">
        <h3>Set up Codex</h3><p>Use your ChatGPT account in Velorn.</p>
        <div className="ca-entry-guide-actions"><button type="button" disabled={selectionDisabled} onClick={openCodexSetup}>Set up Codex</button><button type="button" onClick={() => entryGuide.skip()}>Not now</button></div>
      </section>}
      {showEntryGuide && !showAssistantChoice && provider === 'lmstudio' && <section className="ca-entry-guide" aria-label="LM Studio connection help">
        <h3>Connect LM Studio</h3>
        <p>{entryState.reason}</p>
        <div className="ca-entry-guide-actions">
          <button type="button" disabled={selectionDisabled} onClick={openLmStudioSetup}>Connect LM Studio</button>
          <button type="button" onClick={() => entryGuide.skip()}>Not now</button>
        </div>
      </section>}
      {playable.error && <p role="status" className="ca-note">{playable.error}</p>}
      {setupDownloads.error && !setupDownloads.items.length && <AgentSetupDownloads items={[]} error={setupDownloads.error} onRefresh={setupDownloads.refresh} />}
      {lmStudioDownloads.error && !lmStudioDownloads.items.length && <AgentLmStudioSetup items={[]} error={lmStudioDownloads.error} onRefresh={lmStudioDownloads.refresh} />}
      {!codexSetupOpen && !messages.length && (!showEntryGuide || fundedLuna) && <AgentProjectWelcome key={conversations.activeId} provider={provider} projectName={project?.name} hasProjectWork={hasProjectWork}
        onChoose={chooseProjectStarter} disabled={accessBusy || !visible || Boolean(deleteChatId) || attaching}
        notice={starterNotice.chatId === conversations.activeId ? starterNotice.text : ''} fullAccessEnabled={fullAccessEnabled} computerAccessEnabled={fullComputerAccessEnabled} toolsEnabled={toolsEnabled} />}
      {(lastActivityReply ? messages.slice(0, -1) : messages).map(messageNode)}
      {lastActivityReply && messageNode(lastActivityReply, 'activity-final-reply')}
      {busy && (!liveActivity.length || partial) && <article className="ca-message ca-assistant" aria-busy="true"><strong>{fundedLuna ? 'Velo' : 'Velorn Assistant'}</strong><RequestedModel value={requestModel} provider={provider} effort={requestThinking} /><AgentMessageContent text={formatConnectedAgentResponse(partial, currentContext(), { allowPublicUrls: true }).text || status} /></article>}
      {busy && <AgentReviewGallery frames={reviewFrames.filter(frame => frame.chatId === conversations.activeId && frame.turnId === activeRequest.current)} onShow={showReviewFrame} disabled />}
      {busy && <AgentPlayableMedia items={playable.items.filter(item => item.turnId === activeRequest.current)} />}
      {busy && !messages.some(message => message.role === 'assistant' && message.turnId === activeRequest.current) && setupDownloadCards(activeRequest.current)}
      <LiveActivity key={`${conversations.activeId}:${timingRequest.current || 'no-run'}`} items={liveActivity} timing={runTiming} busy={busy} replyUnavailable={lastActivityReply?.deliveryStatus === 'reply-unavailable'} />
      {approvals.map(approval => <section key={approval.approvalId} ref={approval.approvalId === pendingApprovalId ? approvalStart : undefined} className="ca-tool-approval" aria-label={`Review tool: ${approval.toolName}`}>
        <h3>Approval needed</h3><strong>{approval.toolName}</strong>
        <p>Review this action before allowing it to run.</p>
        {!approval.reviewable && <p role="alert" className="ca-tool-warnings">Approval is disabled because the complete requested arguments cannot be reviewed.</p>}
        {approval.warnings.length > 0 && <ul className="ca-tool-warnings">{approval.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
        <details open><summary>Requested arguments</summary><pre>{approval.arguments || 'No arguments.'}</pre></details>
        {approval.preview && <details><summary>Preview</summary><pre>{approval.preview}</pre></details>}
        <div className="ca-approval-actions"><button type="button" disabled={approval.state !== 'pending' || !busy} onClick={() => void decideApproval(approval.approvalId, false)}>Deny</button>
          <button type="button" disabled={approval.state !== 'pending' || !busy || !approval.reviewable || exportBusy} onClick={() => void decideApproval(approval.approvalId, true)}>Approve</button></div>
      </section>)}
      </div>
    </div>
    <form hidden={codexSetupOpen || lmStudioSetupOpen || (showAssistantChoice && !messages.length && !draft.trim() && !attachments.length)} className={`ca-compose${showEntryGuide && !messages.length && !draft.trim() && !attachments.length ? ' ca-compose-first-setup' : ''}`} onSubmit={send} onDragOver={event => {
      if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = busy || attaching ? 'none' : 'copy' }
    }} onDrop={event => {
      if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); void attachFiles(event.dataTransfer.files) }
    }}>
      {error && <p role="alert" className="ca-error">{error}</p>}
      {!busy && status && <p role="status" className="ca-note">{status}</p>}
      <div className="ca-selected-model" aria-label={fundedLuna ? 'Selected assistant' : 'Selected model'} title={fundedLuna ? 'Velo is Velorn’s built-in AI assistant. It uses Light reasoning. Model details are in About Velo and sharing.' : 'This selection is sent with your next message. Requested model labels are not server-confirmed execution or billing.'}>
        <div><span>{fundedLuna ? 'Assistant' : provider === 'lmstudio' ? 'Requested model' : 'Selected model'}</span>{!fundedLuna && <span>{provider === 'lmstudio' ? 'LM Studio · local' : connectedAgentProviderLabel(provider)}</span>}</div>
        <strong>{fundedLuna ? 'Velo' : selectedModelLabel}{!fundedLuna && provider !== 'lmstudio' && !codexNeedsSetup ? ` · ${THINKING_LABELS[busy ? requestThinking : thinkingLevel] || THINKING_LABELS[thinkingLevel]}` : ''}</strong>
        <button type="button" className="ca-change-model" aria-expanded={modelPickerOpen || codexSetupOpen || lmStudioSetupOpen} aria-controls={codexNeedsSetup || (provider === 'lmstudio' && !model) ? undefined : `${settingsId}-chat-models`} disabled={selectionDisabled} onClick={() => { if (codexNeedsSetup) { openCodexSetup(); return } if (provider === 'lmstudio' && !model) { openLmStudioSetup(); return } setPendingProvider(null); setCustomModelDraft(model); setModelPickerOpen(open => !open) }}>{codexNeedsSetup ? 'Set up Codex' : provider === 'lmstudio' && !model ? 'Connect LM Studio' : fundedLuna ? 'Change assistant' : 'Change assistant or model'}</button>
      </div>
      {!settingsOpen && modelPickerOpen && <div id={`${settingsId}-chat-models`} className={`ca-chat-model-picker${provider === 'codex' && (codexSetupState !== 'ready' || codexLoginPending) ? ' ca-chat-model-picker-setup' : ''}`}>{modelControls}</div>}
      <div className="ca-chat-status" aria-label="Current assistant permissions"><span>{connectedAgentProviderLabel(provider)}</span><span>{toolsEnabled ? 'Tools enabled' : 'Review only'}</span>{toolsEnabled && researchEnabled && <span>Research &amp; setup</span>}<span>{shareImages ? provider === 'lmstudio' && !localVision ? 'Review media on · text-only model' : (shareView && currentViewAvailable ? 'Images + current view' : 'Images on') : attachments.some(item => item.kind === 'image') ? 'Attached images' : fullComputerAccessEnabled ? 'Auto images off · direct file access on' : 'Text only'}</span></div>
      {fundedLuna && !modelPickerOpen && (lunaConnection.available ? !busy && <p className="ca-note" role="status">{veloAllowanceNotice(veloAllowance.result) || 'Velo ready'}</p> : veeAccess)}
      {fundedLuna && mobile.connection?.guided?.registered && <VeloAllowance {...veloAllowance} />}
      <div className={`ca-spending-badge${spendingPolicy ? '' : ' ca-spending-unknown'}`} role="status" aria-label="Generation spending status"
        title={spendingPolicy ? 'This device · all Velorn-managed generation only. Not Codex chat billing or a global spending cap. Direct computer tools can bypass it.' : SPENDING_UNAVAILABLE}>
        {spendingPolicy ? `Velorn-managed generation · ${spendingPolicy === 'local-only' ? 'Local only' : 'Ask before cloud'}`
          : spendingReading ? 'Generation spending · checking…' : 'Generation spending · restart required'}
      </div>
      {attachments.length > 0 && <ul className="ca-attachments" aria-label="Message attachments">{attachments.map(item => <li key={item.id}>
        {item.kind === 'image' ? <img src={item.dataUrl} alt={`Attachment: ${item.name}`} /> : <FileJson size={22} aria-hidden="true" />}
        <span title={item.name}>{item.name}<small>{item.kind === 'image' ? 'Image · resized preview' : 'JSON · original contents'}</small></span>
        <button type="button" aria-label={`Remove attachment ${item.name}`} disabled={busy || attaching} onClick={() => setAttachments(previous => previous.filter(value => value.id !== item.id))}><X size={12} /></button>
      </li>)}</ul>}
      {attaching && <p className="ca-note" role="status">Preparing attachments…</p>}
      {attachments.length > 0 && <p className="ca-note">Attached files are sent with this message only. Check JSON for private information before sending.</p>}
      {!settingsOpen && activityIndicator}
      <textarea ref={composer} aria-label="Message your agent" placeholder="Talk about your project…" value={draft} maxLength={12000} disabled={loading} onChange={event => setDraft(event.target.value)} onPaste={event => {
        const files = Array.from(event.clipboardData?.files || [])
        if (files.length) { event.preventDefault(); event.stopPropagation(); void attachFiles(files) }
      }} onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) void send() }
      }} />
      <input ref={fileInput} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,.json" aria-label="Attach files" onChange={event => { void attachFiles(event.target.files); event.target.value = '' }} />
      <div className="ca-send-row"><button type="button" aria-label="Attach images or JSON" title="Attach images or JSON · you can also paste or drop files" disabled={accessBusy || attaching || attachments.length >= 4} onClick={() => fileInput.current?.click()}><Paperclip size={14} /></button><span>Enter to send · Shift+Enter for a new line</span>{busy ? <button type="button" onClick={stop} aria-label="Stop response"><Square size={12} /> Stop</button> : <button type="submit" disabled={(!draft.trim() && !attachments.length) || attaching || accessBusy || (fundedLuna && (!lunaConnection.available || checking || lunaConnection.accountKey !== lunaAccountKey.current))} aria-label="Send message"><Send size={13} /> Send</button>}</div>
    </form>
    </div>
    {setupHelperOpen && visible && <OptionalSetupDialog onClose={() => setSetupHelperOpen(false)}
      onFinish={() => { setSetupHelperOpen(false); onSettingsOpen(false) }} onChooseAgentModel={() => openSetupModelPicker()} />}
    {deleteChatId && <div className="ca-delete-backdrop"><section ref={deleteDialog} className="ca-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${settingsId}-delete-title`} aria-describedby={`${settingsId}-delete-description`} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelDelete() }
      if (event.key === 'Tab') {
        const buttons = [...event.currentTarget.querySelectorAll('button')]
        if ((event.shiftKey && document.activeElement === buttons[0]) || (!event.shiftKey && document.activeElement === buttons.at(-1))) {
          event.preventDefault(); (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus()
        }
      }
    }}>
      <h3 id={`${settingsId}-delete-title`}>Delete conversation?</h3>
      <p id={`${settingsId}-delete-description`}>“{conversations.conversations.find(chat => chat.id === deleteChatId)?.title || 'This conversation'}” will be removed from chat history on this device. This cannot be undone. Your project, media and edits will not change.</p>
      <div><button type="button" onClick={cancelDelete}>Cancel</button><button type="button" className="ca-delete-confirm" onClick={deleteChat}>Delete conversation</button></div>
    </section></div>}
  </>
}

export default function ConnectedAgentPanel({ activeTab, onClose, onShowShot, onOpenEditor, workspaceRef, onHighlight, docked = false, visible = true, workflowReferenceRef, modelPickerRequest = 0, spendingSettingsRequest = 0 }) {
  const project = useProjectStore(state => state.currentProject)
  const handle = useProjectStore(state => state.currentProjectHandle)
  const loading = useProjectStore(state => state.isLoading)
  const [provider, setProvider] = useState(() => CONNECTED_AGENT_PROVIDERS.includes(readSettings().provider) ? readSettings().provider : 'codex')
  const [width, setWidth] = useState(370)
  const [clipboardError, setClipboardError] = useState('')
  const key = getStoryboardProjectKey(project, handle)
  const [settingsState, setSettingsState] = useState(() => ({ projectKey: key, open: false }))
  const settingsOpen = settingsState.projectKey === key && settingsState.open
  const setSettingsOpen = useCallback(open => setSettingsState(previous =>
    previous.projectKey === key && previous.open === open ? previous : { projectKey: key, open }), [key])
  const settingsButton = useRef(null)
  const setupModelPickerRef = useRef(null)
  const consumedModelPickerRequest = useRef(0)
  const modelPickerRequestScope = useRef(null)
  const [pendingModelPicker, setPendingModelPicker] = useState(null)
  const settingsId = useId()
  const consumedSpendingRequest = useRef(0)
  useEffect(() => {
    if (!spendingSettingsRequest || consumedSpendingRequest.current === spendingSettingsRequest || !visible || !project || loading) return
    consumedSpendingRequest.current = spendingSettingsRequest
    setSettingsOpen(true)
    const timer = setTimeout(() => {
      const heading = document.getElementById(`${settingsId}-spending-title`)
      const section = heading?.closest('.ca-generation-options')
      if (section) section.open = true
      heading?.scrollIntoView({ block: 'center' })
    }, 0)
    return () => clearTimeout(timer)
  }, [spendingSettingsRequest, visible, project, loading, setSettingsOpen, settingsId])
  useEffect(() => {
    if (!modelPickerRequest || consumedModelPickerRequest.current === modelPickerRequest) return
    if (modelPickerRequestScope.current?.request !== modelPickerRequest) modelPickerRequestScope.current = { request: modelPickerRequest, projectKey: key }
    if (modelPickerRequestScope.current.projectKey !== key || !project || loading) {
      consumedModelPickerRequest.current = modelPickerRequest
      return
    }
    if (!visible) return
    consumedModelPickerRequest.current = modelPickerRequest
    if (project && !loading) setupModelPickerRef.current?.()
  }, [modelPickerRequest, visible, key, loading])
  useEffect(() => {
    if (!pendingModelPicker) return
    setPendingModelPicker(null)
    if (visible && !loading && pendingModelPicker.projectKey === key && pendingModelPicker.provider === provider) {
      setupModelPickerRef.current?.(pendingModelPicker.setupHandoff)
    }
  }, [pendingModelPicker, visible, loading, key, provider])
  useEffect(() => { setSettingsOpen(false) }, [setSettingsOpen])
  const backToChat = () => { setSettingsOpen(false); settingsButton.current?.focus() }
  const renderHeader = (onNewChat, newChatDisabled = true, confirming = false) => <header className="ca-header"><MessageSquare size={16} /><h2>Velorn Assistant</h2>
    <button type="button" aria-label="New chat" title="New chat" disabled={newChatDisabled} onClick={onNewChat}><Plus size={16} /></button>
    <button ref={settingsButton} type="button" className="ca-settings-toggle" aria-label="Assistant settings" title="Assistant settings" aria-expanded={settingsOpen} aria-controls={project && !loading ? settingsId : undefined} disabled={!project || loading || confirming} onClick={() => settingsOpen ? backToChat() : setSettingsOpen(true)}><Settings size={16} /></button>{!docked && <button type="button" aria-label="Close assistant panel" title="Close assistant panel" onClick={onClose}><X size={16} /></button>}</header>
  return <aside className={`connected-agent-panel${docked ? ' ca-docked' : ''}`} aria-label="Velorn Assistant" data-editor-keyboard-scope="text" style={docked ? undefined : { '--ca-width': `${width}px` }} onContextMenu={event => {
    const text = selectedTextWithin(event.currentTarget)
    if (!text || !window.electronAPI?.showTextCopyMenu) return
    event.preventDefault(); event.stopPropagation(); setClipboardError('')
    window.electronAPI.showTextCopyMenu(text).then(result => {
      if (!result?.success) setClipboardError('Could not open Copy. Use the Copy button or Ctrl/Cmd+C.')
    }).catch(() => setClipboardError('Could not open Copy. Use the Copy button or Ctrl/Cmd+C.'))
  }} onKeyDown={event => {
    event.stopPropagation()
    if (event.key === 'Escape' && settingsOpen && !event.nativeEvent.isComposing) { event.preventDefault(); backToChat() }
  }}>
    {clipboardError && <p className="ca-history-warning" role="alert">{clipboardError}</p>}
    {!docked && <div role="separator" aria-label="Resize agent panel" aria-orientation="vertical" aria-valuemin={300} aria-valuemax={620} aria-valuenow={width} tabIndex={0} className="ca-resize" onKeyDown={event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(value => Math.max(300, Math.min(620, value + (event.key === 'ArrowLeft' ? 20 : -20)))) }
    }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.dragging = 'true'; event.preventDefault() }} onPointerMove={event => {
      if (event.currentTarget.dataset.dragging === 'true') setWidth(Math.max(300, Math.min(620, window.innerWidth - event.clientX)))
    }} onPointerUp={event => { delete event.currentTarget.dataset.dragging; event.currentTarget.releasePointerCapture(event.pointerId) }} onLostPointerCapture={event => { delete event.currentTarget.dataset.dragging }} />}
    {!project || loading ? <>{renderHeader()}<p className="ca-note">{loading ? 'Opening project…' : 'Open a project to start a conversation.'}</p></>
      : <Conversation key={`${sessionId(key)}:${provider}`} projectKey={key} provider={provider} settingsOpen={settingsOpen} settingsId={settingsId} onSettingsOpen={setSettingsOpen} onBackToChat={backToChat}
        workflowReferenceRef={workflowReferenceRef} setupModelPickerRef={setupModelPickerRef}
        onProviderChange={(value, options) => {
          setProvider(value); saveSettings({ provider: value }); onHighlight?.([])
          if (options?.showModelPicker) setPendingModelPicker({ projectKey: key, provider: value, setupHandoff: options.setupHandoff === true })
        }} activeTab={activeTab} visible={visible} onShowShot={onShowShot} onOpenEditor={onOpenEditor} workspaceRef={workspaceRef} onHighlight={onHighlight} renderHeader={renderHeader} />}
  </aside>
}
