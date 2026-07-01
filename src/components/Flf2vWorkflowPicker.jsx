import { useEffect, useRef, useState } from 'react'
import { Check, FileJson, Upload, X, AlertTriangle } from 'lucide-react'
import {
  BUNDLED_FLF2V_PROFILES,
  detectProfileFromJson,
} from '../services/builtinWorkflows/flf2vProfiles'

/**
 * Inline popover for choosing the FLF2V workflow.
 *
 * - Lists bundled profiles (hand-tuned, ship with the app).
 * - "Import JSON..." button lets the user load any ComfyUI API-format
 *   workflow JSON; auto-detects schema and shows warnings if ambiguous.
 * - Calls onSelect(profile) when a profile is chosen; caller persists.
 *
 * Positioning: simple absolute anchored under the trigger. No portal —
 * the popover is small enough that overflow is rare in this card.
 */
export default function Flf2vWorkflowPicker({
  currentProfileId,
  importedProfile,            // currently active imported profile (if any)
  onSelect,                   // (profile) => void
  onClose,
}) {
  const popRef = useRef(null)
  const fileInputRef = useRef(null)
  const [importError, setImportError] = useState(null)
  const [importWarnings, setImportWarnings] = useState([])

  // Click-outside to close
  useEffect(() => {
    function onDocDown(e) {
      if (popRef.current && !popRef.current.contains(e.target)) {
        onClose?.()
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function handlePickFile() {
    fileInputRef.current?.click()
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-importing same file
    if (!file) return
    setImportError(null)
    setImportWarnings([])
    try {
      const text = await file.text()
      const json = JSON.parse(text)
      const sourceName = file.name.replace(/\.json$/i, '')
      const profile = detectProfileFromJson(json, sourceName)
      setImportWarnings(profile.detectWarnings || [])
      onSelect(profile)
      onClose?.()
    } catch (err) {
      setImportError(err?.message || 'Failed to parse JSON')
    }
  }

  const isCurrent = (id) => id === currentProfileId

  return (
    <div
      ref={popRef}
      className="absolute z-50 top-full right-0 mt-1 w-80 rounded-md border border-sf-dark-600 bg-sf-dark-800 shadow-xl"
      role="dialog"
      aria-label="Choose FLF2V workflow"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-sf-dark-600">
        <div className="text-[11px] uppercase tracking-wider text-sf-text-muted">
          FLF2V workflow
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-0.5 rounded text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-700"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="max-h-72 overflow-y-auto py-1">
        {BUNDLED_FLF2V_PROFILES.map((p) => (
          <ProfileRow
            key={p.id}
            profile={p}
            active={isCurrent(p.id)}
            onPick={() => { onSelect(p); onClose?.() }}
          />
        ))}
        {importedProfile && isCurrent(importedProfile.id) && (
          <ProfileRow
            key={importedProfile.id}
            profile={importedProfile}
            active
            imported
            onPick={() => { onSelect(importedProfile); onClose?.() }}
          />
        )}
      </div>

      <div className="border-t border-sf-dark-600 p-2">
        <button
          type="button"
          onClick={handlePickFile}
          className="w-full flex items-center justify-center gap-2 px-2 py-1.5 rounded bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-primary text-xs"
        >
          <Upload className="w-3.5 h-3.5" />
          Import JSON file…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleFileChange}
        />
        {importError && (
          <div className="mt-2 px-2 py-1.5 rounded bg-red-500/15 border border-red-500/40 text-[11px] text-red-200">
            {importError}
          </div>
        )}
        {importWarnings.length > 0 && (
          <div className="mt-2 px-2 py-1.5 rounded bg-yellow-500/15 border border-yellow-500/40 text-[11px] text-yellow-100">
            <div className="flex items-center gap-1 font-medium">
              <AlertTriangle className="w-3 h-3" />
              Imported with warnings:
            </div>
            <ul className="mt-1 ml-4 list-disc">
              {importWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}

function ProfileRow({ profile, active, imported, onPick }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-sf-dark-700 ${
        active ? 'bg-sf-accent/10' : ''
      }`}
    >
      <div className="mt-0.5 flex-shrink-0">
        {imported
          ? <FileJson className="w-3.5 h-3.5 text-sf-text-muted" />
          : active
            ? <Check className="w-3.5 h-3.5 text-sf-accent" />
            : <div className="w-3.5 h-3.5" />
        }
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-xs truncate ${active ? 'text-sf-accent' : 'text-sf-text-primary'}`}>
          {profile.label}
        </div>
        {profile.description && (
          <div className="text-[10px] text-sf-text-muted line-clamp-2">
            {profile.description}
          </div>
        )}
        <div className="text-[9px] uppercase tracking-wider text-sf-text-muted mt-0.5">
          {profile.kind}{imported ? ' • imported' : ' • bundled'}
        </div>
      </div>
    </button>
  )
}
