// MiniMax H3 running locally for a music video shot: the keyframe is the
// exact first frame and the shot's part of the song drives the lips.
//
// The whole song is uploaded once; the graph cuts out this shot's part
// (TrimAudioDuration) and locks it into the clip: the audio is encoded, frozen
// with a zero mask and joined to the video latent, so the model cannot change
// the song and only draws the picture around it. Giving the song as a guide
// instead let the model drift into invented sound.
//
// The video text must agree with the keyframe or the model cuts away from it
// after half a second. buildH3ShotPrompt() therefore starts from the words
// that made the keyframe. Tested 2026-11-11; see docs/DIRECTOR_DIRECTION.md.
//
// Two quality levels, named for people rather than for samplers:
//   best - 20 steps, the model as it comes
//   fast - 8 steps with the lightx2v turbo add-on; about twice as quick,
//          nearly the same picture, a little less fine texture
// Both need the same graphics memory; "fast" saves time only.

export const MINIMAX_H3_LOCAL_WORKFLOW_ID = 'minimax-h3-local-music'
export const MINIMAX_H3_QUALITY_LEVELS = Object.freeze([
  { id: 'best', label: 'Best', steps: 20, helper: 'For the final video. Slowest.' },
  { id: 'fast', label: 'Fast', steps: 8, helper: 'For trying a shot. About twice as quick.' },
])
export const MINIMAX_H3_FPS = 24

export function normalizeH3Quality(value) {
  return MINIMAX_H3_QUALITY_LEVELS.some((level) => level.id === value) ? value : 'best'
}

// H3 sizes must divide by 32. Round down so 720 becomes 704, never larger
// than what was asked for.
const snap32 = (value, fallback) => {
  const number = Math.floor(Number(value) / 32) * 32
  return Number.isFinite(number) && number >= 256 ? Math.min(number, 2048) : fallback
}

// Tall clips use the model's own tall size. At 704 x 1280 the Fast add-on
// broke up (a ghost close-up fading over the shot, smoke); at 768 x 1344 the
// same shot was clean on Fast, and Best was clean at both (tested 2026-11-11,
// one seed each). Wide stays at 1280 x 704, which has been clean throughout.
export const MINIMAX_H3_TALL_SIZE = Object.freeze({ width: 768, height: 1344 })
// A video starts on its keyframe, so it takes the keyframe's shape: tall
// picture, tall video; wide picture, wide video. The Wide / Tall setting only
// says what shape NEW pictures are made in, and used to decide the video too,
// which cropped a wide picture into a tall video (seen 2026-11-12).
// `picture` is the keyframe's real size; `asked` is what the setting gave.
export function h3SizeFromPicture(picture, asked = {}) {
  const pictureWidth = Number(picture?.width)
  const pictureHeight = Number(picture?.height)
  if (!(pictureWidth > 0 && pictureHeight > 0)) return { width: asked?.width, height: asked?.height }
  const askedWidth = Number(asked?.width) || 1280
  const askedHeight = Number(asked?.height) || 720
  const long = Math.max(askedWidth, askedHeight)
  const short = Math.min(askedWidth, askedHeight)
  return pictureHeight > pictureWidth ? { width: short, height: long } : { width: long, height: short }
}

// How many pictures are wide and how many tall, for the "mixed shapes" note.
export function countPictureShapes(sizes) {
  let wide = 0
  let tall = 0
  for (const size of Array.isArray(sizes) ? sizes : []) {
    const width = Number(size?.width)
    const height = Number(size?.height)
    if (!(width > 0 && height > 0)) continue
    if (height > width) tall += 1; else wide += 1
  }
  return { wide, tall, mixed: wide > 0 && tall > 0 }
}

export function h3ClipSize(width, height) {
  const w = Number(width) || 1280
  const h = Number(height) || 720
  if (h > w) return { ...MINIMAX_H3_TALL_SIZE }
  return { width: snap32(w, 1280), height: snap32(h, 704) }
}

// H3 clip lengths sit on a grid of 17k + 5 frames at 24 fps (5, 22, 39, ...).
// Round up so the clip never ends before the shot does.
export function h3FrameCount(seconds) {
  const wanted = Math.max(5, Math.round((Number(seconds) || 5) * MINIMAX_H3_FPS))
  return 5 + Math.ceil((wanted - 5) / 17) * 17
}

