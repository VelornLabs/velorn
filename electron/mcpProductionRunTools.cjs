const id = { type: 'string', minLength: 1, maxLength: 160 }
const note = { type: 'string', maxLength: 4000 }
const seconds = { type: 'number', minimum: 0, maximum: 86400 }
const duration = { type: 'number', exclusiveMinimum: 0, maximum: 3600 }
const assetIds = { type: 'array', items: id, maxItems: 50, uniqueItems: true }
const state = { type: 'string', enum: ['planned', 'submitted', 'running', 'completed', 'failed', 'uncertain', 'cancelled'] }
const remoteJobId = id
const recipe = { type: 'object', additionalProperties: false, required: ['model', 'workflow'], properties: {
  model: { type: 'string', maxLength: 200 }, workflow: { type: 'string', maxLength: 200 },
  prompt: { type: 'string', maxLength: 12000 }, negativePrompt: { type: 'string', maxLength: 12000 },
  seed: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  width: { type: 'integer', minimum: 8, maximum: 16384 }, height: { type: 'integer', minimum: 8, maximum: 16384 },
  fps: { type: 'number', minimum: 1, maximum: 240 }, generationDurationSeconds: duration,
  referenceAssetIds: assetIds, inputAssetIds: assetIds,
  songAssetId: { ...id, type: ['string', 'null'] }, audioStartSeconds: seconds, audioDurationSeconds: duration,
}, description: 'Immutable descriptive recipe for this attempt, not an executable graph or verified provenance. Use project asset IDs, not workstation paths, credentials or downloads. Generation duration includes handles and is separate from edit length. Inspect the actual backend/workflow before execution.' }

module.exports = {
  writableTools: ['edit_production_run'],
  tools: [{ name: 'get_production_run',
    description: 'Read the project-owned production record, reported job attempts and exact shot-to-timeline links. Overlays the active live timeline; never switches, saves, decodes, runs jobs or exports. Reports missing, ambiguous and manually changed bindings instead of guessing. Job states are agent-reported metadata, NOT verified backend status or permission. Resolve stable shot labels through presentation. Inspect the generation backend before retrying uncertain work. The normal deliverable is an editable timeline ready for review in Velorn; export only on explicit request.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }, { name: 'edit_production_run',
    description: 'Preview and persist an undoable production record only. Records decisions/next action, immutable per-shot attempt recipes, reported job progress, and exact timelineId+clipId bindings. Never generates, retries, imports, replaces clips, purchases, exports or grants authorization. Use a new unique attemptId for an explicitly approved retake; reconcile uncertain submissions before retrying. bind_shot reads the actual clip and stores its baseline; rebind:true explicitly acknowledges the current edit or new target after review. Does not synchronize the board and timeline. Preview first and apply the unchanged suggestedApplyPayload with its one-use previewToken and expectedContext. Save the project for durable recovery. Undo changes records only, never cancels a backend job. Existing timeline tools handle separately approved media placement and retakes, preserving manual edits. Do not call export just to review an edit.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
      operation: { type: 'string', enum: ['update_run', 'record_attempt', 'update_attempt', 'bind_shot', 'unbind_shot'] },
      shotId: id, attemptId: { ...id, description: 'Caller-created unique attempt ID. Replaying an identical record is a no-op, never a new generation. A retry requires its own ID.' },
      recipe, state, remoteJobId, outputAssetId: id, note,
      slot: { type: 'string', enum: ['animatic', 'final'] }, timelineId: id, clipId: id,
      rebind: { type: 'boolean', description: 'Only true after reviewing why an existing binding changed. Does not modify the clip.' },
      patch: { type: 'object', additionalProperties: false, properties: {
        notes: note, nextAction: note, state, remoteJobId, outputAssetId: id, note,
      }, description: 'update_run accepts notes/nextAction. update_attempt accepts state/remoteJobId/outputAssetId/note. Fields from another operation are rejected.' },
      previewOnly: { type: 'boolean', default: true },
      previewToken: { type: 'string', description: 'One-use preview token; required for apply.' },
    } },
  }],
}
