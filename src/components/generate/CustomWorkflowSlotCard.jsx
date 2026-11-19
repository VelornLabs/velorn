import { useState } from 'react'
import { ChevronRight, ExternalLink, X } from 'lucide-react'
import CustomWorkflowLibraryPicker from './CustomWorkflowLibraryPicker'

/**
 * Shared "custom workflow" slot card for Director creators (keyframe + video
 * slots). Primary path: pick a saved My Workflows graph — the picker is the
 * card's main content until a workflow is loaded, then the card collapses to
 * a one-line summary. Saving from the ComfyUI tab is the one way in: the
 * older Import JSON and Velorn bridge routes are no longer offered here.
 */
// What is missing, in plain words, with the node name for people who want it.
const NEEDS = {
  VELORN_PROMPT: 'a place for the description',
  VELORN_INPUT_IMAGE: 'a place for the starting picture',
  VELORN_OUTPUT_IMAGE: 'a node that saves the picture',
  VELORN_OUTPUT_VIDEO: 'a node that saves the video',
}
function plainProblem(validation) {
  const missing = (Array.isArray(validation?.missing) ? validation.missing : []).filter((name) => NEEDS[name])
  if (missing.length === 0) return validation?.message || 'This workflow cannot be used yet.'
  return `This workflow still needs ${missing.map((name) => `${NEEDS[name]} (a node named ${name})`).join(', and ')}. Open it in ComfyUI, add what is missing, and save it again.`
}

// The names Velorn looks for, and what each one is. The first column is what
// the person types as the node's title in ComfyUI.
const GUIDE_ROWS = {
  keyframe: [
    ['VELORN_PROMPT', 'A plain text box. Velorn writes the description of the shot into it.', true],
    ['VELORN_OUTPUT_IMAGE', 'The Save Image node. Its picture comes back into the shot.', true],
    ['VELORN_REFERENCE_IMAGE_1', 'A Load Image node. Gets the picture of the person in the shot.', false],
    ['VELORN_REFERENCE_IMAGE_2', 'A Load Image node. Gets a second person, if there is one.', false],
    ['VELORN_PLACE_IMAGE', 'A Load Image node. Gets the picture of the place.', false],
    ['VELORN_SEED', 'A number box. Gets a new number each time, so no two pictures match.', false],
    ['VELORN_WIDTH', 'A number box. Gets the width of the picture.', false],
    ['VELORN_HEIGHT', 'A number box. Gets the height of the picture.', false],
  ],
  video: [
    ['VELORN_INPUT_IMAGE', 'A Load Image node. Gets the keyframe the video starts from.', true],
    ['VELORN_PROMPT', 'A plain text box. Velorn writes the description of the shot into it.', true],
    ['VELORN_OUTPUT_VIDEO', 'The node that saves the video. It comes back into the shot.', true],
    ['VELORN_AUDIO', 'A Load Audio node. Gets the piece of the song for the shot.', false],
    ['VELORN_DURATION', 'A number box. Gets the length of the shot in seconds.', false],
    ['VELORN_FPS', 'A number box. Gets the frames per second.', false],
    ['VELORN_SEED', 'A number box. Gets a new number each time.', false],
    ['VELORN_WIDTH', 'A number box. Gets the width of the video.', false],
    ['VELORN_HEIGHT', 'A number box. Gets the height of the video.', false],
  ],
}

function SetupGuide({ kind, onOpenStarter }) {
  const rows = GUIDE_ROWS[kind === 'video' ? 'video' : 'keyframe']
  return (
    <div className="mt-2 space-y-2 text-xs leading-5 text-sf-text-secondary">
      {typeof onOpenStarter === 'function' && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded border border-sf-dark-700 bg-sf-dark-950/50 px-2.5 py-2">
          <button
            type="button"
            onClick={onOpenStarter}
            className="inline-flex items-center gap-1.5 rounded border border-sf-accent/50 bg-sf-accent/10 px-2.5 py-1.5 text-xs font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20"
          >
            <ExternalLink className="h-3 w-3" />
            Open a starter in ComfyUI
          </button>
          <span className="min-w-0 flex-1 text-sf-text-muted">
            The nodes below, already named, each with a note. Add your model and connect them.
            {' '}It does not change the workflow you are using.
          </span>
        </div>
      )}
      <ol className="list-decimal space-y-0.5 pl-5">
        <li>Build your workflow in the ComfyUI tab, from the starter or from your own.</li>
        <li>Give these nodes a name: right-click a node, choose Title, and type the name exactly.</li>
        <li>Press Save workflow at the top of the ComfyUI tab.</li>
        <li>Come back here and pick it from your saved workflows.</li>
      </ol>
      <div className="overflow-hidden rounded border border-sf-dark-700">
        {rows.map(([name, what, needed]) => (
          <div key={name} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-sf-dark-800 px-2.5 py-1.5 last:border-b-0">
            <code className="select-all font-mono text-sf-text-primary">{name}</code>
            <span className="min-w-0 flex-1 text-sf-text-secondary">{what}</span>
            <span className={needed ? 'font-semibold text-amber-200' : 'text-sf-text-muted'}>{needed ? 'Needed' : 'Optional'}</span>
          </div>
        ))}
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-sf-text-muted">
        <li>The text box must give plain text (a String node), not a CLIP Text Encode node.</li>
        <li>A number box is a Primitive Int node, wired into the setting it controls.</li>
        <li>Without a node named VELORN_SEED, every run uses the same seed.</li>
        <li>Only wire in the width and height if your model takes any size. Velorn sends sizes like 1280 by 720, and some models refuse that (MiniMax H3 needs 704 high).</li>
        {kind !== 'video' && <li>A picture input a shot does not use is left out for that shot.</li>}
        <li>A paid model works too. Velorn asks before it spends.</li>
      </ul>
    </div>
  )
}

