import { useEffect, useMemo, useRef, useState } from 'react'
import { redactConnectedAgentText } from '../utils/connectedAgentContext.mjs'
import { sanitizeAgentToolReceipts } from '../utils/connectedAgentReceipts.mjs'
import './MobileCompanion.css'
import { mobileProjects } from '../services/mobileCompanionProjectAdapter'
import { isProjectDirty } from '../services/projectDirtyTracker'

const WINDOW_SCOPE = crypto.randomUUID()
let previewAllowed = false

// Adapter to the ONE existing conversation. No second agent or history store.
export function useMobileCompanion(options) {
  const api = window.electronAPI?.mobileCompanion
  const scope = WINDOW_SCOPE
  const contextId = useMemo(() => crypto.randomUUID(), [options.scopeKey, options.model, options.reasoningEffort])
  const contextRef = useRef(contextId); contextRef.current = contextId
  const mounted = useRef(true)
  const projects = useRef([])
  const latest = useRef(options), scopeRef = useRef(scope)
  latest.current = options; scopeRef.current = scope
  const [connection, setConnection] = useState(null)
  const [capabilities, setCapabilities] = useState({ available: false, guidedAvailable: false, legacyAvailable: false })
  const connectionRef = useRef(null); connectionRef.current = connection
  const [pending, setPending] = useState(null)
  const [nativeApprovals, setNativeApprovals] = useState([])
  const pendingRef = useRef(null), deciding = useRef(false), enabling = useRef(false)
  const [changing, setChanging] = useState(false)
  const [checkingAccount, setCheckingAccount] = useState(false)
  const checkingAccountRef = useRef(false)
  const [notice, setNotice] = useState('')
  const [requestError, setRequestError] = useState('')
  const [computerNameDraft, setComputerName] = useState(null)
  const rememberedComputerName = connection?.guided?.computer?.name || connection?.guided?.computerName
  const computerName = computerNameDraft ?? (typeof rememberedComputerName === 'string' && rememberedComputerName.trim() && rememberedComputerName.length <= 80
    && !/[\u0000-\u001f\u007f]/.test(rememberedComputerName) ? rememberedComputerName : 'My computer')
  // Native state owns the persisted label. A draft belongs only to this setup,
  // never a different project/chat or a newly registered account connection.
  useEffect(() => { setComputerName(null) }, [options.scopeKey, connection?.guided?.computer?.id])
  const [sharePreview, setSharePreview] = useState(previewAllowed)
  const [preview, setPreview] = useState(null)
  const previewRef = useRef(null), capturing = useRef(false)
  const activityPublication = useRef({ key: '', updatedAt: 0 })
  const enabled = connection?.enabled === true
  const sharingPreview = sharePreview || options.fullAccess === true
  const previewConsent = useRef(false)
  previewConsent.current = enabled && sharingPreview
  // Chat attachments follow the agent's Share images choice (included in Full
  // access). Full access also includes the current Velorn workspace view.
  const reviewConsent = useRef(false)
  reviewConsent.current = enabled && options.shareReviewImages === true
  const safeText = text => redactConnectedAgentText(String(text || '').slice(0, 8000))
  const snapshot = () => {
    const current = latest.current
    // Only public commentary and bounded tool summaries, never raw command
    // output, arguments, or provider reasoning. Polling is not a progress event.
    const activityItems = (current.liveActivity || []).slice(-30).map(item => ({
      id: item.id, kind: item.kind, status: item.status,
      ...(item.kind === 'progress' ? { text: safeText(item.text).slice(0, 3000) }
        : { toolName: safeText(item.toolName).slice(0, 120),
          summary: /shell|command/i.test(item.toolName) ? '' : safeText(item.summary).slice(0, 600) }),
    }))
    const activityKey = JSON.stringify([contextRef.current, activityItems])
    if (activityPublication.current.key !== activityKey) {
      activityPublication.current = { key: activityKey, updatedAt: activityItems.length ? Date.now() : 0 }
    }
    return {
      protocol: 3, contextId: contextRef.current, chatId: current.chatId,
      chatNavigation: typeof current.onSelectChat === 'function' && typeof current.onNewChat === 'function',
      chats: (current.chats || []).slice(0, 100).map(({ id, title, provider, current: selected, updatedAt }) =>
        ({ id, title: safeText(title).slice(0, 256), provider, current: selected === true, updatedAt })),
      projects: projects.current, models: current.models || [], modelCatalogStatus: current.modelCatalogStatus,
      approvals: current.approvals || [], phoneRequest: current.busy && current.phoneRequest,
      toolsEnabled: current.toolsEnabled, researchEnabled: current.researchEnabled, fullAccess: current.fullAccess,
      fullAccessBundleVersion: current.fullAccessBundleVersion,
      spendingPolicy: current.spendingPolicy, dirty: isProjectDirty(),
      projectName: safeText(current.projectName), chatTitle: safeText(current.chatTitle),
      provider: current.provider, model: current.model,
      ...(api?.aiSharingVersion === 1 && window.electronAPI?.connectedAgent?.aiSharingVersion === 1 ? {
        aiSharingVersion: 1, aiSharingCapabilities: current.aiSharingCapabilities,
      } : {}),
      reasoningEffort: current.reasoningEffort, reasoningOptions: current.reasoningOptions,
      messages: [...current.messages.slice(-60), ...(current.busy && current.activeTurnId ? [{ role: 'assistant', turnId: current.activeTurnId, text: current.partial ? `In progress:\n${current.partial}` : 'Working…' }] : [])]
        .map(({ role, text, turnId, deliveryStatus, toolReceipts }) => {
          const receipts = role === 'assistant' ? sanitizeAgentToolReceipts(toolReceipts) : undefined
          return { role, turnId, text: safeText(text).slice(0, 3500),
            ...(role === 'assistant' && ['failed', 'reply-unavailable'].includes(deliveryStatus) ? { deliveryStatus } : {}),
            ...(receipts ? { toolReceipts: receipts } : {}) }
        }),
      busy: current.busy, awaitingApproval: current.awaitingApproval,
      activity: { items: activityItems, updatedAt: activityPublication.current.updatedAt },
      available: !current.loading && !current.exportBusy,
      status: current.awaitingApproval ? 'Review the pending action.'
        : current.busy ? (current.preparing ? 'Preparing your request…' : safeText(current.activity).slice(0,150) || 'Velorn Agent is working…')
          : safeText(current.status).slice(0, 150),
      preview: previewRef.current,
      reviewProjectPath: current.projectPath,
      shareReviewMedia: current.shareReviewImages === true,
      reviews: reviewConsent.current ? (current.reviews || []).slice(-100).reduceRight((kept, frame) => {
        if (frame.persisted) { const {dataUrl,...metadata}=frame;kept.unshift(metadata) }
        else if (kept.reduce((n, item) => n + (item.dataUrl?.length || 0), 0) + (frame.dataUrl?.length || 0) <= 1500000) kept.unshift(frame)
        return kept
      }, []) : [],
    }
  }

  useEffect(() => {
    mounted.current = true
    setPreview(null); previewRef.current = null; setNotice(''); setRequestError('')
    let disposed = false
    const commandIds = new Set()
    async function refreshProjects() { const next = await mobileProjects.list(); if (!disposed) projects.current = next }
    async function command(event) {
      const c = event.command
      if (!c || commandIds.has(c.id)) return
      commandIds.add(c.id)
      const stillCurrent = () => !disposed && mounted.current && contextRef.current === c.contextId
        && !latest.current.loading && !latest.current.exportBusy && latest.current.isCurrent()
      const sharingCurrent = () => !c.aiSharingConsent || (api?.aiSharingVersion === 1
        && window.electronAPI?.connectedAgent?.aiSharingVersion === 1 && event.aiSharing?.version === 1
        && c.aiSharingConsent.provider === latest.current.provider
        && JSON.stringify(event.aiSharing.capabilities) === JSON.stringify(latest.current.aiSharingCapabilities))
      try {
        if (!stillCurrent() || !sharingCurrent() || (!['approval', 'stop'].includes(c.kind) && latest.current.busy)) throw Error('The desktop changed. Refresh before trying again.')
        const ack = await api.reply({ scope, id: c.id, result: { success: true, status: 'accepted' } })
        if (!ack?.success || !stillCurrent() || !sharingCurrent()) throw Error('This request expired. No new action was started.')
        let result
        if (c.kind === 'message') result = await latest.current.onSend(c.text,
          c.aiSharingConsent ? { commandId: c.id, consent: c.aiSharingConsent, capabilities: event.aiSharing.capabilities } : undefined)
          || { success: false, error: 'The message did not complete. Check the desktop.' }
        else if (c.kind === 'models') await latest.current.onModels()
        else if (c.kind === 'model') latest.current.onModel(c.model)
        else if (c.kind === 'reasoning') latest.current.onReasoning(c.effort)
        else if (c.kind === 'chat') result = await latest.current.onSelectChat(c.chatId, c.provider)
        else if (c.kind === 'new-chat') result = await latest.current.onNewChat()
        else if (c.kind === 'access') result = await latest.current.onAccess(c.mode, { bundleVersion: c.bundleVersion })
        else if (c.kind === 'spending') result = await latest.current.onSpending(c.policy)
        else if (c.kind === 'projects') await refreshProjects()
        else if (c.kind === 'project') await mobileProjects.open(c.projectId, c.saveCurrent, () => stillCurrent() && !latest.current.busy)
        else if (c.kind === 'approval') result = await latest.current.onApproval(c.approvalId, c.approved) || { success: false, error: 'The approval changed. Check the desktop.' }
        else if (c.kind === 'stop') {
          if (!latest.current.busy) throw Error('There is no active request to stop.')
          latest.current.onStop()
        } else if (c.kind === 'preview') result = await capture()
        else if (c.kind === 'show-review') {
          if (!reviewConsent.current) throw Error('Chat image sharing is disabled.')
          result = await latest.current.onShowReview(c.reviewId)
        }
        else throw Error('This control is unavailable.')
        await api.reply({ scope, id: c.id, result: result || { success: true, status: 'completed' } })
      } catch (error) {
        await api.reply({ scope, id: c.id, result: { success: false, error: error.message || 'The request could not finish. Check the desktop.' } }).catch(() => {})
      }
    }
    const off = api?.onEvent?.(event => {
      if (scopeRef.current !== scope || (event.scope && event.scope !== scope)) return
      if (event.type === 'status') {
        setConnection(event.status)
        if (!event.status?.enabled) { setNativeApprovals([]); setPending(null); pendingRef.current = null; previewRef.current = null; setPreview(null) }
      }
      if (event.type === 'native-approvals') setNativeApprovals(event.approvals || [])
      if (event.type === 'access-revoked') void latest.current.onAccessRevoked?.({ reason: event.reason })
      if (event.type === 'message-cancelled' && event.id === pendingRef.current?.id) {
        setPending(null); pendingRef.current = null
      }
      if (event.type === 'command') { void command(event); return }
      if (event.type !== 'message') return
      if (!event.id || typeof event.text !== 'string' || event.text.length > 4000 || pendingRef.current || latest.current.busy) {
        void api.reply({ scope, id: event.id, result: { success: false, error: 'Desktop busy. No message was sent.' } })
        return
      }
      pendingRef.current = event; setPending(event)
    })
    void refreshProjects().catch(() => { if (!disposed) setNotice('Some projects could not be listed.') })
    let attaching = false
    async function attach(restoreOnly = false) {
      if (disposed || attaching || enabling.current) return
      attaching = true
      try {
        if (restoreOnly) {
          if (connectionRef.current?.enabled || !(await api?.getPreference?.())?.enabled) return
          if (disposed || latest.current.loading || latest.current.exportBusy) return
        }
        const result = await api?.attach?.({ scope, snapshot: snapshot() })
        if (!disposed && result?.success) {
          setConnection(result.status); setNativeApprovals(result.nativeApprovals || [])
          if (result.status?.enabled) setNotice('')
        }
      } catch { /* Retry only native remembered opt-in, never replay a command. */ }
      finally { attaching = false }
    }
    void (async () => {
      const preference = await api?.getPreference?.()
      if (disposed) return
      setCapabilities({ available: preference?.available === true, guidedAvailable: preference?.guidedAvailable === true,
        // Older native builds expose only `available` and retain private-link pairing.
        legacyAvailable: preference?.available === true && preference?.legacyAvailable !== false })
      if (preference?.status) setConnection(preference.status)
      await attach()
    })().catch(() => {})
    const restoreTimer = setInterval(() => void attach(true), 5000)
    return () => {
      disposed = true; mounted.current = false
      clearInterval(restoreTimer)
      off?.(); pendingRef.current = null
      void api?.detach?.({ scope, contextId }).catch(() => {})
    }
  }, [api, scope, contextId])

  useEffect(() => {
    if (!enabled || !api) return undefined
    let disposed = false, publishing = false
    const publish = async () => {
      if (disposed || publishing || scopeRef.current !== scope) return
      publishing = true
      try {
        const response = await api.publish({ scope, snapshot: snapshot() })
        if (!disposed && response?.success === false) {
          setConnection(null); setNotice(response.error || 'Phone connection interrupted. Reconnecting when Velorn is ready…')
          setPending(null); pendingRef.current = null
        }
      } catch { if (!disposed) { setConnection(null); setNotice('Phone connection interrupted. Reconnecting when Velorn is ready…') } }
      finally { publishing = false }
    }
    void publish()
    const timer = setInterval(publish, 1500)
    return () => { disposed = true; clearInterval(timer) }
  }, [api, scope, contextId, enabled, options.aiSharingCapabilities?.tools, options.aiSharingCapabilities?.research,
    options.aiSharingCapabilities?.fullAccess, options.aiSharingCapabilities?.images, options.aiSharingCapabilities?.view])

  async function enable() {
    if (!api || enabling.current || latest.current.busy || latest.current.loading || latest.current.exportBusy) return
    enabling.current = true; setChanging(true); setNotice('')
    const enablingContext = contextRef.current
    try {
      projects.current = await mobileProjects.list()
      if (!mounted.current || contextRef.current !== enablingContext) return
      const response = await api.enable({ scope, snapshot: snapshot() })
      if (!mounted.current || contextRef.current !== enablingContext) { void api.disable({ scope }); return }
      if (!response?.success) throw new Error(response?.error || 'Pairing was not enabled.')
      setConnection(response.status)
    } catch (error) { if (scopeRef.current === scope) setNotice(error.message) }
    finally { enabling.current = false; setChanging(false) }
  }
  async function disable() {
    setNotice('')
    previewConsent.current = false
    reviewConsent.current = false
    let status = null
    try {
      const result = await api?.disable?.({ scope })
      if (!result?.success) throw new Error('not confirmed')
      status = result.status || null
    } catch { setNotice('Unable to confirm disconnection. Quit Velorn to end access.'); return }
    // Pausing sharing retains the registered account. Only native status can
    // say whether it was disconnected; do not render pause as a sign-out.
    setConnection(status); setPending(null); pendingRef.current = null
    setPreview(null); previewRef.current = null
  }
  async function decide(accept) {
    const request = pendingRef.current, current = latest.current
    if (!request || deciding.current || request.scope !== scope || scopeRef.current !== scope) return
    if (accept && (current.busy || current.loading || current.exportBusy || !current.visible || current.settingsOpen)) return
    const decisionContext = contextRef.current
    deciding.current = true; setNotice(''); setRequestError('')
    try {
      if (!accept) {
        const result = await api.reply({ scope, id: request.id, result: { success: false, error: 'Declined on the desktop. No message was sent.' } })
        if (!result?.success) throw new Error('The decline could not be confirmed. Disconnect the phone to clear pending requests.')
      } else {
        const ack = await api.reply({ scope, id: request.id, result: { success: true, status: 'accepted' } })
        if (!ack?.success || scopeRef.current !== scope) throw new Error(ack?.error || 'This phone request expired. Nothing was sent.')
        setPending(null)
        // Recheck after IPC: the desktop may have started a request meanwhile.
        const result = await latest.current.onSend(request.text)
        const outcome = result || { success: false, error: 'The request stopped or changed. Inspect the desktop before trying again.' }
        await api.reply({ scope, id: request.id, result: outcome })
        if (outcome.success === false && mounted.current && contextRef.current === decisionContext) {
          const message = outcome.error || 'The phone request did not complete. Inspect the desktop before trying again.'
          setNotice(message); setRequestError(message)
        }
      }
    } catch (error) {
      if (mounted.current && contextRef.current === decisionContext) {
        const message = error.message || 'Could not confirm the request outcome. Inspect the desktop.'
        setNotice(message); setRequestError(message)
      }
    }
    finally {
      if (pendingRef.current?.id === request.id) { pendingRef.current = null; setPending(null) }
      deciding.current = false
    }
  }
  async function capture({ fromSettings = false } = {}) {
    const current = latest.current
    const captureContext = contextRef.current
    // Only an explicit click in the sidebar settings may capture with settings
    // open. Phone commands and automatic snapshots retain the closed-panel rule.
    const allowSettings = fromSettings === true
    const settingsAtCapture = current.settingsOpen
    const tabAtCapture = current.activeTab
    if (capturing.current || !previewConsent.current || (current.settingsOpen && !allowSettings) || current.loading || current.busy || current.exportBusy || !['editor', 'storyboard'].includes(current.activeTab)) return { success: false, error: allowSettings ? 'Preview needs sharing enabled and an idle Editor or Storyboard visible.' : 'Preview needs desktop sharing enabled and Editor or Storyboard visible, with settings closed.' }
    const target = current.workspaceRef?.current
    if (!target) return { success: false, error: 'No visible workspace is available for preview.' }
    const bounds = target.getBoundingClientRect()
    const rect = { x: Math.ceil(bounds.x), y: Math.ceil(bounds.y), width: Math.floor(bounds.width), height: Math.floor(bounds.height) }
    if (rect.width < 1 || rect.height < 1) return { success: false, error: 'The workspace is hidden.' }
    capturing.current = true
    try {
      const result = await window.electronAPI.connectedAgent.capture({ rect })
      const next = latest.current, after = target.getBoundingClientRect()
      if (!mounted.current || contextRef.current !== captureContext || !previewConsent.current || scopeRef.current !== scope || next.busy || next.loading || next.exportBusy || next.settingsOpen !== settingsAtCapture || next.activeTab !== tabAtCapture || target !== next.workspaceRef?.current
        || Math.abs(after.x - bounds.x) > 1 || Math.abs(after.y - bounds.y) > 1 || after.width !== bounds.width || after.height !== bounds.height) return { success: false, error: 'The desktop view changed. Request a fresh preview.' }
      if (!result?.success || !/^data:image\/jpeg;base64,/.test(result.dataUrl) || result.dataUrl.length > 1000000) throw new Error('The current view could not be shared.')
      const frame = { dataUrl: result.dataUrl, capturedAt: Date.now(), workspace: tabAtCapture }
      previewRef.current = frame; setPreview(frame)
      return { success: true, status: 'completed' }
    } catch (error) {
      if (mounted.current && contextRef.current === captureContext) setNotice(error.message || 'Preview unavailable. Try again from Editor or Storyboard.')
      return { success: false, error: 'Preview unavailable. Try again from Editor or Storyboard.' }
    }
    finally { capturing.current = false }
  }
  async function refreshPreview() {
    const refreshContext = contextRef.current
    setNotice('')
    const result = await capture({ fromSettings: true })
    if (mounted.current && contextRef.current === refreshContext) setNotice(result.success ? 'Phone preview refreshed.' : result.error)
    return result
  }
  // Snapshots only when returning to idle/chat, never continuous screen streaming.
  useEffect(() => {
    if (enabled && sharingPreview && !options.busy && !options.settingsOpen) void capture()
  }, [scope, enabled, sharingPreview, options.busy, options.settingsOpen, options.activeTab])
  useEffect(() => {
    previewAllowed = sharePreview
    if (!sharingPreview || !['editor', 'storyboard'].includes(options.activeTab)) { previewRef.current = null; setPreview(null) }
  }, [sharePreview, sharingPreview, options.activeTab])

  async function forget() {
    const result = await api?.forget?.({ scope })
    if (result?.success) { setConnection(null); setNotice('Phone forgotten. Pair again to reconnect.') }
    else setNotice('Could not forget the phone. Quit Velorn to end this connection.')
  }
  async function checkAccountRequests() {
    if (checkingAccountRef.current || !api?.checkAccountRequests) return
    checkingAccountRef.current = true; setCheckingAccount(true); setNotice('')
    try {
      const result = await api.checkAccountRequests({ scope })
      if (!result?.success) throw new Error(result?.error || 'Velorn account requests could not be checked.')
      if (mounted.current) setNotice(result.linked ? 'Computer linked. Return to My computers on your phone.'
        : result.declined ? 'Velorn account request declined. Your existing pairing is unchanged.'
          : 'No pending requests. On your signed-in Velorn account page, choose “Link this browser’s connection” first.')
    } catch (error) { if (mounted.current) setNotice(error.message || 'Velorn account requests could not be checked.') }
    finally { checkingAccountRef.current = false; if (mounted.current) setCheckingAccount(false) }
  }
  async function connectPhoneAccount({ reauthenticate = false } = {}) {
    if (typeof reauthenticate !== 'boolean') return
    if (!api?.connectPhoneAccount || enabling.current || latest.current.busy || latest.current.loading || latest.current.exportBusy || !latest.current.isCurrent()) return
    enabling.current = true; setChanging(true); setNotice('')
    const startContext = contextRef.current
    const stillCurrent = () => mounted.current && contextRef.current === startContext && latest.current.isCurrent()
    try {
      // Invoke during the click; preload requires a real user gesture.
      const result = await api.connectPhoneAccount({ scope, snapshot: snapshot(), name: computerName.trim(), automatic: true, ...(reauthenticate ? { reauthenticate: true } : {}) })
      if (!result?.success) throw new Error(result?.error || 'Phone setup could not start.')
      if (stillCurrent()) setConnection(result.status)
    } catch (error) { if (stillCurrent()) setNotice(error.message) }
    finally { enabling.current = false; if (mounted.current) setChanging(false) }
  }
  async function disconnectPhoneDevice(deviceId) {
    if (!api?.disconnectPhoneDevice || enabling.current || latest.current.busy || latest.current.loading || latest.current.exportBusy || !latest.current.isCurrent()) return
    enabling.current = true; setChanging(true); setNotice('')
    const startContext = contextRef.current
    const stillCurrent = () => mounted.current && contextRef.current === startContext && latest.current.isCurrent()
    try {
      const result = await api.disconnectPhoneDevice({ scope, deviceId })
      if (!result?.success) throw new Error(result?.error || 'Disconnection could not be confirmed. Check the connection.')
      if (stillCurrent()) { setConnection(result.status); setNotice(result.cancelled ? '' : 'Phone disconnected.') }
    } catch (error) { if (stillCurrent()) setNotice(error.message) }
    finally { enabling.current = false; if (mounted.current) setChanging(false) }
  }
  async function disconnectPhoneAccount() {
    if (!api?.disconnectPhoneAccount || enabling.current || latest.current.busy || latest.current.loading || latest.current.exportBusy || !latest.current.isCurrent()) return
    enabling.current = true; setChanging(true); setNotice('')
    const startContext = contextRef.current
    const stillCurrent = () => mounted.current && contextRef.current === startContext && latest.current.isCurrent()
    try {
      const result = await api.disconnectPhoneAccount({ scope })
      if (!result?.success) throw new Error(result?.error || 'Account disconnection could not be confirmed.')
      if (stillCurrent()) setConnection(result.status)
    } catch (error) { if (stillCurrent()) setNotice(error.message) }
    finally { enabling.current = false; if (mounted.current) setChanging(false) }
  }
  async function manageDesktopAccount(action) {
    if (!['sign-out', 'switch-account'].includes(action) || enabling.current || latest.current.busy || latest.current.loading || latest.current.exportBusy || !latest.current.isCurrent()) return
    if (!api?.manageDesktopAccount) { setNotice('Restart Velorn to enable the updated account controls.'); return }
    enabling.current = true; setChanging(true); setNotice('')
    const startContext = contextRef.current
    const stillCurrent = () => mounted.current && contextRef.current === startContext && latest.current.isCurrent()
    try {
      const result = await api.manageDesktopAccount({ scope, action, ...(action === 'switch-account' ? { snapshot: snapshot() } : {}) })
      if (!result?.success) throw new Error(result?.error || 'The account change could not finish. Check the account status before trying again.')
      if (stillCurrent()) {
        setConnection(result.status)
        setNotice(result.cancelled ? '' : action === 'sign-out' ? 'Signed out on this computer. Your projects and other accounts are unchanged.' : 'Finish signing in in your browser. If you cancel there, this computer stays signed out.')
      }
    } catch (error) { if (stillCurrent()) setNotice(error.message) }
    finally { enabling.current = false; if (mounted.current) setChanging(false) }
  }
  async function decideNative(approval, approved, riskAcknowledged, trustLocal) {
    const decisionContext = contextRef.current
    setRequestError(''); setNotice('')
    try {
      const result = await api.decideNative({ scope, approvalId: approval.approvalId, reviewToken: approval.reviewToken, approved, riskAcknowledged,
        ...(approved && approval.allowLocalTrust && trustLocal ? { trustLocal: true } : {}) })
      if (!result?.success) throw new Error(result?.error || 'This approval is no longer available.')
    } catch (error) {
      if (mounted.current && contextRef.current === decisionContext) {
        const message = error.message || 'This approval could not be confirmed.'
        setNotice(message); setRequestError(message)
      }
    }
  }
  return { available: capabilities.available, enabled, connection, pending, nativeApprovals, decideNative, changing, checkingAccount, checkAccountRequests, notice, requestError, dismissRequestError: () => setRequestError(''), enable, disable, forget, decide, sharePreview: sharingPreview, fullAccess: options.fullAccess === true, setSharePreview, preview, capture, refreshPreview,
    guidedAvailable: capabilities.guidedAvailable, legacyAvailable: capabilities.legacyAvailable,
    computerName, setComputerName, connectPhoneAccount, disconnectPhoneDevice, disconnectPhoneAccount, manageDesktopAccount }
}

