// A workflow reference is composer text, not a submission or permission grant.
export function appendWorkflowAgentReference(draft, entry) {
  const id = typeof entry?.id === 'string' ? entry.id : ''
  if (!/^(?:my-workflow:[A-Za-z0-9][A-Za-z0-9_.-]*|tpl-mcp-[a-z0-9][a-z0-9-]{0,47})$/.test(id) || id.length > 200) {
    return { success: false, error: 'This workflow has no saved library reference. Refresh My Workflows and try again.' }
  }
  const title = String(entry.title || entry.label || 'Saved workflow')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 240)
  const reference = `Saved workflow: ${JSON.stringify(title)}\nWorkflow ID: ${id}`
  const current = typeof draft === 'string' ? draft : ''
  if (current.includes(`Workflow ID: ${id}\n`)) return { success: true, text: current, alreadyAdded: true }
  const addition = `${reference}\nHelp me use this workflow. Inspect its saved graph first, then let's discuss the inputs and what I want to make before running anything. Keep per-run changes separate from the saved original.`
  const text = current ? `${current}\n\n${addition}` : addition
  if (text.length > 12000) return { success: false, error: 'Your draft is too long to add this workflow. Shorten it first; nothing has been sent.' }
  return { success: true, text }
}
