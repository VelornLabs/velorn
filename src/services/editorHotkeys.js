const EDITOR_HOTKEYS_STORAGE_KEY = 'comfystudio-editor-hotkeys-v1'
export const EDITOR_HOTKEYS_CHANGED_EVENT = 'comfystudio-editor-hotkeys-changed'

export const EDITOR_HOTKEY_IDS = {
  TOGGLE_SNAPPING: 'timeline.toggleSnapping',
  TOGGLE_RIPPLE: 'timeline.toggleRipple',
  TOGGLE_CLIP_ENABLED: 'timeline.toggleClipEnabled',
  ADD_MARKER: 'timeline.addMarker',
  PREVIOUS_CLIP_BOUNDARY: 'timeline.previousClipBoundary',
  NEXT_CLIP_BOUNDARY: 'timeline.nextClipBoundary',
  PREVIOUS_MARKER: 'timeline.previousMarker',
  NEXT_MARKER: 'timeline.nextMarker',
  PLAY_AROUND: 'timeline.playAround',
  FRAME_ALL: 'timeline.frameAll',
  ZOOM_TO_SELECTION: 'timeline.zoomToSelection',
  ZOOM_OUT: 'timeline.zoomOut',
  ZOOM_IN: 'timeline.zoomIn',
  MATCH_FRAME: 'timeline.matchFrame',
  REVEAL_IN_ASSETS: 'timeline.revealInAssets',
  SELECT_TO_END: 'timeline.selectToEnd',
  SELECT_FROM_START: 'timeline.selectFromStart',
  SPLIT_ACTIVE: 'timeline.splitActive',
  SPLIT_ALL: 'timeline.splitAll',
  OPEN_MOVE_BY: 'timeline.openMoveBy',
  OPEN_DURATION_BY: 'timeline.openDurationBy',
  ADD_TEXT_CLIP: 'timeline.addTextClip',
  ADD_TRANSITION: 'timeline.addTransition',
  LINK_SELECTION: 'timeline.linkSelection',
  UNLINK_SELECTION: 'timeline.unlinkSelection',
  TRIM_START_TO_PLAYHEAD: 'timeline.trimStartToPlayhead',
  TRIM_END_TO_PLAYHEAD: 'timeline.trimEndToPlayhead',
  NUDGE_LEFT: 'timeline.nudgeLeft',
  NUDGE_RIGHT: 'timeline.nudgeRight',
  NUDGE_LEFT_BIG: 'timeline.nudgeLeftBig',
  NUDGE_RIGHT_BIG: 'timeline.nudgeRightBig',
}

