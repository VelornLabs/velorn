'use strict'
// Asks for one approval on the paired phone AND on this computer at the same
// time. Whichever is answered first decides; the other prompt is closed.
//
// Before this, a paired phone took the prompt alone. "Paired" only means a
// phone was linked earlier, not that it is switched on, so with the phone away
// nothing appeared on the computer and the request waited five minutes and
// then failed (seen on a paid ComfyUI video job, 2026-11-11).
//
// This does not loosen approval: the same single yes is still required, and
// the computer's own dialog is the prompt that is used when no phone is paired.
//
// askPhone(signal)   -> a promise for the phone's answer, or null when no phone is paired
// askDesktop(signal) -> a promise for the computer's answer
// Both must settle (as "no") when their signal is aborted.
async function approvalOnPhoneAndDesktop({ askPhone, askDesktop, signal }) {
  const phoneStop = new AbortController()
  const desktopStop = new AbortController()
  const stopBoth = () => { phoneStop.abort(); desktopStop.abort() }
  if (signal?.aborted) stopBoth()
  else signal?.addEventListener('abort', stopBoth, { once: true })
  try {
    const phone = askPhone(phoneStop.signal)
    if (!phone) return { from: 'desktop', answer: await askDesktop(desktopStop.signal) }
    const desktop = askDesktop(desktopStop.signal)
    const first = await Promise.race([
      Promise.resolve(phone).then(answer => ({ from: 'phone', answer })),
      Promise.resolve(desktop).then(answer => ({ from: 'desktop', answer })),
    ])
    // Close the prompt that was not used, and wait until it is really gone.
    ;(first.from === 'phone' ? desktopStop : phoneStop).abort()
    await Promise.allSettled([phone, desktop])
    return first
  } finally {
    signal?.removeEventListener('abort', stopBoth)
  }
}

module.exports = { approvalOnPhoneAndDesktop }
