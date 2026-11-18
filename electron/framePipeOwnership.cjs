// Raw-frame encoders wait indefinitely for their stdin. A crashed renderer
// cannot invoke abortFramePipe, so tie every process to its exact webContents.
function trackFramePipeOwner({ sessions, sessionId, session, sender }) {
  let released = false
  // Killing an encoder can emit an asynchronous EPIPE after a successful
  // write's drain listener was removed. Keep a stream-level guard until close;
  // per-write waits and the process exit still return their normal errors.
  const onStdinError = () => {}
  session.ffmpeg.stdin.on('error', onStdinError)
  session.ffmpeg.stdin.once('close', () => session.ffmpeg.stdin.removeListener('error', onStdinError))
  session.ownerId = sender.id
  session.release = () => {
    if (released) return
    released = true
    sender.removeListener('destroyed', onOwnerGone)
    sender.removeListener('render-process-gone', onOwnerGone)
    if (sessions.get(sessionId) === session) sessions.delete(sessionId)
  }
  session.abort = () => {
    session.release()
    try {
      if (!session.getClosed() && !session.ffmpeg.killed) session.ffmpeg.kill('SIGKILL')
    } catch { /* owner teardown must continue even if the process already exited */ }
  }
  const onOwnerGone = () => session.abort()
  sessions.set(sessionId, session)
  sender.once('destroyed', onOwnerGone)
  sender.once('render-process-gone', onOwnerGone)
  if (sender.isDestroyed()) session.abort()
  return session
}

module.exports = { trackFramePipeOwner }
