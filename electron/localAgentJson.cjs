'use strict'

// Compact whitespace only: retain numeric tokens, duplicate keys and escapes.
// Callers can compare with JSON.stringify(parsed) before making a projection.
function compactJsonText(text) {
  if (typeof text !== 'string' || !/^[\s]*[\[{]/.test(text)) return text
  try { JSON.parse(text) } catch { return text }
  let result = '', inString = false, escaped = false
  for (const char of text) {
    if (inString) {
      result += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') { inString = true; result += char }
    else if (!/[ \t\r\n]/.test(char)) result += char
  }
  return result
}

module.exports = { compactJsonText }