// Words about framing and lenses. The picture model often ignores them (a
// "medium shot" comes out wide), and repeating them to the video model makes
// it cut to that framing.
const FRAMING_WORDS = /composition|\bshot\b|framing|close-?up|\blens\b|\bwide\b|\bmedium\b|\d\s*mm\b/i
const FIXED_OPENING = 'Animate the first-frame image.'
const FIXED_HOLD = 'Keep the same framing, character, clothes, objects and place as the first frame for the whole shot.'
const FIXED_CLOSING = 'One continuous shot, no cuts, no close-up, no text, no new characters or objects.'

// The scene part of a keyframe prompt: what is in the picture and where,
// without camera, framing or rendering instructions.
export function h3SceneWords(keyframePrompt) {
  const scene = String(keyframePrompt || '').split(/Camera setup:|Camera framing:|Camera treatment:|Render one |Keep the same place as /i)[0]
  return scene
    .split(/[;,.]/)
    .map((clause) => clause.replace(/\s+/g, ' ').trim())
    .filter((clause) => clause && !FRAMING_WORDS.test(clause))
    .join(', ')
}

// The script's action for the shot, without lens words.
export function h3MotionWords(motionPrompt) {
  return String(motionPrompt || '')
    .replace(/,?\s*\d+\s*mm(\s+lens)?/gi, '')
    .replace(/\battached vocals\b/gi, 'supplied vocals')
    .replace(/\s+/g, ' ')
    .replace(/\.(\s*\.)+/g, '.')
    .replace(/\s+([.,])/g, '$1')
    .trim()
}

export function buildH3ShotPrompt({ keyframePrompt = '', motionPrompt = '' } = {}) {
  const scene = h3SceneWords(keyframePrompt)
  const motion = h3MotionWords(motionPrompt)
  return [
    FIXED_OPENING,
    scene ? `The first frame shows: ${scene}.` : '',
    FIXED_HOLD,
    motion && !/[.!?"]$/.test(motion) ? `${motion}.` : motion,
    FIXED_CLOSING,
  ].filter(Boolean).join(' ')
}

export function modifyMinimaxH3LocalWorkflow(workflow, options = {}) {
  const {
    prompt = '',
    keyframePrompt = '',
    inputImage = '',
    inputAudio = '',
    audioStart = 0,
    duration = 5,
    width = 1280,
    height = 720,
    seed = Math.floor(Math.random() * 1000000000000),
    quality = 'best',
    filenamePrefix = '',
  } = options
  const graph = JSON.parse(JSON.stringify(workflow))
  const level = MINIMAX_H3_QUALITY_LEVELS.find((entry) => entry.id === normalizeH3Quality(quality))
  const seconds = Math.max(0.25, Number(duration) || 5)
  const frames = h3FrameCount(seconds)

  graph['5'].inputs.image = inputImage
  graph['7'].inputs.prompt = buildH3ShotPrompt({ keyframePrompt, motionPrompt: prompt })
  const size = h3ClipSize(width, height)
  graph['7'].inputs.width = size.width
  graph['7'].inputs.height = size.height
  graph['7'].inputs.length = frames
  graph['13'].inputs.noise_seed = Math.abs(Math.floor(Number(seed) || 0))
  graph['11'].inputs.steps = level.steps
  if (filenamePrefix) graph['18'].inputs.filename_prefix = filenamePrefix

  // The model, with or without the fast add-on.
  const model = level.id === 'fast' ? ['1b', 0] : ['1', 0]
  if (level.id !== 'fast') delete graph['1b']
  graph['10'].inputs.model = model
  graph['11'].inputs.model = model

  if (inputAudio) {
    graph['6'].inputs.audio = inputAudio
    graph['6b'].inputs.start_index = Math.max(0, Number(audioStart) || 0)
    // Cover the whole clip, which may run a few frames past the shot.
    graph['6b'].inputs.duration = Math.round((frames / MINIMAX_H3_FPS) * 1000) / 1000
    // The song is locked: nodes 8-8d put the real audio into the clip and
    // freeze it, so the model only draws the picture around it. The saved
    // clip carries that same audio.
    delete graph['16']
  } else {
    // No song: plain picture-to-video, and the model makes its own sound.
    for (const id of ['6', '6b', '8', '8b', '8c', '8d']) delete graph[id]
    graph['14'].inputs.latent_image = ['7', 1]
    graph['17'].inputs.audio = ['16', 0]
  }
  return graph
}
