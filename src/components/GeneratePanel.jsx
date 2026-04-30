import { Sparkles, RefreshCw, Upload, Wand2, Settings, Video, Music, Mic, Volume2, Clock, X, Loader2, Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import useComfyUI from '../hooks/useComfyUI'
import useAssetsStore from '../stores/assetsStore'
import useProjectStore from '../stores/projectStore'
import { comfyui } from '../services/comfyui'
import { importAsset } from '../services/fileSystem'
import { getVideoDurationPresets } from '../config/generateWorkspaceConfig'

// Cinematography categories and options for filmmakers
const SHOT_CATEGORIES = {
  'Shot': [
    'Extreme close-up', 'Close-up', 'Medium close-up', 'Medium shot', 
    'Medium wide', 'Wide shot', 'Extreme wide', 'Over-the-shoulder', 
    'POV', 'Two-shot', 'Insert shot'
  ],
  'Movement': [
    'Static', 'Pan', 'Tilt', 'Dolly in', 'Dolly out', 'Push in', 'Pull out',
    'Tracking shot', 'Crane shot', 'Steadicam', 'Handheld', 'Drone', 
    'Aerial', 'Orbit', 'Whip pan'
  ],
  'Angle': [
    'Eye level', 'Low angle', 'High angle', 'Bird\'s eye', 
    'Overhead', 'Worm\'s eye', 'Dutch angle'
  ],
  'Lighting': [
    'Natural light', 'Golden hour', 'Blue hour', 'High key', 'Low key',
    'Dramatic lighting', 'Cinematic lighting', 'Soft lighting', 'Hard lighting',
    'Backlit', 'Silhouette', 'Rim lighting', 'Neon', 'Candlelit', 'Moonlit'
  ],
  'Mood': [
    'Cinematic', 'Dramatic', 'Epic', 'Intimate', 'Mysterious', 
    'Tense', 'Suspenseful', 'Romantic', 'Melancholic', 'Energetic', 
    'Serene', 'Ethereal', 'Dark'
  ],
  'Style': [
    'Film noir', 'Documentary', 'Commercial', 'Music video', 'Blockbuster',
    'Indie film', 'Vintage', 'Retro', 'Sci-fi', 'Fantasy', 'Horror', 'Western'
  ],
  'Color': [
    'Desaturated', 'High contrast', 'Warm tones', 'Cool tones', 
    'Teal and orange', 'Black and white', 'Vibrant', 'Muted', 'Neon colors'
  ],
  'Speed': [
    'Slow motion', 'Real-time', 'Fast motion', 'Time-lapse', 'Hyperlapse'
  ],
  'Depth': [
    'Shallow DOF', 'Bokeh', 'Deep focus', 'Rack focus'
  ],
  'Lens': [
    'Anamorphic', 'Wide angle', 'Telephoto', 'Fisheye', 'Macro', '35mm film look'
  ]
}

const CATEGORY_ORDER = ['Shot', 'Movement', 'Angle', 'Lighting', 'Mood', 'Style', 'Color', 'Speed', 'Depth', 'Lens']

function CinematographyTags({ onAddTag, selectedTags, onRemoveTag }) {
  const [activeCategory, setActiveCategory] = useState('Shot')
  const tabsRef = useRef(null)
  
  const scrollTabs = (direction) => {
    if (tabsRef.current) {
      tabsRef.current.scrollBy({ left: direction * 100, behavior: 'smooth' })
    }
  }
  
  return (
    <div className="space-y-2">
      {/* Category Tabs */}
      <div className="relative flex items-center">
        <button 
          onClick={() => scrollTabs(-1)}
          className="absolute left-0 z-10 p-0.5 bg-sf-dark-900/90 hover:bg-sf-dark-700 rounded text-sf-text-muted"
        >
          <ChevronLeft className="w-3 h-3" />
        </button>
        
        <div 
          ref={tabsRef}
          className="flex gap-1 overflow-x-auto scrollbar-hide mx-5 pb-1"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {CATEGORY_ORDER.map(category => (
            <button
              key={category}
              onClick={() => setActiveCategory(category)}
              className={`px-2 py-1 rounded text-[10px] font-medium whitespace-nowrap transition-colors ${
                activeCategory === category
                  ? 'bg-sf-accent text-white'
                  : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600 hover:text-sf-text-secondary'
              }`}
            >
              {category}
            </button>
          ))}
        </div>
        
        <button 
          onClick={() => scrollTabs(1)}
          className="absolute right-0 z-10 p-0.5 bg-sf-dark-900/90 hover:bg-sf-dark-700 rounded text-sf-text-muted"
        >
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
      
      {/* Pills for active category */}
      <div className="bg-sf-dark-800/50 rounded-lg p-2">
        <div className="text-[9px] text-sf-text-muted mb-1.5 uppercase tracking-wider">{activeCategory} options</div>
        <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
          {SHOT_CATEGORIES[activeCategory].map(tag => {
            const isSelected = selectedTags.includes(tag)
            return (
              <button
                key={tag}
                onClick={() => isSelected ? onRemoveTag(tag) : onAddTag(tag)}
                className={`px-2 py-1 rounded text-[10px] transition-colors ${
                  isSelected
                    ? 'bg-sf-accent text-white'
                    : 'bg-sf-dark-700 hover:bg-sf-dark-600 text-sf-text-secondary'
                }`}
              >
                {isSelected ? '✓ ' : '+ '}{tag}
              </button>
            )
          })}
        </div>
      </div>
      
      {/* Selected tags summary */}
      {selectedTags.length > 0 && (
        <div className="pt-1 border-t border-sf-dark-700">
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-[9px] text-sf-text-muted">Selected:</span>
            {selectedTags.map(tag => (
              <span 
                key={tag}
                onClick={() => onRemoveTag(tag)}
                className="px-1.5 py-0.5 bg-sf-accent/20 text-sf-accent rounded text-[9px] cursor-pointer hover:bg-sf-accent/30 transition-colors"
              >
                {tag} ×
              </span>
            ))}
            <button 
              onClick={() => selectedTags.forEach(onRemoveTag)}
              className="text-[9px] text-sf-text-muted hover:text-sf-error ml-1"
            >
              Clear all
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function GeneratePanel() {
  // Sub-tab state
  const [activeSubTab, setActiveSubTab] = useState('video') // 'video' or 'audio'
  
  // ComfyUI hook
  const { 
    isConnected, 
    isGenerating, 
    progress, 
    error, 
    queueCount,
    generationResult,
    generateVideo,
    getResult,
    cancel,
    clearResult,
    wsConnected,
    currentNode
  } = useComfyUI()

  // Assets store
  const { addAsset, generateName } = useAssetsStore()
  
  // Track if we just completed a generation (for success message)
  const [justCompleted, setJustCompleted] = useState(false)

  // Video generation state
  const [prompt, setPrompt] = useState('A cinematic wide shot of a runner on a mountain trail at sunrise, epic lighting, slow motion')
  const [negativePrompt, setNegativePrompt] = useState('blurry, low quality, still frame, frames, watermark, overlay, titles')
  const [selectedWorkflow, setSelectedWorkflow] = useState('wan22-i2v')
  const [seed, setSeed] = useState(Math.floor(Math.random() * 1000000))
  const [duration, setDuration] = useState(5) // seconds
  const [resolution, setResolution] = useState({ width: 1280, height: 720 })
  const [fps, setFps] = useState(24)
  const [generateWithAudio, setGenerateWithAudio] = useState(false)
  const [selectedShotTags, setSelectedShotTags] = useState([]) // Cinematography tags

  // Audio generation state
  const [audioType, setAudioType] = useState('music')
  const [audioPrompt, setAudioPrompt] = useState('')
  const [audioDuration, setAudioDuration] = useState(30)
  const [voiceSettings, setVoiceSettings] = useState({
    voice: 'narrator-male',
    speed: 1.0,
    script: ''
  })
  const [musicSettings, setMusicSettings] = useState({
    genre: 'cinematic',
    mood: 'epic',
    tempo: 'medium'
  })

  const workflows = [
    { id: 'wan22-i2v', name: 'WAN 2.2 Image to Video', description: 'High quality image-to-video generation' },
  ]
  const durationPresets = getVideoDurationPresets(selectedWorkflow)

  const resolutions = [
    { label: '1920 x 1080 (Full HD)', width: 1920, height: 1080 },
    { label: '1280 x 720 (HD)', width: 1280, height: 720 },
    { label: '1024 x 576 (16:9)', width: 1024, height: 576 },
    { label: '768 x 512 (3:2)', width: 768, height: 512 },
    { label: '640 x 480 (4:3)', width: 640, height: 480 },
  ]

  const voices = [
    { id: 'narrator-male', name: 'Narrator (Male)', desc: 'Deep, authoritative' },
    { id: 'narrator-female', name: 'Narrator (Female)', desc: 'Warm, professional' },
    { id: 'commercial-male', name: 'Commercial (Male)', desc: 'Energetic, friendly' },
    { id: 'commercial-female', name: 'Commercial (Female)', desc: 'Bright, engaging' },
    { id: 'documentary', name: 'Documentary', desc: 'Calm, informative' },
  ]

  const genres = ['cinematic', 'electronic', 'orchestral', 'ambient', 'rock', 'jazz', 'corporate']
  const moods = ['epic', 'tense', 'uplifting', 'melancholic', 'energetic', 'calm', 'mysterious']
  const tempos = ['slow', 'medium', 'fast']

  // Calculate frames from duration
  const getFrameCount = () => {
    return Math.round(duration * fps) + 1
  }

  // Get project handle for saving videos locally
  const { currentProjectHandle } = useProjectStore()
  
  // State for saving progress
  const [isSavingToProject, setIsSavingToProject] = useState(false)

  // When generation completes, download and save to project assets folder
  useEffect(() => {
    if (generationResult) {
      console.log('GeneratePanel received result:', generationResult);
      
      const saveVideoToProject = async () => {
        // Generate auto-name from prompt
        const autoName = generateName(prompt)
        
        try {
          // If we have a project, download and save the video locally
          if (currentProjectHandle && generationResult.filename) {
            setIsSavingToProject(true)
            console.log('Downloading and saving video to project...')
            
            // Download the video from ComfyUI
            const videoFile = await comfyui.downloadVideo(
              generationResult.filename,
              generationResult.subfolder || 'video',
              'output'
            )
            
            // Import it to the project's assets folder
            const assetInfo = await importAsset(currentProjectHandle, videoFile, 'video')
            
            // Create blob URL for immediate playback
            const blobUrl = URL.createObjectURL(videoFile)
            
            // Add to assets store with local path (not ComfyUI URL)
            addAsset({
              ...assetInfo,
              name: autoName,
              type: 'video',
              url: blobUrl, // Local blob URL for playback
              prompt: prompt,
              negativePrompt: negativePrompt,
              isImported: true, // Mark as imported so it persists
              settings: {
                resolution: `${resolution.width}x${resolution.height}`,
                duration: duration,
                fps: fps,
                seed: seed,
                workflow: selectedWorkflow
              }
            })
            
            console.log('Video saved to project assets folder:', assetInfo.path)
            setIsSavingToProject(false)
          } else {
            // No project open, just use the ComfyUI URL (won't persist)
            console.warn('No project open - video will not persist across sessions')
            addAsset({
              name: autoName,
              type: 'video',
              url: generationResult.url,
              filename: generationResult.filename,
              subfolder: generationResult.subfolder,
              prompt: prompt,
              negativePrompt: negativePrompt,
              settings: {
                resolution: `${resolution.width}x${resolution.height}`,
                duration: duration,
                fps: fps,
                seed: seed,
                workflow: selectedWorkflow
              }
            })
          }
        } catch (err) {
          console.error('Error saving video to project:', err)
          setIsSavingToProject(false)
          
          // Fallback to ComfyUI URL if save fails
          addAsset({
            name: autoName,
            type: 'video',
            url: generationResult.url,
            filename: generationResult.filename,
            subfolder: generationResult.subfolder,
            prompt: prompt,
            negativePrompt: negativePrompt,
            settings: {
              resolution: `${resolution.width}x${resolution.height}`,
              duration: duration,
              fps: fps,
              seed: seed,
              workflow: selectedWorkflow
            }
          })
        }
        
        // Show success message briefly
        setJustCompleted(true)
        setTimeout(() => setJustCompleted(false), 3000)
        
        // Clear the result from the hook (we've saved it to assets)
        clearResult()
      }
      
      saveVideoToProject()
    }
  }, [generationResult]);

  // Handle video generation
  const handleGenerateVideo = async () => {
    await generateVideo({
      prompt,
      negativePrompt,
      width: resolution.width,
      height: resolution.height,
      frames: getFrameCount(),
      seed,
      fps
    })
    // Result will automatically be available via generationResult from the hook
  }

  const randomizeSeed = () => {
    setSeed(Math.floor(Math.random() * 1000000))
  }

  const audioTypes = [
    { id: 'music', label: 'Music', icon: Music },
    { id: 'voiceover', label: 'Voiceover', icon: Mic },
    { id: 'sfx', label: 'SFX', icon: Volume2 },
  ]

  return (
    <div className="h-full flex flex-col">
      {/* Sub-tabs */}
      <div className="flex border-b border-sf-dark-700 px-2">
        <button
          onClick={() => setActiveSubTab('video')}
          className={`flex items-center gap-1.5 px-3 py-2 border-b-2 transition-colors ${
            activeSubTab === 'video'
              ? 'border-sf-accent text-sf-text-primary'
              : 'border-transparent text-sf-text-muted hover:text-sf-text-secondary'
          }`}
        >
          <Video className="w-4 h-4" />
          <span className="text-xs font-medium">Video</span>
        </button>
        <button
          onClick={() => setActiveSubTab('audio')}
          className={`flex items-center gap-1.5 px-3 py-2 border-b-2 transition-colors ${
            activeSubTab === 'audio'
              ? 'border-sf-accent text-sf-text-primary'
              : 'border-transparent text-sf-text-muted hover:text-sf-text-secondary'
          }`}
        >
          <Music className="w-4 h-4" />
          <span className="text-xs font-medium">Audio</span>
        </button>
      </div>

      {/* Content - Vertical Layout for Left Panel */}
      <div className="flex-1 overflow-y-auto">
        {activeSubTab === 'video' ? (
          /* VIDEO GENERATION - Vertical Layout */
          <div className="p-3 space-y-4">
            {/* Prompt Section */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-sf-text-primary">Prompt</label>
                <button className="text-[10px] text-sf-accent hover:text-sf-accent-hover transition-colors">
                  Load from shot
                </button>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="w-full h-20 bg-sf-dark-800 border border-sf-dark-600 rounded-lg p-2 text-xs text-sf-text-primary placeholder-sf-text-muted resize-none focus:outline-none focus:border-sf-accent transition-colors"
                placeholder="Describe your video..."
              />
              
              {/* Cinematography Tags */}
              <div className="mt-2">
                <CinematographyTags 
                  selectedTags={selectedShotTags}
                  onAddTag={(tag) => {
                    setSelectedShotTags(prev => [...prev, tag])
                    setPrompt(prev => prev + ', ' + tag.toLowerCase())
                  }}
                  onRemoveTag={(tag) => {
                    setSelectedShotTags(prev => prev.filter(t => t !== tag))
                    setPrompt(prev => prev.replace(new RegExp(',?\\s*' + tag.toLowerCase(), 'gi'), ''))
                  }}
                />
              </div>
            </div>

            {/* Negative Prompt */}
            <div>
              <label className="text-xs font-medium text-sf-text-primary mb-1.5 block">Negative Prompt</label>
              <textarea
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                className="w-full h-12 bg-sf-dark-800 border border-sf-dark-600 rounded-lg p-2 text-[11px] text-sf-text-secondary placeholder-sf-text-muted resize-none focus:outline-none focus:border-sf-accent transition-colors"
                placeholder="What to avoid..."
              />
            </div>

            {/* Workflow */}
            <div>
              <label className="text-xs font-medium text-sf-text-primary mb-1.5 block">Workflow</label>
              <select
                value={selectedWorkflow}
                onChange={(e) => setSelectedWorkflow(e.target.value)}
                className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent transition-colors"
              >
                {workflows.map(wf => (
                  <option key={wf.id} value={wf.id}>{wf.name}</option>
                ))}
              </select>
            </div>

            {/* Settings Grid */}
            <div className="grid grid-cols-2 gap-3">
              {/* Duration */}
              <div>
                <div className="flex justify-between text-[10px] mb-1">
                  <span className="text-sf-text-secondary">Duration</span>
                  <span className="text-sf-text-muted">{duration}s</span>
                </div>
                <div className="flex gap-0.5">
                  {durationPresets.map(d => (
                    <button
                      key={d}
                      onClick={() => setDuration(d)}
                      className={`flex-1 py-1 rounded text-[10px] transition-colors ${
                        duration === d ? 'bg-sf-accent text-white' : 'bg-sf-dark-700 text-sf-text-muted'
                      }`}
                    >
                      {d}s
                    </button>
                  ))}
                </div>
              </div>

              {/* Resolution */}
              <div>
                <label className="text-[10px] text-sf-text-secondary mb-1 block">Resolution</label>
                <select 
                  value={`${resolution.width}x${resolution.height}`}
                  onChange={(e) => {
                    const [w, h] = e.target.value.split('x').map(Number)
                    setResolution({ width: w, height: h })
                  }}
                  className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
                >
                  {resolutions.map(r => (
                    <option key={r.label} value={`${r.width}x${r.height}`}>{r.width}x{r.height}</option>
                  ))}
                </select>
              </div>

              {/* FPS */}
              <div>
                <label className="text-[10px] text-sf-text-secondary mb-1 block">Frame Rate</label>
                <select 
                  value={fps}
                  onChange={(e) => setFps(parseInt(e.target.value))}
                  className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
                >
                  <option value={24}>24 fps</option>
                  <option value={30}>30 fps</option>
                </select>
              </div>

              {/* Seed */}
              <div>
                <label className="text-[10px] text-sf-text-secondary mb-1 block">Seed</label>
                <div className="flex gap-1">
                  <input
                    type="number"
                    value={seed}
                    onChange={(e) => setSeed(parseInt(e.target.value) || 0)}
                    className="flex-1 min-w-0 bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  />
                  <button 
                    onClick={randomizeSeed}
                    className="px-2 py-1 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-[10px] transition-colors"
                    title="Randomize"
                  >
                    🎲
                  </button>
                </div>
              </div>
            </div>

            {/* Generate with Audio Option */}
            <div className="flex items-center gap-2 p-2 bg-sf-dark-800 rounded-lg">
              <input
                type="checkbox"
                id="generateWithAudio"
                checked={generateWithAudio}
                onChange={(e) => setGenerateWithAudio(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-sf-dark-600 bg-sf-dark-700 text-sf-accent focus:ring-sf-accent focus:ring-offset-0 cursor-pointer"
              />
              <label htmlFor="generateWithAudio" className="text-[11px] text-sf-text-secondary cursor-pointer flex-1">
                Generate with audio
              </label>
              <Music className="w-3.5 h-3.5 text-sf-text-muted" />
            </div>

            {/* Progress bar when generating */}
            {isGenerating && (
              <div>
                <div className="flex justify-between text-[10px] text-sf-text-muted mb-1">
                  <span>
                    Generating...
                    {currentNode && <span className="text-sf-text-muted/60 ml-1">(node {currentNode})</span>}
                  </span>
                  <span>{progress.percent !== undefined ? progress.percent : Math.round((progress.value / progress.max) * 100)}%</span>
                </div>
                <div className="h-1.5 bg-sf-dark-700 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-sf-accent transition-all duration-300"
                    style={{ width: `${progress.percent !== undefined ? progress.percent : (progress.value / progress.max) * 100}%` }}
                  />
                </div>
                {!wsConnected && (
                  <p className="text-[9px] text-sf-text-muted/50 mt-1">
                    WebSocket not connected - progress may not update in real-time
                  </p>
                )}
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="p-2 bg-sf-error/20 border border-sf-error/50 rounded text-[10px] text-sf-error">
                {error}
              </div>
            )}

            {/* Saving to project notification */}
            {isSavingToProject && (
              <div className="p-2 bg-sf-blue/20 border border-sf-blue/50 rounded-lg flex items-center gap-2">
                <Loader2 className="w-4 h-4 text-sf-blue flex-shrink-0 animate-spin" />
                <div>
                  <p className="text-xs font-medium text-sf-text-primary">Saving to project...</p>
                  <p className="text-[10px] text-sf-text-muted">Downloading and storing video locally</p>
                </div>
              </div>
            )}

            {/* Success notification */}
            {justCompleted && !isSavingToProject && (
              <div className="p-2 bg-sf-success/20 border border-sf-success/50 rounded-lg flex items-center gap-2">
                <Check className="w-4 h-4 text-sf-success flex-shrink-0" />
                <div>
                  <p className="text-xs font-medium text-sf-text-primary">Video Generated!</p>
                  <p className="text-[10px] text-sf-text-muted">Saved to project assets folder</p>
                </div>
              </div>
            )}

            {/* Generate Actions */}
            <div className="space-y-2">
              <button
                onClick={isGenerating ? cancel : handleGenerateVideo}
                disabled={!isConnected}
                className={`w-full py-2.5 rounded-lg font-medium text-white flex items-center justify-center gap-2 transition-colors text-sm ${
                  isGenerating 
                    ? 'bg-sf-error hover:bg-red-600' 
                    : 'bg-sf-blue hover:bg-sf-blue-hover disabled:bg-sf-dark-600'
                }`}
              >
                {isGenerating ? (
                  <>
                    <X className="w-4 h-4" />
                    Cancel
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Generate Video
                  </>
                )}
              </button>
              
              <div className="flex gap-2">
                <button 
                  disabled={isGenerating}
                  className="flex-1 py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 disabled:opacity-50 rounded text-[11px] text-sf-text-secondary flex items-center justify-center gap-1.5 transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  Variations
                </button>
                
                <button 
                  disabled={isGenerating}
                  className="flex-1 py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 disabled:opacity-50 rounded text-[11px] text-sf-text-secondary flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Wand2 className="w-3 h-3" />
                  Enhance
                </button>
              </div>
            </div>

            {/* ComfyUI Status */}
            <div className="pt-3 border-t border-sf-dark-700">
              <div className="flex items-center gap-2 text-[10px]">
                <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-sf-success' : 'bg-sf-error'}`} />
                <span className="text-sf-text-muted">
                  {isConnected ? 'ComfyUI Connected' : 'ComfyUI Disconnected'}
                </span>
                {queueCount > 0 && (
                  <span className="ml-auto text-sf-text-muted">Queue: {queueCount}</span>
                )}
              </div>
            </div>
          </div>
        ) : activeSubTab === 'audio' ? (
          /* AUDIO GENERATION - Vertical Layout */
          <div className="p-3 space-y-4">
            {/* Audio Type Selector */}
            <div>
              <label className="text-[10px] text-sf-text-muted uppercase tracking-wider mb-1.5 block">Type</label>
              <div className="flex gap-1">
                {audioTypes.map((type) => {
                  const Icon = type.icon
                  return (
                    <button
                      key={type.id}
                      onClick={() => setAudioType(type.id)}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded transition-colors ${
                        audioType === type.id
                          ? 'bg-sf-accent text-white'
                          : 'bg-sf-dark-800 text-sf-text-secondary hover:bg-sf-dark-700'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span className="text-[11px] font-medium">{type.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Audio-specific Settings */}
            {audioType === 'music' && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-sf-text-primary mb-1.5 block">Describe the music</label>
                  <textarea
                    value={audioPrompt}
                    onChange={(e) => setAudioPrompt(e.target.value)}
                    placeholder="Epic orchestral music with dramatic percussion..."
                    className="w-full h-20 bg-sf-dark-800 border border-sf-dark-600 rounded-lg p-2 text-xs text-sf-text-primary placeholder-sf-text-muted resize-none focus:outline-none focus:border-sf-accent"
                  />
                </div>
                
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10px] text-sf-text-secondary mb-1">Genre</label>
                    <select 
                      value={musicSettings.genre}
                      onChange={(e) => setMusicSettings({ ...musicSettings, genre: e.target.value })}
                      className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent capitalize"
                    >
                      {genres.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-sf-text-secondary mb-1">Mood</label>
                    <select 
                      value={musicSettings.mood}
                      onChange={(e) => setMusicSettings({ ...musicSettings, mood: e.target.value })}
                      className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent capitalize"
                    >
                      {moods.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-sf-text-secondary mb-1">Tempo</label>
                    <select 
                      value={musicSettings.tempo}
                      onChange={(e) => setMusicSettings({ ...musicSettings, tempo: e.target.value })}
                      className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent capitalize"
                    >
                      {tempos.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>

                {/* Quick Presets */}
                <div>
                  <label className="text-[10px] text-sf-text-secondary mb-1.5 block">Presets</label>
                  <div className="flex flex-wrap gap-1">
                    {['Epic Trailer', 'Corporate', 'Emotional', 'Tense', 'Uplifting'].map(preset => (
                      <button
                        key={preset}
                        className="px-2 py-1 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-[10px] text-sf-text-secondary transition-colors"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {audioType === 'voiceover' && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-sf-text-primary mb-1.5 block">Script</label>
                  <textarea
                    value={voiceSettings.script}
                    onChange={(e) => setVoiceSettings({ ...voiceSettings, script: e.target.value })}
                    placeholder="Enter the text you want spoken..."
                    className="w-full h-24 bg-sf-dark-800 border border-sf-dark-600 rounded-lg p-2 text-xs text-sf-text-primary placeholder-sf-text-muted resize-none focus:outline-none focus:border-sf-accent"
                  />
                  <div className="flex justify-between mt-1">
                    <span className="text-[10px] text-sf-text-muted">{voiceSettings.script.length} chars</span>
                  </div>
                </div>
                
                <div>
                  <label className="block text-[10px] text-sf-text-secondary mb-1">Voice</label>
                  <select 
                    value={voiceSettings.voice}
                    onChange={(e) => setVoiceSettings({ ...voiceSettings, voice: e.target.value })}
                    className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  >
                    {voices.map(v => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[10px] text-sf-text-secondary mb-1">Speed: {voiceSettings.speed}x</label>
                  <input
                    type="range"
                    min="0.5"
                    max="2"
                    step="0.1"
                    value={voiceSettings.speed}
                    onChange={(e) => setVoiceSettings({ ...voiceSettings, speed: parseFloat(e.target.value) })}
                    className="w-full h-1.5 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                  />
                </div>
              </div>
            )}

            {audioType === 'sfx' && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-sf-text-primary mb-1.5 block">Describe the sound</label>
                  <textarea
                    value={audioPrompt}
                    onChange={(e) => setAudioPrompt(e.target.value)}
                    placeholder="Dramatic whoosh transition..."
                    className="w-full h-20 bg-sf-dark-800 border border-sf-dark-600 rounded-lg p-2 text-xs text-sf-text-primary placeholder-sf-text-muted resize-none focus:outline-none focus:border-sf-accent"
                  />
                </div>

                <div>
                  <label className="text-[10px] text-sf-text-secondary mb-1.5 block">Presets</label>
                  <div className="flex flex-wrap gap-1">
                    {['Whoosh', 'Impact', 'Footsteps', 'Ambient', 'Wind', 'Rain'].map(preset => (
                      <button
                        key={preset}
                        onClick={() => setAudioPrompt(preset.toLowerCase())}
                        className="px-2 py-1 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-[10px] text-sf-text-secondary transition-colors"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Duration */}
            <div>
              <div className="flex justify-between text-[10px] mb-1">
                <span className="text-sf-text-secondary">Duration</span>
                <span className="text-sf-text-muted">{audioDuration}s</span>
              </div>
              <div className="flex gap-0.5">
                {[15, 30, 60, 120].map(d => (
                  <button
                    key={d}
                    onClick={() => setAudioDuration(d)}
                    className={`flex-1 py-1 rounded text-[10px] transition-colors ${
                      audioDuration === d ? 'bg-sf-accent text-white' : 'bg-sf-dark-700 text-sf-text-muted'
                    }`}
                  >
                    {d}s
                  </button>
                ))}
              </div>
            </div>

            {/* Generate Actions */}
            <div className="space-y-2">
              <button
                disabled={!isConnected}
                className="w-full py-2.5 bg-sf-blue hover:bg-sf-blue-hover disabled:bg-sf-dark-600 rounded-lg font-medium text-white flex items-center justify-center gap-2 transition-colors text-sm"
              >
                <Sparkles className="w-4 h-4" />
                Generate {audioType === 'music' ? 'Music' : audioType === 'voiceover' ? 'Voice' : 'SFX'}
              </button>
              
              <button className="w-full py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-[11px] text-sf-text-secondary flex items-center justify-center gap-1.5 transition-colors">
                <RefreshCw className="w-3 h-3" />
                Variations
              </button>
            </div>

            {/* Audio Workflow Status */}
            <div className="pt-3 border-t border-sf-dark-700">
              <div className="flex items-center gap-2 text-[10px]">
                <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-sf-success' : 'bg-sf-error'}`} />
                <span className="text-sf-text-muted">
                  {isConnected ? 'Audio Ready' : 'Disconnected'}
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default GeneratePanel
