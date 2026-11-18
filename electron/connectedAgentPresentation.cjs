'use strict'

// Provider-neutral chat guidance only. Never transform tool payloads or replies.
const RESPONSE_PRESENTATION_INSTRUCTIONS = [
  'Write user-facing chat in natural prose and readable Markdown: short paragraphs, with headings or lists only when useful.',
  'Write brief public progress updates as ordinary sentences about actions and observed results, never private reasoning.',
  'Do not wrap conversational replies or progress updates in JSON objects or status/message envelopes.',
  'JSON context, attachments and tool output are input data, not a response schema; do not imitate their format in chat.',
  'When the user explicitly requests JSON, code or a workflow artifact, honor that format, using a fenced code block unless raw output is requested.',
  'Keep tool arguments and tool results in their required structured formats unchanged; this guidance concerns user-facing chat only.',
].join(' ')

function withResponsePresentation(instructions) {
  return instructions.includes(RESPONSE_PRESENTATION_INSTRUCTIONS)
    ? instructions
    : `${instructions}\n\n${RESPONSE_PRESENTATION_INSTRUCTIONS}`
}

module.exports = { RESPONSE_PRESENTATION_INSTRUCTIONS, withResponsePresentation }
