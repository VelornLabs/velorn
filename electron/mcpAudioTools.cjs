const previewOnly = { type: 'boolean', description: 'Defaults to true. Inspect the plan before explicitly applying with false.' }
const clipId = { type: 'string', description: 'Timeline clip ID.' }
const clipIds = { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } }
const target = { clipId, clipIds }
const envelope = {
  type: 'object', additionalProperties: false,
  properties: {
    version: { type: 'integer', enum: [1] },
    offsetSeconds: { type: 'number', description: 'Preserve the current offset when editing trimmed clips. Clip-local time = point.time - offsetSeconds.' },
    points: { type: 'array', maxItems: 128, items: { type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, time: { type: 'number' }, db: { type: 'number', minimum: -60, maximum: 12 } }, required: ['id', 'time', 'db'] } },
  }, required: ['version', 'offsetSeconds', 'points'],
}
const eq = { type: 'object', additionalProperties: false, properties: {
  version: { type: 'integer', enum: [1] }, enabled: { type: 'boolean' }, lowCut: { type: 'boolean', description: '80 Hz low-cut filter.' },
  bassDb: { type: 'number', minimum: -12, maximum: 12 }, midDb: { type: 'number', minimum: -12, maximum: 12 }, trebleDb: { type: 'number', minimum: -12, maximum: 12 },
} }
const cue = { type: 'object', properties: {
  id: { type: 'string' }, start: { type: 'number', minimum: 0 }, end: { type: 'number' }, text: { type: 'string' },
}, required: ['start', 'end', 'text'] }

const tools = [
  {
    name: 'inspect_clip_audio',
    description: 'Read clip gain/fades, editable volume-envelope points and per-clip EQ. Video IDs resolve only to unique linked audio, never an arbitrary reuse of the same asset. Read-only.',
    inputSchema: { type: 'object', properties: target },
  },
  {
    name: 'set_clip_audio',
    description: 'Preview or change audio gain/fades, manual volume-envelope points, and per-clip EQ using the same validated engines as the Inspector. Supports multiple clips in one undo step. audioEq is a partial update; volumeEnvelope replaces its full value, so inspect first to preserve hidden trim points. gainDb is clamped to -24..24; fades to clip length. Locked/sync-locked targets reject the whole request. Video IDs need unique linked audio.',
    inputSchema: { type: 'object', properties: { ...target,
      gainDb: { type: 'number' }, fadeInSeconds: { type: 'number', minimum: 0 }, fadeOutSeconds: { type: 'number', minimum: 0 },
      volumeEnvelope: envelope, audioEq: eq, resetEnvelope: { type: 'boolean' }, resetEq: { type: 'boolean' }, previewOnly,
    } },
  },
  {
    name: 'audio_ducking',
    description: 'Analyze local dialogue to propose editable music volume points, inspect the asynchronous job/result, then explicitly apply it in one undo step. analyze is preview-only unless previewOnly=false and never edits the timeline. status is read-only. apply/cancel default to preview-only. Results become stale after project/timeline/media edits and cannot be applied twice. Uses the same level-based detector as Music ducking, not speech recognition; EQ/inserts are not analyzed.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['analyze', 'status', 'apply', 'cancel'] },
      musicClipId: clipId, dialogueTrackId: { type: 'string', description: 'A separate audible dialogue audio track.' },
      jobId: { type: 'string', description: 'Required for apply/cancel; optional status filter.' },
      settings: { type: 'object', additionalProperties: false, properties: {
        reductionDb: { type: 'number', minimum: 3, maximum: 24 }, fadeSeconds: { type: 'number', minimum: 0.05, maximum: 1.5 }, thresholdDb: { type: 'number', minimum: -60, maximum: -10 },
      } }, previewOnly,
    } },
  },
  {
    name: 'clip_interpolation',
    description: 'Inspect or choose Frame / Frame Blend / Optical Flow, and build/rebuild or cancel native RIFE interpolation caches. inspect is read-only; set/build/cancel default to preview-only. Build starts local GPU work asynchronously and writes only the project cache; poll inspect with returned jobId. Set optical-flow first, then preview build. Reverse/transparent clips are unsupported. Existing audio timing is unchanged. This is the same native engine as the Inspector, not a ComfyUI workflow.',
    inputSchema: { type: 'object', properties: {
      operation: { type: 'string', enum: ['inspect', 'set', 'build', 'cancel'] }, clipId,
      jobId: { type: 'string', description: 'Use to inspect or cancel a previously started job.' },
      frameSampling: { type: 'string', enum: ['frame', 'blend', 'optical-flow'] }, previewOnly,
    } },
  },
  {
    name: 'list_fonts',
    description: 'Read the same installed-font catalog and curated fallback used by the Velorn font selector. Returns status/source so fallback names are not mistaken for confirmed installed fonts.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional case-insensitive family-name search.' }, forceRefresh: { type: 'boolean' } } },
  },
  {
    name: 'get_caption_status',
    description: 'Read caption jobs, the explicitly separate agent-session draft (including ownership), and live caption clip cues in the current timeline. The agent draft does not overwrite an open Caption workspace draft. Use clipId to inspect a particular live captions clip. Drafts from another timeline cannot be applied here.',
    inputSchema: { type: 'object', properties: {
      jobId: { type: 'string' }, clipId, includeCues: { type: 'boolean', description: 'Include draft and live cue lists; defaults to true.' },
    } },
  },
  {
    name: 'update_caption_cues',
    description: 'Preview or edit an agent-session caption draft or a placed live captions clip. Add cues at explicit media seconds, split at a text caret, change start/duration, edit text, delete IDs, or replace cues. Uses the Caption workspace add/split/retime rules, preserving cue styles. The agent-session draft is separate from an open Caption workspace draft. Default target is an owned agent draft, otherwise a live clip. Explicit empty draft replacement is allowed; generate still requires nonempty cues. Defaults to preview-only.',
    inputSchema: { type: 'object', properties: {
      target: { type: 'string', enum: ['draft', 'clip'] }, clipId,
      cues: { type: 'array', items: cue, description: 'Full replacement list; use [] with target=draft to clear the agent draft.' },
      edits: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string' }, text: { type: 'string' }, startSeconds: { type: 'number', minimum: 0 }, endSeconds: { type: 'number' }, durationSeconds: { type: 'number', minimum: 0.1 },
      }, required: ['id'] } },
      add: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string', description: 'Optional unique ID; generated if omitted.' }, atTimeSeconds: { type: 'number', minimum: 0 }, durationSeconds: { type: 'number', minimum: 0.4 }, text: { type: 'string' },
      }, required: ['atTimeSeconds'] } },
      split: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string', description: 'Existing cue ID.' }, caretOffset: { type: 'integer', minimum: 1 }, rightId: { type: 'string', description: 'Optional ID for the new right cue.' },
      }, required: ['id', 'caretOffset'] } },
      removeIds: { type: 'array', items: { type: 'string' } },
      audioDuration: { type: 'number', exclusiveMinimum: 0, description: 'Known media duration when creating a manual agent draft. Cannot shorten existing known media.' }, previewOnly,
      expectedDraftRevision: { type: 'integer', description: 'Revision returned by get_caption_status or a cue preview. Reject if the agent draft changed since review.' },
    } },
  },
]

module.exports = { tools, writableTools: ['set_clip_audio', 'audio_ducking', 'clip_interpolation', 'update_caption_cues'] }
