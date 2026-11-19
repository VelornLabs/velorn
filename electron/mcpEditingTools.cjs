// Public editing schemas live beside the renderer handlers. Existing names
// replace legacy implementations; new tools use the same preview/apply bridge.
const str = description => ({ type: 'string', ...(description ? { description } : {}) })
const num = description => ({ type: 'number', ...(description ? { description } : {}) })
const bool = description => ({ type: 'boolean', ...(description ? { description } : {}) })
const ids = description => ({ type: 'array', items: str(), uniqueItems: true, minItems: 1, ...(description ? { description } : {}) })
const obj = description => ({ type: 'object', ...(description ? { description } : {}) })
const choice = values => ({ type: 'string', enum: values })
const controls = { previewOnly: { type: 'boolean', default: true, description: 'Preview only by default. Apply the returned suggestedApplyPayload after approval.' },
  previewToken: str('Opaque ten-minute one-use preview token. Apply exactly the reviewed arguments.'), expectedContext: obj('Context returned by preview; rejects a changed project or timeline.') }
const targets = { clipId: str(), clipIds: ids(), filter: choice(['selected', 'disabled', 'enabled', 'visual', 'audio', 'labeled', 'colored']),
  selected: bool(), trackId: str(), type: str(), nameIncludes: str(), limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 } }
const asset = { assetId: str(), assetName: str(), replacementAssetId: str(), replacementAssetName: str(), latestGenerated: bool(), latestReplacement: bool(), latest: bool(),
  type: choice(['video', 'image', 'audio']), workflowId: str() }
