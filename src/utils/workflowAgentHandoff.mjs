// Lazy agent panels may not exist until first opened. Wait only for that mount,
// never for a running turn, and recheck project/export/dialog ownership first.
export async function stageWorkflowInAgent(entry, { handlerRef, reveal, isCurrent, timeoutMs = 4000 }) {
  if (!isCurrent()) return { success: false, error: 'Open a project and wait for export to finish before adding a workflow.' }
  if (!handlerRef.current) {
    reveal()
    const deadline = Date.now() + timeoutMs
    while (!handlerRef.current && isCurrent() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  if (!isCurrent()) return { success: false, error: 'The project or library changed. Nothing was added to chat.' }
  if (!handlerRef.current) return { success: false, error: 'The agent panel is still loading. Try again in a moment.' }
  const result = handlerRef.current(entry)
  if (result?.success) reveal()
  return result || { success: false, error: 'Could not add this workflow to chat.' }
}
