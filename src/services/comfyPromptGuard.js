/**
 * Shared registry of ComfyUI prompt IDs that Velorn has already
 * claimed responsibility for.
 *
 * The GenerateWorkspace owns the "managed workflow" path: it queues a
 * prompt, polls history, and imports the result into the project's
 * `Generated/` folder via `saveGenerationResult`. Meanwhile the new
 * ComfyUI-tab auto-import service listens for eligible unmanaged prompts and
 * imports outputs into `Imported from ComfyUI/` when they were observed through
 * the embedded ComfyUI tab.
 *
 * To prevent the same generation from being imported twice (once via
 * each path), GenerateWorkspace registers every prompt ID it queues in
 * this guard. The auto-import bridge checks the guard and skips any
 * prompt already claimed by the managed pipeline.
 *
 * The registry is in-memory only (recycles on app reload), which is
 * fine because ComfyUI's own history is bounded and we only care about
 * prompts that are currently in-flight or recently finished.
 */

const MAX_ENTRIES = 500
const handledPromptIds = new Set()

function normalizeId(promptId) {
  if (promptId == null) return null
  const s = String(promptId).trim()
  return s.length > 0 ? s : null
}

/**
 * Mark a prompt as already being handled by Velorn's managed
 * workflow pipeline (GenerateWorkspace). Call this right after
 * `comfyui.queuePrompt` succeeds for an in-app job.
 */
export function markPromptHandledByApp(promptId) {
  const id = normalizeId(promptId)
  if (!id) return
  handledPromptIds.add(id)
  if (handledPromptIds.size > MAX_ENTRIES) {
    // Evict the oldest entry. Set preserves insertion order.
    const first = handledPromptIds.values().next().value
    if (first) handledPromptIds.delete(first)
  }
}

/**
 * Returns true if the prompt was queued by Velorn's managed
 * pipeline (and therefore the auto-import bridge should NOT double
 * import it).
 */
export function isPromptHandledByApp(promptId) {
  const id = normalizeId(promptId)
  if (!id) return false
  return handledPromptIds.has(id)
}

export function clearPromptHandledRegistry() {
  handledPromptIds.clear()
}
