import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  X,
  KeyRound,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  Trash2,
} from 'lucide-react'
import {
  COMFY_PARTNER_DASHBOARD_URL,
  COMFY_PARTNER_WORKFLOWS,
  clearComfyPartnerApiKey,
  getComfyPartnerApiKey,
  openComfyPartnerDashboard,
  saveComfyPartnerApiKey,
  validateComfyPartnerApiKey,
} from '../services/comfyPartnerAuth'
import { useI18n } from '../i18n/I18nContext'
import { trapDialogFocus } from '../utils/dialogFocus.mjs'

function maskKey(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.length <= 10) return `${raw.slice(0, 3)}••••${raw.slice(-2)}`
  return `${raw.slice(0, 6)}••••••${raw.slice(-4)}`
}

/**
 * Shared modal for adding, replacing, or removing the Comfy.org partner API key.
 *
 * The same component is reused from Settings, the Getting Started checklist,
 * the Workflow Setup gallery, and Generate so the experience is identical no
 * matter where the user first hits a "needs API key" prompt.
 */
export default function ApiKeyDialog(props) {
  // Closing unmounts the key-bearing content, even when callers keep this
  // shared dialog mounted. No raw draft survives a closed/reopened session.
  return props.open ? <ApiKeyDialogContent {...props} /> : null
}

