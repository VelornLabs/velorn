import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildH3ShotPrompt, h3ClipSize, h3FrameCount, h3MotionWords, h3SceneWords, modifyMinimaxH3LocalWorkflow, normalizeH3Quality, countPictureShapes, h3SizeFromPicture } from '../src/services/minimaxH3LocalWorkflow.mjs'

const base = JSON.parse(fs.readFileSync(new URL('../public/workflows/video_minimax_h3_local_music_shot.json', import.meta.url), 'utf8'))

test('clip lengths land on the model grid and never fall short of the shot', () => {
  assert.equal(h3FrameCount(5), 124)
  assert.equal(h3FrameCount(6), 158)
  assert.equal(h3FrameCount(1.5), 39)
  assert.equal(h3FrameCount(0), 124)
  for (const seconds of [1.5, 3, 4.2, 6, 10, 15]) {
    const frames = h3FrameCount(seconds)
    assert.equal((frames - 5) % 17, 0)
    assert.ok(frames >= Math.round(seconds * 24))
  }
})

test('Best is the model as it comes, at 20 steps', () => {
  const graph = modifyMinimaxH3LocalWorkflow(base, { prompt: ' He sings ', inputImage: 'k.png', inputAudio: 'song.mp3', audioStart: 6, duration: 6, width: 1280, height: 720, seed: 9, filenamePrefix: 'video/x' })
  assert.equal(graph['1b'], undefined)
  assert.deepEqual(graph['10'].inputs.model, ['1', 0])
  assert.equal(graph['11'].inputs.steps, 20)
  assert.match(graph['7'].inputs.prompt, /^Animate the first-frame image\. Keep the same framing.* He sings\. One continuous shot, no cuts/)
  assert.deepEqual([graph['7'].inputs.width, graph['7'].inputs.height, graph['7'].inputs.length], [1280, 704, 158])
  assert.equal(graph['5'].inputs.image, 'k.png')
  assert.equal(graph['6'].inputs.audio, 'song.mp3')
  assert.equal(graph['6b'].inputs.start_index, 6)
  assert.equal(graph['6b'].inputs.duration, 6.583)
  assert.deepEqual(graph['10'].inputs.conditioning, ['7', 0])
  assert.equal(graph['13'].inputs.noise_seed, 9)
  assert.equal(graph['18'].inputs.filename_prefix, 'video/x')
  assert.equal(base['7'].inputs.prompt, '')
})

test('Fast adds the 8-step add-on to the model', () => {
  const graph = modifyMinimaxH3LocalWorkflow(base, { inputImage: 'k.png', inputAudio: 's.mp3', quality: 'fast' })
  assert.equal(graph['1b'].class_type, 'LoraLoaderModelOnly')
  assert.deepEqual(graph['10'].inputs.model, ['1b', 0])
  assert.deepEqual(graph['11'].inputs.model, ['1b', 0])
  assert.equal(graph['11'].inputs.steps, 8)
  assert.equal(normalizeH3Quality('nonsense'), 'best')
})

test('without a song it is plain picture-to-video', () => {
  const graph = modifyMinimaxH3LocalWorkflow(base, { inputImage: 'k.png' })
  for (const id of ['6', '6b', '8', '8b', '8c', '8d']) assert.equal(graph[id], undefined)
  assert.deepEqual(graph['14'].inputs.latent_image, ['7', 1])
  assert.deepEqual(graph['17'].inputs.audio, ['16', 0])
  assert.equal(graph['16'].class_type, 'VAEDecodeAudio')
})

test('the finished clip carries the real song, not the sound the model made', () => {
  const base = JSON.parse(fs.readFileSync(new URL('../public/workflows/video_minimax_h3_local_music_shot.json', import.meta.url), 'utf8'))
  const withSong = modifyMinimaxH3LocalWorkflow(base, { inputImage: 'a.png', inputAudio: 'song.mp3', audioStart: 4.2, duration: 5 })
  assert.deepEqual(withSong['17'].inputs.audio, ['6b', 0])
  assert.equal(withSong['16'], undefined)
  const noSong = modifyMinimaxH3LocalWorkflow(base, { inputImage: 'a.png', duration: 5 })
  assert.deepEqual(noSong['17'].inputs.audio, ['16', 0])
})

test('the song is locked into the clip so the model cannot change it', () => {
  const graph = modifyMinimaxH3LocalWorkflow(base, { inputImage: 'k.png', inputAudio: 'song.mp3', audioStart: 8.99, duration: 6.98 })
  assert.equal(graph['8'].class_type, 'VAEEncodeAudio')
  assert.deepEqual(graph['8'].inputs.audio, ['6b', 0])
  assert.equal(graph['8b'].inputs.value, 0)
  assert.deepEqual(graph['8c'].inputs, { samples: ['8', 0], mask: ['8b', 0] })
  assert.deepEqual(graph['8d'].inputs, { video_latent: ['7', 1], audio_latent: ['8c', 0] })
  assert.deepEqual(graph['14'].inputs.latent_image, ['8d', 0])
  assert.deepEqual(graph['7'].inputs.first_frame, ['5', 0])
  assert.equal(Object.values(graph).some((node) => node.class_type === 'MiniMaxH3AddGuide'), false)
  assert.equal(graph['7'].inputs.length, 175)
  assert.equal(graph['6b'].inputs.duration, 7.292)
})

