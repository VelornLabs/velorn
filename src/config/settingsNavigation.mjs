// Navigation/search metadata only. No preference reads, writes or app actions.
export const SETTINGS_GROUPS = [
  { id: 'general', title: 'General', description: 'Make Velorn feel right for you.', pages: ['appearance', 'language', 'notifications'] },
  { id: 'editing', title: 'Editing', description: 'Customize the editor and your keyboard shortcuts.', pages: ['editor', 'hotkeys'] },
  { id: 'media', title: 'Media & Storage', description: 'Manage project storage, imported media and safe removal defaults.', pages: ['storage', 'assets', 'paths'] },
  { id: 'playback', title: 'Playback & Export', description: 'Maintain smooth playback and configure advanced export tools.', pages: ['cache', 'ffmpeg'] },
  { id: 'connections', title: 'Connections', description: 'Connect optional generation tools, media services and agents.', pages: ['setup', 'comfy', 'cloud', 'stock', 'workflow-setup', 'agents', 'network'] },
  { id: 'project', title: 'New Project Defaults', description: 'Defaults for future projects; your open project is not changed.', pages: ['project'] },
]

export const SETTINGS_PAGES = [
  { id: 'appearance', title: 'Appearance & navigation', keywords: 'theme color dark light director generate tutorials discover create sound stock gpu sharing comfyui tab tabs show hide navigation hero background project picker' },
  { id: 'language', title: 'Language', keywords: 'display translation locale english japanese' },
  { id: 'notifications', title: 'Sounds & notifications', keywords: 'generation completion volume alert mute sound' },
  { id: 'editor', title: 'Timeline display', keywords: 'editing clip thumbnails timeline images' },
  { id: 'hotkeys', title: 'Keyboard shortcuts', keywords: 'hotkeys keys bindings keymap presets keyboard undo redo' },
  { id: 'storage', title: 'Projects & autosave', keywords: 'default project location directory storage save reopen startup current close' },
  { id: 'assets', title: 'Import & removal', keywords: 'asset delete deletion disk files keep trash recycle bin project only remove media automatically import comfy outputs' },
  { id: 'paths', title: 'Media folders', keywords: 'file paths generated output workflow directory folder' },
  { id: 'cache', title: 'Playback cache', keywords: 'video performance proxy proxies rebuild smooth playback current project' },
  { id: 'ffmpeg', title: 'Advanced export tools', keywords: 'hardware encoding export ffmpeg nvenc h264 h265 codec gpu encoder videotoolbox' },
  { id: 'setup', title: 'Connect tools', keywords: 'optional setup getting started first run codex chatgpt sign in login lm studio local agent comfyui installation editor only' },
  { id: 'comfy', title: 'ComfyUI', keywords: 'connect connection local server port find desktop launcher start stop restart logs startup' },
  { id: 'cloud', title: 'Cloud generation', keywords: 'comfy org hosted cloud subscription partner api key account access credits balance billing' },
  { id: 'stock', title: 'Stock media (Pexels)', keywords: 'pexels api key stock photos videos account' },
  { id: 'workflow-setup', title: 'Generation tools', keywords: 'workflow setup install models nodes dependencies comfy folder library music video image' },
  { id: 'agents', title: 'Agents (MCP)', keywords: 'agent mcp claude codex cursor tools integration endpoint server' },
  { id: 'network', title: 'Share your GPU', keywords: 'velorn network gpu sharing share invite host jobs report shared computer' },
  { id: 'project', title: 'New Project Defaults', keywords: 'resolution width height fps frame rate dimensions new project defaults' },
]

export const LEGACY_SETTINGS_SECTIONS = Object.freeze({ connection: 'comfy', launcher: 'comfy' })

export function resolveSettingsTarget(value) {
  if (value === 'feedback') return { groupId: 'feedback', pageId: 'feedback' }
  const pageId = LEGACY_SETTINGS_SECTIONS[value] || value
  const group = SETTINGS_GROUPS.find(candidate => candidate.pages.includes(pageId))
    || SETTINGS_GROUPS.find(candidate => candidate.id === value)
    || SETTINGS_GROUPS[0]
  return { groupId: group.id, pageId: group.pages.includes(pageId) ? pageId : group.pages[0] }
}

export function searchSettings(query, pages = SETTINGS_PAGES, groups = SETTINGS_GROUPS) {
  const terms = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  return pages.flatMap(page => {
    const group = groups.find(candidate => candidate.pages.includes(page.id))
    if (!group) return []
    const haystack = [page.title, page.keywords, group.title, group.description].join(' ').toLocaleLowerCase()
    return terms.every(term => haystack.includes(term)) ? [{ ...page, groupId: group.id, groupTitle: group.title }] : []
  })
}
