/**
 * Centralized helpers for the Comfy.org partner API key.
 *
 * Historically this key was read and written in several places with slightly
 * different behaviour. This module is the single source of truth so the
 * onboarding modal, settings panel, workflow-setup gallery, and generate
 * workspace all see the same key and the same validation result.
 *
 * Storage strategy (matches prior behaviour so existing users aren't
 * disrupted):
 *   - Primary: electron settings via window.electronAPI.setSetting
 *   - Fallback: localStorage for web preview / dev
 */

const SETTING_KEY = 'comfyApiKeyComfyOrg'
const LOCAL_KEY = 'comfystudio-comfy-api-key'

// Deep link to the Comfy.org dashboard. The exact API-keys page may move,
// so we land on the login page; once signed in, the user can navigate to
// keys in one click. Keeping this centralised makes future updates trivial.
export const COMFY_PARTNER_DASHBOARD_URL = 'https://platform.comfy.org/'

// Deep link to the credits / profile page. Users can view their live balance
// and top up from here. Kept centralised so we only update one place if
// Comfy.org reorganises their dashboard.
export const COMFY_PARTNER_CREDITS_URL = 'https://platform.comfy.org/profile'

// Workflows that depend on the partner API key. Kept in sync with the
// starter pack workflows. We use this list to compose the human-readable
// "unlocks" message shown in the dialog.
export const COMFY_PARTNER_WORKFLOWS = Object.freeze([
  'Grok Imagine (text-to-image & video)',
  'Kling O3 Omni (image-to-video)',
  'Vidu Q2 (image-to-video)',
  'Seedance 2.0 (reference-to-video)',
  'Nano Banana 2 (image edit)',
  'GPT Image 2 (image generation)',
  'Seedream 5 Lite (image edit)',
])

/**
 * Event name dispatched on window whenever the stored key changes.
 * Consumers can listen for it to re-read the key:
 *   window.addEventListener(COMFY_PARTNER_KEY_CHANGED_EVENT, handler)
 */
export const COMFY_PARTNER_KEY_CHANGED_EVENT = 'comfystudio-partner-key-changed'

/**
 * Event dispatched whenever a queue submission fails because the account is
 * out of (or very low on) partner credits. UI chips listen for this and flip
 * into an "out of credits" state so the failure is always recoverable.
 *
 *   window.addEventListener(COMFY_PARTNER_CREDITS_LOW_EVENT, (e) => { ... })
 *
 * The detail payload looks like:
 *   { reason: 'insufficient-credits', status: 402, message: '...' }
 */
export const COMFY_PARTNER_CREDITS_LOW_EVENT = 'comfystudio-partner-credits-low'

export async function getComfyPartnerApiKey({ nativeOnly = false } = {}) {
  try {
    if (typeof window !== 'undefined' && window?.electronAPI?.getSetting) {
      const stored = await window.electronAPI.getSetting(SETTING_KEY)
      const normalized = String(stored || '').trim()
      if (normalized || nativeOnly) return normalized
    }
  } catch (_) {
    if (nativeOnly) throw new Error('Could not read the saved key from Velorn settings.')
    // Ignore and fall back to localStorage.
  }
  if (nativeOnly) return ''
  try {
    if (typeof localStorage !== 'undefined') {
      return String(localStorage.getItem(LOCAL_KEY) || '').trim()
    }
  } catch (_) {
    // Ignore storage access errors.
  }
  return ''
}

export async function saveComfyPartnerApiKey(rawKey) {
  const normalized = String(rawKey || '').trim()
  const native = typeof window !== 'undefined' && typeof window?.electronAPI?.setSetting === 'function'
  if (native) {
    let result
    try { result = await window.electronAPI.setSetting(SETTING_KEY, normalized) }
    catch { throw new Error('Could not save the key in Velorn settings. Nothing was changed in the local fallback.') }
    if (result?.success !== true) throw new Error('Could not save the key in Velorn settings. Nothing was changed in the local fallback.')
  }
  try {
    if (!native && typeof localStorage === 'undefined') throw new Error('Browser storage unavailable')
    if (typeof localStorage !== 'undefined') {
      if (normalized) {
        localStorage.setItem(LOCAL_KEY, normalized)
      } else {
        localStorage.removeItem(LOCAL_KEY)
      }
    }
  } catch {
    if (!native) throw new Error('Could not save the key in this browser.')
  }
  notifyComfyPartnerKeyChanged(Boolean(normalized))
  return { success: true, hasKey: Boolean(normalized) }
}

// A native guided commit already saved the key. Announce only availability;
// never mirror its raw value or perform a second, unguarded settings write.
export function notifyComfyPartnerKeyChanged(hasKey, { clearLegacy = false } = {}) {
  if (!hasKey || clearLegacy) {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(LOCAL_KEY) } catch { /* Native removal remains authoritative. */ }
  }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(COMFY_PARTNER_KEY_CHANGED_EVENT, {
        detail: { hasKey: Boolean(hasKey) },
      }))
    }
  } catch (_) {
    // Ignore dispatch errors.
  }
}