export const EDITOR_HOTKEY_DEFINITIONS = [
  {
    id: EDITOR_HOTKEY_IDS.SELECT_TO_END,
    label: 'Select clips from playhead to end',
    description: 'Timeline selection',
    defaultBinding: 'E',
  },
  {
    id: EDITOR_HOTKEY_IDS.SELECT_FROM_START,
    label: 'Select clips from start to playhead',
    description: 'Timeline selection',
    defaultBinding: 'Shift+E',
  },
  {
    id: EDITOR_HOTKEY_IDS.SPLIT_ACTIVE,
    label: 'Split at playhead on active track',
    description: 'Timeline editing',
    defaultBinding: 'X',
  },
  {
    id: EDITOR_HOTKEY_IDS.SPLIT_ALL,
    label: 'Split all tracks at playhead',
    description: 'Timeline editing',
    defaultBinding: 'Shift+X',
  },
  {
    id: EDITOR_HOTKEY_IDS.TOGGLE_SNAPPING,
    label: 'Toggle snapping',
    description: 'Timeline editing',
    defaultBinding: 'S',
  },
  {
    id: EDITOR_HOTKEY_IDS.TOGGLE_RIPPLE,
    label: 'Toggle ripple edit',
    description: 'Timeline editing',
    defaultBinding: 'R',
  },
  {
    id: EDITOR_HOTKEY_IDS.TOGGLE_CLIP_ENABLED,
    label: 'Enable or disable selected clips',
    description: 'Timeline clip state',
    defaultBinding: 'D',
  },
  {
    id: EDITOR_HOTKEY_IDS.ADD_MARKER,
    label: 'Add marker at playhead',
    description: 'Timeline navigation',
    defaultBinding: 'M',
  },
  {
    id: EDITOR_HOTKEY_IDS.PREVIOUS_CLIP_BOUNDARY,
    label: 'Jump to previous visible clip boundary',
    description: 'Timeline navigation',
    defaultBinding: 'ArrowUp',
  },
  {
    id: EDITOR_HOTKEY_IDS.NEXT_CLIP_BOUNDARY,
    label: 'Jump to next visible clip boundary',
    description: 'Timeline navigation',
    defaultBinding: 'ArrowDown',
  },
  {
    id: EDITOR_HOTKEY_IDS.MATCH_FRAME,
    label: 'Match frame (open clip source at the playhead frame)',
    description: 'Timeline navigation',
    defaultBinding: 'F',
  },
  {
    id: EDITOR_HOTKEY_IDS.REVEAL_IN_ASSETS,
    label: 'Reveal clip asset in the Assets panel',
    description: 'Timeline navigation',
    defaultBinding: 'Shift+F',
  },
  {
    id: EDITOR_HOTKEY_IDS.PREVIOUS_MARKER,
    label: 'Jump to previous marker',
    description: 'Timeline navigation',
    defaultBinding: 'Shift+ArrowUp',
  },
  {
    id: EDITOR_HOTKEY_IDS.NEXT_MARKER,
    label: 'Jump to next marker',
    description: 'Timeline navigation',
    defaultBinding: 'Shift+ArrowDown',
  },
  {
    id: EDITOR_HOTKEY_IDS.PLAY_AROUND,
    label: 'Play around edit',
    description: 'Preview 2 seconds before and after the playhead, then return',
    defaultBinding: 'Shift+K',
  },
  {
    id: EDITOR_HOTKEY_IDS.FRAME_ALL,
    label: 'Frame all timeline content',
    description: 'Timeline navigation',
    defaultBinding: '1',
  },
  {
    id: EDITOR_HOTKEY_IDS.ZOOM_TO_SELECTION,
    label: 'Zoom to selection / restore previous view',
    description: 'Timeline navigation',
    defaultBinding: 'Z',
  },
  {
    id: EDITOR_HOTKEY_IDS.ZOOM_OUT,
    label: 'Zoom out timeline',
    description: 'Timeline navigation',
    defaultBinding: '2',
  },
  {
    id: EDITOR_HOTKEY_IDS.ZOOM_IN,
    label: 'Zoom in timeline',
    description: 'Timeline navigation',
    defaultBinding: '3',
  },
  {
    id: EDITOR_HOTKEY_IDS.OPEN_MOVE_BY,
    label: 'Open Move By dialog',
    description: 'Precision editing',
    defaultBinding: 'Ctrl+Shift+M',
  },
  {
    id: EDITOR_HOTKEY_IDS.OPEN_DURATION_BY,
    label: 'Open Duration By dialog',
    description: 'Precision editing',
    defaultBinding: '',
  },
  {
    id: EDITOR_HOTKEY_IDS.ADD_TEXT_CLIP,
    label: 'Add text clip at playhead',
    description: 'Timeline text',
    defaultBinding: 'Ctrl+T',
  },
  {
    id: EDITOR_HOTKEY_IDS.ADD_TRANSITION,
    label: 'Add transition between selected clips',
    description: 'Timeline transitions',
    defaultBinding: 'Shift+T',
  },
  {
    id: EDITOR_HOTKEY_IDS.LINK_SELECTION,
    label: 'Link selected clips',
    description: 'Timeline linking',
    defaultBinding: 'Ctrl+L',
  },
  {
    id: EDITOR_HOTKEY_IDS.UNLINK_SELECTION,
    label: 'Unlink selected clips',
    description: 'Timeline linking',
    defaultBinding: 'Ctrl+Shift+L',
  },
  {
    id: EDITOR_HOTKEY_IDS.TRIM_START_TO_PLAYHEAD,
    label: 'Trim clip start to playhead',
    description: 'Timeline editing',
    defaultBinding: 'Q',
  },
  {
    id: EDITOR_HOTKEY_IDS.TRIM_END_TO_PLAYHEAD,
    label: 'Trim clip end to playhead',
    description: 'Timeline editing',
    defaultBinding: 'W',
  },
  {
    id: EDITOR_HOTKEY_IDS.NUDGE_LEFT,
    label: 'Nudge selected clips 1 frame earlier',
    description: 'Timeline editing',
    defaultBinding: 'Alt+ArrowLeft',
  },
  {
    id: EDITOR_HOTKEY_IDS.NUDGE_RIGHT,
    label: 'Nudge selected clips 1 frame later',
    description: 'Timeline editing',
    defaultBinding: 'Alt+ArrowRight',
  },
  {
    id: EDITOR_HOTKEY_IDS.NUDGE_LEFT_BIG,
    label: 'Nudge selected clips 10 frames earlier',
    description: 'Timeline editing',
    defaultBinding: 'Alt+Shift+ArrowLeft',
  },
  {
    id: EDITOR_HOTKEY_IDS.NUDGE_RIGHT_BIG,
    label: 'Nudge selected clips 10 frames later',
    description: 'Timeline editing',
    defaultBinding: 'Alt+Shift+ArrowRight',
  },
]

