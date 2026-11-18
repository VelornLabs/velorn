import { lazy, Suspense, useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import NetworkPanel from './NetworkPanel'
import GpuShareReview from './GpuShareReview'

// The GPU sharing tab. It opens on "Use": the shared workflows as cards over
// the same box the Create tab has (CreateWorkspace in its shared mode). "Share
// my GPU" is the owner's side, one press away: this computer's own sharing
// choices, the owner's own workflows and, for a reviewer, the review list.
const CreateWorkspace = lazy(() => import('./CreateWorkspace'))
const button = 'flex-none rounded-md border border-sf-dark-600 bg-sf-dark-800 px-2.5 py-1.5 text-xs text-sf-text-primary hover:bg-sf-dark-700 transition-colors inline-flex items-center gap-1.5'

export default function GpuSharingWorkspace({ openShare = 0 }) {
  const [view, setView] = useState('use') // 'use' | 'share'
  // Another part of the window (the dot on the account button) asks for the owner's side.
  useEffect(() => { if (openShare > 0) setView('share') }, [openShare])
  // Whether the service counts this account as a reviewer; only then is the review list drawn.
  const [reviewer, setReviewer] = useState(false)
  useEffect(() => { let on = true; window.electronAPI?.gpuShare?.own?.list?.().then(listed => { if (on) setReviewer(listed?.success === true && listed.reviewer === true) }, () => {}); return () => { on = false } }, [view])

  return <div className="flex-1 min-h-0 flex flex-col bg-sf-dark-950 text-sf-text-primary" data-testid="gpu-sharing" data-view={view}>
    {/* Kept mounted while the owner's side is shown, so a job that is being made is not lost from the screen. */}
    <div className="flex-1 min-h-0 flex-col" style={{ display: view === 'use' ? 'flex' : 'none' }}>
      <Suspense fallback={null}><CreateWorkspace mode="shared" onShare={() => setView('share')} /></Suspense>
    </div>
    {view === 'share' && <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-6 flex flex-col gap-5">
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">Share my GPU</h2>
            <p className="text-sm text-sf-text-secondary max-w-2xl">Lend your graphics card to other Velorn creators when you are not using it. It costs nothing, and you choose what runs and who may use it.</p>
          </div>
          <button type="button" className={button} onClick={() => setView('use')}><ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />Back to shared GPUs</button>
        </header>
        <div className={`grid gap-5 items-start ${reviewer ? 'lg:grid-cols-2' : ''}`}>
          <section className="flex flex-col gap-3 min-w-0" aria-label="Share your GPU"><NetworkPanel /></section>
          {reviewer && <section className="flex flex-col gap-3 min-w-0" aria-label="Review"><GpuShareReview /></section>}
        </div>
      </div>
    </div>}
  </div>
}