export default function CustomWorkflowSlotCard({
  kind = 'keyframe',
  workflowName = '',
  workflowLoaded = false,
  validation,
  canOpenInComfyUi = true,
  onOpenInComfyUi,
  onClear,
  onPickLibrary,
  onOpenStarter,
}) {
  const [changingWorkflow, setChangingWorkflow] = useState(false)
  // Open to begin with while nothing is chosen: that is when someone needs it.
  const [showGuide, setShowGuide] = useState(() => !workflowLoaded)

  const validationOk = Boolean(validation?.ok)
  const warnings = Array.isArray(validation?.warnings) ? validation.warnings : []
  const pickerVisible = !workflowLoaded || changingWorkflow

  return (
    <div className="mt-3 rounded-lg border border-sf-dark-700 bg-sf-dark-900/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-sf-text-primary">My own workflow</span>
          <span className={`rounded-full border px-2 py-0.5 text-xs ${
            workflowLoaded && validationOk
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
          }`}>
            {workflowLoaded ? (validationOk ? 'Ready' : 'Needs a fix') : 'None chosen yet'}
          </span>
          {workflowLoaded && (
            <span className="truncate text-xs text-sf-text-primary">{workflowName || 'Custom workflow'}</span>
          )}
        </div>
        {workflowLoaded && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setChangingWorkflow((current) => !current)}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-xs font-medium text-sf-text-secondary transition-colors hover:border-sf-dark-500 hover:text-sf-text-primary"
              title="Pick a different saved workflow."
            >
              {changingWorkflow ? 'Close' : 'Change'}
            </button>
            <button
              type="button"
              onClick={onOpenInComfyUi}
              disabled={!canOpenInComfyUi}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-accent/50 bg-sf-accent/10 px-2 py-1.5 text-xs font-semibold text-sf-accent transition-colors hover:bg-sf-accent/20 disabled:cursor-not-allowed disabled:border-sf-dark-600 disabled:bg-sf-dark-800 disabled:text-sf-text-muted"
              title="Open the loaded custom workflow in the embedded ComfyUI tab."
            >
              <ExternalLink className="h-3 w-3" />
              Open in ComfyUI
            </button>
            <button
              type="button"
              onClick={() => {
                setChangingWorkflow(false)
                onClear?.()
              }}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 py-1.5 text-xs font-medium text-sf-text-muted transition-colors hover:border-red-500/60 hover:text-red-300"
              title="Clear the loaded custom workflow."
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          </div>
        )}
      </div>

      {workflowLoaded && !validationOk && (
        <div className="mt-2 text-xs leading-5 text-amber-200">{plainProblem(validation)}</div>
      )}
      {kind === 'keyframe' && workflowLoaded && validationOk && (
        <div className="mt-2 text-xs leading-5 text-sf-text-muted">
          {validation?.endpoints?.placeImage
            ? 'Place pictures: this workflow takes them.'
            : 'Place pictures: to use them, add a Load Image node named VELORN_PLACE_IMAGE.'}
        </div>
      )}
      {workflowLoaded && warnings.length > 0 && (
        <div className="mt-1 text-xs text-amber-200">{warnings.slice(0, 2).join(' ')}</div>
      )}

      {pickerVisible && (
        <CustomWorkflowLibraryPicker
          kind={kind}
          dismissible={workflowLoaded}
          currentName={workflowLoaded ? workflowName : ''}
          onPick={async (id) => {
            const result = await onPickLibrary?.(id)
            if (result?.success) setChangingWorkflow(false)
            return result
          }}
          onClose={() => setChangingWorkflow(false)}
        />
      )}

      <div className="mt-3 border-t border-sf-dark-700 pt-2">
        <button
          type="button"
          onClick={() => setShowGuide((current) => !current)}
          className="inline-flex items-center gap-1 text-xs font-medium text-sf-text-secondary transition-colors hover:text-sf-text-primary"
        >
          <ChevronRight className={`h-3 w-3 transition-transform ${showGuide ? 'rotate-90' : ''}`} />
          How to set one up
        </button>
        {showGuide && <SetupGuide kind={kind} onOpenStarter={onOpenStarter} />}
      </div>

    </div>
  )
}
