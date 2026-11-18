const path = require('node:path')

function validPort(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return null
  const number = Number(value)
  return Number.isInteger(number) && number > 0 && number <= 65535 ? number : null
}

/** Build argv for the existing direct-Python portable launch path only.
 * Never reads/edits a batch file or executes a command. Extra tokens are copied
 * verbatim: deduplicating individual values corrupts flags with shared values.
 */
function buildPortableArgs({ mainPy, launcherScript, extraArgTokens = [], disableAutoLaunch = true, port = 8188 } = {}) {
  if (typeof mainPy !== 'string' || !mainPy.trim() || mainPy.includes('\0')) {
    throw new TypeError('A valid ComfyUI main.py path is required.')
  }
  if (typeof launcherScript !== 'string' || !launcherScript.trim() || launcherScript.includes('\0')) {
    throw new TypeError('A valid ComfyUI launcher script path is required.')
  }
  if (!Array.isArray(extraArgTokens) || extraArgTokens.some(token => typeof token !== 'string' || token.includes('\0'))) {
    throw new TypeError('ComfyUI extra arguments must be an array of text tokens without NUL characters.')
  }
  const configuredPort = validPort(port)
  if (!configuredPort) throw new TypeError('The configured ComfyUI port must be an integer from 1 to 65535.')

  const hasOption = flag => extraArgTokens.some(token => token === flag || token.startsWith(`${flag}=`))
  let hasExplicitPort = false
  for (let index = 0; index < extraArgTokens.length; index++) {
    const token = extraArgTokens[index]
    if (token !== '--port' && !token.startsWith('--port=')) continue
    hasExplicitPort = true
    const value = token === '--port' ? extraArgTokens[++index] : token.slice('--port='.length)
    const explicitPort = validPort(value)
    if (!explicitPort) throw new TypeError('The --port extra argument must be an integer from 1 to 65535.')
    if (explicitPort !== configuredPort) {
      throw new Error(`ComfyUI extra arguments use port ${explicitPort}, but Velorn is configured for port ${configuredPort}. Match the port in Settings before starting ComfyUI.`)
    }
  }

  const args = ['-s', mainPy, '--windows-standalone-build']
  // Stock scripts: ComfyUI/.ci/windows_base_files/run_cpu.bat and
  // run_nvidia_gpu_fast_fp16_accumulation.bat. The latter explicitly selects
  // fp16_accumulation; bare --fast would enable more optimizations.
  const scriptName = path.win32.basename(launcherScript).toLowerCase()
  if (scriptName === 'run_cpu.bat' && !hasOption('--cpu')) args.push('--cpu')
  if (scriptName === 'run_nvidia_gpu_fast_fp16_accumulation.bat' && !hasOption('--fast')) {
    args.push('--fast', 'fp16_accumulation')
  }
  if (disableAutoLaunch !== false && !hasOption('--disable-auto-launch')) args.push('--disable-auto-launch')
  if (!hasOption('--enable-cors-header')) args.push('--enable-cors-header', '*')
  if (!hasExplicitPort) args.push('--port', String(configuredPort))
  return [...args, ...extraArgTokens]
}

module.exports = { buildPortableArgs }
