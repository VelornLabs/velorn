// Opaque phone IDs never become filesystem paths supplied by the phone.
export function createMobileProjectController({ getState, listProjects, isDirty, editIdentity, uuid }) {
  const registry = new Map()
  let switching = false
  async function list() {
    const state = getState()
    const rows = [...(state.recentProjects || [])]
    if (state.defaultProjectsHandle) {
      try { rows.push(...await listProjects(state.defaultProjectsHandle)) } catch { /* Recent and current projects remain usable if an external drive is offline. */ }
    }
    if (state.currentProjectHandle) rows.unshift({ path: state.currentProjectHandle, name: state.currentProject?.name || 'Current project' })
    const seen = new Set(), result = []
    for (const row of rows) {
      if (typeof row.path !== 'string' || seen.has(row.path)) continue
      seen.add(row.path)
      let entry = [...registry.values()].find(item => item.path === row.path)
      if (!entry) { entry = { id: uuid(), path: row.path }; registry.set(entry.id, entry) }
      result.push({ id: entry.id, name: row.name || 'Project', current: row.path === state.currentProjectHandle })
      if (result.length === 100) break
    }
    return result
  }
  async function open(id, saveCurrent, isCurrent) {
    const target = registry.get(id)
    if (!target || switching || !isCurrent()) throw Error('The project selection changed. Refresh and try again.')
    if (target.path === getState().currentProjectHandle) return
    switching = true
    try {
      if (isDirty()) {
        if (!saveCurrent) throw Error('Save the current project before switching.')
        const before = editIdentity()
        if (!await getState().saveProject()) throw Error('Saving failed. The current project remains open.')
        if (!isCurrent() || editIdentity() !== before || isDirty()) throw Error('The project changed while saving. Review it before switching.')
      }
      if (!isCurrent()) throw Error('The desktop changed. No new project was opened.')
      if (!await getState().openProject(target.path)) throw Error('The project could not be opened. Check the desktop.')
    } finally { switching = false }
  }
  return { list, open }
}
