import { createGpuCompositor } from '../../src/services/gpuCompositor'

const assert = (condition, message) => { if (!condition) throw new Error(message) }
const assertColor = (pixels, expected, description) => {
  assert(pixels.length === 16 * 8 * 4, `${description}: wrong pixel size`)
  for (let index = 0; index < pixels.length; index++) {
    assert(pixels[index] === expected[index % 4], `${description}: byte ${index} was ${pixels[index]}, expected ${expected[index % 4]}`)
  }
}

async function sequence(forceTimeout) {
  const compositor = createGpuCompositor({ width: 16, height: 8 })
  assert(compositor, 'WebGL2 compositor unavailable')
  const gl = compositor.canvas.getContext('webgl2')
  const nativeWait = gl.clientWaitSync
  if (forceTimeout) gl.clientWaitSync = () => gl.TIMEOUT_EXPIRED
  const draw = color => { compositor.beginFrame(); compositor.drawFill(color, 1) }
  try {
    draw('#ff0000')
    const redTicket = compositor.beginFrameReadback()
    draw('#0000ff')
    const blueTicket = compositor.beginFrameReadback()
    // Neither queued ticket may accidentally collect this newer stage.
    draw('#00ff00')
    const red = new Uint8Array(await compositor.resolveFrameReadback(redTicket))
    const pollsAfterFirst = compositor.getReadbackStats().fencePolls
    const blue = new Uint8Array(await compositor.resolveFrameReadback(blueTicket))
    const stats = compositor.getReadbackStats()
    if (forceTimeout) {
      assert(!compositor.canUseAsyncReadback(), 'Timeout did not disable async readback')
      assert(stats.fenceWaitFallbacks === 1 && stats.forcedPboReadbacks === 2, 'Both queued PBOs were not safely collected')
      assert(stats.fencePolls === pollsAfterFirst, 'Queued ticket kept polling after fallback')
      assert(stats.fallbackReason === 'fence-timeout', 'Missing fallback reason')
      assert(stats.fenceWaitMs >= 50 && stats.fenceWaitMs < 1000, 'Fence wait was not bounded')
    }
    const green = new Uint8Array(compositor.readFramePixels())
    assertColor(red, [255, 0, 0, 255], 'First queued frame')
    assertColor(blue, [0, 0, 255, 255], 'Second queued frame')
    assertColor(green, [0, 255, 0, 255], 'Newer synchronous frame')
    return { pixels: [red, blue, green], stats: compositor.getReadbackStats() }
  } finally {
    gl.clientWaitSync = nativeWait
    compositor.dispose()
  }
}

async function main() {
  assert(window.gpuReadbackFixture.sandboxed, 'Renderer is not sandboxed')
  const normal = await sequence(false)
  const fallback = await sequence(true)
  for (let frame = 0; frame < normal.pixels.length; frame++) {
    assert(normal.pixels[frame].every((value, index) => value === fallback.pixels[frame][index]), 'Fallback differs from normal GPU output')
  }
  const fresh = createGpuCompositor({ width: 16, height: 8 })
  assert(fresh?.canUseAsyncReadback(), 'Fallback leaked into a new compositor')
  fresh.dispose()
  window.gpuReadbackFixture.report({ success: true, sandboxed: true, exactPixelIdentity: true,
    queuedFramesPreservedInOrder: true, normal: normal.stats, fallback: fallback.stats })
}
main().catch(error => window.gpuReadbackFixture.report({ success: false, error: error.stack || error.message }))
