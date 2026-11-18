'use strict'

// Test-only decoder for the host-authored header and exact length-labeled
// readable sections. Never use this to infer an action outcome in production.
function decodeReadable(body) {
  if (body.startsWith('Original MCP JSON (')) return JSON.parse(body.slice(body.indexOf('\n') + 1))
  const prefix = 'MCP envelope fields (JSON):\n'
  if (!body.startsWith(prefix)) throw Error('Unexpected readable MCP format')
  let remaining = body.slice(prefix.length)
  const end = remaining.indexOf('\n\n')
  const result = JSON.parse(end < 0 ? remaining : remaining.slice(0, end))
  remaining = end < 0 ? '' : remaining.slice(end + 2)
  result.content = []
  while (remaining) {
    const line = remaining.indexOf('\n'), heading = remaining.slice(0, line)
    remaining = remaining.slice(line + 1)
    if (/^Content block \d+ \(JSON\):$/.test(heading)) {
      const next = remaining.indexOf('\n\n')
      result.content.push(JSON.parse(next < 0 ? remaining : remaining.slice(0, next)))
      remaining = next < 0 ? '' : remaining.slice(next + 2)
      continue
    }
    if (!/^Content block \d+ fields \(JSON\):$/.test(heading)) throw Error('Unexpected readable content header')
    const fieldEnd = remaining.indexOf('\n'), fields = JSON.parse(remaining.slice(0, fieldEnd))
    remaining = remaining.slice(fieldEnd + 1)
    const textEnd = remaining.indexOf('\n'), match = /^Text \((\d+) UTF-16 code units.*\):$/.exec(remaining.slice(0, textEnd))
    if (!match) throw Error('Missing readable text length')
    remaining = remaining.slice(textEnd + 1)
    const length = Number(match[1]), text = remaining.slice(0, length)
    if (text.length !== length) throw Error('Incomplete readable text')
    result.content.push({ ...fields, text })
    remaining = remaining.slice(length)
    if (remaining.startsWith('\n\n')) remaining = remaining.slice(2)
  }
  return result
}

function parseModelTransport(value) {
  const first = value.indexOf('\n\n')
  const header = JSON.parse(first < 0 ? value : value.slice(0, first))
  if (first < 0) return header
  const body = value.slice(first + 2)
  if (header.bodyChars !== body.length) throw Error('Readable body length mismatch')
  return { ...header, body, raw: body,
    ...(header.kind === 'local-tool-result-complete' ? { result: decodeReadable(body) } : {}) }
}

// Test-only extraction of the current-user snapshot wrapper. Provider code does
// not parse these delimiters as authority or executable data.
function unpackLocalUserMessage(message) {
  const text = Array.isArray(message.content) ? message.content[0].text : message.content
  const start = '[BEGIN VELORN SNAPSHOT]\n', end = '\n[END VELORN SNAPSHOT]\n\nCurrent user message:\n'
  const from = text.indexOf(start), to = text.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw Error('Missing current-user snapshot wrapper')
  return { snapshot: text.slice(from + start.length, to), content: text.slice(to + end.length) }
}

module.exports = { parseModelTransport, decodeReadable, unpackLocalUserMessage }
