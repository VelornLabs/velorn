import { hasStoryboardContent } from './storyboardWorkspace.mjs'

// Optional conversation starters, not modes, commands, project types or grants.
// Only their visible text enters the user's editable composer.
export const AGENT_PROJECT_STARTERS = Object.freeze([
  { id: 'music-video', label: 'Music video', hint: 'Start with a song.',
    prompt: "I'd like to make a music video. Let's develop it together—ask me about the song and my ideas before we create anything." },
  { id: 'ugc', label: 'UGC', hint: 'Keep it personal.',
    prompt: "I'd like to make UGC-style content. Let's discuss who it's for and what I want to say before creating anything." },
  { id: 'commercial', label: 'Commercial', hint: 'Find the hook.',
    prompt: "I'd like to make a commercial. Ask me about the product or service, the audience, and my ideas—one step at a time." },
  { id: 'short-film', label: 'Short film', hint: 'Build a story.',
    prompt: "I'd like to make a short film. Let's start with the story or feeling I have in mind, or help me explore ideas if I'm not sure." },
  { id: 'edit', label: 'Edit my project', hint: 'Work with what’s here.',
    prompt: "I'd like help with the edit in this project. Ask me what I'd like to improve before making changes." },
  { id: 'chat', label: 'Freeform', hint: 'Generate, edit, or explore—your way.',
    prompt: "Let's work freely. I'll tell you what I need as we go." },
].map(entry => Object.freeze(entry)))

export const CONTINUE_PROJECT_STARTER = Object.freeze({ id: 'continue', label: 'Continue this project',
  prompt: "Let's continue this project. Start with the saved brief and what's already here, then ask which part I'd like to work on next. Don't restart the plan or make changes yet." })

export function hasExistingAgentProjectWork({ project, assets = [], clips = [] } = {}) {
  if (!project) return false
  if ((Array.isArray(assets) && assets.length) || (Array.isArray(clips) && clips.length)) return true
  if (Array.isArray(project.timelines) && (project.timelines.length > 1
    || project.timelines.some(timeline => Array.isArray(timeline?.clips) && timeline.clips.length))) return true
  return hasStoryboardContent(project.storyboard)
}

export function stageAgentProjectStarter({ id, draft = '', previousStarterText = '' } = {}) {
  const starter = [...AGENT_PROJECT_STARTERS, CONTINUE_PROJECT_STARTER].find(entry => entry.id === id)
  if (!starter) return { success: false, error: 'Choose an available conversation starter.' }
  const current = typeof draft === 'string' ? draft : ''
  // Switching starters may replace only text we inserted untouched, never
  // words the creator has edited or a workflow/attachment reference.
  const replaceUntouched = !current || (previousStarterText && current === previousStarterText)
  const text = replaceUntouched ? starter.prompt
    : current.includes(starter.prompt) ? current : `${current}\n\n${starter.prompt}`
  if (text.length > 12000) return { success: false, error: 'Your draft is too long to add a starter. Shorten it first; nothing has been sent.' }
  return { success: true, text, starterText: replaceUntouched ? starter.prompt : '' }
}