const transform = { transform: obj('Sparse native transform fields, including position, scale, rotation, crop, perspective, corner pin and motion blur.'),
  transformDelta: obj('Numeric offsets to shared transform fields; protects animated properties.'),
  ...Object.fromEntries(['positionX', 'positionY', 'positionZ', 'scaleX', 'scaleY', 'rotation', 'rotationX', 'rotationY', 'perspective',
    'anchorX', 'anchorY', 'opacity', 'blur', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight', 'motionBlurSamples', 'motionBlurShutter'].map(key => [key, num()])),
  ...Object.fromEntries(['scaleLinked', 'flipH', 'flipV', 'motionBlurEnabled', 'cornerPinEnabled'].map(key => [key, bool()])),
  blendMode: str(), motionBlurMode: choice(['auto', 'velocity', 'sampled']), motionPathMode: choice(['linear', 'smooth']) }
const grade = { adjustments: obj('Sparse color values: brightness/contrast/exposure/saturation/temperature/tint/hue plus shadows, midtones, highlights nested groups. Same native Inspector ranges.'),
  color: obj('Alias for adjustments.'), updates: obj('Native Inspector field map, e.g. {"color.contrast":10,"color.shadows.saturation":-5,"effects.blur":2}.') }
const transition = { transitionId: str(), clipAId: str(), clipBId: str(), clipId: str(), edge: choice(['in', 'out']),
  transitionType: choice(['dissolve', 'fade-black', 'fade-white', 'dip-color', 'flash', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down',
    'slide-left', 'slide-right', 'slide-up', 'slide-down', 'whip-left', 'whip-right', 'zoom-in', 'zoom-out', 'cross-zoom', 'blur']),
  durationSeconds: num('Requested duration. Preview reports the actual safe duration limited by source handles.'), alignment: choice(['start', 'center', 'end']), settings: obj('Native transition settings.') }
const trim = {
  clipId: str(),
  startSeconds: num('Controls the clip start position on the timeline, in seconds.'),
  durationSeconds: num('Controls the clip duration on the timeline, in seconds. Set this field to shorten or lengthen the timeline clip.'),
  trimStartSeconds: num('Source-in (In point), in seconds: where playback begins within the source media.'),
  trimEndSeconds: num('Source-out (Out point), in seconds: where playback ends within the source media. This field alone does not shorten the clip on the timeline; set durationSeconds to change timeline duration.'),
}
const tools = []
function tool(name, description, properties, required = [], readOnly = false) {
  tools.push({ name, description, inputSchema: { type: 'object', properties: { ...properties, ...(readOnly ? {} : controls) }, ...(required.length ? { required } : {}) },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false } })
}
tool('set_clip_style', 'Preview or atomically edit clip transforms, opacity, blend, color, labels, enabled state, mattes and bypass. Uses native guarded plans, protects locks/animation/compound boundaries, and commits one undo step.', {
  ...targets, ...transform, ...grade, enabled: bool(), labelColor: str('#RRGGBB; empty clears.'), trackMatte: choice(['none', 'alpha', 'alpha-inverted', 'luma', 'luma-inverted']),
  bypass: { type: 'object', properties: { mask: bool(), color: bool(), effects: bool() }, additionalProperties: false },
})
tool('set_clip_color', 'Preview or atomically set shared static color values on explicit clips. Preserves unrelated grade values and rejects animated fields.', { ...targets, ...grade })
tool('inspect_clip_effects', 'Read complete effects and shared native effect groups for explicit clip IDs, plus supported type definitions and parameter ranges.', targets, [], true)
tool('edit_clip_effects', 'Preview or atomically add/update/remove/enable/reset one shared native effect across one or more clips. Inspect exact types/ordinals first; animated parameters are protected.', {
  ...targets, action: choice(['add', 'update', 'remove', 'enabled', 'reset']), effectType: str(), effectId: str(), ordinal: { type: 'integer', minimum: 0 },
  group: obj('Exact shared group returned by inspect_clip_effects.'), settings: obj('Sparse parameter values in native units.'), enabled: bool(),
}, ['action'])
tool('paste_clip_attributes', 'Preview or atomically copy chosen static attribute groups from one source clip onto explicit destination clips. Uses native Paste Attributes semantics; no keyframes, audio EQ or envelopes are copied.', {
  sourceClipId: str(), sourceId: str('Alias for sourceClipId.'), destinationClipIds: ids(), clipIds: ids('Alias for destinationClipIds.'),
  groups: { type: 'array', minItems: 1, uniqueItems: true, items: choice(['transform', 'color', 'effects', 'audio']) },
}, ['groups'])
tool('edit_source', 'Preview or apply native Insert, Overwrite or Add to End from a video/audio project source, with explicit source In/Out and destination tracks. Picture, linked audio, affected edits and undo commit atomically. Images remain available through add_asset_to_timeline.', {
  ...asset, mode: choice(['insert', 'overwrite', 'append']), sourceInSeconds: num(), sourceOutSeconds: num(),
  trackId: str('Unlocked video/audio destination; defaults to the native active compatible track.'), audioTrackId: str('Optional explicit linked audio destination.'),
  startSeconds: num('Destination time; defaults to playhead. Append uses the destination track ends.'), includeAudio: bool('False omits embedded source audio.'), includeEmbeddedAudio: bool(),
}, ['mode'])
tool('replace_clip_with_asset', 'Preview or apply native Smart Replace to one video/image/audio clip, preserving its edit and validating replacement media, source handles, locks, caches and transitions. Custom sourceInSeconds supported. Legacy resetTrim/preserveTrim retained; fitting duration is rejected in favor of explicit trim.', {
  ...asset, clipId: str(), sourceInSeconds: num('Custom source In in seconds.'), preserveDuration: bool('Must not be false: native Smart Replace preserves the edit.'),
  resetTrim: bool('Legacy default true starts the replacement at zero.'), preserveTrim: bool('True keeps the current source In unless sourceInSeconds is explicit.'),
  fitToAssetDuration: bool('Deprecated; true is rejected. Trim explicitly.'), durationSeconds: num('Deprecated; trim explicitly before replacement.'),
})
tool('trim_clips', 'Preview or atomically apply absolute clip timing/source trims in one undo step. Validates all targets first; rejects locks, source-bound overflow, unsafe transitions, overlaps, partial linked groups and speed ramps. Use edit_trim for roll/slip/slide/ripple.', {
  ...trim, clips: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: trim, required: ['clipId'] } },
})
tool('edit_trim', 'Preview or apply a native normal batch trim, roll, slip, slide or ripple edge trim by delta seconds. Uses native safe bounds and one atomic undo step. Supply inspected clip IDs directly; selecting a clip first is not required. Roll/slip/slide/ripple retain native constant-speed/reverse handling; normal batch edge trim rejects reverse media. Preview reports the accepted delta.', {
  mode: choice(['normal', 'roll', 'slip', 'slide', 'ripple']),
  clipId: str('Exact inspected primary clip ID for normal, slip, slide or ripple. Supplying it requires no prior selection. If omitted, exactly one clip must already be selected; empty or multiple selections are invalid.'),
  clipAId: str('Exact inspected outgoing clip ID required for roll; supply together with clipBId, not selection.'),
  clipBId: str('Exact inspected incoming clip ID required for roll; supply together with clipAId, not selection.'),
  edge: { ...choice(['start', 'end', 'left', 'right']), description: 'Required for normal and ripple: start or end (left/right aliases). Specify the edge explicitly.' },
  deltaSeconds: num(),
  targetClipIds: ids('Optional explicit normal/ripple batch targets. Must include the primary clip resolved from clipId or exactly one selected clip. This list does not replace the primary clip requirement.'),
  clipIds: ids('Alias for targetClipIds for normal/ripple. Must include the primary clip resolved from clipId or exactly one selected clip; this list does not replace that requirement.'),
}, ['mode', 'deltaSeconds'])
tool('inspect_compound', 'Read a compound parent and complete child document without opening it. If the compound is open, returns its live edited children.', { clipId: str() }, [], true)
tool('create_compound', 'Preview or create one native editable compound from explicit clips or the current selection. Checks complete linked groups, supported layers, locks and transitions; one undo step.', { clipIds: ids(), name: str() })
tool('open_compound', 'Preview or open one compound child timeline through native navigation. Does not bake or flatten media.', { clipId: str() })
tool('close_compound', 'Preview or return to the parent timeline, validating the live child document and consolidating its edits into native parent undo.', {})
tool('rename_compound', 'Preview or rename an unlocked top-level compound; no-op names do not create history.', { clipId: str(), name: str() }, ['name'])
tool('uncompound', 'Preview or restore the current visible contents of one compound to the parent timeline using native collision/lock validation and atomic undo.', { clipId: str() })
tool('add_transition', 'Preview or add a native edge/between transition. Preflight uses native handle limits and reports the actual duration. Settings and creation commit in one undo step.', transition)
tool('update_transition', 'Preview or update a native transition with handle/lock validation and atomic undo, including settings-only edits.', transition, ['transitionId'])
tool('remove_transitions', 'Preview or atomically remove distinct native transitions in one undo step after validating all target clip locks.', { transitionId: str(), transitionIds: ids() })

module.exports = { tools, writableTools: tools.filter(tool => !tool.annotations.readOnlyHint).map(tool => tool.name) }
