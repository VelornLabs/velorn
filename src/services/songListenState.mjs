// Where "Velorn is listening to this song" is remembered.
//
// It lives outside the Song screen on purpose. Listening takes about as long
// as the song, and the person may look at the other steps meanwhile. The
// screen is taken down when they leave and built again when they return; kept
// inside it, the progress was forgotten and a second listen was started, which
// the engine refused with "already listening" (seen 2026-11-12).
import { useSyncExternalStore } from 'react'

export const LISTEN_IDLE = Object.freeze({ status: 'idle', step: 'voice', percent: 0, error: '' })

export function createSongListenState() {
  let songId = ''
  let value = LISTEN_IDLE
  const listeners = new Set()
  const read = (id) => (id && id === songId ? value : LISTEN_IDLE)
  const write = (id, next) => {
    if (!id) return
    const wanted = typeof next === 'function' ? next(read(id)) : next
    // A late answer about an earlier song must not wipe out the song being heard now.
    if (id !== songId && value.status === 'listening' && wanted.status !== 'listening') return
    songId = id
    value = wanted
    listeners.forEach((listener) => listener())
  }
  const subscribe = (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  return { read, write, subscribe }
}

const shared = createSongListenState()
const startedFor = new Set()

// True the first time it is asked about a song, so each song is listened to
// once without being asked, however often the screen is rebuilt.
export function firstListenFor(id) {
  if (!id || startedFor.has(id)) return false
  startedFor.add(id)
  return true
}

export function writeSongListen(id, next) { shared.write(id, next) }

export function useSongListen(id) {
  return useSyncExternalStore(shared.subscribe, () => shared.read(id), () => LISTEN_IDLE)
}
