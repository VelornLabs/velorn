const shotFields = {
  title: { type: 'string', maxLength: 200, description: 'Short shot title.' },
  description: { type: 'string', maxLength: 8000, description: 'Creative intent for this shot, independent of any model.' },
  durationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 3600, description: 'Planned duration in seconds. Does not trim media.' },
  referenceAssetIds: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 50, uniqueItems: true, description: 'Existing project image, video or audio asset IDs used as references.' },
  storyboardAssetId: { type: ['string', 'null'], maxLength: 160, description: 'Optional explicit storyboard first-frame image: an existing project image asset ID, or null to clear the frame. Set only after the user approves that image. A missing explicit image remains visibly missing rather than falling back to a different reference. Omit to retain legacy image selection.' },
  status: { type: 'string', enum: ['planned', 'in-progress', 'review', 'approved'] },
}
const productionType = { type: 'string', enum: ['music-video', 'ad', 'ugc', 'short-film'] }
const productionFields = {
  targetDurationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 3600 },
  songStartSeconds: { type: 'number', minimum: 0, maximum: 86400 },
  approach: { type: 'string', enum: ['undecided', 'performance', 'story', 'mixed'] },
  concept: { type: 'string', maxLength: 8000 },
  visualStyle: { type: 'string', maxLength: 8000 },
  audience: { type: 'string', maxLength: 8000 },
  mustInclude: { type: 'string', maxLength: 8000 },
  delegation: { type: 'string', enum: ['guided', 'agent-led'], description: 'Preferred planning style only. A stored agent-led preference is not proof that the user delegated this creative scope, generation, spending or timeline edits; confirm the actual scope in conversation.' },
  castMode: { type: 'string', enum: ['undecided', 'needed', 'none'] },
  locationMode: { type: 'string', enum: ['undecided', 'needed', 'none'] },
}
const locationFields = {
  name: { type: 'string', maxLength: 200 },
  description: { type: 'string', maxLength: 4000 },
  referenceAssetIds: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 20, uniqueItems: true,
    description: 'Existing image/video assets used as visual references. Import separately first.' },
}
const memberFields = { ...locationFields, role: { type: 'string', maxLength: 200 } }
const directionFields = {
  castIds: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 20, uniqueItems: true },
  locationId: { type: ['string', 'null'], maxLength: 160 },
  lipSync: { type: 'boolean', description: 'Creative lip-sync requirement; does not select a model or queue work.' },
  notes: { type: 'string', maxLength: 4000 },
}

