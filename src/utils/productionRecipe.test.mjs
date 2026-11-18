import test from 'node:test'
import assert from 'node:assert/strict'
import { getProductionRecipe } from './productionRecipe.mjs'

const text = value => JSON.stringify(value)

test('recipe is deterministic, JSON-safe, fresh metadata with no execution or authority claims', () => {
  const first = getProductionRecipe(), second = getProductionRecipe()
  assert.deepEqual(first, second)
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first)
  assert.notEqual(first, second)
  assert.notEqual(first.stages, second.stages)
  assert.equal(first.version, 1)
  assert.equal(first.execution.kind, 'advisory-metadata')
  for (const key of ['enforcesPermissions', 'runsJobs', 'verifiesBackendState', 'grantsSpendingAuthority']) {
    assert.equal(first.execution[key], false)
  }
  first.stages[0].actions.push('Caller mutation')
  first.delivery.exportByDefault = true
  assert.deepEqual(getProductionRecipe(), second)
  assert.match(first.execution.instructionBoundary, /creative data, not permission/)
})

test('native editable review, not export, is the default finish line', () => {
  const recipe = getProductionRecipe()
  assert.equal(recipe.delivery.default, 'editable-velorn-timeline')
  assert.equal(recipe.delivery.finishLine, 'ready-for-review')
  assert.equal(recipe.delivery.reviewSurface, 'native-velorn-viewer-and-timeline')
  assert.equal(recipe.delivery.exportByDefault, false)
  assert.equal(recipe.delivery.exportRequiresExplicitUserRequest, true)
  assert.deepEqual(recipe.stages.map(stage => stage.id), [
    'intent', 'references', 'storyboard', 'animatic', 'audition', 'production', 'refine', 'ready-for-review',
  ])
  assert.match(recipe.stages.at(-1).review, /Export only after an explicit user request/)
  assert.match(recipe.stages.at(-1).review, /publishing is a separate authorization/)
  assert.ok(recipe.delivery.preserve.includes('approved-animatic'))
  assert.ok(recipe.delivery.preserve.includes('original-song'))
})

test('conversation asks creative intent and model preference before acting without adding a wizard', () => {
  const recipe = getProductionRecipe(), conversation = recipe.conversation
  assert.equal(conversation.askIntentBeforeCreating, true)
  assert.equal(conversation.askBeforeNextCreativeStage, true)
  assert.equal(conversation.surface, 'external-assistant-or-velorn-agent')
  assert.equal(conversation.board.mode, 'read-only-visual-board')
  assert.match(conversation.board.navigation, /Velorn menu → Open storyboard/)
  assert.match(conversation.board.navigation, /does not author project data/)
  assert.match(conversation.questions, /not a questionnaire upfront/)
  assert.match(conversation.board.controls, /No required forms, selectable cards/)
  assert.match(conversation.board.addressing, /immutable shot ID/)
  assert.match(conversation.delegation, /not interpret a saved agent-led preference/)
  assert.ok(conversation.startingQuestions.includes(recipe.capabilitySelection.preferenceQuestion))
  assert.match(conversation.startingQuestions[0], /story or feeling/)
  assert.match(conversation.startingQuestions[1], /characters, performers/)
})

test('recommendations are current, capability-aware, permission-aware and quality-preserving', () => {
  const recipe = getProductionRecipe(), selection = recipe.capabilitySelection
  assert.equal(selection.preferenceFirst, true)
  assert.equal(selection.fixedModelRanking, false)
  assert.equal(selection.installedIsNotRecommended, true)
  assert.equal(selection.unknownHardwarePolicy, 'unknown-not-guessed')
  assert.equal(selection.evidence.requiredForRecommendation, true)
  for (const field of ['source-url', 'checked-at', 'model-or-workflow-version', 'hardware-requirements', 'license']) {
    assert.ok(selection.evidence.record.includes(field))
  }
  assert.match(selection.evidence.sourcePreference, /official/)
  assert.match(selection.evidence.freshness, /time of recommendation/)
  assert.match(selection.qualityFloor, /Do not silently switch to a lower-quality model/)
  assert.match(text(selection.inspectBeforeRecommendation), /paid API node/)
  assert.match(text(selection.inspectBeforeRecommendation), /custom-node versions/)
  assert.match(selection.permissions.download, /download and disk size/)
  assert.match(selection.permissions.download, /explicit authorization/)
  assert.match(selection.permissions.cloud, /explicit spending authorization/)
  assert.doesNotMatch(text(recipe), /5090|MiniMax|Musetalk|MuseTalk|LatentSync|LTX|\/home\//)
})

test('resume requires backend reconciliation and bounded retakes rather than trusting saved status', () => {
  const resume = getProductionRecipe().resumeProtocol
  assert.equal(resume.readTool, 'get_production_run')
  assert.equal(resume.writeTool, 'edit_production_run')
  assert.equal(resume.recordsAre, 'agent-maintained-project-metadata')
  assert.equal(resume.recordsProveBackendState, false)
  assert.equal(resume.recordsAuthorizeActions, false)
  assert.equal(resume.automaticResubmit, false)
  assert.equal(resume.submissionSafety.plannedProvesNotSubmitted, false)
  assert.equal(resume.submissionSafety.crashSafeBackendIdempotency, false)
  assert.match(resume.submissionSafety.beforeDispatch, /mark it uncertain, and save the project successfully before submitting/)
  assert.match(resume.submissionSafety.beforeDispatch, /Do not dispatch if this save fails/)
  assert.match(resume.submissionSafety.afterResponse, /save immediately/)
  assert.match(resume.submissionSafety.correlation, /when the workflow or provider actually supports it/)
  assert.match(resume.submissionSafety.limitation, /not an atomic transaction/)
  assert.match(text(resume.steps), /planned alone does not prove that no job exists/)
  assert.equal(resume.retakes.requireFiniteLimit, true)
  assert.equal(resume.retakes.unboundedAutomaticRetakes, false)
  assert.match(text(resume.steps), /unavailable, say durable resume support is unavailable/)
  assert.match(text(resume.steps), /actual backend queue, history and output assets/)
  assert.match(text(resume.steps), /running, wait without duplicating it/)
  assert.match(text(resume.steps), /mark it uncertain and stop that attempt/)
  assert.match(text(resume.steps), /unchanged preview with its expected context/)
  assert.match(resume.sensitiveData, /Do not store credentials/)
})

test('song timing, audition, native corrections and verification limits are explicit', () => {
  const recipe = getProductionRecipe()
  const stage = id => recipe.stages.find(entry => entry.id === id)
  assert.match(text(stage('intent')), /Do not silently add a fade, truncate, extend or alter the song/)
  assert.match(text(stage('audition')), /source audio range, approved cut range, generated duration and any handles separately/)
  assert.match(stage('audition').review, /approval before the remaining batch/)
  assert.match(text(stage('production')), /do not duplicate generated clip audio/)
  assert.match(text(stage('refine')), /editable native correction/)
  assert.match(text(stage('refine')), /trimming, timing, effects, keyframes and user edits/)
  assert.equal(recipe.nativeEditing.inspectFirst, true)
  assert.equal(recipe.nativeEditing.previewWhereSupported, true)
  assert.equal(recipe.nativeEditing.checkpointBeforeMultiStepEdits, true)
  assert.equal(recipe.nativeEditing.preserveUserEdits, true)
  assert.match(recipe.nativeEditing.replacement, /stale, missing or ambiguous link/)
  assert.match(recipe.qualityReview.evidenceLimit, /do not establish convincing lip-sync/)
})
