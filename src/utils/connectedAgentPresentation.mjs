// Presentation only. Never replace the original stored reply/provider history,
// interpret workflow JSON, or execute model-provided HTML or commands.
export function presentAgentText(value, { progress = false } = {}) {
  const source = typeof value === 'string' ? value : ''
  const ordinary = { markdown: source, source, adapted: false, json: false }
  if (source.length > 96000 || !/^[\s]*[\[{]/.test(source)) return ordinary
  let parsed
  try { parsed = JSON.parse(source) } catch { return ordinary }
  const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  const keys = object ? Object.keys(parsed) : []
  if (progress && keys.length === 2 && keys.includes('status') && keys.includes('message')
    && typeof parsed.status === 'string' && typeof parsed.message === 'string') {
    return { ...ordinary, markdown: parsed.message, adapted: true }
  }
  // One known legacy conversational envelope, seen before the adapters asked
  // for prose. Unknown fields or nested values stay literal JSON, losslessly.
  const songFields = ['opinion', 'musicPrompt', 'suggestedStructure', 'importantNote']
  if (!progress && keys.length === songFields.length && songFields.every(key => keys.includes(key))
    && ['opinion', 'musicPrompt', 'importantNote'].every(key => typeof parsed[key] === 'string')
    && Array.isArray(parsed.suggestedStructure) && parsed.suggestedStructure.every(item => typeof item === 'string')) {
    const markdown = [parsed.opinion, `### Music prompt\n\n${parsed.musicPrompt}`,
      `### Suggested structure\n\n${parsed.suggestedStructure.map(item => `- ${item.replace(/\n/g, '\n  ')}`).join('\n')}`,
      `### Note\n\n${parsed.importantNote}`].join('\n\n')
    return { ...ordinary, markdown, adapted: true }
  }
  return { ...ordinary, json: true }
}

export const isAgentCommand = name => /^(?:Shell command|run_command|exec_command|commandExecution)$/i.test(name || '')

