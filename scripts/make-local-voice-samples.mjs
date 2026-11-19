// Makes the short "this is how I sound" clips for the Sound tab's local voices.
// Runs the Kokoro model on this computer, so it is free. The first run downloads
// the model (about 92 MB) into the library's own cache under node_modules.
//   node scripts/make-local-voice-samples.mjs
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { KokoroTTS } from 'kokoro-js'
import { LOCAL_VOICE } from '../src/services/createFlow.mjs'

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'sound')
await mkdir(out, { recursive: true })
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' })
for (const voice of LOCAL_VOICE[0].voices) {
  const audio = await tts.generate(`Hi, my name is ${voice.name}. This is how I sound.`, { voice: voice.id })
  const file = path.join(out, `voice-${voice.id}.wav`)
  await audio.save(file)
  console.log(voice.id, `${(audio.audio.length / audio.sampling_rate).toFixed(1)} s`, file)
}