export const DEFAULT_EDITOR_HOTKEYS = EDITOR_HOTKEY_DEFINITIONS.reduce((acc, definition) => {
  acc[definition.id] = definition.defaultBinding || ''
  return acc
}, {})

export const EDITOR_HOTKEY_PRESETS = [
  {
    id: 'comfystudio',
    label: 'Velorn',
    description: 'Current default editor bindings.',
    bindings: { ...DEFAULT_EDITOR_HOTKEYS },
  },
  {
    id: 'premiere',
    label: 'Premiere-style',
    description: 'Ctrl+K split, Ctrl+Shift+K split all, M marker, S snapping.',
    bindings: {
      ...DEFAULT_EDITOR_HOTKEYS,
      [EDITOR_HOTKEY_IDS.SPLIT_ACTIVE]: 'Ctrl+K',
      [EDITOR_HOTKEY_IDS.SPLIT_ALL]: 'Ctrl+Shift+K',
      [EDITOR_HOTKEY_IDS.TOGGLE_SNAPPING]: 'S',
      [EDITOR_HOTKEY_IDS.ADD_MARKER]: 'M',
    },
  },
  {
    id: 'resolve',
    label: 'Resolve-style',
    description: 'Ctrl+\\ split, Ctrl+Shift+\\ split all, M marker, N snapping.',
    bindings: {
      ...DEFAULT_EDITOR_HOTKEYS,
      [EDITOR_HOTKEY_IDS.SPLIT_ACTIVE]: 'Ctrl+\\',
      [EDITOR_HOTKEY_IDS.SPLIT_ALL]: 'Ctrl+Shift+\\',
      [EDITOR_HOTKEY_IDS.TOGGLE_SNAPPING]: 'N',
      [EDITOR_HOTKEY_IDS.ADD_MARKER]: 'M',
    },
  },
  {
    id: 'final-cut',
    label: 'Final Cut-style',
    description: 'Ctrl+B split, Ctrl+Shift+B split all, M marker, N snapping.',
    bindings: {
      ...DEFAULT_EDITOR_HOTKEYS,
      [EDITOR_HOTKEY_IDS.SPLIT_ACTIVE]: 'Ctrl+B',
      [EDITOR_HOTKEY_IDS.SPLIT_ALL]: 'Ctrl+Shift+B',
      [EDITOR_HOTKEY_IDS.TOGGLE_SNAPPING]: 'N',
      [EDITOR_HOTKEY_IDS.ADD_MARKER]: 'M',
    },
  },
]

