// Velorn feedback relay — Cloudflare Worker.
//
// Receives feedback POSTs from the app and forwards them to a private Discord
// channel via webhook. The webhook URL lives ONLY here (secret binding), never
// in the app: the app repo is public, so anything shipped in it is public.
//
// Deploy: see README.md next to this file.

const ALLOWED_CATEGORIES = new Set(['bug', 'idea', 'other'])
const MESSAGE_MAX_LENGTH = 4000
const EMAIL_MAX_LENGTH = 200
// Per-IP: max sends per rolling hour. In-memory per isolate — resets when the
// isolate recycles, which is fine: this is a trickle-limiter, not a fortress.
const RATE_LIMIT_PER_HOUR = 5
const RATE_WINDOW_MS = 60 * 60 * 1000

const CATEGORY_COLORS = { bug: 0xef4444, idea: 0x22c55e, other: 0x6366f1 }
const CATEGORY_TITLES = { bug: 'Bug report', idea: 'Idea', other: 'Feedback' }
// Only these diagnostics keys are forwarded — whatever else a client sends is dropped.
const DIAGNOSTIC_KEYS = [
  ['appVersion', 'Version'],
  ['platform', 'Platform'],
  ['os', 'OS'],
  ['gpu', 'GPU'],
  ['comfyConnected', 'ComfyUI'],
  ['screen', 'Screen'],
]

const recentByIp = new Map()

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function isRateLimited(ip) {
  const now = Date.now()
  const stamps = (recentByIp.get(ip) || []).filter((stamp) => now - stamp < RATE_WINDOW_MS)
  if (stamps.length >= RATE_LIMIT_PER_HOUR) {
    recentByIp.set(ip, stamps)
    return true
  }
  stamps.push(now)
  recentByIp.set(ip, stamps)
  // Keep the map from growing unbounded.
  if (recentByIp.size > 10_000) recentByIp.clear()
  return false
}

function formatDiagnosticValue(value) {
  if (value === null || value === undefined || value === '') return 'unknown'
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return String(value).slice(0, 120)
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS })
    }
    if (!env.DISCORD_WEBHOOK_URL) {
      return new Response('Feedback relay is not configured', { status: 503, headers: CORS_HEADERS })
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
    if (isRateLimited(ip)) {
      return new Response('Too many requests', { status: 429, headers: CORS_HEADERS })
    }

    let body = null
    try {
      body = await request.json()
    } catch {
      return new Response('Bad request', { status: 400, headers: CORS_HEADERS })
    }

    // Honeypot: bots fill every field. Pretend success, forward nothing.
    if (typeof body?.website === 'string' && body.website.trim() !== '') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    const message = String(body?.message || '').trim()
    if (!message || message.length > MESSAGE_MAX_LENGTH) {
      return new Response('Bad request', { status: 400, headers: CORS_HEADERS })
    }
    const category = ALLOWED_CATEGORIES.has(body?.category) ? body.category : 'other'
    const email = String(body?.email || '').trim().slice(0, EMAIL_MAX_LENGTH)

    const fields = []
    if (email) fields.push({ name: 'Reply to', value: email, inline: false })
    const diagnostics = body?.diagnostics
    if (diagnostics && typeof diagnostics === 'object') {
      for (const [key, label] of DIAGNOSTIC_KEYS) {
        if (key in diagnostics) {
          fields.push({ name: label, value: formatDiagnosticValue(diagnostics[key]), inline: true })
        }
      }
    }

    const payload = {
      // No @everyone/@here surprises even if someone types them.
      allowed_mentions: { parse: [] },
      embeds: [{
        title: CATEGORY_TITLES[category],
        description: message.slice(0, 3800),
        color: CATEGORY_COLORS[category],
        fields: fields.slice(0, 25),
        timestamp: new Date().toISOString(),
      }],
    }

    const discordResponse = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!discordResponse.ok) {
      return new Response('Relay failed', { status: 502, headers: CORS_HEADERS })
    }
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  },
}