export async function clearComfyPartnerApiKey() {
  return saveComfyPartnerApiKey('')
}

/**
 * Validate a candidate key by pinging Comfy.org's account endpoint.
 *
 * Returns an object with one of these shapes:
 *   { status: 'valid' }                    -> key accepted
 *   { status: 'invalid', message }         -> server rejected with 401/403
 *   { status: 'unknown', message }         -> we could not reach the server,
 *                                             or the response was ambiguous.
 *                                             The caller may still save the key.
 */
export async function validateComfyPartnerApiKey(rawKey, { signal } = {}) {
  const key = String(rawKey || '').trim()
  if (!key) {
    return { status: 'invalid', message: 'Paste a key first.' }
  }

  const endpoints = [
    'https://api.comfy.org/api/user',
    'https://api.comfy.org/v1/account',
  ]

  const failures = []
  for (const url of endpoints) {
    if (signal?.aborted) throw new DOMException('Validation cancelled.', 'AbortError')
    const controller = new AbortController()
    const abort = () => controller.abort()
    const timeout = setTimeout(abort, 8000)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
          'X-API-Key': key,
        },
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
      })
      if (signal?.aborted) throw new DOMException('Validation cancelled.', 'AbortError')

      if (response.ok) {
        return { status: 'valid' }
      }
      if (response.status === 401 || response.status === 403) {
        return {
          status: 'invalid',
          message: 'Comfy.org rejected that key. Double-check you copied the full value.',
        }
      }
      // 404/405/5xx etc. — endpoint doesn't respond for this key shape,
      // but the key might still be valid for queue submission.
      failures.push({ url, status: response.status })
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Validation cancelled.', 'AbortError')
      failures.push({ url, status: null })
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }

  const anyAuthFailure = failures.some((f) => f.status === 401 || f.status === 403)
  if (anyAuthFailure) {
    return { status: 'invalid', message: 'Comfy.org rejected that key.' }
  }
  return {
    status: 'unknown',
    message: "Couldn't verify against Comfy.org from here (offline or endpoint unavailable). You can still save the key — ComfyUI will use it when you queue a prompt.",
  }
}

export async function openComfyPartnerDashboard() {
  return openExternalSafe(COMFY_PARTNER_DASHBOARD_URL)
}

/**
 * Open the Comfy.org credits / profile page in the user's default browser.
 * Used by the Credits chip — click anywhere on it and the user lands on the
 * page that actually shows their live balance, since the number isn't (yet)
 * exposed to third-party apps.
 */
export async function openComfyPartnerCreditsPage() {
  return openExternalSafe(COMFY_PARTNER_CREDITS_URL)
}

// Shared launcher that prefers the Electron main-process bridge (so the OS
// default browser is used) and falls back to window.open for web/dev.
async function openExternalSafe(url) {
  try {
    if (typeof window !== 'undefined' && window?.electronAPI?.openExternalUrl) {
      const result = await window.electronAPI.openExternalUrl(url)
      if (result?.success) return { success: true }
    }
  } catch (_) { /* fall through */ }
  try {
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer')
      return { success: true }
    }
  } catch (_) { /* ignore */ }
  return { success: false }
}

/**
 * Heuristic check: does this error indicate the user's Comfy partner credits
 * are exhausted? We inspect both the HTTP status (if present on the error)
 * and the message text, since different code paths surface this differently.
 *
 * Accepts anything error-like — an Error, a fetch Response, a string, or an
 * object with a `.status` / `.message` / `.error` field.
 */
export function isInsufficientCreditsError(errorLike) {
  if (!errorLike) return false
  // Numeric HTTP status directly.
  const status = Number(errorLike?.status ?? errorLike?.statusCode ?? NaN)
  if (status === 402) return true

  // Pull every string-ish field we might find and check it case-insensitively.
  const candidates = [
    errorLike?.message,
    errorLike?.error?.message,
    errorLike?.error,
    errorLike?.details,
    typeof errorLike === 'string' ? errorLike : '',
  ]
    .filter((v) => typeof v === 'string' && v.length > 0)
    .map((s) => s.toLowerCase())

  if (candidates.length === 0) return false
  return candidates.some((text) =>
    text.includes('insufficientfundserror') ||
    text.includes('insufficient funds') ||
    text.includes('insufficient credits') ||
    text.includes('out of credits') ||
    text.includes('payment required') ||
    (text.includes('credit') && text.includes('balance') && text.includes('low'))
  )
}

/**
 * Dispatch the "credits low" event so any mounted chip can react in one
 * place. Safe to call from any surface (queue submission, workflow runner,
 * background watcher).
 */
export function notifyComfyPartnerCreditsLow(detail = {}) {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(COMFY_PARTNER_CREDITS_LOW_EVENT, {
        detail: {
          reason: 'insufficient-credits',
          at: Date.now(),
          ...detail,
        },
      }))
    }
  } catch (_) { /* non-browser contexts */ }
}