export function MobileCompanionSettings({ mobile, disabled, accountPanel = false }) {
  const legacyAvailable = mobile.legacyAvailable !== false
  return <section className="ca-settings-section ca-mobile-settings" aria-label="Mobile companion">
    {!accountPanel && <h3>Mobile companion · beta</h3>}
    {!accountPanel && mobile.nativeApprovals?.map(approval => <NativeMobileApproval key={approval.approvalId} approval={approval} decide={mobile.decideNative} />)}
    {!accountPanel && mobile.guidedAvailable && <div className="ca-mobile-account-link" aria-label="Velorn account connection">
      <p>A Velorn account connects this computer for Velo access when available and lets you use your phone. Desktop editing, your own Codex, and local LM Studio do not require a Velorn account.</p>
      <p>On your phone, open <a href="https://connect.velorn.ai" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>connect.velorn.ai</a> and sign in with the same account you use to enable phone access here. Keep this computer awake with Velorn running and a project open.</p>
      {!mobile.connection?.guided?.registered ? <>
        <label>Computer name <input value={mobile.computerName} maxLength={80} onChange={event => mobile.setComputerName(event.target.value)} disabled={disabled || mobile.changing} /></label>
        <button type="button" disabled={disabled || mobile.changing || !mobile.computerName.trim()} onClick={mobile.connectPhoneAccount}>{mobile.changing ? 'Opening phone setup…' : 'Enable phone access'}</button>
      </> : <>
        <p><strong>{mobile.connection.guided.computer.name}</strong> · {mobile.connection.guided.enabled && mobile.connection.guided.automaticAccountAccess ? 'Phone access enabled' : 'Velorn account linked'}</p>
        {(!mobile.connection.guided.enabled || !mobile.connection.guided.automaticAccountAccess || mobile.connection.guided.phase === 'account-unavailable') && <button type="button" disabled={disabled || mobile.changing} onClick={mobile.connectPhoneAccount}>{mobile.changing ? 'Enabling phone access…' : 'Enable phone access'}</button>}
        {mobile.connection.guided.enabled && mobile.connection.guided.automaticAccountAccess && mobile.connection.guided.automaticAvailable && <p>{mobile.connection.guided.devices.some(device => device.connected) ? 'Your phone connection is ready.' : 'Online and ready for your phone.'} Sign in with the same account on your phone to connect.</p>}
        <details><summary>Connected devices · {mobile.connection.guided.devices.length}</summary>
          {mobile.connection.guided.devices.length ? <ul>{mobile.connection.guided.devices.map(device => <li key={device.id}>
            <span>{device.name} · {device.connected ? 'Connected' : 'Offline'}</span>{' '}
            <button type="button" disabled={disabled} onClick={() => mobile.disconnectPhoneDevice(device.id)}>Disconnect</button>
          </li>)}</ul> : <p>No phones connected yet.</p>}
          <button type="button" disabled={disabled} onClick={mobile.disconnectPhoneAccount}>Disconnect Velorn account</button>
        </details>
      </>}
      {mobile.connection?.guided?.message && <p role="status">{mobile.connection.guided.message}</p>}
    </div>}
    {!accountPanel && <p>Use your desktop agent, projects and shared media from your phone. Paid generations still ask.{!mobile.guidedAvailable && ' Your computer must stay awake with Velorn running.'}</p>}
    <details><summary>{accountPanel ? (legacyAvailable ? 'Legacy pairing' : 'Sharing details') : legacyAvailable ? 'Advanced · sharing options and older pairing' : 'Advanced · sharing options'}</summary>
    {legacyAvailable && <p>Older private-link pairing remains available here. Local HTTP addresses are for trusted Wi-Fi only: never port-forward them or expose them through an internet tunnel.</p>}
    <p>Take full access on your paired phone to enable tools, research, downloads and media sharing together. Codex includes computer commands; LM Studio uses Velorn tools. You can remember a custom workflow as local after reviewing it once.</p>
    {!mobile.available && <p>Phone connections are not available in this build.</p>}
    {mobile.available && legacyAvailable && (!mobile.enabled
      ? <button type="button" disabled={disabled || mobile.changing} onClick={mobile.enable}>{mobile.changing ? 'Waiting for confirmation…' : 'Pair a phone'}</button>
      : mobile.connection?.legacyEnabled !== false && <><p>{mobile.connection?.paired ? 'Older phone pairing is enabled' : 'Open this address on your phone, then enter the code:'}</p>
        <div className="ca-mobile-addresses">{mobile.connection?.urls?.map(url => <code key={url}>{url}</code>)}</div>
        {mobile.connection?.remote?.configured && <p role="status">Remote beta: {mobile.connection.remote.connected ? 'encrypted phone connection active' : 'waiting for the remote phone or relay'}. Use your private remote pairing link outside this network.</p>}
        {mobile.connection?.remote?.configured && <div className="ca-mobile-account-link">
          <p>To add this existing connection to My computers, sign in on your phone and choose “Link this browser’s connection”. Then check here and approve once. Desktop use stays login-free.</p>
          <button type="button" disabled={disabled || mobile.checkingAccount} onClick={mobile.checkAccountRequests}>{mobile.checkingAccount ? 'Checking Velorn account requests…' : 'Check Velorn account requests'}</button>
        </div>}
        {mobile.connection?.remote?.reason === 'configuration-error' && <p role="status">Remote configuration could not be loaded. Local sharing is still available.</p>}
        {!mobile.connection?.paired && mobile.connection?.pairingCode && <p>Pairing code: <strong className="ca-mobile-code">{mobile.connection?.pairingCode}</strong><small>Code expires in five minutes.</small></p>}
        <button type="button" onClick={mobile.forget}>Forget older pairing and stop sharing</button></>)}
      {mobile.enabled && <>
        <p>Phone connection restarts automatically with Velorn and an open project.{legacyAvailable && ' Your phone stays paired until you forget it.'} Stop sharing turns off automatic reconnection.</p>
        <label className="ca-check"><input type="checkbox" checked={mobile.sharePreview} disabled={mobile.fullAccess} onChange={event => mobile.setSharePreview(event.target.checked)} />Share Editor / Storyboard still previews{mobile.fullAccess ? ' · included in Full access' : ''}</label>
        <p>Workspace snapshots refresh after responses when Editor or Storyboard is visible, not as video playback. Saved chat images, audio and videos return when you reconnect to the project. Media streams from this computer.</p></>}
    </details>
    {mobile.enabled && <div className="ca-mobile-settings-actions">
      {mobile.sharePreview && <button type="button" disabled={disabled} onClick={() => void mobile.refreshPreview()}>Refresh phone preview</button>}
      {(!accountPanel || !mobile.guidedAvailable) && <button type="button" onClick={mobile.disable}>Stop all phone sharing</button>}
    </div>}
    {!accountPanel && mobile.notice && <p role="status">{mobile.notice}</p>}
  </section>
}

