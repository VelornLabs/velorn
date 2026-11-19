'use strict'

// Numeric response-shape diagnostics only. Never retain prompts, tool names or
// arguments, public output, provider errors, or private reasoning text here.
// Re-sanitize at the native response boundary instead of trusting error fields.
const MAX_PREDICTIONS = 14
const MAX_CONTENT_CHARS = 2 * 1024 * 1024
const MAX_TOKEN_COUNT = 10_000_000
const MAX_TOOL_CALLS = 1_000_000
const FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null

function sanitizeLocalDiagnostics(value) {
  if (!Array.isArray(value)) return []
  const sanitized = [], seen = new Set()
  // Keep only recent metadata, without making retention an execution limit.
  for (const entry of value.slice(-MAX_PREDICTIONS)) {
    if (!object(entry) || !Number.isSafeInteger(entry.prediction) || entry.prediction < 1
      || seen.has(entry.prediction)) continue
    seen.add(entry.prediction)
    sanitized.push({
      prediction: entry.prediction,
      finishReason: FINISH_REASONS.has(entry.finishReason) ? entry.finishReason : 'unknown',
      publicContentChars: count(entry.publicContentChars, MAX_CONTENT_CHARS),
      parsedToolCalls: count(entry.parsedToolCalls, MAX_TOOL_CALLS),
      promptTokens: count(entry.promptTokens, MAX_TOKEN_COUNT),
      completionTokens: count(entry.completionTokens, MAX_TOKEN_COUNT),
      answerRecovery: entry.answerRecovery === true,
    })
  }
  return sanitized
}

function createLocalPredictionDiagnostic(data, { prediction, answerRecovery = false } = {}) {
  const choice = data?.choices?.[0], message = choice?.message
  return sanitizeLocalDiagnostics([{
    prediction,
    finishReason: choice?.finish_reason,
    publicContentChars: message?.content == null ? 0 : typeof message.content === 'string' ? message.content.length : null,
    parsedToolCalls: message?.tool_calls == null ? 0 : Array.isArray(message.tool_calls) ? message.tool_calls.length : null,
    promptTokens: data?.usage?.prompt_tokens,
    completionTokens: data?.usage?.completion_tokens,
    answerRecovery,
  }])[0] || null
}

module.exports = { MAX_PREDICTIONS, MAX_CONTENT_CHARS, MAX_TOKEN_COUNT, MAX_TOOL_CALLS,
  sanitizeLocalDiagnostics, createLocalPredictionDiagnostic }
