import { useEffect, useRef } from 'react'
import DiscoverWorkspace from './DiscoverWorkspace'
import { useI18n } from '../i18n/I18nContext'
import { trapDialogFocus } from '../utils/dialogFocus.mjs'

export default function DiscoverModal({ isOpen, onClose }) {
  const { t } = useI18n()
  const dialogRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return undefined
    const previousFocus = document.activeElement
    dialogRef.current?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-5"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose?.()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('discover.title', undefined, 'Tutorials')}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose?.()
            return
          }
          trapDialogFocus(event, dialogRef.current)
        }}
        className="flex h-full max-h-[920px] w-full max-w-[1500px] overflow-hidden rounded-2xl border border-sf-dark-600 bg-sf-dark-950 shadow-2xl outline-none"
      >
        <DiscoverWorkspace onClose={onClose} />
      </div>
    </div>
  )
}
