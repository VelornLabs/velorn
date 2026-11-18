const previewOnly = { type: 'boolean', default: true, description: 'Preview by default. Set false to apply the transport change (not an authored edit/Undo entry).' }
const imageOptions = { includeImage: { type: 'boolean', default: true }, maxWidth: { type: 'integer', minimum: 64, maximum: 1920, default: 960 } }
module.exports = {
  tools: [
    { name: 'get_transport_state', description: 'Read live Velorn playback, rate, loop, In/Out, Play Around and seek-error state.', inputSchema: { type: 'object', properties: {} } },
    { name: 'control_transport', description: 'Preview/apply the same playback controls as the UI: forward/reverse 1/8x–8x, pause, frame step, looping and Play Around. Does not alter clip speed or document history.', inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['play', 'pause', 'stop', 'step', 'rate', 'loop', 'play_around', 'cancel_play_around'] },
      rate: { type: 'number', enum: [-8, -4, -2, -1, -0.5, -0.25, -0.125, 0.125, 0.25, 0.5, 1, 2, 4, 8] },
      frames: { type: 'integer', minimum: -10000, maximum: 10000, description: 'Signed frame count for step; not zero.' },
      mode: { type: 'string', enum: ['normal', 'loop', 'loop-in-out', 'loop-selection', 'ping-pong'] },
      centerSeconds: { type: 'number', minimum: 0, description: 'Play Around center. Defaults to current playhead when previewing.' }, previewOnly,
    }, required: ['operation'] } },
    { name: 'inspect_source_frame', description: 'Inspect an exact retained source frame at a clip edge or timeline time without moving the playhead. Uses the same source/reverse/ramp/RIFE mapping as the trim viewer. No effects/composite; decoder failures are explicit.', inputSchema: { type: 'object', properties: {
      clipId: { type: 'string' }, edge: { type: 'string', enum: ['left', 'right'] }, timelineSeconds: { type: 'number', minimum: 0 }, ...imageOptions,
    }, required: ['clipId'] } },
    { name: 'inspect_edit_point', description: 'Compare the actual last outgoing and first incoming retained source frames at a cut, matching the two-up trim viewer. Does not seek, pause or edit the live timeline.', inputSchema: { type: 'object', properties: {
      outgoingClipId: { type: 'string' }, incomingClipId: { type: 'string' }, ...imageOptions,
    }, required: ['outgoingClipId', 'incomingClipId'] } },
  ],
  writableTools: ['control_transport'],
}
