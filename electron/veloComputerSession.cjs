'use strict'

// Private native composition only. Never register these capabilities on the
// general MCP server, preload bridge, relay, or an unauthenticated listener.
const { validateCatalog, checkAbort } = require('./connectedAgentMcpGateway.cjs')

async function createVeloComputerSession({ toolSession, cwd, signal, assertCurrent, onEvent,
  makeComputerTools = options => require('./veloComputerTools.cjs').createVeloComputerTools(options) }) {
  if (typeof assertCurrent !== 'function' || typeof toolSession?.listTools !== 'function'
    || typeof toolSession?.callTool !== 'function') throw new TypeError('A native-authorized Velo tool session is required.')
  const guard = async () => {
    checkAbort(signal)
    if (await assertCurrent() === false) throw Object.assign(Error('Computer access is no longer authorized.'), { code: 'UNAUTHORIZED' })
    checkAbort(signal)
  }
  await guard()
  const computer = await makeComputerTools({ cwd, signal, assertCurrent: guard, onEvent })
  let closed = false, closing
  const close = () => {
    closed = true
    closing ||= Promise.resolve().then(() => computer.close()).then(receipt => {
      if (receipt?.success !== true) throw Object.assign(Error('Computer-process cleanup could not be confirmed.'), { code: 'COMPUTER_CLEANUP_FAILED' })
      return receipt
    })
    return closing
  }
  const current = async () => {
    if (closed) throw Object.assign(Error('Computer access has ended.'), { code: 'CANCELLED' })
    await guard()
    if (closed) throw Object.assign(Error('Computer access has ended.'), { code: 'CANCELLED' })
  }
  try {
    await current()
    const nativeTools = validateCatalog(computer.tools)
    const nativeNames = new Set(nativeTools.map(tool => tool.name))
    const baseTools = validateCatalog(await toolSession.listTools())
    // A public catalog must never shadow or create a private native action.
    if (baseTools.some(tool => nativeNames.has(tool.name))) throw new Error('A computer tool conflicts with the editor catalog.')
    const tools = validateCatalog([...baseTools, ...nativeTools])
    await current()
    return {
      ...toolSession,
      listTools: async () => { await current(); return structuredClone(tools) },
      callTool: async (name, args) => {
        await current()
        return nativeNames.has(name) ? computer.callTool(name, args) : toolSession.callTool(name, args)
      },
      close,
    }
  } catch (error) { await close(); throw error }
}

module.exports = { createVeloComputerSession }