const RESERVED_FIXED_BINDINGS = new Set([
  'Space',
  'Enter',
  'ArrowLeft',
  'ArrowRight',
  'Ctrl+Z',
  'Ctrl+Shift+Z',
  'Ctrl+Y',
  'Delete',
  'Backspace',
  'Ctrl+A',
  'Ctrl+C',
  'Ctrl+V',
  'I',
  'O',
  'Alt+X',
  // Timeline tool keys are fixed, so a shortcut bound to one would never fire.
  'A',
  'V',
  'T',
  'B',
  'Y',
  'U',
  'Shift+ArrowLeft',
  'Shift+ArrowRight',
  'Home',
  'End',
])

function normalizeKeyLabel(key) {
  const raw = String(key || '').trim()
  if (!raw) return ''

  if (raw === ' ') return 'Space'

  const lower = raw.toLowerCase()
  const named = {
    escape: 'Escape',
    esc: 'Escape',
    enter: 'Enter',
    return: 'Enter',
    delete: 'Delete',
    del: 'Delete',
    backspace: 'Backspace',
    tab: 'Tab',
    'arrowleft': 'ArrowLeft',
    'arrowright': 'ArrowRight',
    'arrowup': 'ArrowUp',
    'arrowdown': 'ArrowDown',
    space: 'Space',
  }
  if (named[lower]) return named[lower]

  if (/^f\d{1,2}$/i.test(raw)) return raw.toUpperCase()
  if (raw.length === 1) return raw.toUpperCase()
  return raw[0].toUpperCase() + raw.slice(1)
}

function normalizeHotkeyEventKey(event) {
  const digitMatch = /^Digit([0-9])$/.exec(String(event?.code || ''))
  if (digitMatch) return digitMatch[1]
  return normalizeKeyLabel(event?.key)
}

export function normalizeEditorHotkeyBinding(binding) {
  const raw = String(binding || '').trim()
  if (!raw) return ''

  const parts = raw.split('+').map(part => part.trim()).filter(Boolean)
  if (parts.length === 0) return ''

  let primary = false
  let alt = false
  let shift = false
  let key = ''

  parts.forEach((part) => {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control' || lower === 'cmd' || lower === 'command' || lower === 'meta') {
      primary = true
      return
    }
    if (lower === 'alt' || lower === 'option') {
      alt = true
      return
    }
    if (lower === 'shift') {
      shift = true
      return
    }
    key = normalizeKeyLabel(part)
  })

  if (!key) return ''

  const normalized = []
  if (primary) normalized.push('Ctrl')
  if (alt) normalized.push('Alt')
  if (shift) normalized.push('Shift')
  normalized.push(key)
  return normalized.join('+')
}

export function formatEditorHotkey(binding) {
  const normalized = normalizeEditorHotkeyBinding(binding)
  return normalized || 'Not set'
}

export function isReservedEditorHotkeyBinding(binding) {
  const normalized = normalizeEditorHotkeyBinding(binding)
  return RESERVED_FIXED_BINDINGS.has(normalized)
}

export function matchEditorHotkey(event, binding) {
  const normalized = normalizeEditorHotkeyBinding(binding)
  if (!normalized) return false

  const parts = normalized.split('+')
  const key = parts[parts.length - 1]
  const requiresPrimary = parts.includes('Ctrl')
  const requiresAlt = parts.includes('Alt')
  const requiresShift = parts.includes('Shift')
  const pressedPrimary = !!(event.ctrlKey || event.metaKey)
  const pressedAlt = !!event.altKey
  const pressedShift = !!event.shiftKey
  const pressedKeys = new Set([
    normalizeKeyLabel(event.key),
    normalizeHotkeyEventKey(event),
  ])

  return (
    pressedKeys.has(key) &&
    pressedPrimary === requiresPrimary &&
    pressedAlt === requiresAlt &&
    pressedShift === requiresShift
  )
}

