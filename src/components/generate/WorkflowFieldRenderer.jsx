import { useMemo } from 'react'
import { RefreshCw } from 'lucide-react'
import useAssetsStore from '../../stores/assetsStore'

const VIDEO_RESOLUTION_OPTIONS = [
  { label: '1080p', value: '1920x1080' },
  { label: '720p', value: '1280x720' },
  { label: '9:16', value: '1080x1920' },
  { label: 'UHD', value: '3840x2160', ltxOnly: true },
]

const IMAGE_RESOLUTION_OPTIONS = [
  { label: '1080p', value: '1920x1080' },
  { label: 'Square 1K', value: '1024x1024' },
  { label: 'Portrait', value: '1080x1920' },
]

const Z_IMAGE_TURBO_IMAGE_RESOLUTION_OPTIONS = [
  { label: '1080p', value: '1920x1080' },
  { label: 'Square 1K', value: '1024x1024' },
  { label: 'Square 2K', value: '2048x2048' },
  { label: 'Portrait', value: '1080x1920' },
]

function Segmented({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg border border-sf-dark-700 bg-sf-dark-800 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
            String(value) === String(option.value)
              ? 'bg-sf-accent text-white'
              : 'text-sf-text-muted hover:bg-sf-dark-700 hover:text-sf-text-primary'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export default function WorkflowFieldRenderer({ field, workflow, values, actions }) {
  const { assets, folders } = useAssetsStore()
  const folderById = useMemo(() => {
    const map = new Map()
    ;(folders || []).forEach((folder) => {
      if (folder?.id) map.set(folder.id, folder)
    })
    return map
  }, [folders])

  const getFolderPath = (folderId) => {
    const path = []
    let cursor = folderId || null
    const visited = new Set()
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor)
      const folder = folderById.get(cursor)
      if (!folder) break
      path.unshift(folder.name)
      cursor = folder.parentId || null
    }
    return path.join(' / ')
  }

  if (!field) return null

  const label = field.label || field.id
  const commonLabel = (
    <label className="text-[10px] font-medium uppercase tracking-wider text-sf-text-muted">
      {label}
    </label>
  )

  if (field.type === 'asset') {
    const selectedAsset = values.selectedAsset
    return (
      <div className="space-y-1.5">
        {commonLabel}
        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/70 p-3">
          {selectedAsset ? (
            <div className="flex items-center gap-3">
              <div className="h-14 w-20 overflow-hidden rounded bg-sf-dark-900">
                {selectedAsset.type === 'video' ? (
                  <video src={selectedAsset.url} className="h-full w-full object-cover" muted />
                ) : selectedAsset.type === 'image' ? (
                  <img src={selectedAsset.url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[10px] text-sf-text-muted">Audio</div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-sf-text-primary">{selectedAsset.name}</div>
                <div className="text-[10px] text-sf-text-muted">Selected from Assets</div>
              </div>
              <button
                type="button"
                onClick={() => actions.onSelectAsset?.(null)}
                className="rounded border border-sf-dark-600 px-2 py-1 text-[10px] text-sf-text-muted hover:text-sf-text-primary"
              >
                Clear
              </button>
            </div>
          ) : (
            <div className="text-xs text-sf-text-muted">
              Pick {field.assetType || 'media'} from the left asset browser.
            </div>
          )}
        </div>
      </div>
    )
  }

  if (field.type === 'assetSelect') {
    const compatibleAssets = assets.filter((asset) => asset?.type === field.assetType)
    const selectedAsset = values[field.id] || null
    const selectedId = selectedAsset?.id || ''
    return (
      <div className="space-y-1.5">
        {commonLabel}
        <div className="rounded-lg border border-sf-dark-700 bg-sf-dark-800/70 p-3">
          <select
            value={selectedId}
            onChange={(event) => {
              const nextAsset = compatibleAssets.find((asset) => asset.id === event.target.value) || null
              actions.onSelectAssetField?.(field.id, nextAsset)
            }}
            className="w-full rounded-lg border border-sf-dark-700 bg-sf-dark-900 px-3 py-2 text-xs text-sf-text-primary outline-none transition-colors focus:border-sf-accent"
          >
            <option value="">Select {field.assetType || 'asset'}...</option>
            {compatibleAssets.map((asset) => {
              const folderPath = getFolderPath(asset.folderId || null)
              return (
                <option key={asset.id} value={asset.id}>
                  {folderPath ? `${folderPath} / ${asset.name}` : asset.name}
                </option>
              )
            })}
          </select>
          {selectedAsset ? (
            <div className="mt-2 text-[10px] text-sf-text-muted">
              Selected <span className="text-sf-text-secondary">{selectedAsset.name}</span>
            </div>
          ) : (
            <div className="mt-2 text-[10px] text-sf-text-muted">
              {compatibleAssets.length > 0
                ? `Pick ${field.assetType || 'media'} from your project assets.`
                : `Import ${field.assetType || 'media'} in Assets first.`}
            </div>
          )}
          {field.helper && (
            <p className="mt-2 text-[10px] leading-snug text-sf-text-muted">{field.helper}</p>
          )}
        </div>
      </div>
    )
  }

  if (field.type === 'textarea') {
    const stateKey = field.id === 'musicTags' ? 'musicTags' : field.id === 'lyrics' ? 'lyrics' : 'prompt'
    return (
      <div className="space-y-1.5">
        {commonLabel}
        <textarea
          value={values[stateKey] || ''}
          onChange={(event) => actions.setValue(stateKey, event.target.value)}
          rows={field.rows || 3}
          placeholder={field.placeholder || (stateKey === 'prompt' ? 'Describe what you want to generate...' : '')}
          className="w-full resize-y rounded-lg border border-sf-dark-700 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary outline-none transition-colors placeholder:text-sf-text-muted focus:border-sf-accent"
        />
      </div>
    )
  }

  if (field.type === 'duration') {
    const ltxDurationWorkflowIds = new Set(['ltx23-i2v', 'ltx23-ia2v', 'ltx23-t2v'])
    const seedanceDurationWorkflowIds = new Set(['seedance2-t2v', 'seedance2-flf2v', 'seedance2-r2v'])
    const durationOptions = ltxDurationWorkflowIds.has(workflow?.workflowId)
      ? [5, 8, 10, 15]
      : seedanceDurationWorkflowIds.has(workflow?.workflowId)
        ? [5, 7, 10]
        : [2, 3, 5, 8]
    const options = durationOptions.map((seconds) => ({
      label: `${seconds}s`,
      value: seconds,
    }))
    return (
      <div className="space-y-1.5">
        {commonLabel}
        <Segmented options={options} value={values.duration} onChange={(value) => actions.setValue('duration', Number(value))} />
      </div>
    )
  }

  if (field.type === 'musicDuration') {
    return (
      <div className="space-y-1.5">
        {commonLabel}
        <Segmented
          options={[15, 30, 60, 120].map((seconds) => ({ label: `${seconds}s`, value: seconds }))}
          value={values.musicDuration}
          onChange={(value) => actions.setValue('musicDuration', Number(value))}
        />
      </div>
    )
  }

  if (field.type === 'resolution') {
    const ltxResolutionWorkflowIds = new Set(['ltx23-i2v', 'ltx23-ia2v', 'ltx23-t2v'])
    const options = VIDEO_RESOLUTION_OPTIONS.filter((option) => !option.ltxOnly || ltxResolutionWorkflowIds.has(workflow?.workflowId))
    const value = `${values.resolution?.width || 1920}x${values.resolution?.height || 1080}`
    return (
      <div className="space-y-1.5">
        {commonLabel}
        <Segmented
          options={options}
          value={value}
          onChange={(next) => {
            const [width, height] = String(next).split('x').map(Number)
            actions.setValue('resolution', { width, height })
          }}
        />
      </div>
    )
  }

  if (field.type === 'imageResolution') {
    const imageResolutionOptions = String(workflow?.workflowId || '').trim() === 'z-image-turbo'
      ? Z_IMAGE_TURBO_IMAGE_RESOLUTION_OPTIONS
      : IMAGE_RESOLUTION_OPTIONS
    const value = `${values.imageResolution?.width || 1024}x${values.imageResolution?.height || 1024}`
    return (
      <div className="space-y-1.5">
        {commonLabel}
        <Segmented
          options={imageResolutionOptions}
          value={value}
          onChange={(next) => {
            const [width, height] = String(next).split('x').map(Number)
            actions.setValue('imageResolution', { width, height })
          }}
        />
      </div>
    )
  }

  if (field.type === 'fps') {
    return (
      <div className="space-y-1.5">
        {commonLabel}
        <Segmented
          options={[24, 30].map((fps) => ({ label: `${fps}`, value: fps }))}
          value={values.fps}
          onChange={(value) => actions.setValue('fps', Number(value))}
        />
      </div>
    )
  }

  if (field.type === 'interpolationMultiplier') {
    return (
      <div className="space-y-1.5">
        {commonLabel}
        <Segmented
          options={[2, 3, 4, 8].map((multiplier) => ({ label: `${multiplier}x`, value: multiplier }))}
          value={values.interpolationMultiplier || 4}
          onChange={(value) => actions.setValue('interpolationMultiplier', Number(value))}
        />
      </div>
    )
  }

  if (field.type === 'toggle') {
    const checked = Boolean(values[field.id])
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-sf-dark-700 bg-sf-dark-800/70 px-3 py-2">
          <div className="min-w-0">
            {commonLabel}
            {field.helper && (
              <p className="mt-1 text-[10px] leading-snug text-sf-text-muted">{field.helper}</p>
            )}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => actions.setValue(field.id, !checked)}
            className={`relative h-5 w-10 flex-shrink-0 rounded-full transition-colors ${checked ? 'bg-sf-accent' : 'bg-sf-dark-600'}`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[calc(100%-1.25rem)]' : 'left-0.5'}`}
              aria-hidden
            />
          </button>
        </div>
      </div>
    )
  }

  if (field.type === 'seed') {
    return (
      <div className="space-y-1.5">
        {commonLabel}
        <div className="flex gap-1">
          <input
            type="number"
            value={values.seed}
            onChange={(event) => actions.setValue('seed', Number(event.target.value))}
            className="min-w-0 flex-1 rounded-lg border border-sf-dark-700 bg-sf-dark-800 px-3 py-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent"
          />
          <button
            type="button"
            onClick={actions.randomizeSeed}
            className="rounded-lg border border-sf-dark-700 bg-sf-dark-800 px-2 text-sf-text-muted hover:text-sf-text-primary"
            title="Randomize seed"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    )
  }

  return null
}