function ApiKeyDialogContent({
  onClose,
  onSaved,
  headline,
  subhead,
  guided = false,
  onPersist,
}) {
  const { t } = useI18n()
  const [existingKey, setExistingKey] = useState('')
  const [draftKey, setDraftKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [validation, setValidation] = useState({ state: 'idle', message: '' })
  const [validating, setValidating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const inputRef = useRef(null)
  const abortRef = useRef(null)
  const dialogRef = useRef(null), alive = useRef(true), version = useRef(0), operation = useRef(null)
  const closeRef = useRef(onClose), titleId = useId(), descriptionId = useId(), inputId = useId()
  closeRef.current = onClose
  const current = token => alive.current && token === version.current
  const invalidate = () => { version.current++; abortRef.current?.abort(); abortRef.current = null }
  const close = useCallback(() => {
    alive.current = false; invalidate()
    setDraftKey(''); setExistingKey(''); setShowKey(false)
    closeRef.current?.({ outcome: 'cancelled', validation: 'unknown' })
  }, [])

  useEffect(() => {
    alive.current = true
    const token = version.current
    const load = async () => {
      try {
        const stored = await getComfyPartnerApiKey({ nativeOnly: guided })
        if (!current(token)) return
        setExistingKey(stored)
      } catch { if (current(token)) setError(t('apiKey.readFailed')) }
      finally { if (current(token)) setLoading(false) }
    }
    void load()
    return () => { alive.current = false; invalidate(); operation.current = null }
  }, [guided])

  useEffect(() => {
    const previous = document.activeElement
    const focusTimer = setTimeout(() => { if (alive.current) inputRef.current?.focus() }, 0)
    const handler = (event) => {
      if (!alive.current) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      else if (event.key === 'Tab') { trapDialogFocus(event, dialogRef.current); event.stopPropagation() }
    }
    window.addEventListener('keydown', handler, true)
    return () => {
      clearTimeout(focusTimer); window.removeEventListener('keydown', handler, true)
      if (previous?.isConnected) previous.focus?.()
    }
  }, [close])

  useEffect(() => { if (!loading && alive.current) inputRef.current?.focus() }, [loading])

  const handleGetKey = useCallback(async () => {
    const token = version.current, result = await openComfyPartnerDashboard()
    if (current(token) && !result?.success) setError(t('apiKey.openFailed'))
  }, [t])

  const runValidation = useCallback(async (candidate) => {
    const value = String(candidate || '').trim()
    if (!value) {
      setValidation({ state: 'invalid', message: t('apiKey.pasteFirst') })
      return null
    }
    if (/[\s\x00-\x1f\x7f]/.test(value) || value.length > 4096) {
      setValidation({ state: 'invalid', message: 'Copy the full API key without spaces or control characters.' })
      return { status: 'invalid' }
    }
    invalidate()
    const token = version.current
    setValidating(true)
    setValidation({ state: 'checking', message: t('apiKey.checking') })
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = await validateComfyPartnerApiKey(value, { signal: controller.signal })
      if (!current(token) || controller.signal.aborted) return null
      setValidation({
        state: result.status === 'valid' ? 'valid'
          : result.status === 'invalid' ? 'invalid'
          : 'unknown',
        message: result.status === 'valid' ? t('apiKey.accepted') : result.status === 'invalid'
          ? 'Comfy.org rejected that key. Check the full value and try again.'
          : 'Could not verify this key. Retry Test, or explicitly save without verification.',
      })
      return result
    } catch {
      if (!current(token) || controller.signal.aborted) return null
      setValidation({ state: 'unknown', message: t('apiKey.validateFailed') })
      return { status: 'unknown' }
    } finally {
      if (current(token)) setValidating(false)
    }
  }, [t])

  const handleTest = useCallback(() => {
    if (!operation.current && !loading) void runValidation(draftKey.trim() ? draftKey : existingKey)
  }, [draftKey, existingKey, loading, runValidation])

  const handleSave = useCallback(async () => {
    if (operation.current || loading || validating) return
    const useExisting = guided && !String(draftKey || '').trim() && Boolean(existingKey)
    const value = String(useExisting ? existingKey : draftKey || '').trim()
    if (!value) {
      setError(t('apiKey.pasteBeforeSave'))
      return
    }
    const request = {}; operation.current = request
    setSaving(true)
    setError('')
    try {
      let finalState = validation.state
      if (finalState === 'idle' || finalState === 'checking') {
        const result = await runValidation(value)
        if (!result || !alive.current) return
        finalState = result.status === 'valid' ? 'valid' : result.status === 'invalid' ? 'invalid' : 'unknown'
        // An ambiguous validation never silently becomes a verified save.
        // A second explicit click, labelled accordingly, may save unknown.
        if (finalState === 'unknown') return
      }
      if (finalState === 'invalid' || !alive.current) return
      const token = version.current
      const result = onPersist ? await onPersist({ key: value, validation: finalState, useExisting }) : await saveComfyPartnerApiKey(value)
      if (!current(token)) return
      if (result?.success !== true) throw new Error('Save failed')
      if (!onPersist) onSaved?.(value)
      setDraftKey(''); setExistingKey(''); setShowKey(false)
      alive.current = false; invalidate()
      closeRef.current?.({ outcome: 'saved', validation: finalState })
    } catch { if (alive.current) setError(t('apiKey.saveFailed')) }
    finally {
      if (operation.current === request) operation.current = null
      if (alive.current) setSaving(false)
    }
  }, [draftKey, existingKey, guided, loading, validating, onPersist, onSaved, runValidation, t, validation.state])

  const handleRemove = useCallback(async () => {
    if (operation.current || loading) return
    invalidate(); setValidating(false)
    const token = version.current, request = {}; operation.current = request
    setSaving(true)
    setError('')
    try {
      const result = onPersist ? await onPersist({ key: '', validation: 'unknown' }) : await clearComfyPartnerApiKey()
      if (!current(token)) return
      if (result?.success !== true) throw new Error('Remove failed')
      setExistingKey('')
      setDraftKey('')
      setValidation({ state: 'idle', message: '' })
      if (!onPersist) onSaved?.('')
      else { alive.current = false; invalidate(); closeRef.current?.({ outcome: 'removed', validation: 'unknown' }) }
    } catch { if (current(token)) setError(t('apiKey.removeFailed')) }
    finally {
      if (operation.current === request) operation.current = null
      if (alive.current) setSaving(false)
    }
  }, [loading, onPersist, onSaved, t])

  const hasDraft = Boolean(String(draftKey || '').trim())
  const hasExisting = Boolean(String(existingKey || '').trim())

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 px-3 py-4"
      onClick={close}
    >
      <div
        ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-sf-dark-600 bg-sf-dark-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-sf-dark-700 px-4 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-sf-dark-800 p-2">
              <KeyRound className="h-4 w-4 text-sf-accent" />
            </div>
            <div>
              <h2 id={titleId} className="text-base font-semibold text-sf-text-primary">
                {headline || t('apiKey.title')}
              </h2>
              <p id={descriptionId} className="mt-1 text-xs text-sf-text-muted">
                {subhead || t('apiKey.subtitle')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="rounded-lg p-1.5 text-sf-text-muted transition-colors hover:bg-sf-dark-800 hover:text-sf-text-primary"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 space-y-4 overflow-y-auto px-4 py-4">
          {guided ? <p className="text-xs text-sf-text-muted">This key enables paid Partner/API nodes through your local ComfyUI server. It is optional for local editing. Saving it does not buy credits, start a generation, or change your spending settings.</p> : <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 px-3 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-sf-text-muted">
              {t('apiKey.unlocks')}
            </div>
            <ul className="mt-1.5 space-y-0.5 text-xs text-sf-text-secondary">
              {COMFY_PARTNER_WORKFLOWS.map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-sf-accent" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-sf-text-muted">
              {t('apiKey.coverage')}
            </p>
          </div>}

          {loading && <p role="status" className="text-xs text-sf-text-muted">Reading saved key…</p>}

          {hasExisting && !hasDraft && (
            <div className="rounded-lg border border-sf-dark-600 bg-sf-dark-900/70 px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-2">
                  <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-sf-text-muted" aria-hidden="true" />
                  <div>
                    <div className="text-sm text-sf-text-primary">{t('apiKey.alreadySaved')}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-sf-text-muted">
                      {guided ? 'Saved on this computer. Test it before continuing.' : maskKey(existingKey)}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { void handleRemove() }}
                  disabled={saving}
                  className="inline-flex items-center gap-1 rounded-md border border-sf-dark-600 px-2 py-1 text-[11px] text-sf-text-muted transition-colors hover:border-sf-error/40 hover:text-sf-error disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" />
                  {t('apiKey.remove')}
                </button>
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-sf-text-secondary" htmlFor={inputId}>
                {hasExisting ? t('apiKey.replacePrompt') : t('apiKey.pastePrompt')}
              </label>
              <button
                type="button"
                onClick={() => { void handleGetKey() }}
                className="inline-flex items-center gap-1 text-[11px] text-sf-accent hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                {t('apiKey.getKey')}
              </button>
            </div>
            <div className="mt-1.5 flex gap-2">
              <div className="relative flex-1">
                <input
                  id={inputId}
                  ref={inputRef}
                  type={showKey ? 'text' : 'password'}
                  autoComplete="off"
                  maxLength={4096}
                  spellCheck={false}
                  disabled={loading || saving}
                  value={draftKey}
                  onChange={(e) => {
                    invalidate(); setValidating(false); setError('')
                    setDraftKey(e.target.value)
                    if (validation.state !== 'idle') {
                      setValidation({ state: 'idle', message: '' })
                    }
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !validating && !saving && hasDraft) {
                      e.preventDefault()
                      void handleSave()
                    }
                  }}
                  placeholder="comfyui-..."
                  className="w-full rounded border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 pr-9 text-sm text-sf-text-primary placeholder-sf-text-muted focus:border-sf-accent focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((prev) => !prev)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1.5 text-sf-text-muted hover:text-sf-text-primary"
                  aria-label={showKey ? t('apiKey.hide') : t('apiKey.show')}
                  tabIndex={-1}
                >
                  {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
              <button
                type="button"
                onClick={handleTest}
                disabled={(!hasDraft && !hasExisting) || validating || saving || loading}
                className="inline-flex items-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {validating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {!hasDraft && hasExisting ? 'Test saved key' : t('apiKey.test')}
              </button>
            </div>

            {validation.state === 'checking' && (
              <div role="status" className="mt-2 flex items-center gap-1.5 text-[11px] text-sf-text-muted">
                <Loader2 className="h-3 w-3 animate-spin" />
                {validation.message || t('apiKey.checkingShort')}
              </div>
            )}
            {validation.state === 'valid' && (
              <div role="status" className="mt-2 flex items-center gap-1.5 text-[11px] text-green-400">
                <CheckCircle2 className="h-3 w-3" />
                {validation.message}
              </div>
            )}
            {validation.state === 'invalid' && (
              <div role="alert" className="mt-2 flex items-start gap-1.5 text-[11px] text-sf-error">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{validation.message}</span>
              </div>
            )}
            {validation.state === 'unknown' && (
              <div role="status" className="mt-2 flex items-start gap-1.5 text-[11px] text-yellow-300">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{validation.message}</span>
              </div>
            )}
          </div>

          {error && (
            <div role="alert" className="rounded border border-sf-error/40 bg-sf-error/10 px-3 py-2 text-[11px] text-sf-error">
              {error}
            </div>
          )}

          <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/40 px-3 py-2.5 text-[11px] text-sf-text-muted">
            {guided ? 'Saved in Velorn’s settings on this computer. Used for Comfy key checks and Partner/API requests; never included in chat or agent tool results.' : <>{t('apiKey.storagePrefix')}{' '}
            <code className="rounded bg-sf-dark-800 px-1">api_key_comfy_org</code>{' '}
            {t('apiKey.storageSuffix')}</>}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-sf-dark-700 bg-sf-dark-900/40 px-4 py-3">
          <a
            href={COMFY_PARTNER_DASHBOARD_URL}
            onClick={(event) => {
              event.preventDefault()
              void handleGetKey()
            }}
            className="inline-flex items-center gap-1 text-[11px] text-sf-text-muted hover:text-sf-text-primary"
          >
            <ExternalLink className="h-3 w-3" />
            platform.comfy.org
          </a>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded border border-sf-dark-600 px-3 py-1.5 text-xs text-sf-text-secondary transition-colors hover:text-sf-text-primary hover:border-sf-dark-500"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => { void handleSave() }}
              disabled={(!hasDraft && !(guided && hasExisting)) || loading || saving || validating || validation.state === 'invalid'}
              className="inline-flex items-center gap-1.5 rounded bg-sf-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {validation.state === 'unknown' ? (!hasDraft && guided && hasExisting ? 'Use without verification' : 'Save without verification')
                : !hasDraft && guided && hasExisting ? 'Use saved key' : hasExisting ? t('apiKey.replace') : t('apiKey.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