export function hotkeyEventToBinding(event) {
  const key = normalizeHotkeyEventKey(event)
  if (!key || ['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return ''

  const parts = []
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  parts.push(key)
  return normalizeEditorHotkeyBinding(parts.join('+'))
}

export function assignEditorHotkeyBinding(bindings, actionId, binding) {
  const next = { ...(bindings || {}) }
  const normalized = normalizeEditorHotkeyBinding(binding)

  if (normalized) {
    for (const definition of EDITOR_HOTKEY_DEFINITIONS) {
      if (
        definition.id !== actionId &&
        normalizeEditorHotkeyBinding(next[definition.id]) === normalized
      ) {
        next[definition.id] = ''
      }
    }
  }

  next[actionId] = normalized
  return next
}

export function mergeEditorHotkeys(stored) {
  const merged = { ...DEFAULT_EDITOR_HOTKEYS }
  if (!stored || typeof stored !== 'object') return merged

  const explicitlyStoredIds = new Set()
  for (const definition of EDITOR_HOTKEY_DEFINITIONS) {
    const raw = stored[definition.id]
    // Plain T always selected the Trim tool first, so "add text" stored on T
    // never fired. Treat it as unset and let it take its working default.
    if (definition.id === EDITOR_HOTKEY_IDS.ADD_TEXT_CLIP && typeof raw === 'string'
      && normalizeEditorHotkeyBinding(raw) === 'T') continue
    if (typeof raw === 'string') {
      merged[definition.id] = normalizeEditorHotkeyBinding(raw)
      explicitlyStoredIds.add(definition.id)
    }
  }

  // A newly introduced default must not steal a binding that the user had
  // explicitly assigned before that action existed. Keep the older custom
  // assignment and leave the new action unbound until the user chooses one.
  for (const definition of EDITOR_HOTKEY_DEFINITIONS) {
    if (explicitlyStoredIds.has(definition.id)) continue
    const binding = merged[definition.id]
    if (!binding) continue
    const conflictsWithStoredBinding = EDITOR_HOTKEY_DEFINITIONS.some((candidate) => (
      candidate.id !== definition.id &&
      explicitlyStoredIds.has(candidate.id) &&
      merged[candidate.id] === binding
    ))
    if (conflictsWithStoredBinding) {
      merged[definition.id] = ''
    }
  }

  return merged
}

export function getEditorHotkeyPresetMatch(bindings) {
  const merged = mergeEditorHotkeys(bindings)
  const matchingPreset = EDITOR_HOTKEY_PRESETS.find((preset) =>
    EDITOR_HOTKEY_DEFINITIONS.every((definition) => (
      mergeEditorHotkeys(preset.bindings)[definition.id] === merged[definition.id]
    ))
  )
  return matchingPreset?.id || 'custom'
}

function emitEditorHotkeysChanged(bindings) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(EDITOR_HOTKEYS_CHANGED_EVENT, {
    detail: mergeEditorHotkeys(bindings),
  }))
}

export async function getEditorHotkeys() {
  if (typeof window !== 'undefined' && window.electronAPI?.getSetting) {
    const stored = await window.electronAPI.getSetting('editorHotkeys')
    return mergeEditorHotkeys(stored)
  }

  try {
    const raw = localStorage.getItem(EDITOR_HOTKEYS_STORAGE_KEY)
    return mergeEditorHotkeys(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_EDITOR_HOTKEYS }
  }
}

export async function setEditorHotkeys(bindings) {
  const merged = mergeEditorHotkeys(bindings)

  if (typeof window !== 'undefined' && window.electronAPI?.setSetting) {
    const result = await window.electronAPI.setSetting('editorHotkeys', merged)
    if (result?.success === false) throw new Error(result.error || 'Could not save keyboard shortcuts.')
  } else if (typeof localStorage !== 'undefined') {
    localStorage.setItem(EDITOR_HOTKEYS_STORAGE_KEY, JSON.stringify(merged))
  }

  emitEditorHotkeysChanged(merged)
  return merged
}