export function MobileCompanionRequest({ mobile, disabled }) {
  const needsDecision = mobile.enabled && (mobile.pending || mobile.nativeApprovals?.length > 0)
  if (!needsDecision && !mobile.requestError) return null
  return <div className="ca-mobile-request">
    {mobile.enabled && mobile.nativeApprovals?.map(approval => <NativeMobileApproval key={approval.approvalId} approval={approval} decide={mobile.decideNative} />)}
    {mobile.enabled && mobile.pending && <><p className="ca-mobile-message">{mobile.pending.text}</p><small>From your paired phone. Accept sends it to your current model; editing approvals remain here.</small>
      <div><button type="button" disabled={disabled} onClick={() => mobile.decide(true)}>Accept phone request</button><button type="button" onClick={() => mobile.decide(false)}>Decline</button></div></>}
    {mobile.requestError && <div><p role="alert">{mobile.requestError}</p><button type="button" onClick={mobile.dismissRequestError}>Dismiss</button></div>}
  </div>
}

function NativeMobileApproval({ approval, decide }) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [trustLocal, setTrustLocal] = useState(false)
  const [sending, setSending] = useState(false)
  async function answer(approved) {
    setSending(true)
    try { await decide(approval, approved, acknowledged, trustLocal) } finally { setSending(false) }
  }
  return <section className="ca-mobile-native-approval" role="group" aria-label={approval.title}>
    <strong>{approval.title}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{approval.detail}</p>
    {approval.requiresRiskAcknowledgement && <label><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />I understand and accept these risks.</label>}
    {approval.allowLocalTrust && <label><input type="checkbox" checked={trustLocal} onChange={event => setTrustLocal(event.target.checked)} />Trust this workflow as local on this computer. Your choice, not independently verified; known paid nodes still ask.</label>}
    <div><button type="button" disabled={sending} onClick={() => void answer(false)}>Decline</button>
      <button type="button" disabled={sending || (approval.requiresRiskAcknowledgement && !acknowledged)} onClick={() => void answer(true)}>Approve</button></div>
  </section>
}
