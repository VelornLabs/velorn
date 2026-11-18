import { useEffect, useState } from 'react'

const KEY = 'freeGpuMemoryAfterGeneration'
export default function GenerationMemorySetting() {
  const api = window.electronAPI
  const [enabled, setEnabled] = useState(false)
  const [ready, setReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    if (api?.getSetting && api?.setSetting) {
      Promise.resolve().then(() => api.getSetting(KEY)).then(value => {
        if (current) { setEnabled(value === true); setReady(true) }
      }).catch(() => { if (current) setError('Could not read the memory setting. Reopen Assistant settings to retry.') })
    }
    return () => { current = false }
  }, [api])
  async function change(value) {
    setSaving(true); setError('')
    try {
      const result = await api.setSetting(KEY, value)
      if (result?.success !== true) throw new Error('save failed')
      setEnabled(value)
    } catch { setError('Could not save the memory setting. Please try again.') }
    finally { setSaving(false) }
  }
  return <section className="ca-settings-section">
    <label><input type="checkbox" checked={enabled} disabled={!ready || saving} onChange={event => void change(event.target.checked)} /> Free GPU memory after generation</label>
    <p>Unload ComfyUI models and clear its cache after Velorn-managed generation when the queue stays empty briefly. The next generation may start more slowly. Does not unload your agent model or delete files. Saved on this device.</p>
    {error && <p role="alert">{error}</p>}
  </section>
}
