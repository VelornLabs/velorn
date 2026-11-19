import { Clapperboard, Film, Megaphone, MessageSquare, Music2, Scissors, UserRound, ArrowUpRight } from 'lucide-react'
import { AGENT_PROJECT_STARTERS } from '../utils/agentProjectStarters.mjs'
import { VELO_DESCRIPTION } from '../utils/connectedAgentProviders.mjs'

const icons = { 'music-video': Music2, ugc: UserRound, commercial: Megaphone, 'short-film': Film, edit: Scissors, chat: MessageSquare }

export default function AgentProjectWelcome({ projectName, hasProjectWork = false, onChoose, disabled = false, notice = '', fullAccessEnabled = false, computerAccessEnabled = false, toolsEnabled = false, provider }) {
  const cards = <div className="ca-starter-grid" role="group" aria-label="Project starters">
    {AGENT_PROJECT_STARTERS.map(starter => {
      const Icon = icons[starter.id]
      return <button type="button" key={starter.id} className="ca-starter" aria-label={starter.label}
        disabled={disabled} onClick={() => onChoose(starter.id)} title="Add an editable starter to your draft. Nothing is sent yet.">
        <Icon size={17} aria-hidden="true" /><span><strong>{starter.label}</strong><small>{starter.hint}</small></span>
      </button>
    })}
  </div>
  return <section className="ca-welcome ca-project-welcome" aria-label="Start a conversation">
    <Clapperboard className="ca-welcome-icon" size={25} aria-hidden="true" />
    <h3>{provider === 'luna' ? 'Velo' : hasProjectWork ? <>What would you like to work on in <span className="ca-welcome-project">{projectName || 'this project'}</span>?</> : 'What would you like to work on today?'}</h3>
    <p>{provider === 'luna' ? VELO_DESCRIPTION : hasProjectWork ? 'Pick up with what’s already here, or explore a new direction.' : 'Choose a starting point, or tell me what you have in mind.'}</p>
    <details className="ca-more-starters"><summary>Ideas to get started</summary>
      {hasProjectWork && <button type="button" className="ca-continue-project" disabled={disabled} onClick={() => onChoose('continue')}><ArrowUpRight size={15} aria-hidden="true" />Continue this project</button>}
      {cards}
      <p className="ca-starter-help">Adds a suggestion to your draft. Edit it, then press Send when you’re ready.</p>
    </details>
    {notice && <p className="ca-starter-notice" role="status">{notice}</p>}
    <p className="ca-welcome-capabilities">{fullAccessEnabled
      ? provider === 'codex' || computerAccessEnabled ? 'Full computer access is active. Computer actions can run without per-action prompts; stop the response to interrupt.'
        : 'Full Velorn access is active. Velorn actions can run without per-action prompts; stop the response to interrupt.'
      : toolsEnabled ? 'We can plan together, then use Velorn’s tools when you’re ready. Your current approval settings still apply.'
        : 'You can plan and discuss now. Enable Velorn tools in Assistant settings when you want the assistant to make changes.'}</p>
  </section>
}