const KEYFRAME = 'Infinite white studio, Grinch in black suit beside a small potted cactus, green fur and pointed lapel; bright even light, white background with green accents, tidy medium composition, self-satisfied expression. Camera setup: Lateral slide, eye level, 50mm lens.. Artist visible with a readable face. Render one cinematic keyframe still, no collage.'
const MOTION = 'He sings, presenting the cactus before recoiling from its spines. Camera: Lateral slide, eye level, 50mm lens.. The artist performs, lip-syncing naturally to the attached vocals.'

test('the video text starts from the words that made the keyframe', () => {
  assert.equal(h3SceneWords(KEYFRAME), 'Infinite white studio, Grinch in black suit beside a small potted cactus, green fur and pointed lapel, bright even light, white background with green accents, self-satisfied expression')
  assert.equal(h3MotionWords(MOTION), 'He sings, presenting the cactus before recoiling from its spines. Camera: Lateral slide, eye level. The artist performs, lip-syncing naturally to the supplied vocals.')
  const prompt = buildH3ShotPrompt({ keyframePrompt: KEYFRAME, motionPrompt: MOTION })
  assert.match(prompt, /^Animate the first-frame image\. The first frame shows: Infinite white studio, .*self-satisfied expression\. Keep the same framing/)
  assert.match(prompt, /One continuous shot, no cuts, no close-up, no text, no new characters or objects\.$/)
  assert.doesNotMatch(prompt, /50mm|medium composition|Render one/)
})

test('without keyframe words the video text still gets the fixed lines', () => {
  assert.equal(buildH3ShotPrompt({ motionPrompt: 'He waves' }), 'Animate the first-frame image. Keep the same framing, character, clothes, objects and place as the first frame for the whole shot. He waves. One continuous shot, no cuts, no close-up, no text, no new characters or objects.')
  assert.equal(h3SceneWords(''), '')
})

test('wide clips keep the tested wide size and tall clips use the model\'s own tall size', () => {
  assert.deepEqual(h3ClipSize(1280, 720), { width: 1280, height: 704 })
  assert.deepEqual(h3ClipSize(720, 1280), { width: 768, height: 1344 })
  assert.deepEqual(h3ClipSize(1080, 1920), { width: 768, height: 1344 })
  assert.deepEqual(h3ClipSize(720, 720), { width: 704, height: 704 })
  const tall = modifyMinimaxH3LocalWorkflow(base, { inputImage: 'k.png', inputAudio: 's.mp3', width: 720, height: 1280, quality: 'fast' })
  assert.deepEqual([tall['7'].inputs.width, tall['7'].inputs.height], [768, 1344])
})

test('a video takes the shape of its own picture, whatever the setting says', () => {
  // A wide picture with the setting on Tall still gives a wide video.
  assert.deepEqual(h3SizeFromPicture({ width: 2752, height: 1536 }, { width: 720, height: 1280 }), { width: 1280, height: 720 })
  // A tall picture with the setting on Wide still gives a tall video.
  assert.deepEqual(h3SizeFromPicture({ width: 1536, height: 2752 }, { width: 1280, height: 720 }), { width: 720, height: 1280 })
  // Matching shapes are left as asked.
  assert.deepEqual(h3SizeFromPicture({ width: 1280, height: 720 }, { width: 1280, height: 720 }), { width: 1280, height: 720 })
  // A picture that could not be measured falls back to the setting.
  assert.deepEqual(h3SizeFromPicture(null, { width: 720, height: 1280 }), { width: 720, height: 1280 })
  // And the clip size that follows is the tall or the wide one.
  const tall = h3SizeFromPicture({ width: 1536, height: 2752 }, { width: 1280, height: 720 })
  assert.deepEqual(h3ClipSize(tall.width, tall.height), { width: 768, height: 1344 })
  const wide = h3SizeFromPicture({ width: 2752, height: 1536 }, { width: 720, height: 1280 })
  assert.deepEqual(h3ClipSize(wide.width, wide.height), { width: 1280, height: 704 })
})

test('wide and tall pictures are counted, and unmeasured ones are left out', () => {
  assert.deepEqual(countPictureShapes([{ width: 16, height: 9 }, { width: 9, height: 16 }, null, { width: 0, height: 0 }, { width: 16, height: 9 }]), { wide: 2, tall: 1, mixed: true })
  assert.deepEqual(countPictureShapes([{ width: 16, height: 9 }]), { wide: 1, tall: 0, mixed: false })
  assert.deepEqual(countPictureShapes(undefined), { wide: 0, tall: 0, mixed: false })
})
