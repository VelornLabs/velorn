import { useEffect, useId, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle2, Cloud, HelpCircle, Loader2, Monitor } from 'lucide-react'
import { connectRunningComfy } from '../services/comfyConnectionSetup.mjs'
import { refreshComfyLauncher } from '../services/comfyLauncher'
import { isExportBusy } from '../stores/exportActivityStore'
import ToolSetupAssistant from './ToolSetupAssistant'
import './GuidedComfySetup.css'

const GUIDE = 'https://docs.comfy.org/installation/manual_install'
const validPort = value => Number.isInteger(value) && value > 0 && value <= 65535
const failureText = failure => typeof failure?.message === 'string' ? failure.message.slice(0, 600) : 'The check could not finish. Please try again.'

/** A deterministic, optional guide. No model prompts, installs or checks on mount. */
export default function GuidedComfySetup({ onBack, onSkip, onManual, onCloudSetup }) {
  const [step, setStep] = useState('choice')
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [saved, setSaved] = useState(false)
  const alive = useRef(false), operation = useRef(null), timer = useRef(null)
  const heading = useRef(null), previousStep = useRef(step)
  const titleId = useId()
  const api = window.electronAPI
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; operation.current = null; clearTimeout(timer.current) }
  }, [])
  useEffect(() => {
    if (previousStep.current !== step) heading.current?.focus()
    previousStep.current = step
  }, [step])
  const leave = action => {
    operation.current = null
    clearTimeout(timer.current)
    setPending(''); setError(''); setResult(null); setSaved(false)
    action?.()
  }
  const go = next => leave(() => setStep(next))
  const run = async (action, task, bounded = false) => {
    if (operation.current) return
    const token = {}
    operation.current = token
    const current = () => alive.current && operation.current === token
    setPending(action); setError('')
    try {
      if (bounded) await Promise.race([task(current), new Promise((_, reject) => {
        timer.current = setTimeout(() => reject(new Error('The connection check took too long. Start ComfyUI if needed, then check again.')), 15000)
      })])
      else await task(current)
    } catch (failure) { if (current()) setError(failureText(failure)) }
    finally {
      if (current()) { clearTimeout(timer.current); operation.current = null; setPending('') }
    }
  }
  const check = () => {
    if (operation.current) return
    setResult(null); setSaved(false); setStep('check')
    void run('check', async current => {
      if (!api?.optionalSetup?.inspect) throw new Error('Open the latest Velorn desktop app to check this computer. You can still use the editor without ComfyUI.')
      const checked = await api.optionalSetup.inspect({ integration: 'comfyui' })
      if (!current()) return
      if (checked?.success !== true || checked.integration !== 'comfyui'
        || !['ready', 'unavailable'].includes(checked.state) || !validPort(checked.configuredPort)
        || !Array.isArray(checked.connections) || checked.connections.length > 12
        || checked.connections.some(item => !validPort(item?.port))) {
        throw new Error(checked?.error || 'ComfyUI could not be checked. Your saved connection has not changed.')
      }
      const connections = [...new Map(checked.connections.map(item => [item.port, { port: item.port }])).values()]
      const next = { configuredPort: checked.configuredPort, connections }
      setResult(next)
      // Ready requires a currently responding saved endpoint, not a remembered label.
      setStep(checked.state === 'ready' && connections.some(item => item.port === checked.configuredPort)
        ? 'ready' : connections.length ? 'connections' : 'unavailable')
    }, true)
  }
  const connect = port => void run('connect', async current => {
    if (isExportBusy()) throw new Error('Wait for the current export to finish before changing the ComfyUI connection.')
    const connected = await connectRunningComfy(port, { isCurrent: () => current() && !isExportBusy() })
    if (!current()) return
    if (connected?.cancelled) throw new Error('The connection change stopped before saving. Wait for any export to finish, then check again.')
    if (!connected?.success || connected.config?.port !== port) throw new Error(connected?.error || 'Could not verify this connection. Check again before retrying.')
    setResult({ configuredPort: port, connections: [{ port }] }); setSaved(true); setStep('ready')
    void refreshComfyLauncher().catch(() => {})
  })
  const guide = () => void run('guide', async () => {
    if (!api?.openExternalUrl) throw new Error(`Open ${GUIDE} in your browser for the official installation guide.`)
    const opened = await api.openExternalUrl(GUIDE)
    if (opened?.success === false) throw new Error(`Open ${GUIDE} in your browser for the official installation guide.`)
  })
  const titles = {
    choice: 'How would you like to create AI media?', help: 'Choose what works for you',
    local: 'Let’s check ComfyUI on this computer', check: 'Checking your connection',
    connections: result?.connections?.length === 1 ? 'We found ComfyUI' : 'Which ComfyUI would you like to use?',
    unavailable: 'ComfyUI isn’t responding yet', installation: 'Get ComfyUI ready',
    ready: 'Your ComfyUI connection is ready', paid: 'Use paid generation services',
  }
  const choices = <div className="guided-setup-choices">
    <button type="button" aria-label="Use this computer" onClick={() => go('local')}><Monitor size={19} aria-hidden="true" /><span><strong>Use this computer</strong><small>Connect ComfyUI for local workflows. Models and hardware are checked later.</small></span></button>
    <button type="button" aria-label="Use paid API services" onClick={() => go('paid')}><Cloud size={19} aria-hidden="true" /><span><strong>Use paid API services</strong><small>Set up your Comfy API key. Review costs before generating.</small></span></button>
    {step === 'choice' && <button type="button" aria-label="Help me choose" onClick={() => go('help')}><HelpCircle size={19} aria-hidden="true" /><span><strong>Help me choose</strong><small>A quick explanation—no account or agent needed.</small></span></button>}
  </div>
  return <section className="optional-setup guided-setup" aria-labelledby={titleId} aria-busy={Boolean(pending)}>
    <p className="guided-setup-eyebrow">Optional setup · AI generation</p>
    <h2 id={titleId} ref={heading} tabIndex={-1}>{titles[step]}</h2>
    {step === 'choice' && <><p>You can use Velorn just as an editor. Add generation now, or come back whenever you need it.</p>{choices}</>}
    {step === 'help' && <>
      <p><strong>Local models</strong> run on your computer. Speed and memory needs depend on the model and your hardware; connecting ComfyUI alone does not confirm they will run.</p>
      <p><strong>Paid API services</strong> run supported generation remotely using your account and credits. Some workflows still need a local ComfyUI runner.</p>
      <p>You can use both. We won’t buy credits, download models or start generation during this guide.</p>{choices}
    </>}
    {step === 'local' && <><p>You don’t need to know whether ComfyUI is installed. We can look for a running local server first.</p><p>This checks local connections only. It won’t install anything, start ComfyUI or change your settings.</p><button type="button" onClick={check}>Check this computer</button></>}
    {step === 'check' && !pending && !error && <button type="button" onClick={check}>Check again</button>}
    {step === 'connections' && <>
      <p>{result.connections.length === 1 ? 'Connect Velorn to this server?' : 'More than one server responded. Choose the one you want; we won’t guess.'} We’ll test it once more before saving the connection.</p>
      <div className="guided-setup-choices">{result.connections.map(candidate => <button key={candidate.port} type="button" aria-label={`Connect on port ${candidate.port}`} disabled={Boolean(pending)} onClick={() => connect(candidate.port)}>
        <Monitor size={19} aria-hidden="true" /><span><strong>Connect on port {candidate.port}</strong><small>Local ComfyUI · 127.0.0.1:{candidate.port}{candidate.port === result.configuredPort ? ' · Saved connection' : ''}</small></span>
      </button>)}</div>
    </>}
    {step === 'unavailable' && <>
      <p>No server responded on the local ports we checked. ComfyUI may be stopped or using another port—this does not mean it is uninstalled.</p>
      <p>If you already have it, open ComfyUI and start your local instance, then check again.</p>
      <div className="optional-setup-actions"><button type="button" onClick={check}>Check again</button><button type="button" onClick={() => go('installation')}>Installation help</button></div>
      <p className="optional-setup-hint">Using another port? Choose Configure manually below.</p>
    </>}
    {step === 'installation' && <>
      {api?.platform === 'darwin' ? <><p>Review the existing installer plan, approve any download, and follow the app’s own installation steps. Then open ComfyUI and check again.</p><ToolSetupAssistant integration="comfyui" name="ComfyUI" onCheck={check} /></> : <>
        <p>Automatic ComfyUI installation is not available in this guide on {api?.platform === 'linux' ? 'Linux' : 'this platform'} yet. Use the official installation guide, then start your local server and return here.</p>
        <p>Choose model downloads separately after reviewing their size, license and hardware needs. No installer or model download has started.</p>
        <div className="optional-setup-actions"><button type="button" disabled={Boolean(pending)} onClick={guide}>Official ComfyUI installation guide</button><button type="button" disabled={Boolean(pending)} onClick={check}>Check again</button></div>
      </>}
    </>}
    {step === 'paid' && <>
      <p>Use the existing Comfy API key settings to add your key privately. Never paste it into agent chat.</p>
      <p>An API key is not a hosted ComfyUI server connection. The connection you need depends on your workflow; hosted-server setup is not included in this guide.</p>
      <p>Saving a key does not start generation or buy credits. This step does not verify your balance or that a workflow is ready.</p>
      {onCloudSetup ? <button type="button" onClick={() => leave(onCloudSetup)}>Open API key settings</button> : <p>Open Settings → Cloud generation to manage your Comfy API key.</p>}
      <div className="optional-setup-actions"><button type="button" onClick={() => go('local')}>Also connect local ComfyUI</button></div>
    </>}
    {step === 'ready' && <>
      <div className="guided-setup-ready" role="status"><CheckCircle2 size={20} aria-hidden="true" /><span>Connected · local port {result.configuredPort}</span></div>
      <p>{saved ? 'Your verified connection was saved.' : 'Your saved connection is responding. No settings were changed.'} No generation was started.</p>
      <p>Next, choose a workflow when you’re ready to create. Its models, dependencies and any paid costs are checked separately.</p>
      <p className="optional-setup-hint">This does not configure automatic startup or confirm model compatibility.</p>
      <div className="optional-setup-actions"><button type="button" onClick={() => leave(onSkip || onBack)}>Done</button><button type="button" onClick={check}>Check again</button></div>
    </>}
    {pending && <p className="guided-setup-progress" role="status"><Loader2 size={15} className="animate-spin" aria-hidden="true" />{pending === 'check' ? 'Looking for running ComfyUI servers…' : pending === 'connect' ? 'Testing and saving your selected connection…' : 'Opening the official guide…'}</p>}
    {error && <div role="alert"><p className="optional-setup-error">{error}</p>{step === 'check' && <button type="button" disabled={Boolean(pending)} onClick={check}>Check again</button>}</div>}
    <nav className="guided-setup-navigation" aria-label="Setup navigation">
      <button type="button" onClick={() => step === 'choice' ? leave(onBack) : go(['check', 'connections', 'unavailable', 'ready', 'installation'].includes(step) ? 'local' : 'choice')}><ArrowLeft size={14} aria-hidden="true" />Back</button>
      <button type="button" onClick={() => leave(onManual)}>Configure manually</button>
      {step !== 'ready' && <button type="button" onClick={() => leave(onSkip || onBack)}>Skip for now</button>}
    </nav>
    <p className="optional-setup-footer">No Velo credits or model prompts are used. Your agent, chats and project stay unchanged. Leaving stops pending checks; a settings save already in progress can still finish.</p>
  </section>
}
