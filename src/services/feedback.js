// In-app feedback: a small form in Settings posts to a Cloudflare Worker we
// control, which forwards to a private Discord channel (see
// infra/feedback-worker). The endpoint URL is public by nature — this repo is
// open source — so all abuse control (rate limits, length caps, honeypot)
// lives in the worker; the client is never trusted.
import packageJson from '../../package.json'
import { checkLocalComfyConnection } from './localComfyConnection'

// Update after deploying infra/feedback-worker (see its README).
const DEFAULT_FEEDBACK_ENDPOINT = 'https://velorn-feedback.jaime-10b.workers.dev'
// localStorage override for testing a worker before pointing DNS at it.
const FEEDBACK_ENDPOINT_OVERRIDE_KEY = 'velorn-feedback-endpoint'

export const FEEDBACK_CATEGORIES = [
  { id: 'bug', label: 'Bug' },
  { id: 'idea', label: 'Idea' },
  { id: 'other', label: 'Other' },
]

export const FEEDBACK_MESSAGE_MAX_LENGTH = 4000

export function getFeedbackEndpoint() {
  try {
    const override = window.localStorage?.getItem(FEEDBACK_ENDPOINT_OVERRIDE_KEY)
    if (override && /^https?:\/\//i.test(override)) return override
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return DEFAULT_FEEDBACK_ENDPOINT
}

function getGpuName() {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) return ''
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : ''
  } catch {
    return ''
  }
}

// Everything here is shown to the user before sending — no hidden fields.
export async function collectFeedbackDiagnostics() {
  let comfyConnected = null
  try {
    const check = await checkLocalComfyConnection({ timeoutMs: 2500 })
    comfyConnected = Boolean(check?.ok)
  } catch {
    comfyConnected = null
  }
  const osMatch = typeof navigator !== 'undefined' ? navigator.userAgent.match(/\(([^)]+)\)/) : null
  return {
    appVersion: String(packageJson.version || ''),
    platform: (typeof window !== 'undefined' && window.electronAPI?.platform) || '',
    os: osMatch ? osMatch[1] : '',
    gpu: getGpuName(),
    comfyConnected,
    screen: typeof window !== 'undefined' && window.screen
      ? `${window.screen.width}x${window.screen.height}`
      : '',
  }
}

export async function sendFeedback({ category, message, email, diagnostics }) {
  const trimmed = String(message || '').trim()
  if (!trimmed) throw new Error('Write a little something first.')
  if (trimmed.length > FEEDBACK_MESSAGE_MAX_LENGTH) {
    throw new Error(`Please keep it under ${FEEDBACK_MESSAGE_MAX_LENGTH} characters.`)
  }

  const body = {
    category: FEEDBACK_CATEGORIES.some((entry) => entry.id === category) ? category : 'other',
    message: trimmed,
    email: String(email || '').trim().slice(0, 200),
    diagnostics: diagnostics && typeof diagnostics === 'object' ? diagnostics : null,
    // Honeypot — real users never see or fill this field.
    website: '',
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(getFeedbackEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(response.status === 429
        ? 'Slow down a little — try again in a few minutes.'
        : 'Could not reach the feedback service right now. Try again later.')
    }
    return { success: true }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('The feedback service took too long to answer — try again later.')
    }
    if (error instanceof TypeError) {
      throw new Error('Could not reach the feedback service. Check your internet connection and try again.')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
