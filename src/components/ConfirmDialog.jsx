import { X } from 'lucide-react'
import { useI18n } from '../i18n/I18nContext'

export default function ConfirmDialog({
  isOpen,
  title,
  message = '',
  confirmLabel,
  cancelLabel,
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}) {
  const { t } = useI18n()
  if (!isOpen) return null

  const resolvedTitle = title || t('confirmDialog.title')
  const resolvedConfirmLabel = confirmLabel || t('confirmDialog.confirm')
  const resolvedCancelLabel = cancelLabel || t('common.cancel')

  const confirmToneClass = tone === 'danger'
    ? 'bg-sf-error hover:bg-red-500 text-white'
    : 'bg-sf-accent hover:bg-sf-accent-hover text-white'

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70" onClick={busy ? undefined : onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={resolvedTitle}
        aria-busy={busy}
        className="w-full max-w-md mx-4 rounded-xl border border-sf-dark-600 bg-sf-dark-900 shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-sf-dark-700">
          <h3 className="text-sm font-medium text-sf-text-primary">{resolvedTitle}</h3>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="p-1 rounded hover:bg-sf-dark-700 text-sf-text-muted"
            title={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-4 py-4 text-sm text-sf-text-secondary whitespace-pre-line max-h-[55vh] overflow-y-auto break-words">
          {message}
        </div>
        <div className="px-4 py-3 border-t border-sf-dark-700 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="px-3 py-1.5 rounded bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary text-xs"
          >
            {resolvedCancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`px-3 py-1.5 rounded text-xs ${confirmToneClass}`}
          >
            {resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
