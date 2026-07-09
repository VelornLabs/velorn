import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, Send } from 'lucide-react'
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  collectFeedbackDiagnostics,
  sendFeedback,
} from '../services/feedback'

const DIAGNOSTIC_LABELS = [
  ['appVersion', 'Velorn version'],
  ['platform', 'Platform'],
  ['os', 'OS'],
  ['gpu', 'GPU'],
  ['comfyConnected', 'ComfyUI connected'],
  ['screen', 'Screen'],
]

function formatDiagnosticValue(value) {
  if (value === null || value === undefined || value === '') return 'unknown'
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return String(value)
}

export default function FeedbackSection() {
  const [category, setCategory] = useState('bug')
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true)
  const [diagnostics, setDiagnostics] = useState(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const collected = await collectFeedbackDiagnostics()
      if (!cancelled) setDiagnostics(collected)
    })()
    return () => { cancelled = true }
  }, [])

  const handleSend = async () => {
    if (sending) return
    setError('')
    setSending(true)
    try {
      await sendFeedback({
        category,
        message,
        email,
        diagnostics: includeDiagnostics ? diagnostics : null,
      })
      setSent(true)
      setMessage('')
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Could not send feedback.')
    } finally {
      setSending(false)
    }
  }

  if (sent) {
    return (
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-4 py-6 text-center">
        <CheckCircle2 className="mx-auto h-8 w-8 text-green-300" />
        <div className="mt-3 text-sm font-medium text-sf-text-primary">Thanks — got it.</div>
        <p className="mt-1 text-[11px] text-sf-text-muted">
          Your feedback goes straight to the team. If you left an email, we may follow up.
        </p>
        <button
          type="button"
          onClick={() => { setSent(false); setError('') }}
          className="mt-4 rounded bg-sf-dark-700 px-3 py-1.5 text-[11px] text-sf-text-secondary hover:bg-sf-dark-600"
        >
          Send another
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-900/60 px-3 py-3">
        <div className="text-sm font-medium text-sf-text-primary">Send feedback</div>
        <p className="mt-1 text-[11px] text-sf-text-muted">
          Found a bug, missing a feature, or just have a thought? It lands directly with the team —
          no account, no forms, no GitHub required.
        </p>

        <div className="mt-3 flex items-center gap-1.5">
          {FEEDBACK_CATEGORIES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setCategory(entry.id)}
              className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                category === entry.id
                  ? 'bg-sf-accent text-white'
                  : 'border border-sf-dark-700 bg-sf-dark-800 text-sf-text-muted hover:border-sf-dark-500 hover:text-sf-text-primary'
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
          rows={5}
          placeholder={category === 'bug'
            ? 'What happened, and what did you expect instead?'
            : 'Tell us what you are thinking...'}
          className="mt-3 w-full resize-y rounded-lg border border-sf-dark-700 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary outline-none transition-colors placeholder:text-sf-text-muted focus:border-sf-accent"
        />

        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Email for a reply (optional)"
          className="mt-2 w-full rounded-lg border border-sf-dark-700 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary outline-none transition-colors placeholder:text-sf-text-muted focus:border-sf-accent"
        />

        <label className="mt-3 flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={includeDiagnostics}
            onChange={(event) => setIncludeDiagnostics(event.target.checked)}
            className="mt-0.5 accent-sf-accent"
          />
          <span className="text-[11px] text-sf-text-muted">
            Include system info — it makes bugs much easier to fix. Exactly this, nothing more:
          </span>
        </label>

        {includeDiagnostics && (
          <div className="mt-2 rounded border border-sf-dark-700 bg-black/30 px-3 py-2">
            {diagnostics ? (
              <dl className="space-y-0.5">
                {DIAGNOSTIC_LABELS.map(([key, label]) => (
                  <div key={key} className="flex gap-2 text-[11px]">
                    <dt className="w-36 flex-shrink-0 text-sf-text-muted">{label}</dt>
                    <dd className="min-w-0 truncate text-sf-text-secondary">{formatDiagnosticValue(diagnostics[key])}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="text-[11px] text-sf-text-muted">Collecting…</div>
            )}
          </div>
        )}

        {error && <p className="mt-2 text-[11px] text-red-300">{error}</p>}

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[10px] text-sf-text-muted">
            {message.trim().length}/{FEEDBACK_MESSAGE_MAX_LENGTH}
          </span>
          <button
            type="button"
            onClick={() => { void handleSend() }}
            disabled={sending || message.trim().length === 0}
            className="inline-flex items-center gap-1.5 rounded bg-sf-accent px-3 py-1.5 text-[11px] font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            {sending ? 'Sending…' : 'Send feedback'}
          </button>
        </div>
      </div>
    </div>
  )
}
