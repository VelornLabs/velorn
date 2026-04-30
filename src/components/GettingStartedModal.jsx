import { useEffect, useMemo, useState } from 'react'
import {
  X,
  Rocket,
  CheckCircle2,
  Circle,
  AlertCircle,
  Settings,
  Sparkles,
  Download,
  Server,
  KeyRound,
  Image as ImageIcon,
  FolderOpen,
  Clapperboard,
} from 'lucide-react'
import {
  COMFY_CONNECTION_CHANGED_EVENT,
  checkLocalComfyConnection,
  getLocalComfyConnectionSync,
  hydrateLocalComfyConnection,
} from '../services/localComfyConnection'
import { getPexelsApiKey } from '../services/pexelsSettings'
import { WORKFLOW_SETUP_SECTION_ID } from '../services/workflowSetupManager'
import ApiKeyDialog from './ApiKeyDialog'
import {
  COMFY_PARTNER_KEY_CHANGED_EVENT,
  COMFY_PARTNER_WORKFLOWS,
  getComfyPartnerApiKey,
} from '../services/comfyPartnerAuth'

function StatusPill({ tone = 'neutral', children }) {
  const toneClassName = {
    success: 'bg-green-500/10 text-green-400 border-green-500/30',
    warning: 'bg-yellow-500/10 text-yellow-300 border-yellow-500/30',
    neutral: 'bg-sf-dark-700 text-sf-text-secondary border-sf-dark-600',
  }[tone] || 'bg-sf-dark-700 text-sf-text-secondary border-sf-dark-600'

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClassName}`}>
      {tone === 'success' ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : tone === 'warning' ? (
        <AlertCircle className="h-3 w-3" />
      ) : (
        <Circle className="h-3 w-3" />
      )}
      {children}
    </span>
  )
}

function ChecklistCard({
  icon: Icon,
  title,
  description,
  statusTone = 'neutral',
  statusLabel,
  detail,
  helperLines = [],
  actions = [],
}) {
  return (
    <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-sf-dark-800 p-2">
            <Icon className="h-4 w-4 text-sf-accent" />
          </div>
          <div>
            <div className="text-sm font-semibold text-sf-text-primary">{title}</div>
            <div className="mt-1 text-xs text-sf-text-muted">{description}</div>
          </div>
        </div>
        <StatusPill tone={statusTone}>{statusLabel}</StatusPill>
      </div>

      {detail && (
        <div className="mb-3 rounded-lg border border-sf-dark-700 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-secondary">
          {detail}
        </div>
      )}

      {helperLines.length > 0 && (
        <div className="mb-3 space-y-1 text-[11px] text-sf-text-secondary">
          {helperLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}

      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              disabled={action.disabled}
              className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                action.primary
                  ? 'bg-sf-accent text-white hover:bg-sf-accent-hover disabled:opacity-50'
                  : 'bg-sf-dark-800 text-sf-text-secondary hover:bg-sf-dark-700 disabled:opacity-50'
              }`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TourCard({ icon: Icon, title, description, helperLines = [], actionLabel, onAction }) {
  return (
    <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900 p-4">
      <div className="mb-3 flex items-start gap-3">
        <div className="rounded-lg bg-sf-dark-800 p-2">
          <Icon className="h-4 w-4 text-sf-accent" />
        </div>
        <div>
          <div className="text-sm font-semibold text-sf-text-primary">{title}</div>
          <div className="mt-1 text-xs text-sf-text-muted">{description}</div>
        </div>
      </div>

      <div className="mb-3 space-y-1 text-[11px] text-sf-text-secondary">
        {helperLines.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>

      <button
        type="button"
        onClick={onAction}
        className="rounded-lg bg-sf-dark-800 px-3 py-2 text-xs font-medium text-sf-text-secondary transition-colors hover:bg-sf-dark-700"
      >
        {actionLabel}
      </button>
    </div>
  )
}

export default function GettingStartedModal({
  isOpen,
  onClose,
  projectName,
  defaultProjectsLocation,
  onOpenSettings,
  onNavigate,
}) {
  const [activeTab, setActiveTab] = useState('setup')
  const [comfyConnection, setComfyConnection] = useState(() => getLocalComfyConnectionSync())
  const [connectionState, setConnectionState] = useState({
    status: 'idle',
    message: `Saved endpoint: ${getLocalComfyConnectionSync().httpBase}`,
  })
  const [testingConnection, setTestingConnection] = useState(false)
  const [pexelsConfigured, setPexelsConfigured] = useState(false)
  const [partnerKeyConfigured, setPartnerKeyConfigured] = useState(false)
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false)

  useEffect(() => {
    if (!isOpen) return

    let cancelled = false

    const loadSetupState = async () => {
      try {
        const connection = await hydrateLocalComfyConnection()
        if (cancelled) return
        setComfyConnection(connection)
        setConnectionState({
          status: 'idle',
          message: `Saved endpoint: ${connection.httpBase}`,
        })

        const testResult = await checkLocalComfyConnection({ port: connection.port, timeoutMs: 2500 })
        if (cancelled) return
        setConnectionState(
          testResult.ok
            ? { status: 'success', message: `Connected to ${testResult.httpBase}` }
            : { status: 'warning', message: testResult.error || `Could not connect to ${connection.httpBase}.` }
        )
      } catch {
        if (!cancelled) {
          const fallback = getLocalComfyConnectionSync()
          setComfyConnection(fallback)
          setConnectionState({
            status: 'warning',
            message: `Could not verify ${fallback.httpBase} yet.`,
          })
        }
      }

      try {
        const pexelsKey = await getPexelsApiKey()
        if (!cancelled) {
          setPexelsConfigured(Boolean(String(pexelsKey || '').trim()))
        }
      } catch {
        if (!cancelled) {
          setPexelsConfigured(false)
        }
      }

      try {
        const partnerKey = await getComfyPartnerApiKey()
        if (!cancelled) {
          setPartnerKeyConfigured(Boolean(String(partnerKey || '').trim()))
        }
      } catch {
        if (!cancelled) {
          setPartnerKeyConfigured(false)
        }
      }
    }

    setActiveTab('setup')
    loadSetupState()

    const handleConnectionChanged = (event) => {
      const nextConnection = event?.detail?.httpBase ? event.detail : getLocalComfyConnectionSync()
      setComfyConnection(nextConnection)
      setConnectionState({
        status: 'idle',
        message: `Saved endpoint: ${nextConnection.httpBase}`,
      })
    }

    window.addEventListener(COMFY_CONNECTION_CHANGED_EVENT, handleConnectionChanged)

    const handlePartnerKeyChanged = (event) => {
      setPartnerKeyConfigured(Boolean(event?.detail?.hasKey))
    }
    window.addEventListener(COMFY_PARTNER_KEY_CHANGED_EVENT, handlePartnerKeyChanged)

    return () => {
      cancelled = true
      window.removeEventListener(COMFY_CONNECTION_CHANGED_EVENT, handleConnectionChanged)
      window.removeEventListener(COMFY_PARTNER_KEY_CHANGED_EVENT, handlePartnerKeyChanged)
    }
  }, [isOpen])

  const handleTestConnection = async () => {
    setTestingConnection(true)
    setConnectionState({
      status: 'idle',
      message: `Testing ${comfyConnection.httpBase}...`,
    })

    try {
      const testResult = await checkLocalComfyConnection({ port: comfyConnection.port })
      setConnectionState(
        testResult.ok
          ? { status: 'success', message: `Connected to ${testResult.httpBase}` }
          : { status: 'warning', message: testResult.error || `Could not connect to ${comfyConnection.httpBase}.` }
      )
    } finally {
      setTestingConnection(false)
    }
  }

  const handleOpenSettings = (section) => {
    onOpenSettings?.(section)
  }

  const handleNavigate = (tab) => {
    onNavigate?.(tab)
  }

  const setupSummary = useMemo(() => {
    const readyCount = [
      Boolean(defaultProjectsLocation),
      connectionState.status === 'success',
      true,
      connectionState.status === 'success' || partnerKeyConfigured,
    ].filter(Boolean).length

    return `${readyCount}/4 ready-to-generate steps complete`
  }, [connectionState.status, defaultProjectsLocation, partnerKeyConfigured])

  const readyPathSteps = useMemo(() => ([
    {
      label: 'Projects Folder',
      ready: Boolean(defaultProjectsLocation),
      detail: defaultProjectsLocation ? 'Ready' : 'Pick where projects and generated media live.',
    },
    {
      label: 'ComfyUI Connection',
      ready: connectionState.status === 'success',
      detail: connectionState.status === 'success' ? 'Connected' : 'Connect to local ComfyUI or use cloud workflows.',
    },
    {
      label: 'Workflow Setup',
      ready: true,
      detail: 'Open starter kits to prepare models and nodes by use case.',
    },
    {
      label: 'Ready To Generate',
      ready: connectionState.status === 'success' || partnerKeyConfigured,
      detail: connectionState.status === 'success' || partnerKeyConfigured ? 'Local or cloud generation is available.' : 'Connect local ComfyUI or add a cloud API key.',
    },
  ]), [connectionState.status, defaultProjectsLocation, partnerKeyConfigured])

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pb-4 pt-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-sf-dark-600 bg-sf-dark-950 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-sf-dark-700 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-sf-dark-700 bg-sf-dark-900 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-sf-text-muted">
                <Rocket className="h-3 w-3 text-sf-accent" />
                Getting Started
              </div>
              <h2 className="text-xl font-semibold text-sf-text-primary">
                Get from install to first generation
              </h2>
              <p className="mt-2 max-w-3xl text-sm text-sf-text-muted">
                ComfyStudio can run local, cloud, and hybrid AI workflows. This guide keeps the first-run path simple: choose how you want to connect, prepare the workflows you need, then start creating.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-sf-text-muted transition-colors hover:bg-sf-dark-800 hover:text-sf-text-primary"
              aria-label="Close getting started"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="rounded-full border border-sf-dark-700 bg-sf-dark-900 px-3 py-1 text-xs text-sf-text-secondary">
              Project: <span className="text-sf-text-primary">{projectName || 'Untitled'}</span>
            </div>
            <div className="rounded-full border border-sf-dark-700 bg-sf-dark-900 px-3 py-1 text-xs text-sf-text-secondary">
              {setupSummary}
            </div>
            <div className="rounded-full border border-sf-dark-700 bg-sf-dark-900 px-3 py-1 text-xs text-sf-text-secondary">
              Reopen later from <span className="text-sf-text-primary">ComfyStudio &gt; Getting Started</span>
            </div>
          </div>
        </div>

        <div className="border-b border-sf-dark-700 px-5 py-3">
          <div className="inline-flex rounded-xl border border-sf-dark-700 bg-sf-dark-900 p-1">
            <button
              type="button"
              onClick={() => setActiveTab('setup')}
              className={`rounded-lg px-4 py-2 text-sm transition-colors ${
                activeTab === 'setup'
                  ? 'bg-sf-accent text-white'
                  : 'text-sf-text-muted hover:bg-sf-dark-800 hover:text-sf-text-primary'
              }`}
            >
              Setup Checklist
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('tour')}
              className={`rounded-lg px-4 py-2 text-sm transition-colors ${
                activeTab === 'tour'
                  ? 'bg-sf-accent text-white'
                  : 'text-sf-text-muted hover:bg-sf-dark-800 hover:text-sf-text-primary'
              }`}
            >
              Quick Tour
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {activeTab === 'setup' ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-sf-accent/30 bg-sf-accent/10 px-4 py-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="max-w-2xl">
                    <div className="text-sm font-semibold text-sf-text-primary">Choose your setup path</div>
                    <p className="mt-1 text-xs leading-relaxed text-sf-text-secondary">
                      Use <span className="text-sf-text-primary">Quick Start</span> if you want ComfyStudio to guide you through a starter kit. Use <span className="text-sf-text-primary">Bring Your Own ComfyUI</span> if you already have a custom ComfyUI install and just need ComfyStudio pointed at it.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => handleOpenSettings(WORKFLOW_SETUP_SECTION_ID)}
                      className="rounded-lg bg-sf-accent px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-sf-accent-hover"
                    >
                      Quick Start Setup
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenSettings('connection')}
                      className="rounded-lg border border-sf-dark-500 bg-sf-dark-900 px-3 py-2 text-xs font-semibold text-sf-text-secondary transition-colors hover:border-sf-dark-400 hover:text-sf-text-primary"
                    >
                      Bring Your Own ComfyUI
                    </button>
                  </div>
                </div>
                <div className="mt-4 grid gap-2 md:grid-cols-4">
                  {readyPathSteps.map((step) => (
                    <div
                      key={step.label}
                      className={`rounded-lg border px-3 py-2 ${
                        step.ready
                          ? 'border-green-500/25 bg-green-500/10'
                          : 'border-sf-dark-600 bg-sf-dark-900/65'
                      }`}
                    >
                      <div className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${step.ready ? 'text-green-400' : 'text-sf-text-muted'}`}>
                        {step.ready ? 'Ready' : 'Next'}
                      </div>
                      <div className="mt-1 text-xs font-medium text-sf-text-primary">{step.label}</div>
                      <div className="mt-1 text-[10px] leading-relaxed text-sf-text-muted">{step.detail}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <ChecklistCard
                  icon={FolderOpen}
                  title="Workspace folder"
                  description="Projects, imported assets, and generated media live under your selected projects folder."
                  statusTone={defaultProjectsLocation ? 'success' : 'warning'}
                  statusLabel={defaultProjectsLocation ? 'Ready' : 'Needs setup'}
                  detail={defaultProjectsLocation || 'No default projects folder selected yet.'}
                  actions={[
                    { label: 'Open Settings', onClick: () => handleOpenSettings('storage') },
                  ]}
                />

                <ChecklistCard
                  icon={Server}
                  title="Local ComfyUI connection"
                  description="ComfyStudio talks to a local ComfyUI server on localhost only. If generations fail immediately, check the saved port first."
                  statusTone={connectionState.status === 'success' ? 'success' : connectionState.status === 'warning' ? 'warning' : 'neutral'}
                  statusLabel={connectionState.status === 'success' ? 'Connected' : connectionState.status === 'warning' ? 'Check port' : 'Saved'}
                  detail={connectionState.message}
                  helperLines={[
                    `Saved endpoint: ${comfyConnection.httpBase}`,
                    'If your ComfyUI window uses a different port, update it in Settings before generating.',
                  ]}
                  actions={[
                    { label: testingConnection ? 'Testing...' : 'Test Connection', onClick: handleTestConnection, primary: true, disabled: testingConnection },
                    { label: 'Connection Settings', onClick: () => handleOpenSettings('connection') },
                  ]}
                />

                <ChecklistCard
                  icon={Clapperboard}
                  title="Workflow requirements"
                  description="Each workflow can require custom nodes, models, or a partner API key even though the workflow file is already bundled in the app."
                  statusTone="neutral"
                  statusLabel="Use Workflow Setup"
                  helperLines={[
                    'Open Settings > Workflow Setup to scan every built-in workflow at once.',
                    'Use Generate when you want workflow-specific fallback tools like Load in ComfyUI and per-workflow Re-check.',
                    'This is the fastest way to answer: why does this workflow work on one machine but not another?',
                  ]}
                  actions={[
                    { label: 'Workflow Setup', onClick: () => handleOpenSettings(WORKFLOW_SETUP_SECTION_ID), primary: true },
                    { label: 'Open Generate', onClick: () => handleNavigate('generate') },
                  ]}
                />

                <ChecklistCard
                  icon={KeyRound}
                  title="Cloud Workflows API key"
                  description={`One Comfy.org key unlocks the ${COMFY_PARTNER_WORKFLOWS.length} cloud-rendered starter workflows: Grok, Kling, Vidu, Nano Banana, and Seedream.`}
                  statusTone={partnerKeyConfigured ? 'success' : 'warning'}
                  statusLabel={partnerKeyConfigured ? 'Key saved' : 'Optional but recommended'}
                  detail={partnerKeyConfigured ? 'Cloud-powered workflows are ready to go.' : 'Paste your key once and you can skip local GPU setup for these workflows.'}
                  helperLines={[
                    'Great for low-VRAM machines — cloud workflows run on Comfy.org and cost a few cents per generation.',
                    'You can skip this and come back any time.',
                  ]}
                  actions={[
                    { label: partnerKeyConfigured ? 'Change key' : 'Add API key', onClick: () => setApiKeyDialogOpen(true), primary: true },
                  ]}
                />

                <ChecklistCard
                  icon={ImageIcon}
                  title="Stock setup"
                  description="The Stock tab uses Pexels. Add a key once and you can browse and import footage or photos directly into the project."
                  statusTone={pexelsConfigured ? 'success' : 'neutral'}
                  statusLabel={pexelsConfigured ? 'Pexels ready' : 'Optional'}
                  detail={pexelsConfigured ? 'Pexels API key detected.' : 'No Pexels API key detected yet.'}
                  helperLines={[
                    'You can skip this until you need stock content.',
                  ]}
                  actions={[
                    { label: 'Open Stock Settings', onClick: () => handleOpenSettings('stock') },
                    { label: 'Open Stock Tab', onClick: () => handleNavigate('stock') },
                  ]}
                />

              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-xl border border-sf-dark-700 bg-sf-dark-900/70 px-4 py-3 text-sm text-sf-text-secondary">
                This is the quick orientation layer. It is meant to answer “where do I go next?” while your videos can explain the deeper editing and prompting techniques in detail.
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <TourCard
                  icon={Sparkles}
                  title="Editor workspace"
                  description="This is the day-to-day editing view once media is inside the project."
                  helperLines={[
                    'Assets panel: import videos, audio, and images, then drag them to the timeline.',
                    'Preview: review media and send a frame to Generate as a starting keyframe.',
                    'Timeline: trim, ripple, snap, markers, and arrange your cut.',
                    'Inspector: transform, crop, timing, effects, text, and adjustments for the selected item.',
                  ]}
                  actionLabel="Open Editor"
                  onAction={() => handleNavigate('editor')}
                />

                <TourCard
                  icon={Rocket}
                  title="Generate"
                  description="Create images, videos, or audio with local or cloud workflows."
                  helperLines={[
                    'Single mode is for one-off image, video, or audio jobs.',
                    'Director mode walks through Setup, Script, Keyframes, and Videos.',
                    'If a workflow is missing models or nodes, use Re-check before you queue anything.',
                  ]}
                  actionLabel="Open Generate"
                  onAction={() => handleNavigate('generate')}
                />

                <TourCard
                  icon={ImageIcon}
                  title="Stock"
                  description="Search Pexels and import footage or stills directly into the current project."
                  helperLines={[
                    'Best used when you need quick placeholder footage, inspiration, or background plates.',
                    'Requires a Pexels API key in Settings.',
                  ]}
                  actionLabel="Open Stock"
                  onAction={() => handleNavigate('stock')}
                />

                <TourCard
                  icon={Download}
                  title="Export"
                  description="Render the current timeline to a deliverable file and manage the export queue."
                  helperLines={[
                    'Choose format, codec, render range, resolution, FPS, and audio settings.',
                    'Queue multiple exports if you want a few output variants.',
                  ]}
                  actionLabel="Open Export"
                  onAction={() => handleNavigate('export')}
                />

                <TourCard
                  icon={Settings}
                  title="Settings"
                  description="Return here whenever the machine-specific setup changes."
                  helperLines={[
                    'Projects folder, ComfyUI port, Comfy account API key, Pexels key, and new-project defaults all live here.',
                    'If something works on one machine and not another, this is the first place to compare.',
                  ]}
                  actionLabel="Open Settings"
                  onAction={() => handleOpenSettings('connection')}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-sf-dark-700 px-5 py-4">
          <div className="text-xs text-sf-text-muted">
            Keep the in-app guide short. Save the deep “how to edit” and “how to prompt” teaching for videos.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-sf-dark-800 px-4 py-2 text-sm text-sf-text-secondary transition-colors hover:bg-sf-dark-700"
            >
              Close
            </button>
          </div>
        </div>
      </div>
      <ApiKeyDialog
        open={apiKeyDialogOpen}
        onClose={() => setApiKeyDialogOpen(false)}
        onSaved={(value) => setPartnerKeyConfigured(Boolean(String(value || '').trim()))}
      />
    </div>
  )
}