module.exports = {
  tools: [
    {
      name: 'get_storyboard',
      description: 'Read the shared project Storyboard: ordered shot plans, takes, selected takes, metadata-only asset summaries and a read-only presentation matching the visual board. presentation.shots maps stable human labels such as Shot 01 to exact shotId and stillAssetId; use shotId for edits, never array position or label as an ID. Presentation also groups cast, locations and other references. Raw saved board fields remain compatible and reads never materialize legacy labels. The board is a read-only reference page; discuss changes with an external assistant or the separate Velorn Agent dock. Works without Director or Generate open. Never loads images, decodes media, queues generation or changes the timeline. Unsupported schemas are reported, never reset.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'get_production_guide',
      description: 'Read model-independent project planning guidance and the same presentation mapping as get_storyboard: stages/readiness, at most two next questions, references/details and an assistant handoff. Start here for a new music video or other video. First ask about the user\'s story, casting intent and existing references; do not invent those decisions or generate examples first. Ask for yes/no to each proposed next creative step unless the user explicitly delegated that whole scope in conversation; a stored agent-led preference is not authorization. Save agreed choices through previewed edit_storyboard. The visual board is read-only, not an embedded assistant or animatic player; use existing normal timeline tools for a separately authorized animatic. Stage review never grants generation, spending, imports or timeline permission. Deterministic metadata only: no images, decoders or network requests.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'edit_storyboard',
      description: 'Preview an undoable edit to the shared project plan displayed on the read-only Storyboard. Use get_production_guide, ask about story/cast/references before deciding, and get yes/no to the next creative step unless its whole scope was explicitly delegated in conversation. Save agreed decisions, cast, locations, shot direction and actual human review; plan shots, attach existing takes, select a take or set an approved first-frame image through storyboardAssetId. Resolve stable Shot 01-style labels with get_storyboard.presentation, then target exact shotId. Preview first; apply the returned suggestedApplyPayload unchanged with its one-use previewToken and expectedContext. Stage approval and stored agent-led preference never authorize execution or spending. Never generate first and ask afterward whether it was wanted. These operations do not generate, import or place media. Use separately authorized existing workflow tools, then attach results; create any approved animatic with normal timeline tools. The timeline remains the final edit; legacy Director tools stay separate.',
      inputSchema: { type: 'object', properties: {
        operation: { type: 'string', enum: ['update_board', 'add_shot', 'update_shot', 'remove_shot', 'reorder_shots', 'attach_take', 'select_take', 'remove_take',
          'start_production', 'update_production', 'add_cast_member', 'update_cast_member', 'remove_cast_member',
          'add_location', 'update_location', 'remove_location', 'set_shot_direction', 'review_production_stage'] },
        patch: { type: 'object', properties: {
          ...productionFields, ...memberFields, ...shotFields, ...directionFields,
          referenceAssetIds: { ...shotFields.referenceAssetIds, description: 'Operation-specific existing reference IDs: update_board accepts up to 50 image/video assets for general mood/prop references even before shots exist; update_shot accepts up to 50 image/video/audio assets; cast/location edits accept up to 20 image/video assets. Retained missing references remain inspectable.' },
          brief: { type: 'string', maxLength: 12000, description: 'Project-wide creative brief (update_board only). update_board also accepts concept, visualStyle and approach, before or after starting a guided production.' },
          songAssetId: { type: ['string', 'null'], maxLength: 160, description: 'Existing project audio asset or video asset with audio, or null (update_board only).' },
        }, additionalProperties: false, description: 'Fields are operation-specific: update_board accepts title/brief/songAssetId/referenceAssetIds/concept/visualStyle/approach. Creative direction can be saved before choosing a production type; when production exists those direction fields update it atomically. update_shot accepts title/description/durationSeconds/referenceAssetIds/storyboardAssetId/status; update_production accepts production scalar fields; update_cast_member accepts name/role/description/referenceAssetIds; update_location accepts name/description/referenceAssetIds; set_shot_direction accepts castIds/locationId/lipSync/notes.' },
        productionType,
        targetDurationSeconds: productionFields.targetDurationSeconds,
        songAssetId: { type: ['string', 'null'], maxLength: 160, description: 'Optional update_production-only song assignment, saved atomically with its scalar patch. Existing audio or audio-bearing video asset, or null. update_board instead uses patch.songAssetId.' },
        member: { type: 'object', properties: memberFields, additionalProperties: false, description: 'add_cast_member fields. Velorn assigns a stable ID; at most 20 cast members.' },
        memberId: { type: 'string', maxLength: 160, description: 'Existing cast member ID for update_cast_member/remove_cast_member.' },
        location: { type: 'object', properties: locationFields, additionalProperties: false, description: 'add_location fields. Velorn assigns a stable ID; at most 20 locations.' },
        locationId: { type: 'string', maxLength: 160, description: 'Existing location ID for update_location/remove_location. Use patch.locationId for shot direction.' },
        stage: { type: 'string', enum: ['concept', 'cast-locations', 'animatic', 'generate', 'refine'] },
        decision: { type: 'string', enum: ['approve', 'reopen'], description: 'Record human creative review only. Approval is rejected when the stage is not ready and never grants execution authorization.' },
        note: { type: 'string', maxLength: 4000, description: 'Optional stage-review note.' },
        shot: { type: 'object', properties: shotFields, additionalProperties: false, description: 'New shot fields for add_shot. IDs are assigned by Velorn.' },
        afterShotId: { type: ['string', 'null'], description: 'Optional insertion position for add_shot; omit to append.' },
        shotId: { type: 'string', description: 'Exact existing shot ID for shot/take operations. Resolve human-facing Shot 01-style labels through get_storyboard.presentation.shots; never use a label or array position as the ID.' },
        shotIds: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 200, uniqueItems: true, description: 'Complete shot order for reorder_shots; every current shot ID exactly once.' },
        assetId: { type: 'string', maxLength: 160, description: 'Existing project image/video asset ID for attach_take (up to 30 takes per shot).' },
        label: { type: 'string', maxLength: 200, description: 'Optional take label for attach_take.' },
        prompt: { type: 'string', maxLength: 12000, description: 'Optional human/agent-supplied take prompt notes for attach_take, not verified generation provenance.' },
        workflowLabel: { type: 'string', maxLength: 200, description: 'Optional workflow notes for attach_take, not a model router or verified provenance.' },
        takeId: { type: 'string', maxLength: 160, description: 'Existing take ID for remove_take or select_take.' },
        previewOnly: { type: 'boolean', default: true },
        previewToken: { type: 'string', description: 'Opaque one-use token from a successful preview. Required when previewOnly is false.' },
      }, required: ['operation'], additionalProperties: false },
    },
  ],
  writableTools: ['edit_storyboard'],
}
