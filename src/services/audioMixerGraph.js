// Shared registry that connects the live preview audio graph (owned by
// AudioLayerRenderer) to meter UIs — the mixer channel strips and the master
// meter. The renderer registers its AnalyserNodes here; UI components poll
// levels on an interval. No audio flows through this module and it never
// creates nodes itself, so it is safe to import from any component.

const METER_SILENCE_DB = -120

const registry = {
  context: null,
  masterAnalyser: null,
  trackAnalysers: new Map(), // trackId -> AnalyserNode
}

export function registerMixerGraph({ context, masterAnalyser }) {
  registry.context = context || null
  registry.masterAnalyser = masterAnalyser || null
}

export function unregisterMixerGraph(context) {
  // Only clear if the caller owns the registered graph — guards against a
  // stale unmount cleanup racing a fresh mount's registration.
  if (context && registry.context !== context) return
  registry.context = null
  registry.masterAnalyser = null
  registry.trackAnalysers.clear()
}

export function setTrackAnalyser(trackId, analyser) {
  if (!trackId) return
  if (analyser) {
    registry.trackAnalysers.set(trackId, analyser)
  } else {
    registry.trackAnalysers.delete(trackId)
  }
}

export function removeTrackAnalyser(trackId) {
  registry.trackAnalysers.delete(trackId)
}

export function getMasterAnalyser() {
  return registry.masterAnalyser
}

export function getTrackAnalyser(trackId) {
  return registry.trackAnalysers.get(trackId) || null
}

/**
 * Read the current RMS level of an analyser in dBFS. Returns `minDb` when
 * there is no analyser or no signal, so meters render as silent.
 */
export function readAnalyserRmsDb(analyser, minDb = METER_SILENCE_DB) {
  if (!analyser) return minDb
  try {
    const floatData = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(floatData)
    let sum = 0
    for (let i = 0; i < floatData.length; i++) {
      sum += floatData[i] * floatData[i]
    }
    const rms = floatData.length > 0 ? Math.sqrt(sum / floatData.length) : 0
    if (rms <= 0.001) return minDb
    return Math.max(minDb, 20 * Math.log10(rms))
  } catch (_) {
    return minDb
  }
}
